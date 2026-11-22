import { onSourceFocus } from "./source-focus.ts";
import type { DocumentId, TabId, Workspace } from "../../src/index.ts";
import { createRenameController } from "../../src/browser/index.ts";
import type { RenameController, RenamePreview, RenameSnapshot, TextEditor } from "../../src/browser/index.ts";
import type { LspPrepare, LspWorkspace } from "../../src/protocol/index.ts";
import { navigationLimits, navigationSymbol } from "../../fixtures/language/navigation.ts";
import type { NavigationInput } from "../../fixtures/language/navigation.ts";
import { HostCell } from "../shared/observable.ts";

export type RenameHostOptions = Readonly<{ provider: LspWorkspace; prepare?: (delay: number, fault?: NavigationInput["fault"]) => LspPrepare }>;
type Session = { id: string; editor: TextEditor; controller: RenameController; stop: () => void };
export type RenameNote = Readonly<{ ordinal: number; document: string; resource: string; title: string; revision: number; from: number; to: number; line: number; column: number; context: string; before?: string; after?: string }>;
export type HostRenameSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; pending: boolean; status: RenameSnapshot["status"];
    message: string; name: string; symbol: string; preview: RenamePreview | null; canApply: boolean; count: number; page: number; locations: readonly RenameNote[];
    changes: RenameSnapshot["changes"] }>;
const initial: HostRenameSnapshot = { available: false, connected: false, disconnected: false, pending: false, status: "idle",
    message: "Focus a source and prepare a rename preview.", name: "", symbol: "", preview: null, canApply: false, count: 0, page: 0, locations: [], changes: [] };

