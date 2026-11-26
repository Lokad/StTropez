import type { FixturePolicy } from "../language/fixture-requests.ts";
import { captureDestinationPanes, isMountedEditor, presentDocument, type NavigationHost } from "../../../examples/shared/language-host.ts";
import { focusSource, onSourceFocus } from "../../../examples/shared/source-focus.ts";
import { attachPanelSession } from "../../../examples/shared/editor-attachment.ts";
import { createWorkingSource } from "./working-source.ts";
import type { DocumentId, TabId, TabTarget } from "../../../src/index.ts";
import { attachEditorLanguage } from "../../../src/browser/index.ts";
import type { NavigationController, NavigationSnapshot as ControllerSnapshot, NavigationDestination, NavigationPointerLink, TextEditor } from "../../../src/browser/index.ts";
import type { LspNavigationRequest, LspPrepare, LspWorkspace } from "../../../src/protocol/index.ts";
import type { NavigationFault } from "../language/navigation.ts";
import { HostCell } from "../../../examples/shared/observable.ts";

type Kind = LspNavigationRequest["kind"];
export type NavigationHostOptions = Readonly<{ provider: LspWorkspace; prepare: (kind: Kind, policy: FixturePolicy<NavigationFault>) => LspPrepare;
    linkAt?: (editor: TextEditor, offset: number) => NavigationPointerLink | undefined }>;
type Session = { id: string; target: TabTarget; editor: TextEditor; controller: NavigationController | undefined };
export type NavigationSnapshot = Readonly<{
    available: boolean;
    status: ControllerSnapshot["status"];
    message: string;
    canReturn: boolean;
}>;

