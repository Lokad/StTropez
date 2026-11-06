import type { TextBuffer } from "./text-buffer.ts";
export type SearchMatch = Readonly<{ from: number; to: number }>;
export type SearchStep = Readonly<{ done: boolean; scanned: number; readUnits: number; matches: readonly SearchMatch[] }>;

/** Non-overlapping literal UTF-16 matches over immutable pieces. The caller supplies scheduling. */
export class LiteralSearch {
    private iterator: Iterator<string> | undefined;
    private chunk = "";
    private index = 0;
    private offset: number;
    private matched = 0;
    private readonly prefix: Uint32Array;
    private readonly query: string;
    private done = false;
    constructor(buffer: TextBuffer, query: string, from = 0, to = buffer.length) {
        if (typeof query !== "string") throw new TypeError("Expected a literal search string.");
        this.iterator = buffer.chunks(from, to)[Symbol.iterator](); this.offset = from; this.query = query;
        this.prefix = new Uint32Array(query.length);
        for (let index = 1, length = 0; index < query.length; index++) {
            while (length && query[index] !== query[length]) length = this.prefix[length - 1]!;
            if (query[index] === query[length]) length++;
            this.prefix[index] = length;
        }
        if (!query.length) this.dispose();
    }
    next(maxUnits = 32_768, maxMatches = 8_192): SearchStep {
        if (![maxUnits, maxMatches].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError("Search budgets must be positive integers.");
        const matches: SearchMatch[] = []; let readUnits = 0;
        while (!this.done && readUnits < maxUnits && matches.length < maxMatches) {
            if (this.index === this.chunk.length) {
                const next = this.iterator!.next();
                if (next.done) { this.dispose(); break; }
                this.chunk = next.value; this.index = 0; if (!this.chunk.length) continue;
            }
            const unit = this.chunk[this.index++]!; this.offset++; readUnits++;
            while (this.matched && unit !== this.query[this.matched]) this.matched = this.prefix[this.matched - 1]!;
            if (unit === this.query[this.matched]) this.matched++;
            if (this.matched === this.query.length) {
                matches.push(Object.freeze({ from: this.offset - this.query.length, to: this.offset })); this.matched = 0;
            }
        }
        return Object.freeze({ done: this.done, scanned: this.offset, readUnits, matches: Object.freeze(matches) });
    }
    dispose(): void { this.done = true; this.iterator?.return?.(); this.iterator = undefined; this.chunk = ""; this.index = 0; }
}
