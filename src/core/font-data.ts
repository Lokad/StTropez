import { FontReader as Bytes, fontSearch as lowerBound, invalidFont as invalid } from "./font-reader.ts";
import { createSubstitutionPlan } from "./font-substitution.ts";
import type { SubstitutionOptions, SubstitutionPlan } from "./font-substitution.ts";
import { createPositioningPlan } from "./font-positioning.ts";
import type { PositioningOptions, PositioningPlan } from "./font-positioning.ts";
import { createGlyphRunBuilder } from "./glyph-run.ts";
import type { GlyphRunBuilder } from "./glyph-run.ts";
import { createGlyphMappingCursor } from "./glyph-mapping.ts";
import type { GlyphMappingCursor, GlyphMappingOptions } from "./glyph-mapping.ts";
import type { NormalizedText } from "./unicode-normalization.ts";
export type FontEncoding = Readonly<{ platformId: number; encodingId: number; format: number; language: number | null }>;
export type NominalGlyphMetrics = Readonly<{ advanceWidth: number; leftSideBearing: number }>;
export type SfntMetadata = Readonly<{ container: "sfnt" | "collection"; faceIndex: number; faceCount: number; byteLength: number;
    unitsPerEm: number; glyphCount: number; ascent: number; descent: number; lineGap: number; flags: number;
    outline: "truetype" | "cff" | "cff2" | "unknown"; variable: boolean; tables: readonly string[];
    encodings: readonly FontEncoding[]; unicodeEncoding: number | null; variationEncoding: number | null }>;

type Mapping = Readonly<{ info: FontEncoding; lookup: (code: number) => number; variation?: (code: number, selector: number, base: () => number) => number | null }>;
const integer = (value: number, maximum: number) => { if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError("Invalid font query."); };
const scalar = (code: number) => { integer(code, 0x10ffff); if (code >= 0xd800 && code <= 0xdfff) throw new RangeError("Expected a Unicode scalar."); };

