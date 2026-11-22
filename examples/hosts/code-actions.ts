import { onSourceFocus } from "./source-focus.ts";
import type { DocumentId, TabId, TabTarget, Workspace } from "../../src/index.ts";
import { createCodeActionController } from "../../src/browser/index.ts";
import type { CodeActionChoice, CodeActionController, CodeActionPreview, TextEditor } from "../../src/browser/index.ts";
import type { LspCommandPolicy, LspScopeAccess, LspWorkspace, LspWorkspaceEditPreview } from "../../src/protocol/index.ts";
import { validateActionInput } from "../../fixtures/language/actions.ts";
import type { ActionInput } from "../../fixtures/language/actions.ts";
import { HostCell } from "../shared/observable.ts";
import type { HostProjectTools } from "./project.ts";
type Session = { events: AbortController; id: string; target: TabTarget; editor: TextEditor; controller: CodeActionController };
export type ActionHostOptions = Readonly<{ provider: LspWorkspace; commandPolicy?: LspCommandPolicy;
    beforeRequest?: (scope: LspScopeAccess, config: Pick<ActionInput, "module" | "delay" | "fault">) => Promise<unknown>;
    beforeResolve?: (scope: LspScopeAccess, config: Pick<ActionInput, "module" | "delay" | "fault">) => Promise<unknown> }>;
export type ActionChoice = CodeActionChoice;
export type ActionNote = Readonly<{ document: string; resource: string; title: string; revision: number; from: number; to: number; insert: string; context: string; before?: string; insertUnits?: number }>;
type ActionChange = Readonly<{ document: DocumentId; title: string }>;
export type ActionsSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; reconnectRequired: boolean; pending: boolean; canApply: boolean; confirm: (() => void) | null; token: number | null; module: string;
    status: "idle" | "pending" | "ready" | "expired" | "failed" | "applied" | "executed"; message: string; title: string; disabled: string | null; work: number; total: number; command: string | null;
    edits: readonly ActionNote[]; changed: ActionChange | null; changes: readonly ActionChange[]; choices: readonly ActionChoice[]; choice: number | null; choicePage: number; resolving: boolean; page: number; editCount: number }>;

type Panel = { source: Session; input: ActionInput; stop: () => void;
    preview: CodeActionPreview | null; page: number; choicePage: number; edits: LspWorkspaceEditPreview | undefined };
/** Routes the shared host sidebar to its originating editor and supplies fixture and command policy. */
export class HostActionsTools {
    private readonly workspace: Workspace;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly present: (id: DocumentId) => TextEditor | undefined;
    private readonly options: ActionHostOptions;
    private readonly reviewOwner: HostProjectTools | undefined;
    private readonly reconnectProvider: (() => void) | undefined;
    private readonly sessions = new Set<Session>();
    private active: Session | undefined;
    private panel: Panel | undefined;
    private readonly stopReviewOwner: (() => void) | undefined;
    private moduleInput: HTMLInputElement | undefined;
    private moduleEvents: AbortController | undefined;

