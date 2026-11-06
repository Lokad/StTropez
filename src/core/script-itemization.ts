import type { NormalizedText } from "./unicode-normalization.ts";
import { ownedNormalizedText } from "./unicode-normalization.ts";
import { unicodeScript, unicodeScriptExtensions, unicodeCategory, unicodeJoinControl, unicodeVariationSelector, shapingUnicodeVersion } from "./unicode-shaping-data.ts";
import type { UnicodeScript } from "./unicode-shaping-data.ts";
import { bidiBracket, bidiClass } from "./bidi-data.ts";
import { kernelCursor } from "./kernel-cursor.ts";
import { createNormalizedGraphemeCursor, ownedGraphemeIndex, GraphemeLimitError } from "./graphemes.ts";
import type { GraphemeIndex } from "./graphemes.ts";

export type ScriptRunKind = "text" | "unknown" | "separator";
export type ScriptRun = Readonly<{ from: number; to: number; script: UnicodeScript; candidates: readonly UnicodeScript[]; kind: ScriptRunKind }>;
export type ScriptCluster = Readonly<{ from: number; to: number; runIndex: number }>;
export type ScriptItemizationOptions = Readonly<{ from?: number; to?: number; clusterMode?: "grapheme" | "combining"; graphemes?: GraphemeIndex; maxOperations?: number; maxRuns?: number; maxBracketDepth?: number }>;
export type ScriptItemizationProgress = Readonly<{ status: "running" | "ready" | "failed" | "disposed"; phase: "grapheme" | "cluster" | "resolve" | "publish";
    scannedPoints: number; clusters: number; plannedRuns: number; publishedRuns: number; publishedClusters: number;
    pairedBrackets: number; unmatchedBrackets: number; bracketDepth: number; workUnits: number; result: ScriptIndex | null; failure: string | null }>;
