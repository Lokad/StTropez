import { createReviewKey } from "./panel-actions.ts";
import { createPanelKeyBinding } from "./panel-keys.ts";
import { detachWithEditor, scopedCommands } from "../shared/editor-attachment.ts";
import { onSourceFocus } from "./source-focus.ts";
import type { DocumentId, TabId, Workspace } from "../../src/index.ts";
import { createRenameController } from "../../src/browser/index.ts";
import type { RenameController, RenamePreview, RenameSnapshot, TextEditor } from "../../src/browser/index.ts";
import type { LspPrepare, LspWorkspace, LspWorkspaceEditNote } from "../../src/protocol/index.ts";
import { navigationLimits, navigationSymbol } from "../../fixtures/language/navigation.ts";
import type { NavigationFault } from "../../fixtures/language/navigation.ts";
import { HostCell } from "../shared/observable.ts";

export type RenameHostOptions = Readonly<{ provider: LspWorkspace; prepare?: (delay: number, fault?: NavigationFault) => LspPrepare }>;
type Session = { id: string; editor: TextEditor; controller: RenameController; stop: () => void };
export type RenameNote = Omit<LspWorkspaceEditNote, "insert" | "insertUnits"> & Readonly<{ ordinal: number; line: number; column: number; after: string }>;
export type HostRenameSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; pending: boolean; status: RenameSnapshot["status"];
    message: string; name: string; preview: RenamePreview | null; reviewKey: number | null; canApply: boolean; count: number; page: number; locations: readonly RenameNote[];
    changes: RenameSnapshot["changes"] }>;
const initial: HostRenameSnapshot = { available: false, connected: false, disconnected: false, pending: false, status: "idle",
    message: "Focus a source and prepare a rename preview.", name: "", preview: null, reviewKey: null, canApply: false, count: 0, page: 0, locations: [], changes: [] };

