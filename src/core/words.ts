import type { TextBuffer } from "./text-buffer.ts";
import { highSurrogate as high, lowSurrogate as low } from "./utf16.ts";
import { validateWorkBudget } from "./kernel-cursor.ts";

export type WordStep = Readonly<{ status: "running" | "ready" | "cancelled"; offset: number | null; workUnits: number; readUnits: number }>;
export type WordOptions = Readonly<{ skipWhitespace?: boolean; from?: number; to?: number }>;
type Kind = "word" | "space" | "symbol" | "extend";
type Unit = Readonly<{ from: number; to: number; kind: Kind; control: boolean }>;
type Counters = { work: number; yielded: number; reads: number };
const extendPattern = "[\\p{M}\\u200c\\u200d]", basePattern = "[\\p{L}\\p{N}\\p{Pc}]";
/** One code point in the editor's code-word policy, for host-owned Unicode expressions. */
export const codeWordConstituentPattern = `(?:${basePattern}|${extendPattern})`;
const extendExpression = new RegExp(`^${extendPattern}$`, "u"), baseExpression = new RegExp(`^${basePattern}$`, "u");
const kind = (text: string): Kind => extendExpression.test(text) ? "extend" : /^\p{White_Space}$/u.test(text) ? "space" : baseExpression.test(text) ? "word" : "symbol";
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
        let from = direction < 0 ? Math.max(bounds.from, offset - 256) : offset, to = direction < 0 ? offset : Math.min(bounds.to, offset + 256);
        let text = buffer.slice(from, to); counters.reads += text.length;
        if (direction > 0 && to < bounds.to && high(text.charCodeAt(text.length - 1))) {
            const next = buffer.slice(to, to + 1); counters.reads++;
            if (low(next.charCodeAt(0))) { text += next; to++; }
        } else if (direction < 0 && from > bounds.from && low(text.charCodeAt(0))) {
            const previous = buffer.slice(from - 1, from); counters.reads++;
            if (high(previous.charCodeAt(0))) { text = previous + text; from--; }
        }
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

/** Code-oriented word starts. Set skipWhitespace:false for run edges within captured bounds.
 * Endpoints are raw UTF-16; a view supplies grapheme snapping and its logical-line bounds.
 */
export class WordCursor {
    private iterator: Generator<void, number> | undefined;
    private readonly counters: Counters = { work: 0, yielded: 0, reads: 0 };
    private status: WordStep["status"] = "running";
    private offset: number | null = null;
    constructor(buffer: TextBuffer, offset: number, direction: -1 | 1, options: WordOptions = {}) {
        const from = options.from ?? 0, to = options.to ?? buffer.length;
        if (![offset, from, to].every(Number.isSafeInteger) || from < 0 || from > offset || offset > to || to > buffer.length || direction !== -1 && direction !== 1) throw new RangeError("Invalid word command target.");
        this.iterator = scan(buffer, offset, direction, this.counters, { from, to }, options.skipWhitespace !== false);
    }
    next(maxWork = 4096): WordStep {
        validateWorkBudget(maxWork, "Word");
        const start = this.counters.work;
        while (this.iterator && this.counters.work - start < maxWork) {
            const next = this.iterator.next(); if (next.done) { this.offset = next.value; this.status = "ready"; this.iterator = undefined; }
        }
        return Object.freeze({ status: this.status, offset: this.offset, workUnits: this.counters.work, readUnits: this.counters.reads });
    }
    dispose(): void { this.iterator?.return(0); this.iterator = undefined; this.offset = null; this.status = "cancelled"; }
}
