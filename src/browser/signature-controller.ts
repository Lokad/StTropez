import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import type { DocumentViewSnapshot } from "../core/workspace.ts";
import { createLspSignatureClient, type LspSignatureClient } from "../protocol/lsp-language.ts";
import type { LspSignatureContext } from "../protocol/lsp-language.ts";
import type { LspSignature } from "../protocol/lsp-features.ts";
import type { LspPrepare, LspWorkspace } from "../protocol/lsp-workspace.ts";
import { captureViewRequest } from "./captured-view.ts";
import type { CapturedViewRequest } from "./captured-view.ts";
import type { TextEditor } from "./text-editor.ts";
import { typedTextEvent, type TypedTextDetail } from "./input-events.ts";

export type SignatureControllerOptions = Readonly<{ canCapture?: () => boolean; beforeRequest?: () => void; prepareRequest?: LspPrepare }>;
export type SignatureSnapshot = Readonly<{
    status: "idle" | "pending" | "ready" | "empty" | "expired" | "failed" | "disposed"; message: string;
    anchor: Readonly<{ revision: number; offset: number }> | null;
    signature: LspSignature | null; activeSignature: number; signatureCount: number;
}>;
export type SignatureController = Observable<SignatureSnapshot> & Readonly<{
    request: () => void; cancel: () => void; dispose: () => void;
    getDiagnostics: () => Readonly<{ requested: number; applied: number; scheduled: boolean }>;
}>;
type Call = ReturnType<LspSignatureClient["run"]>;
type Request = { capture: CapturedViewRequest<TextEditor["tab"]>; call?: Call; help?: NonNullable<Awaited<Call["result"]>>; timer?: number; typing?: boolean };
const idle: SignatureSnapshot = Object.freeze({ status: "idle", message: "", anchor: null, signature: null, activeSignature: 0, signatureCount: 0 });
const manual = Object.freeze({ triggerKind: 1, isRetrigger: false } as const);
const changed = Object.freeze({ triggerKind: 3, isRetrigger: true } as const);

