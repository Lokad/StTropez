import { Store } from "../core/observable.ts";
import { isFocused } from "./dom-focus.ts";
import { createCooperativeRunner } from "./cooperative-runner.ts";
import { ownsTextSurface } from "../core/workspace.ts";
import type { DocumentId } from "../core/workspace.ts";
import { createLspHighlightClient } from "../protocol/lsp-highlights.ts";
import type { LspDocumentHighlight } from "../protocol/lsp-highlights.ts";
import type { LspWorkspace } from "../protocol/lsp-workspace.ts";
import type { TextEditor } from "./text-editor.ts";

export type LspHighlightSnapshot = Readonly<{ status: "idle" | "pending" | "ready" | "unavailable" | "disposed";
    documentId: DocumentId; revision: number; caret: number | null; items: readonly LspDocumentHighlight[] }>;

/** Advisory occurrences for one captured view. Never changes text, selection, focus or connection policy. */
export function createLspHighlightController(editor: TextEditor,
    options: Readonly<{ provider: LspWorkspace; delayMs?: number }>) {
    const { workspace, tab: target, view } = editor, documentId = view.documentId, win = editor.element.ownerDocument.defaultView!;
    const delay = options.delayMs ?? 150;
    if (editor.signal.aborted || !ownsTextSurface(workspace, view, target)) throw new Error("Invalid highlight view.");
    if (!Number.isFinite(delay) || delay < 0) throw new RangeError("Invalid highlight delay.");
    const client = createLspHighlightClient(options.provider), empty: readonly LspDocumentHighlight[] = Object.freeze([]);
    const notifications = workspace.createNotificationScope(), cell = new Store<LspHighlightSnapshot>(Object.freeze({ status: "idle", documentId,
        revision: workspace.document(documentId).revision, caret: null, items: empty }), notifications);
    const events = new AbortController(), runner = createCooperativeRunner(win); let disposed = false, generation = 0;
    let result: Awaited<ReturnType<typeof client.run>["result"]> | undefined;
    const available = () => !disposed && !editor.activity().disposed && ownsTextSurface(workspace, view, target);
    const focused = () => isFocused(editor.input);
    const busy = () => { const state = editor.activity(); return state.composing || state.pendingInput || state.pendingCommand || state.pendingWord || state.pendingGrapheme; };
    const publish = (status: LspHighlightSnapshot["status"], revision = cell.get().revision, caret: number | null = null) => {
        notifications.publish(cell, Object.freeze({ status, documentId, revision, caret, items: result?.items ?? empty }));
    };
    const cancel = () => {
        generation++; runner.cancel();
        result = undefined; client.cancel();
    };
    const later = (work: () => void, ms: number) => { runner.schedule(work, ms); };
    const start = (token: number, deadline: number) => {
        if (token !== generation || !available() || !focused() || options.provider.getSnapshot().phase !== "ready") return;
        if (busy()) { if (win.performance.now() < deadline) later(() => start(token, deadline), 16); else publish("idle"); return; }
        const document = workspace.document(documentId), selections = view.getSnapshot().selectionSet, caret = selections.ranges[selections.primary]!.head;
        const current = () => token === generation && available() && focused() && !busy() && workspace.document(documentId).revision === document.revision
            && workspace.document(documentId).buffer === document.buffer && view.getSnapshot().selectionSet === selections;
        try {
            if (!client.options(document).length) { publish("unavailable", document.revision, caret); return; }
            const call = client.run(document, caret); publish("pending", document.revision, caret);
            void call.result.then(batch => {
                if (!current() || !batch.isCurrent()) return;
                result = batch; publish("ready", document.revision, caret);
            }, () => { if (current()) publish("unavailable", document.revision, caret); });
        } catch { if (current()) publish("unavailable", document.revision, caret); }
    };
    const refresh = () => {
        if (disposed) return; cancel(); publish("idle");
        if (available() && focused() && options.provider.getSnapshot().phase === "ready") {
            const token = generation; later(() => start(token, win.performance.now() + 5000), delay);
        }
    };
    let provider = options.provider.getSnapshot();
    const stops = [workspace.observeDocument(documentId).subscribe(refresh), view.subscribe(refresh),
        options.provider.subscribe(() => {
            const next = options.provider.getSnapshot(), changed = next.phase !== provider.phase || next.epoch !== provider.epoch || next.registrationGeneration !== provider.registrationGeneration;
            provider = next; if (changed) refresh();
        })];
    if (target) stops.push(workspace.tabState.subscribe(() => { if (!available()) refresh(); }));
    for (const event of ["focus", "blur", "compositionstart", "compositionend"] as const) editor.input.addEventListener(event, refresh, { signal: events.signal });
    const dispose = () => {
        if (disposed) return;
        notifications.assertWritable(); disposed = true; cancel(); events.abort();
        stops.forEach(stop => stop()); client.dispose(); publish("disposed");
    };
    editor.signal.addEventListener("abort", dispose, { once: true, signal: events.signal });
    refresh();
    return Object.freeze({ ...cell.observable, refresh: () => { notifications.assertWritable(); refresh(); },
        intersect: (from: number, to: number): readonly LspDocumentHighlight[] => result?.isCurrent() && available() && focused() ? result.intersect(from, to) : empty,
        dispose });
}
export type LspHighlightController = ReturnType<typeof createLspHighlightController>;
