import { LiteralSearch } from "./search.ts";
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
 * The backend produces one edit per indexed match, including no-ops. Only the controller commits. */
export type FindBackend = Readonly<{ search: (capture: FindQueryCapture) => FindSearchCursor;
    replace: (capture: FindQueryCapture, replacement: string, range?: SearchMatch) => FindPlanCursor; dispose: () => void }>;

const planStepEdits = 1024;

/** Assemble one captured plan. The owner supplies steps, cancels failed/stale work and commits
 * only a complete result. Accepted edits are copied before the producer can reuse its buffers. */
export function createFindReplacementPlan(positions: FindIndex, total: number, range?: SearchMatch): (step: FindPlanStep) => readonly TextEdit[] | undefined {
    const edits: TextEdit[] = [];
    return result => {
        if (result.edits.length > planStepEdits) throw new Error("Invalid replacement plan step.");
        for (const edit of result.edits) {
            const index = edits.length;
            if (index >= total) throw new Error("Invalid replacement plan.");
            const at = range ?? positions.at(index);
            if (edit.from !== at.from || edit.to !== at.to) throw new Error("Replacement plan does not match the captured search.");
            edits.push(Object.freeze({ from: edit.from, to: edit.to, insert: edit.insert }));
        }
        if (!result.done) return;
        if (edits.length !== total) throw new Error("Incomplete replacement plan.");
        return Object.freeze(edits);
    };
}

/** Controller-private backend: replacement captures the existing index, without rescanning
 * the document or retaining a second index. The controller owns all cursors and commits. */
export function createLiteralFindBackend(index: () => FindIndex, maxUnits: number, maxMatches: number) {
    return Object.freeze({
        search: ({ buffer, query, wholeWord, matchCase }: FindQueryCapture) => {
            const search = new LiteralSearch(buffer, query, { wholeWord, matchCase });
            return { next: () => search.next(maxUnits, maxMatches), dispose: () => search.dispose() };
        },
        replace: (_capture: FindQueryCapture, replacement: string, range?: SearchMatch) => {
            let positions = range ? undefined : index(), at = 0;
            const count = range ? 1 : positions!.count;
            return {
                next: () => {
                    const edits: TextEdit[] = [], end = Math.min(count, at + planStepEdits);
                    for (; at < end; at++) edits.push({ ...(range ?? positions!.at(at)), insert: replacement });
                    return { done: at === count, edits };
                },
                dispose: () => { positions = undefined; at = count; },
            };
        },
        dispose: () => {},
    });
}