/** The host owns the name field, paging and opening changed files. Each pane owns its rename preview. */
export class HostRenameTools {
    private readonly sessions = new Set<Session>();
    private active: Session | undefined;
    private owner: Session | undefined;
    private readonly workspace: Workspace;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly present: (id: DocumentId) => TextEditor | undefined;
    private readonly backend: RenameHostOptions;
    private readonly options: Readonly<{ reconnectProvider?: () => void; open?: () => boolean }>;
    private disconnected = false;
    private disposed = false;
    private delay = 0;
    private fault: NavigationInput["fault"];
    private requested = 0;
    private input: HTMLInputElement | undefined;
    private nameEvents: AbortController | undefined;
    private readonly cell = new HostCell(initial);
    readonly state = this.cell.observable;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, present: (id: DocumentId) => TextEditor | undefined,
        backend: RenameHostOptions, options: Readonly<{ reconnectProvider?: () => void; open?: () => boolean }> = {}) {
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
        this.publish({ name: state.name, status: state.status, message: state.message, preview, pending: state.status === "pending",
            canApply: preview?.canApply ?? false, count: preview?.count ?? 0, page, locations, ...(state.status === "applied" ? { changes: state.changes } : {}) });
    }
    readonly cancel = () => {
        const owner = this.owner; this.owner = undefined; owner?.controller.cancel();
        this.publish({ status: "idle", pending: false, preview: null, canApply: false, count: 0, locations: [], page: 0, message: "Rename preview dismissed." });
    };
    readonly disconnect = () => { this.disconnected = true; this.cancel(); };
    readonly reconnect = () => { this.disconnected = false; this.cancel(); this.options.reconnectProvider?.(); };
    setName(value: string) {
        const name = value.slice(0, 256);
        if (this.owner) this.owner.controller.setName(name); else this.publish({ name });
    }
    readonly bindName = (input: HTMLInputElement | null) => {
        this.nameEvents?.abort(); this.input = input ?? undefined;
        if (!input || this.disposed) return;
        const events = new AbortController(); this.nameEvents = events;
        input.addEventListener("keydown", event => {
            if ((this.owner ?? this.active)?.editor.keymap.handle(event)) event.stopPropagation();
        }, { signal: events.signal });
    };
    attach(id: string, _tab: TabId, editor: TextEditor): () => void {
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
            const command = editor.commands.register({ id: "rename.start", label: "Rename symbol", enabled: () => !this.disconnected && this.canCapture(editor.view.documentId),
                run: () => { if (this.options.open && !this.options.open()) return false; this.active = session; this.prompt(session); return true; } }, { keys: ["F2"] });
            events.signal.addEventListener("abort", command.dispose, { once: true });
            const ownsField = () => (this.owner ?? this.active) === session && !!this.input?.matches(":focus");
            const submit = editor.commands.register({ id: "rename.submit", label: "Preview or apply rename", enabled: ownsField,
                run: () => {
                    this.setName(this.input!.value);
                    const state = this.cell.get();
                    if (state.pending) return;
                    if (!state.preview) this.prepareIn(session);
                    else if (state.preview.confirm() && this.input?.matches(":focus")) editor.focus();
                } }, { keys: ["Enter"], shared: true, priority: 33, repeat: false });
            events.signal.addEventListener("abort", submit.dispose, { once: true });
            const dismiss = editor.commands.register({ id: "rename.cancel", label: "Cancel rename", enabled: ownsField,
                run: () => { this.cancel(); editor.focus(); } }, { keys: ["Escape"], shared: true, priority: 9 });
            events.signal.addEventListener("abort", dismiss.dispose, { once: true });
        } catch (error) { session.stop(); throw error; }
        onSourceFocus(editor, events.signal, () => { this.active = session; this.publish(); });
        for (const event of ["beforeinput", "compositionstart", "paste", "cut"]) editor.input.addEventListener(event, () => {
            if (this.owner && this.owner !== session && this.workspace.document(editor.view.documentId).key.variant === "working") this.cancel();
        }, { signal: events.signal });
        return session.stop;
    }
    private hint(session: Session) { return navigationSymbol(this.workspace.document(session.editor.view.documentId).buffer, session.editor.view.getSnapshot().selection.head); }
    private prompt(session: Session) {
        this.cancel(); this.owner = session;
        const hint = this.hint(session);
        session.controller.setName(hint ?? "");
        this.publish({ name: hint ?? "", symbol: hint ?? "position", message: "Enter a name, then preview its changes." });
        this.input?.focus(); this.input?.select();
    }
    readonly prepare = () => this.prepareIn(this.active);
    private prepareIn(s: Session | undefined) {
        const name = this.cell.get().name;
        if (!s || this.disconnected || !this.canCapture(s.editor.view.documentId)) return;
        if (!name || /[\u0000-\u001f\u007f]/.test(name)) { this.prompt(s); return; }
        if (this.owner !== s) this.cancel();
        this.owner = s; this.publish({ symbol: this.hint(s) ?? "position" }); s.controller.request(name);
    }
    private page(delta: number) {
        const state = this.cell.get(), page = state.page + delta;
        if (state.preview && this.owner && page >= 0 && page * navigationLimits.page < state.count) this.render(this.owner.controller.getSnapshot(), page);
    }
    readonly nextPage = () => this.page(1);
    readonly previousPage = () => this.page(-1);
    openChanged(document: DocumentId) {
        const s = this.cell.get();
        if (s.pending || s.preview || this.disposed || !s.changes.some(c => c.document === document) || !this.canCapture(document)) return;
        try { ([...this.sessions].find(s => s.editor.view.documentId === document && !s.editor.signal.aborted)?.editor ?? this.present(document))?.focus(); }
        catch { this.publish({ message: "The captured changed resource is no longer available." }); }
    }
    setDelay(value: number) { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid rename delay."); this.delay = value; }
    faultNext(value: NonNullable<NavigationInput["fault"]>) { this.fault = value; }
    faultIdle() {
        if (!this.owner || this.cell.get().pending || !this.cell.get().connected) return false;
        this.backend.provider.disconnect(); return true;
    }
    debug() { return { state: this.cell.get(), requested: this.requested, capture: this.owner ? { view: this.owner.id } : null,
        sessions: this.sessions.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose() { if (!this.disposed) { this.disposed = true; this.cancel(); this.bindName(null); for (const s of this.sessions) s.stop(); } }
}
