import { fixtureRequests } from "../shared/language/fixture-requests.ts";
import { createReviewKey, type PanelPaging } from "./panel-actions.ts";
import { createActionPages, requestActionsForReview } from "./action-pages.ts";
import { createPanelKeyBinding } from "./panel-keys.ts";
import { attachPanelSession } from "../shared/editor-attachment.ts";
import { focusSourceCaret, onSourceFocus } from "./source-focus.ts";
import { isMountedEditor, openChangedFile, type ChangedFile, type LanguageHost } from "./language-host.ts";
import type { DocumentId, TabId, TabTarget } from "../../src/index.ts";
import { attachEditorLanguage } from "../../src/browser/index.ts";
import type { CodeActionChoice, CodeActionController, CodeActionPreview, TextEditor } from "../../src/browser/index.ts";
import type { LspCommandPolicy, LspScopeAccess, LspWorkspace, LspWorkspaceEditNote } from "../../src/protocol/index.ts";
import { validDomainModule } from "../../fixtures/language/domain.ts";
import type { ActionInput } from "../../fixtures/language/actions.ts";
import { HostCell } from "../shared/observable.ts";
import type { HostProjectTools } from "./project.ts";
type Session = { id: string; target: TabTarget; editor: TextEditor; controller: CodeActionController };
type ActionSettings = Pick<ActionInput, "module" | "delay" | "fault">;
export type ActionHostOptions = Readonly<{ provider: LspWorkspace; commandPolicy?: LspCommandPolicy;
    beforeRequest?: (scope: LspScopeAccess, config: ActionSettings) => Promise<unknown>;
    beforeResolve?: (scope: LspScopeAccess, config: ActionSettings) => Promise<unknown> }>;
export type ActionsSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; reconnectRequired: boolean; pending: boolean; canApply: boolean; confirm: CodeActionPreview["apply"] | null; reviewKey: number | null; active: boolean; module: string;
    status: "idle" | "pending" | "ready" | "expired" | "failed" | "applied" | "executed"; message: string; title: string; disabled: string | null; command: string | null;
    edits: readonly LspWorkspaceEditNote[]; changes: readonly ChangedFile[]; choices: readonly CodeActionChoice[]; choice: number | null; choicePage: number; choicePaging: PanelPaging | null; editPaging: PanelPaging | null; resolving: boolean; page: number; editCount: number }>;

type Panel = { source: Session; settings: ActionSettings; stop: () => void; pages: ReturnType<typeof createActionPages> };
/** Routes the shared host sidebar to its originating editor and supplies fixture and command policy. */
export class HostActionsTools {
    private readonly host: LanguageHost;
    private readonly reviewKey;
    private readonly options: ActionHostOptions;
    private readonly reviewOwner: HostProjectTools | undefined;
    private readonly sessions = new Map<Session, () => void>();
    private active: Session | undefined;
    private panel: Panel | undefined;
    private readonly stopReviewOwner: (() => void) | undefined;
    private get moduleSource() { return this.panel && this.cell.get().active ? this.panel.source : this.active; }
    private readonly moduleField = createPanelKeyBinding<HTMLInputElement>(() => this.moduleSource?.editor);

    private disposed = false;
    private disconnected = false;
    readonly fixture = fixtureRequests<NonNullable<ActionSettings["fault"]>>("action");
    private requested = 0;
    private readonly cell = new HostCell<ActionsSnapshot>({ available: false, connected: false, disconnected: false, reconnectRequired: false, pending: false, canApply: false, confirm: null, reviewKey: null, active: false, module: "sample-utils", status: "idle", message: "Focus a candidate source to preview a module-import action.", title: "", disabled: null, command: null, edits: [], changes: [], choices: [], choice: null, choicePage: 0, choicePaging: null, editPaging: null, resolving: false, page: 0, editCount: 0 });
    readonly state = this.cell.observable;

