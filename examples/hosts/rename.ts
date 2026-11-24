import { fixtureRequests, type FixturePolicy } from "../shared/language/fixture-requests.ts";
import { createReviewKey, type PanelPaging } from "./panel-actions.ts";
import { editPageSize, editPaging } from "./edit-review.ts";
import { createPanelKeyBinding } from "./panel-keys.ts";
import { attachPanelSession } from "../shared/editor-attachment.ts";
import { focusSourceCaret, onSourceFocus } from "./source-focus.ts";
import { isMountedEditor, openChangedFile, type LanguageHost } from "./language-host.ts";
import type { DocumentId, TabId } from "../../src/index.ts";
import { attachEditorLanguage } from "../../src/browser/index.ts";
import type { RenameController, RenamePreview, RenameSnapshot, TextEditor } from "../../src/browser/index.ts";
import type { LspPrepare, LspWorkspace, LspWorkspaceEditNote } from "../../src/protocol/index.ts";
import { navigationSymbol } from "../../fixtures/language/navigation.ts";
import type { NavigationFault } from "../../fixtures/language/navigation.ts";
import { HostCell } from "../shared/observable.ts";

export type RenameHostOptions = Readonly<{ provider: LspWorkspace; open?: (prompt: (name?: string) => void) => boolean; prepare?: (policy: FixturePolicy<NavigationFault>) => LspPrepare }>;
type Session = { id: string; editor: TextEditor; controller: RenameController };
export type RenameNote = Omit<LspWorkspaceEditNote, "insert" | "insertUnits"> & Readonly<{ ordinal: number; line: number; column: number; after: string }>;
export type HostRenameSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; pending: boolean; status: RenameSnapshot["status"];
    message: string; name: string; preview: RenamePreview | null; reviewKey: number | null; canApply: boolean; count: number; page: number; locations: readonly RenameNote[];
    paging: PanelPaging | null; changes: RenameSnapshot["changes"] }>;
const initial: HostRenameSnapshot = { available: false, connected: false, disconnected: false, pending: false, status: "idle",
    message: "Focus a source and prepare a rename preview.", name: "", preview: null, reviewKey: null, canApply: false, count: 0, page: 0, paging: null, locations: [], changes: [] };

