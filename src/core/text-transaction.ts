import { compactDocumentEdit } from "./changes.ts";
import type { TextEdit } from "./changes.ts";
import { composePositionMapList, positionChanges } from "./positions.ts";
import type { PositionMapping } from "./positions.ts";
import type { TextBuffer } from "./text-buffer.ts";

export type TextTransaction = Readonly<{ buffer: TextBuffer; edit: (edits: readonly TextEdit[]) => void }>;
export type TextStep = Readonly<{ before: TextBuffer; after: TextBuffer; mapping: PositionMapping;
    parts?: readonly TextStep[] | undefined }>;
export type StagedText = Pick<TextStep, "mapping" | "parts"> & Readonly<{ buffer: TextBuffer; changedUnits: number }>;
export type StepRun = { size: number; step: TextStep; earlier?: StepRun };

function joinSteps(parts: TextStep[]): TextStep {
    // A position map compacts ordinary edits. A row move also needs its neighboring blocks during fold projection.
    return { before: parts[0]!.before, after: parts.at(-1)!.after,
        mapping: composePositionMapList(parts.map(part => part.mapping)),
        parts: parts.some(part => part.parts || positionChanges(part.mapping)?.[0]?.lineMove) ? parts : undefined };
}

/** Join equal-sized runs once. An ordinary group keeps logarithmically many spans while it grows. */
export function appendStep(run: StepRun | undefined, step: TextStep): StepRun {
    let size = 1;
    while (run?.size === size) {
        step = joinSteps([run.step, step]);
        size *= 2;
        run = run.earlier;
    }
    return run ? { size, step, earlier: run } : { size, step };
}

export function finishSteps(run: StepRun): TextStep {
    if (!run.earlier) return run.step;
    const parts: TextStep[] = [];
    for (let part: StepRun | undefined = run; part; part = part.earlier) parts.push(part.step);
    return joinSteps(parts.reverse());
}

/** Stage edits against successive immutable buffers. Workspace commits only the final result. */
export function stageTextTransaction(before: TextBuffer, action: (tx: TextTransaction) => void): StagedText {
    let buffer = before, changedUnits = 0, open = true, valid = true;
    let run: StepRun | undefined;
    const draft: TextTransaction = Object.freeze({
        get buffer() { return buffer; },
        edit(edits: readonly TextEdit[]) {
            if (!open || !valid) throw new Error("The text transaction is no longer open.");
            try {
                const result = buffer.apply(compactDocumentEdit(buffer, edits));
                if (result.buffer === buffer) return;
                run = appendStep(run, { before: buffer, after: result.buffer, mapping: result.mapping });
                buffer = result.buffer;
                changedUnits += result.changedUnits;
            } catch (error) { valid = false; throw error; }
        }
    });
    try {
        const returned: unknown = action(draft);
        if (returned && typeof (returned as PromiseLike<unknown>).then === "function") {
            // An unsupported asynchronous callback may try to use the closed draft after await.
            void Promise.resolve(returned).catch(() => {});
            throw new TypeError("A text transaction callback must be synchronous.");
        }
        if (!valid) throw new Error("A failed text transaction step cannot be committed.");
    } finally { open = false; }
    if (!run || (run.size > 1 || run.earlier) && buffer.equals(before)) return before.apply([]);
    const { mapping, parts } = finishSteps(run);
    return { buffer, changedUnits, mapping, parts };
}
