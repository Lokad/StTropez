import { getLine, lineEdges, tick } from "./diff-index.ts";
import type { DiffIndex as Index, DiffStats as Stats } from "./diff-index.ts";

type Region = Readonly<{ a0: number; a1: number; b0: number; b1: number }>;
type Token = Readonly<{ count: number; first: number }>;
export type DiffRepairReference = ReadonlyMap<string, Token>;
/** Job-local complete root scans. Neither map is published before outer-row completion. */
export type DiffRepairCounts = { region: Region; previous?: DiffRepairReference | undefined; reference?: Map<string, Token>; working?: Map<string, number> };
/** The retained reference membership is fixed in every optimum attaining the occurrence bound.
 * The uniqueness flag also proves the working placements; only that case permits local splicing.
 * Deviations store only nonzero working counts different from the reference count.
 * Otherwise the first reference occurrence is matched iff the working count is complete.
 * Published maps are never mutated; each repair copies only the bounded deviations. */
export type DiffRepairCertificate = Readonly<{ reference: DiffRepairReference; deviations: ReadonlyMap<string, number>; matches: number; unique: boolean }>;
type Repair = Readonly<{ proof: DiffRepairCertificate; from: number; to: number; delta: number; rowDelta: number } &
    ({ changes: readonly Region[]; origins: readonly (number | undefined)[] } | { required: { from: number; to: number; rows: readonly number[] } })>;
const limits = Object.freeze({ rows: 65536, regions: 4096, window: 256, deviations: 256 });

/** Reuse complete root alphabets, extending their counts through the equal trimmed rows.
 * The completed exact edit distance proves attainment of the shared-occurrence bound.
 * An absent working scan still permits the ordinary unmatched-region certification. */
export function* certifyCountedAlignment(left: Index, right: Index, changes: readonly Region[], counts: DiffRepairCounts, stats: Stats): Generator<void, { reference: DiffRepairReference; proof?: DiffRepairCertificate } | undefined> {
    if (Math.max(left.lines.size, right.lines.size) > limits.rows || changes.length > limits.regions) return;
    const { working, region } = counts, reference = counts.previous ?? counts.reference;
    if (!reference || region.a0 !== region.b0 || left.lines.size - region.a1 !== right.lines.size - region.b1) return;
    for (const [from, to] of [[0, region.a0], [region.a1, left.lines.size]] as const) for (let row = from; row < to; row++) {
        const token = (yield* getLine(left, row, stats)).token; if (token === undefined) return;
        if (!counts.previous) {
            const old = reference.get(token);
            counts.reference!.set(token, { first: Math.min(old?.first ?? row, row), count: (old?.count ?? 0) + 1 });
        }
        if (working) working.set(token, (working.get(token) ?? 0) + 1);
        if (tick(stats, token.length + (working ? 8 : 6))) yield;
    }
    if (!working) {
        const proof = yield* certifyAlignment(left, right, changes, reference, stats);
        return proof ? { reference, proof } : { reference };
    }
    const deviations = new Map<string, number>(); let matches = 0, edits = 0;
    for (const [token, ref] of reference) {
        const count = working.get(token) ?? 0;
        if (count > 0 && count < ref.count) return { reference };
        if (count > 0) matches += ref.count;
        if (count > ref.count) deviations.set(token, count);
        if (deviations.size > limits.deviations) return { reference };
        if (tick(stats, token.length + 8)) yield;
    }
    for (const change of changes) { edits += change.a1 - change.a0 + change.b1 - change.b0; if (tick(stats, 4)) yield; }
    return edits === left.lines.size + right.lines.size - 2 * matches
        ? { reference, proof: { reference, deviations, matches, unique: deviations.size === 0 } } : { reference };
}

