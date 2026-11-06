import { assembleFont, cmapTable, fixtureMappings, FontBytes, fontFixture, fontTables } from "./consumer/font-fixture.ts";
import { gsub, language, ligatures, lookup, script, single } from "./substitution.ts";

/** Original rectangle outlines with conflicting script-specific features and a whole-run control. */
export function scriptFontFixture(): Uint8Array {
    const tables = fontTables(fontFixture()), mappings = [...fixtureMappings, [0x3b1, 2], [0x3b2, 3], [0x5d0, 2], [0x5d1, 3]].sort(([a], [b]) => a! - b!);
    const cmap = new FontBytes(16 + mappings.length * 12).u16(0, 12).u32(4, 16 + mappings.length * 12).u32(12, mappings.length);
    mappings.forEach(([cp, glyph], i) => cmap.u32(16 + i * 12, cp!).u32(20 + i * 12, cp!).u32(24 + i * 12, glyph!));
    tables.set("cmap", cmapTable([{ platform: 3, encoding: 10, bytes: cmap.data }]));
    tables.set("GSUB", gsub([lookup(1, [single([2], [3])]), lookup(1, [single([2], [4])]), lookup(1, [single([2], [5])]), lookup(4, [ligatures([2], [[{ to: 6, rest: [2] }]])])], {
        features: [{ tag: "test", lookups: [3] }, { tag: "test", lookups: [0] }, { tag: "test", lookups: [1] }, { tag: "test", lookups: [2] }],
        scripts: [{ tag: "DFLT", bytes: script(language([0])) }, { tag: "grek", bytes: script(language([2])) }, { tag: "hebr", bytes: script(language([3])) }, { tag: "latn", bytes: script(language([1])) }]
    }));
    return assembleFont(tables);
}
