import test from "node:test";
import assert from "node:assert/strict";
import { AdvanceIndex, SfntFont } from "../src/index.ts";
import { FontBytes, assembleFont, cmapTable, fixtureMappings, fontChecksum, fontFixture, fontTables } from "./fixtures/consumer/font-fixture.ts";

function withMap(bytes: Uint8Array, format: number, platform = 0, encoding = format === 13 ? 6 : format >= 8 ? 4 : 3): SfntFont {
    const tables = fontTables(fontFixture()); tables.set("cmap", cmapTable([{ platform, encoding, bytes }])); return SfntFont.from(assembleFont(tables));
}

test("owned SFNT data selects full Unicode mappings, preserves variations and exposes nominal metrics", () => {
    const bytes = fontFixture(), font = SfntFont.from(bytes); assert.equal(fontChecksum(bytes), 0xb1b0afba);
    assert.equal(font.metadata.unicodeEncoding, 2); assert.equal(font.metadata.unitsPerEm, 1000); assert.equal(font.metadata.glyphCount, 10);
    assert.equal(font.metadata.outline, "truetype"); assert.deepEqual([font.metadata.ascent, font.metadata.descent, font.metadata.lineGap], [800, -200, 0]);
    for (const [code, glyph] of fixtureMappings) assert.equal(font.glyphIndex(code!), glyph);
    assert.equal(font.glyphIndex(0x43), 0); assert.equal(font.variationGlyphIndex(0x41, 0xfe00), 2); assert.equal(font.variationGlyphIndex(0x41, 0xfe0f), 8);
    assert.equal(font.variationGlyphIndex(0x42, 0xfe0f), null); assert.equal(font.variationGlyphIndex(0x41, 0xe0100), null);
    assert.deepEqual(font.nominalGlyphMetrics(8), { advanceWidth: 900, leftSideBearing: 0 });
    const index = AdvanceIndex.from([font.nominalGlyphMetrics(2).advanceWidth, font.nominalGlyphMetrics(1).advanceWidth, font.nominalGlyphMetrics(3).advanceWidth]); assert.equal(index.total, 1550);
    bytes.fill(0); assert.equal(font.glyphIndex(0x1f600), 7); assert.equal(font.nominalGlyphMetrics(2).advanceWidth, 600);
    for (const value of [font, font.metadata, font.metadata.tables, font.metadata.encodings, font.metadata.encodings[0], font.nominalGlyphMetrics(0)]) assert.ok(Object.isFrozen(value));
    for (const invalid of [-1, .5, 0x110000, 0xd800, NaN]) assert.throws(() => font.glyphIndex(invalid)); assert.throws(() => font.nominalGlyphMetrics(10));
});

test("compressed hmtx advances reuse the final metric while retaining per-glyph signed bearings", () => {
    const tables = fontTables(fontFixture({ metricCount: 8 })), hmtx = tables.get("hmtx")!; new DataView(hmtx.buffer).setInt16(34, -37);
    const font = SfntFont.from(assembleFont(tables)); assert.deepEqual(font.nominalGlyphMetrics(9), { advanceWidth: 1000, leftSideBearing: -37 });
    assert.equal(font.nominalGlyphMetrics(8).advanceWidth, 1000);
});

test("cmap formats 0, 6 and 10 map trimmed arrays without confusing encoded or Unicode inputs", () => {
    const zero = new FontBytes(262).u16(0, 0).u16(2, 262).u8(6 + 65, 2), legacy = withMap(zero.data, 0, 1, 0);
    assert.equal(legacy.metadata.unicodeEncoding, null); assert.throws(() => legacy.glyphIndex(65)); assert.equal(legacy.encodedGlyphIndex(0, 65), 2); assert.equal(legacy.encodedGlyphIndex(0, 256), 0);
    const six = new FontBytes(14).u16(0, 6).u16(2, 14).u16(6, 65).u16(8, 2).u16(10, 2).u16(12, 3), bmp = withMap(six.data, 6);
    assert.equal(bmp.glyphIndex(65), 2); assert.equal(bmp.glyphIndex(66), 3); assert.equal(bmp.glyphIndex(64), 0);
    const ten = new FontBytes(24).u16(0, 10).u32(4, 24).u32(12, 0x1f600).u32(16, 2).u16(20, 7).u16(22, 8), full = withMap(ten.data, 10);
    assert.equal(full.glyphIndex(0x1f600), 7); assert.equal(full.glyphIndex(0x1f601), 8); assert.equal(full.glyphIndex(0x41), 0);
});

