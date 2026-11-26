import type { SearchMatch, SearchStep } from "../core/search.ts";
import type { TextEdit } from "../core/changes.ts";
import type { DocumentId } from "../core/workspace.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import { splitsSurrogatePair } from "../core/utf16.ts";
import { isNonNegativeInteger } from "../core/bounds.ts";
import { readRegexResult, regexIdentity, regexOptions, regexProtocolVersion, regexQuery, regexSourceLimit } from "../protocol/regex.ts";
import type { RegexOptions, RegexRequest, RegexResult } from "../protocol/regex.ts";

type Capture = Readonly<{ documentId: DocumentId; revision: number; buffer: TextBuffer }>;
type QueryOptions = RegexOptions & Readonly<{ wholeWord?: boolean }>;
type CursorStep = SearchStep & Readonly<{ edits: readonly TextEdit[] }>;
type Source = Capture & Readonly<{ id: number; text: string }>;
type Job = Readonly<{ receive(data: unknown): void; fail(error: Error): void; dispose(): void }>;
const empty = Object.freeze([]);

export function createRegexClient(host: Readonly<{ clock: Pick<Window, "setTimeout" | "clearTimeout">; createWorker: () => Worker; timeoutMs?: number }>) {
    const timeout = host.timeoutMs ?? 5000;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError("Unsupported regex timeout.");
    let sequence = 0;
    let disposed = false;
    let worker: Worker | undefined;
    let listeners: AbortController | undefined;
    let cached: Source | undefined;
    let active: Job | undefined;
    function terminate() {
        listeners?.abort();
        worker?.terminate();
        listeners = undefined;
        worker = undefined;
        cached = undefined;
    }
    function connect() {
        if (worker) return worker;
        const created = host.createWorker();
        worker = created;
        listeners = new AbortController();
        const failed = (error: Error) => {
            if (worker !== created) return;
            active?.fail(error);
            if (worker === created) terminate();
        };
        created.addEventListener("error", event => {
            event.preventDefault();
            failed(event.error instanceof Error ? event.error : new Error(event.message || "Regex worker failed to load or run."));
        }, { signal: listeners.signal });
        created.addEventListener("messageerror", () => failed(new Error("Regex worker response could not be decoded.")), { signal: listeners.signal });
        created.addEventListener("message", event => {
            if (worker === created) active?.receive(event.data);
        }, { signal: listeners.signal });
        return created;
    }
    function createCursor(capture: Capture, pattern: string, matchCase: boolean, options: QueryOptions = {}) {
        if (disposed) throw new Error("Regex backend is disposed.");
        const { documentId, revision } = capture;
        const length = capture.buffer.length;
        const query = { length, pattern, matchCase, wholeWord: options.wholeWord ?? false };
        const maxOutput = options.maxOutputUnits ?? regexSourceLimit;
        if (!documentId || typeof documentId !== "string" || !isNonNegativeInteger(revision) || !regexQuery(query) || !regexOptions(options, length))
            throw new RangeError("Unsupported regex capture.");
        const replacement = options.replacement;
        const range = options.range && { from: options.range.from, to: options.range.to };
        active?.dispose();
        const id = ++sequence;
        let buffer: TextBuffer | undefined = capture.buffer;
        let source: Source | undefined;
        let result: RegexResult | undefined;
        let pending: { resolve(value: RegexResult): void; reject(error: Error): void; timer: number } | undefined;
        let failure: Error | undefined;
        let sent = false;
        let busy = false;
        let position = 0;
        let lastFrom = -1;
        let lastTo = 0;
        let inserted = 0;
        let removed = 0;
        let scanned = 0;
        const replacing = replacement !== undefined;
        function release(error?: Error) {
            if (pending) {
                host.clock.clearTimeout(pending.timer);
                if (error) pending.reject(error);
                pending = undefined;
            }
            if (active === job) {
                active = undefined;
                if (error && sent) terminate();
                else if (!error) cached = source;
            }
            result = undefined;
            buffer = undefined;
            source = undefined;
        }
        const job: Job = {
            fail(error) { failure = error; release(error); },
            dispose() { release(new Error("Regex search cancelled.")); },
            receive(value) {
                if (!regexIdentity(value)) return job.fail(new Error("Malformed regex response."));
                if (value.id !== id || value.revision !== revision) return;
                if (!pending) return job.fail(new Error("Unexpected regex response."));
                try {
                    const reply = readRegexResult(value, length, replacing, maxOutput);
                    host.clock.clearTimeout(pending.timer);
                    pending.resolve(reply);
                    pending = undefined;
                } catch (error) { job.fail(error as Error); }
            },
        };
        active = job;
        async function next(): Promise<CursorStep> {
            if (failure) throw failure;
            if (!buffer) return Object.freeze({ done: true, readUnits: 0, scanned, matches: empty, edits: empty });
            if (busy) throw new Error("Regex cursor already has a pending step.");
            busy = true;
            let readUnits = 0;
            try {
                if (!result) {
                    const lane = connect();
                    const reuse = cached?.documentId === documentId && cached.revision === revision && cached.buffer === buffer;
                    if (!reuse) cached = undefined;
                    source = reuse ? cached! : { id, documentId, revision, buffer, text: buffer.slice(0, length) };
                    readUnits = reuse ? 0 : length;
                    const request: RegexRequest = { id, revision, version: regexProtocolVersion, source: source.id,
                        ...query, ...(replacing && { replacement, maxOutputUnits: maxOutput }), ...(range && { range }),
                        ...(reuse ? {} : { text: source.text }) };
                    const reply = await new Promise<RegexResult>((resolve, reject) => {
                        pending = { resolve, reject, timer: host.clock.setTimeout(
                            () => job.fail(new Error("Regex search timed out; narrow the expression.")), timeout) };
                        sent = true;
                        lane.postMessage(request);
                    });
                    if (active !== job) throw failure ?? new Error("Regex search cancelled.");
                    result = reply;
                }
                const stride = replacing ? 3 : 2;
                const end = Math.min(result.offsets.length, position + stride * (replacing ? 1024 : 8192));
                const matches: SearchMatch[] = [];
                const edits: TextEdit[] = [];
                for (; position < end; position += stride) {
                    const from = result.offsets[position]!;
                    const to = result.offsets[position + 1]!;
                    if (from <= lastFrom || from < lastTo || to < from || to > length
                        || splitsSurrogatePair(source!.text, from) || splitsSurrogatePair(source!.text, to))
                        throw new Error("Invalid raw regex range.");
                    if (range && (from !== range.from || to !== range.to))
                        throw new Error("Invalid captured regex replacement range.");
                    lastFrom = from;
                    lastTo = to;
                    if (result.operation === "regex-matches") matches.push(Object.freeze({ from, to }));
                    else {
                        const nextEnd = result.offsets[position + 2]!;
                        if (nextEnd < inserted || nextEnd > result.insertions.length) throw new Error("Invalid regex insertion offset.");
                        edits.push(Object.freeze({ from, to, insert: result.insertions.slice(inserted, nextEnd) }));
                        inserted = nextEnd;
                        removed += to - from;
                    }
                }
                const done = position === result.offsets.length;
                scanned = done ? length : lastTo;
                if (done) {
                    if (result.operation === "regex-edits" && (inserted !== result.insertions.length || length - removed + inserted > regexSourceLimit))
                        throw new Error("Invalid regex result size.");
                    release();
                }
                return Object.freeze({ done, readUnits, scanned, matches: Object.freeze(matches), edits: Object.freeze(edits) });
            } catch (cause) {
                const error = cause instanceof Error ? cause : new Error("Regex search failed.");
                job.fail(error);
                throw error;
            } finally { busy = false; }
        }
        return Object.freeze({ next, dispose: job.dispose });
    }
    return Object.freeze({ createCursor, dispose: () => {
        if (disposed) return;
        disposed = true;
        active?.dispose();
        terminate();
    } });
}
