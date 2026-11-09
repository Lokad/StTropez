import type { DiffHunk } from "./diff.ts";
import type { TextBuffer } from "./text-buffer.ts";

/** Project a fractional source row through completed, ordered diff ranges. */
export function comparisonLine(hunks: readonly DiffHunk[], side: "baseline" | "working", line: number, baseline: TextBuffer, working: TextBuffer): number {
    if (!Number.isFinite(line)) throw new RangeError("Invalid comparison row.");
    const other = side === "baseline" ? "working" : "baseline", source = side === "baseline" ? baseline : working, target = side === "baseline" ? working : baseline;
    const at = Math.min(source.lineCount - 1, Math.max(0, line));
    let low = 0, high = hunks.length;
    while (low < high) { const middle = (low + high) >>> 1; if (hunks[middle]![side].lineFrom <= at) low = middle + 1; else high = middle; }
    const hunk = hunks[low - 1];
    if (!hunk) return Math.min(target.lineCount - 1, at);
    const from = hunk[side], to = hunk[other], sourceEnd = source.lineAt(from.to), targetEnd = target.lineAt(to.to), length = sourceEnd - from.lineFrom;
    // At a line-start insertion use the after edge. Inside a row retain its unchanged prefix;
    // a trailing deletion can otherwise move the final retained row to the deleted last row.
    if (!length && at < from.lineFrom + 1 && from.from !== source.offsetAt(from.lineFrom))
        return Math.min(target.lineCount - 1, Math.max(0, to.lineFrom + at - from.lineFrom));
    // Paint ranges have exclusive lineTo even for a same-row insertion. Raw end coordinates
    // retain the actual newline delta, including scalar-trimmed and unterminated hunks.
    const mapped = length && at < sourceEnd ? to.lineFrom + (at - from.lineFrom) * (targetEnd - to.lineFrom) / length : at + targetEnd - sourceEnd;
    return Math.min(target.lineCount - 1, Math.max(0, mapped));
}
