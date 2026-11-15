import { LiteralSearch } from "../core/search.ts";
import type { SearchMatch, SearchStep } from "../core/search.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import { highSurrogate, lowSurrogate } from "../core/utf16.ts";

type Page = { values: readonly number[]; begin: number; size: number; shift: number; end: number };
const pageSize = 1024;

/** Paged match offsets. Slices share sealed backing arrays; only the owned tail is mutable.
 * Adjacent small slices merge, so repeated local repairs cannot accumulate tiny pages. */
export class FindIndex {
    private readonly pages: Page[] = [];
    private tail: number[] | undefined;
    private length = 0;
    get count(): number { return this.length; }
    private pageAt(index: number): number {
        let low = 0, high = this.pages.length;
        while (low < high) { const mid = Math.floor((low + high) / 2); if (this.pages[mid]!.end <= index) low = mid + 1; else high = mid; }
        return low;
    }
    at(index: number): SearchMatch {
        if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) throw new RangeError("Invalid match index.");
        const page = this.pages[this.pageAt(index)]!, at = (page.begin + index - (page.end - page.size)) * 2;
        return { from: page.values[at]! + page.shift, to: page.values[at + 1]! + page.shift };
    }
    lowerBound(offset: number): number {
        let low = 0, high = this.length;
        while (low < high) { const mid = Math.floor((low + high) / 2); if (this.at(mid).from < offset) low = mid + 1; else high = mid; }
        return low;
    }
    append(match: SearchMatch): void {
        let page = this.pages.at(-1);
        if (!page || page.size === pageSize) {
            this.tail = []; page = { values: this.tail, begin: 0, size: 0, shift: 0, end: this.length }; this.pages.push(page);
        } else if (!this.tail) {
            this.tail = [];
            for (let i = 0; i < page.size * 2; i++) this.tail.push(page.values[page.begin * 2 + i]! + page.shift);
            page.values = this.tail; page.begin = 0; page.shift = 0;
        }
        this.tail!.push(match.from, match.to); page.size++; page.end++; this.length++;
    }
    appendRange(source: FindIndex, from = 0, to = source.count, shift = 0): void {
        if (source === this || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > source.count) throw new RangeError("Invalid match slice.");
        source.tail = undefined;
        for (let i = source.pageAt(from); from < to; i++) {
            const page = source.pages[i]!, local = from - (page.end - page.size), size = Math.min(page.size - local, to - from);
            const begin = page.begin + local, delta = page.shift + shift, last = this.pages.at(-1);
            if (last && last.size + size <= pageSize) {
                for (let j = 0; j < size; j++) this.append({ from: page.values[(begin + j) * 2]! + delta, to: page.values[(begin + j) * 2 + 1]! + delta });
            } else {
                this.length += size; this.pages.push({ values: page.values, begin, size, shift: delta, end: this.length }); this.tail = undefined;
            }
            from += size;
        }
    }
    preview(limit = 200): readonly SearchMatch[] {
        return Object.freeze(Array.from({ length: Math.min(limit, this.length) }, (_, i) => Object.freeze(this.at(i))));
    }
}

/** Repair one conservative change hull, retaining an exact prefix and reusing a suffix only
 * after a fresh accepted match proves the same non-overlap state in unchanged text. */
export class LiteralFindRepair {
    readonly index = new FindIndex();
    readonly start: number;
    private readonly search: LiteralSearch;
    private readonly old: FindIndex;
    private readonly delta: number;
    private readonly suffixFrom: number;
    private readonly length: number;
    private done = false;
    constructor(buffer: TextBuffer, query: string, options: { wholeWord: boolean; matchCase: boolean }, old: FindIndex,
        oldLength: number, edges: { prefix: number; suffix: number }) {
        // Simple folding preserves code-point count, with at most two UTF-16 units per
        // point. Two additional units protect whole-word and split-surrogate boundaries.
        let cutoff = Math.max(0, edges.prefix - query.length * (options.matchCase ? 1 : 2) - 2);
        if (!options.matchCase && cutoff > 0 && cutoff < buffer.length) {
            const seam = buffer.slice(cutoff - 1, cutoff + 1);
            // A bounded caseless scan treats a clipped low surrogate literally. Keep
            // the full-document code-point boundary when choosing an internal start.
            if (highSurrogate(seam.charCodeAt(0)) && lowSurrogate(seam.charCodeAt(1))) cutoff--;
        }
        const prefix = old.lowerBound(cutoff); this.index.appendRange(old, 0, prefix);
        // Include a known match crossing the cutoff. Otherwise no accepted old match
        // crosses it; any unresolved earlier prefix ends before the changed context.
        this.start = Math.max(cutoff, prefix ? old.at(prefix - 1).to : 0);
        this.old = old; this.delta = buffer.length - oldLength; this.suffixFrom = oldLength - edges.suffix + 2; this.length = buffer.length;
        this.search = new LiteralSearch(buffer, query, { ...options, from: this.start });
    }
    next(maxUnits = 4096, maxMatches = 64): SearchStep {
        if (this.done) return Object.freeze({ done: true, scanned: this.length, readUnits: 0, matches: Object.freeze([]) });
        const result = this.search.next(maxUnits, maxMatches), accepted: SearchMatch[] = [];
        for (const match of result.matches) {
            this.index.append(match); accepted.push(match);
            const from = match.from - this.delta;
            if (from < this.suffixFrom) continue;
            const index = this.old.lowerBound(from), old = index < this.old.count ? this.old.at(index) : undefined;
            if (old?.from !== from || old.to + this.delta !== match.to) continue;
            this.index.appendRange(this.old, index + 1, this.old.count, this.delta); this.done = true; this.search.dispose(); break;
        }
        if (result.done) this.done = true;
        return Object.freeze({ done: this.done, scanned: this.done ? this.length : result.scanned, readUnits: result.readUnits, matches: Object.freeze(accepted) });
    }
    dispose(): void { this.search.dispose(); this.done = true; }
}
