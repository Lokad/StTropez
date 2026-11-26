import type { SearchMatch, SearchStep } from "./search.ts";
import type { FindIndex } from "./find-index.ts";
import type { TextEdit } from "./changes.ts";
import type { DocumentId } from "./workspace.ts";
import type { TextBuffer } from "./text-buffer.ts";

export type FindQueryCapture = Readonly<{ documentId: DocumentId; revision: number; buffer: TextBuffer; query: string; wholeWord: boolean; matchCase: boolean }>;
export type FindSearchCursor = Readonly<{ next: () => SearchStep | PromiseLike<SearchStep>; dispose: () => void }>;
export type FindPlanStep = Readonly<{ done: boolean; edits: readonly TextEdit[] }>;
export type FindPlanCursor = Readonly<{ next: () => FindPlanStep | PromiseLike<FindPlanStep>; dispose: () => void }>;
/** One controller owns the backend until expiry/destruction. Disposal must be idempotent.
 * Return one edit per indexed match, including no-ops. For an unindexed selection that does not
 * match in context, finish with no edits. Only the controller commits. */
export type FindBackend = Readonly<{ search: (capture: FindQueryCapture) => FindSearchCursor;
    replace: (capture: FindQueryCapture, replacement: string, range?: SearchMatch) => FindPlanCursor; dispose: () => void }>;

const planStepEdits = 1024;

/** Assemble one captured plan. The owner supplies steps, cancels failed/stale work and commits
 * only a complete result. Accepted edits are copied before the producer can reuse its buffers. */
export function createFindReplacementPlan(positions: FindIndex, total: number, range?: SearchMatch, allowMiss = false) {
    const edits: TextEdit[] = [];
    return (result: FindPlanStep) => {
        if (result.edits.length > planStepEdits) throw new Error("Invalid replacement plan step.");
        for (const edit of result.edits) {
            const index = edits.length;
            if (index >= total) throw new Error("Invalid replacement plan.");
            const at = range ?? positions.at(index);
            if (edit.from !== at.from || edit.to !== at.to) throw new Error("Replacement plan does not match the captured search.");
            edits.push(Object.freeze({ from: edit.from, to: edit.to, insert: edit.insert }));
        }
        if (!result.done) return;
        if (edits.length !== total && !(allowMiss && !edits.length)) throw new Error("Incomplete replacement plan.");
        return Object.freeze(edits);
    };
}

/** Literal replacement reuses the captured search index and releases it on disposal. */
export function literalReplacement(index: FindIndex, replacement: string, range?: SearchMatch): FindPlanCursor {
    let positions = range ? undefined : index, at = 0;
    const count = range ? 1 : index.count;
    return {
        next() {
            const edits: TextEdit[] = [], end = Math.min(count, at + planStepEdits);
            for (; at < end; at++) edits.push({ ...(range ?? positions!.at(at)), insert: replacement });
            return { done: at === count, edits };
        },
        dispose() { positions = undefined; at = count; },
    };
}