/** Map an unchanged row through the sorted raw regions, including zero-width changes. */
function* match(changes: readonly Region[], row: number, side: "a" | "b", stats: Stats): Generator<void, number | undefined> {
    let low = 0, high = changes.length;
    while (low < high) {
        const mid = (low + high) >>> 1, end = side === "a" ? changes[mid]!.a1 : changes[mid]!.b1;
        if (end <= row) low = mid + 1; else high = mid;
        if (tick(stats, 4)) yield;
    }
    const next = changes[low];
    if (next && (side === "a" ? next.a0 : next.b0) <= row) return;
    const prior = changes[low - 1];
    return row + (prior ? side === "a" ? prior.b1 - prior.a1 : prior.a1 - prior.b1 : 0);
}

/** Verify the complete capture, including trimmed outer rows: every matchable reference
 * occurrence must participate. Equal shared counts also fix its working placement; excess
 * working occurrences permit ambiguity while preserving the forced reference membership. */
export function* certifyAlignment(left: Index, right: Index, changes: readonly Region[], previous: DiffRepairReference | undefined, stats: Stats): Generator<void, DiffRepairCertificate | undefined> {
    if (Math.max(left.lines.size, right.lines.size) > limits.rows || changes.length > limits.regions) return;
    let reference = previous;
    if (!reference) {
        const tokens = new Map<string, Token>();
        for (let row = 0; row < left.lines.size; row++) {
            const token = (yield* getLine(left, row, stats)).token; if (token === undefined) return;
            const old = tokens.get(token); tokens.set(token, { count: (old?.count ?? 0) + 1, first: old?.first ?? row });
            if (tick(stats, token.length + 4)) yield;
        }
        reference = tokens;
    }
    // All matched rows already occur in the completed alignment. Count only exceptions.
    // A reference token must be wholly matched or wholly absent, never partially matched.
    const missing = new Map<string, number>(); let matches = left.lines.size;
    for (const region of changes) {
        matches -= region.a1 - region.a0;
        for (let row = region.a0; row < region.a1; row++) {
            const token = (yield* getLine(left, row, stats)).token; if (token === undefined) return;
            missing.set(token, (missing.get(token) ?? 0) + 1);
            if (tick(stats, token.length + 4)) yield;
        }
        if (tick(stats, 2)) yield;
    }
    for (const [token, count] of missing) {
        if (count !== reference.get(token)!.count) return;
        if (tick(stats, 4)) yield;
    }
    const deviations = new Map<string, number>();
    for (const region of changes) {
        for (let row = region.b0; row < region.b1; row++) {
            const token = (yield* getLine(right, row, stats)).token; if (token === undefined) return;
            const ref = reference.get(token);
            if (ref) {
                if (missing.has(token)) return;
                deviations.set(token, (deviations.get(token) ?? ref.count) + 1);
                if (deviations.size > limits.deviations) return;
            }
            if (tick(stats, token.length + 8)) yield;
        }
        if (tick(stats, 2)) yield;
    }
    return { reference, deviations, matches, unique: deviations.size === 0 };
}

/** An equal-row edge belongs to an optimal matching iff prefix + 1 + suffix equals LCS.
 * Exactly LCS distinct reference endpoints fixes membership in every optimum. Multiple
 * working endpoints keep that membership but require global canonical placement.
 * One forward table and two reverse rows use at most 257*257 + 2*257 Uint16 cells. */
