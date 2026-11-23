import { lineContentEnd, lineEnding } from "./newlines.ts";
import { collapsedLineBlock, type FoldIndex } from "./folding.ts";
import { PositionMap } from "./positions.ts";
import { mapSelectionRanges, planSelectionEdits } from "./selections.ts";
import type { SelectionEditPlan, SelectionSet } from "./selections.ts";
import type { TextBuffer } from "./text-buffer.ts";
import type { TextEdit } from "./changes.ts";

/** Carets on the same line copy or cut that line once. Group adjacent lines for the final EOF cut. */
export function copyCaretLines(buffer: TextBuffer, selections: SelectionSet, cut: boolean, folds?: FoldIndex) {
    const text: string[] = [], edits: TextEdit[] = [];
    let first = -1, last = -1;
    const flush = () => {
        const start = buffer.offsetAt(first), eof = last + 1 === buffer.lineCount;
        const end = eof ? buffer.length : buffer.offsetAt(last + 1);
        text.push(buffer.slice(start, end));
        if (eof) text.push(lineEnding(buffer, last));
        const from = eof && first > 0 ? lineContentEnd(buffer, first - 1) : start;
        if (cut && from < end) edits.push({ from, to: end, insert: "" });
    };
    for (const range of selections.ranges) {
        const line = buffer.lineAt(range.head), block = collapsedLineBlock(folds, line);
        const start = block?.lineFrom ?? line, end = block ? block.lineTo - 1 : line;
        if (end <= last) continue;
        if (first < 0 || start > last + 1) { if (first >= 0) flush(); first = start; }
        last = end;
    }
    flush();
    const selectionSet = edits.length ? mapSelectionRanges(new PositionMap(buffer.length, edits), selections, "after") : selections;
    return { text: text.join(""), edits, selectionSet };
}

function clipboardLines(text: string, count: number, includeEndings: boolean): string[] | undefined {
    if (count < 2) return;
    const lines: string[] = [], endings = /\r\n|[\r\n]/g;
    let start = 0, match: RegExpExecArray | null;
    while ((match = endings.exec(text))) {
        lines.push(text.slice(start, includeEndings ? endings.lastIndex : match.index));
        if (lines.length > count) return;
        start = endings.lastIndex;
    }
    if (!includeEndings || start < text.length) lines.push(text.slice(start));
    return lines.length === count ? lines : undefined;
}

export function planClipboardPaste(buffer: TextBuffer, selections: SelectionSet, text: string, wholeLines: boolean, preserve: boolean): SelectionEditPlan {
    const above = wholeLines && /[\r\n]$/.test(text) && selections.ranges.every(range => range.anchor === range.head);
    const parts = clipboardLines(text, selections.ranges.length, above);
    const edits: TextEdit[] = [], inserts: string[] = [];
    let lf: string | undefined, crlf: string | undefined, previousLine = -1;
    const normalize = !preserve && /[\r\n]/.test(text);
    if (!above && !parts && !normalize) return planSelectionEdits(buffer.length, selections, text);
    for (const [i, range] of selections.ranges.entries()) {
        const line = buffer.lineAt(Math.min(range.anchor, range.head));
        let insert = parts?.[i] ?? text;
        if (normalize) {
            const ending = lineEnding(buffer, line);
            if (parts) { if (above) insert = insert.replace(/\r\n|[\r\n]/g, ending); }
            else if (ending === "\n") insert = lf ??= text.replace(/\r\n?/g, "\n");
            else insert = crlf ??= text.replace(/\r\n|[\r\n]/g, "\r\n");
        }
        if (above) {
            if (parts || previousLine !== line) { const at = buffer.offsetAt(line); edits.push({ from: at, to: at, insert }); }
            previousLine = line;
        } else inserts.push(insert);
    }
    if (!above) return planSelectionEdits(buffer.length, selections, inserts);
    return { edits, selectionSet: mapSelectionRanges(new PositionMap(buffer.length, edits), selections, "after") };
}
