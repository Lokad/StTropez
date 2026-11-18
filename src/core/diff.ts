import { certifyAlignment, repairAlignment } from "./diff-repair.ts";
import type { DiffRepairCertificate, DiffRepairReference } from "./diff-repair.ts";
import { prepareEqualities, minimumEqualRows } from "./diff-equalities.ts";
import type { DiffEqualities, DiffEqualitySnapshot } from "./diff-equalities.ts";
import type { TextBuffer } from "./text-buffer.ts";
import { kernelCursor } from "./kernel-cursor.ts";
import type { KernelCursor, KernelStatus } from "./kernel-cursor.ts";
import { DiffIdentities, equalLineText, knownLineHash, lineHash } from "./diff-identities.ts";
import { commonText, getLine, lineEdges, indexLines, lineLength, matchingLines, offsetAt, tick } from "./diff-index.ts";
import type { DiffStats, DiffIndex as Index } from "./diff-index.ts";
type Stats = DiffStats & { identities: DiffIdentities; equalities: DiffEqualities | undefined };
export type DiffRange = Readonly<{ from: number; to: number; lineFrom: number; lineTo: number }>;
export type DiffHunk = Readonly<{ baseline: DiffRange; working: DiffRange; whitespaceOnly: boolean }>;
export type DiffProgress = Readonly<{ status: KernelStatus; work: number; readUnits: number; lineComparisons: number; lineEdits: number; hunks: readonly DiffHunk[]; failure: string | null }>;
type Alphabet = Readonly<{ has(token: string): boolean }>;
type Cache = { baseline: TextBuffer; serial: number; reference: Index | undefined; working: Index | undefined;
    equalities?: DiffEqualitySnapshot; alphabet?: Alphabet | null; repairReference?: DiffRepairReference; alignment?: AlignmentPlan | undefined; frontier?: FrontierPlan | undefined; splits?: SplitPlan | undefined };
const referenceCaches = new WeakMap<DiffReferenceCache, { current: Cache | undefined }>();

/** Retains reference/working metadata and bounded exact proofs from completed captures. */
export class DiffReferenceCache {
    constructor() { referenceCaches.set(this, { current: undefined }); Object.freeze(this); }
    dispose(): void { referenceCaches.delete(this); }
}
type Region = Readonly<{ a0: number; a1: number; b0: number; b1: number }>;
type FrontierPoint = Readonly<{ distance: number; radius: number; origin: number; sparse?: boolean; forward: Int32Array; reverse: Int32Array; seenF: number; seenR: number }>;
type FrontierPlan = Readonly<{ working: Index; region: Region; points: readonly FrontierPoint[]; minimum?: number }>;
type FrontierCapture = { previous: FrontierPlan | undefined; plan?: FrontierPlan; ordered?: boolean; certified?: boolean; profile?: RootProfiles; first: boolean };
type SplitCapture = { rows?: Float64Array; count: number; reused: boolean };
type SplitPlan = Readonly<{ working: Index; rows: Float64Array; count: number }>;
// Split points contain the reference row, working row and exact region edit distance.
type SavedSplit = Readonly<{ point: readonly [number, number, number]; work: number }>;
const decisionLimits = Object.freeze({ bytes: 65536, splits: 32, fields: 8, minimumWork: 1024 });
const splitBytes = decisionLimits.splits * decisionLimits.fields * Float64Array.BYTES_PER_ELEMENT;
const regionKey = (region: Region): string => [region.a0, region.a1, region.b0, region.b1].join(":");
/** Only whole unchanged regions preserve the deterministic bisection decision. */
function* retainedSplits(plan: SplitPlan, right: Index, stats: Stats): Generator<void, Map<string, SavedSplit>> {
    const saved = new Map<string, SavedSplit>(), old = plan.working;
    let from = old.lines.size, to = from, end = from;
    if (old.buffer !== right.buffer) {
        const edges = yield* lineEdges(old.buffer, right.buffer, stats);
        from = edges.aFrom === old.to ? old.lines.size : old.buffer.lineAt(edges.aFrom);
        to = edges.aTo === old.to ? old.lines.size : old.buffer.lineAt(edges.aTo);
        end = edges.bTo === right.to ? right.lines.size : right.buffer.lineAt(edges.bTo);
        if (Math.max(to - from, end - from) > frontierLimits.changedRows) return saved;
    }
    for (let row = 0; row < plan.count; row++) {
        const i = row * decisionLimits.fields, a0 = plan.rows[i + 1]!, a1 = plan.rows[i + 2]!, b0 = plan.rows[i + 3]!, b1 = plan.rows[i + 4]!;
        const shift = b1 <= from ? 0 : b0 >= to ? end - to : undefined;
        if (shift !== undefined) saved.set(regionKey({ a0, a1, b0: b0 + shift, b1: b1 + shift }),
            { point: [plan.rows[i + 5]!, plan.rows[i + 6]! + shift, plan.rows[i + 7]!], work: plan.rows[i]! });
        if (tick(stats, decisionLimits.fields)) yield;
    }
    return saved;
}
/** Descending original work keeps expensive decisions without depending on the next edit. */
function* retainSplit(capture: SplitCapture, region: Region, point: readonly [number, number, number], work: number, stats: Stats): Generator<void, void> {
    if (tick(stats)) yield;
    if (work < decisionLimits.minimumWork) return;
    const fields = decisionLimits.fields; let rows = capture.rows;
    if (!rows) { capture.rows = rows = new Float64Array(decisionLimits.splits * fields); if (tick(stats, rows.length)) yield; }
    if (capture.count === decisionLimits.splits && work <= rows[(capture.count - 1) * fields]!) return;
    let row = Math.min(capture.count, decisionLimits.splits - 1);
    while (row > 0 && work > rows[(row - 1) * fields]!) {
        for (let field = 0; field < fields; field++) rows[row * fields + field] = rows[(row - 1) * fields + field]!;
        row--; if (tick(stats, fields)) yield;
    }
    const i = row * fields;
    rows[i] = work; rows[i + 1] = region.a0; rows[i + 2] = region.a1; rows[i + 3] = region.b0; rows[i + 4] = region.b1; rows[i + 5] = point[0]; rows[i + 6] = point[1]; rows[i + 7] = point[2];
    capture.count = Math.min(capture.count + 1, decisionLimits.splits);
    if (tick(stats, fields)) yield;
}
const frontierLimits = Object.freeze({ rows: 65536, changedRows: 256, firstDistance: 16, lastDistance: 2048, checkpointStride: 64, comparisons: 100000 });

/** A direction is reusable only while all move bounds and equality probes exclude the edit.
 * Replacing r old working rows with s new rows changes edit distance by at most r+s.
 * The completed region's exact minimum therefore excludes overlap below D-r-s. Saved
 * points contain complete waves through distance-1: ceil((D-r-s)/2) is a conservative
 * limit for independently restarting either direction without missing the first split.
 * The existing joint dependency proof remains available when this bound is weaker. */
function* retainedFrontier(plan: FrontierPlan, right: Index, region: Region, stats: Stats): Generator<void, {joint: number; forward: number; reverse: number} | undefined> {
    const old = plan.working, prior = plan.region;
    if (tick(stats, 4)) yield;
    if (region.a0 !== prior.a0 || region.a1 !== prior.a1 || region.b0 !== prior.b0) return;
    if (old.buffer === right.buffer) {
        const last = plan.points.length - 1;
        return region.b1 === prior.b1 ? {joint: last, forward: last, reverse: last} : undefined;
    }
    const edges = yield* lineEdges(old.buffer, right.buffer, stats);
    const from = edges.aFrom === old.to ? old.lines.size : old.buffer.lineAt(edges.aFrom);
    const to = edges.aTo === old.to ? old.lines.size : old.buffer.lineAt(edges.aTo);
    const end = edges.bTo === right.to ? right.lines.size : right.buffer.lineAt(edges.bTo);
    if (from < prior.b0 || to > prior.b1 || Math.max(to - from, end - from) > frontierLimits.changedRows
        || region.b1 !== prior.b1 + end - to) return;
    const limit = plan.minimum === undefined ? -1 : Math.ceil(Math.max(0, plan.minimum - (to - from) - (end - from)) / 2);
    let joint = -1, forward = -1, reverse = -1;
    for (let index = plan.points.length - 1; index >= 0; index--) {
        const point = plan.points[index]!, safeF = point.seenF < from - prior.b0, safeR = point.seenR < prior.b1 - to;
        if (joint < 0 && safeF && safeR && point.seenF + point.seenR < region.b1 - region.b0) joint = index;
        if (point.distance <= limit) {
            if (forward < 0 && safeF) forward = index;
            if (reverse < 0 && safeR) reverse = index;
        }
        if (tick(stats, 7)) yield;
    }
    forward = Math.max(joint, forward); reverse = Math.max(joint, reverse);
    return forward >= 0 || reverse >= 0 ? {joint, forward, reverse} : undefined;
}
type ProjectionSource = Readonly<{plan: FrontierPlan; right: Index; region: Region; cut: number; minimum: number}>;
/** Certify a zero-match row insertion before projecting complete ordinary waves. */
function* projectionSource(plan: FrontierPlan, right: Index, region: Region, alphabet: Alphabet, stats: Stats): Generator<void, ProjectionSource | undefined> {
    const old = plan.working, prior = plan.region, n = region.a1 - region.a0, m = prior.b1 - prior.b0;
    if (tick(stats, 8)) yield;
    if (plan.minimum === undefined || !plan.points.length || right.lines.size !== old.lines.size + 1 || region.a0 !== prior.a0 || region.a1 !== prior.a1 || region.b0 !== prior.b0 || region.b1 !== prior.b1 + 1) return;
    for (const point of plan.points) {
        if (point.sparse || point.seenF >= m || point.seenR >= m || Math.max(point.seenF, point.seenR) + point.distance >= n) return;
        if (tick(stats, 8)) yield;
    }
    const edges = yield* lineEdges(old.buffer, right.buffer, stats);
    const from = edges.aFrom === old.to ? old.lines.size : old.buffer.lineAt(edges.aFrom);
    const to = edges.aTo === old.to ? old.lines.size : old.buffer.lineAt(edges.aTo);
    const end = edges.bTo === right.to ? right.lines.size : right.buffer.lineAt(edges.bTo);
    if (end !== to + 1 || from < prior.b0 || to > prior.b1 || Math.max(to - from, end - from) > frontierLimits.changedRows) return;
    for (const [index, stop] of [[old, to], [right, end]] as const) for (let row = from; row < stop; row++) {
        const token = (yield* getLine(index, row, stats)).token;
        if (token === undefined) return;
        const matched = alphabet.has(token); if (tick(stats, token.length + 4)) yield;
        if (matched) return;
    }
    return {plan, right, region, cut: to - prior.b0, minimum: plan.minimum};
}
/** The live wave is exact; its missing earlier parity cannot support another projection. */
function* projectFrontier(source: ProjectionSource, stats: Stats): Generator<void, FrontierPlan> {
    const {plan, right, region, cut} = source, n = region.a1 - region.a0, m = plan.region.b1 - plan.region.b0, points: FrontierPoint[] = [];
    for (const point of plan.points) {
        const d = point.distance - 1, forward = new Int32Array(point.forward.length), reverse = new Int32Array(point.reverse.length);
        for (let at = 0; at < forward.length; at++) { forward[at] = -1; reverse[at] = -1; if (tick(stats, 2)) yield; }
        let seenF = 0, seenR = 0;
        for (const side of ["forward", "reverse"] as const) {
            const p = side === "forward" ? cut : m - cut, target = side === "forward" ? forward : reverse, source = point[side];
            for (let k = -d; k <= d; k += 2) {
                const a = source[point.origin + k] ?? -1, b = source[point.origin + k + 1] ?? -1;
                let x = b >= 0 && b - (k + 1) >= p ? b : a < 0 ? -1 : Math.min(a, p + k);
                if (x < 0 || x > n || x - k < 0 || x - k > m + 1 || 2 * x - k < d) x = -1;
                target[point.origin + k] = x;
                if (x >= 0) { if (side === "forward") seenF = Math.max(seenF, x - k + 1); else seenR = Math.max(seenR, x - k + 1); }
                if (tick(stats, 16)) yield;
            }
        }
        points.push(Object.freeze({ ...point, forward, reverse, seenF, seenR, sparse: true }));
    }
    return Object.freeze({ working: right, region, points: Object.freeze(points), minimum: source.minimum + 1 });
}