function* fixedMembership(left: readonly string[], right: readonly string[], stats: Stats): Generator<void, { pairs: readonly (readonly [number, number])[]; unique: boolean } | undefined> {
    const n = left.length, m = right.length, width = m + 1, table = new Uint16Array((n + 1) * width);
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
        table[(i + 1) * width + j + 1] = left[i] === right[j] ? table[i * width + j]! + 1 : Math.max(table[i * width + j + 1]!, table[(i + 1) * width + j]!);
        stats.lineComparisons++; if (tick(stats, Math.max(left[i]!.length, right[j]!.length) + 4)) yield;
    }
    const length = table[n * width + m]!, pairs: (readonly [number, number])[] = [];
    let below = new Uint16Array(width), current = new Uint16Array(width), unique = true;
    for (let i = n - 1; i >= 0; i--) {
        current[m] = 0; let chosen = false;
        for (let j = m - 1; j >= 0; j--) {
            const equal = left[i] === right[j];
            current[j] = equal ? below[j + 1]! + 1 : Math.max(below[j]!, current[j + 1]!);
            if (equal && table[i * width + j]! + 1 + below[j + 1]! === length) {
                if (chosen) unique = false;
                else { pairs.push([i, j]); chosen = true; if (pairs.length > length) return; }
                if (tick(stats, 2)) yield;
            }
            stats.lineComparisons++; if (tick(stats, Math.max(left[i]!.length, right[j]!.length) + 4)) yield;
        }
        [below, current] = [current, below];
    }
    if (pairs.length !== length) return;
    const ordered: (readonly [number, number])[] = [];
    for (let index = pairs.length - 1; index >= 0; index--) { ordered.push(pairs[index]!); if (tick(stats)) yield; }
    return { pairs: ordered, unique };
}

/** Tokens balanced in both captures force their occurrence ranks to match in every optimum
 * attaining the count bound. Unchanged matches on either side of the edit therefore anchor
 * an independent local window. Fixed local reference membership must attain the updated
 * global bound. Unique placements splice locally; ambiguous placements return only the
 * forced reference rows, leaving canonical placement to the current comparison. */
