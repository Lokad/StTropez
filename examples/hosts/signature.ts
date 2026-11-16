import type { DocumentId, DocumentSnapshot, TabId, TabTarget, TextBuffer, Workspace } from "../../src/index.ts";
import type { LspSignatureContext } from "../../src/protocol/index.ts";
import { captureViewRequest } from "../../src/browser/index.ts";
import type { CapturedViewRequest, DocumentationContent, EditingCandidate } from "../../src/browser/index.ts";
import { createNavigationClient, navigationMetrics } from "../editing/navigation-client.ts";
import { signatureTriggerName, validateSignatureInput } from "../../fixtures/language/signature.ts";
import type { SignatureInput, SignatureResult } from "../../fixtures/language/signature.ts";
import { HostCell } from "../shared/observable.ts";
type SignaturePresentation = Omit<SignatureResult, "signatures"> & Readonly<{ signatures: readonly (Omit<SignatureResult["signatures"][number], "parameters"> & Readonly<{
    activeParameter?: number | null; content?: DocumentationContent;
    parameters: readonly (SignatureResult["signatures"][number]["parameters"][number] & Readonly<{ content?: DocumentationContent }>)[] }>)[] }>;
export type SignatureBackend = Readonly<{ signature: (input: SignatureInput, buffer: TextBuffer, progress: (work: number) => void, context?: LspSignatureContext) => Promise<SignaturePresentation>;
    snapshot: () => Readonly<{ connected: boolean; busy: boolean; transport?: string }>; dispose: () => void; faultIdle?: () => boolean;
    trigger?: (document: DocumentSnapshot, character: string, retrigger: boolean) => boolean; isCurrent?: () => boolean }>;
export type SignatureBackendFactory = (clock: Window, changed: () => void) => SignatureBackend;
type Session = { token: number; id: string; target: TabTarget; editor: EditingCandidate; stop: () => void };
type Job = { session: Session; input: SignatureInput; capture: CapturedViewRequest;
    timer: number; invalid: boolean; ready: boolean; result?: SignaturePresentation };
export type SignatureSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; visible: boolean; pending: boolean;
    status: "idle" | "pending" | "ready" | "empty" | "expired" | "failed"; message: string; view: string | null; left: number; top: number;
    before: string; parameter: string; after: string; documentation: string; parameterDocumentation: string; content: DocumentationContent; parameterContent: DocumentationContent; activeSignature: number; signatureCount: number; argument: number | null; work: number; total: number }>;