type RecursiveSeed = Readonly<{ frontier: FrontierPlan; splits: SplitPlan; from: number; to: number; end: number }>;
/** Cross-region bounds require frontier and split facts from the same working capture. */
function* recursiveSeed(frontier: FrontierPlan | undefined, splits: SplitPlan | undefined, right: Index, stats: Stats): Generator<void, RecursiveSeed | undefined> {
    if (!frontier || !splits || frontier.working !== splits.working) return;
    const old = frontier.working;
    let from = old.lines.size, to = from, end = from;
    if (old.buffer !== right.buffer) {
        const edges = yield* lineEdges(old.buffer, right.buffer, stats);
        from = edges.aFrom === old.to ? old.lines.size : old.buffer.lineAt(edges.aFrom);
        to = edges.aTo === old.to ? old.lines.size : old.buffer.lineAt(edges.aTo);
        end = edges.bTo === right.to ? right.lines.size : right.buffer.lineAt(edges.bTo);
    }
    if (Math.max(to - from, end - from) > frontierLimits.changedRows) return;
    return {frontier, splits, from, to, end};
}
/** Deleting/inserting outside owned intersections bounds how far an exact old distance can fall. */
function* recursiveDistance(seed: RecursiveSeed, region: Region, stats: Stats): Generator<void, number> {
    const {splits, from, to, end} = seed, n = region.a1 - region.a0, m = region.b1 - region.b0, shift = end - to;
    const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
    let lower = Math.abs(n - m);
    for (let row = 0; row < splits.count; row++) {
        const i = row * decisionLimits.fields, a0 = splits.rows[i + 1]!, a1 = splits.rows[i + 2]!, b0 = splits.rows[i + 3]!, b1 = splits.rows[i + 4]!;
        const commonA = overlap(a0, a1, region.a0, region.a1);
        const prefix = overlap(b0, Math.min(from, b1), region.b0, region.b1);
        const suffix = overlap(Math.max(to, b0) + shift, b1 + shift, region.b0, region.b1);
        // The prefix and shifted suffix are ordered disjoint common subsequences.
        const costA = a1 - a0 + n - 2 * commonA, costB = b1 - b0 + m - 2 * (prefix + suffix);
        lower = Math.max(lower, splits.rows[i + 7]! - costA - costB);
        if (tick(stats, 24)) yield;
    }
    return lower;
}
/** An anchored parent direction is exact inside a shorter unchanged child region.
 * Its stored y extent plus wave distance bounds x, including move validations. The
 * distance bound excludes overlap before either reused direction catches up. */
function* retainedRecursive(seed: RecursiveSeed, region: Region, stats: Stats, bounds?: ChildDistance): Generator<void, {joint: number; forward: number; reverse: number} | undefined> {
    const {frontier, from, to, end} = seed, prior = frontier.region, n = region.a1 - region.a0, m = region.b1 - region.b0, shift = end - to;
    const anchorF = region.a0 === prior.a0 && region.b0 === prior.b0;
    const anchorR = region.a1 === prior.a1 && region.b1 === prior.b1 + shift;
    if (tick(stats, 8)) yield;
    if ((!anchorF && !anchorR) || n > prior.a1 - prior.a0 || m > prior.b1 - prior.b0) return;
    const safeF = (p: FrontierPoint) => anchorF && p.seenF < from - region.b0 && p.seenF < m && p.seenF + p.distance < n;
    const safeR = (p: FrontierPoint) => anchorR && p.seenR < prior.b1 - to && p.seenR < m && p.seenR + p.distance < n;
    let possible = false;
    for (const point of frontier.points) { possible ||= safeF(point) || safeR(point); if (tick(stats, 8)) yield; }
    if (!possible) return;
    const lower = bounds?.minimum ?? (yield* recursiveDistance(seed, region, stats));
    if (bounds) bounds.minimum = lower;
    const limit = Math.ceil(lower / 2); let forward = -1, reverse = -1;
    for (let index = 0; index < frontier.points.length; index++) {
        const point = frontier.points[index]!;
        if (point.distance <= limit) { if (safeF(point)) forward = index; if (safeR(point)) reverse = index; }
        if (tick(stats, 10)) yield;
    }
    if (forward >= 0 || reverse >= 0) { return {joint: -1, forward, reverse}; }
    return;
}
function* copyFrontier(forward: Int32Array, reverse: Int32Array, stats: Stats): Generator<void, readonly [Int32Array<ArrayBuffer>, Int32Array<ArrayBuffer>]> {
    const f = new Int32Array(forward.length), r = new Int32Array(reverse.length);
    for (let index = 0; index < f.length; index++) { f[index] = forward[index]!; r[index] = reverse[index]!; if (tick(stats, 2)) yield; }
    return [f, r];
}
function* equalLine(a: Index, b: Index, ai: number, bi: number, stats: Stats, prove = true): Generator<void, boolean> {
    stats.lineComparisons++;
    if (tick(stats)) yield;
    const length = lineLength(a, ai); if (length !== lineLength(b, bi)) return false;
    if (prove && (yield* matchingLines(a, b, ai, ai + 1, bi, bi + 1, false, stats)) === 1) return true;
    const left = yield* getLine(a, ai, stats), right = yield* getLine(b, bi, stats);
    const identities = stats.identities, leftId = identities.known(left), rightId = identities.known(right);
    if (leftId !== undefined && rightId !== undefined) return leftId === rightId;
    const leftHash = knownLineHash(left), rightHash = knownLineHash(right);
    if (leftHash !== undefined && rightHash !== undefined && leftHash !== rightHash) return false;
    const cached = identities.cached(left) && identities.cached(right);
    const repeatedLeft = !cached && identities.repeated(left), repeatedRight = !cached && identities.repeated(right);
    if (cached || repeatedLeft || repeatedRight)
        return (yield* identities.identify(a, ai, left, stats)) === (yield* identities.identify(b, bi, right, stats));
    return yield* equalLineText(a, ai, left, b, bi, right, stats);
}
/** Known metadata can prove inequality; equal hashes and gaps still require exact checks. */
function knownUnequal(a: Index, b: Index, ai: number, bi: number): boolean {
    const left = a.lines.at(ai), right = b.lines.at(bi);
    if (!left || !right) return false;
    if (left.length !== right.length) return true;
    const ah = knownLineHash(left), bh = knownLineHash(right);
    return ah !== undefined && bh !== undefined && ah !== bh;
}
function* commonLines(a: Index, b: Index, region: Region, reverse: boolean, stats: Stats, firstChecked = false): Generator<void, number> {
    let count = 0;
    const maximum = Math.min(region.a1 - region.a0, region.b1 - region.b0);
    if (maximum && !firstChecked) {
        // Cached inequality proves zero common rows before any structural span work.
        // Equal hashes and missing metadata retain the exact span/row checks below.
        const unequal = knownUnequal(a, b, reverse ? region.a1 - 1 : region.a0, reverse ? region.b1 - 1 : region.b0);
        if (tick(stats)) yield;
        if (unequal) { stats.lineComparisons++; return 0; }
    }
    while (count < maximum) {
        if (count % 64 === 0) {
            const proved = yield* matchingLines(a, b, reverse ? region.a0 : region.a0 + count, reverse ? region.a1 - count : region.a1,
                reverse ? region.b0 : region.b0 + count, reverse ? region.b1 - count : region.b1, reverse, stats);
            if (proved) { count += proved; continue; }
        }
        const ai = reverse ? region.a1 - count - 1 : region.a0 + count, bi = reverse ? region.b1 - count - 1 : region.b0 + count;
        if (!(yield* equalLine(a, b, ai, bi, stats, false))) break; count++;
        // Failed frontier probes have no equal run to extend. Look up retained ranges
        // only after the first exact match, before any repeated-row text scan.
        if (count < maximum && stats.equalities?.hasProofs) {
            const cached = stats.equalities.match(reverse ? region.a1 - count : region.a0 + count, reverse ? region.b1 - count : region.b0 + count, maximum - count, reverse, stats);
            if (tick(stats, 0)) yield;
            if (cached) { count += cached; continue; }
        }
        // Repeated rows can align at different backing offsets. Verify their remaining
        // text in bounded native string comparisons instead of materializing every row.
        const token = a.lines.at(ai)?.token; let repeated = false;
        for (let distance = 1; token !== undefined && distance <= 4 && count - 1 + distance < maximum; distance++) {
            const nextA = ai + (reverse ? -distance : distance), nextB = bi + (reverse ? -distance : distance);
            if (token === a.lines.at(nextA)?.token && token === b.lines.at(nextB)?.token) { repeated = true; break; }
        }
        if (repeated) {
            count += yield* matchingLines(a, b, reverse ? region.a0 : region.a0 + count, reverse ? region.a1 - count : region.a1,
                reverse ? region.b0 : region.b0 + count, reverse ? region.b1 - count : region.b1, reverse, stats, true);
        } else {
            // A metadata leaf can end between ownership checkpoints, especially in reverse.
            // Stop at the pending checkpoint, including one just reached by equalLine.
            // An empty run lets the next loop retry the shared-source proof immediately.
            const end = Math.min(maximum, Math.ceil(count / 64) * 64);
            const known = a.lines.matching(b.lines, reverse ? region.a1 - end : region.a0 + count, reverse ? region.a1 - count : region.a0 + end,
                reverse ? region.b1 - end : region.b0 + count, reverse ? region.b1 - count : region.b0 + end, reverse, stats.identities.known);
            count += known; stats.lineComparisons += known; if (tick(stats, known)) yield;
        }
    }
    if (count >= minimumEqualRows && stats.equalities) yield* stats.equalities.remember(reverse ? region.a1 - count : region.a0, reverse ? region.b1 - count : region.b0, count, stats);
    return count;
}
function* disjoint(left: Index, right: Index, region: Region, stats: Stats): Generator<void, boolean> {
    // A cheap exact match can decline this optional scan without indexing a huge shared interior.
    for (let offset = 1; offset < Math.min(4, region.a1 - region.a0, region.b1 - region.b0); offset++)
        if (yield* equalLine(left, right, region.a0 + offset, region.b0 + offset, stats)) return false;
    const signatures = new Set<number>();
    for (let ai = region.a0; ai < region.a1; ai++) { signatures.add(yield* lineHash(left, ai, yield* getLine(left, ai, stats), stats)); if (tick(stats)) yield; }
    for (let bi = region.b0; bi < region.b1; bi++) { if (signatures.has(yield* lineHash(right, bi, yield* getLine(right, bi, stats), stats))) return false; if (tick(stats)) yield; }
    return true;
}
/** If the shared alphabet has at most one exact short-line token, greedy matching is
 * a longest common subsequence: its length is the smaller occurrence count. This
 * avoids an edit-distance frontier proportional to a large insertion/deletion delta. */