function mapping(cmap: Bytes, offset: number, platformId: number, encodingId: number, glyphCount: number): Mapping {
    const format = cmap.u16(offset), length = format === 14 ? cmap.u32(offset + 2) : format >= 8 ? cmap.u32(offset + 4) : cmap.u16(offset + 2), b = cmap.sub(offset, length);
    const glyph = (value: number) => { if (value >= glyphCount) invalid("glyph index exceeds maxp"); return value; };
    const language = format === 14 ? null : format >= 8 ? b.u32(8) : b.u16(4);
    const info = Object.freeze({ platformId, encodingId, format, language });
    if (format === 0) {
        b.span(6, 256); for (let i = 0; i < 256; i++) glyph(b.u8(6 + i));
        return { info, lookup: code => code < 256 ? b.u8(6 + code) : 0 };
    }
    if (format === 2) {
        b.span(6, 512); let maximumKey = 0;
        for (let i = 0; i < 256; i++) { const key = b.u16(6 + i * 2); if (key % 8) invalid("unaligned cmap subheader"); maximumKey = Math.max(maximumKey, key); }
        const count = maximumKey / 8 + 1, arrayStart = 518 + count * 8; b.span(518, count * 8);
        for (let i = 0; i < count; i++) {
            const p = 518 + i * 8, first = b.u16(p), entries = b.u16(p + 2), delta = b.i16(p + 4), at = p + 6 + b.u16(p + 6);
            if (first + entries > 256 || entries && (at < arrayStart || at % 2)) invalid("cmap subheader range"); b.span(at, entries * 2);
            for (let j = 0; j < entries; j++) { const value = b.u16(at + j * 2); if (value) glyph((value + delta) & 0xffff); }
        }
        return { info, lookup: code => {
            if (code > 0xffff) return 0; const high = code >>> 8, low = code & 255, key = b.u16(6 + (high || low) * 2);
            if (high ? key === 0 : key !== 0) return 0; const p = 518 + (high ? key : 0), first = b.u16(p), count = b.u16(p + 2);
            if (low < first || low >= first + count) return 0; const value = b.u16(p + 6 + b.u16(p + 6) + (low - first) * 2);
            return value ? (value + b.i16(p + 4)) & 0xffff : 0;
        } };
    }
    if (format === 4) {
        const twice = b.u16(6), count = twice / 2; if (!count || twice % 2) invalid("cmap segment count"); b.span(14, count * 8 + 2);
        const ends = 14, starts = 16 + count * 2, deltas = starts + count * 2, ranges = deltas + count * 2, arrayStart = ranges + count * 2;
        if (b.u16(14 + count * 2) !== 0 || b.u16(ends + (count - 1) * 2) !== 0xffff) invalid("cmap sentinel");
        for (let i = 0, previous = -1; i < count; i++) {
            const first = b.u16(starts + i * 2), last = b.u16(ends + i * 2), delta = b.i16(deltas + i * 2), word = ranges + i * 2, relative = b.u16(word);
            if (first > last || first <= previous) invalid("unordered cmap segments"); previous = last;
            if (relative && (word + relative < arrayStart || relative % 2)) invalid("cmap glyph offset"); if (relative) b.span(word + relative, (last - first + 1) * 2);
            for (let code = first; code <= last; code++) { const raw = relative ? b.u16(word + relative + (code - first) * 2) : code;
                if (!relative || raw) glyph((raw + delta) & 0xffff); }
        }
        return { info, lookup: code => {
            if (code > 0xffff) return 0; const i = lowerBound(count, index => b.u16(ends + index * 2), code);
            if (i === count || code < b.u16(starts + i * 2)) return 0;
            const word = ranges + i * 2, relative = b.u16(word), raw = relative ? b.u16(word + relative + (code - b.u16(starts + i * 2)) * 2) : code;
            return relative && !raw ? 0 : (raw + b.i16(deltas + i * 2)) & 0xffff;
        } };
    }
    if (format === 6 || format === 10) {
        const first = format === 6 ? b.u16(6) : b.u32(12), count = format === 6 ? b.u16(8) : b.u32(16), start = format === 6 ? 10 : 20;
        if (first + count > (format === 6 ? 0x10000 : 0x1_0000_0000)) invalid("cmap character range"); b.span(start, count * 2);
        for (let i = 0; i < count; i++) glyph(b.u16(start + i * 2));
        return { info, lookup: code => code >= first && code < first + count ? b.u16(start + (code - first) * 2) : 0 };
    }
    if (format === 8 || format === 12 || format === 13) {
        const count = b.u32(format === 8 ? 8204 : 12), start = format === 8 ? 8208 : 16; b.span(start, count * 12);
        const bit = (word: number) => (b.u8(12 + Math.floor(word / 8)) & 1 << (7 - word % 8)) !== 0;
        for (let i = 0, previous = -1; i < count; i++) {
            const p = start + i * 12, first = b.u32(p), last = b.u32(p + 4), value = b.u32(p + 8);
            if (first > last || first <= previous) invalid("unordered cmap groups"); previous = last;
            glyph(value); glyph(format === 13 ? value : value + last - first);
            if (format === 8) {
                for (let code = first; code <= Math.min(last, 0xffff); code++) if (bit(code)) invalid("cmap is32 flags");
                for (let high = Math.max(1, first >>> 16); high <= last >>> 16; high++) if (!bit(high)) invalid("cmap is32 flags");
            }
        }
        return { info, lookup: code => {
            if (format === 8 && (code > 0xffff ? !bit(code >>> 16) : bit(code))) return 0;
            const i = lowerBound(count, index => b.u32(start + index * 12 + 4), code); if (i === count) return 0;
            const p = start + i * 12, first = b.u32(p); return code < first ? 0 : b.u32(p + 8) + (format === 13 ? 0 : code - first);
        } };
    }
    if (format === 14) {
        if (platformId !== 0 || encodingId !== 5) invalid("variation encoding"); const count = b.u32(6); b.span(10, count * 11);
        for (let i = 0, previous = -1; i < count; i++) {
            const p = 10 + i * 11, selector = b.u24(p); if (selector <= previous || selector > 0x10ffff) invalid("unordered variation selectors"); previous = selector;
            const defaults = b.u32(p + 3), nondefaults = b.u32(p + 7);
            if (defaults) {
                const ranges = b.u32(defaults); b.span(defaults + 4, ranges * 4);
                for (let j = 0, last = -1; j < ranges; j++) { const q = defaults + 4 + j * 4, first = b.u24(q), end = first + b.u8(q + 3); if (first <= last || end > 0x10ffff) invalid("variation default ranges"); last = end; }
            }
            if (nondefaults) {
                const pairs = b.u32(nondefaults); b.span(nondefaults + 4, pairs * 5);
                for (let j = 0, last = -1; j < pairs; j++) { const q = nondefaults + 4 + j * 5, code = b.u24(q); if (code <= last || code > 0x10ffff) invalid("variation mappings"); last = code; glyph(b.u16(q + 3)); }
            }
        }
        return { info, lookup: () => 0, variation: (code, selector, base) => {
            const i = lowerBound(count, index => b.u24(10 + index * 11), selector); if (i === count || b.u24(10 + i * 11) !== selector) return null;
            const p = 10 + i * 11, nondefaults = b.u32(p + 7), defaults = b.u32(p + 3);
            if (nondefaults) { const pairs = b.u32(nondefaults), j = lowerBound(pairs, index => b.u24(nondefaults + 4 + index * 5), code);
                if (j < pairs && b.u24(nondefaults + 4 + j * 5) === code) return b.u16(nondefaults + 7 + j * 5); }
            if (defaults) { const ranges = b.u32(defaults), j = lowerBound(ranges, index => b.u24(defaults + 4 + index * 4) + b.u8(defaults + 7 + index * 4), code);
                if (j < ranges && b.u24(defaults + 4 + j * 4) <= code) return base(); }
            return null;
        } };
    }
    throw new Error(`Unsupported cmap format ${format}.`);
}