    private disposed = false;
    private disconnected = false;
    private delay = 0;
    private fault: ActionInput["fault"];
    private requested = 0;
    private readonly cell = new HostCell<ActionsSnapshot>({ available: false, connected: false, disconnected: false, reconnectRequired: false, pending: false, canApply: false, confirm: null, token: null, module: "sample-utils", status: "idle", message: "Focus a candidate source to preview a module-import action.", title: "", disabled: null, work: 0, total: 0, command: null, edits: [], changed: null, changes: [], choices: [], choice: null, choicePage: 0, resolving: false, page: 0, editCount: 0 });
    readonly state = this.cell.observable;

    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean,
        present: (id: DocumentId) => TextEditor | undefined, options: ActionHostOptions,
        reviewOwner?: HostProjectTools, reconnectProvider?: () => void) {
        this.workspace = workspace; this.canCapture = canCapture; this.present = present;
        this.options = options; this.reviewOwner = reviewOwner; this.reconnectProvider = reconnectProvider;
        this.stopReviewOwner = reviewOwner?.state.subscribe(() => this.publish());
    }
    private available(s: Session): boolean {
        const tab = this.workspace.tabs.resolve(s.target);
        return !this.disposed && this.sessions.has(s) && s.editor.element.isConnected && !s.editor.activity().disposed && this.workspace.ownsDocumentView(s.editor.view)
            && tab?.surface.kind === "text" && tab.surface.documentId === s.editor.view.documentId && !!this.workspace.observeDocument(s.editor.view.documentId).getSnapshot();
    }

    private publish(patch: Partial<ActionsSnapshot> = {}): void {
        const panel = this.panel, state = panel?.source.controller.getSnapshot(), preview = state?.preview;
        const status = state?.status, provider = this.options.provider.getSnapshot();
        if (panel && panel.preview !== (preview ?? null)) {
            panel.preview = preview ?? null; panel.page = 0; panel.edits = preview?.readPage();
            if (state?.choice != null) panel.choicePage = Math.floor(state.choice / 16);
        }
        if (provider.phase === "disconnected" && (status === "expired" || status === "failed")) this.disconnected = true;
        const active = status && ["pending", "resolving", "ready", "executing"].includes(status);
        const changes = state?.changes ?? [];
        this.cell.set({ ...this.cell.get(), available: !!this.active && this.available(this.active), connected: !!panel && provider.phase === "ready",
            disconnected: this.disconnected, reconnectRequired: provider.commandRequiresReconnect, token: active ? panel!.input.id : null,
            pending: status === "pending" || status === "executing" || status === "resolving", resolving: status === "resolving",
            status: status === "executing" || status === "resolving" ? "pending" : status ?? "idle",
            title: preview?.title ?? (state?.choice != null ? state.choices[state.choice]?.title : "") ?? "",
            message: state?.message ?? this.cell.get().message, command: preview?.command ?? null, choices: state?.choices ?? [], choice: state?.choice ?? null,
            canApply: !!preview?.canApply && (!preview.command || !!this.reviewOwner?.canRunAction(panel!.source.editor)), confirm: preview?.confirm ?? null,
            disabled: preview?.disabled ?? null, page: panel?.page ?? 0, editCount: panel?.edits?.count ?? 0, edits: panel?.edits?.notes ?? [],
            choicePage: panel?.choicePage ?? 0, work: state?.status === "ready" ? panel!.input.length : 0, total: panel?.input.length ?? 0,
            changes, changed: changes.find(c => c.document === panel?.source.editor.view.documentId) ?? changes[0] ?? null, ...patch });
    }
    readonly cancel = (): void => {
        const panel = this.panel; this.panel = undefined; panel?.stop(); panel?.source.controller.cancel();
        this.publish(panel ? { message: panel.source.controller.getSnapshot().message || "Action preview dismissed." } : {});
    };
    readonly disconnect = (): void => { this.disconnected = true; this.cancel(); this.publish({ message: "Action provider disconnected; local editing remains available." }); };
    readonly reconnect = (): void => { this.disconnected = false; this.cancel(); this.reconnectProvider?.(); this.publish({ message: "Preview a fresh action with current source." }); };
    setModule(value: string): void { if (value === this.cell.get().module) return; this.cancel(); this.publish({ module: value.slice(0, 65), status: "idle", message: "Module changed; preview a fresh action.", title: "", disabled: null, edits: [], work: 0, total: 0, choices: [], page: 0, editCount: 0 }); }
    readonly bindModule = (input: HTMLInputElement | null): void => {
        this.moduleEvents?.abort(); this.moduleEvents = undefined; this.moduleInput = input ?? undefined; if (!input || this.disposed) return;
        const events = new AbortController(); this.moduleEvents = events;
        input.addEventListener("keydown", event => {
            const origin = this.panel?.source ?? this.active;
            if (origin?.editor.keymap.handle(event)) event.stopPropagation();
        }, { signal: events.signal });
    };
    private readonly documents = () => this.workspace.getSnapshot().documents.filter(doc => doc.language !== null);
    attach(id: string, tab: TabId, editor: TextEditor): () => void {
        const target = this.workspace.tabs.capture(tab), events = new AbortController();
        const { provider, commandPolicy, beforeRequest, beforeResolve } = this.options, review = this.reviewOwner;
        const input = () => {
            const panel = this.panel;
            if (panel?.source.editor !== editor) throw new Error("The action panel has closed.");
            return panel.input;
        };
        const controller = createCodeActionController(editor, provider, { documents: this.documents, canCapture: this.canCapture,
            ...(commandPolicy && { commandPolicy }), ...(beforeRequest && { prepareRequest: session => beforeRequest(session, input()) }),
            ...(beforeResolve && { prepareResolve: session => {
                const settings = { module: input().module, delay: this.delay, ...(this.fault ? { fault: this.fault } : {}) };
                this.fault = undefined; return beforeResolve(session, settings);
            } }), ...(review && { runCommand: command => review.beginAction({ ...command, editor }) }) });
        const s = { id, target, editor, controller, events }; this.sessions.add(s);
        onSourceFocus(editor, events.signal, () => { this.active = s; this.publish(); });
        for (const event of ["beforeinput", "compositionstart", "paste", "cut"] as const) editor.input.addEventListener(event, () => { if (this.panel && this.panel.source !== s && this.cell.get().token !== null && this.panel.source.controller.getSnapshot().status !== "executing" && this.workspace.document(editor.view.documentId).key.variant === "working") this.cancel(); }, { signal: events.signal });
        const detach = () => events.abort();
        events.signal.addEventListener("abort", () => {
            if (this.panel?.source === s) this.cancel();
            controller.dispose(); this.sessions.delete(s); if (this.active === s) this.active = undefined;
            this.publish();
        }, { once: true });
        editor.signal.addEventListener("abort", detach, { once: true, signal: events.signal });
        const ownsModule = () => this.moduleInput?.matches(":focus") === true && (this.panel?.source ?? this.active) === s;
        try {
            const request = editor.commands.register({ id: "actions.request", label: "Preview module action", enabled: () => this.available(s),
                run: from => { this.active = s; this.start(from !== "panel"); } }, { keys: ["Ctrl+.", "Meta+."] });
            events.signal.addEventListener("abort", request.dispose, { once: true });
            const submit = editor.commands.register({ id: "actions.submitModule", label: "Preview the entered module", enabled: ownsModule,
                run: () => editor.commands.run("actions.request", "panel") }, { keys: ["Enter"], shared: true, priority: 35 });
            events.signal.addEventListener("abort", submit.dispose, { once: true });
            const close = editor.commands.register({ id: "actions.dismiss", label: "Dismiss action preview", enabled: ownsModule,
                run: () => { this.cancel(); editor.focus(); } }, { keys: ["Escape"], shared: true, priority: 6 });
            events.signal.addEventListener("abort", close.dispose, { once: true });
            return detach;
        } catch (error) { detach(); throw error; }
    }
    readonly request = (): void => {
        if (!this.active?.editor.commands.run("actions.request", "panel"))
            this.publish({ message: "Focus an available source and finish typing before requesting a code action." });
    };
    private start(keyboard: boolean): void {
        const origin = this.active, module = this.cell.get().module;
        if (this.disconnected || !origin || !this.available(origin)) { this.publish({ message: "Focus an available source and reconnect first." }); return; }
        const doc = this.workspace.document(origin.editor.view.documentId), range = origin.editor.view.getSnapshot().selection;
        if (doc.key.variant !== "working" || this.documents().some(doc => !this.canCapture(doc.id))) {
            this.publish({ message: "Finish pending input, navigation, table conversion or composition in the captured project first." }); return;
        }
        this.cancel();
        let input: ActionInput;
        try { input = validateActionInput({ operation: "action-start", id: this.workspace.allocateIdentity(), document: doc.id, revision: doc.revision, length: doc.buffer.length,
            from: Math.min(range.anchor, range.head), to: Math.max(range.anchor, range.head), module, delay: this.delay, ...(this.fault ? { fault: this.fault } : {}) }); }
        catch (error) { this.fault = undefined; this.publish({ status: "failed", message: String(error) }); return; }
        this.fault = undefined;
        const controller = origin.controller;
        this.panel = { source: origin, input, stop: controller.subscribe(() => this.publish()), page: 0, choicePage: 0, edits: undefined, preview: null };
        this.requested++; controller.request();
        if (keyboard && this.moduleInput && this.cell.get().pending) { this.moduleInput.focus(); this.moduleInput.select(); }
    }
    private goToPage(direction: -1 | 1): void {
        const panel = this.panel; if (!panel?.preview || !panel.edits) return;
        const page = panel.page + direction; if (page < 0 || page * 64 >= panel.edits.count) return;
        panel.edits = panel.preview.readPage(page); panel.page = page; this.publish();
    }
    nextPage(): void { this.goToPage(1); }
    previousPage(): void { this.goToPage(-1); }
    moveChoicePage(direction: -1 | 1): void {
        const panel = this.panel; if (!panel) return;
        const state = panel.source.controller.getSnapshot(), page = panel.choicePage + direction;
        if (state.status === "ready" && page >= 0 && page * 16 < state.choices.length) { panel.choicePage = page; this.publish(); }
    }
    readonly openChanged = (): void => {
        const changed = this.cell.get().changed; if (changed) this.openChangedDocument(changed.document);
    };
    openChangedDocument(document: DocumentId): void {
        if (this.disposed || this.cell.get().token !== null || !this.cell.get().changes.some(change => change.document === document) || !this.canCapture(document)) return;
        try { const editor = [...this.sessions.values()].find(s => s.editor.view.documentId === document && this.available(s))?.editor ?? this.present(document);
            if (!editor || editor.view.documentId !== document) { this.publish({ message: "The captured changed resource cannot be presented in an available source view." }); return; } editor.focus(); }
        catch { this.publish({ message: "The changed resource is no longer available." }); }
    }
    setDelay(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid action delay."); this.delay = value; }
    faultNext(value: NonNullable<ActionInput["fault"]>): void { this.fault = value; }

    faultIdle(): boolean {
        if (!this.panel || this.cell.get().pending || this.options.provider.getSnapshot().phase !== "ready") return false;
        this.options.provider.disconnect(); return true;
    }
    debug() { return { requested: this.requested, state: this.cell.get(), capture: this.panel && this.cell.get().token !== null ? { view: this.panel.source.id, input: this.panel.input } : null,
        transport: this.panel ? "lsp3.17" : null, sessions: this.sessions.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.bindModule(null); this.stopReviewOwner?.(); this.disposed = true; for (const session of this.sessions) session.events.abort(); this.active = undefined; this.publish(); }
}
