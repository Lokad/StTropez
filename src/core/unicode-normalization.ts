import type { TextBuffer } from "./text-buffer.ts";
import type { GlyphSourceSpan } from "./font-substitution.ts";
import { kernelCursor } from "./kernel-cursor.ts";
import { utf16CodePointAt } from "./utf16.ts";
import { canonicalCombiningClass, normalizationComposition, normalizationDecomposition, shapingUnicodeVersion } from "./unicode-shaping-data.ts";

export type NormalizationForm = "none" | "NFC" | "NFD" | "NFKC" | "NFKD";
export type LayoutNormalizationForm = NormalizationForm | "font";
export type NormalizedPoint = Readonly<{ codePoint: number; sources: readonly GlyphSourceSpan[] }>;
export type NormalizationOptions = Readonly<{ form?: NormalizationForm; from?: number; to?: number; maxOperations?: number; maxPoints?: number }>;
export type NormalizationPhase = "scan" | "decompose" | "order" | "compose" | "publish";
export type NormalizationProgress = Readonly<{ status: "running" | "ready" | "failed" | "disposed"; phase: NormalizationPhase;
    scannedUnits: number; readUnits: number; inputPoints: number; decomposedPoints: number; outputPoints: number;
    workUnits: number; result: NormalizedText | null; failure: string | null }>;
export type NormalizationCursor = Readonly<{ next: (workBudget?: number) => NormalizationProgress; snapshot: () => NormalizationProgress; dispose: () => void }>;
export class NormalizationLimitError extends Error {
    readonly limit: "operations" | "points";
    constructor(limit: "operations" | "points") { super(`Unicode normalization exceeded its ${limit} limit.`); this.name = "NormalizationLimitError"; this.limit = limit; }
}
const owned = new WeakSet<NormalizedText>();
export const ownedNormalizedText = (value: unknown): value is NormalizedText => typeof value === "object" && value !== null && owned.has(value as NormalizedText);
let publish: (source: TextBuffer, from: number, to: number, form: LayoutNormalizationForm, blocks: readonly (readonly NormalizedPoint[])[], length: number, units: number) => NormalizedText;
const interval = (length: number, from: number, to: number) => { if (![from, to].every(Number.isSafeInteger) || from < 0 || from > to || to > length) throw new RangeError("Invalid normalized text range."); };

