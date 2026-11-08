import type { TextBuffer } from "./text-buffer.ts";
import { wordConstituent } from "./words.ts";
import { highSurrogate as high, lowSurrogate as low } from "./utf16.ts";
export type SearchMatch = Readonly<{ from: number; to: number }>;
export type SearchStep = Readonly<{ done: boolean; scanned: number; readUnits: number; matches: readonly SearchMatch[] }>;
export type LiteralSearchOptions = Readonly<{ from?: number; to?: number; wholeWord?: boolean }>;

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
    private boundaryBuffer: TextBuffer | undefined;
    private pending: { match: SearchMatch; before: string; after: string } | undefined;
    constructor(buffer: TextBuffer, query: string, from: number | LiteralSearchOptions = 0, to = buffer.length) {
        if (typeof query !== "string") throw new TypeError("Expected a literal search string.");
        if (typeof from !== "number" && (typeof from !== "object" || from === null)) throw new TypeError("Expected search bounds or options.");
        const options = typeof from === "number" ? undefined : from, start = typeof from === "number" ? from : from.from ?? 0;
        if (options?.wholeWord !== undefined && typeof options.wholeWord !== "boolean") throw new TypeError("Expected a whole-word flag.");
        this.iterator = buffer.chunks(start, options?.to ?? to)[Symbol.iterator](); this.offset = start; this.query = query;
        if (options?.wholeWord) this.boundaryBuffer = buffer;
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
            if (this.pending) {
                const pending = this.pending, buffer = this.boundaryBuffer!, before = Math.min(2, pending.match.from), after = Math.min(2, buffer.length - pending.match.to);
                if (pending.before.length < before) {
                    const from = pending.match.from - before + pending.before.length, length = Math.min(before - pending.before.length, maxUnits - readUnits);
                    pending.before += buffer.slice(from, from + length); readUnits += length;
                    if (pending.before.length < before || readUnits === maxUnits) continue;
                }
                if (pending.after.length < after) {
                    const from = pending.match.to + pending.after.length, length = Math.min(after - pending.after.length, maxUnits - readUnits);
                    pending.after += buffer.slice(from, from + length); readUnits += length;
                    if (pending.after.length < after || readUnits === maxUnits) continue;
                }
                const prior = pending.before, following = pending.after, last = prior.charCodeAt(prior.length - 1), first = following.charCodeAt(0);
                const beforeText = low(last) && high(prior.charCodeAt(prior.length - 2)) ? prior.slice(-2) : prior.slice(-1);
                const afterText = high(first) && low(following.charCodeAt(1)) ? following.slice(0, 2) : following.slice(0, 1);
                const splitPair = low(this.query.charCodeAt(0)) && high(last) || high(this.query.charCodeAt(this.query.length - 1)) && low(first);
                const accepted = !splitPair && !wordConstituent(beforeText) && !wordConstituent(afterText);
                this.pending = undefined; this.matched = accepted ? 0 : this.prefix[this.query.length - 1]!;
                if (accepted) matches.push(pending.match);
                continue;
            }
            if (this.index === this.chunk.length) {
                const next = this.iterator!.next();
                if (next.done) { this.dispose(); break; }
                this.chunk = next.value; this.index = 0; if (!this.chunk.length) continue;
            }
            const unit = this.chunk[this.index++]!; this.offset++; readUnits++;
            while (this.matched && unit !== this.query[this.matched]) this.matched = this.prefix[this.matched - 1]!;
            if (unit === this.query[this.matched]) this.matched++;
            if (this.matched === this.query.length) {
                const match = Object.freeze({ from: this.offset - this.query.length, to: this.offset });
                if (this.boundaryBuffer) this.pending = { match, before: "", after: "" };
                else { matches.push(match); this.matched = 0; }
            }
        }
        return Object.freeze({ done: this.done, scanned: this.offset, readUnits, matches: Object.freeze(matches) });
    }
    dispose(): void { this.done = true; this.iterator?.return?.(); this.iterator = undefined; this.chunk = ""; this.index = 0; this.pending = undefined; this.boundaryBuffer = undefined; }
}
