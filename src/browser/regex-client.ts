import type { SearchMatch, SearchStep } from "../core/search.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import type { TextEdit } from "../core/changes.ts";
import { regexChunkUnits, regexMatchLimit, regexSourceLimit, regexProtocolVersion } from "./regex-session.ts";
type Reply = Readonly<{ operation: string; id: number; revision: number; received?: number; matches?: readonly SearchMatch[]; count?: number; message?: string;
    edits?: readonly TextEdit[]; ordinal?: number; from?: number; to?: number; units?: number; text?: string; outputLength?: number; version?: number }>;
type Pending = { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: number };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const empty: readonly SearchMatch[] = Object.freeze([]);
const noEdits: readonly TextEdit[] = Object.freeze([]);
export type RegexCursorStep = SearchStep & Readonly<{ edits: readonly TextEdit[] }>;
let sequence = 0;

/** Dedicated host worker cursor. The find owner captures identities/revisions and disposes
 * this cursor when its intent changes. One source chunk or result page is in flight at a time. */
export function createRegexCursor(input: TextBuffer, revision: number, pattern: string, matchCase: boolean,
    options: Readonly<{ clock: Pick<Window, "setTimeout" | "clearTimeout">; createWorker: () => Worker; timeoutMs?: number; wholeWord?: boolean;
        replacement?: string; range?: SearchMatch; maxOutputUnits?: number }>) {
    const timeout = options.timeoutMs ?? 5000, maxOutput = options.maxOutputUnits ?? regexSourceLimit;
    if (!integer(revision) || typeof pattern !== "string" || pattern.length > 4096 || typeof matchCase !== "boolean"
        || input.length > regexSourceLimit || !Number.isFinite(timeout) || timeout <= 0 || options.wholeWord !== undefined && typeof options.wholeWord !== "boolean") throw new RangeError("Unsupported regex capture or timeout.");
    if (options.replacement !== undefined && (typeof options.replacement !== "string" || options.replacement.length > regexChunkUnits)
        || !integer(maxOutput) || maxOutput > regexSourceLimit || options.range !== undefined && (options.replacement === undefined || !record(options.range)
            || !integer(options.range.from) || !integer(options.range.to) || options.range.to < options.range.from || options.range.to > input.length)) throw new RangeError("Unsupported regex replacement capture.");
    const id = ++sequence, length = input.length, listeners = new AbortController();
    let buffer: TextBuffer | undefined = input, worker: Worker | undefined, pending: Pending | undefined, failure: Error | undefined;
    let done = false, busy = false, started = false, running = false, transferred = 0, count = 0, scanned = 0, lastFrom = -1, lastTo = -1;
    let plannedUnits = 0, delta = 0, insertion: { from: number; to: number; units: number; received: number; parts: string[] } | undefined;
    const release = () => { listeners.abort(); worker?.terminate(); worker = undefined; buffer = undefined; insertion = undefined; };
    const reject = (error: Error) => { failure = error; done = true; const active = pending; pending = undefined;
        if (active) { options.clock.clearTimeout(active.timer); active.reject(error); } release(); };
    const connect = () => {
        if (worker) return;
        worker = options.createWorker();
        worker.addEventListener("error", event => { event.preventDefault(); reject(new Error("Regex worker failed; editing remains available.")); }, { signal: listeners.signal });
        worker.addEventListener("messageerror", () => reject(new Error("Regex worker response could not be decoded.")), { signal: listeners.signal });
        worker.addEventListener("message", (event: MessageEvent<unknown>) => {
            let value: unknown;
            try { if (typeof event.data !== "string" || event.data.length > 262144) throw new TypeError(); value = JSON.parse(event.data); }
            catch { reject(new Error("Malformed regex response.")); return; }
            if (!record(value) || !integer(value.id) || !integer(value.revision)) { reject(new Error("Malformed regex response.")); return; }
            if (value.id !== id || value.revision !== revision) return;
            const active = pending;
            if (!active || typeof value.operation !== "string") { reject(new Error("Unexpected regex response.")); return; }
            pending = undefined; options.clock.clearTimeout(active.timer);
            if (value.operation === "regex-error") { const error = new Error(typeof value.message === "string" && value.message.length <= 256 ? value.message : "Regex search failed.");
                active.reject(error); reject(error); return; }
            active.resolve(value as Reply);
        }, { signal: listeners.signal });
    };
    const exchange = (operation: string, fields: Readonly<Record<string, unknown>> = {}): Promise<Reply> => new Promise((resolve, no) => {
        if (done || pending) { no(failure ?? new Error("Regex cursor is unavailable.")); return; }
        try {
            connect(); pending = { resolve, reject: no, timer: options.clock.setTimeout(() => reject(new Error("Regex search timed out; narrow the expression.")), timeout) };
            worker!.postMessage(JSON.stringify({ operation, id, revision, ...fields }));
        } catch { const error = new Error("Regex worker is unavailable; editing remains available."); reject(error); no(error); }
    });
    const step = (finished: boolean, readUnits: number, matches: readonly SearchMatch[] = empty, edits: readonly TextEdit[] = noEdits): RegexCursorStep => Object.freeze({ done: finished, scanned, readUnits, matches, edits });
    const next = async (): Promise<RegexCursorStep> => {
        if (failure) throw failure;
        if (done) return step(true, 0);
        if (busy) throw new Error("Regex cursor already has a pending step.");
        busy = true;
        try {
            if (!started) { const ack = await exchange("regex-start", { version: regexProtocolVersion, length, pattern, matchCase, wholeWord: options.wholeWord ?? false,
                ...(options.replacement === undefined ? {} : { replacement: options.replacement, maxOutputUnits: maxOutput }), ...(options.range ? { range: options.range } : {}) });
                if (ack.operation !== "regex-progress" || ack.received !== 0) throw new Error("Invalid regex start acknowledgement.");
                if (ack.version !== regexProtocolVersion) throw new Error("Unsupported regex worker protocol version."); started = true; }
            if (done) throw new Error("Regex search cancelled.");
            if (transferred < length) {
                const text = buffer!.slice(transferred, Math.min(length, transferred + regexChunkUnits)), ack = await exchange("regex-chunk", { from: transferred, text });
                if (ack.operation !== "regex-progress" || ack.received !== transferred + text.length) throw new Error("Invalid regex transfer acknowledgement.");
                transferred += text.length; return step(false, text.length);
            }
            const operation = running ? "regex-continue" : "regex-run"; running = true;
            const reply = await exchange(operation);
            if (reply.operation === "regex-done") {
                if (insertion || reply.count !== count || options.range !== undefined && count !== 1) throw new Error("Invalid regex result count.");
                if (options.replacement === undefined ? reply.outputLength !== undefined : reply.outputLength !== length + delta || length + delta > regexSourceLimit) throw new Error("Invalid regex result size.");
                scanned = length; done = true; release(); return step(true, 0);
            }
            let readUnits = 0;
            const split = (at: number) => { if (at <= 0 || at >= length) return false; const pair = buffer!.slice(at - 1, at + 1); readUnits += 2;
                return /^[\ud800-\udbff][\udc00-\udfff]$/.test(pair); };
            const range = (value: unknown): SearchMatch => {
                if (!record(value) || !integer(value.from) || !integer(value.to) || value.to < value.from || value.to > length || value.from < lastTo
                    || value.from === lastFrom && value.to === lastTo || split(value.from) || split(value.to)) throw new Error("Invalid raw regex range.");
                if (options.range && (value.from !== options.range.from || value.to !== options.range.to)) throw new Error("Invalid captured regex replacement range.");
                lastFrom = value.from; lastTo = value.to; return Object.freeze({ from: value.from, to: value.to });
            };
            const reserve = (at: SearchMatch, units: number) => {
                if (units > maxOutput - plannedUnits || count >= regexMatchLimit) throw new Error("Regex replacement output limit exceeded.");
                plannedUnits += units; delta += units - (at.to - at.from);
            };
            if (options.replacement === undefined) {
                if (reply.operation !== "regex-matches" || !Array.isArray(reply.matches) || reply.matches.length === 0 || reply.matches.length > 512 || count + reply.matches.length > regexMatchLimit) throw new Error("Invalid regex result page.");
                const matches = reply.matches.map(range); count += matches.length; scanned = Math.max(scanned, lastTo);
                return step(false, readUnits, Object.freeze(matches));
            }
            if (insertion) {
                if (reply.operation !== "regex-insert" || reply.ordinal !== count || reply.from !== insertion.received || typeof reply.text !== "string"
                    || !reply.text.length || reply.text.length > regexChunkUnits || reply.text.length > insertion.units - insertion.received) throw new Error("Invalid regex insertion chunk.");
                insertion.parts.push(reply.text); insertion.received += reply.text.length;
                if (insertion.received < insertion.units) return step(false, 0);
                const edit = Object.freeze({ from: insertion.from, to: insertion.to, insert: insertion.parts.join("") }); insertion = undefined;
                count++; scanned = Math.max(scanned, edit.to); return step(false, 0, empty, Object.freeze([edit]));
            }
            if (reply.operation === "regex-edit") {
                if (reply.ordinal !== count || !integer(reply.units) || reply.units <= regexChunkUnits) throw new Error("Invalid regex insertion descriptor.");
                const at = range(reply); reserve(at, reply.units); insertion = { ...at, units: reply.units, received: 0, parts: [] }; return step(false, readUnits);
            }
            if (reply.operation !== "regex-edits" || !Array.isArray(reply.edits) || !reply.edits.length || reply.edits.length > 512) throw new Error("Invalid regex edit page.");
            let units = 0; const edits: TextEdit[] = [];
            for (const value of reply.edits as unknown[]) {
                if (!record(value) || typeof value.insert !== "string" || value.insert.length > regexChunkUnits - units) throw new Error("Invalid regex edit text.");
                const at = range(value); reserve(at, value.insert.length); units += value.insert.length; count++; edits.push(Object.freeze({ ...at, insert: value.insert }));
            }
            scanned = Math.max(scanned, lastTo); return step(false, readUnits, empty, Object.freeze(edits));
        } catch (error) { const cause = error instanceof Error ? error : new Error("Regex search failed."); reject(cause); throw cause; }
        finally { busy = false; }
    };
    return Object.freeze({ next, dispose: () => { if (done) return; done = true; const active = pending; pending = undefined;
        if (active) { options.clock.clearTimeout(active.timer); active.reject(new Error("Regex search cancelled.")); } release(); },
        snapshot: () => Object.freeze({ id, revision, transferred, length, count, scanned, pending: pending !== undefined, done }) });
}
