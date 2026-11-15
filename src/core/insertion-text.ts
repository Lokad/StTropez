import { applyTextEdits } from "./changes.ts";
import { lineEnding } from "./language-edits.ts";
import { PositionMap } from "./positions.ts";
import type { TextBuffer } from "./text-buffer.ts";
import type { Affinity, PositionMapping } from "./positions.ts";

export type InsertionIndentation = Readonly<{ tabSize: number; insertSpaces: boolean }>;
export type InsertionContext = InsertionIndentation & Readonly<{ columns: number; lineEnding: "\n" | "\r\n" }>;
export type InsertionText = Readonly<{ text: string; mapping: PositionMapping;
    /** Annotation positions stay before line breaks and can exclude newly added indentation.
     * Positions inside whitespace compressed to a tab snap to its requested boundary. */
    mapPosition: (offset: number, affinity?: Affinity) => number }>;

function validateIndentation(value: InsertionIndentation): void {
    if (!Number.isSafeInteger(value.tabSize) || value.tabSize < 1 || value.tabSize > 256 || typeof value.insertSpaces !== "boolean")
        throw new RangeError("Invalid insertion indentation.");
}
/** Read only leading whitespace before the insertion, in bounded source slices. */
export function insertionContext(buffer: TextBuffer, offset: number, indentation: InsertionIndentation): InsertionContext {
    validateIndentation(indentation);
    const line = buffer.lineAt(offset), start = buffer.offsetAt(line); let columns = 0;
    outer: for (let at = start; at < offset; at += 4096) {
        const value = buffer.slice(at, Math.min(offset, at + 4096));
        for (const unit of value) {
            if (unit === " ") columns++;
            else if (unit === "\t") columns += indentation.tabSize - columns % indentation.tabSize;
            else break outer;
        }
    }
    return Object.freeze({ tabSize: indentation.tabSize, insertSpaces: indentation.insertSpaces, columns, lineEnding: lineEnding(buffer, line) });
}

/** Preserve the first line and relative indentation, adding the insertion line's indentation
 * to subsequent lines. Normalize their leading whitespace and LF/CRLF endings only. */
export function adjustInsertionText(value: string, context: InsertionContext, maxUnits = Number.MAX_SAFE_INTEGER): InsertionText {
    validateIndentation(context);
    if (typeof value !== "string" || !Number.isSafeInteger(context.columns) || context.columns < 0
        || context.lineEnding !== "\n" && context.lineEnding !== "\r\n" || !Number.isSafeInteger(maxUnits) || maxUnits < 0)
        throw new RangeError("Invalid insertion text context or limit.");
    const changes: { from: number; to: number; insert: string | number }[] = [];
    const runs: { from: number; to: number; columns: number; tabEnds: number[] }[] = [];
    let length = value.length;
    for (let end = value.indexOf("\n"); end >= 0; end = value.indexOf("\n", end + 1)) {
        const from = end > 0 && value[end - 1] === "\r" ? end - 1 : end;
        if (end + 1 - from !== context.lineEnding.length) {
            changes.push({ from, to: end + 1, insert: context.lineEnding }); length += context.lineEnding.length - (end + 1 - from);
        }
        let to = end + 1, columns = 0; const tabEnds: number[] = [];
        while (to < value.length) {
            if (value[to] === " ") columns++;
            else if (value[to] === "\t") { columns += context.tabSize - columns % context.tabSize; tabEnds.push(to + 1, columns); }
            else break;
            to++;
        }
        columns += context.columns;
        if (!Number.isSafeInteger(columns)) throw new RangeError("Adjusted insertion exceeds the insertion limit.");
        runs.push({ from: end + 1, to, columns, tabEnds });
        const tabs = context.insertSpaces ? 0 : Math.floor(columns / context.tabSize), spaces = context.insertSpaces ? columns : columns % context.tabSize;
        let same = to - end - 1 === tabs + spaces;
        for (let i = end + 1; same && i < to; i++) same = value[i] === (i - end - 1 < tabs ? "\t" : " ");
        if (!same) { changes.push({ from: end + 1, to, insert: columns }); length += tabs + spaces - (to - end - 1); }
    }
    // Validate the final size before constructing any expanded indentation. Later CRLF
    // contractions can offset earlier growth, so intermediate lengths are not limits.
    if (!Number.isSafeInteger(length) || length > maxUnits) throw new RangeError("Adjusted insertion exceeds the insertion limit.");
    const indents = new Map<number, string>();
    const edits = changes.map(change => {
        const columns = change.insert; if (typeof columns === "string") return { ...change, insert: columns };
        let insert = indents.get(columns);
        if (insert === undefined) { insert = context.insertSpaces ? " ".repeat(columns)
            : "\t".repeat(Math.floor(columns / context.tabSize)) + " ".repeat(columns % context.tabSize); indents.set(columns, insert); }
        return { from: change.from, to: change.to, insert };
    });
    const mapping = new PositionMap(value.length, edits), breaks = changes.filter(change => typeof change.insert === "string");
    const preceding = <T extends { from: number }>(items: readonly T[], offset: number): T | undefined => {
        let low = 0, high = items.length;
        while (low < high) { const mid = Math.floor((low + high) / 2); if (items[mid]!.from <= offset) low = mid + 1; else high = mid; }
        return items[low - 1];
    };
    const mapPosition = (offset: number, affinity: Affinity = "after"): number => {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length || affinity !== "before" && affinity !== "after") throw new RangeError("Invalid insertion marker.");
        const run = preceding(runs, offset);
        if (run && offset <= run.to) {
            const start = mapping.map(run.from, "before").offset;
            if (offset === run.from && affinity === "before") return start;
            let low = 0, high = run.tabEnds.length / 2;
            while (low < high) { const mid = Math.floor((low + high) / 2); if (run.tabEnds[mid * 2]! <= offset) low = mid + 1; else high = mid; }
            const columns = context.columns + (low ? run.tabEnds[(low - 1) * 2 + 1]! + offset - run.tabEnds[(low - 1) * 2]! : offset - run.from);
            if (context.insertSpaces) return start + columns;
            const tabs = Math.floor(run.columns / context.tabSize), tabColumns = tabs * context.tabSize;
            return start + (columns < tabColumns ? (affinity === "after" ? Math.ceil : Math.floor)(columns / context.tabSize) : tabs + columns - tabColumns);
        }
        const ending = preceding(breaks, offset);
        return ending && offset < ending.to ? mapping.map(ending.from, "before").offset : mapping.map(offset, affinity).offset;
    };
    return Object.freeze({ text: edits.length ? applyTextEdits(value, edits) : value, mapping, mapPosition });
}