    constructor(host: LanguageHost, options: ActionHostOptions, reviewOwner?: HostProjectTools) {
        this.reviewKey = createReviewKey(host.workspace);
        this.host = host; this.options = options; this.reviewOwner = reviewOwner;
        this.stopReviewOwner = reviewOwner?.state.subscribe(() => this.publish());
    }
    private available(s: Session): boolean {
        return !this.disposed && this.sessions.has(s) && isMountedEditor(this.host.workspace, s.editor, s.target);
    }

    private publish(patch: Partial<ActionsSnapshot> = {}): void {
        const panel = this.panel, state = panel?.source.controller.getSnapshot(), preview = state?.preview;
        const status = state?.status, provider = this.options.provider.getSnapshot();
        const pages = panel?.pages();
        if (provider.phase === "disconnected" && (status === "expired" || status === "failed")) this.disconnected = true;
        const active = !!status && ["pending", "resolving", "ready", "executing"].includes(status);
        const changes = state?.changes ?? this.cell.get().changes;
        this.cell.set({ ...this.cell.get(), available: !!this.active && this.available(this.active), connected: !!panel && provider.phase === "ready",
            disconnected: this.disconnected, reconnectRequired: provider.commandRequiresReconnect, active,
            pending: status === "pending" || status === "executing" || status === "resolving", resolving: status === "resolving",
            status: status === "executing" || status === "resolving" ? "pending" : status ?? (changes.length ? this.cell.get().status : "idle"),
            title: preview?.title ?? (state?.choice != null ? state.choices[state.choice]?.title : "") ?? "",
            message: state?.message ?? this.cell.get().message, command: preview?.command ?? null, choices: state?.choices ?? [], choice: state?.choice ?? null,
            canApply: !!preview?.canApply && (!preview.command || !!this.reviewOwner?.canRunAction(panel!.source.editor)), confirm: preview?.apply ?? null, reviewKey: this.reviewKey(preview),
            disabled: preview?.disabled ?? null, page: pages?.edits?.page ?? 0, editCount: pages?.edits?.count ?? 0, edits: pages?.edits?.notes ?? [],
            choicePage: pages?.choicePage ?? 0, choicePaging: pages?.choicePaging ?? null, editPaging: pages?.editPaging ?? null,
            changes, ...patch });
    }
    readonly cancel = (): void => {
        const panel = this.panel; this.panel = undefined; panel?.stop(); panel?.source.controller.cancel();
        this.publish({ status: "idle", changes: [], message: panel?.source.controller.getSnapshot().message || "Action preview dismissed." });
    };
    readonly disconnect = (): void => { this.disconnected = true; this.cancel(); this.publish({ message: "Action provider disconnected; local editing remains available." }); };
    readonly reconnect = (): void => { this.disconnected = false; this.cancel(); this.host.reconnect?.(); this.publish({ message: "Preview a fresh action with current source." }); };
    setModule(value: string): void { if (value === this.cell.get().module) return; this.cancel(); this.publish({ module: value.slice(0, 65), status: "idle", message: "Module changed; preview a fresh action.", title: "", disabled: null, edits: [], choices: [], page: 0, editCount: 0 }); }
    readonly bindModule = this.moduleField.bind;
    private readonly documents = () => this.host.workspace.getSnapshot().documents.filter(doc => doc.language !== null);
    attach(id: string, tab: TabId, editor: TextEditor): () => void {
        if (this.disposed) throw new Error("Code action panel is disposed.");
        const target = this.host.workspace.tabs.capture(tab);
        const { provider, commandPolicy, beforeRequest, beforeResolve } = this.options, review = this.reviewOwner;
        const settings = () => {
            const panel = this.panel;
            if (panel?.source.editor !== editor) throw new Error("The action panel has closed.");
            return panel.settings;
        };
        const { codeActions: controller, commands, dispose } = attachEditorLanguage(editor, provider, {
            commands: {
                documents: () => this.documents().filter(doc => doc.key.variant === "working"),
                canCapture: this.host.canCapture,
                ...(review && { reviewCommandEdit: review.reviewActionEdit })
            },
            codeActions: {
                documents: this.documents,
                canCapture: this.host.canCapture,
                ...(commandPolicy && { commandPolicy }),
                ...(beforeRequest && { prepareRequest: session => beforeRequest(session, settings()) }),
                ...(beforeResolve && {
                    prepareResolve: session => beforeResolve(session, { module: settings().module, ...this.fixture.take() })
                }),
                ...(review && { canRunCommand: () => review.canRunAction(editor), reviewCommandEdit: review.reviewActionEdit })
            }
        });
        const stopAction = review?.observeActions(editor, controller, commands);
        const s = { id, target, editor, controller };
        const ownsModule = () => this.moduleField.focused && this.moduleSource === s;
        return attachPanelSession(this.sessions, s, (signal, register) => {
            onSourceFocus(editor, signal, () => { this.active = s; this.publish(); });
            editor.onEditIntent(() => {
                if (this.panel && this.panel.source !== s && this.cell.get().active && this.panel.source.controller.getSnapshot().status !== "executing"
                    && this.host.workspace.document(editor.view.documentId).key.variant === "working") this.cancel();
            }, signal);
            register({ id: "actions.request", label: "Preview module action", enabled: () => this.available(s),
                run: from => { this.active = s; this.start(from !== "panel"); } }, { keys: ["Mod+."] });
            register({ id: "actions.submitModule", label: "Preview the entered module", enabled: ownsModule,
                run: () => editor.commands.run("actions.request", "panel") }, { keys: ["Enter"], shared: true, priority: 35, repeat: false });
            register({ id: "actions.dismiss", label: "Dismiss action preview", enabled: ownsModule,
                run: () => { this.cancel(); focusSourceCaret(editor); } }, { keys: ["Escape"], shared: true, priority: 6 });
        }, () => {
            if (this.active === s) this.active = undefined;
            if (this.panel?.source === s) {
                if (this.cell.get().active) this.cancel();
                else { this.panel.stop(); this.panel = undefined; }
            }
            this.publish();
        }, () => { dispose(); stopAction?.(); });
    }
    readonly request = (): void => {
        if (!this.moduleSource?.editor.commands.run("actions.request", "panel"))
            this.publish({ message: "Focus an available source and finish typing before requesting a code action." });
    };
    private start(keyboard: boolean): void {
        const origin = this.active, module = this.cell.get().module;
        if (this.disconnected || !origin || !this.available(origin)) { this.publish({ message: "Focus an available source and reconnect first." }); return; }
        const doc = this.host.workspace.document(origin.editor.view.documentId);
        if (doc.key.variant !== "working" || this.documents().some(doc => !this.host.canCapture(doc.id))) {
            this.publish({ message: "Finish pending input, navigation, table conversion or composition in the captured project first." }); return;
        }
        this.cancel();
        const settings: ActionSettings = { module, ...this.fixture.take() };
        if (!validDomainModule(module)) { this.publish({ status: "failed", message: "Choose a valid module identifier." }); return; }
        const controller = origin.controller;
        this.panel = { source: origin, settings, stop: controller.subscribe(() => this.publish()), pages: createActionPages(controller, this.reviewKey, () => this.publish()) };
        this.requested++;
        void requestActionsForReview(controller);
        if (keyboard && this.moduleField.element && this.cell.get().pending) { this.moduleField.element.focus(); this.moduleField.element.select(); }
    }
    openChangedDocument(document: DocumentId): void {
        if (this.disposed || this.cell.get().active || !this.cell.get().changes.some(change => change.document === document)) return;
        this.publish({ message: openChangedFile(this.host, document, this.sessions.keys()) });
    }

    faultIdle(): boolean {
        if (!this.panel || this.cell.get().pending || this.options.provider.getSnapshot().phase !== "ready") return false;
        this.options.provider.disconnect(); return true;
    }
    debug() { return { requested: this.requested, state: this.cell.get(), capture: this.panel && this.cell.get().active ? { view: this.panel.source.id } : null,
        transport: this.panel ? "lsp3.17" : null, sessions: this.sessions.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.moduleField.dispose(); this.stopReviewOwner?.(); this.disposed = true; for (const detach of this.sessions.values()) detach(); this.active = undefined; this.publish(); }
}