function* singleTokenAlignment(left: Index, right: Index, region: Region, stats: Stats): Generator<void, readonly Region[] | undefined> {
    const tokens = new Set<string>();
    for (let ai = region.a0; ai < region.a1; ai++) {
        const token = (yield* getLine(left, ai, stats)).token;
        if (token === undefined) return; tokens.add(token);
        if (tokens.size > 64) return; // Optional exact shortcut; retain general alignment otherwise.
        if (tick(stats)) yield;
    }
    let common: string | undefined;
    for (let bi = region.b0; bi < region.b1; bi++) {
        const token = (yield* getLine(right, bi, stats)).token;
        if (token === undefined) return;
        stats.lineComparisons++;
        if (tokens.has(token)) { if (common !== undefined && common !== token) return; common = token; }
        if (tick(stats)) yield;
    }
    if (common === undefined) return [region];
    const changes: Region[] = []; let a0 = region.a0, b0 = region.b0, ai = a0, bi = b0;
    while (ai < region.a1 && bi < region.b1) {
        while (ai < region.a1 && (yield* getLine(left, ai, stats)).token !== common) { ai++; if (tick(stats)) yield; }
        while (bi < region.b1 && (yield* getLine(right, bi, stats)).token !== common) { bi++; if (tick(stats)) yield; }
        if (ai === region.a1 || bi === region.b1) break;
        if (a0 < ai || b0 < bi) changes.push({ a0, a1: ai, b0, b1: bi });
        const count = yield* commonLines(left, right, { a0: ai, a1: region.a1, b0: bi, b1: region.b1 }, false, stats);
        ai += count; bi += count; a0 = ai; b0 = bi;
    }
    if (a0 < region.a1 || b0 < region.b1) changes.push({ a0, a1: region.a1, b0, b1: region.b1 });
    return changes;
}
/** Matching every common occurrence fixes its pairing, even when tokens repeat.
 * The caller supplies the complete left alphabet and bounds both region sizes. */
function* completeCommonAlignment(left: Index, right: Index, region: Region, rows: ReadonlyMap<string, number>, stats: Stats, facts?: CommonFacts): Generator<void, readonly Region[] | undefined> {
    const runs = facts?.optional?.records, tokens = runs ? undefined : new Set<string>();
    const rightTokens = runs ?? tokens!;
    let previous: string | undefined;
    for (let bi = region.b0; bi < region.b1; bi++) {
        const token = (yield* getLine(right, bi, stats)).token;
        if (token === undefined) return;
        if (runs) {
            let record = runs.get(token);
            if (!record) {
                const reference = rows.get(token);
                record = {from: bi - region.b0, to: bi - region.b0, blocks: 0, count: reference === undefined ? 0 : reference < 0 ? -reference : 1};
                runs.set(token, record); if (tick(stats, token.length + 4)) yield;
            }
            if (previous !== token) record.blocks++;
            record.to = bi - region.b0 + 1; previous = token;
            if (facts?.optional?.omission?.replacement) { record.occurrences = (record.occurrences ?? 0) + 1; if (tick(stats, 2)) yield; }
        } else tokens!.add(token);
        // Sum comparison lengths for the captured edit without rereading row tokens.
        if (facts?.optional?.omission) {
            const bound = facts.optional.omission, cost = Math.max(token.length, facts.maximum);
            bound.comparison += cost; bound.maximum = Math.max(bound.maximum, cost);
            if (tick(stats, 2)) yield;
        }
        if (tick(stats, token.length + (runs ? 8 : 4))) yield;
    }
    const replacement = facts?.optional?.omission?.replacement;
    if (replacement) for (const record of runs!.values()) {
        replacement.required += record.count;
        replacement.missing += Math.max(0, record.count - record.occurrences!);
        if (tick(stats, 6)) yield;
    }
    if (facts) { facts.working = rightTokens; if (facts.optional) facts.optional.complete = true; if (tick(stats, facts.optional ? 2 : 1)) yield; }
    const changes: Region[] = []; let a0 = region.a0, b0 = region.b0, ai = a0, bi = b0;
    for (;;) {
        let leftToken: string | undefined, rightToken: string | undefined;
        while (ai < region.a1) {
            const token = (yield* getLine(left, ai, stats)).token;
            if (token === undefined) return;
            if (tick(stats, token.length + 4)) yield;
            if (rightTokens.has(token)) { leftToken = token; break; }
            ai++;
        }
        while (bi < region.b1) {
            const token = (yield* getLine(right, bi, stats)).token;
            if (token === undefined) return;
            if (tick(stats, token.length + 4)) yield;
            if (rows.has(token)) { rightToken = token; break; }
            bi++;
        }
        if (ai === region.a1 || bi === region.b1) {
            if (ai !== region.a1 || bi !== region.b1) return;
            break;
        }
        stats.lineComparisons++;
        if (tick(stats, Math.max(leftToken!.length, rightToken!.length) + 4)) yield;
        if (leftToken !== rightToken) return;
        if (a0 < ai || b0 < bi) changes.push({ a0, a1: ai, b0, b1: bi });
        a0 = ++ai; b0 = ++bi; if (tick(stats, 4)) yield;
    }
    if (a0 < region.a1 || b0 < region.b1) changes.push({ a0, a1: region.a1, b0, b1: region.b1 });
    return changes;
}
/** Unique common tokens establish a complete ordered match directly. Duplicates require
 * matching both complete common sequences; unknown or crossed matches retain the frontier. */
function* orderedCommonAlignment(left: Index, right: Index, region: Region, stats: Stats, facts?: CommonFacts): Generator<void, readonly Region[] | undefined> {
    if (Math.max(region.a1 - region.a0, region.b1 - region.b0) > 65536) return;
    const rows = new Map<string, number>();
    for (let ai = region.a0; ai < region.a1; ai++) {
        const token = (yield* getLine(left, ai, stats)).token;
        if (token === undefined) return;
        // Negative values mark repeated tokens; eligible roots also retain their counts.
        const previous = rows.get(token);
        rows.set(token, previous === undefined ? ai : facts?.optional ? previous < 0 ? previous - 1 : -2 : -1);
        if (facts) { facts.maximum = Math.max(facts.maximum, token.length); if (tick(stats, facts.optional ? 2 : 1)) yield; }
        if (tick(stats, token.length + 4)) yield;
    }
    const changes: Region[] = []; let a0 = region.a0, b0 = region.b0;
    for (let bi = region.b0; bi < region.b1; bi++) {
        const token = (yield* getLine(right, bi, stats)).token;
        if (token === undefined) return;
        const ai = rows.get(token); stats.lineComparisons++;
        if (tick(stats, token.length + 4)) yield;
        if (ai === undefined) continue;
        if (ai < 0) return yield* completeCommonAlignment(left, right, region, rows, stats, facts);
        if (ai < a0) return; // Repeated working tokens or crossed unique pairs.
        if (a0 < ai || b0 < bi) changes.push({ a0, a1: ai, b0, b1: bi });
        a0 = ai + 1; b0 = bi + 1;
        if (tick(stats, 4)) yield;
    }
    if (a0 < region.a1 || b0 < region.b1) changes.push({ a0, a1: region.a1, b0, b1: region.b1 });
    return changes;
}
type OptionalRecord = {from: number; to: number; blocks: number; count: number; occurrences?: number};
type ReplacementFacts = {required: number; missing: number; lower: number};
type CommonFacts = { working?: Alphabet; maximum: number; optional?: {records: Map<string, OptionalRecord>; complete: boolean; omission?: {comparison: number; maximum: number; replacement?: ReplacementFacts}} };
type ChildDistance = { minimum?: number };
/** The complete working alphabet and all short row tokens are already materialized.
 * If every matchable reference row embeds in order, every optimum must match them all.
 * Earliest prefix endpoints and latest suffix starts enumerate all optimum midpoint
 * vertices. Odd/even overlap scan order selects the diagonal, then its furthest x,
 * preserving the ordinary first canonical split without publishing a partial frontier. */
function* requiredReferenceSplit(left: Index, right: Index, region: Region, facts: CommonFacts, stats: Stats, captured: {value?: RootProfiles}, allowOmission = false): Generator<void, readonly [number, number, number] | undefined> {
    const n = region.a1 - region.a0, m = region.b1 - region.b0;
    const flags = new Uint8Array(n), earliest = new Uint32Array(n + 1), latest = new Uint32Array(n + 1), required: string[] = [];
    for (let row = 0; row <= n; row++) if (tick(stats, 3)) yield;
    let at = 0, prefix: number | undefined;
    for (let row = 0; row < n; row++) {
        const token = (yield* getLine(left, region.a0 + row, stats)).token!;
        if (tick(stats, token.length + 4)) yield;
        if (!facts.working!.has(token)) continue;
        flags[row] = 1; required.push(token);
        for (;;) {
            if (at === m) { if (!allowOmission) return; prefix ??= required.length - 1; break; }
            const other = (yield* getLine(right, region.b0 + at, stats)).token!, equal = other === token;
            stats.lineComparisons++; if (tick(stats, Math.max(token.length, other.length) + 4)) yield;
            at++; if (equal) break;
        }
        if (prefix === undefined) { earliest[required.length] = at; if (tick(stats, 3)) yield; }
    }
    let length = required.length, suffix = 0;
    if (!length || allowOmission && prefix === undefined) return;
    at = m; latest[length] = m; if (tick(stats)) yield;
    suffixScan: for (let row = length - 1; row >= 0; row--) {
        for (;;) {
            if (!at) { if (!allowOmission) return; suffix = row + 1; break suffixScan; }
            const token = (yield* getLine(right, region.b0 + at - 1, stats)).token!, wanted = required[row]!, equal = token === wanted;
            stats.lineComparisons++; if (tick(stats, Math.max(token.length, wanted.length) + 4)) yield;
            at--; if (equal) break;
        }
        latest[row] = at; if (tick(stats)) yield;
    }
    const profiles = {region, required, flags, earliest, latest};
    if (prefix !== undefined) {
        // All required rows cannot embed, so one unique omission attains the optimum.
        if (!(yield* omitRequiredRow(right, profiles, prefix, suffix, stats))) return;
        length = required.length;
    }
    if (region.b0) for (let row = 0; row <= length; row++) {
        earliest[row] = earliest[row]! + region.b0; latest[row] = latest[row]! + region.b0;
        if (tick(stats, 2)) yield;
    }
    const point = yield* profileMidpoint(region, profiles, 0, length, stats);
    if (point) { captured.value = profiles; if (tick(stats, 8)) yield; }
    return point;
}

