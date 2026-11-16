import { LiteralSearch } from "../core/search.ts";
import type { FindIndex } from "../core/find-index.ts";
import type { TextEdit } from "../core/changes.ts";
import type { FindBackend } from "./find.ts";

/** Controller-private backend: replacement captures the existing index, without rescanning
 * the document or retaining a second index. The controller owns all cursors and commits. */
export function createLiteralFindBackend(index: () => FindIndex): FindBackend {
    return Object.freeze({
        search: ({ buffer, query, wholeWord, matchCase }) => {
            const search = new LiteralSearch(buffer, query, { wholeWord, matchCase });
            return { next: () => search.next(131_072, 8192), dispose: () => search.dispose() };
        },
        replace: (_capture, replacement, range) => {
            let positions = range ? undefined : index(), at = 0;
            const count = range ? 1 : positions!.count;
            return {
                next: () => {
                    const edits: TextEdit[] = [], end = Math.min(count, at + 1024);
                    for (; at < end; at++) edits.push({ ...(range ?? positions!.at(at)), insert: replacement });
                    return { done: at === count, edits };
                },
                dispose: () => { positions = undefined; at = count; },
            };
        },
        dispose: () => {},
    });
}
