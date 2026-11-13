import { NotificationScope, Store } from "../core/observable.ts";
import type { DocumentId, TabId, Workspace } from "../core/workspace.ts";
import { createLspHighlightClient } from "../protocol/lsp-highlights.ts";
import type { LspDocumentHighlight } from "../protocol/lsp-highlights.ts";
import type { LspWorkspace } from "../protocol/lsp-workspace.ts";
import type { EditingCandidate } from "./editing-candidate.ts";

export type LspHighlightSnapshot = Readonly<{ status: "idle" | "pending" | "ready" | "unavailable" | "disposed";
    documentId: DocumentId; revision: number; caret: number | null; items: readonly LspDocumentHighlight[] }>;

/** Advisory occurrences for one captured view. Never changes text, selection, focus or connection policy. */
export function createLspHighlightController(workspace: Workspace, tabId: TabId, editor: EditingCandidate,
    options: Readonly<{ provider: LspWorkspace; delayMs?: number }>) {
    const target = workspace.captureTab(tabId), view = editor.view, documentId = view.documentId, win = editor.element.ownerDocument.defaultView!;
    const tab = workspace.resolveTab(target), delay = options.delayMs ?? 150;
    if (tab?.surface.kind !== "text" || tab.surface.documentId !== documentId || !workspace.ownsDocumentView(view)) throw new Error("Invalid highlight view.");
    if (!Number.isFinite(delay) || delay < 0) throw new RangeError("Invalid highlight delay.");
    const client = createLspHighlightClient(options.provider), empty: readonly LspDocumentHighlight[] = Object.freeze([]);
    const notifications = new NotificationScope(() => {}), cell = new Store<LspHighlightSnapshot>(Object.freeze({ status: "idle", documentId,
        revision: workspace.document(documentId).revision, caret: null, items: empty }), notifications);
    const events = new AbortController(); let disposed = false, generation = 0, timer: number | undefined;
    let result: Awaited<ReturnType<typeof client.run>["result"]> | undefined;
    const available = () => !disposed && !editor.snapshot().disposed && workspace.ownsDocumentView(view) && !!workspace.resolveTab(target);
    const focused = () => editor.element.ownerDocument.activeElement === editor.input;
    const busy = () => { const state = editor.snapshot(); return state.composing || state.pendingInput || state.pendingCommand || state.pendingWord || state.pendingGrapheme; };
    const publish = (status: LspHighlightSnapshot["status"], revision = cell.get().revision, caret: number | null = null) => {
        const changed = new Set<Store<unknown>>(); cell.set(Object.freeze({ status, documentId, revision, caret, items: result?.items ?? empty }), changed); notifications.deliver([...changed]);
    };
    const cancel = () => {
        generation++; if (timer !== undefined) win.clearTimeout(timer); timer = undefined;
        result = undefined; client.cancel();
    };
    const later = (work: () => void, ms: number) => { timer = win.setTimeout(() => { timer = undefined; work(); }, ms); };
    const start = (token: number, deadline: number) => {
        if (token !== generation || !available() || !focused() || options.provider.state.getSnapshot().phase !== "ready") return;
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
        if (available() && focused() && options.provider.state.getSnapshot().phase === "ready") {
            const token = generation; later(() => start(token, win.performance.now() + 5000), delay);
        }
    };
    let provider = options.provider.state.getSnapshot();
    const stops = [workspace.observeDocument(documentId).subscribe(refresh), view.subscribe(refresh), workspace.tabState.subscribe(() => { if (!available()) refresh(); }),
        options.provider.state.subscribe(() => {
            const next = options.provider.state.getSnapshot(), changed = next.phase !== provider.phase || next.epoch !== provider.epoch || next.registrationGeneration !== provider.registrationGeneration;
            provider = next; if (changed) refresh();
        })];
    for (const event of ["focus", "blur", "compositionstart", "compositionend"] as const) editor.input.addEventListener(event, refresh, { signal: events.signal });
    refresh();
    return Object.freeze({ state: cell.observable, refresh,
        intersect: (from: number, to: number): readonly LspDocumentHighlight[] => result?.isCurrent() && available() && focused() ? result.intersect(from, to) : empty,
        dispose: () => { if (disposed) return; disposed = true; cancel(); events.abort(); stops.forEach(stop => stop()); client.dispose(); publish("disposed"); } });
}
export type LspHighlightController = ReturnType<typeof createLspHighlightController>;
