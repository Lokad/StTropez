import type { TextBuffer } from "./text-buffer.ts";

export type GraphemePoint = Readonly<{ offset: number; floor: number; ceil: number; preceding: number | null; following: number | null }>;

/** An exact answer at one offset, or no answer. Never constructs an index from clipped context. */
export function localAsciiGraphemePoint(buffer: TextBuffer, offset: number): GraphemePoint | undefined {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length) throw new RangeError("Invalid grapheme offset.");
    const text = buffer.slice(Math.max(0, offset - 2), Math.min(buffer.length, offset + 2));
    // ASCII has only Other/Control/CR/LF grapheme properties. Excluding CR leaves
    // a break at every adjacent pair (GB4/5/999). Two units on each side prove
    // the target and its immediate neighbors, regardless of more distant context.
    // Non-ASCII and CR require the existing context-sensitive segmentation path.
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f || text.charCodeAt(i) === 13) return;
    return Object.freeze({ offset, floor: offset, ceil: offset,
        preceding: offset > 0 ? offset - 1 : null, following: offset < buffer.length ? offset + 1 : null });
}
