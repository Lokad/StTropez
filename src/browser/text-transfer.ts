import { isOffset } from "../core/bounds.ts";
import { createSelectionSet, planSelectionEdits } from "../core/selections.ts";
import { PositionMap } from "../core/positions.ts";
import type { DocumentId, DocumentView, Workspace } from "../core/workspace.ts";
import type { SelectionSet } from "../core/selections.ts";
import type { TextBuffer } from "../core/text-buffer.ts";

/** Internal transfer ticket. Identity/revision/set belong to the captured source, never focus. */
export type TextTransferCapture = Readonly<{ workspace: Workspace; documentId: DocumentId;
    view: DocumentView; revision: number; buffer: TextBuffer; selectionSet: SelectionSet; text: string; moveAllowed: boolean }>;
export type TextDropRequest = Readonly<{ workspace: Workspace; view: DocumentView;
    expectedRevision: number; offset: number; source?: TextTransferCapture; text?: string; copy?: boolean }>;
export type TextDropResult = Readonly<{ applied: false; reason: string } | {
    applied: true; operation: "move" | "copy" | "noop"; revision: number; offset: number | null }>;

function resolve(workspace: Workspace, view: DocumentView) {
    if (!workspace.ownsDocumentView(view)) return;
    const document = workspace.observeDocument(view.documentId).getSnapshot(), metadata = workspace.resourceForDocument(view.documentId).metadata.getSnapshot();
    if (!document || metadata.state !== "ready" || view.getSnapshot().revision !== document.revision) return;
    return { document, metadata };
}
export function captureTextTransfer(workspace: Workspace, view: DocumentView): TextTransferCapture | undefined {
    const current = resolve(workspace, view); if (!current) return;
    const { selectionSet } = view.getSnapshot(), fragments: string[] = [];
    for (const range of selectionSet.ranges) if (range.anchor !== range.head) fragments.push(current.document.buffer.slice(Math.min(range.anchor, range.head), Math.max(range.anchor, range.head)));
    if (!fragments.length) return;
    return Object.freeze({ workspace, documentId: view.documentId, view, revision: current.document.revision,
        buffer: current.document.buffer, selectionSet, text: fragments.join("\n"),
        moveAllowed: current.metadata.capabilities.edit.includes("human") });
}
export function isCurrentTextTransfer(source: TextTransferCapture): boolean {
    if (source.documentId !== source.view.documentId) return false;
    const current = resolve(source.workspace, source.view);
    return current?.document.revision === source.revision && current.document.buffer === source.buffer && source.view.getSnapshot().selectionSet === source.selectionSet;
}

/** Commit one original-coordinate text transaction; cross-document moves reuse linked history. */
export function applyTextDrop(request: TextDropRequest): TextDropResult {
    const { workspace, view, expectedRevision, offset, source } = request, target = resolve(workspace, view);
    if (!target || target.document.revision !== expectedRevision) return Object.freeze({ applied: false, reason: "stale-drop-target" });
    if (!isOffset(offset, target.document.buffer.length)) return Object.freeze({ applied: false, reason: "invalid-drop-offset" });
    if (source && !isCurrentTextTransfer(source)) return Object.freeze({ applied: false, reason: "stale-drag-source" });
    const text = source?.text ?? request.text;
    if (typeof text !== "string") return Object.freeze({ applied: false, reason: "missing-drop-text" });
    if (!text.length) return Object.freeze({ applied: true, operation: "noop", revision: expectedRevision, offset: null });
    const move = !!source && source.workspace === workspace && source.moveAllowed && !request.copy;
    const sameDocument = source?.workspace === workspace && source.documentId === view.documentId;
    if (move && sameDocument && source.selectionSet.ranges.some(range => range.anchor !== range.head && offset >= Math.min(range.anchor, range.head) && offset <= Math.max(range.anchor, range.head))) {
        return Object.freeze({ applied: true, operation: "noop", revision: expectedRevision, offset: null });
    }
    const removed = move ? planSelectionEdits(source!.buffer.length, source!.selectionSet, "") : undefined;
    const removals = removed?.edits.filter(edit => edit.from !== edit.to) ?? [];
    const mapped = move && sameDocument ? new PositionMap(source!.buffer.length, removals).map(offset, "before").offset : offset;
    const head = mapped + text.length, targetLength = target.document.buffer.length + text.length - (sameDocument && move ? removals.reduce((sum, edit) => sum + edit.to - edit.from, 0) : 0);
    const after = createSelectionSet(targetLength, [{ anchor: mapped, head }]);
    const edits = [...(move && sameDocument ? removals : []), { from: offset, to: offset, insert: text }].sort((a, b) => a.from - b.from || a.to - b.to);
    const initiator = move && sameDocument ? source!.view : view;
    const targetRequest = { documentId: view.documentId, expectedRevision, origin: "human" as const,
        edits, view: initiator, selectionSet: after, history: { kind: "replace" as const } };
    const result = move && !sameDocument ? workspace.editDocuments([
        { documentId: source!.documentId, expectedRevision: source!.revision, origin: "human", edits: removals,
            view: source!.view, selectionSet: removed!.selectionSet, history: { kind: "replace" } }, targetRequest,
    ]) : workspace.editDocuments([targetRequest]);
    if (!result.applied) return Object.freeze({ applied: false, reason: result.reason });
    const revision = result.revisions.find(item => item.documentId === view.documentId)!.revision;
    // Same-document history restores the drag-initiating view; other retained views map normally.
    // The drop view selects the inserted text, independently of whichever view has focus.
    if (initiator !== view && workspace.ownsDocumentView(view)) view.setSelections(revision, after.ranges, after.primary);
    return Object.freeze({ applied: true, operation: move ? "move" : "copy", revision, offset: head });
}
