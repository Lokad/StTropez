import type { SfntFont } from "./font-data.ts";
import type { GlyphSourceSpan, SubstitutionGlyph } from "./font-substitution.ts";
import { glyphRunFromOwnedBlocks } from "./glyph-run.ts";
import type { GlyphRun } from "./glyph-run.ts";
import { ownedNormalizedText } from "./unicode-normalization.ts";
import type { NormalizedText } from "./unicode-normalization.ts";
import { unicodeCategory } from "./unicode-shaping-data.ts";
import { kernelCursor } from "./kernel-cursor.ts";
import { mappedGlyphProperties } from "./glyph-properties.ts";

export type GlyphMappingOptions = Readonly<{ from?: number; to?: number; variationSelectors?: "standard" | "preserve"; maxOperations?: number; maxGlyphs?: number }>;
export type GlyphPointRange = Readonly<{ from: number; to: number }>;
export type GlyphMappingResult = Readonly<{ font: SfntFont; text: NormalizedText; from: number; to: number; run: GlyphRun<SubstitutionGlyph>;
    missingGlyphs: number; unpairedSurrogates: number; ignoredSelectors: number; unsupportedVariations: number;
    pointRangeAt: (glyphIndex: number) => GlyphPointRange }>;
export type GlyphMappingProgress = Readonly<{ status: "running" | "ready" | "failed" | "disposed"; phase: "map" | "publish";
    scannedPoints: number; mappedGlyphs: number; missingGlyphs: number; unpairedSurrogates: number; ignoredSelectors: number;
    unsupportedVariations: number; workUnits: number; result: GlyphMappingResult | null; failure: string | null }>;
export type GlyphMappingCursor = Readonly<{ next: (workBudget?: number) => GlyphMappingProgress; snapshot: () => GlyphMappingProgress; dispose: () => void }>;
const owned = new WeakSet<GlyphMappingResult>();
export const ownedGlyphMappingResult = (value: unknown): value is GlyphMappingResult => typeof value === "object" && value !== null && owned.has(value as GlyphMappingResult);
export class GlyphMappingLimitError extends Error {
    readonly limit: "operations" | "glyphs";
    constructor(limit: "operations" | "glyphs") { super(`Nominal glyph mapping exceeded its ${limit} limit.`); this.name = "GlyphMappingLimitError"; this.limit = limit; }
}
type Counters = { phase: "map" | "publish"; scanned: number; mapped: number; missing: number; unpaired: number; ignored: number; unsupported: number; work: number; yielded: number };
const positive = (n: number) => { if (!Number.isSafeInteger(n) || n <= 0) throw new RangeError("Invalid glyph mapping limit."); return n; };
// Mongolian selectors require script-specific policy and remain in the supplied sequence.
export const standardVariationSelector = (cp: number) => cp >= 0xfe00 && cp <= 0xfe0f || cp >= 0xe0100 && cp <= 0xe01ef;

