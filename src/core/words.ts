import type { TextBuffer } from "./text-buffer.ts";
import { lineContentEnd } from "./newlines.ts";
import { readUtf16Window } from "./utf16.ts";
import { kernelCursor } from "./kernel-cursor.ts";
import type { KernelCursor, KernelStatus } from "./kernel-cursor.ts";

export type WordStep = Readonly<{ status: KernelStatus; offset: number | null; workUnits: number; readUnits: number; failure: string | null }>;
export type WordOptions = Readonly<{ skipWhitespace?: boolean; from?: number; to?: number }>;
type Kind = "word" | "space" | "symbol" | "extend";
type Unit = Readonly<{ from: number; to: number; kind: Kind; control: boolean }>;
type Counters = { work: number; yielded: number; reads: number };
const extendPattern = "[\\p{M}\\u200c\\u200d]", basePattern = "[\\p{L}\\p{N}\\p{Pc}]";
/** One code point in the editor's code-word policy, for host-owned Unicode expressions. */
export const codeWordConstituentPattern = `(?:${basePattern}|${extendPattern})`;
const extendExpression = new RegExp(`^${extendPattern}$`, "u"), baseExpression = new RegExp(`^${basePattern}$`, "u");
export const isCodeWordBase = (text: string): boolean => baseExpression.test(text);
const kind = (text: string): Kind => extendExpression.test(text) ? "extend" : /^\p{White_Space}$/u.test(text) ? "space" : isCodeWordBase(text) ? "word" : "symbol";
/** Search boundaries use the same code-word constituents, including attached marks/joiners. */
export const wordConstituent = (text: string): boolean => { const value = kind(text); return value === "word" || value === "extend"; };
const symbolPattern = "[^\\p{M}\\u200c\\u200d\\p{White_Space}\\p{L}\\p{N}\\p{Pc}]";
// A base and its attached marks have one class. Leading marks stay separate so the
// directional scan can attach them across windows and preserve whitespace/control rules.
const runExpression = new RegExp(`(${extendPattern}+)|(\\p{White_Space}+)|(${basePattern}(?:${basePattern}|${extendPattern})*)|(${symbolPattern}(?:${symbolPattern}|${extendPattern})*)`, "gu");
const spaceControl = (code: number): boolean => code >= 9 && code <= 13 || code === 0x85 || code === 0x2028 || code === 0x2029;
function* units(buffer: TextBuffer, start: number, direction: -1 | 1, counters: Counters, bounds: Readonly<{ from: number; to: number }>): Generator<Unit> {
    let offset = start;
    while (direction < 0 ? offset > bounds.from : offset < bounds.to) {
        const { from, to, text, readUnits } = readUtf16Window(buffer, offset, direction < 0 ? bounds.from : bounds.to, direction); counters.reads += readUnits;
        // matchAll owns its iteration state, so suspended cursors cannot interfere. Reverse
        // traversal retains only this bounded window, including at most one paired surrogate.
        const runs = text.matchAll(runExpression);
        for (const run of direction > 0 ? runs : [...runs].reverse()) {
            const type: Kind = run[1] ? "extend" : run[2] ? "space" : run[3] ? "word" : "symbol";
            const end = run.index + run[0].length;
            counters.work += run[0].length;
            yield { from: from + run.index, to: from + end, kind: type, control: type === "space" && spaceControl(text.charCodeAt(end - 1)) };
        }
        offset = direction < 0 ? from : to;
    }
}
function* scan(buffer: TextBuffer, start: number, direction: -1 | 1, counters: Counters, bounds: Readonly<{ from: number; to: number }>, skipWhitespace: boolean): Generator<void, number> {
    let current: Exclude<Kind, "extend"> | undefined, pending: number | undefined, afterControl = false;
    for (const unit of units(buffer, start, direction, counters, bounds)) {
        if (counters.work - counters.yielded >= 256) { counters.yielded = counters.work; yield; }
        if (direction > 0) {
            const next = unit.kind === "extend" ? !skipWhitespace && afterControl ? "symbol" : current ?? "symbol" : unit.kind;
            if (current !== undefined && next !== current) {
                if (skipWhitespace && next === "space" && current !== "space") current = "space";
                else return unit.from;
            } else current ??= next;
            afterControl = !skipWhitespace && unit.control;
        } else {
            // Marks/join controls belong to their preceding base, which arrives later in reverse.
            if (unit.kind === "extend") { pending ??= unit.to; continue; }
            if (!skipWhitespace && pending !== undefined && unit.control) return current === undefined || current === "symbol" ? unit.to : pending;
            if (current !== undefined && unit.kind !== current) {
                if (skipWhitespace && current === "space") current = unit.kind;
                else return pending ?? unit.to;
            } else current ??= unit.kind;
            pending = undefined;
        }
    }
    return direction < 0 ? pending !== undefined && current === "word" ? pending : bounds.from : bounds.to;
}

