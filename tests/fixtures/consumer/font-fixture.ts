/** Original rectangles, mappings and binary fixture data. No third-party font or implementation. */
class FontBytes {
    readonly data: Uint8Array;
    readonly view: DataView;
    constructor(length: number) { this.data = new Uint8Array(length); this.view = new DataView(this.data.buffer); }
    u8(at: number, value: number): this { this.view.setUint8(at, value); return this; }
    u16(at: number, value: number): this { this.view.setUint16(at, value); return this; }
    i16(at: number, value: number): this { this.view.setInt16(at, value); return this; }
    u24(at: number, value: number): this { return this.u8(at, value >>> 16).u16(at + 1, value); }
    u32(at: number, value: number): this { this.view.setUint32(at, value); return this; }
    tag(at: number, value: string): this { for (let i = 0; i < 4; i++) this.u8(at + i, value.charCodeAt(i)); return this; }
    put(at: number, value: Uint8Array): this { this.data.set(value, at); return this; }
}
function fontChecksum(data: Uint8Array): number {
    let sum = 0; for (let i = 0; i < data.length; i += 4) sum = (sum + ((data[i] ?? 0) * 0x1000000 + (data[i + 1] ?? 0) * 65536 + (data[i + 2] ?? 0) * 256 + (data[i + 3] ?? 0))) >>> 0; return sum;
}
function assembleFont(tables: ReadonlyMap<string, Uint8Array>, signature = 0x10000): Uint8Array {
    const sorted = [...tables].sort(([a], [b]) => a < b ? -1 : 1), count = sorted.length, power = 2 ** Math.floor(Math.log2(count));
    let length = 12 + count * 16; for (const [, data] of sorted) length += Math.ceil(data.length / 4) * 4;
    const b = new FontBytes(length).u32(0, signature).u16(4, count).u16(6, power * 16).u16(8, Math.log2(power)).u16(10, count * 16 - power * 16);
    let at = 12 + count * 16, head = -1;
    sorted.forEach(([tag, bytes], index) => {
        const data = new Uint8Array(bytes); if (tag === "head") { new DataView(data.buffer).setUint32(8, 0); head = at; }
        const p = 12 + index * 16; b.tag(p, tag).u32(p + 4, fontChecksum(data)).u32(p + 8, at).u32(p + 12, data.length).put(at, data); at += Math.ceil(data.length / 4) * 4;
    });
    if (head >= 0) b.u32(head + 8, (0xb1b0afba - fontChecksum(b.data)) >>> 0); return b.data;
}
function cmapTable(records: readonly Readonly<{ platform: number; encoding: number; bytes: Uint8Array }>[]): Uint8Array {
    const b = new FontBytes(4 + records.length * 8 + records.reduce((n, r) => n + Math.ceil(r.bytes.length / 4) * 4, 0)).u16(2, records.length); let offset = 4 + records.length * 8;
    records.forEach((r, i) => { b.u16(4 + i * 8, r.platform).u16(6 + i * 8, r.encoding).u32(8 + i * 8, offset).put(offset, r.bytes); offset += Math.ceil(r.bytes.length / 4) * 4; }); return b.data;
}
const fixtureMappings = Object.freeze([[0x20, 1], [0x41, 2], [0x42, 3], [0x66, 4], [0x69, 5], [0x301, 9], [0x1f600, 7]].map(pair => Object.freeze(pair)));
function basicCmaps(): Uint8Array {
    const bmp = fixtureMappings.filter(pair => pair[0]! <= 0xffff), count = bmp.length + 1, four = new FontBytes(16 + count * 8).u16(0, 4).u16(2, 16 + count * 8).u16(6, count * 2);
    const power = 2 ** Math.floor(Math.log2(count)); four.u16(8, power * 2).u16(10, Math.log2(power)).u16(12, count * 2 - power * 2);
    [...bmp, [0xffff, 0]].forEach(([code, glyph], i) => { four.u16(14 + i * 2, code!).u16(16 + count * 2 + i * 2, code!).u16(16 + count * 4 + i * 2, (glyph! - code!) & 0xffff); });
    const twelve = new FontBytes(16 + fixtureMappings.length * 12).u16(0, 12).u32(4, 16 + fixtureMappings.length * 12).u32(12, fixtureMappings.length);
    fixtureMappings.forEach(([code, glyph], i) => twelve.u32(16 + i * 12, code!).u32(20 + i * 12, code!).u32(24 + i * 12, glyph!));
    return cmapTable([{ platform: 3, encoding: 1, bytes: four.data }, { platform: 3, encoding: 10, bytes: twelve.data }]);
}
function glyph(width: number, height: number, bottom = 0): Uint8Array {
    const b = new FontBytes(36).i16(0, 1).i16(2, 0).i16(4, bottom).i16(6, width).i16(8, bottom + height).u16(10, 3).u16(12, 0);
    for (let i = 0; i < 4; i++) b.u8(14 + i, 1);
    [0, width, 0, -width].forEach((value, i) => b.i16(18 + i * 2, value)); [bottom, 0, height, 0].forEach((value, i) => b.i16(26 + i * 2, value)); return b.data;
}

