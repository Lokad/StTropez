import type { TextBuffer } from "../../../src/index.ts";

export const maxIdentifierUnits = 256;

/** A caret just after an identifier still names it. Read one extra code point on either side to detect clipping. */
export function identifierAt(source: Pick<TextBuffer, "length" | "slice">, offset: number) {
    const radius = maxIdentifierUnits + 2;
    const start = Math.max(0, offset - radius);
    const end = Math.min(source.length, offset + radius);
    const text = source.slice(start, end);
    for (const match of text.matchAll(/[\p{L}\p{N}\p{Pc}\p{M}\u200c\u200d]+/gu)) {
        const from = start + match.index;
        const name = match[0];
        const to = from + name.length;
        if (offset < from) break;
        if (offset > to) continue;
        if (name.length > maxIdentifierUnits || from === start && start > 0 || to === end && end < source.length) break;
        return { name, from, to };
    }
}
