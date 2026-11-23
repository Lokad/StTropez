import type { TextEdit } from "./changes.ts";
import type { TextBuffer } from "./text-buffer.ts";

/** Swap the adjacent half-open source line intervals [first, middle) and [middle, end). */
export type LineSwap = Readonly<{ first: number; middle: number; end: number }>;
const proposals = new WeakMap<readonly TextEdit[], { source: TextBuffer; swaps: readonly LineSwap[] }>();

export function recordLineMovePlan(source: TextBuffer, edits: readonly TextEdit[], swaps: readonly LineSwap[]): void {
    if (swaps.length) proposals.set(edits, { source, swaps });
}

/** Only the planner's own frozen edits applied to their original buffer describe a row move. */
export function plannedLineSwaps(source: TextBuffer, edits: readonly TextEdit[]): readonly LineSwap[] | undefined {
    const plan = proposals.get(edits);
    return plan?.source === source ? plan.swaps : undefined;
}
