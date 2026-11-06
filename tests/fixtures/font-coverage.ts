import { FontBytes, assembleFont, cmapTable, fontFixture, fontTables } from "./consumer/font-fixture.ts";
export type CoverageVariation = Readonly<{ base: number; selector: number; glyph?: number }>;
/** Original rectangle font with deliberately narrow Unicode coverage. */
export function coverageFontFixture(mappings: readonly (number | readonly [number, number])[], variations: readonly CoverageVariation[] = [], options: Readonly<{ advanceA?: number }> = {}): Uint8Array {
    const entries = mappings.map(v => typeof v === "number" ? [v, 2] as const : v).sort((a, b) => a[0] - b[0]), unique = [...new Map(entries.map(v => [v[0], v])).values()], table = new FontBytes(16 + unique.length * 12).u16(0, 12).u32(4, 16 + unique.length * 12).u32(12, unique.length);
    unique.forEach(([cp, gid], i) => table.u32(16 + i * 12, cp).u32(20 + i * 12, cp).u32(24 + i * 12, gid));
    const records: { platform: number; encoding: number; bytes: Uint8Array }[] = [], selectors = [...new Set(variations.map(v => v.selector))].sort((a, b) => a - b);
    if (selectors.length) {
        const variation = new FontBytes(10 + selectors.length * 11 + selectors.reduce((n, s) => n + 4 + variations.filter(v => v.selector === s).length * 5, 0)).u16(0, 14).u32(6, selectors.length);
        variation.u32(2, variation.data.length); let at = 10 + selectors.length * 11;
        selectors.forEach((selector, i) => { const rows = variations.filter(v => v.selector === selector).sort((a, b) => a.base - b.base); variation.u24(10 + i * 11, selector).u32(17 + i * 11, at).u32(at, rows.length); rows.forEach((row, j) => variation.u24(at + 4 + j * 5, row.base).u16(at + 7 + j * 5, row.glyph ?? 8)); at += 4 + rows.length * 5; });
        records.push({ platform: 0, encoding: 5, bytes: variation.data });
    }
    records.push({ platform: 3, encoding: 10, bytes: table.data }); const tables = fontTables(fontFixture(options)); tables.set("cmap", cmapTable(records)); tables.delete("GSUB"); tables.delete("kern"); return assembleFont(tables);
}
