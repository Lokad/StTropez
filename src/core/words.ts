import type { TextBuffer } from "./text-buffer.ts";
import { highSurrogate as high, lowSurrogate as low } from "./utf16.ts";

export type WordStep = Readonly<{ status: "running" | "ready" | "cancelled"; offset: number | null; workUnits: number; readUnits: number }>;
type Kind = "word" | "space" | "symbol" | "extend";
type Unit = Readonly<{ from: number; to: number; kind: Kind }>;
type Counters = { work: number; yielded: number; reads: number };
const kind = (text: string): Kind => /^[\p{M}\u200c\u200d]$/u.test(text) ? "extend" : /^\p{White_Space}$/u.test(text) ? "space" : /^[\p{L}\p{N}\p{Pc}]$/u.test(text) ? "word" : "symbol";
function* units(buffer: TextBuffer, start: number, direction: -1 | 1, counters: Counters): Generator<Unit> {
    let offset = start;
    while (direction < 0 ? offset > 0 : offset < buffer.length) {
        let from = direction < 0 ? Math.max(0, offset - 256) : offset, to = direction < 0 ? offset : Math.min(buffer.length, offset + 256);
        let text = buffer.slice(from, to); counters.reads += text.length;
        if (direction > 0 && to < buffer.length && high(text.charCodeAt(text.length - 1))) {
            const next = buffer.slice(to, to + 1); counters.reads++;
            if (low(next.charCodeAt(0))) { text += next; to++; }
        } else if (direction < 0 && from > 0 && low(text.charCodeAt(0))) {
            const previous = buffer.slice(from - 1, from); counters.reads++;
            if (high(previous.charCodeAt(0))) { text = previous + text; from--; }
        }
        if (direction > 0) for (let index = 0; index < text.length;) {
            const width = high(text.charCodeAt(index)) && low(text.charCodeAt(index + 1)) ? 2 : 1;
            counters.work += width; yield { from: from + index, to: from + index + width, kind: kind(text.slice(index, index + width)) }; index += width;
        } else for (let end = text.length; end > 0;) {
            const width = low(text.charCodeAt(end - 1)) && high(text.charCodeAt(end - 2)) ? 2 : 1;
            counters.work += width; yield { from: from + end - width, to: from + end, kind: kind(text.slice(end - width, end)) }; end -= width;
        }
        offset = direction < 0 ? from : to;
    }
}
function* scan(buffer: TextBuffer, start: number, direction: -1 | 1, counters: Counters): Generator<void, number> {
    let current: Exclude<Kind, "extend"> | undefined, pending: number | undefined;
    for (const unit of units(buffer, start, direction, counters)) {
        if (counters.work - counters.yielded >= 256) { counters.yielded = counters.work; yield; }
        if (direction > 0) {
            const next = unit.kind === "extend" ? current ?? "symbol" : unit.kind;
            if (current !== undefined && next !== current) {
                if (next === "space" && current !== "space") current = "space";
                else return unit.from;
            } else current ??= next;
        } else {
            // Marks/join controls belong to their preceding base, which arrives later in reverse.
            if (unit.kind === "extend") { pending ??= unit.to; continue; }
            if (current !== undefined && unit.kind !== current) {
                if (current === "space") current = unit.kind;
                else return pending ?? unit.to;
            } else current ??= unit.kind;
            pending = undefined;
        }
    }
    return direction < 0 ? pending !== undefined && current === "word" ? pending : 0 : buffer.length;
}

/** Code-oriented word starts: Unicode letters/numbers/connectors, symbol runs, and whitespace. */
export class WordCursor {
    private iterator: Generator<void, number> | undefined;
    private readonly counters: Counters = { work: 0, yielded: 0, reads: 0 };
    private status: WordStep["status"] = "running";
    private offset: number | null = null;
    constructor(buffer: TextBuffer, offset: number, direction: -1 | 1) {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length || direction !== -1 && direction !== 1) throw new RangeError("Invalid word command target.");
        this.iterator = scan(buffer, offset, direction, this.counters);
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
