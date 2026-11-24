import { Store } from "../core/observable.ts";
import type { DocumentId } from "../core/workspace.ts";
import { captureViewRequest, editorReadyForRequest, requireLanguageView } from "./captured-view.ts";
import type { CapturedViewRequest } from "./captured-view.ts";
import { controllerObservable } from "./controller-observable.ts";
import type { TextEditor } from "./text-editor.ts";

type Job = {
    invalid: boolean;
    timer?: number;
    source?: CapturedViewRequest<TextEditor["tab"]>;
    project: { dispose(): void };
    client: { dispose(): void };
};

/** One captured review per controller. Drop the old job before releasing its observable resources. */
export function languageReview<J extends Job, S>(editor: TextEditor, name: string, idle: S,
    canCapture: ((id: DocumentId) => boolean) | undefined,
    reset: (status: "idle" | "expired" | "disposed") => void, releaseExtra?: (job: J) => void) {
    requireLanguageView(editor);
    const { workspace, tab, view } = editor;
    const scope = workspace.createNotificationScope();
    const state = new Store(idle, scope);
    const events = new AbortController();
    const active: { job: J | undefined } = { job: undefined };
    const available = (id: DocumentId) =>
        !events.signal.aborted && editorReadyForRequest(editor) && (canCapture?.(id) ?? true);
    function release() {
        const j = active.job;
        active.job = undefined;
        if (!j) return;
        editor.element.ownerDocument.defaultView!.clearTimeout(j.timer);
        releaseExtra?.(j);
        j.source?.cancel();
        j.project.dispose();
        j.client.dispose();
    }
    function expire(j: J) {
        if (j !== active.job || j.invalid) return;
        j.invalid = true;
        // Observers latch expiry immediately. Release workspace leases after delivery.
        queueMicrotask(() => {
            if (j === active.job) {
                release();
                reset("expired");
            }
        });
    }
    function cancel() {
        scope.assertWritable();
        if (!events.signal.aborted) {
            release();
            reset("idle");
        }
    }
    function mount(stop: () => void) {
        function dispose() {
            if (events.signal.aborted) return;
            scope.assertWritable();
            events.abort();
            stop();
            release();
            reset("disposed");
            state.clearSnapshotListeners();
        }
        editor.onEditIntent(() => { if (active.job) cancel(); }, events.signal);
        editor.signal.addEventListener("abort", dispose, { once: true, signal: events.signal });
        return { ...controllerObservable(state, name, () => events.signal.aborted), cancel, dispose };
    }
    return { scope, state, signal: events.signal, active, available, release, expire, mount,
        capture: () => captureViewRequest(workspace, tab, view, { available: () => available(view.documentId) }) };
}
