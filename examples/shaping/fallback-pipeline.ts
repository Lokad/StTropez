import { createFontNormalizationCursor, createScriptItemizationCursor, createScriptGlyphCursor } from "../../src/index.ts";
import type { FontCascade, NormalizedText, FontNormalizationIndex, PositioningResult, SubstitutionPlan, PositioningPlan, LayoutSelection } from "../../src/index.ts";
import { kernelCursor } from "../../src/core/kernel-cursor.ts";
export type FallbackPart = Readonly<{ fontIndex: number; script: string; from: number; to: number; units: number; pixels: number; substitution: LayoutSelection; positioned: PositioningResult }>;
export type FallbackResult = Readonly<{ fonts: FontNormalizationIndex; parts: readonly FallbackPart[]; pixels: number; hiddenGlyphs: number }>;
type Counters = { work: number; phase: string; yielded: number };
const tag = (script: string) => script === "Latn" ? "latn" : script === "Grek" ? "grek" : script === "Hebr" ? "hebr" : "DFLT";
/** Explicit fixture feature policy, not a complete script/language shaping model. */
function* pipeline(input: NormalizedText, cascade: FontCascade, preference: "composed" | "decomposed", c: Counters): Generator<void, FallbackResult> {
    function* complete<T>(phase: string, cursor: { next: (budget: number) => { status: string; workUnits: number; result: T | null }; snapshot: () => { workUnits: number }; dispose: () => void }): Generator<void, T> {
        let prior = 0; try { while (true) { c.phase = phase; const step = cursor.next(256); c.work += Math.max(256, step.workUnits - prior); prior = step.workUnits;
                if (c.work - c.yielded >= 256) { c.yielded = c.work; yield; } if (step.status === "ready") return step.result!; } } finally { cursor.dispose(); }
    }
    const fonts = yield* complete("font", createFontNormalizationCursor(input, cascade, { preference })), plans = new Map<string, Readonly<{ sub: SubstitutionPlan; pos: PositioningPlan }>>(), parts: FallbackPart[] = []; let pixels = 0, hiddenGlyphs = 0;
    for (let r = 0; r < fonts.runCount; r++) { const run = fonts.runAt(r), font = cascade.at(run.fontIndex), scripts = yield* complete("script", createScriptItemizationCursor(fonts.text, { from: run.from, to: run.to })),
            mapping = yield* complete("map", font.createGlyphMappingCursor(fonts.text, { from: run.from, to: run.to })), partitions = yield* complete("partition", createScriptGlyphCursor(mapping, scripts));
        for (let i = 0; i < partitions.length; i++) { const part = partitions.at(i), key = `${run.fontIndex}:${part.script.script}`; let plan = plans.get(key); c.phase = "compile";
            if (!plan) { plan = { sub: font.substitutionPlan({ script: tag(part.script.script), features: [{ tag: "ccmp" }, { tag: "locl" }, { tag: "liga" }] }), pos: font.positioningPlan({ script: tag(part.script.script), features: [{ tag: "kern" }, { tag: "mark" }, { tag: "mkmk" }], legacyKerning: true }) }; plans.set(key, plan); }
            const shaped = yield* complete("substitute", plan.sub.createCursor(part.glyphs)), positioned = yield* complete("position", plan.pos.createCursor(shaped)), width = positioned.advances.total * 100 / font.metadata.unitsPerEm;
            parts.push(Object.freeze({ fontIndex: run.fontIndex, script: part.script.script, from: part.script.from, to: part.script.to, units: positioned.advances.total, pixels: width, substitution: shaped.selection, positioned })); pixels += width; hiddenGlyphs += positioned.hiddenGlyphs;
        }
    } return Object.freeze({ fonts, parts: Object.freeze(parts), pixels, hiddenGlyphs });
}
function drive(iterator: Generator<void, FallbackResult> | null, c: Counters) { const cursor = kernelCursor(iterator, () => c.work, (status, result, failure) => Object.freeze({ status, phase: c.phase, workUnits: c.work, result, failure }), "Cascade pipeline"); iterator = null; return cursor; }
export function createFallbackPipeline(input: NormalizedText, cascade: FontCascade, preference: "composed" | "decomposed") { const c: Counters = { work: 0, phase: "font", yielded: 0 }; return drive(pipeline(input, cascade, preference, c), c); }