const emptyContent: DocumentationContent = Object.freeze([]);
let sessionSerial = 0;
/** One captured signature lane per host; automatic requests are debounced outside input handlers. */
export class HostSignatureTools {
    private readonly workspace: Workspace;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly beforeRequest: () => void;
    private readonly sessions = new Map<number, Session>();
    private active: Session | undefined;
    private job: Job | undefined;
    private client: SignatureBackend | undefined;
    private readonly factory: SignatureBackendFactory | undefined;
    private readonly completionOpen: (() => boolean) | undefined;
    private armed = false;
    private disconnected = false;
    private disposed = false;
    private sequence = 0;
    private delay = 0;
    private fault: SignatureInput["fault"];
    private auto: { session: Session; timer: number; deadline: number; context: LspSignatureContext } | undefined;
    private layout: { win: Window; observer: MutationObserver; frame: number | undefined } | undefined;
    private readonly worker = navigationMetrics();
    private readonly counts = { requested: 0, applied: 0, cancelled: 0, expired: 0, failed: 0, scheduled: 0 };
    private readonly cell = new HostCell<SignatureSnapshot>({ available: false, connected: false, disconnected: false, visible: false, pending: false,
        status: "idle", message: "Use Ctrl/Cmd+Shift+Space for signature help.", view: null, left: 8, top: 8, before: "", parameter: "", after: "", documentation: "", parameterDocumentation: "", content: emptyContent, parameterContent: emptyContent, activeSignature: 0, signatureCount: 0, argument: null, work: 0, total: 0 });
    readonly state = this.cell.observable;
    private readonly reconnectProvider: (() => void) | undefined;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, beforeRequest: () => void, factory?: SignatureBackendFactory, completionOpen?: () => boolean, reconnectProvider?: () => void) { this.reconnectProvider = reconnectProvider; this.workspace = workspace; this.canCapture = canCapture; this.beforeRequest = beforeRequest; this.factory = factory; this.completionOpen = completionOpen; }
    private available(s: Session): boolean {
        const tab = this.workspace.resolveTab(s.target);
        return !this.disposed && this.sessions.get(s.token) === s && s.editor.element.isConnected && !s.editor.activity().disposed && this.workspace.ownsDocumentView(s.editor.view)
            && tab?.surface.kind === "text" && tab.surface.documentId === s.editor.view.documentId && !!this.workspace.observeDocument(s.editor.view.documentId).getSnapshot();
    }
    private current(job: Job): boolean {
        try { return this.job === job && !job.invalid && job.capture.isCurrent() && (this.client?.isCurrent?.() ?? true); } catch { return false; }
    }
    private publish(patch: Partial<SignatureSnapshot> = {}): void {
        this.cell.set({ ...this.cell.get(), ...patch, available: !!this.active && this.available(this.active), connected: this.client?.snapshot().connected ?? false,
            disconnected: this.disconnected, pending: !!this.job && !this.job.ready, view: this.job?.session.id ?? this.active?.id ?? null });
    }
    private position(): Readonly<{ left: number; top: number }> {
        const job = this.job; if (!job) return { left: 8, top: 8 };
        const editor = job.session.editor, win = editor.element.ownerDocument.defaultView!, point = editor.viewport.coordsAt(job.input.offset), box = editor.element.getBoundingClientRect();
        return { left: Math.max(8, Math.min(win.innerWidth - 352, (point?.left ?? box.left) + 8)), top: Math.max(8, Math.min(win.innerHeight - 180, (point ? point.top + point.height : box.top) + 8)) };
    }
    private stopLayout(): void { const old = this.layout; this.layout = undefined; old?.observer.disconnect(); if (old?.frame !== undefined) old.win.cancelAnimationFrame(old.frame); }
    private queueLayout(): void {
        const layout = this.layout; if (!layout || layout.frame !== undefined) return;
        layout.frame = layout.win.requestAnimationFrame(() => { layout.frame = undefined; if (this.layout !== layout || !this.cell.get().visible) return;
            const at = this.position(), before = this.cell.get(); if (at.left !== before.left || at.top !== before.top) this.publish(at); });
    }
    private trackLayout(): void {
        if (this.layout || !this.job) return; const editor = this.job.session.editor, win = editor.element.ownerDocument.defaultView!;
        const observer = new MutationObserver(() => this.queueLayout()); this.layout = { win, observer, frame: undefined };
        observer.observe(editor.element.closest("#host") ?? editor.element.ownerDocument.body, { childList: true, subtree: true, attributes: true, characterData: true });
    }
    private drop(): void { const old = this.client; this.client = undefined; old?.dispose(); }
    private clearDeadline(job: Job): void { job.session.editor.element.ownerDocument.defaultView!.clearTimeout(job.timer); }
    private stopAuto(): void { if (this.auto) this.auto.session.editor.element.ownerDocument.defaultView!.clearTimeout(this.auto.timer); this.auto = undefined; }
    private clear(status: SignatureSnapshot["status"], message: string): void {
        const job = this.job; this.job = undefined; if (job) { job.invalid = true; this.clearDeadline(job); job.capture.cancel(); if (!job.ready) this.drop(); }
        this.stopLayout(); this.publish({ status, message, visible: false, before: "", parameter: "", after: "", documentation: "", parameterDocumentation: "", content: emptyContent, parameterContent: emptyContent, activeSignature: 0, signatureCount: 0, argument: null, work: 0, total: 0 });
    }
    readonly dismiss = (): void => { this.armed = false; this.stopAuto(); if (this.job && !this.job.ready) this.counts.cancelled++; this.clear("idle", "Signature help dismissed."); };
    readonly disconnect = (): void => { this.dismiss(); this.drop(); this.disconnected = true; this.publish({ message: "Signature provider disconnected; local editing remains available." }); };
    readonly reconnect = (): void => { this.dismiss(); this.drop(); this.disconnected = false; this.reconnectProvider?.(); this.publish({ message: "Request signature help with current text." }); };
    private schedule(s: Session, context?: LspSignatureContext): void {
        const captured = context ?? (this.auto?.session === s ? this.auto.context : { triggerKind: 3 as const, isRetrigger: true });
        this.stopAuto(); if (!this.armed || this.disconnected || !this.available(s)) return; this.counts.scheduled++;
        const win = s.editor.element.ownerDocument.defaultView!;
        const poll = () => {
            if (!this.auto || this.auto.session !== s) return;
            if (!this.armed || !this.available(s) || this.active !== s || s.editor.element.ownerDocument.activeElement !== s.editor.input) { this.stopAuto(); return; }
            if (win.performance.now() > this.auto.deadline) { this.stopAuto(); this.armed = false; this.publish({ message: "Request signature help after pending input finishes." }); return; }
            if (!this.canCapture(s.editor.view.documentId)) { this.auto.timer = win.setTimeout(poll, 50); return; }
            this.auto = undefined; this.request(s, captured);
        };
        this.auto = { session: s, timer: win.setTimeout(poll, 50), deadline: win.performance.now() + 5000, context: captured };
    }
    private invalidate(s: Session): void {
        const job = this.job;
        if (job?.session === s && !this.current(job)) { job.invalid = true; queueMicrotask(() => { if (this.job === job) { this.counts.expired++; this.clear("expired", "Captured signature context changed."); this.schedule(s); } }); }
        else if (!job && this.active === s && this.armed) this.schedule(s);
    }
    private show(job: Job, index: number): void {
        const result = job.result!, signature = result.signatures[index], argument = signature?.activeParameter ?? result.call?.argument ?? null, parameter = argument === null ? undefined : signature?.parameters[argument];
        if (!signature) {
            this.stopLayout();
            if (result.reason === "no-call" || result.reason === "depth-limit") this.armed = false;
            this.publish({ status: "empty", visible: false, message: result.reason === "depth-limit" ? "Signature nesting exceeds the local provider limit." : "No supported signature in this captured context.", before: "", parameter: "", after: "", documentation: "", parameterDocumentation: "", signatureCount: 0, argument: null }); return;
        }
        this.publish({ status: "ready", visible: true, message: `Signature ${index + 1} of ${result.signatures.length}; argument ${(argument ?? 0) + 1}.`, activeSignature: index, signatureCount: result.signatures.length, argument,
            before: parameter ? signature.label.slice(0, parameter.from) : signature.label, parameter: parameter ? signature.label.slice(parameter.from, parameter.to) : "", after: parameter ? signature.label.slice(parameter.to) : "",
            documentation: signature.documentation, parameterDocumentation: parameter?.documentation ?? "No declared parameter for this argument in this overload.",
            content: signature.content ?? emptyContent, parameterContent: parameter?.content ?? emptyContent, ...this.position() }); this.trackLayout();
    }
    readonly previous = (): void => this.cycle(-1);
    readonly next = (): void => this.cycle(1);
    private cycle(delta: number): void { const job = this.job; if (!job?.ready || !job.result?.signatures.length || !this.current(job)) return;
        this.show(job, (this.cell.get().activeSignature + delta + job.result.signatures.length) % job.result.signatures.length); }
    readonly inspect = (): void => { if (this.active) this.request(this.active); };
    private trigger(s: Session, inserted: boolean, character = "("): boolean {
        if (!this.available(s)) return false;
        if (this.factory) { this.ensureClient(s.editor.element.ownerDocument.defaultView!); return this.client?.trigger?.(this.workspace.document(s.editor.view.documentId), character, this.armed) ?? false; }
        const doc = this.workspace.document(s.editor.view.documentId), to = s.editor.view.getSnapshot().selection.head - (inserted ? 1 : 0);
        return to >= 0 && signatureTriggerName(doc.buffer.slice(Math.max(0, to - 512), to));
    }
    private ensureClient(win: Window): void {
        this.client ??= this.factory ? this.factory(win, () => { const active = this.active; if (active) this.invalidate(active); this.publish(); }) : createNavigationClient(win, this.worker, undefined, () => {
            const transport = this.client?.snapshot(); if (transport && !transport.connected && !transport.busy) { this.armed = false; this.drop(); this.clear("failed", "Signature provider failed; local editing remains available."); } else this.publish();
        });
    }
    private request(s: Session, context: LspSignatureContext = { triggerKind: 1, isRetrigger: false }): void {
        if (this.disconnected || !this.available(s) || !this.canCapture(s.editor.view.documentId)) { this.publish({ message: "Finish pending input, navigation, table conversion or composition first." }); return; }
        this.beforeRequest(); this.stopAuto(); this.clear("idle", "Capturing signature context."); this.armed = true;
        const capture = captureViewRequest(this.workspace, s.target, s.editor.view, { available: () => this.available(s) && this.canCapture(s.editor.view.documentId) });
        if (!capture) { this.armed = false; this.publish({ status: "expired", message: "Captured signature context changed." }); return; }
        const doc = capture.document, selected = capture.selectionSet.ranges[capture.selectionSet.primary]!;
        let input: SignatureInput; try { input = validateSignatureInput({ id: ++this.sequence, document: doc.id, revision: doc.revision, length: doc.buffer.length, offset: selected.head, delay: this.delay, ...(this.fault ? { fault: this.fault } : {}) }); }
        catch (error) { capture.cancel(); this.armed = false; this.fault = undefined; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Invalid signature context." }); return; } this.fault = undefined;
        const win = s.editor.element.ownerDocument.defaultView!, job: Job = { session: s, input, capture, timer: 0, invalid: false, ready: false }; this.job = job; this.counts.requested++;
        capture.signal.addEventListener("abort", () => { if (this.job === job) this.invalidate(s); }, { once: true });
        this.publish({ status: "pending", visible: true, message: "Reading captured signature context.", total: input.offset, work: 0, ...this.position() }); this.trackLayout();
        try {
            this.ensureClient(win);
            job.timer = win.setTimeout(() => { if (this.job === job && !job.ready) { this.counts.failed++; this.armed = false; this.clear("failed", "Signature help timed out; local editing remains available."); } }, 30000);
            void this.client!.signature(input, doc.buffer, work => { if (this.current(job)) this.publish({ work }); }, context).then(result => {
                if (this.job !== job) return; if (!this.current(job)) { this.invalidate(s); return; }
                job.ready = true; job.result = result; this.clearDeadline(job); this.counts.applied++; this.show(job, result.activeSignature);
            }).catch(error => { if (this.job !== job) return; this.counts.failed++; this.armed = false; this.clear("failed", error instanceof Error ? error.message : "Signature provider failed; local editing remains available."); });
        } catch (error) { this.counts.failed++; this.armed = false; this.clear("failed", error instanceof Error ? error.message : "Signature help is unavailable."); }
    }
    attach(id: string, tab: TabId, editor: EditingCandidate): () => void {
        const s: Session = { token: ++sessionSerial, id, target: this.workspace.captureTab(tab), editor, stop: () => {} }, events = new AbortController(), win = editor.element.ownerDocument.defaultView!;
        this.sessions.set(s.token, s);
        editor.input.addEventListener("focus", () => { if (this.active !== s) { this.dismiss(); this.active = s; this.publish(); } }, { signal: events.signal });
        editor.input.addEventListener("blur", () => { if (this.active === s) this.dismiss(); }, { signal: events.signal });
        editor.input.addEventListener("keydown", event => {
            if (event.defaultPrevented || event.isComposing || editor.activity().composing) return;
            if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key === " ") { event.preventDefault(); event.stopImmediatePropagation(); this.active = s; this.request(s); }
            else if (event.key === "Escape" && (this.job || this.auto || this.armed)) { if (this.factory && this.completionOpen?.()) return; event.preventDefault(); event.stopImmediatePropagation(); this.dismiss(); }
            else if (!event.ctrlKey && !event.metaKey && !event.altKey && !this.disconnected && (this.factory ? event.key.length === 1 && this.trigger(s, false, event.key) : event.key === "(" && (this.armed || this.trigger(s, false)) || event.key === "," && this.armed)) {
                const retrigger = this.armed; this.active = s; this.armed = true; this.clear("idle", "Signature context changed while typing."); this.schedule(s, { triggerKind: 2, triggerCharacter: event.key, isRetrigger: retrigger }); }
        }, { capture: true, signal: events.signal });
        editor.input.addEventListener("beforeinput", (event: InputEvent) => {
            if (event.defaultPrevented || event.isComposing || editor.activity().composing || this.disconnected) return;
            const prior = this.auto?.session === s && this.auto.context.triggerCharacter === event.data ? this.auto.context : undefined;
            const trigger = this.factory ? !!event.data && this.trigger(s, true, event.data) : event.data === "(" && this.trigger(s, true), retrigger = prior?.isRetrigger ?? this.armed;
            if (!this.armed && !trigger) return; this.active = s; this.armed = true; this.clear("idle", "Signature context changed while typing."); this.schedule(s, trigger && event.data ? { triggerKind: 2, triggerCharacter: event.data, isRetrigger: retrigger } : undefined);
        }, { capture: true, signal: events.signal });
        for (const event of ["compositionstart", "paste", "cut"] as const) editor.input.addEventListener(event, () => { if (this.active === s) this.dismiss(); }, { signal: events.signal });
        win.addEventListener("scroll", () => { if (this.job?.session === s) this.queueLayout(); }, { capture: true, signal: events.signal }); win.addEventListener("resize", () => { if (this.job?.session === s) this.queueLayout(); }, { signal: events.signal });
        let detached = false; s.stop = () => { if (detached) return; detached = true; if (this.job?.session === s || this.auto?.session === s) this.dismiss(); events.abort(); this.sessions.delete(s.token);
            if (this.active === s) this.active = undefined; if (!this.sessions.size) this.drop(); this.publish(); }; return s.stop;
    }
    setDelay(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid signature delay."); this.delay = value; }
    faultNext(value: NonNullable<SignatureInput["fault"]>): void { this.fault = value; }
    faultIdle(): boolean { return this.client?.faultIdle?.() ?? false; }
    debug() { return { ...this.counts, worker: { ...this.worker }, pending: !!this.job && !this.job.ready, scheduled: !!this.auto, sessions: this.sessions.size, subscriptions: this.cell.count(), layoutObserver: !!this.layout, layoutFramePending: this.layout?.frame !== undefined, presentation: this.cell.get(),
        capture: this.job ? { document: this.job.input.document, revision: this.job.input.revision, offset: this.job.input.offset, open: this.job.result?.call?.open ?? null } : null, disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.dismiss(); for (const s of [...this.sessions.values()]) s.stop(); this.drop(); this.disposed = true; this.publish(); }
}