/** The host owns the name field, paging and opening changed files. Each pane owns its rename preview. */
export class HostRenameTools {
    private readonly sessions = new Set<Session>();
    private active: Session | undefined;
    private owner: Session | undefined;
    private readonly workspace: Workspace;
    private readonly reviewKey;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly present: (id: DocumentId) => TextEditor | undefined;
    private readonly backend: RenameHostOptions;
    private readonly options: Readonly<{ reconnectProvider?: () => void; open?: () => boolean }>;
    private disconnected = false;
    private disposed = false;
    private delay = 0;
    private fault: NavigationFault | undefined;
    private requested = 0;
    private readonly nameField = createPanelKeyBinding<HTMLInputElement>(() => (this.owner ?? this.active)?.editor);
    private readonly cell = new HostCell(initial);
    readonly state = this.cell.observable;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, present: (id: DocumentId) => TextEditor | undefined,
        backend: RenameHostOptions, options: Readonly<{ reconnectProvider?: () => void; open?: () => boolean }> = {}) {
        this.reviewKey = createReviewKey(workspace);
        this.workspace = workspace; this.canCapture = canCapture; this.present = present; this.backend = backend; this.options = options;
    }
    private publish(patch: Partial<HostRenameSnapshot> = {}) {
        this.cell.set({ ...this.cell.get(), ...patch, available: !!this.active && !this.active.editor.signal.aborted,
            connected: !this.disconnected && this.backend.provider.getSnapshot().phase === "ready", disconnected: this.disconnected });
    }
    private render(state: RenameSnapshot, page = 0) {
        const preview = state.preview, notes = preview?.readPage(page)?.notes ?? [];
        const locations = notes.map(({ insert, insertUnits, ...at }, i) => {
            const { line, column } = this.workspace.document(at.document as DocumentId).buffer.positionAt(at.from);
            return { ...at, ordinal: page * navigationLimits.page + i, line, column,
                before: at.before + (at.to - at.from > 256 ? ` (${at.to - at.from} UTF-16 units)` : ""),
                after: insert + (insertUnits > insert.length ? `… (${insertUnits} UTF-16 units)` : "") };
        });
        if (state.status === "expired" && this.backend.provider.getSnapshot().phase === "disconnected") this.disconnected = true;
        this.publish({ name: state.name, status: state.status, message: state.message, preview, reviewKey: this.reviewKey(preview), pending: state.status === "pending",
            canApply: preview?.canApply ?? false, count: preview?.count ?? 0, page, locations, ...(state.status === "applied" ? { changes: state.changes } : {}) });
    }
    readonly cancel = () => {
        const owner = this.owner; this.owner = undefined; owner?.controller.cancel();
        this.publish({ status: "idle", pending: false, preview: null, reviewKey: null, canApply: false, count: 0, locations: [], page: 0, message: "Rename preview dismissed." });
    };
    readonly disconnect = () => { this.disconnected = true; this.cancel(); };
    readonly reconnect = () => { this.disconnected = false; this.cancel(); this.options.reconnectProvider?.(); };
    setName(value: string) {
        const name = value.slice(0, 256);
        if (this.owner) this.owner.controller.setName(name); else this.publish({ name });
    }
    readonly bindName = this.nameField.bind;
    attach(id: string, _tab: TabId, editor: TextEditor): () => void {
        if (this.disposed) throw new Error("Rename panel is disposed.");
        const controller = createRenameController(editor, this.backend.provider, {
            documents: () => this.workspace.getSnapshot().documents.filter(doc => doc.language !== null),
            canCapture: this.canCapture, prepareRequest: () => {
                const fault = this.fault; this.fault = undefined; return this.backend.prepare?.(this.delay, fault);
            },
        });
        const events = new AbortController();
        const session: Session = { id, editor, controller, stop: () => {
            if (!this.sessions.delete(session)) return;
            if (this.active === session) this.active = undefined;
            if (this.owner === session) this.cancel();
            events.abort(); stop(); controller.dispose(); this.publish();
        } };
        const stop = controller.subscribe(() => { if (this.owner === session) {
            const state = controller.getSnapshot(); if (state.status === "pending") this.requested++;
            this.render(state);
        } });
        this.sessions.add(session);
        try {
            const register = scopedCommands(editor, events.signal);
            register({ id: "rename.start", label: "Rename symbol", enabled: () => !this.disconnected && this.canCapture(editor.view.documentId),
                run: () => { if (this.options.open && !this.options.open()) return false; this.active = session; this.prompt(session); return true; } }, { keys: ["F2"] });
            const ownsField = () => (this.owner ?? this.active) === session && !!this.nameField.element?.matches(":focus");
            register({ id: "rename.submit", label: "Preview or apply rename", enabled: ownsField,
                run: () => {
                    this.setName(this.nameField.element!.value);
                    const state = this.cell.get();
                    if (state.pending) return;
                    if (!state.preview) this.prepareIn(session);
                    else if (state.preview.confirm().applied && this.nameField.element?.matches(":focus")) editor.focus();
                } }, { keys: ["Enter"], shared: true, priority: 33, repeat: false });
            register({ id: "rename.cancel", label: "Cancel rename", enabled: ownsField,
                run: () => { this.cancel(); editor.focus(); } }, { keys: ["Escape"], shared: true, priority: 9 });
        } catch (error) { session.stop(); throw error; }
        onSourceFocus(editor, events.signal, () => { this.active = session; this.publish(); });
        editor.onEditIntent(() => {
            if (this.owner && this.owner !== session && this.workspace.document(editor.view.documentId).key.variant === "working") this.cancel();
        }, events.signal);
        return detachWithEditor(editor, events.signal, session.stop);
    }
    private hint(session: Session) { return navigationSymbol(this.workspace.document(session.editor.view.documentId).buffer, session.editor.view.getSnapshot().selection.head); }
    private prompt(session: Session) {
        this.cancel(); this.owner = session;
        const hint = this.hint(session);
        session.controller.setName(hint ?? "");
        this.publish({ name: hint ?? "", message: "Enter a name, then preview its changes." });
        this.nameField.element?.focus(); this.nameField.element?.select();
    }
    readonly prepare = () => this.prepareIn(this.active);
    private prepareIn(s: Session | undefined) {
        const name = this.cell.get().name;
        if (!s || this.disconnected || !this.canCapture(s.editor.view.documentId)) return;
        if (!name || /[\u0000-\u001f\u007f]/.test(name)) { this.prompt(s); return; }
        if (this.owner !== s) this.cancel();
        this.owner = s; s.controller.request(name);
    }
    showPage(preview: RenamePreview, page: number) {
        const state = this.owner?.controller.getSnapshot();
        if (state?.preview === preview && Number.isSafeInteger(page) && page >= 0 && page * navigationLimits.page < preview.count) this.render(state, page);
    }
    openChanged(document: DocumentId) {
        const s = this.cell.get();
        if (s.pending || s.preview || this.disposed || !s.changes.some(c => c.document === document) || !this.canCapture(document)) return;
        try { ([...this.sessions].find(s => s.editor.view.documentId === document && !s.editor.signal.aborted)?.editor ?? this.present(document))?.focus(); }
        catch { this.publish({ message: "The captured changed resource is no longer available." }); }
    }
    setDelay(value: number) { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid rename delay."); this.delay = value; }
    faultNext(value: NavigationFault) { this.fault = value; }
    faultIdle() {
        if (!this.owner || this.cell.get().pending || !this.cell.get().connected) return false;
        this.backend.provider.disconnect(); return true;
    }
    debug() { return { state: this.cell.get(), requested: this.requested, capture: this.owner ? { view: this.owner.id } : null,
        sessions: this.sessions.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose() { if (!this.disposed) { this.disposed = true; this.cancel(); this.nameField.dispose(); for (const s of this.sessions) s.stop(); } }
}
