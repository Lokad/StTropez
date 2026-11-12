import { createRegexCursor } from "./regex-client.ts";
import type { FindBackend, FindQueryCapture } from "./find.ts";
import type { SearchMatch } from "../core/search.ts";
export type RegexFindBackendOptions = Readonly<{ clock: Pick<Window, "setTimeout" | "clearTimeout">; createWorker: () => Worker;
    timeoutMs?: number; maxOutputUnits?: number }>;

/** The host creates a dedicated module worker from the shipped browser/regex-worker.js asset.
 * No source compilation, language service, network or fallback matcher is required. */
export function createRegexFindBackend(options: RegexFindBackendOptions): FindBackend {
    const common = { clock: options.clock, createWorker: options.createWorker, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) };
    return Object.freeze({
        search: (capture: FindQueryCapture) => createRegexCursor(capture.buffer, capture.revision, capture.query, capture.matchCase, { ...common, wholeWord: capture.wholeWord }),
        replace: (capture: FindQueryCapture, replacement: string, range?: SearchMatch) => createRegexCursor(capture.buffer, capture.revision, capture.query, capture.matchCase,
            { ...common, wholeWord: capture.wholeWord, replacement, ...(range === undefined ? {} : { range }), ...(options.maxOutputUnits === undefined ? {} : { maxOutputUnits: options.maxOutputUnits }) }),
    });
}
