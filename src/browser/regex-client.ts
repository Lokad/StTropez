import type { SearchMatch, SearchStep } from "../core/search.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import type { TextEdit } from "../core/changes.ts";
import type { DocumentId } from "../core/workspace.ts";
import { splitsSurrogatePair } from "../core/utf16.ts";
import { regexChunkUnits, regexSourceLimit, regexProtocolVersion, regexInteger, regexIdentity, regexQuery, regexOptions, decodeRegexMessage, readRegexReply } from "../protocol/regex.ts";
import type { RegexCommand, RegexRequest, RegexReply, RegexOptions } from "../protocol/regex.ts";
type Pending = { resolve: (reply: RegexReply) => void; reject: (error: Error) => void; timer: number };
const empty: readonly SearchMatch[] = Object.freeze([]);
const noEdits: readonly TextEdit[] = Object.freeze([]);
export type RegexCursorStep = SearchStep & Readonly<{ edits: readonly TextEdit[] }>;

type Capture = Readonly<{ documentId: DocumentId; revision: number; buffer: TextBuffer }>;
type QueryOptions = RegexOptions & Readonly<{ wholeWord?: boolean }>;

/** One controller-owned worker and complete source capture. Active cancellation terminates
 * native matching; completed queries retain the lane. One exchange is in flight at a time. */