function* map(font: SfntFont, text: NormalizedText, from: number, end: number, selectors: "standard" | "preserve", maxOperations: number, maxGlyphs: number, c: Counters): Generator<void, GlyphMappingResult | null> {
    const tick = () => { if (++c.work > maxOperations) throw new GlyphMappingLimitError("operations"); }, pause = () => { if (c.work - c.yielded < 256) return false; c.yielded = c.work; return true; };
    const blocks: (readonly SubstitutionGlyph[])[] = [], ranges: (readonly GlyphPointRange[])[] = []; let pending: SubstitutionGlyph[] = [], pendingRanges: GlyphPointRange[] = [];
    for (let i = from; i < end;) {
        c.phase = "map"; tick(); if (pause()) yield; const point = text.at(i), cp = point.codePoint;
        if (selectors === "standard" && standardVariationSelector(cp)) { c.ignored++; c.scanned = ++i - from; continue; }
        const unpaired = cp >= 0xd800 && cp <= 0xdfff, lookup = unpaired ? 0xfffd : cp; if (unpaired) c.unpaired++;
        let glyph = font.glyphIndex(lookup), to = i + 1, origins = point.sources;
        if (selectors === "standard" && to < end && standardVariationSelector(text.at(to).codePoint)) {
            const selector = text.at(to), variant = font.variationGlyphIndex(lookup, selector.codePoint); if (variant === null) c.unsupported++; else glyph = variant;
            const copied: GlyphSourceSpan[] = [], seen = new Set<GlyphSourceSpan>();
            for (const values of [point.sources, selector.sources]) for (const source of values) { tick(); if (pause()) yield; if (!seen.has(source)) { seen.add(source); copied.push(source); } }
            origins = Object.freeze(copied); to++;
        }
        if (c.mapped >= maxGlyphs) throw new GlyphMappingLimitError("glyphs"); if (!glyph) c.missing++;
        const glyphClass = unicodeCategory(cp).startsWith("M") ? 3 : 1;
        c.phase = "publish"; tick(); if (pause()) yield;
        pending.push(Object.freeze({ glyphId: glyph, glyphClass, properties: mappedGlyphProperties(cp), components: Object.freeze([origins]), sources: origins, attachment: null })); pendingRanges.push(Object.freeze({ from: i, to })); c.mapped++; c.scanned = to - from; i = to;
        if (pending.length === 256) { blocks.push(Object.freeze(pending)); ranges.push(Object.freeze(pendingRanges)); pending = []; pendingRanges = []; }
    }
    if (pending.length) { blocks.push(Object.freeze(pending)); ranges.push(Object.freeze(pendingRanges)); }
    const run = glyphRunFromOwnedBlocks(font, Object.freeze(blocks), c.mapped), positions = Object.freeze(ranges);
    const result = Object.freeze({ font, text, from, to: end, run, missingGlyphs: c.missing, unpairedSurrogates: c.unpaired, ignoredSelectors: c.ignored, unsupportedVariations: c.unsupported,
        pointRangeAt: (index: number) => { if (!Number.isSafeInteger(index) || index < 0 || index >= run.length) throw new RangeError("Invalid mapped glyph index."); return positions[Math.floor(index / 256)]![index % 256]!; } });
    owned.add(result); return result;
}
function drive(iterator: Generator<void, GlyphMappingResult | null> | null, c: Counters): GlyphMappingCursor {
    const cursor = kernelCursor(iterator, () => c.work, (status, result, failure): GlyphMappingProgress => Object.freeze({ status, phase: c.phase, scannedPoints: c.scanned,
        mappedGlyphs: c.mapped, missingGlyphs: c.missing, unpairedSurrogates: c.unpaired, ignoredSelectors: c.ignored, unsupportedVariations: c.unsupported,
        workUnits: c.work, result, failure }), "Glyph mapping"); iterator = null; return cursor;
}
export function createGlyphMappingCursor(font: SfntFont, text: NormalizedText, options: GlyphMappingOptions = {}): GlyphMappingCursor {
    if (!ownedNormalizedText(text)) throw new TypeError("Glyph mapping requires owned immutable normalized text."); const selectors = options.variationSelectors ?? "standard";
    if (selectors !== "standard" && selectors !== "preserve") throw new RangeError("Invalid variation selector policy.");
    const from = options.from ?? 0, to = options.to ?? text.length;
    if (![from, to].every(Number.isSafeInteger) || from < 0 || from > to || to > text.length) throw new RangeError("Invalid glyph mapping point range.");
    if (selectors === "standard" && from < to && (from > 0 && standardVariationSelector(text.at(from).codePoint) && !standardVariationSelector(text.at(from - 1).codePoint)
        || to < text.length && standardVariationSelector(text.at(to).codePoint) && !standardVariationSelector(text.at(to - 1).codePoint))) throw new RangeError("Glyph mapping range bisects a variation sequence.");
    const maxOperations = positive(options.maxOperations ?? Math.max(1_000_000, text.length * 64)), maxGlyphs = positive(options.maxGlyphs ?? Math.max(1_000_000, text.length));
    const c: Counters = { phase: "map", scanned: 0, mapped: 0, missing: 0, unpaired: 0, ignored: 0, unsupported: 0, work: 0, yielded: 0 }; return drive(map(font, text, from, to, selectors, maxOperations, maxGlyphs, c), c);
}
