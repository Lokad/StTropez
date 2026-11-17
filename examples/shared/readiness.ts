import type { TextEditor, TextComparison, TextViewport } from "../../src/browser/index.ts";

// Fixture-only completion checks. Provider requests and native composition sessions have
// their own owners; neither is evidence that the editor's scheduled work is still pending.
export function viewportSettled(viewport: TextViewport): boolean {
    const painted = viewport.activity();
    if (painted.disposed || painted.pending) return false;
    const view = viewport.view.getSnapshot();
    return painted.revision === view.revision && painted.selectionSet === view.selectionSet
        && painted.foldGeneration === viewport.view.folding.getSnapshot().generation;
}

export function editorSettled(editor: TextEditor): boolean {
    const input = editor.activity();
    return !input.disposed && !input.pendingInput && !input.pendingCommand && !input.pendingCaret
        && !input.pendingWord && !input.pendingGrapheme && !input.pendingDragScroll && viewportSettled(editor.viewport);
}

export function comparisonSettled(comparison: TextComparison): boolean {
    const work = comparison.snapshot(), reference = comparison.referenceEditor();
    if (work.alignment.status === "failed") throw new Error(work.alignment.failure);
    if (work.disposed || comparison.controller.getSnapshot().status !== "ready" || work.alignment.pending || work.pendingScroll
        || !reference || !editorSettled(reference) || !editorSettled(comparison.working)) return false;
    const workingRows = comparison.working.viewport.activity(), referenceRows = reference.viewport.activity();
    return !work.rowsAligned || workingRows.aligned && referenceRows.aligned && workingRows.alignmentId === referenceRows.alignmentId;
}
