import type { TextBuffer } from "./text-buffer.ts";
import { wordConstituent } from "./words.ts";
import { highSurrogate as high, lowSurrogate as low } from "./utf16.ts";
export type SearchMatch = Readonly<{ from: number; to: number }>;
export type SearchStep = Readonly<{ done: boolean; scanned: number; readUnits: number; matches: readonly SearchMatch[] }>;
export type LiteralSearchOptions = Readonly<{ from?: number; to?: number; wholeWord?: boolean; matchCase?: boolean }>;

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
    private folded: CaseInsensitiveMatcher | undefined;
    private leading: { text: string; from: number } | undefined;
    private queued: { text: string; from: number } | undefined;
    constructor(buffer: TextBuffer, query: string, from: number | LiteralSearchOptions = 0, to = buffer.length) {
        if (typeof query !== "string") throw new TypeError("Expected a literal search string.");
        if (typeof from !== "number" && (typeof from !== "object" || from === null)) throw new TypeError("Expected search bounds or options.");
        const options = typeof from === "number" ? undefined : from, start = typeof from === "number" ? from : from.from ?? 0;
        if (options?.wholeWord !== undefined && typeof options.wholeWord !== "boolean") throw new TypeError("Expected a whole-word flag.");
        if (options?.matchCase !== undefined && typeof options.matchCase !== "boolean") throw new TypeError("Expected a match-case flag.");
        this.iterator = buffer.chunks(start, options?.to ?? to)[Symbol.iterator](); this.offset = start; this.query = query;
        if (options?.wholeWord) this.boundaryBuffer = buffer;
        if (options?.matchCase === false) this.folded = new CaseInsensitiveMatcher(query);
        this.prefix = new Uint32Array(this.folded ? 0 : query.length);
        for (let index = 1, length = 0; !this.folded && index < query.length; index++) {
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
                this.pending = undefined;
                if (this.folded) this.folded.settle(accepted); else this.matched = accepted ? 0 : this.prefix[this.query.length - 1]!;
                if (accepted) matches.push(pending.match);
                continue;
            }
            if (!this.folded) {
                if (this.index === this.chunk.length) {
                    const next = this.iterator!.next();
                    if (next.done) { this.dispose(); break; }
                    this.chunk = next.value; this.index = 0; if (!this.chunk.length) continue;
                }
                const carry = this.matched, end = Math.min(this.chunk.length, this.index + maxUnits - readUnits - carry);
                if (carry <= this.index && end - this.index >= this.query.length) {
                    // The unresolved prefix is in this piece. Bound the native call, including
                    // rereading that prefix; it cannot search an entire large backing at once.
                    const from = this.index - carry, found = this.chunk.slice(from, end).indexOf(this.query);
                    if (found < 0) {
                        // Only the final query.length - 1 units can start a match in the next
                        // window/piece. Stream that tail through KMP, charging its reread too.
                        const skipped = end - this.query.length + 1 - this.index;
                        this.index += skipped; this.offset += skipped; readUnits += end - from; this.matched = 0;
                        continue;
                    }
                    const consumed = found + this.query.length - carry;
                    this.index += consumed; this.offset += consumed; readUnits += consumed + carry; this.matched = this.query.length;
                } else {
                    const unit = this.chunk[this.index++]!; this.offset++; readUnits++;
                    while (this.matched && unit !== this.query[this.matched]) this.matched = this.prefix[this.matched - 1]!;
                    if (unit === this.query[this.matched]) this.matched++;
                }
                if (this.matched === this.query.length) {
                    const match = Object.freeze({ from: this.offset - this.query.length, to: this.offset });
                    if (this.boundaryBuffer) this.pending = { match, before: "", after: "" }; else { matches.push(match); this.matched = 0; }
                }
                continue;
            }
            let point = this.queued; this.queued = undefined;
            if (!point) {
                if (this.index === this.chunk.length) {
                    const next = this.iterator!.next();
                    if (next.done) {
                        if (this.leading) { point = this.leading; this.leading = undefined; }
                        else { this.dispose(); break; }
                    } else { this.chunk = next.value; this.index = 0; if (!this.chunk.length) continue; }
                }
                if (!point) {
                    const text = this.chunk[this.index++]!, from = this.offset++; readUnits++;
                    if (this.leading) {
                        point = this.leading; this.leading = undefined;
                        if (low(text.charCodeAt(0))) point = { text: point.text + text, from: point.from };
                        else if (high(text.charCodeAt(0))) this.leading = { text, from };
                        else this.queued = { text, from };
                    } else if (high(text.charCodeAt(0))) { this.leading = { text, from }; continue; }
                    else point = { text, from };
                }
            }
            const match = this.folded.push(point.text, point.from);
            if (match) {
                if (this.boundaryBuffer) this.pending = { match, before: "", after: "" };
                else { matches.push(match); this.folded.settle(true); }
            }
        }
        return Object.freeze({ done: this.done, scanned: this.offset, readUnits, matches: Object.freeze(matches) });
    }
    dispose(): void { this.done = true; this.iterator?.return?.(); this.iterator = undefined; this.chunk = ""; this.index = 0; this.pending = undefined; this.boundaryBuffer = undefined; this.folded = undefined; this.leading = undefined; this.queued = undefined; }
}

/** Same KMP search over code points; native fixed literals supply Unicode simple-fold equality.
 * No document normalization, general regular-expression execution or vendored folding table. */
class CaseInsensitiveMatcher {
    private readonly points: readonly string[];
    private readonly prefix: Uint32Array;
    private readonly starts: Float64Array;
    private readonly patterns = new Map<string, RegExp>();
    private matched = 0;
    private position = 0;
    constructor(query: string) {
        this.points = Array.from(query); this.prefix = new Uint32Array(this.points.length); this.starts = new Float64Array(this.points.length);
        for (let index = 1, length = 0; index < this.points.length; index++) {
            while (length && !this.same(this.points[index]!, this.points[length]!)) length = this.prefix[length - 1]!;
            if (this.same(this.points[index]!, this.points[length]!)) length++;
            this.prefix[index] = length;
        }
    }
    private same(a: string, b: string): boolean {
        if (a === b) return true;
        const x = a.codePointAt(0)!, y = b.codePointAt(0)!;
        if (x < 128 && y < 128) return (x >= 65 && x <= 90 ? x + 32 : x) === (y >= 65 && y <= 90 ? y + 32 : y);
        let pattern = this.patterns.get(a);
        if (!pattern) { pattern = new RegExp(`^\\u{${x.toString(16)}}$`, "iu"); this.patterns.set(a, pattern); }
        return pattern.test(b);
    }
    push(point: string, from: number): SearchMatch | undefined {
        this.starts[this.position] = from; this.position = (this.position + 1) % this.points.length;
        while (this.matched && !this.same(this.points[this.matched]!, point)) this.matched = this.prefix[this.matched - 1]!;
        if (this.same(this.points[this.matched]!, point)) this.matched++;
        return this.matched === this.points.length ? Object.freeze({ from: this.starts[this.position]!, to: from + point.length }) : undefined;
    }
    settle(accepted: boolean): void { this.matched = accepted ? 0 : this.prefix[this.points.length - 1]!; }
}
