import type { PositioningResult } from "./font-positioning.ts";
import { kernelCursor } from "./kernel-cursor.ts";

export type PositioningPhase = "source" | "metrics" | "lookups" | "legacy" | "visibility" | "pens" | "attachments" | "publish";
export type PositioningProgress = Readonly<{ status: "running" | "ready" | "failed" | "disposed";
    phase: PositioningPhase; preparedGlyphs: number; publishedGlyphs: number; workUnits: number;
    result: PositioningResult | null; failure: string | null }>;
export type PositioningCursor = Readonly<{ next: (workBudget?: number) => PositioningProgress;
    snapshot: () => PositioningProgress; dispose: () => void }>;
export type PositioningCounters = { phase: PositioningPhase; prepared: number; published: number; operations: number; yielded: number };

/** The host owns task scheduling. No timer, clock, document or observable escapes into this kernel. */
export function positioningCursor(iterator: Generator<void, PositioningResult | null> | null, counters: PositioningCounters): PositioningCursor {
    const cursor = kernelCursor(iterator, () => counters.operations, (status, result, failure): PositioningProgress => Object.freeze({ status, phase: counters.phase,
        preparedGlyphs: counters.prepared, publishedGlyphs: counters.published, workUnits: counters.operations, result, failure }), "Positioning"); iterator = null; return cursor;
}
