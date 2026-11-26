import type { TextEditor, ViewState } from "../../src/browser/index.ts";
import type { ComparisonBaseline } from "../../src/index.ts";

export type SavedReferenceView = Readonly<{ baseline: ComparisonBaseline; state: ViewState }>;

export function restoreReferenceView(
    editor: TextEditor, baseline: ComparisonBaseline, saved?: SavedReferenceView,
): boolean {
    if (!saved || saved.baseline.buffer !== baseline.buffer || saved.baseline.version !== baseline.version) return false;
    // Remounting the same saved bytes creates a new private document. Carry over only anchors for those bytes.
    const { folding, verticalAnchor, horizontalAnchor, ...state } = saved.state;
    const revision = editor.view.getSnapshot().revision;
    editor.restoreView({ ...state,
        ...(folding && { folding: { ...folding, documentId: editor.view.documentId, revision } }),
        ...(verticalAnchor && verticalAnchor.revision === folding?.revision
            && { verticalAnchor: { ...verticalAnchor, revision } }),
        ...(horizontalAnchor && horizontalAnchor.revision === folding?.revision
            && { horizontalAnchor: { ...horizontalAnchor, revision } }),
    });
    return true;
}
