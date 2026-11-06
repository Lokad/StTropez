import { FontReader, fontSearch, invalidFont as invalid } from "./font-reader.ts";
export type KernSubtable = Readonly<{ crossStream: boolean; override: boolean; value: (left: number, right: number) => number | null }>;
/** OpenType version-0 kerning. Apple state-machine containers remain a separate qualification. */
export function readKern(table: FontReader | undefined, glyphCount: number): readonly KernSubtable[] {
    if (!table) return []; if (table.u16(0) !== 0) throw new Error("Unsupported legacy kern container."); const count = table.u16(2), result: KernSubtable[] = []; let offset = 4;
    for (let i = 0; i < count; i++) {
        table.span(offset, 6); const size = table.u16(offset + 2), b = table.sub(offset, size), coverage = b.u16(4), format = coverage >>> 8; offset += size;
        if (size < 6 || b.u16(0) !== 0 || coverage & 0xf0) invalid("kern subtable header"); if (!(coverage & 1)) continue;
        if (coverage & 2) throw new Error("Minimum-distance kern subtables are not implemented."); let value: KernSubtable["value"];
        if (format === 0) {
            const pairs = b.u16(6); b.span(6, 8 + pairs * 6); let previous = -1;
            for (let j = 0; j < pairs; j++) { const p = 14 + j * 6, key = b.u32(p); if (key <= previous || b.u16(p) >= glyphCount || b.u16(p + 2) >= glyphCount) invalid("kern pair order/glyph"); previous = key; }
            value = (left, right) => { const key = left * 65536 + right, at = fontSearch(pairs, j => b.u32(14 + j * 6), key); return at < pairs && b.u32(14 + at * 6) === key ? b.i16(18 + at * 6) : null; };
        } else if (format === 2) {
            const rowWidth = b.u16(6), array = b.u16(12); if (!rowWidth || rowWidth % 2) invalid("kern row width");
            const classes = (at: number, left: boolean) => { const c = b.tail(at), first = c.u16(0), n = c.u16(2); if (first + n > glyphCount) invalid("kern class glyphs"); c.span(4, n * 2); let maximum = 0;
                for (let j = 0; j < n; j++) { const v = c.u16(4 + j * 2); if (v % (left ? rowWidth : 2) || !left && v >= rowWidth) invalid("kern class offset"); maximum = Math.max(maximum, v); }
                return { maximum, get: (glyph: number) => glyph >= first && glyph < first + n ? c.u16(4 + (glyph - first) * 2) : 0 }; };
            const left = classes(b.u16(8), true), right = classes(b.u16(10), false); b.span(array, left.maximum + right.maximum + 2);
            value = (a, c) => b.i16(array + left.get(a) + right.get(c));
        } else throw new Error(`Unsupported legacy kern format ${format}.`);
        result.push({ crossStream: !!(coverage & 4), override: !!(coverage & 8), value });
    }
    return result;
}
