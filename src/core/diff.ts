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
type FrontierPoint = Readonly<{ distance: number; radius: number; origin: number; forward: Int32Array; reverse: Int32Array; seenF: number; seenR: number }>;
type FrontierPlan = Readonly<{ working: Index; region: Region; points: readonly FrontierPoint[]; minimum?: number }>;
type FrontierCapture = { previous: FrontierPlan | undefined; plan?: FrontierPlan; ordered?: boolean; first: boolean };
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
    const lower = yield* recursiveDistance(seed, region, stats);
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
    const rightTokens = new Set<string>();
    for (let bi = region.b0; bi < region.b1; bi++) {
        const token = (yield* getLine(right, bi, stats)).token;
        if (token === undefined) return;
        rightTokens.add(token); if (tick(stats, token.length + 4)) yield;
    }
    if (facts) { facts.working = rightTokens; if (tick(stats)) yield; }
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
        rows.set(token, rows.has(token) ? -1 : ai);
        if (facts) { facts.maximum = Math.max(facts.maximum, token.length); if (tick(stats)) yield; }
        if (tick(stats, token.length + 4)) yield;
    }
    const changes: Region[] = []; let a0 = region.a0, b0 = region.b0;
    for (let bi = region.b0; bi < region.b1; bi++) {
        const token = (yield* getLine(right, bi, stats)).token;
        if (token === undefined) return;
        const ai = rows.get(token); stats.lineComparisons++;
        if (tick(stats, token.length + 4)) yield;
        if (ai === undefined) continue;
        if (ai === -1) return yield* completeCommonAlignment(left, right, region, rows, stats, facts);
        if (ai < a0) return; // Repeated working tokens or crossed unique pairs.
        if (a0 < ai || b0 < bi) changes.push({ a0, a1: ai, b0, b1: bi });
        a0 = ai + 1; b0 = bi + 1;
        if (tick(stats, 4)) yield;
    }
    if (a0 < region.a1 || b0 < region.b1) changes.push({ a0, a1: region.a1, b0, b1: region.b1 });
    return changes;
}
type CommonFacts = { working?: ReadonlySet<string>; maximum: number };
type ChildDistance = { minimum?: number };
/** The complete working alphabet and all short row tokens are already materialized.
 * If every matchable reference row embeds in order, every optimum must match them all.
 * Earliest prefix endpoints and latest suffix starts enumerate all optimum midpoint
 * vertices. Odd/even overlap scan order selects the diagonal, then its furthest x,
 * preserving the ordinary first canonical split without publishing a partial frontier. */
function* requiredReferenceSplit(left: Index, right: Index, region: Region, facts: CommonFacts, stats: Stats): Generator<void, readonly [number, number, number] | undefined> {
    const n = region.a1 - region.a0, m = region.b1 - region.b0;
    const flags = new Uint8Array(n), earliest = new Uint32Array(n + 1), latest = new Uint32Array(n + 1), required: string[] = [];
    for (let row = 0; row <= n; row++) if (tick(stats, 3)) yield;
    let at = 0;
    for (let row = 0; row < n; row++) {
        const token = (yield* getLine(left, region.a0 + row, stats)).token!;
        if (tick(stats, token.length + 4)) yield;
        if (!facts.working!.has(token)) continue;
        flags[row] = 1; required.push(token);
        for (;;) {
            if (at === m) return;
            const other = (yield* getLine(right, region.b0 + at, stats)).token!, equal = other === token;
            stats.lineComparisons++; if (tick(stats, Math.max(token.length, other.length) + 4)) yield;
            at++; if (equal) break;
        }
        earliest[required.length] = at; if (tick(stats, 3)) yield;
    }
    const length = required.length;
    if (!length) return;
    at = m; latest[length] = m; if (tick(stats)) yield;
    for (let row = length - 1; row >= 0; row--) {
        for (;;) {
            if (!at) return;
            const token = (yield* getLine(right, region.b0 + at - 1, stats)).token!, wanted = required[row]!, equal = token === wanted;
            stats.lineComparisons++; if (tick(stats, Math.max(token.length, wanted.length) + 4)) yield;
            at--; if (equal) break;
        }
        latest[row] = at; if (tick(stats)) yield;
    }
    const minimum = n + m - length * 2, wave = Math.ceil(minimum / 2);
    let matched = 0, bestX = -1, bestY = -1, diagonal: number | undefined;
    for (let x = 0; x <= n; x++) {
        if (x) matched += flags[x - 1]!;
        const y = wave - x + matched * 2, k = x - y;
        if (y >= earliest[matched]! && y <= latest[matched]!
            && (diagonal === undefined || (minimum % 2 ? k < diagonal : k > diagonal) || k === diagonal && x > bestX)) {
            diagonal = k; bestX = x; bestY = y;
        }
        if (tick(stats, 12)) yield;
    }
    if (bestX >= 0) return [region.a0 + bestX, region.b0 + bestY, minimum];
    return;
}

