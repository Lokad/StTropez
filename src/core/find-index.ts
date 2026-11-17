import type { SearchMatch } from "./search.ts";
import { partitionPoint } from "./bound-search.ts";

type Page = { values: readonly number[]; begin: number; size: number; shift: number; end: number };
const pageSize = 1024;

/** Sorted, non-overlapping match offsets, without duplicate point matches.
 * Slices share sealed backing arrays; only the owned tail is mutable.
 * Adjacent small slices merge, so repeated local repairs cannot accumulate tiny pages. */
export class FindIndex {
    private readonly pages: Page[] = [];
    private tail: number[] | undefined;
    private length = 0;
    get count(): number { return this.length; }
    private pageAt(index: number): number {
        return partitionPoint(this.pages.length, at => this.pages[at]!.end <= index);
    }
    at(index: number): SearchMatch {
        if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) throw new RangeError("Invalid match index.");
        const page = this.pages[this.pageAt(index)]!, at = (page.begin + index - (page.end - page.size)) * 2;
        return { from: page.values[at]! + page.shift, to: page.values[at + 1]! + page.shift };
    }
    lowerBound(offset: number): number {
        const at = partitionPoint(this.pages.length, index => {
            const page = this.pages[index]!;
            return page.values[(page.begin + page.size - 1) * 2]! + page.shift < offset;
        });
        const page = this.pages[at]; if (!page) return this.length;
        return page.end - page.size + partitionPoint(page.size,
            index => page.values[(page.begin + index) * 2]! + page.shift < offset);
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
    /** Immutable matches intersecting [from, to). An empty interval returns only a point match there. */
    matchesIn(from: number, to: number): readonly SearchMatch[] {
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new RangeError("Invalid match range.");
        let first = this.lowerBound(from);
        if (first > 0 && this.at(first - 1).to > from) first--;
        const result: SearchMatch[] = [];
        for (let p = this.pageAt(first); p < this.pages.length; p++) {
            const page = this.pages[p]!;
            for (let i = first - (page.end - page.size); i < page.size; i++) {
                const at = (page.begin + i) * 2, start = page.values[at]! + page.shift, end = page.values[at + 1]! + page.shift;
                if (start > to || start === to && from !== to) return Object.freeze(result);
                if (start === end ? start >= from : from < to && end > from) result.push(Object.freeze({ from: start, to: end }));
            }
            first = page.end;
        }
        return Object.freeze(result);
    }
}
