import { LiteralSearch } from "../core/search.ts";
import type { SearchMatch, SearchStep } from "../core/search.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import { highSurrogate, lowSurrogate } from "../core/utf16.ts";
import { FindIndex } from "../core/find-index.ts";

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
