import { kernelCursor } from "./kernel-cursor.ts";
import type { SubstitutionResult } from "./font-substitution.ts";
export type SubstitutionPhase = "input" | "associations" | "validate" | "lookups" | "ordinals" | "publish";
export type SubstitutionProgress = Readonly<{ status: "running" | "ready" | "failed" | "disposed"; phase: SubstitutionPhase;
    preparedGlyphs: number; currentGlyphs: number; publishedGlyphs: number; substitutions: number; workUnits: number; result: SubstitutionResult | null; failure: string | null }>;
export type SubstitutionCursor = Readonly<{ next: (workBudget?: number) => SubstitutionProgress; snapshot: () => SubstitutionProgress; dispose: () => void }>;
export type SubstitutionCounters = { phase: SubstitutionPhase; prepared: number; current: number; published: number; substitutions: number; operations: number; yielded: number };
export function substitutionCursor(iterator: Generator<void, SubstitutionResult | null> | null, counters: SubstitutionCounters): SubstitutionCursor {
    const cursor = kernelCursor(iterator, () => counters.operations, (status, result, failure): SubstitutionProgress => Object.freeze({ status, phase: counters.phase,
        preparedGlyphs: counters.prepared, currentGlyphs: counters.current, publishedGlyphs: counters.published, substitutions: counters.substitutions, workUnits: counters.operations, result, failure }), "Substitution"); iterator = null; return cursor;
}