/** A unique omitted ordinal fixes the optimum mask. Repair the same profile pair in place. */
function* omitRequiredRow(right: Index, profiles: RootProfiles & {required: string[]}, prefix: number, suffix: number, stats: Stats): Generator<void, boolean> {
    const {region, required, flags, earliest, latest} = profiles;
    const n = region.a1 - region.a0;
    // Prefixes through prefix and suffixes from suffix are complete and exact.
    let omitted = -1;
    for (let row = Math.max(0, suffix - 1); row <= Math.min(prefix, required.length - 1); row++) {
        if (earliest[row]! <= latest[row + 1]!) { if (omitted >= 0) return false; omitted = row; }
        if (tick(stats, 4)) yield;
    }
    if (omitted < 0 || latest[omitted + 1]! - earliest[omitted]! > frontierLimits.changedRows) return false;
    let ordinal = 0;
    for (let row = 0; row < n; row++) {
        if (flags[row] === 1 && ordinal++ === omitted) { flags[row] = 0; break; }
        if (tick(stats, 2)) yield;
    }
    // Keep one profile pair: shift the known suffix and repair only the changed sides.
    const oldLength = required.length;
    for (let row = omitted; row < oldLength - 1; row++) { required[row] = required[row + 1]!; if (tick(stats)) yield; }
    required.pop();
    for (let row = omitted; row < oldLength; row++) { latest[row] = latest[row + 1]!; if (tick(stats)) yield; }
    return yield* completeRequiredProfiles(right, profiles, omitted, omitted, stats);
}

/** Recompute only the changed sides of one shared profile pair. */
function* completeRequiredProfiles(right: Index, profiles: RootProfiles & {required: string[]}, prefix: number, suffix: number, stats: Stats): Generator<void, boolean> {
    const {region, required, earliest, latest} = profiles, m = region.b1 - region.b0;
    let at = earliest[prefix]!;
    for (let row = prefix; row < required.length; row++) {
        const wanted = required[row]!;
        for (;;) {
            if (at === m) throw new Error("Unique omission prefix does not embed.");
            const token = (yield* getLine(right, region.b0 + at, stats)).token!, equal = token === wanted;
            stats.lineComparisons++; if (tick(stats, Math.max(token.length, wanted.length) + 4)) yield;
            at++; if (equal) break;
        }
        earliest[row + 1] = at; if (tick(stats)) yield;
    }
    at = latest[suffix]!;
    for (let row = suffix - 1; row >= 0; row--) {
        const wanted = required[row]!;
        for (;;) {
            if (!at) throw new Error("Unique omission suffix does not embed.");
            const token = (yield* getLine(right, region.b0 + at - 1, stats)).token!, equal = token === wanted;
            stats.lineComparisons++; if (tick(stats, Math.max(token.length, wanted.length) + 4)) yield;
            at--; if (equal) break;
        }
        latest[row] = at; if (tick(stats)) yield;
    }
    return true;
}

/** With at most one omission impossible, exactly two omittable ordinals force the optimum mask. */
function* twoOmissionSplit(left: Index, right: Index, region: Region, working: Alphabet, stats: Stats, captured: {value?: RootProfiles}): Generator<void, readonly [number, number, number] | undefined> {
    const n = region.a1 - region.a0, m = region.b1 - region.b0;
    const flags = new Uint8Array(n), earliest = new Uint32Array(n + 1), latest = new Uint32Array(n + 1), required: string[] = [];
    for (let row = 0; row <= n; row++) if (tick(stats, 3)) yield;
    for (let row = 0; row < n; row++) {
        const token = (yield* getLine(left, region.a0 + row, stats)).token!;
        if (working.has(token)) { flags[row] = 1; required.push(token); }
        if (tick(stats, token.length + 4)) yield;
    }
    let zero = 0, one = 0;
    for (let row = 0; row < required.length; row++) {
        const wanted = required[row]!, cap = zero;
        for (;;) {
            if (zero >= m) { zero = m + 1; break; }
            const token = (yield* getLine(right, region.b0 + zero, stats)).token!, equal = token === wanted;
            stats.lineComparisons++; if (tick(stats, Math.max(token.length, wanted.length) + 4)) yield;
            zero++; if (equal) break;
        }
        for (;;) {
            if (one >= Math.min(m, cap)) { one = cap; break; }
            const token = (yield* getLine(right, region.b0 + one, stats)).token!, equal = token === wanted;
            stats.lineComparisons++; if (tick(stats, Math.max(token.length, wanted.length) + 4)) yield;
            one++; if (equal) break;
        }
        earliest[row + 1] = zero; latest[row + 1] = one; if (tick(stats, 4)) yield;
    }
    if (one <= m) return;
    // Consume each one-omission prefix before replacing it with the ordinary suffix.
    zero = one = m; latest[required.length] = m;
    let ordinal = required.length, first = -1, last = -1;
    for (let row = n - 1; row >= 0; row--) {
        if (tick(stats)) yield;
        if (flags[row] !== 1) continue;
        const index = --ordinal, wanted = required[index]!, cap = zero;
        if (earliest[index]! <= one || latest[index]! <= zero) {
            if (last < 0) last = index;
            else if (first < 0) first = index;
            else return;
            flags[row] = 0; if (tick(stats, 2)) yield;
        }
        for (;;) {
            if (zero <= 0) { zero = -1; break; }
            const token = (yield* getLine(right, region.b0 + zero - 1, stats)).token!, equal = token === wanted;
            stats.lineComparisons++; if (tick(stats, Math.max(token.length, wanted.length) + 4)) yield;
            zero--; if (equal) break;
        }
        for (;;) {
            if (one <= Math.max(0, cap)) { one = cap; break; }
            const token = (yield* getLine(right, region.b0 + one - 1, stats)).token!, equal = token === wanted;
            stats.lineComparisons++; if (tick(stats, Math.max(token.length, wanted.length) + 4)) yield;
            one--; if (equal) break;
        }
        latest[index] = zero < 0 ? m + 1 : zero; if (tick(stats, 5)) yield;
    }
    if (first < 0 || earliest[first]! > m || latest[last + 1]! > m
        || latest[last + 1]! - earliest[first]! > frontierLimits.changedRows) return;
    const oldLength = required.length;
    for (let row = first; row < last - 1; row++) { required[row] = required[row + 1]!; if (tick(stats)) yield; }
    for (let row = last - 1; row < oldLength - 2; row++) { required[row] = required[row + 2]!; if (tick(stats)) yield; }
    for (let row = last - 1; row < oldLength - 1; row++) { latest[row] = latest[row + 2]!; if (tick(stats)) yield; }
    required.length = oldLength - 2;
    const profiles = {region, required, flags, earliest, latest};
    yield* completeRequiredProfiles(right, profiles, first, last - 1, stats);
    if (region.b0) for (let row = 0; row <= required.length; row++) { earliest[row] = earliest[row]! + region.b0; latest[row] = latest[row]! + region.b0; if (tick(stats, 2)) yield; }
    const point = yield* profileMidpoint(region, profiles, 0, required.length, stats);
    if (point) { captured.value = profiles; if (tick(stats, 8)) yield; }
    return point;
}

/** One mutable profile pair belongs to an active subtree, indexed by its required-token ordinal. */
type RootProfiles = Readonly<{region: Region; required: readonly string[]; flags: Uint8Array; earliest: Uint32Array; latest: Uint32Array}>;
type ProfileTask = Readonly<{profiles: RootProfiles; from: number; to: number; direction: "earliest" | "latest"; boundary?: number | undefined}>;
type Task = Region & {profile?: ProfileTask; distance?: number};
/** Forced reference rows enumerate every optimal midpoint; overlap order chooses the canonical one. */
function* profileMidpoint(region: Region, profiles: RootProfiles, from: number, to: number, stats: Stats): Generator<void, readonly [number, number, number] | undefined> {
    const {earliest, latest, flags} = profiles, minimum = region.a1 - region.a0 + region.b1 - region.b0 - 2 * (to - from);
    const wave = Math.ceil(minimum / 2); let matched = from, bestX = -1, bestY = -1, diagonal: number | undefined;
    for (let x = region.a0; x <= region.a1; x++) {
        if (x > region.a0) matched += flags[x - profiles.region.a0 - 1]!;
        const y = region.b0 + wave - (x - region.a0) + 2 * (matched - from), k = (x - region.a0) - (y - region.b0);
        if (y >= earliest[matched]! && y <= latest[matched]!
            && (diagonal === undefined || (minimum % 2 ? k < diagonal : k > diagonal) || k === diagonal && x > bestX)) {
            diagonal = k; bestX = x; bestY = y;
        }
        if (tick(stats, 12)) yield;
    }
    return bestX < 0 ? undefined : [bestX, bestY, minimum];
}
/** A forced-match child inherits one exact profile. Its sibling owns the shared ordinal. */
function* profileSplit(left: Index, right: Index, region: Region, task: ProfileTask, stats: Stats, saved?: readonly [number, number, number]): Generator<void, readonly [number, number, number] | Readonly<{changes: readonly Region[]}>> {
    const n = region.a1 - region.a0, m = region.b1 - region.b0, minimum = n + m - 2 * (task.to - task.from);
    // The exact distance excludes overlap before the existing distance-64 shortcut phase.
    if (!saved && Math.min(n, m) >= 64) {
        const single = yield* singleTokenAlignment(left, right, region, stats);
        if (single) return {changes: single};
        const ordered = yield* orderedCommonAlignment(left, right, region, stats);
        if (ordered) return {changes: ordered};
    }
    const {profiles, from, to} = task, {earliest, latest, required} = profiles;
    if (task.direction === "earliest") {
        if (task.boundary !== undefined) latest[from] = task.boundary;
        let at = region.b0; earliest[from] = at;
        if (tick(stats, 2)) yield;
        for (let row = from; row < to; row++) {
            const wanted = required[row]!;
            for (;;) {
                if (at === region.b1) throw new Error("Required child prefix does not embed.");
                const token = (yield* getLine(right, at, stats)).token!, equal = token === wanted;
                stats.lineComparisons++; if (tick(stats, Math.max(token.length, wanted.length) + 4)) yield;
                at++; if (equal) break;
            }
            earliest[row + 1] = at; if (tick(stats, 3)) yield;
        }
    } else {
        let at = region.b1; latest[to] = at; if (tick(stats)) yield;
        for (let row = to - 1; row >= from; row--) {
            const wanted = required[row]!;
            for (;;) {
                if (at === region.b0) throw new Error("Required child suffix does not embed.");
                const token = (yield* getLine(right, at - 1, stats)).token!, equal = token === wanted;
                stats.lineComparisons++; if (tick(stats, Math.max(token.length, wanted.length) + 4)) yield;
                at--; if (equal) break;
            }
            latest[row] = at; if (tick(stats, 3)) yield;
        }
    }
    if (saved) {
        if (saved[2] !== minimum) throw new Error("Saved split disagrees with required child distance.");
        return saved;
    }
    const point = yield* profileMidpoint(region, profiles, from, to, stats);
    if (!point) throw new Error("Required child profile has no canonical midpoint.");
    return point;
}

