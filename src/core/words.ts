import type { TextBuffer } from "./text-buffer.ts";
import { highSurrogate as high, lowSurrogate as low } from "./utf16.ts";

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
const asciiKind = (code: number): Exclude<Kind, "extend"> => code === 32 || code >= 9 && code <= 13 ? "space"
    : code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 95 ? "word" : "symbol";
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
        if (direction > 0) for (let index = 0; index < text.length;) {
            if (text.charCodeAt(index) < 128) {
                const type = asciiKind(text.charCodeAt(index)); let end = index + 1;
                while (end < text.length && text.charCodeAt(end) < 128 && asciiKind(text.charCodeAt(end)) === type) end++;
                counters.work += end - index; yield { from: from + index, to: from + end, kind: type, control: type === "space" && text.charCodeAt(end - 1) >= 9 && text.charCodeAt(end - 1) <= 13 }; index = end; continue;
            }
            const width = high(text.charCodeAt(index)) && low(text.charCodeAt(index + 1)) ? 2 : 1;
            const value = text.slice(index, index + width);
            counters.work += width; yield { from: from + index, to: from + index + width, kind: kind(value), control: /^[\u0085\u2028\u2029]$/u.test(value) }; index += width;
        } else for (let end = text.length; end > 0;) {
            if (text.charCodeAt(end - 1) < 128) {
                const type = asciiKind(text.charCodeAt(end - 1)); let index = end - 1;
                while (index > 0 && text.charCodeAt(index - 1) < 128 && asciiKind(text.charCodeAt(index - 1)) === type) index--;
                counters.work += end - index; yield { from: from + index, to: from + end, kind: type, control: type === "space" && text.charCodeAt(end - 1) >= 9 && text.charCodeAt(end - 1) <= 13 }; end = index; continue;
            }
            const width = low(text.charCodeAt(end - 1)) && high(text.charCodeAt(end - 2)) ? 2 : 1;
            const value = text.slice(end - width, end);
            counters.work += width; yield { from: from + end - width, to: from + end, kind: kind(value), control: /^[\u0085\u2028\u2029]$/u.test(value) }; end -= width;
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
        if (!Number.isSafeInteger(maxWork) || maxWork < 256) throw new RangeError("Word budget must be an integer of at least 256 units.");
        const start = this.counters.work;
        while (this.iterator && this.counters.work - start < maxWork) {
            const next = this.iterator.next(); if (next.done) { this.offset = next.value; this.status = "ready"; this.iterator = undefined; }
        }
        return Object.freeze({ status: this.status, offset: this.offset, workUnits: this.counters.work, readUnits: this.counters.reads });
    }
    dispose(): void { this.iterator?.return(0); this.iterator = undefined; this.offset = null; this.status = "cancelled"; }
}
