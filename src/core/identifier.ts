import type { TextBuffer } from "./text-buffer.ts";

/** Both ends are inclusive for a caret. Read past the limit to detect clipped identifiers. */
export function identifierAt(buffer: Pick<TextBuffer, "length" | "slice">, offset: number, limit: number) {
    const from = Math.max(0, offset - limit - 2);
    const text = buffer.slice(from, Math.min(buffer.length, offset + limit + 2));
    for (const match of text.matchAll(/[$\p{ID_Continue}\u200c\u200d]+/gu)) {
        const start = from + match.index;
        if (start > offset) break;
        if (offset <= start + match[0].length) return match[0].length <= limit ? match[0] : undefined;
    }
}