/** A short contiguous working run can force one otherwise ambiguous reference occurrence.
 * Two required rows between optional occurrences make matching two of them strictly worse.
 * Accept only one occurrence that embeds with every other matchable reference row.
 * This proves the optimum even without a known distance. Prepared root facts avoid
 * duplicate token scans; children also verify their independently known distance.
 * After one working-row removal, three separators and a unique omitted required row
 * can still force every optimum reference match. Ambiguous omissions decline. */
function* optionalRunSplit(left: Index, right: Index, region: Region, minimum: number | undefined, stats: Stats, captured: {value?: RootProfiles}, prepared?: ReadonlyMap<string, OptionalRecord>, allowOmission = false, replacement?: ReplacementFacts): Generator<void, readonly [number, number, number] | undefined> {
    const n = region.a1 - region.a0, m = region.b1 - region.b0;
    let records = prepared, common = 0;
    if (!records) {
        const scanned = new Map<string, OptionalRecord>();
        let previous: string | undefined;
        for (let row = 0; row < m; row++) {
            const token = (yield* getLine(right, region.b0 + row, stats)).token!;
            let record = scanned.get(token);
            if (!record) { record = {from: row, to: row, blocks: 0, count: 0}; scanned.set(token, record); }
            if (previous !== token) record.blocks++;
            record.to = row + 1; previous = token;
            if (tick(stats, token.length + 8)) yield;
        }
        for (let row = 0; row < n; row++) {
            const token = (yield* getLine(left, region.a0 + row, stats)).token!, record = scanned.get(token);
            if (record) { record.count++; common++; }
            if (tick(stats, token.length + 6)) yield;
        }
        records = scanned;
    }
    // All optimal matches except one must be the other matchable reference rows.
    const target = minimum === undefined ? undefined : common - (n + m - minimum) / 2 + 1;
    if (target !== undefined && target <= 1) return;
    let optional: string | undefined, from = 0, to = 0;
    for (const [token, record] of records) {
        if (record.blocks === 1 && record.count > 1 && (target === undefined || record.count === target) && record.to - record.from <= frontierLimits.changedRows) {
            if (optional !== undefined) return;
            optional = token; from = record.from; to = record.to;
        }
        if (tick(stats, 8)) yield;
    }
    if (optional === undefined) {
        // Complete occurrence counts can reject a required-only replacement before allocation.
        if (replacement) {
            if (tick(stats, 8)) yield;
            if (n + m - 2 * (replacement.required - replacement.missing) < replacement.lower) return;
            if (replacement.missing === 2) return yield* twoOmissionSplit(left, right, region, records, stats, captured);
            if (replacement.missing !== 1) return;
        }
        if (allowOmission) return yield* requiredReferenceSplit(left, right, region, {working: records, maximum: 0}, stats, captured, true);
        return;
    }
    const flags = new Uint8Array(n), earliest = new Uint32Array(n + 1), latest = new Uint32Array(n + 1), required: string[] = [];
    for (let row = 0; row <= n; row++) if (tick(stats, 3)) yield;
    let gap = 2, minimumGap = n, seenOptional = false;
    for (let row = 0; row < n; row++) {
        const token = (yield* getLine(left, region.a0 + row, stats)).token!;
        if (token === optional) {
            if (gap < 2) return;
            if (allowOmission) { if (seenOptional) minimumGap = Math.min(minimumGap, gap); seenOptional = true; if (tick(stats, 2)) yield; }
            flags[row] = 2; gap = 0;
        }
        else if (records.has(token)) { flags[row] = 1; required.push(token); gap++; }
        if (tick(stats, token.length + 6)) yield;
    }
    if (minimum !== undefined && n + m - 2 * (required.length + 1) !== minimum) return;
    let at = 0, prefix = 0, suffix = required.length;
    prefixScan: for (let row = 0; row < required.length; row++) {
        const wanted = required[row]!;
        for (;;) {
            if (at === m) { if (!allowOmission) return; break prefixScan; }
            const token = (yield* getLine(right, region.b0 + at, stats)).token!, equal = token === wanted;
            stats.lineComparisons++; if (tick(stats, Math.max(token.length, wanted.length) + 4)) yield;
            at++; if (equal) break;
        }
        earliest[row + 1] = at; prefix = row + 1; if (tick(stats)) yield;
    }
    at = m; latest[required.length] = m;
    suffixScan: for (let row = required.length - 1; row >= 0; row--) {
        const wanted = required[row]!;
        for (;;) {
            if (!at) { if (!allowOmission) return; break suffixScan; }
            const token = (yield* getLine(right, region.b0 + at - 1, stats)).token!, equal = token === wanted;
            stats.lineComparisons++; if (tick(stats, Math.max(token.length, wanted.length) + 4)) yield;
            at--; if (equal) break;
        }
        latest[row] = at; suffix = row; if (tick(stats)) yield;
    }
    if (prefix < required.length) {
        // q optional matches lose at least 3(q-1) required rows. Once all required
        // rows cannot embed, a witness with one omission and one optional match is
        // strictly better than q=0 or q>=2. Its omitted reference row must be unique.
        if (minimumGap < 3) return;
        if (!(yield* omitRequiredRow(right, {region, required, flags, earliest, latest}, prefix, suffix, stats))) return;
    }
    let chosen = -1, ordinal = 0, selectedOrdinal = 0;
    for (let row = 0; row < n; row++) {
        if (flags[row] === 1) ordinal++;
        else if (flags[row] === 2) {
            flags[row] = 0;
            if (earliest[ordinal]! <= from && latest[ordinal]! >= to) {
                if (chosen >= 0) return;
                chosen = row; selectedOrdinal = ordinal;
            }
        }
        if (tick(stats, 3)) yield;
    }
    if (chosen < 0) return;
    flags[chosen] = 1;
    // Insert the forced occurrence into the same profile pair. Only its opposite
    // prefix/suffix need recomputation; no second pair is allocated.
    const oldLength = required.length;
    required.push(optional);
    for (let row = oldLength; row > selectedOrdinal; row--) { required[row] = required[row - 1]!; if (tick(stats)) yield; }
    required[selectedOrdinal] = optional;
    for (let row = oldLength; row >= selectedOrdinal; row--) { latest[row + 1] = latest[row]!; if (tick(stats)) yield; }
    earliest[selectedOrdinal + 1] = at = from + 1;
    for (let row = selectedOrdinal + 1; row < required.length; row++) {
        const wanted = required[row]!;
        for (;;) {
            if (at === m) return;
            const token = (yield* getLine(right, region.b0 + at, stats)).token!, equal = token === wanted;
            stats.lineComparisons++; if (tick(stats, Math.max(token.length, wanted.length) + 4)) yield;
            at++; if (equal) break;
        }
        earliest[row + 1] = at; if (tick(stats)) yield;
    }
    latest[selectedOrdinal] = at = to - 1;
    for (let row = selectedOrdinal - 1; row >= 0; row--) {
        const wanted = required[row]!;
        for (;;) {
            if (!at) return;
            const token = (yield* getLine(right, region.b0 + at - 1, stats)).token!, equal = token === wanted;
            stats.lineComparisons++; if (tick(stats, Math.max(token.length, wanted.length) + 4)) yield;
            at--; if (equal) break;
        }
        latest[row] = at; if (tick(stats)) yield;
    }
    if (region.b0) for (let row = 0; row <= required.length; row++) { earliest[row] = earliest[row]! + region.b0; latest[row] = latest[row]! + region.b0; if (tick(stats, 2)) yield; }
    const profiles = {region, required, flags, earliest, latest};
    const point = yield* profileMidpoint(region, profiles, 0, required.length, stats);
    if (point) { captured.value = profiles; if (tick(stats, 8)) yield; }
    return point;
}

