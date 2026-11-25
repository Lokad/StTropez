import { listenUntil, onAbort } from "./listen.ts";
import { done, failed, refused, stale, type Outcome } from "../core/outcome.ts";
import { isStaleRequest } from "../protocol/wire.ts";
import { signatureHelpMethod } from "../protocol/lsp-methods.ts";
import { controllerObservable } from "./controller-observable.ts";
import { mountSignaturePopup, type SignaturePopupOptions } from "./signature-popup.ts";
import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import type { DocumentViewSnapshot } from "../core/workspace.ts";
import { signatureClient, type LspSignatureClient } from "../protocol/lsp-language.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import type { LspSignatureContext } from "../protocol/lsp-language.ts";
import type { LspSignature } from "../protocol/lsp-features.ts";
import type { LspPrepare } from "../protocol/lsp-workspace.ts";
import { canInspectView, captureViewRequest } from "./captured-view.ts";
import type { CapturedViewRequest } from "./captured-view.ts";
import type { TextEditor } from "./text-editor.ts";
import { revealSelectionHead } from "./input-caret.ts";
import { acceptedTypedText, typedTextEvent } from "./input-events.ts";

export type SignatureControllerOptions = Readonly<{
    canCapture?: () => boolean;
    beforeRequest?: () => void;
    prepareRequest?: LspPrepare;
    popup?: boolean | SignaturePopupOptions;
}>;
export type SignatureSnapshot = Readonly<{
    status: "idle" | "pending" | "ready" | "empty" | "expired" | "failed" | "disposed"; message: string;
    anchor: Readonly<{ revision: number; offset: number }> | null;
    signature: LspSignature | null; activeSignature: number; signatureCount: number;
}>;
export type SignatureController = Observable<SignatureSnapshot> & Readonly<{
    request: () => Promise<Outcome<SignatureSnapshot>>; cancel: () => void; dispose: () => void;
    getDiagnostics: () => Readonly<{ requested: number; applied: number; scheduled: boolean }>;
}>;
type Call = ReturnType<LspSignatureClient["run"]>;
type Request = { capture: CapturedViewRequest<TextEditor["tab"]>; call?: Call; help?: NonNullable<Awaited<Call["result"]>>;
    timer?: number; typing?: boolean; argumentKey?: string };
const idle: SignatureSnapshot = Object.freeze({ status: "idle", message: "", anchor: null, signature: null, activeSignature: 0, signatureCount: 0 });
const manual = Object.freeze({ triggerKind: 1, isRetrigger: false } as const);
const changed = Object.freeze({ triggerKind: 3, isRetrigger: true } as const);