/** Manual and advertised signature triggers on a single mounted editing surface. */
export function createSignatureController(editor: TextEditor, provider: LspWorkspace, options: SignatureControllerOptions = {}): SignatureController {
    const { workspace, view, tab } = editor, win = editor.element.ownerDocument.defaultView!;
    if (editor.signal.aborted || !workspace.ownsDocumentView(view, tab)) throw new Error("Signature help requires a live document view.");
    const events = new AbortController(), notifications = workspace.createNotificationScope(), cell = new Store(idle, notifications);
    const stops = new Set<() => void>();
    let client: LspSignatureClient | undefined, job: Request | undefined, armed = false, requested = 0, applied = 0;
    let queued: { timer: number; context: LspSignatureContext } | undefined;
    const publish = (next: SignatureSnapshot) => notifications.publish(cell, Object.freeze(next));
    const available = () => {
        const activity = editor.activity();
        return !events.signal.aborted && editor.element.isConnected && !editor.getSnapshot().disabled && !activity.composing
            && !activity.pendingInput && !activity.pendingCommand && workspace.ownsDocumentView(view, tab) && (options.canCapture?.() ?? true);
    };
    function stopTimer() { win.clearTimeout(queued?.timer); queued = undefined; }
    function release() {
        const previous = job; job = undefined;
        if (previous) { win.clearTimeout(previous.timer); previous.call?.cancel(); previous.capture.cancel(); }
    }
    function end() {
        armed = false; stopTimer(); release(); client?.dispose(); client = undefined;
    }
    function cancel() {
        notifications.assertWritable(); end();
        if (!events.signal.aborted && cell.get() !== idle) publish(idle);
    }
    function schedule(context: LspSignatureContext, afterTyping?: DocumentViewSnapshot) {
        stopTimer();
        const deadline = win.performance.now() + 5000;
        const poll = () => {
            if (!queued || !armed || !editor.getSnapshot().focused || win.performance.now() >= deadline) { cancel(); return; }
            if (!available()) { queued.timer = win.setTimeout(poll, 50); return; }
            queued = undefined;
            if (afterTyping && view.getSnapshot() !== afterTyping) {
                if (context.isRetrigger) request(changed); else cancel();
                return;
            }
            request(context);
        };
        queued = { context, timer: win.setTimeout(poll, 50) };
    }
    function expire(current: Request) {
        if (current !== job) return;
        release(); publish({ ...idle, status: "expired", message: "Signature context changed." });
        if (armed && provider.getSnapshot().phase === "ready" && editor.getSnapshot().focused) {
            if (!queued) schedule(changed);
        } else end();
    }
    function fail(current: Request, error: unknown) {
        if (current !== job) return;
        end(); publish({ ...idle, status: "failed", message: error instanceof Error ? error.message : "Signature help failed." });
    }
    function show(index: number) {
        const help = job?.help, signature = help?.signatures[index]; if (!help || !signature) return;
        publish({ status: "ready", message: `Signature ${index + 1} of ${help.signatures.length}.`, anchor: cell.get().anchor,
            signature, activeSignature: index, signatureCount: help.signatures.length });
    }
    function captureRequest(): Request | undefined {
        const capture = captureViewRequest(workspace, tab, view, { available });
        if (!capture) return;
        const current: Request = { capture }; job = current; armed = true;
        capture.signal.addEventListener("abort", () => expire(current), { once: true });
        return current;
    }
    function request(context: LspSignatureContext = manual) {
        notifications.assertWritable(); if (!available()) return;
        options.beforeRequest?.(); stopTimer();
        const retained = context.isRetrigger && job && !job.call && job.capture.isCurrent() ? job : undefined;
        if (!retained) release();
        if (context === manual) {
            const caret = view.getSnapshot().selection;
            editor.viewport.revealOffset(caret.head, { horizontal: "nearest", vertical: "nearest", affinity: caret.headAffinity ?? "after" });
            if (editor.getSnapshot().focused) editor.viewport.element.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        const current = retained ?? captureRequest();
        if (!current) { cancel(); return; }
        const { capture } = current;
        const doc = capture.document, offset = capture.selectionSet.ranges[capture.selectionSet.primary]!.head;
        try {
            client ??= createLspSignatureClient(provider); requested++;
            current.call = client.run({ document: doc, offset, context, prepare: options.prepareRequest });
            current.timer = win.setTimeout(() => fail(current, new Error("Signature help timed out.")), 30000);
            if (!retained) publish({ ...idle, status: "pending", message: "Reading signature help.", anchor: Object.freeze({ revision: doc.revision, offset }) });
            void current.call.result.then(help => {
                if (current !== job) return;
                if (!capture.isCurrent() || help && !help.isCurrent()) { expire(current); return; }
                applied++; win.clearTimeout(current.timer);
                if (!help?.signatures.length) {
                    end(); publish({ ...idle, status: "empty", message: "No signature at this position." }); return;
                }
                current.help = help; show(help.activeSignature);
            }, error => fail(current, error));
        } catch (error) { fail(current, error); }
    }
    function canCycle() { return !!job?.help && job.help.signatures.length > 1 && job.capture.isCurrent() && job.help.isCurrent(); }
    function cycle(delta: number) {
        const help = job?.help; if (!help || !canCycle()) return;
        const index = (cell.get().activeSignature + delta + help.signatures.length) % help.signatures.length;
        if (help.selectOverload(help.signatures[index]!)) show(index);
    }
    function followArgument(text: string, after: DocumentViewSnapshot) {
        const previous = cell.get(), { anchor, signature } = previous, caret = after.selection.head;
        if (!job?.typing || !anchor || !signature || after.selectionSet.ranges.length !== 1
            || after.selection.anchor !== caret || caret !== anchor.offset + text.length || !/^[\p{ID_Continue}$, \t]+$/u.test(text)) return;
        const change = workspace.document(view.documentId).change;
        if (change?.previousRevision !== anchor.revision || change.origin !== "human" || change.kind !== "typing" || change.edits.length !== 1) return;
        const edit = change.edits[0]!;
        if (edit.from !== anchor.offset || edit.to !== anchor.offset || edit.insert !== text) return;
        // Transfer only the displayed label. The new caret owns cancellation and the next request.
        release();
        if (!captureRequest()) { cancel(); return; }
        publish({ ...previous, status: "pending", message: "Updating signature help.", anchor: Object.freeze({ revision: after.revision, offset: caret }),
            signature: text.includes(",") ? Object.freeze({ ...signature, activeParameter: null }) : signature });
    }
    function typed(event: Event) {
        const detail = (event as CustomEvent<TypedTextDetail>).detail, after = view.getSnapshot();
        if (event.target !== editor.element || detail?.documentId !== view.documentId || detail.revision !== after.revision
            || detail.selectionSet !== after.selectionSet || typeof detail.text !== "string" || !workspace.ownsDocumentView(view, tab)) return;
        const doc = workspace.document(view.documentId);
        let trigger = "";
        for (const option of provider.queryFeatureOptions("textDocument/signatureHelp", doc)) {
            for (const list of [option.triggerCharacters, armed && option.retriggerCharacters]) {
                if (Array.isArray(list)) for (const value of list) {
                    if (typeof value === "string" && value.length > trigger.length && value.length <= 8 && detail.text.endsWith(value)) trigger = value;
                }
            }
        }
        const caret = after.selection.head;
        if (trigger && (caret < trigger.length || doc.buffer.slice(caret - trigger.length, caret) !== trigger)) trigger = "";
        if (!trigger && !armed) return;
        const prior = queued?.context;
        const context = trigger ? { triggerKind: 2 as const, triggerCharacter: trigger, isRetrigger: prior?.isRetrigger ?? armed } : prior ?? changed;
        followArgument(detail.text, after);
        armed = true; schedule(context, after);
    }
    function bind(id: string, label: string, keys: string[], enabled: () => boolean, run: () => void | boolean) {
        const registration = editor.commands.register({ id, label, enabled, run }, { keys, priority: 10 });
        events.signal.addEventListener("abort", registration.dispose, { once: true });
    }
    try {
        bind("signature.request", "Show signature help", ["Ctrl+Shift+Space", "Meta+Shift+Space"], available, () => request());
        bind("signature.previous", "Previous signature", ["ArrowUp"], canCycle, () => cycle(-1));
        bind("signature.next", "Next signature", ["ArrowDown"], canCycle, () => cycle(1));
        bind("signature.dismiss", "Dismiss signature help", ["Escape"], () => armed, () => { const visible = !!cell.get().anchor; cancel(); return visible; });
    } catch (error) { events.abort(); throw error; }
    editor.element.addEventListener(typedTextEvent, typed, { signal: events.signal });
    editor.element.addEventListener("focusout", cancel, { signal: events.signal });
    editor.onEditIntent(kind => {
        if (kind !== "beforeinput") cancel();
        else if (job) job.typing = job.capture.isCurrent() && (!job.help || job.help.isCurrent());
    }, events.signal);
    let providerState = provider.getSnapshot();
    const stopProvider = provider.subscribe(() => {
        const current = job, next = provider.getSnapshot();
        const changedProvider = next.phase !== "ready" || next.epoch !== providerState.epoch || next.registrationGeneration !== providerState.registrationGeneration;
        providerState = next;
        if (current && (current.help && !current.help.isCurrent() || cell.get().signature && changedProvider)) queueMicrotask(() => expire(current));
    });
    function dispose() {
        if (events.signal.aborted) return;
        notifications.assertWritable(); events.abort(); stopProvider(); cancel(); editor.signal.removeEventListener("abort", dispose);
        publish({ ...idle, status: "disposed" }); for (const stop of stops) stop();
    }
    editor.signal.addEventListener("abort", dispose, { once: true });
    return Object.freeze({ request: () => request(), cancel, dispose, getSnapshot: cell.observable.getSnapshot, subscribe(listener: () => void) {
        if (events.signal.aborted) throw new Error("Signature controller is disposed.");
        const unsubscribe = cell.observable.subscribe(listener), stop = () => { unsubscribe(); stops.delete(stop); };
        stops.add(stop); return stop;
    }, getDiagnostics: () => Object.freeze({ requested, applied, scheduled: !!queued }) });
}