export function fontFixture(options: Readonly<{ advanceA?: number }> = {}): Uint8Array {
    const head = new FontBytes(54).u32(0, 0x10000).u32(4, 0x10000).u32(12, 0x5f0f3cf5).u16(16, 3).u16(18, 1000).i16(40, 1000).i16(42, 850).u16(46, 8).i16(48, 2).i16(50, 1);
    const widths = [500, 250, options.advanceA ?? 600, 700, 400, 200, 500, 1000, 900, 0], metricCount = widths.length;
    const hhea = new FontBytes(36).u32(0, 0x10000).i16(4, 800).i16(6, -200).u16(10, 1000).i16(16, 1000).i16(18, 1).u16(34, metricCount);
    const hmtx = new FontBytes(metricCount * 4 + (10 - metricCount) * 2); for (let i = 0; i < metricCount; i++) hmtx.u16(i * 4, widths[i]!);
    const maxp = new FontBytes(32).u32(0, 0x10000).u16(4, 10).u16(6, 4).u16(8, 1).u16(14, 2);
    const os2 = new FontBytes(96).u16(0, 4).i16(2, 500).u16(4, 400).u16(6, 5).u32(42, 1).tag(58, "STTR").u16(62, 0x40).u16(64, 0x20).u16(66, 0xffff)
        .i16(68, 800).i16(70, -200).u16(74, 850).u16(76, 200).u32(78, 1).i16(86, 500).i16(88, 700).u16(92, 32).u16(94, 2);
    const post = new FontBytes(32).u32(0, 0x30000).i16(8, -100).i16(10, 50);
    const names = [[1, "StTropez Fixture"], [2, "Regular"], [4, "StTropez Fixture Regular"], [6, "StTropezFixture-Regular"]] as const;
    const name = new FontBytes(6 + names.length * 12 + names.reduce((n, entry) => n + entry[1].length * 2, 0)).u16(2, names.length).u16(4, 6 + names.length * 12); let at = 0;
    names.forEach(([id, value], i) => { const p = 6 + i * 12; name.u16(p, 3).u16(p + 2, 1).u16(p + 4, 0x409).u16(p + 6, id).u16(p + 8, value.length * 2).u16(p + 10, at);
        for (const char of value) { name.u16(6 + names.length * 12 + at, char.charCodeAt(0)); at += 2; } });
    const tables = new Map<string, Uint8Array>([["head", head.data], ["hhea", hhea.data], ["maxp", maxp.data], ["hmtx", hmtx.data], ["cmap", basicCmaps()], ["OS/2", os2.data], ["post", post.data], ["name", name.data]]);
    {
        const outlines = widths.map((width, i) => i === 1 ? new Uint8Array(0) : glyph(i === 9 ? 150 : Math.max(100, width - 100), i === 9 ? 150 : 700, i === 9 ? 700 : 0));
        const loca = new FontBytes(44), glyf = new FontBytes(outlines.reduce((sum, data) => sum + data.length, 0)); let offset = 0;
        outlines.forEach((data, i) => { loca.u32(i * 4, offset); glyf.put(offset, data); offset += data.length; }); loca.u32(40, offset); tables.set("loca", loca.data); tables.set("glyf", glyf.data);
    }
    return assembleFont(tables);
}