function* commandOffset(buffer: TextBuffer, offset: number, direction: -1 | 1, deleting: boolean, counters: Counters): Generator<void, number> {
    let line = buffer.lineAt(offset), from = buffer.offsetAt(line), to = lineContentEnd(buffer, line);
    let start = Math.min(offset, to);
    const crossing = direction > 0 ? start === to : start === from;
    if (crossing) {
        line += direction;
        if (line < 0 || line >= buffer.lineCount) return start;
        from = buffer.offsetAt(line); to = lineContentEnd(buffer, line); start = direction < 0 ? to : from;
        if (deleting && direction < 0) return to;
    }
    const bound = direction < 0 ? from : to;
    const adjacentKind = (at: number): Kind | undefined => {
        if (at === bound) return;
        const text = direction < 0 ? buffer.slice(Math.max(from, at - 2), at) : buffer.slice(at, Math.min(to, at + 2));
        counters.reads += text.length;
        return kind(direction < 0 ? Array.from(text).at(-1)! : String.fromCodePoint(text.codePointAt(0)!));
    };
    const run = (at: number) => scan(buffer, at, direction, counters, { from, to }, false);
    let type = adjacentKind(start);
    if (type === "space") {
        const end = yield* run(start);
        if (deleting && (crossing || Math.abs(start - end) >= 2)) return end;
        start = end; type = adjacentKind(start);
    }
    if (!type || deleting && crossing) return start;
    const end = yield* run(start);
    // In member access, one press from a separator reaches the adjoining identifier.
    if (!deleting && type === "symbol" && Math.abs(end - start) === 1 && adjacentKind(end) === "word") return yield* run(end);
    return end;
}

function wordDriver(work: Generator<void, number>, counters: Counters): KernelCursor<WordStep> {
    return kernelCursor(work, () => counters.work, (status, offset, failure): WordStep =>
        Object.freeze({ status, offset, failure, workUnits: counters.work, readUnits: counters.reads }), "Word");
}

/** Keyboard commands stop at logical line boundaries. The editor snaps both ends to graphemes. */
export function createWordCommandCursor(buffer: TextBuffer, offset: number, direction: -1 | 1, deleting: boolean): KernelCursor<WordStep> {
    const counters: Counters = { work: 0, yielded: 0, reads: 0 };
    return wordDriver(commandOffset(buffer, offset, direction, deleting, counters), counters);
}

/** Code-oriented word starts. Set skipWhitespace:false for run edges within captured bounds.
 * Endpoints are raw UTF-16; a view supplies grapheme snapping and its logical-line bounds.
 */
export class WordCursor {
    private readonly driver: KernelCursor<WordStep>;
    constructor(buffer: TextBuffer, offset: number, direction: -1 | 1, options: WordOptions = {}) {
        const from = options.from ?? 0, to = options.to ?? buffer.length;
        if (![offset, from, to].every(Number.isSafeInteger) || from < 0 || from > offset || offset > to || to > buffer.length) throw new RangeError("Invalid word command target.");
        const counters: Counters = { work: 0, yielded: 0, reads: 0 };
        this.driver = wordDriver(scan(buffer, offset, direction, counters, { from, to }, options.skipWhitespace !== false), counters);
    }
    next(maxWork = 4096): WordStep { return this.driver.next(maxWork); }
    snapshot(): WordStep { return this.driver.snapshot(); }
    dispose(): void { this.driver.dispose(); }
}
