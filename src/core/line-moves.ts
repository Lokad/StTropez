import { lineContentEnd } from "./newlines.ts";
import { positionChanges, type PositionMapping } from "./positions.ts";
import type { TextBuffer } from "./text-buffer.ts";

/** Swap the adjacent half-open source line intervals [first, middle) and [middle, end). */
export type LineSwap = Readonly<{ first: number; middle: number; end: number }>;

/** A line move transfers a whole block and rotates its boundary newline to the other end. */
export function lineSwaps(before: TextBuffer, after: TextBuffer, mapping: PositionMapping): LineSwap[] | undefined {
    const changes = positionChanges(mapping);
    if (!changes?.[0]?.lineMove || changes.length % 2) return;
    const swaps: LineSwap[] = [];
    for (let i = 0; i < changes.length; i += 2) {
        const leading = changes[i]!;
        const trailing = changes[i + 1]!;
        if (leading.lineMove !== true) return;
        const cutFirst = leading.insertedLength === 0;
        const cut = cutFirst ? leading : trailing;
        const paste = cutFirst ? trailing : leading;
        if (cut.insertedLength || paste.from !== paste.to || paste.insertedLength !== cut.to - cut.from) return;
        const first = before.lineAt(leading.from);
        const last = before.lineAt(trailing.to);
        const middle = cutFirst ? before.lineAt(cut.to) : before.lineAt(cut.from) + 1;
        if (middle <= first || middle > last) return;
        if (leading.from !== before.offsetAt(first) || trailing.to !== lineContentEnd(before, last)) return;
        const middleStart = before.offsetAt(middle);
        const previousEnd = lineContentEnd(before, middle - 1);
        if (cutFirst ? cut.to !== middleStart : cut.from !== previousEnd) return;
        const split = cutFirst ? previousEnd : middleStart;
        // Earlier pairs have zero net length. Only a cut before this paste shifts its destination.
        const at = cutFirst ? paste.from - paste.insertedLength : paste.from;
        const rotated = before.slice(split, cut.to) + before.slice(cut.from, split);
        if (after.slice(at, at + paste.insertedLength) !== rotated) return;
        swaps.push({ first, middle, end: last + 1 });
    }
    return swaps;
}
