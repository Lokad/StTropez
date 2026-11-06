import { SfntFont } from "./font-data.ts";
import { ownedNormalizedText, normalizationCursorFromPoints, fontNormalizedTextFromOwnedBlocks, NormalizationLimitError } from "./unicode-normalization.ts";
import type { NormalizedText, NormalizedPoint } from "./unicode-normalization.ts";
import { createNormalizedGraphemeCursor, ownedGraphemeIndex, GraphemeLimitError } from "./graphemes.ts";
import type { GraphemeIndex } from "./graphemes.ts";
import { canonicalCombiningClass, normalizationDecomposition, unicodeDefaultIgnorable, unicodeVariationSelector } from "./unicode-shaping-data.ts";
import { canonicalVariantAt, canonicalVariantRange } from "./canonical-variants.ts";
import type { CanonicalVariant } from "./canonical-variants.ts";
import { standardVariationSelector } from "./glyph-mapping.ts";
import type { GlyphSourceSpan } from "./font-substitution.ts";
import { kernelCursor } from "./kernel-cursor.ts";

const cascades = new WeakSet<FontCascade>();
/** Host-ordered immutable font instances; no system discovery, loading or style matching. */
export class FontCascade {
    readonly length: number; readonly #fonts: readonly SfntFont[];
    private constructor(fonts: readonly SfntFont[]) { this.#fonts = Object.freeze(Array.from(fonts)); this.length = fonts.length; cascades.add(this); Object.freeze(this); }
    static from(fonts: readonly SfntFont[]): FontCascade { if (!fonts.length || fonts.some(f => !(f instanceof SfntFont) || f.metadata.unicodeEncoding === null)) throw new TypeError("A font cascade requires Unicode font instances."); return new FontCascade(fonts); }
    at(index: number): SfntFont { if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) throw new RangeError("Invalid cascade font."); return this.#fonts[index]!; }
}
export type FontCoverage = "covered" | "variation-fallback" | "missing";
export type FontCluster = Readonly<{ from: number; to: number; sourceFrom: number; sourceTo: number; textFrom: number; textTo: number; fontIndex: number; coverage: FontCoverage; missingGlyphs: number; unsupportedVariations: number }>;
export type FontTextRun = Readonly<{ from: number; to: number; fontIndex: number; firstCluster: number; toCluster: number }>;
export type FontNormalizationOptions = Readonly<{ from?: number; to?: number; graphemes?: GraphemeIndex; preference?: "composed" | "decomposed"; maxOperations?: number; maxPoints?: number; maxClusters?: number; maxSearchStates?: number }>;
export type FontNormalizationPhase = "grapheme" | "prepare" | "normalize" | "coverage" | "search" | "publish";
export type FontNormalizationProgress = Readonly<{ status: "running" | "ready" | "failed" | "disposed"; phase: FontNormalizationPhase; workUnits: number; scannedPoints: number; completedClusters: number; outputPoints: number; fontsTried: number; searchStates: number;
    fallbackClusters: number; missingClusters: number; unsupportedVariations: number; orphanSelectors: number; scriptSelectors: number; unpairedSurrogates: number; result: FontNormalizationIndex | null; failure: string | null }>;
export type FontNormalizationCursor = Readonly<{ next: (workBudget?: number) => FontNormalizationProgress; snapshot: () => FontNormalizationProgress; dispose: () => void }>;
export class FontNormalizationLimitError extends Error { readonly limit: "operations" | "points" | "clusters" | "search-states";
    constructor(limit: FontNormalizationLimitError["limit"]) { super(`Font normalization exceeded its ${limit} limit.`); this.name = "FontNormalizationLimitError"; this.limit = limit; } }
const owned = new WeakSet<FontNormalizationIndex>();
export const ownedFontNormalizationIndex = (value: unknown): value is FontNormalizationIndex => typeof value === "object" && value !== null && owned.has(value as FontNormalizationIndex);
let publish: (input: NormalizedText, text: NormalizedText, cascade: FontCascade, graphemes: GraphemeIndex, clusters: readonly (readonly FontCluster[])[], runs: readonly (readonly FontTextRun[])[], count: number, runCount: number) => FontNormalizationIndex;
export class FontNormalizationIndex {
    readonly input: NormalizedText; readonly text: NormalizedText; readonly cascade: FontCascade; readonly graphemes: GraphemeIndex; readonly clusterCount: number; readonly runCount: number;
    readonly #clusters: readonly (readonly FontCluster[])[]; readonly #runs: readonly (readonly FontTextRun[])[];
    private constructor(input: NormalizedText, text: NormalizedText, cascade: FontCascade, graphemes: GraphemeIndex, clusters: readonly (readonly FontCluster[])[], runs: readonly (readonly FontTextRun[])[], count: number, runCount: number) {
        this.input = input; this.text = text; this.cascade = cascade; this.graphemes = graphemes; this.#clusters = clusters; this.#runs = runs; this.clusterCount = count; this.runCount = runCount; owned.add(this); Object.freeze(this);
    }
    clusterAt(index: number): FontCluster { if (!Number.isSafeInteger(index) || index < 0 || index >= this.clusterCount) throw new RangeError("Invalid font cluster."); return this.#clusters[Math.floor(index / 256)]![index % 256]!; }
    runAt(index: number): FontTextRun { if (!Number.isSafeInteger(index) || index < 0 || index >= this.runCount) throw new RangeError("Invalid font run."); return this.#runs[Math.floor(index / 256)]![index % 256]!; }
    static { publish = (input, text, cascade, graphemes, clusters, runs, count, runCount) => new FontNormalizationIndex(input, text, cascade, graphemes, clusters, runs, count, runCount); }
}
type Counters = { phase: FontNormalizationPhase; work: number; yielded: number; scanned: number; clusters: number; output: number; tried: number; states: number; fallback: number; missing: number; unsupported: number; orphans: number; script: number; unpaired: number };
type Limits = { operations: number; points: number; clusters: number; states: number };
type Plain = { kind: "plain"; raw: readonly NormalizedPoint[]; nfd: readonly NormalizedPoint[]; nfc: readonly NormalizedPoint[]; sourceFrom: number; sourceTo: number };
type Pair = { kind: "pair"; points: readonly [NormalizedPoint, NormalizedPoint]; standard: boolean };
type Part = Plain | Pair;
type MutableRun = { -readonly [K in keyof FontTextRun]: FontTextRun[K] };
type Segment = { starter: number | null; classes: number[]; queues: number[][]; slots: Map<number, number>; marks: number };
type State = { segment: number; begun: boolean; positions: number[]; remaining: number };
const lookup = (cp: number) => cp >= 0xd800 && cp <= 0xdfff ? 0xfffd : cp;
const required = (cp: number) => !unicodeDefaultIgnorable(cp) && ![9, 10, 13, 0x85, 0x2028, 0x2029].includes(cp);
const scalarDecomposes = (cp: number) => cp >= 0xac00 && cp <= 0xd7a3 || normalizationDecomposition(cp, false) !== null;

function* normalizeFonts(input: NormalizedText, cascade: FontCascade, from: number, to: number, supplied: GraphemeIndex | null, preference: "composed" | "decomposed", limits: Limits, c: Counters): Generator<void, FontNormalizationIndex | null> {
    const tick = (n = 1) => { c.work += n; if (c.work > limits.operations) throw new FontNormalizationLimitError("operations"); }, pause = () => { if (c.work - c.yielded < 256) return false; c.yielded = c.work; return true; };
    function* child<T>(cursor: { next: (budget: number) => Readonly<{ status: string; workUnits: number; result: T | null }>; snapshot: () => Readonly<{ workUnits: number }>; dispose: () => void }): Generator<void, T> {
        let previous = 0; try { while (true) { if (c.work !== c.yielded) { c.yielded = c.work; yield; } const step = cursor.next(256), delta = step.workUnits - previous; previous = step.workUnits; tick(delta); if (pause()) yield; if (step.status === "ready") return step.result!; } }
        catch (error) { c.work += cursor.snapshot().workUnits - previous; if (error instanceof GraphemeLimitError || error instanceof NormalizationLimitError) throw new FontNormalizationLimitError(error.limit === "operations" ? "operations" : error.limit); throw error; }
        finally { cursor.dispose(); }
    }
    c.phase = "grapheme"; const graphemes = supplied ?? (yield* child(createNormalizedGraphemeCursor(input, { from, to, maxOperations: limits.operations, maxClusters: limits.clusters })));
    const sourceFrom = from < input.length ? input.at(from).sources[0]!.from : input.to, sourceTo = from < to ? input.at(to - 1).sources[0]!.to : sourceFrom;
    const pointBlocks: (readonly NormalizedPoint[])[] = [], clusterBlocks: (readonly FontCluster[])[] = [], runBlocks: (readonly FontTextRun[])[] = [];
    let points: NormalizedPoint[] = [], clusters: FontCluster[] = [], runs: FontTextRun[] = [], run: MutableRun | null = null, runCount = 0, units = 0;
    const candidateCaches = new Map<number, Map<number, readonly CanonicalVariant[]>>();
    function* normalizePart(raw: readonly NormalizedPoint[], form: "NFD" | "NFC", accept: ((first: number, second: number, cp: number) => boolean) | null = null,
        sourceFrom = raw[0]!.sources[0]!.from, sourceTo = raw.at(-1)!.sources.at(-1)!.to): Generator<void, readonly NormalizedPoint[]> {
        c.phase = "normalize"; const result = yield* child(normalizationCursorFromPoints(input.source, sourceFrom, sourceTo, raw, form, limits.operations, limits.points, accept)), output: NormalizedPoint[] = [];
        for (let i = 0; i < result.length; i++) { tick(); if (pause()) yield; output.push(result.at(i)); } return output;
    }
    function* coverage(font: SfntFont, values: readonly NormalizedPoint[]): Generator<void, number> {
        c.phase = "coverage"; let missing = 0; for (const p of values) { tick(); if (pause()) yield; if (required(p.codePoint) && !font.glyphIndex(lookup(p.codePoint))) missing++; } return missing;
    }
    function* candidates(fontIndex: number, first: number): Generator<void, readonly CanonicalVariant[]> {
        let cache = candidateCaches.get(fontIndex); if (!cache) { cache = new Map(); candidateCaches.set(fontIndex, cache); } const prior = cache.get(first); if (prior) return prior;
        const font = cascade.at(fontIndex), result: CanonicalVariant[] = [], [start, end] = canonicalVariantRange(first);
        for (let i = start; i < end; i++) { tick(); if (pause()) yield; const v = canonicalVariantAt(i); if (font.glyphIndex(v.codePoint)) result.push(v); }
        if (first >= 0x1100 && first < 0x1113) for (const trailing of [true, false]) for (let vowel = 0; vowel < 21; vowel++) for (let tail = trailing ? 1 : 0; tail < (trailing ? 28 : 1); tail++) {
            tick(); if (pause()) yield; const cp = 0xac00 + ((first - 0x1100) * 21 + vowel) * 28 + tail; if (font.glyphIndex(cp)) result.push({ codePoint: cp, decomposition: tail ? [first, 0x1161 + vowel, 0x11a7 + tail] : [first, 0x1161 + vowel] });
        }
        tick(); if (pause()) yield; if (!required(first) || font.glyphIndex(lookup(first))) result.push({ codePoint: first, decomposition: [first] });
        cache.set(first, result); return result;
    }
    // Search the canonical-equivalence DAG. Equal-CCC order is fixed; different classes may interleave.
    // Every edge consumes a nonempty canonical decomposition, so search cannot cycle.
    function* search(fontIndex: number, nfd: readonly NormalizedPoint[]): Generator<void, readonly NormalizedPoint[] | null> {
        c.phase = "search"; const segments: Segment[] = []; let segment: Segment | null = null;
        for (let i = 0; i < nfd.length; i++) { tick(); if (pause()) yield; const cls = canonicalCombiningClass(nfd[i]!.codePoint);
            if (!cls || !segment) { segment = { starter: cls ? null : i, classes: [], queues: [], slots: new Map(), marks: 0 }; segments.push(segment); }
            if (cls) { let slot = segment.slots.get(cls); if (slot === undefined) { slot = segment.classes.length; segment.slots.set(cls, slot); segment.classes.push(cls); segment.queues.push([]); } segment.queues[slot]!.push(i); segment.marks++; }
        }
        const initial = (i: number): State => ({ segment: i, begun: segments[i]?.starter === null, positions: segments[i]?.classes.map(() => 0) ?? [], remaining: segments[i]?.marks ?? 0 });
        const advance = (state: State): State => state.begun && state.remaining === 0 ? initial(state.segment + 1) : state;
        const key = (state: State) => `${state.segment}:${Number(state.begun)}:${state.positions.join(",")}`;
        const match = (state: State, variant: CanonicalVariant): { state: State; indices: number[] } | null => {
            let current = state; const indices: number[] = [];
            for (const cp of variant.decomposition) { current = advance(current); const seg = segments[current.segment]; if (!seg) return null; const cls = canonicalCombiningClass(cp);
                if (!cls) { if (current.begun || seg.starter === null || nfd[seg.starter]!.codePoint !== cp) return null; indices.push(seg.starter); current = { ...current, begun: true }; }
                else { if (!current.begun) return null; const slot = seg.slots.get(cls); if (slot === undefined) return null; const at = seg.queues[slot]![current.positions[slot]!] ; if (at === undefined || nfd[at]!.codePoint !== cp) return null;
                    const positions = current.positions.slice(); positions[slot] = positions[slot]! + 1; indices.push(at); current = { ...current, positions, remaining: current.remaining - 1 }; }
            } return { state: advance(current), indices };
        };
        type Frame = { state: State; key: string; choices: readonly CanonicalVariant[]; next: number; depth: number };
        function* frame(state: State, depth: number): Generator<void, Frame> {
            tick(); if (pause()) yield; if (++c.states > limits.states) throw new FontNormalizationLimitError("search-states"); const seg = segments[state.segment]!, heads: number[] = [], choices: CanonicalVariant[] = [];
            if (!state.begun) heads.push(nfd[seg.starter!]!.codePoint); else for (let i = 0; i < seg.queues.length; i++) { tick(); if (pause()) yield; const at = seg.queues[i]![state.positions[i]!]; if (at !== undefined) heads.push(nfd[at]!.codePoint); }
            for (const head of heads) for (const candidate of yield* candidates(fontIndex, head)) { tick(); if (pause()) yield; choices.push(candidate); }
            return { state, key: key(state), choices, next: 0, depth };
        }
        const stack: Frame[] = [yield* frame(initial(0), 0)], failed = new Set<string>(), path: { cp: number; indices: number[] }[] = [];
        while (stack.length) { tick(); if (pause()) yield; const active = stack.at(-1)!;
            if (active.next === active.choices.length) { failed.add(active.key); stack.pop(); path.length = active.depth; continue; }
            const variant = active.choices[active.next++]!, matched = match(active.state, variant); if (!matched || failed.has(key(matched.state))) continue;
            path.length = active.depth; path.push({ cp: variant.codePoint, indices: matched.indices });
            if (matched.state.segment === segments.length) { const output: NormalizedPoint[] = []; for (const value of path) { const origins: GlyphSourceSpan[] = [], seen = new Set<GlyphSourceSpan>();
                    for (const index of value.indices) for (const origin of nfd[index]!.sources) { tick(); if (pause()) yield; if (!seen.has(origin)) { seen.add(origin); origins.push(origin); } }
                    output.push(Object.freeze({ codePoint: value.cp, sources: Object.freeze(origins) })); } return output; }
            stack.push(yield* frame(matched.state, path.length));
        } return null;
    }
    function* selectPlain(part: Plain, fontIndex: number): Generator<void, readonly NormalizedPoint[] | null> {
        const font = cascade.at(fontIndex), preferred = preference === "composed" ? part.nfc : part.nfd;
        if ((yield* coverage(font, preferred)) === 0) return preferred;
        const selective = yield* normalizePart(part.nfd, "NFC", (_first, second, cp) => !!font.glyphIndex(cp) && (preference === "composed" || !font.glyphIndex(lookup(second))), part.sourceFrom, part.sourceTo);
        if ((yield* coverage(font, selective)) === 0) return selective;
        return yield* search(fontIndex, part.nfd);
    }
    function endRun(): void { if (!run) return; runs.push(Object.freeze(run)); runCount++; run = null; if (runs.length === 256) { runBlocks.push(Object.freeze(runs)); runs = []; } }
    for (let ordinal = 0; ordinal < graphemes.clusterCount; ordinal++) {
        c.phase = "prepare"; if (ordinal >= limits.clusters) throw new FontNormalizationLimitError("clusters"); const extent = graphemes.clusterAt(ordinal), parts: Part[] = []; let raw: NormalizedPoint[] = [];
        function* flush(): Generator<void, void> {
            if (!raw.length) return; const captured = raw; raw = []; let nfd: readonly NormalizedPoint[], nfc: readonly NormalizedPoint[];
            if (captured.length === 1 && !scalarDecomposes(captured[0]!.codePoint)) nfd = nfc = captured;
            else { nfd = yield* normalizePart(captured, "NFD"); nfc = yield* normalizePart(nfd, "NFC", null, captured[0]!.sources[0]!.from, captured.at(-1)!.sources[0]!.to); }
            parts.push({ kind: "plain", raw: captured, nfd, nfc, sourceFrom: captured[0]!.sources[0]!.from, sourceTo: captured.at(-1)!.sources[0]!.to });
        }
        for (let i = extent.from; i < extent.to;) { c.phase = "prepare"; tick(); if (pause()) yield; const point = input.at(i), cp = point.codePoint; if (cp >= 0xd800 && cp <= 0xdfff) c.unpaired++;
            if (!unicodeVariationSelector(cp) && i + 1 < extent.to && unicodeVariationSelector(input.at(i + 1).codePoint)) {
                yield* flush(); const selector = input.at(i + 1), standard = standardVariationSelector(selector.codePoint); parts.push({ kind: "pair", points: [point, selector], standard }); if (!standard) c.script++; i += 2;
            } else { if (unicodeVariationSelector(cp)) c.orphans++; raw.push(point); i++; } c.scanned = i - from;
        } yield* flush();
        const attempts = new Map<number, readonly (readonly NormalizedPoint[])[] | null>(); let selected: readonly (readonly NormalizedPoint[])[] | null = null, fontIndex = 0, unsupported = 0;
        for (const strict of [true, false]) { for (let f = 0; f < cascade.length; f++) {
                c.phase = "coverage"; tick(); if (pause()) yield; c.tried++; const font = cascade.at(f); let badPair = false, misses = 0;
                for (const part of parts) if (part.kind === "pair") { tick(); if (pause()) yield; const cp = lookup(part.points[0].codePoint), variant = part.standard ? font.variationGlyphIndex(cp, part.points[1].codePoint) : null;
                    if (part.standard && (variant === null || variant === 0)) { misses++; if (strict) badPair = true; }
                    if ((!part.standard || variant === null || variant === 0) && required(part.points[0].codePoint) && !font.glyphIndex(cp)) badPair = true;
                }
                if (badPair) continue; let choices = attempts.get(f);
                if (choices === undefined) { const values: (readonly NormalizedPoint[])[] = []; let failed = false;
                    for (const part of parts) { if (part.kind === "pair") values.push(part.points); else { const value = yield* selectPlain(part, f); if (!value) { failed = true; break; } values.push(value); } } choices = failed ? null : values; attempts.set(f, choices);
                }
                if (choices) { selected = choices; fontIndex = f; unsupported = misses; break; }
            } if (selected) break;
        }
        let missing = 0;
        if (!selected) { selected = parts.map(p => p.kind === "plain" ? p.nfc : p.points); const font = cascade.at(0);
            for (const part of parts) { if (part.kind === "plain") missing += yield* coverage(font, part.nfc); else { tick(); if (pause()) yield; const cp = lookup(part.points[0].codePoint), v = part.standard ? font.variationGlyphIndex(cp, part.points[1].codePoint) : null;
                    if (part.standard && (v === null || v === 0)) unsupported++; if ((!part.standard || v === null || v === 0) && required(part.points[0].codePoint) && !font.glyphIndex(cp)) missing++; } }
        }
        c.phase = "publish"; const first = c.output;
        for (const values of selected) for (const point of values) { tick(); if (pause()) yield; if (c.output >= limits.points) throw new FontNormalizationLimitError("points"); points.push(point); c.output++; units += point.codePoint > 0xffff ? 2 : 1; if (points.length === 256) { pointBlocks.push(Object.freeze(points)); points = []; } }
        tick(); if (pause()) yield; clusters.push(Object.freeze({ from: extent.from, to: extent.to, sourceFrom: input.at(extent.from).sources[0]!.from, sourceTo: input.at(extent.to - 1).sources[0]!.to, textFrom: first, textTo: c.output, fontIndex,
            coverage: missing ? "missing" : unsupported ? "variation-fallback" : "covered", missingGlyphs: missing, unsupportedVariations: unsupported }));
        c.clusters++; c.unsupported += unsupported; if (fontIndex > 0) c.fallback++; if (missing) c.missing++; if (clusters.length === 256) { clusterBlocks.push(Object.freeze(clusters)); clusters = []; }
        const activeRun = run as MutableRun | null;
        if (activeRun?.fontIndex !== fontIndex) { endRun(); run = { from: first, to: c.output, fontIndex, firstCluster: ordinal, toCluster: ordinal + 1 }; } else { activeRun.to = c.output; activeRun.toCluster = ordinal + 1; }
    }
    endRun(); if (points.length) pointBlocks.push(Object.freeze(points)); if (clusters.length) clusterBlocks.push(Object.freeze(clusters)); if (runs.length) runBlocks.push(Object.freeze(runs));
    return publish(input, fontNormalizedTextFromOwnedBlocks(input.source, sourceFrom, sourceTo, Object.freeze(pointBlocks), c.output, units), cascade, graphemes, Object.freeze(clusterBlocks), Object.freeze(runBlocks), c.clusters, runCount);
}
function drive(iterator: Generator<void, FontNormalizationIndex | null> | null, c: Counters): FontNormalizationCursor {
    const cursor = kernelCursor(iterator, () => c.work, (status, result, failure): FontNormalizationProgress => Object.freeze({ status, phase: c.phase, workUnits: c.work, scannedPoints: c.scanned,
        completedClusters: c.clusters, outputPoints: c.output, fontsTried: c.tried, searchStates: c.states, fallbackClusters: c.fallback, missingClusters: c.missing, unsupportedVariations: c.unsupported, orphanSelectors: c.orphans, scriptSelectors: c.script, unpairedSurrogates: c.unpaired, result, failure }), "Font normalization"); iterator = null; return cursor;
}
export function createFontNormalizationCursor(input: NormalizedText, cascade: FontCascade, options: FontNormalizationOptions = {}): FontNormalizationCursor {
    if (!ownedNormalizedText(input) || input.form !== "none" || !cascades.has(cascade)) throw new TypeError("Font normalization requires owned original points and a captured font cascade.");
    const from = options.from ?? 0, to = options.to ?? input.length, preference = options.preference ?? "composed", supplied = options.graphemes ?? null;
    if (![from, to].every(Number.isSafeInteger) || from < 0 || from > to || to > input.length || !["composed", "decomposed"].includes(preference)) throw new RangeError("Invalid font normalization options.");
    if (supplied && (!ownedGraphemeIndex(supplied) || supplied.source.kind !== "normalized" || supplied.source.text !== input || supplied.from !== from || supplied.to !== to)) throw new TypeError("Font graphemes must match the exact original text and point range.");
    const limits: Limits = { operations: options.maxOperations ?? Math.max(1_000_000, (to - from) * 1024), points: options.maxPoints ?? Math.max(1_000_000, (to - from) * 64), clusters: options.maxClusters ?? Math.max(1_000_000, to - from), states: options.maxSearchStates ?? Math.max(65_536, (to - from) * 8) };
    if (!Object.values(limits).every(v => Number.isSafeInteger(v) && v > 0)) throw new RangeError("Invalid font normalization limits.");
    const c: Counters = { phase: "grapheme", work: 0, yielded: 0, scanned: 0, clusters: 0, output: 0, tried: 0, states: 0, fallback: 0, missing: 0, unsupported: 0, orphans: 0, script: 0, unpaired: 0 };
    return drive(normalizeFonts(input, cascade, from, to, supplied, preference, limits, c), c);
}
