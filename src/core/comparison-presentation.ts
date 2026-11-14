import { unchangedPositionEdges } from "./positions.ts";
import type { PositionMapping } from "./positions.ts";
import type { TextBuffer } from "./text-buffer.ts";
import type { DiffHunk, DiffRange } from "./diff.ts";

/** Presentation only: mapped prior differences are not a new exact alignment or edit plan. */
export function mapComparisonHunks(baseline: TextBuffer, before: TextBuffer, after: TextBuffer, mapping: PositionMapping, hunks: readonly DiffHunk[]): readonly DiffHunk[] {
    if (!hunks.length) return hunks;
    const edges = unchangedPositionEdges(mapping), suffix = before.length - (edges?.suffix ?? 0);
    const units = after.length - before.length, lines = after.lineCount - before.lineCount, result: DiffHunk[] = [];
    for (const hunk of hunks) {
        const r = hunk.working; let working: DiffRange, whitespaceOnly = hunk.whitespaceOnly;
        // Strict boundaries include new typing at either edge of an existing change.
        if (edges && r.to < edges.prefix) working = r;
        else if (edges && r.from > suffix) working = units === 0 && lines === 0 ? r
            : Object.freeze({ from: r.from + units, to: r.to + units, lineFrom: r.lineFrom + lines, lineTo: r.lineTo + lines });
        else {
            const from = mapping.map(r.from, "before").offset, to = Math.max(from, mapping.map(r.to, "after").offset), lineFrom = after.lineAt(from);
            working = Object.freeze({ from, to, lineFrom, lineTo: from === to ? lineFrom : after.lineAt(to - 1) + 1 });
            whitespaceOnly = false; // Text inside this provisional range has not been classified.
        }
        const previous = result.at(-1);
        if (previous && (previous.working.to >= working.from || Math.max(previous.working.lineFrom + 1, previous.working.lineTo) > working.lineFrom)) {
            // Deletion can collapse changes onto one boundary or join their rows while
            // leaving unchanged text between them. The viewport's row lookup needs one
            // projected range per row; include the intervening reference span as well.
            const merge = (buffer: TextBuffer, first: DiffRange, last: DiffRange): DiffRange => Object.freeze({ from: first.from, to: last.to,
                lineFrom: first.lineFrom, lineTo: first.from === last.to ? first.lineFrom : buffer.lineAt(last.to - 1) + 1 });
            result[result.length - 1] = Object.freeze({ baseline: merge(baseline, previous.baseline, hunk.baseline),
                working: merge(after, previous.working, working), whitespaceOnly: false });
        } else result.push(working === r && whitespaceOnly === hunk.whitespaceOnly ? hunk : Object.freeze({ ...hunk, working, whitespaceOnly }));
    }
    return Object.freeze(result);
}
