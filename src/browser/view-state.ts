import type { Affinity } from "../core/positions.ts";
import type { DocumentChange, DocumentId, DocumentSnapshot, DocumentView, ViewId } from "../core/workspace.ts";
import type { Selection } from "../core/history.ts";
import { createSelectionSet } from "../core/selections.ts";
import type { SelectionSet } from "../core/selections.ts";
import type { FoldRange } from "../core/folding.ts";

export type ViewState = Selection & Readonly<{ scrollTop: number; scrollLeft: number;
    verticalAnchor?: Readonly<{ revision: number; offset: number; topRemainder: number; aligned?: true }>;
    selectionSet?: SelectionSet;
    folding?: Readonly<{ documentId: DocumentId; viewId: ViewId; revision: number; generation: number; regions: readonly FoldRange[] }>;
    horizontalAnchor?: Readonly<{ revision: number; offset: number; affinity: Affinity; left: number }> }>;

export type ViewRestoreOptions = Readonly<{ selection?: "captured" | "current" }>;
export type ViewRestoreResult = Readonly<{
    selection: "captured" | "current" | "mapped" | "clamped";
    foldsRestored: boolean; horizontalAnchorRestored: boolean; verticalAnchorRestored: boolean;
}>;

export function mapViewAnchor<T extends { revision: number; offset: number; affinity?: Affinity }>(
    anchor: T | undefined, revision: number, change: DocumentChange | null,
) {
    if (!anchor || anchor.revision === revision) return anchor;
    if (change?.previousRevision === anchor.revision)
        return { ...anchor, revision, offset: change.mapViewOffset(anchor.offset, anchor.affinity ?? "before") };
}

/** A retained view has followed every edit. A fresh view can map through the last document change. */
export function selectionToRestore(document: DocumentSnapshot, view: DocumentView, state: ViewState, options: ViewRestoreOptions):
    { set: SelectionSet; source: ViewRestoreResult["selection"] } {
    const mode = options.selection ?? "captured", saved = state.folding;
    if (mode !== "captured" && mode !== "current") throw new RangeError("Invalid view selection policy.");
    if (mode === "current" || saved?.viewId === view.id && saved.revision !== document.revision)
        return { set: view.getSnapshot().selectionSet, source: "current" };
    const capture = state.selectionSet ?? { ranges: [state], primary: 0 }, length = document.buffer.length;
    if (saved && document.change?.previousRevision === saved.revision)
        return { set: document.change.mapSelections(capture), source: "mapped" };
    const set = createSelectionSet(saved?.revision === document.revision ? length : Number.MAX_SAFE_INTEGER, capture.ranges, capture.primary);
    const last = set.ranges[set.ranges.length - 1]!;
    if (Math.max(last.anchor, last.head) > length) {
        const ranges = set.ranges.map(r => ({ ...r, anchor: Math.min(r.anchor, length), head: Math.min(r.head, length) }));
        return { set: createSelectionSet(length, ranges, set.primary), source: "clamped" };
    }
    return { set, source: "captured" };
}