/** The host owns the name field, paging and opening changed files. Each pane owns its rename preview. */
export class HostRenameTools {
    private readonly sessions = new Map<Session, () => void>();
    private active: Session | undefined;
    private owner: Session | undefined;
    private readonly host: LanguageHost;
    private readonly reviewKey;
    private readonly options: RenameHostOptions;
    private disconnected = false;
    private disposed = false;
    readonly fixture = fixtureRequests<NavigationFault>("rename");
    private requested = 0;
    private readonly nameField = createPanelKeyBinding<HTMLInputElement>(() => (this.owner ?? this.active)?.editor);
    private readonly cell = new HostCell(initial);
    readonly state = this.cell.observable;
    constructor(host: LanguageHost, options: RenameHostOptions) {
        this.reviewKey = createReviewKey(host.workspace);
        this.host = host; this.options = options;
    }
    private publish(patch: Partial<HostRenameSnapshot> = {}) {
        this.cell.set({ ...this.cell.get(), ...patch, available: !!this.active && !this.active.editor.signal.aborted,
            connected: !this.disconnected && this.options.provider.getSnapshot().phase === "ready", disconnected: this.disconnected });
    }
    private render(state: RenameSnapshot, page = 0) {
        const preview = state.preview, notes = preview?.readPage(page)?.notes ?? [];
        const locations = notes.map(({ insert, insertUnits, ...at }, i) => {
            const { line, column } = this.host.workspace.document(at.document as DocumentId).buffer.positionAt(at.from);
            return { ...at, ordinal: page * editPageSize + i, line, column,
                before: at.before + (at.to - at.from > 256 ? ` (${at.to - at.from} UTF-16 units)` : ""),
                after: insert + (insertUnits > insert.length ? `… (${insertUnits} UTF-16 units)` : "") };
        });
        if (state.status === "expired" && this.options.provider.getSnapshot().phase === "disconnected") this.disconnected = true;
        const reviewKey = this.reviewKey(preview);
        const paging = preview && reviewKey !== null ? editPaging(reviewKey, page, preview.count, next => {
            const current = this.owner?.controller.getSnapshot();
            if (current?.preview === preview && this.cell.get().locations === locations) this.render(current, next);
        }) : null;
        this.publish({ name: state.name, status: state.status, message: state.message, preview, reviewKey, paging, pending: state.status === "pending",
            canApply: preview?.canApply ?? false, count: preview?.count ?? 0, page, locations, ...(state.status === "applied" ? { changes: state.changes } : {}) });
    }
    readonly cancel = () => {
        const owner = this.owner; this.owner = undefined; owner?.controller.cancel();
        this.publish({ status: "idle", pending: false, preview: null, reviewKey: null, paging: null, canApply: false, count: 0, locations: [], page: 0, message: "Rename preview dismissed." });
    };
    readonly disconnect = () => { this.disconnected = true; this.cancel(); };
    readonly reconnect = () => { this.disconnected = false; this.cancel(); this.host.reconnect?.(); };
    setName(value: string) {
        const name = value.slice(0, 256);
        if (this.owner) this.owner.controller.setName(name); else this.publish({ name });
    }
    readonly bindName = this.nameField.bind;
    attach(id: string, _tab: TabId, editor: TextEditor): () => void {
        if (this.disposed) throw new Error("Rename panel is disposed.");
        const { rename: controller, dispose } = attachEditorLanguage(editor, this.options.provider, { rename: {
            documents: () => this.host.workspace.getSnapshot().documents.filter(doc => doc.language !== null),
            canCapture: this.host.canCapture, prepareRequest: () => {
                const policy = this.fixture.take();
                return this.options.prepare?.(policy);
            },
        } });
        const session = { id, editor, controller };
        return attachPanelSession(this.sessions, session, (signal, register) => {
            controller.subscribe(() => { if (this.owner === session) {
                const state = controller.getSnapshot(); if (state.status === "pending") this.requested++;
                this.render(state);
            } });
            register({ id: "rename.start", label: "Rename symbol", enabled: () => !this.disconnected && this.host.canCapture(editor.view.documentId),
                run: () => {
                    const prompt = (name?: string) => { if (this.sessions.has(session)) { this.active = session; this.prompt(session, name); } };
                    if (this.options.open) return this.options.open(prompt);
                    prompt(); return true;
                } }, { keys: ["F2"] });
            const ownsField = () => (this.owner ?? this.active) === session && this.nameField.focused;
            register({ id: "rename.submit", label: "Preview or apply rename", enabled: ownsField,
                run: () => {
                    this.setName(this.nameField.element!.value);
                    const state = this.cell.get();
                    if (state.pending) return;
                    if (!state.preview) this.prepareIn(session);
                    else this.apply(state.preview);
                } }, { keys: ["Enter"], shared: true, priority: 33, repeat: false });
            register({ id: "rename.cancel", label: "Cancel rename", enabled: ownsField,
                run: () => { this.cancel(); focusSourceCaret(editor); } }, { keys: ["Escape"], shared: true, priority: 9 });
            onSourceFocus(editor, signal, () => { this.active = session; this.publish(); });
            editor.onEditIntent(() => {
                if (this.owner && this.owner !== session && this.host.workspace.document(editor.view.documentId).key.variant === "working") this.cancel();
            }, signal);
        }, () => {
            if (this.active === session) this.active = undefined;
            if (this.owner === session) this.cancel();
            else this.publish();
        }, dispose);
    }
    private hint(session: Session) { return navigationSymbol(this.host.workspace.document(session.editor.view.documentId).buffer, session.editor.view.getSnapshot().selection.head); }
    private prompt(session: Session, name = this.hint(session) ?? "") {
        this.cancel(); this.owner = session;
        session.controller.setName(name);
        this.publish({ name, message: "Enter a name, then preview its changes." });
        const field = this.nameField.element;
        if (field) {
            // A controlled field may still display the previous name when F2 returns.
            if (field.value !== name) field.value = name;
            field.focus(); field.select();
        }
    }
    readonly prepare = () => this.prepareIn(this.owner ?? this.active);
    apply(preview: RenamePreview | null): void {
        const owner = this.owner;
        if (!owner || !preview || owner.controller.getSnapshot().preview !== preview) return;
        const doc = owner.editor.element.ownerDocument, focused = doc.activeElement;
        if (preview.confirm().applied && this.owner === owner && isMountedEditor(this.host.workspace, owner.editor)
            && doc.hasFocus() && (doc.activeElement === focused || doc.activeElement === doc.body)) focusSourceCaret(owner.editor);
    }
    private prepareIn(s: Session | undefined) {
        const name = this.cell.get().name;
        if (!s || this.disconnected || !this.host.canCapture(s.editor.view.documentId)) return;
        if (!name || /[\u0000-\u001f\u007f]/.test(name)) { this.prompt(s); return; }
        if (this.owner !== s) this.cancel();
        this.owner = s;
        void s.controller.request(name);
    }
    openChanged(document: DocumentId) {
        const s = this.cell.get();
        if (s.pending || s.preview || this.disposed || !s.changes.some(c => c.document === document)) return;
        this.publish({ message: openChangedFile(this.host, document, this.sessions.keys()) });
    }
    faultIdle() {
        if (!this.owner || this.cell.get().pending || !this.cell.get().connected) return false;
        this.options.provider.disconnect(); return true;
    }
    debug() { return { state: this.cell.get(), requested: this.requested, capture: this.owner ? { view: this.owner.id } : null,
        sessions: this.sessions.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose() { if (!this.disposed) { this.disposed = true; this.cancel(); this.nameField.dispose(); for (const detach of this.sessions.values()) detach(); } }
}