export function createRegexClient(host: Readonly<{ clock: Pick<Window, "setTimeout" | "clearTimeout">; createWorker: () => Worker; timeoutMs?: number }>) {
    let sequence = 0;
    const timeout = host.timeoutMs ?? 5000;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError("Unsupported regex timeout.");
    let worker: Worker | undefined, listeners: AbortController | undefined, disposed = false;
    let source: (Capture & { id: number }) | undefined;
    let active: { receive(data: unknown): void; reject(error: Error): void; dispose(): void } | undefined;
    const terminate = () => { listeners?.abort(); listeners = undefined; worker?.terminate(); worker = undefined; source = undefined; };
    const connect = () => {
        if (worker) return;
        const created = host.createWorker(); worker = created; listeners = new AbortController();
        const failed = (error: Error) => {
            if (worker !== created) return;
            active?.reject(error);
            // A debounced query has sent nothing, so its ordinary cancellation preserves
            // the cached lane. A worker failure must also invalidate that idle source.
            if (worker === created) terminate();
        };
        created.addEventListener("error", event => {
            event.preventDefault();
            failed(event.error instanceof Error ? event.error : new Error(event.message || "Regex worker failed to load or run."));
        }, { signal: listeners.signal });
        created.addEventListener("messageerror", () => failed(new Error("Regex worker response could not be decoded.")), { signal: listeners.signal });
        created.addEventListener("message", (event: MessageEvent<unknown>) => { if (worker === created) active?.receive(event.data); }, { signal: listeners.signal });
    };
    const createCursor = (capture: Capture, pattern: string, matchCase: boolean, options: QueryOptions = {}) => {
        if (disposed) throw new Error("Regex backend is disposed.");
        const { buffer: input, revision, documentId } = capture, maxOutput = options.maxOutputUnits ?? regexSourceLimit;
        if (typeof documentId !== "string" || !documentId || !regexInteger(revision)
            || !regexQuery({ length: input.length, pattern, matchCase, wholeWord: options.wholeWord })) throw new RangeError("Unsupported regex capture.");
        if (!regexOptions({ ...options, maxOutputUnits: maxOutput }, input.length)) throw new RangeError("Unsupported regex replacement capture.");
        active?.dispose();
        const id = ++sequence, length = input.length;
        let buffer: TextBuffer | undefined = input, pending: Pending | undefined, failure: Error | undefined, sent = false, sourceId = id;
        let done = false, busy = false, started = false, running = false, transferred = 0, count = 0, scanned = 0, lastFrom = -1, lastTo = -1;
        let plannedUnits = 0, delta = 0, insertion: { from: number; to: number; units: number; received: number; parts: string[] } | undefined;
        const release = (complete = false) => {
            if (active === job) {
                active = undefined;
                if (complete) source = { documentId, revision, buffer: buffer!, id: sourceId };
                else if (sent) terminate();
            }
            buffer = undefined; insertion = undefined;
        };
        const reject = (error: Error) => { failure = error; done = true; const active = pending; pending = undefined;
            if (active) { host.clock.clearTimeout(active.timer); active.reject(error); } release(); };
        const receive = (data: unknown) => {
            const value = decodeRegexMessage(data);
            if (!regexIdentity(value)) { reject(new Error("Malformed regex response.")); return; }
            if (value.id !== id || value.revision !== revision) return;
            const active = pending;
            if (!active || typeof value.operation !== "string") { reject(new Error("Unexpected regex response.")); return; }
            let reply: RegexReply;
            try { reply = readRegexReply(value); }
            catch (cause) { reject(cause as Error); return; }
            if (reply.operation === "regex-error") { reject(new Error(reply.message)); return; }
            pending = undefined; host.clock.clearTimeout(active.timer); active.resolve(reply);
        };
        const exchange = (command: RegexCommand): Promise<RegexReply> => new Promise((resolve, no) => {
            if (done || pending) { no(failure ?? new Error("Regex cursor is unavailable.")); return; }
            try {
                sent = true; connect(); pending = { resolve, reject: no, timer: host.clock.setTimeout(() => reject(new Error("Regex search timed out; narrow the expression.")), timeout) };
                const request: RegexRequest = { id, revision, ...command }; worker!.postMessage(JSON.stringify(request));
            } catch (cause) {
                const error = cause instanceof Error ? cause : new Error(String(cause));
                reject(error);
                no(error);
            }
        });
        const step = (finished: boolean, readUnits: number, matches: readonly SearchMatch[] = empty, edits: readonly TextEdit[] = noEdits): RegexCursorStep => Object.freeze({ done: finished, scanned, readUnits, matches, edits });
        const next = async (): Promise<RegexCursorStep> => {
            if (failure) throw failure;
            if (done) return step(true, 0);
            if (busy) throw new Error("Regex cursor already has a pending step.");
            busy = true;
            try {
                if (!started) {
                    const reuse = source?.documentId === documentId && source.revision === revision && source.buffer === buffer;
                    sourceId = reuse ? source!.id : id; if (!reuse) source = undefined;
                    const ack = await exchange({ operation: "regex-start", version: regexProtocolVersion, source: sourceId, length, pattern, matchCase, wholeWord: options.wholeWord ?? false,
                        ...(options.replacement === undefined ? {} : { replacement: options.replacement, maxOutputUnits: maxOutput }), ...(options.range ? { range: options.range } : {}) });
                    if (ack.operation !== "regex-progress" || ack.received !== (reuse ? length : 0)) throw new Error("Invalid regex start acknowledgement.");
                    if (ack.version !== regexProtocolVersion) throw new Error("Unsupported regex worker protocol version.");
                    started = true; transferred = ack.received; }
                if (done) throw new Error("Regex search cancelled.");
                if (transferred < length) {
                    const text = buffer!.slice(transferred, Math.min(length, transferred + regexChunkUnits)), ack = await exchange({ operation: "regex-chunk", from: transferred, text });
                    if (ack.operation !== "regex-progress" || ack.received !== transferred + text.length) throw new Error("Invalid regex transfer acknowledgement.");
                    transferred += text.length; return step(false, text.length);
                }
                const operation = running ? "regex-continue" : "regex-run"; running = true;
                const reply = await exchange({ operation });
                if (done || active !== job) throw new Error("Regex search cancelled.");
                if (reply.operation === "regex-done") {
                    if (insertion || reply.count !== count || options.range !== undefined && count !== 1) throw new Error("Invalid regex result count.");
                    if (options.replacement === undefined ? reply.outputLength !== undefined : reply.outputLength !== length + delta || length + delta > regexSourceLimit) throw new Error("Invalid regex result size.");
                    scanned = length; done = true; release(true); return step(true, 0);
                }
                let readUnits = 0;
                const split = (at: number) => { if (at <= 0 || at >= length) return false; const pair = buffer!.slice(at - 1, at + 1); readUnits += 2;
                    return splitsSurrogatePair(pair, 1); };
                const range = (value: SearchMatch): SearchMatch => {
                    // A global expression advances after every match, including an empty one.
                    if (value.to > length || value.from < lastTo || value.from === lastFrom || split(value.from) || split(value.to))
                        throw new Error("Invalid raw regex range.");
                    if (options.range && (value.from !== options.range.from || value.to !== options.range.to)) throw new Error("Invalid captured regex replacement range.");
                    lastFrom = value.from; lastTo = value.to; return Object.freeze({ from: value.from, to: value.to });
                };
                const reserve = (at: SearchMatch, units: number) => {
                    if (units > maxOutput - plannedUnits) throw new Error("Regex replacement output limit exceeded.");
                    plannedUnits += units; delta += units - (at.to - at.from);
                };
                if (options.replacement === undefined) {
                    if (reply.operation !== "regex-matches") throw new Error("Invalid regex result page.");
                    const matches = reply.matches.map(range); count += matches.length; scanned = Math.max(scanned, lastTo);
                    return step(false, readUnits, Object.freeze(matches));
                }
                if (insertion) {
                    if (reply.operation !== "regex-insert" || reply.ordinal !== count || reply.from !== insertion.received
                        || reply.text.length > insertion.units - insertion.received) throw new Error("Invalid regex insertion chunk.");
                    insertion.parts.push(reply.text); insertion.received += reply.text.length;
                    if (insertion.received < insertion.units) return step(false, 0);
                    const edit = Object.freeze({ from: insertion.from, to: insertion.to, insert: insertion.parts.join("") }); insertion = undefined;
                    count++; scanned = Math.max(scanned, edit.to); return step(false, 0, empty, Object.freeze([edit]));
                }
                if (reply.operation === "regex-edit") {
                    if (reply.ordinal !== count) throw new Error("Invalid regex insertion descriptor.");
                    const at = range(reply); reserve(at, reply.units); insertion = { ...at, units: reply.units, received: 0, parts: [] }; return step(false, readUnits);
                }
                if (reply.operation !== "regex-edits") throw new Error("Invalid regex edit page.");
                const edits: TextEdit[] = [];
                for (const value of reply.edits) {
                    const at = range(value); reserve(at, value.insert.length); count++; edits.push(Object.freeze({ ...at, insert: value.insert }));
                }
                scanned = Math.max(scanned, lastTo); return step(false, readUnits, empty, Object.freeze(edits));
            } catch (error) { const cause = error instanceof Error ? error : new Error("Regex search failed."); reject(cause); throw cause; }
            finally { busy = false; }
        };
        const dispose = () => { if (done) return; done = true; const active = pending; pending = undefined;
            if (active) { host.clock.clearTimeout(active.timer); active.reject(new Error("Regex search cancelled.")); } release(); };
        const job = { receive, reject, dispose }; active = job;
        return Object.freeze({ next, dispose,
            snapshot: () => Object.freeze({ id, revision, transferred, length, count, scanned, pending: pending !== undefined, done }) });
    };
    return Object.freeze({ createCursor, dispose: () => { if (disposed) return; disposed = true; active?.dispose(); terminate(); } });
}