/** Limit optional speculation to a captured edit window containing a reference match. */
function* changedReferenceMatch(right: Index, seed: RecursiveSeed, alphabet: Alphabet | undefined, stats: Stats): Generator<void, boolean> {
    if (!alphabet) return false;
    for (let row = seed.from; row < seed.end; row++) {
        const token = (yield* getLine(right, row, stats)).token;
        if (tick(stats, (token?.length ?? 0) + 4)) yield;
        if (token !== undefined && alphabet.has(token)) return true;
    }
    return false;
}
type SplitBudget = { remaining: number; certified: boolean; matching?: boolean };
function* bisect(a: Index, b: Index, region: Region, stats: Stats, capture?: FrontierCapture, seed?: RecursiveSeed, certificateBudget?: SplitBudget, rootAlphabet?: Alphabet, childProfile?: {value?: RootProfiles}, exactDistance?: number): Generator<void, readonly [number, number, number] | Readonly<{ changes: readonly Region[] }>> {
    const n = region.a1 - region.a0, m = region.b1 - region.b0, maximum = Math.ceil((n + m) / 2), delta = n - m;
    let radius = 0, origin = 1, forward = new Int32Array(3).fill(-1), reverse = new Int32Array(3).fill(-1);
    if (tick(stats, 6)) yield;
    forward[origin + 1] = 0; reverse[origin + 1] = 0;
    let resumeDistance = 0, resumeForward = 0, resumeReverse = 0, together = 0, seenF = 0, seenR = 0, sparseThroughF = -1, sparseThroughR = -1;
    const points: FrontierPoint[] = [], bounds: ChildDistance = exactDistance === undefined ? {} : {minimum: exactDistance};
    const root = capture?.previous && rootAlphabet && capture.previous.minimum !== undefined
        && b.lines.size === capture.previous.working.lines.size + 1 && !capture.previous.points.some(point => point.sparse)
        ? capture.previous : undefined;
    if (capture || seed) {
        const prior = capture?.previous ?? seed?.frontier;
        const retained = capture ? prior ? yield* retainedFrontier(prior, b, region, stats) : undefined : seed ? yield* retainedRecursive(seed, region, stats, bounds) : undefined;
        if (prior && retained) {
            for (let index = 0; index <= retained.joint; index++) { points.push(prior.points[index]!); if (tick(stats)) yield; }
            const f = prior.points[retained.forward], r = prior.points[retained.reverse];
            resumeForward = f?.distance ?? 0; resumeReverse = r?.distance ?? 0;
            resumeDistance = Math.min(resumeForward, resumeReverse); together = Math.max(resumeForward, resumeReverse);
            seenF = f?.seenF ?? 0; seenR = r?.seenR ?? 0; sparseThroughF = f?.sparse ? resumeForward : -1; sparseThroughR = r?.sparse ? resumeReverse : -1;
            radius = Math.max(f?.radius ?? 0, r?.radius ?? 0); origin = radius + 1;
            forward = new Int32Array(radius * 2 + 3); reverse = new Int32Array(forward.length);
            for (let index = 0; index < forward.length; index++) {
                forward[index] = f ? f.forward[index - origin + f.origin] ?? -1 : index === origin + 1 ? 0 : -1;
                reverse[index] = r ? r.reverse[index - origin + r.origin] ?? -1 : index === origin + 1 ? 0 : -1;
                if (tick(stats, 2)) yield;
            }
        }
        if (capture) capture.plan = { working: b, region, points };
    }
    let preparedRoot: {facts: CommonFacts; lower: number} | undefined;
    const start = (vector: Int32Array, diagonal: number): number => {
        const index = origin + diagonal, insert = vector[index + 1]!, remove = vector[index - 1]! < 0 ? -1 : vector[index - 1]! + 1;
        if (capture) {
            const extent = Math.max(0, insert >= 0 && insert <= n ? insert - diagonal : 0, remove >= 0 && remove <= n ? remove - diagonal : 0);
            if (vector === forward) seenF = Math.max(seenF, extent); else seenR = Math.max(seenR, extent);
        }
        const valid = (x: number) => x >= 0 && x <= n && x - diagonal >= 0 && x - diagonal <= m;
        return Math.max(valid(insert) ? insert : -1, valid(remove) ? remove : -1);
    };
    for (let distance = resumeDistance; distance <= maximum; distance++) {
        // Retain only complete, synchronized waves under the shared cap.
        if (capture && distance >= together && distance >= frontierLimits.firstDistance && distance <= frontierLimits.lastDistance
            && ((distance & (distance - 1)) === 0 || distance % frontierLimits.checkpointStride === 0) && (points.at(-1)?.distance ?? -1) < distance) {
            const previous = points.at(-1)?.distance ?? 0;
            if ((previous & (previous - 1)) !== 0) { points.pop(); if (tick(stats)) yield; }
            const [f, r] = yield* copyFrontier(forward, reverse, stats);
            points.push(Object.freeze({ distance, radius, origin, forward: f, reverse: r, seenF, seenR, sparse: distance === sparseThroughF || distance === sparseThroughR }));
            let bytes = points.reduce((total, point) => total + point.forward.byteLength + point.reverse.byteLength, 0);
            while (bytes + splitBytes > decisionLimits.bytes) { const removed = points.shift()!; bytes -= removed.forward.byteLength + removed.reverse.byteLength; }
            if (tick(stats, points.length)) yield;
        }
        // Preserve cheap small-edit searches and ownership proofs. Only after a bounded
        // frontier effort, try exact alphabet proofs before expanding further.
        // An old failed alphabet shortcut depends on the whole region; recheck it after an edit.
        if ((distance === 64 || distance === resumeDistance && resumeDistance > 64) && Math.min(n, m) >= 64) {
            const changes = yield* singleTokenAlignment(a, b, region, stats);
            if (changes) return { changes };
            // Removals and replacements can lose a reference match. Inspect the captured
            // old row; child speculation keeps its existing insertion guard.
            let omission = false, replacement = false;
            if (capture && seed && rootAlphabet && seed.end === seed.from && seed.to === seed.from + 1) {
                const token = (yield* getLine(seed.frontier.working, seed.from, stats)).token;
                omission = token !== undefined && rootAlphabet.has(token);
                if (tick(stats, (token?.length ?? 0) + 4)) yield;
            }
            // Joining one matchable and one unmatched row can remove one required occurrence.
            if (capture && seed && rootAlphabet && seed.to === seed.from + 2 && seed.end === seed.from + 1) {
                const token = (yield* getLine(b, seed.from, stats)).token;
                if (tick(stats, (token?.length ?? 0) + 4)) yield;
                if (token !== undefined && !rootAlphabet.has(token)) {
                    let matches = 0, complete = true;
                    for (let row = seed.from; row < seed.to; row++) {
                        const old = (yield* getLine(seed.frontier.working, row, stats)).token;
                        complete &&= old !== undefined;
                        if (old !== undefined && rootAlphabet.has(old)) matches++;
                        if (tick(stats, (old?.length ?? 0) + 4)) yield;
                    }
                    omission = complete && matches === 1;
                }
            }
            if (capture && seed && rootAlphabet && seed.to === seed.from + 1 && seed.end === seed.to) {
                const old = (yield* getLine(seed.frontier.working, seed.from, stats)).token;
                const current = (yield* getLine(b, seed.from, stats)).token;
                replacement = old !== undefined && current !== undefined && rootAlphabet.has(old) !== rootAlphabet.has(current);
                if (tick(stats, (old?.length ?? 0) + (current?.length ?? 0) + 8)) yield;
            }
            const rootLower = capture && seed && rootAlphabet && (omission || replacement || (yield* changedReferenceMatch(b, seed, rootAlphabet, stats)))
                ? yield* recursiveDistance(seed, region, stats) : undefined;
            // No certificate can fit after the last retained wave if the lower bound ends there.
            const optionalRoot = rootLower !== undefined && Math.ceil(rootLower / 2) > frontierLimits.lastDistance;
            const facts: CommonFacts | undefined = root || optionalRoot || certificateBudget && certificateBudget.remaining > 0
                ? {maximum: 0, ...(optionalRoot ? {optional: {records: new Map(), complete: false, ...(omission || replacement ? {omission: {comparison: 0, maximum: 0, ...(replacement ? {replacement: {required: 0, missing: 0, lower: rootLower!}} : {})}} : {})}} : {})} : undefined;
            const ordered = yield* orderedCommonAlignment(a, b, region, stats, facts);
            if (ordered) { if (capture) capture.ordered = true; return { changes: ordered }; }
            if (facts?.working && root && capture && rootAlphabet) {
                const prepared = yield* projectionSource(root, b, region, rootAlphabet, stats);
                if (prepared) {
                    const stop = Math.ceil((root.minimum! + 1) / 2);
                    const cells = (start: number) => start >= stop ? 0 : (stop * (stop + 1) - start * (start + 1)) / 2;
                    const remaining = cells(Math.max(distance, resumeForward)) + cells(Math.max(distance, resumeReverse));
                    const cost = offsetAt(a, region.a1) - offsetAt(a, region.a0) + 2 * (offsetAt(b, region.b1) - offsetAt(b, region.b0))
                        + 2 * m * facts.maximum + 8 * m + 23 * n + 16
                        + root.points.reduce((total, point) => total + 2 * point.forward.length + 32 * point.distance + 8, 16)
                        + offsetAt(a, region.a1) - offsetAt(a, region.a0) + 4 * n + (region.b0 ? 2 * (n + 1) : 0) + 8;
                    if (tick(stats, 24 + root.points.length)) yield;
                    if (cost <= remaining) {
                        const limit = stats.work + cost;
                        const probe = (function* (): Generator<void, {split: readonly [number, number, number]; plan: FrontierPlan; profile: RootProfiles} | undefined> {
                            // The known optimum rejects impossible forced matches before the greedy scan.
                            let required = 0;
                            for (let row = region.a0; row < region.a1; row++) {
                                const token = (yield* getLine(a, row, stats)).token!;
                                if (facts.working!.has(token)) required++;
                                if (tick(stats, token.length + 4)) yield;
                            }
                            if (n + m - 2 * required !== root.minimum! + 1) return;
                            const captured: {value?: RootProfiles} = {};
                            const split = yield* requiredReferenceSplit(a, b, region, facts, stats, captured);
                            if (!split) return;
                            if (split[2] !== root.minimum! + 1) throw new Error("Root certificate distance disagrees with the zero-match projection.");
                            const plan = yield* projectFrontier(prepared, stats);
                            return {split, plan, profile: captured.value!};
                        })();
                        try {
                            for (;;) {
                                const step = probe.next();
                                if (stats.work > limit) { break; }
                                if (step.done) {
                                    if (step.value) { capture.plan = step.value.plan; capture.certified = true; capture.profile = step.value.profile; return step.value.split; }
                                    break;
                                }
                                yield;
                            }
                        } finally { probe.return(undefined); }
                    }
                }
            }
            if (optionalRoot && facts?.optional?.complete) preparedRoot = {facts, lower: rootLower!};
            if (facts?.working && certificateBudget && certificateBudget.remaining > 0 && seed) {
                const lower = bounds.minimum ?? (yield* recursiveDistance(seed, region, stats)), stop = Math.ceil(lower / 2);
                // Every wave before stop must complete, visiting d+1 cells per active direction.
                const cells = (start: number) => start >= stop ? 0 : (stop * (stop + 1) - start * (start + 1)) / 2;
                const remaining = cells(Math.max(distance, resumeForward)) + cells(Math.max(distance, resumeReverse));
                // Bound token filtering, both greedy scans, numeric initialization and vertices.
                const cost = offsetAt(a, region.a1) - offsetAt(a, region.a0) + 2 * (offsetAt(b, region.b1) - offsetAt(b, region.b0))
                    + 2 * m * facts.maximum + 8 * m + 23 * n + 16 + (region.b0 ? 2 * (n + 1) : 0) + 8;
                if (tick(stats, 24)) yield;
                if (cost <= remaining) {
                    const captured: {value?: RootProfiles} = {};
                    const before = stats.work, limit = before + Math.min(cost, certificateBudget.remaining), probe = requiredReferenceSplit(a, b, region, facts, stats, captured);
                    try {
                        for (;;) {
                            const step = probe.next();
                            if (stats.work > limit) { break; }
                            if (step.done) { if (step.value) { certificateBudget.certified = true; if (childProfile) childProfile.value = captured.value!; return step.value; } break; }
                            yield;
                        }
                    } finally { certificateBudget.remaining = Math.max(0, certificateBudget.remaining - (stats.work - before)); probe.return(undefined); }
                }
                if (exactDistance !== undefined && childProfile && certificateBudget.remaining > 0) {
                    const optionalCost = 2 * (offsetAt(a, region.a1) - offsetAt(a, region.a0)) + 3 * (offsetAt(b, region.b1) - offsetAt(b, region.b0))
                        + (3 * m + 512) * facts.maximum + 34 * n + 28 * m + 1032;
                    if (tick(stats, 24)) yield;
                    // If 2*d + abs(delta) < D, reaching a boundary would finish in fewer
                    // than D edits. Every cell is therefore live/interior and pays both ticks.
                    const interior = (exactDistance - Math.abs(delta)) / 2;
                    const extra = (start: number) => start >= interior ? 0 : (interior * (interior + 1) - start * (start + 1)) / 2;
                    const mandatory = remaining + extra(Math.max(distance, resumeForward)) + extra(Math.max(distance, resumeReverse));
                    if (tick(stats, 20)) yield;
                    if (optionalCost <= mandatory && (certificateBudget.matching ??= yield* changedReferenceMatch(b, seed, rootAlphabet, stats))) {
                        const captured: {value?: RootProfiles} = {}, before = stats.work, limit = before + Math.min(optionalCost, certificateBudget.remaining);
                        const probe = optionalRunSplit(a, b, region, exactDistance, stats, captured);
                        try {
                            for (;;) {
                                const step = probe.next();
                                if (stats.work > limit) { break; }
                                if (step.done) {
                                    if (step.value) { certificateBudget.certified = true; childProfile.value = captured.value!; return step.value; }
                                    break;
                                }
                                yield;
                            }
                        } finally { certificateBudget.remaining = Math.max(0, certificateBudget.remaining - (stats.work - before)); probe.return(undefined); }
                    }
                }
            }
        }
        // Keep the ordinary current checkpoint sequence intact for later edits and undo.
        // Only complete same-region token facts can avoid the helper's first two scans.
        if (distance === frontierLimits.lastDistance && preparedRoot && capture?.plan?.points.at(-1)?.distance === distance) {
            const {facts, lower} = preparedRoot; preparedRoot = undefined;
            const stop = Math.ceil(lower / 2);
            const cells = (start: number) => start >= stop ? 0 : (stop * (stop + 1) - start * (start + 1)) / 2;
            const remaining = cells(Math.max(distance, resumeForward)) + cells(Math.max(distance, resumeReverse));
            const omission = facts.optional!.omission;
            // A bounded omission gap and optional run add at most 512 repeated row probes.
            let cost = omission ? offsetAt(a, region.a1) - offsetAt(a, region.a0) + 4 * omission.comparison
                + 44 * n + 16 * m + 1024 * omission.maximum + 8 * facts.optional!.records.size + 4096
                : offsetAt(a, region.a1) - offsetAt(a, region.a0) + 2 * (offsetAt(b, region.b1) - offsetAt(b, region.b0))
                    + (3 * m + 512) * facts.maximum + 28 * n + 20 * m + 1032;
            if (omission?.replacement?.missing === 2) {
                // Four capped scans plus in-place repair of a bounded outer gap.
                cost = Math.max(cost, offsetAt(a, region.a1) - offsetAt(a, region.a0) + 5 * omission.comparison
                    + 20 * n + 14 * omission.replacement.required + 20 * m + 256 * omission.maximum
                    + 8 * facts.optional!.records.size + 2048);
            }
            if (tick(stats, 24)) yield;
            if (cost <= remaining) {
                const captured: {value?: RootProfiles} = {}, limit = stats.work + cost;
                const probe = optionalRunSplit(a, b, region, undefined, stats, captured, facts.optional!.records, !!omission, omission?.replacement);
                try {
                    for (;;) {
                        const step = probe.next();
                        if (stats.work > limit) break;
                        if (step.done) {
                            if (step.value) {
                                capture.plan = {...capture.plan, minimum: step.value[2]}; capture.certified = true; capture.profile = captured.value!;
                                if (tick(stats, 8)) yield; return step.value;
                            }
                            break;
                        }
                        yield;
                    }
                } finally { probe.return(undefined); }
            }
        }
        if (distance > radius) {
            // Only visited diagonals need storage. Retain both parities and their empty
            // neighbours so growth preserves the same frontier and overlap tie choices.
            const nextRadius = Math.min(maximum, Math.max(8, radius * 2)), nextOrigin = nextRadius + 1;
            const nextForward = new Int32Array(nextRadius * 2 + 3), nextReverse = new Int32Array(nextForward.length);
            for (let index = 0; index < nextForward.length; index++) {
                const prior = index - nextOrigin + origin;
                nextForward[index] = forward[prior] ?? -1; nextReverse[index] = reverse[prior] ?? -1;
                if (tick(stats, 2)) yield;
            }
            radius = nextRadius; origin = nextOrigin; forward = nextForward; reverse = nextReverse;
        }
        // A reused direction may start ahead of the other. Compare overlap only after
        // both have caught up to the same phase; earlier overlaps are excluded above.
        if (distance >= resumeForward) for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
            let x = start(forward, diagonal), y = x - diagonal;
            if (x >= 0) {
                if (x < n && y < m) {
                    const unequal = knownUnequal(a, b, region.a0 + x, region.b0 + y);
                    if (tick(stats)) yield;
                    if (unequal) stats.lineComparisons++;
                    else { const same = yield* commonLines(a, b, { a0: region.a0 + x, a1: region.a1, b0: region.b0 + y, b1: region.b1 }, false, stats, true); x += same; y += same; }
                }
                if (capture) seenF = Math.max(seenF, y + 1);
            }
            forward[origin + diagonal] = x;
            const opposite = origin + delta - diagonal;
            if (distance >= together && x >= 0 && delta % 2 !== 0 && opposite >= 0 && opposite < reverse.length && reverse[opposite]! >= 0 && x >= n - reverse[opposite]!) {
                if (capture?.plan) { capture.plan = {...capture.plan, minimum: 2 * distance - 1}; if (tick(stats)) yield; }
                return [region.a0 + x, region.b0 + y, 2 * distance - 1];
            }
            if (tick(stats)) yield;
        }
        if (distance >= resumeReverse) for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
            let x = start(reverse, diagonal), y = x - diagonal;
            if (x >= 0) {
                if (x < n && y < m) {
                    const unequal = knownUnequal(a, b, region.a1 - x - 1, region.b1 - y - 1);
                    if (tick(stats)) yield;
                    if (unequal) stats.lineComparisons++;
                    else { const same = yield* commonLines(a, b, { a0: region.a0, a1: region.a1 - x, b0: region.b0, b1: region.b1 - y }, true, stats, true); x += same; y += same; }
                }
                if (capture) seenR = Math.max(seenR, y + 1);
            }
            reverse[origin + diagonal] = x;
            const opposite = origin + delta - diagonal;
            if (distance >= together && x >= 0 && delta % 2 === 0 && opposite >= 0 && opposite < forward.length && forward[opposite]! >= 0 && forward[opposite]! >= n - x) {
                if (capture?.plan) { capture.plan = {...capture.plan, minimum: 2 * distance}; if (tick(stats)) yield; }
                const split = forward[opposite]!; return [region.a0 + split, region.b0 + split - (delta - diagonal), 2 * distance];
            }
            if (tick(stats)) yield;
        }
    }
    throw new Error("Comparison search did not find a split.");
}

