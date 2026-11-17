import type { TextBuffer } from "./text-buffer.ts";
import { kernelCursor } from "./kernel-cursor.ts";
import type { KernelCursor, KernelStatus } from "./kernel-cursor.ts";
export type BufferChangeSpan = Readonly<{ from: number; to: number; insertFrom: number; insertTo: number }>;
export type BufferChangeProgress = Readonly<{ status: KernelStatus; workUnits: number; result: BufferChangeSpan | null; failure: string | null }>;
type Work = { units: number };
/** Unproved text remains inside one streamed replacement; no character scan or export. */
function* plan(before: TextBuffer, after: TextBuffer, work: Work): Generator<void, BufferChangeSpan> {
    let from = 0, suffix = 0;
    for (const count of before.sharedEdge(after, "start")) { from = count; if (++work.units % 256 === 0) yield; }
    for (const count of before.sharedEdge(after, "end", { from, to: before.length, otherFrom: from, otherTo: after.length })) { suffix = count; if (++work.units % 256 === 0) yield; }
    return Object.freeze({ from, to: before.length - suffix, insertFrom: from, insertTo: after.length - suffix });
}
/** Charges one structural node-pair decision per unit, with checkpoints every 256 units. */
export class BufferChangeCursor {
    readonly #driver: KernelCursor<BufferChangeProgress>;
    constructor(before: TextBuffer, after: TextBuffer) {
        const work = { units: 0 };
        this.#driver = kernelCursor(plan(before, after, work), () => work.units,
            (status, result, failure): BufferChangeProgress => Object.freeze({ status, workUnits: work.units, result, failure }), "Buffer change");
    }
    next(budget = 256): BufferChangeProgress { return this.#driver.next(budget); }
    snapshot(): BufferChangeProgress { return this.#driver.snapshot(); }
    dispose(): void { this.#driver.dispose(); }
}
