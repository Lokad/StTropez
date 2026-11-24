import { emptyList } from "../core/empty-list.ts";
import { LiteralSearch } from "../core/search.ts";
import type { SearchMatch, SearchStep } from "../core/search.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import { highSurrogate, lowSurrogate } from "../core/utf16.ts";
import { FindIndex } from "../core/find-index.ts";

/** A literal cannot cross an unchanged line break unless the query contains one.
 * Elsewhere, an accepted old match in unchanged text proves the same non-overlap state. */
export class LiteralFindRepair {
    private readonly building = new FindIndex();
    private retained: FindIndex | undefined;
    readonly start: number;
    readonly prefixCount: number;
    readonly suffixStart: number;
    private readonly suffixIndex: number;
    private readonly search: LiteralSearch;
    private readonly old: FindIndex;
    private readonly delta: number;
    private readonly suffixFrom: number;
    private readonly length: number;
    private done = false;
    constructor(buffer: TextBuffer, query: string, options: { wholeWord: boolean; matchCase: boolean }, old: FindIndex,
        oldLength: number, edges: { prefix: number; suffix: number }) {
        // A line break or a case-folded code point may occupy two source units.
        const variableWidth = !options.matchCase || query.includes("\n");
        let cutoff = Math.max(0, edges.prefix - query.length * (variableWidth ? 2 : 1) - 2);
        if (variableWidth && cutoff > 0 && cutoff < buffer.length) {
            const seam = buffer.slice(cutoff - 1, cutoff + 1);
            if (seam === "\r\n" || highSurrogate(seam.charCodeAt(0)) && lowSurrogate(seam.charCodeAt(1))) cutoff--;
        }
        const prefix = this.prefixCount = old.lowerBound(cutoff); this.building.appendRange(old, 0, prefix);
        // Include a known match crossing the cutoff. Otherwise no accepted old match
        // crosses it; any unresolved earlier prefix ends before the changed context.
        this.start = Math.max(cutoff, prefix ? old.at(prefix - 1).to : 0);
        this.old = old; this.delta = buffer.length - oldLength; this.suffixFrom = oldLength - edges.suffix + 2; this.length = buffer.length;
        const nextLine = buffer.lineAt(buffer.length - edges.suffix) + 1;
        this.suffixStart = !/[\r\n]/.test(query) && nextLine < buffer.lineCount ? buffer.offsetAt(nextLine) : buffer.length;
        this.suffixIndex = old.lowerBound(this.suffixStart - this.delta);
        this.search = new LiteralSearch(buffer, query, { ...options, from: this.start, to: this.suffixStart, lineEndings: "equivalent" });
    }
    get index(): FindIndex {
        if (this.done || this.suffixIndex === this.old.count) return this.building;
        // Keep ordinals on either side stable while the interior is being rescanned.
        if (!this.retained) {
            this.retained = new FindIndex();
            this.retained.appendRange(this.old, 0, this.prefixCount);
            this.retained.appendRange(this.old, this.suffixIndex, this.old.count, this.delta);
        }
        return this.retained;
    }
    get hasRetainedSuffix(): boolean {
        return !this.done && this.suffixIndex < this.old.count;
    }
    next(maxUnits = 4096, maxMatches = 64): SearchStep {
        if (this.done) return Object.freeze({ done: true, scanned: this.length, readUnits: 0, matches: emptyList });
        const result = this.search.next(maxUnits, maxMatches), accepted: SearchMatch[] = [];
        for (const match of result.matches) {
            this.building.append(match); accepted.push(match);
            const from = match.from - this.delta;
            if (from < this.suffixFrom) continue;
            const index = this.old.lowerBound(from), old = index < this.old.count ? this.old.at(index) : undefined;
            if (old?.from !== from || old.to + this.delta !== match.to) continue;
            this.building.appendRange(this.old, index + 1, this.old.count, this.delta); this.done = true; this.search.dispose(); break;
        }
        if (result.done && !this.done) {
            this.building.appendRange(this.old, this.suffixIndex, this.old.count, this.delta); this.done = true;
        }
        return Object.freeze({ done: this.done, scanned: this.done ? this.length : result.scanned, readUnits: result.readUnits, matches: Object.freeze(accepted) });
    }
    dispose(): void { this.search.dispose(); this.done = true; }
}