type AlignmentPlan = Readonly<{ working: Index; alphabet: Alphabet; proof?: DiffRepairCertificate | undefined; changes: readonly Region[]; hunks: readonly (DiffHunk | undefined)[] }>;
type AlignmentReuse = Readonly<{ plan: AlignmentPlan; from: number; to: number; delta: number; rowDelta?: number; origins?: readonly (number | undefined)[] }>;
/** Equal row positions and zero reference matches for every changed old/new row preserve
 * the complete equality matrix, hence the canonical raw alignment. Character trims still
 * depend on the new text. Ownership must cover everything outside the checked window. */
function* reuseAlignment(plan: AlignmentPlan, right: Index, stats: Stats): Generator<void, AlignmentReuse | undefined> {
    const old = plan.working;
    if (tick(stats, 4)) yield;
    if (old.lines.size !== right.lines.size) return;
    if (old.buffer === right.buffer) return { plan, from: 0, to: 0, delta: 0 };
    const edges = yield* lineEdges(old.buffer, right.buffer, stats);
    const from = edges.aFrom === old.to ? old.lines.size : old.buffer.lineAt(edges.aFrom);
    const to = edges.aTo === old.to ? old.lines.size : old.buffer.lineAt(edges.aTo);
    const end = edges.bTo === right.to ? right.lines.size : right.buffer.lineAt(edges.bTo);
    if (to !== end || to - from > 256 || from === 0 && to === old.lines.size) return;
    for (let row = from; row < to; row++) for (const index of [old, right]) {
        const token = (yield* getLine(index, row, stats)).token;
        if (token === undefined) return;
        stats.lineComparisons++;
        if (tick(stats, token.length + 4)) yield;
        if (plan.alphabet.has(token)) return;
    }
    return { plan, from, to, delta: edges.bTo - edges.aTo };
}
/** A partial alphabet cannot prove absence. Null remembers an unindexable reference. */
function* referenceAlphabet(left: Index, stats: Stats): Generator<void, ReadonlySet<string> | null> {
    const alphabet = new Set<string>();
    for (let row = 0; row < left.lines.size; row++) {
        const token = (yield* getLine(left, row, stats)).token;
        if (token === undefined) return null;
        alphabet.add(token); if (tick(stats, token.length + 2)) yield;
    }
    return alphabet;
}
function range(buffer: TextBuffer, from: number, to: number): DiffRange {
    const lineFrom = buffer.lineAt(from); return Object.freeze({ from, to, lineFrom, lineTo: from === to ? lineFrom : buffer.lineAt(to - 1) + 1 });
}
function* compare(a: TextBuffer, b: TextBuffer, stats: Stats, cache?: Cache, serial = 0): Generator<void, readonly DiffHunk[]> {
    try {
        const prior = cache?.alignment, previousSplits = cache?.splits; let alphabet = cache?.alphabet;
        if (a === b) { if (cache?.serial === serial) { cache.alignment = undefined; cache.frontier = undefined; cache.splits = undefined; } return Object.freeze([]); }
        const left = yield* indexLines(a, stats, cache?.reference);
        if (cache?.serial === serial) cache.reference = left;
        const right = yield* indexLines(b, stats, cache?.working ?? left);
        if (cache) stats.equalities = yield* prepareEqualities(right, cache.equalities, stats);
        if (cache?.serial === serial) cache.working = right;
        let reused = prior ? yield* reuseAlignment(prior, right, stats) : undefined;
        if (!reused && prior?.proof) {
            const local = yield* repairAlignment(left, right, prior.working, prior.changes, prior.proof, stats);
            if (local) reused = { plan: { ...prior, changes: local.changes, proof: local.proof }, from: local.from, to: local.to,
                delta: local.delta, rowDelta: local.rowDelta, origins: local.origins };
        }
        const frontier: FrontierCapture | undefined = cache && left.lines.size <= frontierLimits.rows && right.lines.size <= frontierLimits.rows
            ? { previous: cache.frontier, first: true } : undefined;
        const splits: SplitCapture | undefined = frontier ? { count: 0, reused: false } : undefined;
        const savedSplits = splits && previousSplits && !reused ? yield* retainedSplits(previousSplits, right, stats) : undefined;
        const seed = frontier && !reused ? yield* recursiveSeed(frontier.previous, previousSplits, right, stats) : undefined;
        let certificateBudget: SplitBudget | undefined;
        const tasks: Task[] = [{ a0: 0, a1: left.lines.size, b0: 0, b1: right.lines.size }], changes: Region[] = [];
        const append = (change: Region) => {
            const previous = changes.at(-1);
            if (previous?.a1 === change.a0 && previous.b1 === change.b0) changes[changes.length - 1] = { a0: previous.a0, a1: change.a1, b0: previous.b0, b1: change.b1 };
            else changes.push(change);
        };
        if (reused) for (const change of reused.plan.changes) { changes.push(change); if (tick(stats)) yield; }
        while (!reused && tasks.length) {
            const task = tasks.pop()!; let { a0, a1, b0, b1 } = task;
            const prefix = yield* commonLines(left, right, { a0, a1, b0, b1 }, false, stats); a0 += prefix; b0 += prefix;
            const suffix = yield* commonLines(left, right, { a0, a1, b0, b1 }, true, stats); a1 -= suffix; b1 -= suffix;
            const inherited = task.profile ? {...task.profile, from: task.profile.from + prefix, to: task.profile.to - suffix,
                boundary: prefix === 0 ? task.profile.boundary : undefined} : undefined;
            if (inherited && tick(stats, 8)) yield;
            if (a0 === a1 && b0 === b1) continue;
            if (a0 === a1 || b0 === b1 || a1 - a0 > 1 && b1 - b0 > 1 && (yield* disjoint(left, right, { a0, a1, b0, b1 }, stats))) {
                append({ a0, a1, b0, b1 });
            } else if (a1 - a0 === 1 || b1 - b0 === 1) {
                let matchA = -1, matchB = -1;
                outer: for (let ai = a0; ai < a1; ai++) for (let bi = b0; bi < b1; bi++) if (yield* equalLine(left, right, ai, bi, stats)) { matchA = ai; matchB = bi; break outer; }
                if (matchA < 0) append({ a0, a1, b0, b1 });
                else { tasks.push({ a0: matchA + 1, a1, b0: matchB + 1, b1 }); tasks.push({ a0, a1: matchA, b0, b1: matchB }); }
            } else {
                const capture = frontier?.first ? frontier : undefined;
                if (frontier) frontier.first = false;
                const region = { a0, a1, b0, b1 }, saved = savedSplits?.get(regionKey(region));
                if (savedSplits && tick(stats, 4)) yield;
                const profile = inherited && a1 - a0 + b1 - b0 - 2 * (inherited.to - inherited.from) >= 128 ? inherited : undefined;
                const certified: {value?: RootProfiles} = {};
                const before = stats.work, split = profile ? yield* profileSplit(left, right, region, profile, stats, saved?.point)
                    : saved?.point ?? (yield* bisect(left, right, region, stats, capture, seed, capture ? undefined : certificateBudget, alphabet ?? undefined, certified, task.distance));
                // A root profile disables speculation. A child profile stays on its subtree;
                // cheap descendants cannot reach the distance-64 certificate phase.
                if (capture?.plan && seed && !capture.profile) certificateBudget = { remaining: stats.work, certified: false };
                if (saved && splits) splits.reused = true;
                if (splits && !("changes" in split)) yield* retainSplit(splits, region, split, saved?.work ?? stats.work - before, stats);
                if ("changes" in split) { split.changes.forEach(append); continue; }
                const [ai, bi] = split, prefixDistance = Math.ceil(split[2] / 2);
                if (tick(stats, 3)) yield;
                if ((ai === a0 && bi === b0) || (ai === a1 && bi === b1)) throw new Error("Comparison split did not make progress.");
                const prepared = capture?.profile ?? certified.value;
                const currentProfile = profile ?? (prepared ? {profiles: prepared, from: 0, to: prepared.required.length} : undefined);
                if (currentProfile) {
                    // A canonical split spends ceil(D/2) edits in its prefix.
                    const middle = currentProfile.from + ((ai - a0) + (bi - b0) - prefixDistance) / 2;
                    if (!Number.isInteger(middle) || middle < currentProfile.from || middle > currentProfile.to) throw new Error("Invalid required midpoint ordinal.");
                    tasks.push({a0: ai, a1, b0: bi, b1, distance: split[2] - prefixDistance, profile: {profiles: currentProfile.profiles, from: middle, to: currentProfile.to,
                        direction: "earliest", boundary: currentProfile.profiles.latest[middle]!}});
                    tasks.push({a0, a1: ai, b0, b1: bi, distance: prefixDistance, profile: {profiles: currentProfile.profiles, from: currentProfile.from, to: middle, direction: "latest"}});
                    if (tick(stats, 16)) yield;
                } else { tasks.push({ a0: ai, a1, b0: bi, b1, distance: split[2] - prefixDistance }); tasks.push({ a0, a1: ai, b0, b1: bi, distance: prefixDistance }); }
            }
        }
        let proof = reused?.plan.proof;
        if (!proof && frontier?.ordered) {
            // Trimmed outer spans can dwarf the ordered region. Optional certification may
            // spend at most the work already performed, plus one cooperative advance.
            const capture = certifyAlignment(left, right, changes, cache?.repairReference, stats), limit = stats.work * 2;
            try {
                for (;;) {
                    const step = capture.next();
                    if (stats.work > limit) break;
                    if (step.done) { proof = step.value; break; }
                    yield;
                }
            } finally { capture.return(undefined); }
        }
        if (proof) alphabet = proof.reference;
        // Capture a certified ordered alignment or an expensive completed search. Other
        // cheap sparse jobs keep lazy indexes and clear an obsolete plan on success.
        const capturePlan = cache && alphabet !== null && left.lines.size <= 65536 && right.lines.size <= 65536 && changes.length <= 4096
            && (reused !== undefined || proof !== undefined || frontier?.certified || certificateBudget?.certified || stats.lineComparisons >= 100000);
        const regionHunks: (DiffHunk | undefined)[] | undefined = capturePlan ? [] : undefined;
        const hunks: DiffHunk[] = [];
        for (let index = 0; index < changes.length; index++) {
            const change = changes[index]!;
            stats.lineEdits += change.a1 - change.a0 + change.b1 - change.b0;
            if (reused && (reused.origins === undefined || reused.origins[index] !== undefined) && (change.b1 <= reused.from || change.b0 >= reused.to)) {
                let hunk = reused.plan.hunks[reused.origins?.[index] ?? index];
                if (hunk && change.b0 >= reused.to && (reused.delta !== 0 || reused.rowDelta !== undefined && reused.rowDelta !== 0)) hunk = Object.freeze({ baseline: hunk.baseline,
                    working: Object.freeze({ ...hunk.working, from: hunk.working.from + reused.delta, to: hunk.working.to + reused.delta,
                        lineFrom: hunk.working.lineFrom + (reused.rowDelta ?? 0), lineTo: hunk.working.lineTo + (reused.rowDelta ?? 0) }), whitespaceOnly: hunk.whitespaceOnly });
                if (hunk) hunks.push(hunk); regionHunks?.push(hunk); if (tick(stats, 8)) yield; continue;
            }
            let a0 = offsetAt(left, change.a0), a1 = offsetAt(left, change.a1);
            let b0 = offsetAt(right, change.b0), b1 = offsetAt(right, change.b1);
            const prefix = yield* commonText(a, b, a0, a1, b0, b1, "start", stats); a0 += prefix; b0 += prefix;
            const suffix = yield* commonText(a, b, a0, a1, b0, b1, "end", stats); a1 -= suffix; b1 -= suffix;
            let whitespaceOnly = true;
            outer: for (const [buffer, from, to] of [[a, a0, a1], [b, b0, b1]] as const) for (let offset = from; offset < to; offset += 256) {
                const end = Math.min(to, offset + 256), white = /^\s*$/u.test(buffer.slice(offset, end));
                stats.readUnits += end - offset; if (tick(stats, end - offset)) yield;
                if (!white) { whitespaceOnly = false; break outer; }
            }
            const hunk = a0 !== a1 || b0 !== b1 ? Object.freeze({ baseline: range(a, a0, a1), working: range(b, b0, b1), whitespaceOnly }) : undefined;
            if (hunk) hunks.push(hunk);
            if (regionHunks) { regionHunks.push(hunk); if (tick(stats, 8)) yield; }
        }
        if (capturePlan && alphabet === undefined) alphabet = yield* referenceAlphabet(left, stats);
        if (stats.equalities) { const equalities = yield* stats.equalities.finish(stats); if (cache?.serial === serial) cache.equalities = equalities; }
        if (cache?.serial === serial) {
            if (alphabet !== undefined) cache.alphabet = alphabet;
            if (proof) cache.repairReference = proof.reference;
            cache.alignment = capturePlan && alphabet ? Object.freeze({ working: right, alphabet, proof, changes: Object.freeze(changes), hunks: Object.freeze(regionHunks!) }) : undefined;
            // Local repair changes the equality matrix. Older frontier/split proofs must
            // keep their actual working capture; only matrix-preserving reuse can relabel it.
            cache.splits = reused?.origins ? previousSplits : reused ? previousSplits && previousSplits.working === reused.plan.working ? Object.freeze({ ...previousSplits, working: right }) : previousSplits
                : splits?.rows && (splits.reused || frontier?.certified || certificateBudget?.certified || stats.lineComparisons >= frontierLimits.comparisons) ? Object.freeze({ working: right, rows: splits.rows, count: splits.count }) : undefined;
            const previous = frontier?.previous, captured = frontier?.plan;
            cache.frontier = reused?.origins ? previous : reused ? previous && previous.working === reused.plan.working ? Object.freeze({ ...previous, working: right }) : previous
                : captured?.points.length && (frontier?.certified || certificateBudget?.certified || stats.lineComparisons >= frontierLimits.comparisons) ? Object.freeze({ ...captured, points: Object.freeze([...captured.points]) }) : undefined;
        }
        return Object.freeze(hunks);
    } finally { stats.identities.clear(); stats.equalities = undefined; stats.textProof = undefined; }
}