/** Immutable layout text and exact input-point provenance; the original buffer is never edited. */
export class NormalizedText {
    readonly source: TextBuffer;
    readonly from: number;
    readonly to: number;
    readonly form: LayoutNormalizationForm;
    readonly length: number;
    readonly utf16Length: number;
    readonly unicodeVersion = shapingUnicodeVersion;
    readonly #blocks: readonly (readonly NormalizedPoint[])[];
    private constructor(source: TextBuffer, from: number, to: number, form: LayoutNormalizationForm, blocks: readonly (readonly NormalizedPoint[])[], length: number, units: number) {
        this.source = source; this.from = from; this.to = to; this.form = form; this.#blocks = blocks; this.length = length; this.utf16Length = units; owned.add(this); Object.freeze(this);
    }
    at(index: number): NormalizedPoint { interval(this.length, index, index + 1); return this.#blocks[Math.floor(index / 256)]![index % 256]!; }
    /** Explicit export by normalized point indices. Bounded consumers should query at(). */
    text(from = 0, to = this.length): string {
        interval(this.length, from, to); const parts: string[] = [];
        for (let start = from; start < to; start += 256) { const points: number[] = []; for (let i = start; i < Math.min(to, start + 256); i++) points.push(this.at(i).codePoint); parts.push(String.fromCodePoint(...points)); } return parts.join("");
    }
    static { publish = (source, from, to, form, blocks, length, units) => new NormalizedText(source, from, to, form, blocks, length, units); }
}
type Origin = GlyphSourceSpan | Readonly<{ left: Origin; right: Origin }>;
type Token = { cp: number; ccc: number; origin: Origin; next: Token | null };
type Counters = { phase: NormalizationPhase; scanned: number; reads: number; input: number; decomposed: number; output: number; work: number; yielded: number };
const positive = (value: number) => { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("Invalid normalization limit."); return value; };
function decomposition(cp: number, compatibility: boolean): readonly number[] | null {
    const s = cp - 0xac00; if (s >= 0 && s < 11172) { const l = 0x1100 + Math.floor(s / 588), v = 0x1161 + Math.floor(s % 588 / 28), t = s % 28; return t ? [l, v, 0x11a7 + t] : [l, v]; }
    return normalizationDecomposition(cp, compatibility);
}
function composition(first: number, second: number): number | null {
    const l = first - 0x1100, v = second - 0x1161; if (l >= 0 && l < 19 && v >= 0 && v < 21) return 0xac00 + (l * 21 + v) * 28;
    const s = first - 0xac00, t = second - 0x11a7; if (s >= 0 && s < 11172 && s % 28 === 0 && t > 0 && t < 28) return first + t;
    return normalizationComposition(first, second);
}
const merge = (left: Origin, right: Origin): Origin => left === right ? left : { left, right };
type CompositionFilter = (first: number, second: number, composed: number) => boolean;

function* normalize(source: TextBuffer, from: number, to: number, form: NormalizationForm, maxOperations: number, maxPoints: number, c: Counters,
    points: readonly NormalizedPoint[] | null = null, accept: CompositionFilter | null = null): Generator<void, NormalizedText | null> {
    const tick = (count = 1) => { c.work += count; if (c.work > maxOperations) throw new NormalizationLimitError("operations"); };
    const pause = () => { if (c.work - c.yielded < 256) return false; c.yielded = c.work; return true; };
    const compose = form === "NFC" || form === "NFKC", compatibility = form === "NFKC" || form === "NFKD";
    const join = (first: number, second: number) => { const cp = composition(first, second); return cp !== null && (!accept || accept(first, second, cp)) ? cp : null; };
    const heads: (Token | null | undefined)[] = [], tails: (Token | null | undefined)[] = [], used = new Uint32Array(8);
    const blocks: (readonly NormalizedPoint[])[] = []; let pending: NormalizedPoint[] = [], starter: Token | null = null, marks = 0, units = 0;
    function* emit(token: Token): Generator<void, void> {
        c.phase = "publish"; const stack: Origin[] = [token.origin], seen = new Set<GlyphSourceSpan>(), sources: GlyphSourceSpan[] = [];
        while (stack.length) { tick(); if (pause()) yield; const origin = stack.pop()!; if ("left" in origin) { stack.push(origin.right, origin.left); } else if (!seen.has(origin)) { seen.add(origin); sources.push(origin); } }
        const point = Object.freeze({ codePoint: token.cp, sources: Object.freeze(sources) }); pending.push(point); c.output++; units += token.cp > 0xffff ? 2 : 1;
        if (pending.length === 256) { blocks.push(Object.freeze(pending)); pending = []; }
    }
    function* flush(next: Token | null): Generator<void, void> {
        c.phase = "order"; tick(); if (pause()) yield; const segment: Token[] = []; let active = starter, lastClass = 0; if (active) segment.push(active);
        if (marks) for (let group = 0; group < used.length; group++) {
            tick(); if (pause()) yield; let bits = used[group]!;
            while (bits) {
                const bit = 31 - Math.clz32(bits & -bits), cls = group * 32 + bit; let token = heads[cls];
                while (token) {
                    const following = token.next; token.next = null; c.phase = compose ? "compose" : "order"; tick(); if (pause()) yield;
                    const joined = compose && active && (lastClass < cls || lastClass === 0) ? join(active.cp, token.cp) : null;
                    if (joined !== null) { active!.cp = joined; active!.origin = merge(active!.origin, token.origin); }
                    else { segment.push(token); lastClass = cls; } token = following;
                }
                heads[cls] = tails[cls] = null; bits = (bits & bits - 1) >>> 0;
            }
            used[group] = 0;
        }
        marks = 0; c.phase = compose ? "compose" : "order"; tick(); if (pause()) yield;
        const joined = compose && active && segment.length === 1 && next ? join(active.cp, next.cp) : null;
        if (joined !== null) { active!.cp = joined; active!.origin = merge(active!.origin, next!.origin); starter = active; return; }
        for (const token of segment) yield* emit(token); starter = next;
    }
    let offset = from, windowFrom = from, window = "", pointIndex = 0;
    while (points ? pointIndex < points.length : offset < to) {
        c.phase = "scan";
        if (!points && offset >= windowFrom + window.length) {
            windowFrom = offset; const end = Math.min(to, offset + 256); window = source.slice(offset, end); let read = window.length;
            const last = window.charCodeAt(window.length - 1); if (last >= 0xd800 && last <= 0xdbff && end < to) { const next = source.slice(end, end + 1); read++; const low = next.charCodeAt(0); if (low >= 0xdc00 && low <= 0xdfff) window += next; }
            c.reads += read; tick(read); if (pause()) yield;
        }
        const point = points?.[pointIndex++], cp = point ? point.codePoint : utf16CodePointAt(window, offset - windowFrom), width = cp > 0xffff ? 2 : 1;
        let origin: Origin = point ? point.sources[0]! : Object.freeze({ from: offset, to: offset + width });
        if (point) for (let i = 1; i < point.sources.length; i++) { tick(); if (pause()) yield; origin = merge(origin, point.sources[i]!); }
        offset += width; c.scanned = offset - from; c.input++;
        const stack = [cp];
        while (stack.length) {
            c.phase = "decompose"; tick(); if (pause()) yield; const point = stack.pop()!, expansion = form === "none" ? null : decomposition(point, compatibility);
            if (expansion) { for (let i = expansion.length - 1; i >= 0; i--) { tick(); if (pause()) yield; stack.push(expansion[i]!); } continue; }
            if (++c.decomposed > maxPoints) throw new NormalizationLimitError("points"); const cls = canonicalCombiningClass(point), token: Token = { cp: point, ccc: cls, origin, next: null };
            if (form === "none") yield* emit(token);
            else if (!cls) yield* flush(token);
            else { const last = tails[cls]; if (last) last.next = token; else heads[cls] = token; tails[cls] = token; used[cls >>> 5] = used[cls >>> 5]! | 1 << (cls & 31); marks++; }
        }
    }
    if (form !== "none") yield* flush(null); if (pending.length) blocks.push(Object.freeze(pending));
    return publish(source, from, to, accept ? "font" : form, Object.freeze(blocks), c.output, units);
}

function drive(iterator: Generator<void, NormalizedText | null> | null, c: Counters): NormalizationCursor {
    const cursor = kernelCursor(iterator, () => c.work, (status, result, failure): NormalizationProgress => Object.freeze({ status, phase: c.phase, scannedUnits: c.scanned,
        readUnits: c.reads, inputPoints: c.input, decomposedPoints: c.decomposed, outputPoints: c.output, workUnits: c.work, result, failure }), "Normalization"); iterator = null; return cursor;
}
export function createNormalizationCursor(source: TextBuffer, options: NormalizationOptions = {}): NormalizationCursor {
    const from = options.from ?? 0, to = options.to ?? source.length, form = options.form ?? "NFC"; interval(source.length, from, to);
    if (!["none", "NFC", "NFD", "NFKC", "NFKD"].includes(form)) throw new RangeError("Invalid normalization form.");
    const maxOperations = positive(options.maxOperations ?? Math.max(1_000_000, (to - from) * 256)), maxPoints = positive(options.maxPoints ?? Math.max(1_000_000, (to - from) * 64));
    const c: Counters = { phase: "scan", scanned: 0, reads: 0, input: 0, decomposed: 0, output: 0, work: 0, yielded: 0 };
    return drive(normalize(source, from, to, form, maxOperations, maxPoints, c), c);
}
export function normalizeText(source: TextBuffer, options: NormalizationOptions = {}): NormalizedText {
    const cursor = createNormalizationCursor(source, options); try { let step = cursor.next(65536); while (step.status === "running") step = cursor.next(65536); return step.result!; } finally { cursor.dispose(); }
}

/** Internal owned-point path: callers keep immutable points stable until disposal. No source reread. */
export function normalizationCursorFromPoints(source: TextBuffer, from: number, to: number, points: readonly NormalizedPoint[], form: "NFD" | "NFC", maxOperations: number, maxPoints: number, accept: CompositionFilter | null = null): NormalizationCursor {
    const c: Counters = { phase: "scan", scanned: 0, reads: 0, input: 0, decomposed: 0, output: 0, work: 0, yielded: 0 };
    return drive(normalize(source, from, to, form, maxOperations, maxPoints, c, points, accept), c);
}
/** Internal publication of already frozen, provenance-preserving font layout points. */
export const fontNormalizedTextFromOwnedBlocks = (source: TextBuffer, from: number, to: number, blocks: readonly (readonly NormalizedPoint[])[], length: number, units: number): NormalizedText => publish(source, from, to, "font", blocks, length, units);
