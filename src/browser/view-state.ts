import type { Affinity } from "../core/positions.ts";
import type { DocumentId, ViewId } from "../core/workspace.ts";
import type { Selection } from "../core/history.ts";
import type { SelectionSet } from "../core/selections.ts";
import type { FoldRange } from "../core/folding.ts";

export type ViewState = Selection & Readonly<{ scrollTop: number; scrollLeft: number;
    verticalAnchor?: Readonly<{ revision: number; offset: number; topRemainder: number; aligned?: true }>;
    selectionSet?: SelectionSet;
    folding?: Readonly<{ documentId: DocumentId; viewId: ViewId; revision: number; generation: number; regions: readonly FoldRange[] }>;
    horizontalAnchor?: Readonly<{ revision: number; offset: number; affinity: Affinity; left: number }> }>;
