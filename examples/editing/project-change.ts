import type { TextBuffer } from "../../src/index.ts";
export type ProjectChange = Readonly<{ from: number; to: number; insertFrom: number; insertTo: number }>;
/** Unproved text remains inside one streamed replacement; no character scan or export. */
function* plan(before: TextBuffer, after: TextBuffer): Generator<void, ProjectChange | undefined> {
    let from = 0, suffix = 0;
    for (const count of before.sharedEdge(after, "start")) { from = count; yield; }
    for (const count of before.sharedEdge(after, "end", { from, to: before.length, otherFrom: from, otherTo: after.length })) { suffix = count; yield; }
    return Object.freeze({ from, to: before.length - suffix, insertFrom: from, insertTo: after.length - suffix });
}
export class ProjectChangeCursor {
    private iterator: Generator<void, ProjectChange | undefined> | undefined;
    private result: ProjectChange | undefined;
    private disposed = false;
    constructor(before: TextBuffer, after: TextBuffer) { this.iterator = plan(before, after); }
    next(budget = 64): Readonly<{ done: boolean; steps: number; result?: ProjectChange }> {
        if (this.disposed) throw new Error("Project change cursor is disposed.");
        if (!Number.isSafeInteger(budget) || budget < 1 || budget > 1024) throw new RangeError("Invalid project planning budget.");
        let steps = 0;
        while (this.iterator && steps < budget) { const step = this.iterator.next(); steps++; if (step.done) { this.result = step.value; this.iterator = undefined; } }
        return Object.freeze({ done: this.iterator === undefined, steps, ...(this.result ? { result: this.result } : {}) });
    }
    dispose(): void { this.disposed = true; this.iterator?.return(undefined); this.iterator = undefined; this.result = undefined; }
}