/** Manual and advertised signature triggers on a single mounted editing surface. */
export function mountSignature(editor: TextEditor, owner: LspDocumentOwner, options: SignatureControllerOptions): SignatureController {
    const { workspace, view, tab, element } = editor;
    const win = element.ownerDocument.defaultView!;
    const { provider } = owner;
    const client = signatureClient(owner);
    const events = new AbortController(), notifications = workspace.createNotificationScope(), cell = new Store(idle, notifications);
    const { signal } = events;
    const listen = listenUntil(signal);
    const onDispose = (release: () => void) => onAbort(signal, release);
    const currentView = view.getSnapshot;
    const focused = () => editor.getSnapshot().focused;
    const liveHelp = (current: Request) => current.capture.isCurrent() && (!current.help || current.help.isCurrent());
    let job: Request | undefined, armed = false, requested = 0, applied = 0;
    let queued: { timer: number; context: LspSignatureContext } | undefined;
    function publish(next: SignatureSnapshot) {
        notifications.publish(cell, Object.freeze(next));
        return next;
    }
    const available = () => !signal.aborted && canInspectView(editor, options.canCapture);
    function stopTimer() { win.clearTimeout(queued?.timer); queued = undefined; }
    function releaseRequest(previous: Request | undefined) {
        if (previous) { win.clearTimeout(previous.timer); previous.call?.cancel(); previous.capture.cancel(); }
    }
    function release() {
        const previous = job; job = undefined; releaseRequest(previous);
    }
    function end(afterBlur = false) {
        const previous = job;
        armed = false; stopTimer(); job = undefined;
        const close = () => {
            releaseRequest(previous);
            if (!armed) client.cancel();
        };
        // A host can move focus from a read-only subscriber. Release its leases after delivery.
        if (afterBlur && previous) queueMicrotask(close); else close();
    }
    function dismiss(afterBlur = false) {
        end(afterBlur);
        if (!signal.aborted && cell.get() !== idle) publish(idle);
    }
    function cancel() { notifications.assertWritable(); dismiss(); }
    function schedule(context: LspSignatureContext, afterTyping?: DocumentViewSnapshot) {
        stopTimer();
        const deadline = win.performance.now() + 5000;
        const poll = () => {
            if (!queued || !armed || !focused() || win.performance.now() >= deadline) { cancel(); return; }
            if (!available()) { queued.timer = win.setTimeout(poll, 50); return; }
            queued = undefined;
            if (afterTyping && currentView() !== afterTyping) {
                if (context.isRetrigger) request(changed); else cancel();
                return;
            }
            request(context);
        };
        queued = { context, timer: win.setTimeout(poll, 50) };
    }
    function expire(current: Request, followCaret = true) {
        if (current !== job) return;
        if (followCaret && current.argumentKey && focused() && available()) {
            const after = currentView(), text = crossedArgument(current, after);
            if (text && transferLabel(after, text)) { schedule(changed, after); return; }
        }
        release(); publish({ ...idle, status: "expired", message: "Signature context changed." });
        if (followCaret && armed && provider.getSnapshot().phase === "ready" && focused()) {
            if (!queued) schedule(changed);
        } else end();
    }
    function show(help: NonNullable<Request["help"]>, index: number) {
        return publish({ status: "ready", message: `Signature ${index + 1} of ${help.signatures.length}.`, anchor: cell.get().anchor,
            signature: help.signatures[index]!, activeSignature: index, signatureCount: help.signatures.length });
    }
    function captureRequest(): Request | undefined {
        const capture = captureViewRequest(workspace, tab, view, { available });
        if (!capture) return;
        const current: Request = { capture }; job = current; armed = true;
        onAbort(capture.signal, () => expire(current));
        return current;
    }
    async function request(context: LspSignatureContext = manual): Promise<Outcome<SignatureSnapshot>> {
        notifications.assertWritable();
        let current: Request | undefined;
        let timedOut = false;
        try {
            if (!available()) return refused("unavailable-view");
            options.beforeRequest?.();
            stopTimer();
            const retained = context.isRetrigger && job && !job.call && job.capture.isCurrent() ? job : undefined;
            if (!retained) release();
            if (context === manual) revealSelectionHead(editor, focused());
            current = retained ?? captureRequest();
            if (!current) {
                cancel();
                return refused("unavailable-view");
            }
            const { capture } = current;
            const doc = capture.document, offset = capture.selectionSet.ranges[capture.selectionSet.primary]!.head;
            requested++;
            const call = client.run({ document: doc, offset, context, prepare: options.prepareRequest });
            current.call = call;
            current.timer = win.setTimeout(() => {
                timedOut = true;
                call.cancel();
            }, 30000);
            if (!retained) publish({ ...idle, status: "pending", message: "Reading signature help.", anchor: Object.freeze({ revision: doc.revision, offset }) });
            const help = await call.result;
            if (current !== job) return stale;
            if (!capture.isCurrent() || help?.isCurrent() === false) {
                expire(current);
                return stale;
            }
            applied++;
            win.clearTimeout(current.timer);
            if (!help?.signatures.length) {
                end();
                return done(publish({ ...idle, status: "empty", message: "No signature at this position." }));
            }
            current.help = help;
            return done(show(help, help.activeSignature));
        } catch (error) {
            if (current && current !== job) return stale;
            if (timedOut) error = new Error("Signature help timed out.");
            if (current && (isStaleRequest(error) || !current.capture.isCurrent())) {
                expire(current, !current.capture.isCurrent());
                return stale;
            }
            end();
            publish({ ...idle, status: "failed", message: error instanceof Error ? error.message : "Signature help failed." });
            return failed(error);
        }
    }
    function canCycle() { return !!job?.help && job.help.signatures.length > 1 && job.capture.isCurrent() && job.help.isCurrent(); }
    function cycle(delta: number) {
        const help = job?.help; if (!help || !canCycle()) return;
        const index = (cell.get().activeSignature + delta + help.signatures.length) % help.signatures.length;
        if (help.selectOverload(help.signatures[index]!)) show(help, index);
    }
    function crossedArgument(current: Request, after: DocumentViewSnapshot) {
        const { document, selectionSet } = current.capture, before = selectionSet.ranges[0]!, caret = after.selection.head;
        if (selectionSet.ranges.length !== 1 || before.anchor !== before.head || after.selectionSet.ranges.length !== 1
            || after.selection.anchor !== caret) return;
        let from = Math.min(before.head, caret), to = Math.max(before.head, caret);
        if (current.argumentKey === "Backspace" || current.argumentKey === "Delete") {
            const change = workspace.document(view.documentId).change, edit = change?.edits[0];
            if (change?.previousRevision !== document.revision || change.revision !== after.revision || change.kind !== "delete"
                || change.origin !== "human" || change.edits.length !== 1 || !edit || edit.insert || edit.from !== caret
                || (current.argumentKey === "Backspace" ? edit.to : edit.from) !== before.head) return;
            from = edit.from; to = edit.to;
        } else if (after.revision !== document.revision) return;
        const text = document.buffer.slice(from, to);
        return /^[\p{ID_Continue}., \t]+$/u.test(text) ? text : undefined;
    }
    function followArgument(text: string, after: DocumentViewSnapshot) {
        const { anchor, signature } = cell.get(), caret = after.selection.head;
        if (!job?.typing || !anchor || !signature || after.selectionSet.ranges.length !== 1
            || after.selection.anchor !== caret || caret !== anchor.offset + text.length || /[()[\]{};\r\n\u2028\u2029]/u.test(text)) return;
        const change = workspace.document(view.documentId).change;
        if (change?.previousRevision !== anchor.revision || change.origin !== "human" || change.kind !== "typing" || change.edits.length !== 1) return;
        const edit = change.edits[0]!;
        if (edit.from !== anchor.offset || edit.to !== anchor.offset || edit.insert !== text) return;
        transferLabel(after, text);
    }
    function transferLabel(after: DocumentViewSnapshot, text: string) {
        const previous = cell.get(), { signature } = previous;
        if (!signature) return false;
        // Transfer only the displayed label. The new caret owns cancellation and the next request.
        release();
        if (!captureRequest()) { cancel(); return false; }
        publish({ ...previous, status: "pending", message: "Updating signature help.", anchor: Object.freeze({ revision: after.revision, offset: after.selection.head }),
            signature: text.includes(",") ? Object.freeze({ ...signature, activeParameter: null }) : signature });
        return true;
    }
    function typed(event: Event) {
        const after = currentView();
        const text = acceptedTypedText(event, element, after);
        if (text === undefined || !workspace.ownsDocumentView(view, tab)) return;
        const doc = workspace.document(view.documentId);
        let trigger = "";
        for (const option of provider.queryFeatureOptions(signatureHelpMethod, doc)) {
            for (const list of [option.triggerCharacters, armed && option.retriggerCharacters]) {
                if (Array.isArray(list)) for (const value of list) {
                    if (typeof value === "string" && value.length > trigger.length && value.length <= 8 && text.endsWith(value)) trigger = value;
                }
            }
        }
        const caret = after.selection.head;
        if (trigger && (caret < trigger.length || doc.buffer.slice(caret - trigger.length, caret) !== trigger)) trigger = "";
        if (!trigger && !armed) return;
        const prior = queued?.context;
        const context = trigger ? { triggerKind: 2 as const, triggerCharacter: trigger, isRetrigger: prior?.isRetrigger ?? armed } : prior ?? changed;
        if (!trigger || trigger === ",") followArgument(text, after);
        armed = true; schedule(context, after);
    }
    function bind(id: string, label: string, keys: string[], enabled: () => boolean, run: () => void | boolean) {
        const registration = editor.commands.register({ id, label, owner: "editor", category: "Signature help", enabled, run }, { keys, priority: 10 });
        onDispose(registration.dispose);
    }
    let providerState = provider.getSnapshot();
    onDispose(provider.subscribe(() => {
        const current = job, next = provider.getSnapshot();
        const changedProvider = next.phase !== "ready" || next.epoch !== providerState.epoch
                || next.registrationVersion(signatureHelpMethod) !== providerState.registrationVersion(signatureHelpMethod);
        providerState = next;
        if (current && changedProvider) delete current.argumentKey;
        if (current && (current.help && !current.help.isCurrent() || cell.get().signature && changedProvider)) queueMicrotask(() => expire(current));
    }));
    try {
        bind("signature.request", "Show signature help", ["Mod+Shift+Space"], available, () => { void request(); });
        bind("signature.previous", "Previous signature", ["ArrowUp"], canCycle, () => cycle(-1));
        bind("signature.next", "Next signature", ["ArrowDown"], canCycle, () => cycle(1));
        bind("signature.dismiss", "Dismiss signature help", ["Escape"], () => armed, () => { const visible = !!cell.get().anchor; cancel(); return visible; });
        if (options.popup) {
            onDispose(mountSignaturePopup(editor, cell.observable, options.popup === true ? {} : options.popup));
        }
    } catch (error) {
        events.abort();
        client.dispose();
        throw error;
    }
    listen(element, typedTextEvent, typed);
    listen(element, "keydown", event => {
        if (!job) return;
        delete job.argumentKey;
        if (!event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
            && ["Backspace", "Delete", "ArrowLeft", "ArrowRight"].includes(event.key) && cell.get().signature
            && liveHelp(job)) job.argumentKey = event.key;
    }, { capture: true });
    listen(element, "keyup", () => { if (job) delete job.argumentKey; });
    listen(element, "focusout", () => dismiss(true));
    editor.onEditIntent(kind => {
        if (kind !== "beforeinput") cancel();
        else if (job) job.typing = liveHelp(job);
    }, signal);
    function dispose() {
        if (signal.aborted) return;
        notifications.assertWritable();
        events.abort();
        dismiss();
        client.dispose();
        publish({ ...idle, status: "disposed" });
        cell.clearSnapshotListeners();
    }
    return Object.freeze({ request: () => request(), cancel, dispose, ...controllerObservable(cell, "Signature", () => signal.aborted), getDiagnostics: () => Object.freeze({ requested, applied, scheduled: !!queued }) });
}
