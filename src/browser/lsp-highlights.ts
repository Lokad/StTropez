import { emptyList } from "../core/empty-list.ts";
import { documentHighlightMethod } from "../protocol/lsp-methods.ts";
import { Store, type Observable } from "../core/observable.ts";
import { codeWordConstituentPattern } from "../core/word-patterns.ts";
import { controllerObservable } from "./controller-observable.ts";
import type { DocumentId } from "../core/workspace.ts";
import { highlightClient } from "../protocol/lsp-highlights.ts";
import type { LspDocumentHighlight } from "../protocol/lsp-highlights.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import type { TextEditor } from "./text-editor.ts";

export type LspHighlightSnapshot = Readonly<{ status: "idle" | "pending" | "ready" | "unavailable" | "disposed";
    documentId: DocumentId; revision: number; caret: number | null; items: readonly LspDocumentHighlight[] }>;

export type LspHighlightController = Observable<LspHighlightSnapshot> & Readonly<{
    refresh: () => void; intersect: (from: number, to: number) => readonly LspDocumentHighlight[]; dispose: () => void;
}>;

const identifier = new RegExp(`^(?:\\$|${codeWordConstituentPattern})+$`, "u");

/** Advisory occurrences for one captured view. Never changes text, selection, focus or connection policy. */
export function mountOccurrences(editor: TextEditor, owner: LspDocumentOwner,
    { delayMs: delay = 150 }: Readonly<{ delayMs?: number }>): LspHighlightController {
    const { workspace, tab: target, view } = editor, documentId = view.documentId, win = editor.element.ownerDocument.defaultView!;
    if (!Number.isFinite(delay) || delay < 0) throw new RangeError("Invalid highlight delay.");
    const { provider } = owner;
    const client = highlightClient(owner);
    const notifications = workspace.createNotificationScope(), cell = new Store<LspHighlightSnapshot>(Object.freeze({ status: "idle", documentId,
        revision: workspace.document(documentId).revision, caret: null, items: emptyList }), notifications);
    let disposed = false, generation = 0, timer: number | undefined;
    let result: Awaited<ReturnType<typeof client.run>["result"]> | undefined;
    let occurrence: LspDocumentHighlight | undefined;
    const available = () => !disposed && !editor.signal.aborted && workspace.ownsDocumentView(view, target);
    const watching = () => available() && editor.getSnapshot().focused && provider.getSnapshot().phase === "ready";
    const intersect = (from: number, to: number) => result?.isCurrent() && watching()
        ? result.intersect(from, to) : emptyList;
    const layer = editor.decorations.addProvider({ order: 20, minimap: false, provide: line => {
        if (result?.revision !== line.revision) return emptyList;
        return result.intersect(line.from, line.to).map(({ from, to, kind }) => ({ from, to, className: "st-occurrence-" + kind }));
    } });
    const busy = () => editor.activity().input !== "idle";
    const publish = (status: LspHighlightSnapshot["status"], revision = cell.get().revision, caret: number | null = null) => {
        const items = result?.items ?? emptyList;
        if (items !== cell.get().items) layer.invalidate();
        notifications.publish(cell, Object.freeze({ status, documentId, revision, caret, items }));
    };
    const cancel = () => {
        generation++;
        win.clearTimeout(timer);
        result = undefined;
        occurrence = undefined;
        client.cancel();
    };
    const later = (work: () => void, ms: number) => { timer = win.setTimeout(work, ms); };
    const start = async (token: number, deadline: number) => {
        if (token !== generation || !watching()) return;
        if (busy()) {
            if (win.performance.now() < deadline) later(() => start(token, deadline), 16);
            else publish("idle");
            return;
        }
        const document = workspace.document(documentId);
        const selected = view.getSnapshot();
        const caret = selected.selection.head;
        const current = () => token === generation && watching() && !busy() && view.getSnapshot() === selected;
        try {
            if (!client.options(document).length) { publish("unavailable", document.revision, caret); return; }
            const call = client.run({ document, offset: caret });
            publish("pending", document.revision, caret);
            const batch = await call.result;
            if (!current() || !batch.isCurrent()) return;
            result = batch;
            if (selected.selectionSet.ranges.length === 1 && selected.selection.anchor === caret && caret < document.buffer.length) {
                const [hit] = batch.intersect(caret, caret + 1);
                // Moving inside one unambiguous word preserves the displayed occurrences.
                if (hit && hit.to - hit.from <= 4096 && identifier.test(document.buffer.slice(hit.from, hit.to))
                    && batch.intersect(hit.from, hit.to).length === 1) occurrence = hit;
            }
            publish("ready", document.revision, caret);
        } catch { if (current()) publish("unavailable", document.revision, caret); }
    };
    const refresh = () => {
        if (disposed) return;
        cancel();
        publish("idle");
        if (watching()) {
            const token = generation;
            later(() => start(token, win.performance.now() + 5000), delay);
        }
    };
    const viewChanged = () => {
        const { selection, selectionSet } = view.getSnapshot();
        if (occurrence && selectionSet.ranges.length === 1 && selection.anchor === selection.head
            && occurrence.from <= selection.head && selection.head < occurrence.to
            && watching() && !busy() && result?.isCurrent()) {
            if (cell.get().caret !== selection.head) publish("ready", result.revision, selection.head);
            return;
        }
        refresh();
    };
    let connection = provider.getSnapshot();
    const stops = [workspace.observeDocument(documentId).subscribe(refresh), view.subscribe(viewChanged),
        provider.subscribe(() => {
            const next = provider.getSnapshot();
            const changed = next.phase !== connection.phase || next.epoch !== connection.epoch
                || next.registrationVersion(documentHighlightMethod) !== connection.registrationVersion(documentHighlightMethod);
            connection = next;
            if (changed) refresh();
        })];
    if (target) stops.push(workspace.tabs.subscribe(() => { if (!available()) refresh(); }));
    stops.push(editor.subscribe(refresh));
    const dispose = () => {
        if (disposed) return;
        notifications.assertWritable();
        disposed = true;
        cancel();
        layer.dispose();
        stops.forEach(stop => stop());
        client.dispose();
        publish("disposed");
        cell.clearSnapshotListeners();
    };
    refresh();
    return Object.freeze({
        ...controllerObservable(cell, "Occurrence", () => disposed),
        refresh: () => { notifications.assertWritable(); refresh(); },
        intersect,
        dispose,
    });
}