test("cmap format 2 distinguishes single bytes from high-byte subheaders and applies signed deltas", () => {
    const b = new FontBytes(538).u16(0, 2).u16(2, 538).u16(6 + 0x81 * 2, 8);
    b.u16(518, 65).u16(520, 1).i16(522, -1).u16(524, 10).u16(526, 0x40).u16(528, 1).i16(530, 1).u16(532, 4).u16(534, 3).u16(536, 3);
    const font = withMap(b.data, 2); assert.equal(font.glyphIndex(65), 2); assert.equal(font.glyphIndex(0x8140), 4); assert.equal(font.glyphIndex(0x81), 0);
    assert.equal(font.glyphIndex(0x4141), 0); assert.equal(font.glyphIndex(0x8141), 0); assert.equal(font.glyphIndex(0x10000), 0);
});

test("cmap format 4 respects relative glyph words, missing zero entries and modulo deltas", () => {
    const b = new FontBytes(36).u16(0, 4).u16(2, 36).u16(6, 4).u16(14, 66).u16(16, 0xffff).u16(20, 65).u16(22, 0xffff).i16(24, 1).i16(26, 1).u16(28, 4).u16(32, 2).u16(34, 0);
    const font = withMap(b.data, 4); assert.equal(font.glyphIndex(65), 3); assert.equal(font.glyphIndex(66), 0); assert.equal(font.glyphIndex(0xffff), 0);
    assert.equal(font.glyphIndex(64), 0); assert.equal(font.glyphIndex(0x10000), 0);
});

test("cmap formats 8, 12 and 13 use sorted groups with sequential or constant glyphs", () => {
    const eight = new FontBytes(8232).u16(0, 8).u32(4, 8232).u8(12, 0x40).u32(8204, 2).u32(8208, 65).u32(8212, 66).u32(8216, 2).u32(8220, 0x1f600).u32(8224, 0x1f600).u32(8228, 7);
    const old = withMap(eight.data, 8); assert.equal(old.glyphIndex(65), 2); assert.equal(old.glyphIndex(66), 3); assert.equal(old.glyphIndex(0x1f600), 7); assert.equal(old.glyphIndex(1), 0);
    const twelve = new FontBytes(28).u16(0, 12).u32(4, 28).u32(12, 1).u32(16, 65).u32(20, 66).u32(24, 2), full = withMap(twelve.data, 12);
    assert.equal(full.glyphIndex(66), 3);
    const thirteen = new FontBytes(28).u16(0, 13).u32(4, 28).u32(12, 1).u32(16, 0).u32(20, 0x10ffff).u32(24, 7), fallback = withMap(thirteen.data, 13);
    assert.equal(fallback.glyphIndex(0), 7); assert.equal(fallback.glyphIndex(0x10ffff), 7); assert.equal(fallback.glyphIndex(0x1f600), 7);
});

test("collection faces use absolute table offsets and retain independent nominal font identities", () => {
    const fonts = [fontFixture(), fontFixture({ advanceA: 800 })], b = new FontBytes(20 + fonts.reduce((sum, bytes) => sum + bytes.length, 0)).tag(0, "ttcf").u32(4, 0x10000).u32(8, 2); let at = 20;
    fonts.forEach((bytes, i) => { const copy = new Uint8Array(bytes), view = new DataView(copy.buffer); for (let table = 0; table < view.getUint16(4); table++) { const p = 12 + table * 16 + 8; view.setUint32(p, view.getUint32(p) + at); } b.u32(12 + i * 4, at).put(at, copy); at += bytes.length; });
    const first = SfntFont.from(b.data), second = SfntFont.from(b.data, { faceIndex: 1 }); assert.equal(first.metadata.container, "collection"); assert.equal(second.metadata.faceCount, 2);
    assert.equal(first.nominalGlyphMetrics(2).advanceWidth, 600); assert.equal(second.nominalGlyphMetrics(2).advanceWidth, 800); assert.throws(() => SfntFont.from(b.data, { faceIndex: 2 }));
});

test("truncated tables and malformed metrics/maps fail before publishing a font snapshot", () => {
    const bytes = fontFixture(); for (let end = 0; end < bytes.length; end += 7) assert.throws(() => SfntFont.from(bytes.slice(0, end)));
    const malformed = (change: (tables: Map<string, Uint8Array>) => void) => { const tables = fontTables(bytes); change(tables); assert.throws(() => SfntFont.from(assembleFont(tables))); };
    malformed(t => new DataView(t.get("head")!.buffer).setUint16(18, 0)); malformed(t => new DataView(t.get("hhea")!.buffer).setUint16(34, 11));
    malformed(t => t.set("hmtx", t.get("hmtx")!.slice(0, 4))); malformed(t => t.set("cmap", cmapTable([{ platform: 0, encoding: 3, bytes: new FontBytes(262).u16(2, 262).u8(6, 99).data }])));
    const duplicate = new Uint8Array(bytes), duplicateView = new DataView(duplicate.buffer); duplicate.set(duplicate.slice(12, 16), 28); assert.throws(() => SfntFont.from(duplicate));
    duplicateView.setUint32(0, 0x774f4632); assert.throws(() => SfntFont.from(duplicate), /uncompressed/);
});
