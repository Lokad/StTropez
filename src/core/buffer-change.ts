import type { TextBuffer } from "./text-buffer.ts";
export type BufferChangeSpan = Readonly<{ from: number; to: number; insertFrom: number; insertTo: number }>;

/** Return a replacement span after skipping storage shared by the two versions. */
export function bufferDifference(before: TextBuffer, after: TextBuffer): BufferChangeSpan {
    let from = 0, suffix = 0;
    for (const length of before.sharedEdge(after, "start")) from = length;
    const rest = { from, to: before.length, otherFrom: from, otherTo: after.length };
    for (const length of before.sharedEdge(after, "end", rest)) suffix = length;
    return Object.freeze({ from, to: before.length - suffix, insertFrom: from, insertTo: after.length - suffix });
}