/** Exact line alignment with bounded cooperative steps and linear-space bisection. */
export class TextDiff {
    private readonly driver: KernelCursor<DiffProgress>;
    constructor(baseline: TextBuffer, working: TextBuffer, cache?: DiffReferenceCache) {
        const state = cache === undefined ? undefined : referenceCaches.get(cache);
        if (cache !== undefined && !state) throw new Error("Reference cache is disposed or foreign.");
        const current = state?.current?.baseline === baseline ? state.current : { baseline, serial: 0, reference: undefined, working: undefined };
        if (state) state.current = current;
        const stats: Stats = { work: 0, yielded: 0, readUnits: 0, lineComparisons: 0, lineEdits: 0, equalities: undefined, identities: new DiffIdentities() };
        const empty: readonly DiffHunk[] = Object.freeze([]);
        this.driver = kernelCursor(compare(baseline, working, stats, state ? current : undefined, ++current.serial), () => stats.work,
            (status, result, failure): DiffProgress => Object.freeze({ status, work: stats.work, readUnits: stats.readUnits,
                lineComparisons: stats.lineComparisons, lineEdits: stats.lineEdits, hunks: result ?? empty, failure }), "Comparison");
    }
    next(workBudget = 32_768): DiffProgress { return this.driver.next(workBudget); }
    snapshot(): DiffProgress { return this.driver.snapshot(); }
    dispose(): void { this.driver.dispose(); }
}