type SplitBudget = { remaining: number; certified: boolean };
function* bisect(a: Index, b: Index, region: Region, stats: Stats, capture?: FrontierCapture, seed?: RecursiveSeed, certificateBudget?: SplitBudget): Generator<void, readonly [number, number, number] | Readonly<{ changes: readonly Region[] }>> {
    const n = region.a1 - region.a0, m = region.b1 - region.b0, maximum = Math.ceil((n + m) / 2), delta = n - m;
    let radius = 0, origin = 1, forward = new Int32Array(3).fill(-1), reverse = new Int32Array(3).fill(-1);
    if (tick(stats, 6)) yield;
    forward[origin + 1] = 0; reverse[origin + 1] = 0;
    let resumeDistance = 0, resumeForward = 0, resumeReverse = 0, together = 0, seenF = 0, seenR = 0;
    const points: FrontierPoint[] = [], bounds: ChildDistance = {};
    if (capture || seed) {
        const prior = capture?.previous ?? seed?.frontier;
        const retained = capture ? prior ? yield* retainedFrontier(prior, b, region, stats) : undefined : seed ? yield* retainedRecursive(seed, region, stats, bounds) : undefined;
        if (prior && retained) {
            for (let index = 0; index <= retained.joint; index++) { points.push(prior.points[index]!); if (tick(stats)) yield; }
            const f = prior.points[retained.forward], r = prior.points[retained.reverse];
            resumeForward = f?.distance ?? 0; resumeReverse = r?.distance ?? 0;
            resumeDistance = Math.min(resumeForward, resumeReverse); together = Math.max(resumeForward, resumeReverse);
            seenF = f?.seenF ?? 0; seenR = r?.seenR ?? 0;
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
            points.push(Object.freeze({ distance, radius, origin, forward: f, reverse: r, seenF, seenR }));
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
            const facts: CommonFacts | undefined = certificateBudget && certificateBudget.remaining > 0 ? { maximum: 0 } : undefined;
            const ordered = yield* orderedCommonAlignment(a, b, region, stats, facts);
            if (ordered) { if (capture) capture.ordered = true; return { changes: ordered }; }
            if (facts?.working && certificateBudget && certificateBudget.remaining > 0 && seed) {
                const lower = bounds.minimum ?? (yield* recursiveDistance(seed, region, stats)), stop = Math.ceil(lower / 2);
                // Every wave before stop must complete, visiting d+1 cells per active direction.
                const cells = (start: number) => start >= stop ? 0 : (stop * (stop + 1) - start * (start + 1)) / 2;
                const remaining = cells(Math.max(distance, resumeForward)) + cells(Math.max(distance, resumeReverse));
                // Bound token filtering, both greedy scans, numeric initialization and vertices.
                const cost = offsetAt(a, region.a1) - offsetAt(a, region.a0) + 2 * (offsetAt(b, region.b1) - offsetAt(b, region.b0))
                    + 2 * m * facts.maximum + 8 * m + 23 * n + 16;
                if (tick(stats, 24)) yield;
                if (cost <= remaining) {
                    const before = stats.work, limit = before + Math.min(cost, certificateBudget.remaining), probe = requiredReferenceSplit(a, b, region, facts, stats);
                    try {
                        for (;;) {
                            const step = probe.next();
                            if (stats.work > limit) { break; }
                            if (step.done) { if (step.value) { certificateBudget.certified = true; return step.value; } break; }
                            yield;
                        }
                    } finally { certificateBudget.remaining = Math.max(0, certificateBudget.remaining - (stats.work - before)); probe.return(undefined); }
                }
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
        const tasks: Region[] = [{ a0: 0, a1: left.lines.size, b0: 0, b1: right.lines.size }], changes: Region[] = [];
        const append = (change: Region) => {
            const previous = changes.at(-1);
            if (previous?.a1 === change.a0 && previous.b1 === change.b0) changes[changes.length - 1] = { a0: previous.a0, a1: change.a1, b0: previous.b0, b1: change.b1 };
            else changes.push(change);
        };
        if (reused) for (const change of reused.plan.changes) { changes.push(change); if (tick(stats)) yield; }
        while (!reused && tasks.length) {
            let { a0, a1, b0, b1 } = tasks.pop()!;
            const prefix = yield* commonLines(left, right, { a0, a1, b0, b1 }, false, stats); a0 += prefix; b0 += prefix;
            const suffix = yield* commonLines(left, right, { a0, a1, b0, b1 }, true, stats); a1 -= suffix; b1 -= suffix;
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
                const before = stats.work, split = saved?.point ?? (yield* bisect(left, right, region, stats, capture, capture ? undefined : seed, capture ? undefined : certificateBudget));
                if (capture?.plan && seed) certificateBudget = { remaining: stats.work, certified: false };
                if (saved && splits) splits.reused = true;
                if (splits && !("changes" in split)) yield* retainSplit(splits, region, split, saved?.work ?? stats.work - before, stats);
                if ("changes" in split) { split.changes.forEach(append); continue; }
                const [ai, bi] = split;
                if ((ai === a0 && bi === b0) || (ai === a1 && bi === b1)) throw new Error("Comparison split did not make progress.");
                tasks.push({ a0: ai, a1, b0: bi, b1 }); tasks.push({ a0, a1: ai, b0, b1: bi });
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
            && (reused !== undefined || proof !== undefined || certificateBudget?.certified || stats.lineComparisons >= 100000);
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
                : splits?.rows && (splits.reused || certificateBudget?.certified || stats.lineComparisons >= frontierLimits.comparisons) ? Object.freeze({ working: right, rows: splits.rows, count: splits.count }) : undefined;
            const previous = frontier?.previous, captured = frontier?.plan;
            cache.frontier = reused?.origins ? previous : reused ? previous && previous.working === reused.plan.working ? Object.freeze({ ...previous, working: right }) : previous
                : captured?.points.length && (certificateBudget?.certified || stats.lineComparisons >= frontierLimits.comparisons) ? Object.freeze({ ...captured, points: Object.freeze([...captured.points]) }) : undefined;
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
