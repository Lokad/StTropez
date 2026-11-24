import { isOffset } from "./bounds.ts";
import type { TextBuffer } from "./text-buffer.ts";

export type GraphemePoint = Readonly<{ offset: number; floor: number; ceil: number; preceding: number | null; following: number | null }>;

/** An exact answer at one offset, or no answer. Never constructs an index from clipped context. */
export function localAsciiGraphemePoint(buffer: TextBuffer, offset: number): GraphemePoint | undefined {
    if (!isOffset(offset, buffer.length)) throw new RangeError("Invalid grapheme offset.");
    const from = Math.max(0, offset - 2), text = buffer.slice(from, Math.min(buffer.length, offset + 2));
    // ASCII has only Other/Control/CR/LF properties. CR x LF is its sole non-break
    // pair (GB3/4/5/999). Two units per side prove the point and adjacent boundaries;
    // non-ASCII still requires the existing context-sensitive segmentation path.
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return;
    const at = offset - from, before = text.charCodeAt(at - 1), after = text.charCodeAt(at), inside = before === 13 && after === 10;
    return Object.freeze({ offset, floor: offset - Number(inside), ceil: offset + Number(inside),
        preceding: offset > 0 ? offset - (before === 10 && text.charCodeAt(at - 2) === 13 ? 2 : 1) : null,
        following: offset < buffer.length ? offset + (after === 13 && text.charCodeAt(at + 1) === 10 ? 2 : 1) : null });
}