/** Owned SFNT data and nominal default-instance metrics. This is not an OpenType shaper. */
export class SfntFont {
    readonly metadata: SfntMetadata;
    readonly #maps: readonly Mapping[];
    readonly #metrics: Bytes;
    readonly #metricCount: number;
    readonly #tables: ReadonlyMap<string, Bytes>;
    private constructor(input: Uint8Array, faceIndex: number) {
        const bytes = new Bytes(new Uint8Array(input)), tables = new Map<string, Bytes>(); let offset = 0, faceCount = 1, container: "sfnt" | "collection" = "sfnt";
        if (bytes.tag(0) === "ttcf") {
            container = "collection"; const version = bytes.u32(4); if (version !== 0x10000 && version !== 0x20000) invalid("collection version");
            faceCount = bytes.u32(8); bytes.span(12, faceCount * 4); integer(faceIndex, faceCount - 1); offset = bytes.u32(12 + faceIndex * 4);
            if (version === 0x20000) bytes.span(12 + faceCount * 4, 12);
        } else integer(faceIndex, 0);
        const signature = bytes.u32(offset); if (signature !== 0x10000 && signature !== 0x4f54544f && signature !== 0x74727565) throw new Error("Expected uncompressed SFNT font data.");
        const count = bytes.u16(offset + 4); bytes.span(offset + 12, count * 16);
        for (let i = 0; i < count; i++) {
            const p = offset + 12 + i * 16, tag = bytes.tag(p), start = bytes.u32(p + 8), length = bytes.u32(p + 12);
            if (!/^[\x20-\x7e]{4}$/.test(tag) || tables.has(tag) || start % 4) invalid("table directory"); tables.set(tag, bytes.sub(start, length));
        }
        const required = (tag: string) => { const data = tables.get(tag); if (!data) throw new Error(`Missing font table ${tag}.`); return data; };
        const head = required("head"), hhea = required("hhea"), maxp = required("maxp"), cmap = required("cmap"), metrics = required("hmtx");
        head.span(0, 54); hhea.span(0, 36); if (head.u32(0) !== 0x10000 || head.u32(12) !== 0x5f0f3cf5 || hhea.u32(0) !== 0x10000) invalid("font header");
        const unitsPerEm = head.u16(18), glyphCount = maxp.u16(4), metricCount = hhea.u16(34), maxpVersion = maxp.u32(0);
        if (maxpVersion !== 0x5000 && maxpVersion !== 0x10000) invalid("maxp version"); maxp.span(0, maxpVersion === 0x10000 ? 32 : 6);
        if (unitsPerEm < 16 || unitsPerEm > 16384 || !glyphCount || !metricCount || metricCount > glyphCount) invalid("font metric counts");
        metrics.span(0, metricCount * 4 + (glyphCount - metricCount) * 2);
        if (cmap.u16(0) !== 0) invalid("cmap version"); const encodings = cmap.u16(2); cmap.span(4, encodings * 8);
        const maps: Mapping[] = [], parsed = new Map<number, Mapping>();
        for (let i = 0; i < encodings; i++) {
            const p = 4 + i * 8, at = cmap.u32(p + 4), platformId = cmap.u16(p), encodingId = cmap.u16(p + 2), cached = parsed.get(at);
            if (cached) {
                if (cached.info.format === 14 && (platformId !== 0 || encodingId !== 5)) invalid("variation encoding");
                maps.push({ ...cached, info: Object.freeze({ ...cached.info, platformId, encodingId }) });
            } else { const value = mapping(cmap, at, platformId, encodingId, glyphCount); parsed.set(at, value); maps.push(value); }
        }
        const rank = (m: Mapping) => m.info.platformId === 0 && m.info.encodingId !== 5 || m.info.platformId === 3 && (m.info.encodingId === 1 || m.info.encodingId === 10)
            ? ({ 0: 1, 2: 2, 4: 10, 6: 8, 8: 20, 10: 30, 12: 40, 13: 35 } as Record<number, number>)[m.info.format] ?? -1 : -1;
        let selected: number | null = null, variation: number | null = null, best = -1;
        maps.forEach((m, i) => { const score = rank(m); if (score > best) { best = score; selected = i; } if (m.info.format === 14) { if (variation !== null) invalid("duplicate variation encoding"); variation = i; } });
        this.#maps = maps; this.#metrics = metrics; this.#metricCount = metricCount; this.#tables = tables;
        this.metadata = Object.freeze({ container, faceIndex, faceCount, byteLength: bytes.length, unitsPerEm, glyphCount,
            ascent: hhea.i16(4), descent: hhea.i16(6), lineGap: hhea.i16(8), flags: head.u16(16),
            outline: tables.has("glyf") ? "truetype" : tables.has("CFF ") ? "cff" : tables.has("CFF2") ? "cff2" : "unknown",
            variable: tables.has("fvar"), tables: Object.freeze([...tables.keys()].sort()), encodings: Object.freeze(maps.map(m => m.info)), unicodeEncoding: selected, variationEncoding: variation });
        Object.freeze(this);
    }
    static from(bytes: Uint8Array, options: Readonly<{ faceIndex?: number }> = {}): SfntFont { return new SfntFont(bytes, options.faceIndex ?? 0); }
    createGlyphRunBuilder(): GlyphRunBuilder { return createGlyphRunBuilder(this); }
    createGlyphMappingCursor(text: NormalizedText, options: GlyphMappingOptions = {}): GlyphMappingCursor { return createGlyphMappingCursor(this, text, options); }
    substitutionPlan(options: SubstitutionOptions): SubstitutionPlan { return createSubstitutionPlan(this, this.#tables, options); }
    positioningPlan(options: PositioningOptions): PositioningPlan { return createPositioningPlan(this, this.#tables, options); }
    glyphIndex(codePoint: number): number {
        scalar(codePoint); const selected = this.metadata.unicodeEncoding; if (selected === null) throw new Error("Font has no Unicode cmap."); return this.#maps[selected]!.lookup(codePoint);
    }
    encodedGlyphIndex(encoding: number, code: number): number {
        integer(encoding, this.#maps.length - 1); integer(code, 0xffffffff); if (this.#maps[encoding]!.info.format === 14) throw new Error("Use variationGlyphIndex for variation sequences."); return this.#maps[encoding]!.lookup(code);
    }
    variationGlyphIndex(codePoint: number, selector: number): number | null {
        scalar(codePoint); scalar(selector); const selected = this.metadata.variationEncoding;
        return selected === null ? null : this.#maps[selected]!.variation!(codePoint, selector, () => this.glyphIndex(codePoint));
    }
    nominalGlyphMetrics(glyphId: number): NominalGlyphMetrics {
        integer(glyphId, this.metadata.glyphCount - 1); const at = Math.min(glyphId, this.#metricCount - 1) * 4;
        return Object.freeze({ advanceWidth: this.#metrics.u16(at), leftSideBearing: this.#metrics.i16(glyphId < this.#metricCount ? at + 2 : this.#metricCount * 4 + (glyphId - this.#metricCount) * 2) });
    }
}
