import { getLine, lineEdges, tick } from "./diff-index.ts";
import type { DiffIndex as Index, DiffStats as Stats } from "./diff-index.ts";

type Region = Readonly<{ a0: number; a1: number; b0: number; b1: number }>;
type Token = Readonly<{ count: number; first: number }>;
export type DiffRepairReference = ReadonlyMap<string, Token>;
/** The retained matching is unique and attains sum(min(reference count, working count)).
 * Deviations store only nonzero working counts different from the reference count.
 * Otherwise the first reference occurrence is matched iff the working count is complete.
 * Published maps are never mutated; each repair copies only the bounded deviations. */
export type DiffRepairCertificate = Readonly<{ reference: DiffRepairReference; deviations: ReadonlyMap<string, number>; matches: number }>;
type Repair = Readonly<{ changes: readonly Region[]; origins: readonly (number | undefined)[];
    proof: DiffRepairCertificate; from: number; to: number; delta: number; rowDelta: number }>;
const limits = Object.freeze({ rows: 65536, regions: 4096, window: 256, deviations: 256 });

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

/** Called after ordered-common alignment succeeds. Verify the complete capture, including
 * trimmed outer rows: every shared occurrence must match and shared counts must balance.
 * This gives a unique global optimum and a reusable immutable reference count index. */
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
    const counts = new Map<string, number>(); let matches = 0, change = 0;
    for (let row = 0; row < right.lines.size; row++) {
        const token = (yield* getLine(right, row, stats)).token; if (token === undefined) return;
        while (change < changes.length && changes[change]!.b1 <= row) { change++; if (tick(stats)) yield; }
        const unmatched = changes[change] && changes[change]!.b0 <= row;
        if (reference.has(token)) {
            if (unmatched) return;
            counts.set(token, (counts.get(token) ?? 0) + 1); matches++;
        } else if (!unmatched) return;
        if (tick(stats, token.length + 4)) yield;
    }
    for (const [token, count] of counts) { if (count !== reference.get(token)!.count) return; if (tick(stats, 4)) yield; }
    return { reference, deviations: new Map(), matches };
}

/** An equal-row edge belongs to an optimal matching iff prefix + 1 + suffix equals LCS.
 * Exactly LCS such edges means the matching is unique. Insertion/deletion order is irrelevant.
 * One forward table and two reverse rows use at most 257*257 + 2*257 Uint16 cells. */
function* unique(left: readonly string[], right: readonly string[], stats: Stats): Generator<void, readonly (readonly [number, number])[] | undefined> {
    const n = left.length, m = right.length, width = m + 1, table = new Uint16Array((n + 1) * width);
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
        table[(i + 1) * width + j + 1] = left[i] === right[j] ? table[i * width + j]! + 1 : Math.max(table[i * width + j + 1]!, table[(i + 1) * width + j]!);
        stats.lineComparisons++; if (tick(stats, Math.max(left[i]!.length, right[j]!.length) + 4)) yield;
    }
    const length = table[n * width + m]!, pairs: (readonly [number, number])[] = [];
    let below = new Uint16Array(width), current = new Uint16Array(width);
    for (let i = n - 1; i >= 0; i--) {
        current[m] = 0;
        for (let j = m - 1; j >= 0; j--) {
            const equal = left[i] === right[j];
            current[j] = equal ? below[j + 1]! + 1 : Math.max(below[j]!, current[j + 1]!);
            if (equal && table[i * width + j]! + 1 + below[j + 1]! === length) {
                pairs.push([i, j]); if (pairs.length > length) return;
            }
            stats.lineComparisons++; if (tick(stats, Math.max(left[i]!.length, right[j]!.length) + 4)) yield;
        }
        [below, current] = [current, below];
    }
    if (pairs.length !== length) return;
    const ordered: (readonly [number, number])[] = [];
    for (let index = pairs.length - 1; index >= 0; index--) { ordered.push(pairs[index]!); if (tick(stats)) yield; }
    return ordered;
}

/** Tokens balanced in both captures force their occurrence ranks to match in every optimum
 * attaining the count bound. Unchanged matches on either side of the edit therefore anchor
 * an independent local window. Accept only a unique local matching attaining the updated
 * global bound; unchanged outer components retain their old unique optimum. */
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
    const pairs = yield* unique(a, b, stats); if (!pairs) return;
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
    return { changes: result, origins, proof: { reference: proof.reference, deviations, matches: upper }, from: b0, to: b1, delta, rowDelta };
}