export type ScriptItemizationCursor = Readonly<{ next: (workBudget?: number) => ScriptItemizationProgress; snapshot: () => ScriptItemizationProgress; dispose: () => void }>;
export class ScriptItemizationLimitError extends Error {
    readonly limit: "operations" | "runs" | "brackets";
    constructor(limit: "operations" | "runs" | "brackets") { super(`Script itemization exceeded its ${limit} limit.`); this.name = "ScriptItemizationLimitError"; this.limit = limit; }
}
let publish: (text: NormalizedText, from: number, to: number, runs: readonly (readonly ScriptRun[])[], clusters: readonly (readonly ScriptCluster[])[], runCount: number, clusterCount: number) => ScriptIndex;
const owned = new WeakSet<ScriptIndex>();
export const ownedScriptIndex = (value: unknown): value is ScriptIndex => typeof value === "object" && value !== null && owned.has(value as ScriptIndex);
const bounds = (length: number, index: number) => { if (!Number.isSafeInteger(index) || index < 0 || index >= length) throw new RangeError("Invalid script index."); };
/** Owned immutable script interpretation, in normalized point coordinates, separate from bidi/font selection. */
export class ScriptIndex {
    readonly text: NormalizedText; readonly from: number; readonly to: number; readonly runCount: number; readonly clusterCount: number; readonly unicodeVersion = shapingUnicodeVersion;
    readonly #runs: readonly (readonly ScriptRun[])[]; readonly #clusters: readonly (readonly ScriptCluster[])[];
    private constructor(text: NormalizedText, from: number, to: number, runs: readonly (readonly ScriptRun[])[], clusters: readonly (readonly ScriptCluster[])[], runCount: number, clusterCount: number) {
        this.text = text; this.from = from; this.to = to; this.#runs = runs; this.#clusters = clusters; this.runCount = runCount; this.clusterCount = clusterCount; owned.add(this); Object.freeze(this);
    }
    runAt(index: number): ScriptRun { bounds(this.runCount, index); return this.#runs[Math.floor(index / 256)]![index % 256]!; }
    clusterAt(index: number): ScriptCluster { bounds(this.clusterCount, index); return this.#clusters[Math.floor(index / 256)]![index % 256]!; }
    runIndexAt(point: number): number { return this.#find(point, this.runCount, i => this.runAt(i)); }
    clusterIndexAt(point: number): number { return this.#find(point, this.clusterCount, i => this.clusterAt(i)); }
    scriptAt(point: number): UnicodeScript { return this.runAt(this.runIndexAt(point)).script; }
    #find(point: number, count: number, at: (index: number) => Readonly<{ from: number; to: number }>): number {
        if (!Number.isSafeInteger(point) || point < this.from || point >= this.to) throw new RangeError("Invalid script point.");
        let low = 0, high = count; while (low + 1 < high) { const mid = (low + high) >>> 1; if (at(mid).from <= point) low = mid; else high = mid; } return low;
    }
    static { publish = (text, from, to, runs, clusters, runCount, clusterCount) => new ScriptIndex(text, from, to, runs, clusters, runCount, clusterCount); }
}
type Unit = { from: number; to: number; cp: number; kind: ScriptRunKind; scripts: readonly UnicodeScript[] | null; preferred: UnicodeScript | null; run: number };
type Run = { from: number; to: number; kind: ScriptRunKind; scripts: readonly UnicodeScript[] | null; preferred: UnicodeScript | null; script: UnicodeScript };
type Bracket = { close: number; run: Run; previous: Bracket | null; same: Bracket | null };
type Counters = { phase: "grapheme" | "cluster" | "resolve" | "publish"; scanned: number; clusters: number; runs: number; publishedRuns: number; publishedClusters: number; pairs: number; unmatched: number; depth: number; work: number; yielded: number };
const explicit = (s: UnicodeScript) => s !== "Zyyy" && s !== "Zinh" && s !== "Zzzz";
const constrained = (scripts: readonly UnicodeScript[]): readonly UnicodeScript[] | null => scripts.length === 1 && (scripts[0] === "Zyyy" || scripts[0] === "Zinh") ? null : scripts;
const canonicalBracket = (cp: number) => cp === 0x2329 ? 0x3008 : cp === 0x232a ? 0x3009 : cp;
const separator = (cp: number) => cp === 0x2028 || bidiClass(cp) === "B";
const positive = (value: number) => { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("Invalid script itemization limit."); return value; };

function* itemize(text: NormalizedText, from: number, to: number, maxOperations: number, maxRuns: number, maxDepth: number, mode: "grapheme" | "combining", supplied: GraphemeIndex | null, c: Counters): Generator<void, ScriptIndex | null> {
    const tick = (n = 1) => { c.work += n; if (c.work > maxOperations) throw new ScriptItemizationLimitError("operations"); }, pause = () => { if (c.work - c.yielded < 256) return false; c.yielded = c.work; return true; };
    let graphemes = supplied;
    if (mode === "grapheme" && !graphemes) {
        const cursor = createNormalizedGraphemeCursor(text, { from, to, maxOperations }); let previous = 0;
        try { while (true) { c.phase = "grapheme"; const step = cursor.next(256), delta = step.workUnits - previous; previous = step.workUnits; tick(delta); if (pause()) yield; if (step.status === "ready") { graphemes = step.result!; break; } } }
        catch (error) { c.work += cursor.snapshot().workUnits - previous; if (error instanceof GraphemeLimitError) throw new ScriptItemizationLimitError("operations"); throw error; }
        finally { cursor.dispose(); }
    }
    const units: Unit[] = [], runs: Run[] = []; let cluster = 0;
    for (let i = from; i < to;) {
        c.phase = "cluster"; tick(); if (pause()) yield; const cp = text.at(i).codePoint, primary = unicodeScript(cp), kind: ScriptRunKind = separator(cp) ? "separator" : primary === "Zzzz" ? "unknown" : "text";
        const end = graphemes?.clusterAt(cluster++).to;
        const unit: Unit = { from: i, to: ++i, cp, kind, scripts: constrained(unicodeScriptExtensions(cp)), preferred: explicit(primary) ? primary : null, run: -1 };
        if (kind === "separator") { if (cp === 13 && i < to && text.at(i).codePoint === 10) { tick(); if (pause()) yield; unit.to = ++i; } unit.scripts = null; }
        else while (i < to && (end === undefined || i < end)) {
            const next = text.at(i).codePoint; tick(); if (pause()) yield;
            if (end === undefined && !unicodeCategory(next).startsWith("M") && !unicodeJoinControl(next) && !unicodeVariationSelector(next)) break;
            if (end !== undefined && bidiBracket(next)) unit.cp = next;
            const p = unicodeScript(next); if (end !== undefined && p === "Zzzz") { unit.kind = "unknown"; unit.scripts = ["Zzzz"]; unit.preferred = null; }
            // Keep the selected grapheme (or explicit legacy combining sequence) intact.
            if (unit.kind === "text" && unit.preferred === null) { if (explicit(p)) { unit.preferred = p; unit.scripts = unicodeScriptExtensions(next); }
                else if (unit.scripts === null) unit.scripts = constrained(unicodeScriptExtensions(next)); }
            unit.to = ++i;
        }
        units.push(unit); c.scanned = i - from; c.clusters++;
    }
    let current: Run | null = null, top: Bracket | null = null; const byClose = new Map<number, Bracket>();
    const choose = (run: Run) => { run.script = run.preferred ?? run.scripts?.[0] ?? "Zyyy"; };
    function* popThrough(match: Bracket | null): Generator<void, void> {
        while (top) { tick(); if (pause()) yield; const removed = top; top = removed.previous; c.depth--; if (removed.same) byClose.set(removed.close, removed.same); else byClose.delete(removed.close);
            if (removed === match) { c.pairs++; break; } c.unmatched++; }
    }
    for (const unit of units) {
        c.phase = "resolve"; tick(); if (pause()) yield; const bracket = unit.kind === "text" ? bidiBracket(unit.cp) : undefined;
        if (unit.kind !== "text") yield* popThrough(null);
        let scripts = unit.scripts, preferred = unit.preferred;
        // Paired punctuation belongs to the enclosing text; retain a live run reference for leading pairs.
        if (bracket?.[1]) { const outer = current as Run | null; scripts = outer?.kind === "text" ? outer.scripts : null; preferred = outer?.kind === "text" ? outer.preferred : null; }
        if (bracket && !bracket[1]) { const match = byClose.get(canonicalBracket(unit.cp)); if (match) { if (match.run !== (current as Run | null)) { scripts = [match.run.script]; preferred = match.run.script; } else { scripts = match.run.scripts; preferred = match.run.preferred; } yield* popThrough(match); } else c.unmatched++; }
        let intersection: readonly UnicodeScript[] | null = scripts;
        if (current && current.kind === unit.kind && unit.kind !== "separator" && current.scripts !== null && scripts !== null) {
            const values: UnicodeScript[] = []; let a = 0, b = 0;
            while (a < current.scripts.length && b < scripts.length) { tick(); if (pause()) yield; const left = current.scripts[a]!, right = scripts[b]!; if (left === right) { values.push(left); a++; b++; } else if (left < right) a++; else b++; } intersection = values;
        } else if (current && current.kind === unit.kind && scripts === null) intersection = current.scripts;
        const joins = current !== null && current.kind === unit.kind && unit.kind !== "separator" && (intersection === null || intersection.length > 0);
        if (!joins) {
            if (current) choose(current); if (runs.length >= maxRuns) throw new ScriptItemizationLimitError("runs");
            current = { from: unit.from, to: unit.to, kind: unit.kind, scripts, preferred, script: "Zyyy" }; runs.push(current); c.runs++;
        } else { current!.to = unit.to; current!.scripts = intersection;
            if (current!.preferred === null || intersection !== null && !intersection.includes(current!.preferred!)) current!.preferred = preferred !== null && (intersection === null || intersection.includes(preferred)) ? preferred : null;
        }
        unit.run = runs.length - 1;
        if (bracket?.[1]) { if (c.depth >= maxDepth) throw new ScriptItemizationLimitError("brackets"); const close = canonicalBracket(bracket[0]), entry: Bracket = { close, run: current!, previous: top, same: byClose.get(close) ?? null }; top = entry; byClose.set(close, entry); c.depth++; }
    }
    if (current) choose(current); yield* popThrough(null);
    c.phase = "publish"; const runBlocks: (readonly ScriptRun[])[] = [], clusterBlocks: (readonly ScriptCluster[])[] = []; let runBlock: ScriptRun[] = [], clusterBlock: ScriptCluster[] = [];
    for (const run of runs) { tick(); if (pause()) yield; const scripts: UnicodeScript[] = []; for (const s of run.scripts ?? [run.script]) { tick(); if (pause()) yield; scripts.push(s); }
        runBlock.push(Object.freeze({ from: run.from, to: run.to, script: run.script, candidates: Object.freeze(scripts), kind: run.kind })); c.publishedRuns++;
        if (runBlock.length === 256) { runBlocks.push(Object.freeze(runBlock)); runBlock = []; }
    }
    for (const unit of units) { tick(); if (pause()) yield; clusterBlock.push(Object.freeze({ from: unit.from, to: unit.to, runIndex: unit.run })); c.publishedClusters++; if (clusterBlock.length === 256) { clusterBlocks.push(Object.freeze(clusterBlock)); clusterBlock = []; } }
    if (runBlock.length) runBlocks.push(Object.freeze(runBlock)); if (clusterBlock.length) clusterBlocks.push(Object.freeze(clusterBlock));
    return publish(text, from, to, Object.freeze(runBlocks), Object.freeze(clusterBlocks), runs.length, units.length);
}
function drive(iterator: Generator<void, ScriptIndex | null> | null, c: Counters): ScriptItemizationCursor {
    const cursor = kernelCursor(iterator, () => c.work, (status, result, failure): ScriptItemizationProgress => Object.freeze({ status, phase: c.phase,
        scannedPoints: c.scanned, clusters: c.clusters, plannedRuns: c.runs, publishedRuns: c.publishedRuns, publishedClusters: c.publishedClusters,
        pairedBrackets: c.pairs, unmatchedBrackets: c.unmatched, bracketDepth: c.depth, workUnits: c.work, result, failure }), "Script itemization"); iterator = null; return cursor;
}
export function createScriptItemizationCursor(text: NormalizedText, options: ScriptItemizationOptions = {}): ScriptItemizationCursor {
    if (!ownedNormalizedText(text)) throw new TypeError("Script itemization requires owned immutable normalized text."); const from = options.from ?? 0, to = options.to ?? text.length;
    if (![from, to].every(Number.isSafeInteger) || from < 0 || from > to || to > text.length) throw new RangeError("Invalid script itemization range.");
    const maxOperations = positive(options.maxOperations ?? Math.max(1_000_000, (to - from) * 256)), maxRuns = positive(options.maxRuns ?? Math.max(1_000_000, to - from)), maxDepth = positive(options.maxBracketDepth ?? 1024);
    const mode = options.clusterMode ?? "grapheme", graphemes = options.graphemes ?? null;
    if (mode !== "grapheme" && mode !== "combining") throw new RangeError("Invalid script cluster mode.");
    if (graphemes && (mode !== "grapheme" || !ownedGraphemeIndex(graphemes) || graphemes.source.kind !== "normalized" || graphemes.source.text !== text || graphemes.from !== from || graphemes.to !== to)) throw new TypeError("Script graphemes must cover the same owned normalized range.");
    const c: Counters = { phase: "cluster", scanned: 0, clusters: 0, runs: 0, publishedRuns: 0, publishedClusters: 0, pairs: 0, unmatched: 0, depth: 0, work: 0, yielded: 0 };
    return drive(itemize(text, from, to, maxOperations, maxRuns, maxDepth, mode, graphemes, c), c);
}
export function itemizeScripts(text: NormalizedText, options: ScriptItemizationOptions = {}): ScriptIndex {
    const cursor = createScriptItemizationCursor(text, options); try { let step = cursor.next(65536); while (step.status === "running") step = cursor.next(65536); return step.result!; } finally { cursor.dispose(); }
}