export function* repairAlignment(left: Index, right: Index, old: Index, changes: readonly Region[], proof: DiffRepairCertificate, stats: Stats): Generator<void, Repair | undefined> {
    if (Math.max(left.lines.size, right.lines.size, old.lines.size) > limits.rows) return;
    const edges = yield* lineEdges(old.buffer, right.buffer, stats);
    const from = edges.aFrom === old.to ? old.lines.size : old.buffer.lineAt(edges.aFrom);
    const to = edges.aTo === old.to ? old.lines.size : old.buffer.lineAt(edges.aTo);
    const end = edges.bTo === right.to ? right.lines.size : right.buffer.lineAt(edges.bTo);
    if (Math.max(to - from, end - from) > limits.window) return;
    const rowDelta = end - to, delta = right.to - old.to, counts = new Map<string, number>(), deltas = new Map<string, number>();
    function* before(token: string): Generator<void, number> {
        let count = counts.get(token); if (count !== undefined) return count;
        const ref = proof.reference.get(token);
        count = proof.deviations.get(token) ?? (ref && (yield* match(changes, ref.first, "a", stats)) !== undefined ? ref.count : 0);
        counts.set(token, count); if (tick(stats, token.length + 4)) yield; return count;
    }
    for (const [index, stop, sign] of [[old, to, -1], [right, end, 1]] as const) for (let row = from; row < stop; row++) {
        const token = (yield* getLine(index, row, stats)).token; if (token === undefined) return;
        if (proof.reference.has(token)) deltas.set(token, (deltas.get(token) ?? 0) + sign);
        if (tick(stats, token.length + 4)) yield;
    }
    // Only affected token counts change; never copy or scan the complete reference index.
    const deviations = new Map<string, number>();
    for (const [token, count] of proof.deviations) { deviations.set(token, count); if (tick(stats, 4)) yield; }
    let upper = proof.matches;
    for (const [token, difference] of deltas) {
        const previous = yield* before(token), next = previous + difference, ref = proof.reference.get(token)!;
        if (next < 0) return;
        upper += Math.min(ref.count, next) - Math.min(ref.count, previous);
        if (next !== 0 && next !== ref.count) deviations.set(token, next); else deviations.delete(token);
        if (tick(stats, 8)) yield;
    }
    if (deviations.size > limits.deviations) return;
    function* anchor(start: number, direction: -1 | 1): Generator<void, readonly [number, number] | undefined> {
        let inspected = 0;
        for (let row = start; row >= 0 && row < old.lines.size; row += direction) {
            if (++inspected > limits.window) return;
            const token = (yield* getLine(old, row, stats)).token; if (token === undefined) return;
            const ref = proof.reference.get(token);
            if (ref && (yield* before(token)) === ref.count && (deltas.get(token) ?? 0) === 0) {
                const ai = yield* match(changes, row, "b", stats);
                if (ai !== undefined) return [ai, row];
            }
            if (tick(stats, token.length + 4)) yield;
        }
        return direction < 0 ? [-1, -1] : [left.lines.size, old.lines.size];
    }
    const prior = yield* anchor(from - 1, -1), next = yield* anchor(to, 1);
    if (!prior || !next) return;
    const a0 = prior[0] + 1, a1 = next[0], b0 = prior[1] + 1, oldEnd = next[1], b1 = oldEnd + rowDelta;
    if (a1 - a0 > limits.window || b1 - b0 > limits.window || a0 > a1 || b0 > b1) return;
    const a: string[] = [], b: string[] = [];
    for (const [index, begin, stop, rows] of [[left, a0, a1, a], [right, b0, b1, b]] as const) for (let row = begin; row < stop; row++) {
        const token = (yield* getLine(index, row, stats)).token; if (token === undefined) return;
        rows.push(token); if (tick(stats)) yield;
    }
    const local = yield* fixedMembership(a, b, stats); if (!local) return;
    const pairs = local.pairs;
    const prefix: { region: Region; origin: number }[] = [], suffix: { region: Region; origin: number }[] = []; let localEdits = 0;
    for (let index = 0; index < changes.length; index++) {
        const region = changes[index]!;
        if (region.a1 <= a0 && region.b1 <= b0) prefix.push({ region, origin: index });
        else if (region.a0 >= a1 && region.b0 >= oldEnd) suffix.push({ region: { ...region, b0: region.b0 + rowDelta, b1: region.b1 + rowDelta }, origin: index });
        else {
            if (region.a0 < a0 || region.a1 > a1 || region.b0 < b0 || region.b1 > oldEnd) return;
            localEdits += region.a1 - region.a0 + region.b1 - region.b0;
        }
        if (tick(stats, 8)) yield;
    }
    const oldLocal = (a1 - a0 + oldEnd - b0 - localEdits) / 2;
    if (proof.matches - oldLocal + pairs.length !== upper) return;
    if (!proof.unique || !local.unique) {
        const rows: number[] = [];
        for (const pair of pairs) { rows.push(a0 + pair[0]); if (tick(stats, 2)) yield; }
        return { required: { from: a0, to: a1, rows }, proof: { reference: proof.reference, deviations, matches: upper, unique: false }, from: b0, to: b1, delta, rowDelta };
    }
    // Origins distinguish reusable empty hunks from newly computed local regions.
    const result: Region[] = [], origins: (number | undefined)[] = [];
    for (const entry of prefix) { result.push(entry.region); origins.push(entry.origin); if (tick(stats, 2)) yield; }
    let ai = a0, bi = b0;
    for (const [x, y] of pairs) {
        if (ai < a0 + x || bi < b0 + y) { result.push({ a0: ai, a1: a0 + x, b0: bi, b1: b0 + y }); origins.push(undefined); }
        ai = a0 + x + 1; bi = b0 + y + 1; if (tick(stats, 4)) yield;
    }
    if (ai < a1 || bi < b1) { result.push({ a0: ai, a1, b0: bi, b1 }); origins.push(undefined); }
    for (const entry of suffix) { result.push(entry.region); origins.push(entry.origin); if (tick(stats, 2)) yield; }
    if (result.length > limits.regions) return;
    return { changes: result, origins, proof: { reference: proof.reference, deviations, matches: upper, unique: true }, from: b0, to: b1, delta, rowDelta };
}
