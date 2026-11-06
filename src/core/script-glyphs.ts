import type { GlyphMappingResult } from "./glyph-mapping.ts";
import { ownedGlyphMappingResult } from "./glyph-mapping.ts";
import type { ScriptIndex, ScriptRun } from "./script-itemization.ts";
import { ownedScriptIndex } from "./script-itemization.ts";
import type { GlyphRun } from "./glyph-run.ts";
import type { SubstitutionGlyph } from "./font-substitution.ts";
import { kernelCursor } from "./kernel-cursor.ts";

export type ScriptGlyphPart = Readonly<{ script: ScriptRun; fromGlyph: number; toGlyph: number; glyphs: GlyphRun<SubstitutionGlyph> }>;
export type ScriptGlyphOptions = Readonly<{ maxOperations?: number }>;
export type ScriptGlyphProgress = Readonly<{ status: "running" | "ready" | "failed" | "disposed"; phase: "locate" | "partition";
    scannedGlyphs: number; publishedParts: number; workUnits: number; result: ScriptGlyphIndex | null; failure: string | null }>;
export type ScriptGlyphCursor = Readonly<{ next: (workBudget?: number) => ScriptGlyphProgress; snapshot: () => ScriptGlyphProgress; dispose: () => void }>;
let publish: (mapping: GlyphMappingResult, scripts: ScriptIndex, blocks: readonly (readonly ScriptGlyphPart[])[]) => ScriptGlyphIndex;
/** One owned logical glyph view per script run, including runs containing no mapped glyphs. */
export class ScriptGlyphIndex {
    readonly mapping: GlyphMappingResult; readonly scripts: ScriptIndex; readonly length: number;
    readonly #blocks: readonly (readonly ScriptGlyphPart[])[];
    private constructor(mapping: GlyphMappingResult, scripts: ScriptIndex, blocks: readonly (readonly ScriptGlyphPart[])[]) { this.mapping = mapping; this.scripts = scripts; this.length = scripts.runCount; this.#blocks = blocks; Object.freeze(this); }
    at(index: number): ScriptGlyphPart { if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) throw new RangeError("Invalid script glyph part."); return this.#blocks[Math.floor(index / 256)]![index % 256]!; }
    static { publish = (mapping, scripts, blocks) => new ScriptGlyphIndex(mapping, scripts, blocks); }
}
type Counters = { phase: "locate" | "partition"; scanned: number; parts: number; work: number; yielded: number };
function* partition(mapping: GlyphMappingResult, scripts: ScriptIndex, maxOperations: number, c: Counters): Generator<void, ScriptGlyphIndex | null> {
    const tick = () => { if (++c.work > maxOperations) throw new RangeError("Script glyph partition exceeded its operations limit."); }, pause = () => { if (c.work - c.yielded < 256) return false; c.yielded = c.work; return true; };
    let low = 0, high = mapping.run.length;
    while (low < high) { tick(); if (pause()) yield; const mid = (low + high) >>> 1; if (mapping.pointRangeAt(mid).to <= scripts.from) low = mid + 1; else high = mid; }
    let glyph = low; const blocks: (readonly ScriptGlyphPart[])[] = []; let pending: ScriptGlyphPart[] = [];
    c.phase = "partition";
    for (let i = 0; i < scripts.runCount; i++) {
        tick(); if (pause()) yield; const script = scripts.runAt(i), fromGlyph = glyph;
        while (glyph < mapping.run.length) {
            tick(); if (pause()) yield; const range = mapping.pointRangeAt(glyph); if (range.from >= script.to) break;
            if (range.from < script.from || range.to > script.to) throw new RangeError("Script boundary bisects a mapped glyph."); glyph++; c.scanned++;
        }
        pending.push(Object.freeze({ script, fromGlyph, toGlyph: glyph, glyphs: mapping.run.slice(fromGlyph, glyph) })); c.parts++;
        if (pending.length === 256) { blocks.push(Object.freeze(pending)); pending = []; }
    }
    if (pending.length) blocks.push(Object.freeze(pending)); return publish(mapping, scripts, Object.freeze(blocks));
}
function drive(iterator: Generator<void, ScriptGlyphIndex | null> | null, c: Counters): ScriptGlyphCursor {
    const cursor = kernelCursor(iterator, () => c.work, (status, result, failure): ScriptGlyphProgress => Object.freeze({ status, phase: c.phase, scannedGlyphs: c.scanned,
        publishedParts: c.parts, workUnits: c.work, result, failure }), "Script glyph partition"); iterator = null; return cursor;
}
export function createScriptGlyphCursor(mapping: GlyphMappingResult, scripts: ScriptIndex, options: ScriptGlyphOptions = {}): ScriptGlyphCursor {
    if (!ownedGlyphMappingResult(mapping) || !ownedScriptIndex(scripts) || mapping.text !== scripts.text) throw new TypeError("Script glyph partition requires owned values for the same normalized text.");
    if (scripts.from < mapping.from || scripts.to > mapping.to) throw new RangeError("Script range exceeds its mapped font range.");
    const maxOperations = options.maxOperations ?? Math.max(1_000_000, mapping.run.length * 32 + scripts.runCount * 8);
    if (!Number.isSafeInteger(maxOperations) || maxOperations <= 0) throw new RangeError("Invalid script glyph operations limit.");
    const c: Counters = { phase: "locate", scanned: 0, parts: 0, work: 0, yielded: 0 }; return drive(partition(mapping, scripts, maxOperations, c), c);
}