export class HostNavigationTools {
    private readonly sessions = new Map<Session, () => void>();
    private active: Session | undefined;
    private companion: DocumentId | undefined;
    private requested = 0;
    private disposed = false;
    private readonly cell = new HostCell<NavigationSnapshot>({
        available: false, status: "idle", message: "", canReturn: false
    });
    readonly state = this.cell.observable;
    private readonly host: NavigationHost;
    private readonly options: NavigationHostOptions;
    private readonly stopHistory: () => void;
    constructor(host: NavigationHost, options: NavigationHostOptions) {
        this.host = host;
        this.options = options;
        this.stopHistory = host.history.subscribe(() => this.publish());
    }
    private available(session: Session): session is Session & { controller: NavigationController } {
        return !!session.controller && !this.disposed && this.sessions.has(session)
            && isMountedEditor(this.host.workspace, session.editor, session.target);
    }
    private publish(patch: Partial<NavigationSnapshot> = {}) {
        this.cell.set({ ...this.cell.get(), available: !!this.active && this.available(this.active),
            status: this.active?.controller?.getSnapshot().status ?? "idle",
            canReturn: this.host.history.getSnapshot() > 0, ...patch });
    }
    private capture(session: Session, kind: Kind, offset: number) {
        const { editor } = session;
        if (!this.available(session) || !this.host.canCapture(editor.view.documentId)) return;
        if (kind === "definition") {
            const link = this.options.linkAt?.(editor, offset);
            if (link) { link.open(); return; }
        }
        const source = this.host.workspace.observeDocument(editor.view.documentId);
        const revision = editor.view.getSnapshot().revision;
        const point = this.host.history.capture(editor, offset);
        if (!point) return;
        const ownsFocus = this.host.claimNavigationFocus();
        const documents = this.host.workspace.getSnapshot().documents;
        const targets = captureDestinationPanes(session, this.sessions.keys(), new Set(documents.map(doc => doc.id)));
        this.requested++;
        this.publish({ message: "" });
        return (at: NavigationDestination) => {
            try {
                if (!ownsFocus() || !this.available(session)) return;
                const opened = point.visit(() => {
                    const id = at.document.documentId as DocumentId;
                    if (!this.host.canCapture(id)) return false;
                    const pane = targets.get(id);
                    if (pane && !this.available(pane)) return false;
                    const destination = presentDocument(this.host, id, pane ? [pane] : []);
                    if (!destination || source.getSnapshot()?.revision !== revision || !this.host.canCapture(id)) return false;
                    const range = kind === "definition" ? { from: at.from, to: at.from } : at;
                    if (!destination.reveal(range, { expectedRevision: at.document.revision, select: true })) return false;
                    focusSource(destination);
                    return true;
                });
                if (!opened) this.publish({ message: "The destination pane is unavailable." });
            } catch (error) {
                this.publish({ message: error instanceof Error ? error.message : "Could not open the destination." });
            }
        };
    }
    attach(id: string, tab: TabId, editor: TextEditor) {
        if (this.disposed) throw new Error("Navigation panel is disposed.");
        const { workspace } = this.host;
        const target = workspace.tabs.capture(tab);
        const session: Session = { id, target, editor, controller: undefined };
        const attachment = workspace.document(editor.view.documentId).language && attachEditorLanguage(editor, this.options.provider, {
            navigation: {
                documents: () => workspace.getSnapshot().documents.filter(doc => doc.language !== null),
                canCapture: () => this.host.canCapture(editor.view.documentId),
                prepareRequest: kind => this.options.prepare(kind, { delay: 0 }),
                linkAt: offset => this.options.linkAt?.(editor, offset),
                chooser: {
                    capture: (kind, offset) => this.capture(session, kind, offset),
                    fileLabel: at => workspace.observeDocument(at.document.documentId as DocumentId).getSnapshot()?.title ?? at.document.uri,
                },
            },
        });
        session.controller = attachment?.navigation;
        return attachPanelSession(this.sessions, session, (signal, register) => {
            onSourceFocus(editor, signal, () => { this.active = session; this.publish(); });
            const apple = /Mac|iPhone|iPad|iPod/.test(editor.element.ownerDocument.defaultView!.navigator.platform);
            register({ id: "navigation.back", label: "Back to previous location",
                enabled: () => this.host.history.getSnapshot() > 0, run: this.returnToOrigin },
                { keys: apple ? [] : ["Alt+ArrowLeft"], repeat: false });
            const stop = session.controller?.subscribe(() => { if (this.active === session) this.publish(); });
            if (stop) signal.addEventListener("abort", stop, { once: true });
        }, () => {
            if (this.active === session) this.active = undefined;
            this.publish();
        }, attachment?.dispose);
    }
    private request(kind: Kind) {
        const session = this.active;
        if (!session || !this.available(session)) return;
        session.editor.focus();
        void session.controller.request(kind);
    }
    readonly findDefinition = () => this.request("definition");
    readonly findReferences = () => this.request("references");
    private cancel = () => this.active?.controller?.cancel();
    readonly returnToOrigin = () => {
        this.host.claimNavigationFocus();
        const result = this.host.back(this.active?.editor, this.sessions.keys());
        if (result !== "restored") this.publish({ message: result === "busy" ? "Finish pending input." : "No origin is open." });
    };
    readonly addCompanion = (): void => {
        if (this.disposed) return; this.cancel();
        this.companion ??= createWorkingSource(this.host.workspace, "navigation-companion", "Navigation companion", { value: "const catalogue = 1;\r\ncatalogue;\r\n" }).documentId;
        this.publish({ message: "Navigation companion added. Find catalogue from a source view to open its captured definition." });
    };
    releaseCompanion(): boolean {
        if (!this.companion) return false; this.cancel();
        try { this.host.workspace.releaseDocument(this.companion); this.companion = undefined; this.publish(); return true; } catch { return false; }
    }
    debug() {
        return { requested: this.requested, pending: this.state.getSnapshot().status === "pending",
            sessions: [...this.sessions.keys()].map(s => ({ id: s.id, documentId: s.editor.view.documentId })),
            subscriptions: this.cell.count(), companion: this.companion ?? null, disposed: this.disposed };
    }
    dispose() {
        this.disposed = true;
        this.stopHistory();
        for (const detach of this.sessions.values()) detach();
    }
}
