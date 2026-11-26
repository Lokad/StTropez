import { createRegexClient } from "./regex-client.ts";
import type { FindBackend } from "../core/find.ts";
export type RegexFindBackendOptions = Readonly<{ clock: Pick<Window, "setTimeout" | "clearTimeout">; createWorker: () => Worker;
    timeoutMs?: number; maxOutputUnits?: number }>;

/** The host creates a dedicated module worker from the shipped browser/regex-worker.js asset.
 * No source compilation, language service, network or fallback matcher is required. */
export function createRegexFindBackend(options: RegexFindBackendOptions): FindBackend {
    const client = createRegexClient(options);
    return Object.freeze({ search: capture => client.createCursor(capture), replace: client.createCursor, dispose: client.dispose });
}
