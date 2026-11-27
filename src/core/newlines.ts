import { applyTextEdits } from "./changes.ts";
import type { TextEdit } from "./changes.ts";
import { PositionMap } from "./positions.ts";

type LineReader = Readonly<{ lineCount: number; offsetAt(line: number): number; slice(from: number, to: number): string }>;

/** Start of a row, including the exclusive boundary after the last row. */
export function lineBoundary(buffer: LineReader & { readonly length: number }, line: number): number {
    return line < buffer.lineCount ? buffer.offsetAt(line) : buffer.length;
}

function endingBefore(buffer: LineReader, end: number): "\n" | "\r\n" {
    return end >= 2 && buffer.slice(end - 2, end) === "\r\n" ? "\r\n" : "\n";
}

/** Use this LF row's ending, or the preceding ending at EOF. */
export function lineEnding(buffer: LineReader, line: number): "\n" | "\r\n" {
    return endingBefore(buffer, buffer.offsetAt(line + 1 < buffer.lineCount ? line + 1 : line));
}

export function lineContentEnd(buffer: LineReader & { readonly length: number }, line: number): number {
    if (line + 1 === buffer.lineCount) return buffer.length;
    const next = buffer.offsetAt(line + 1);
    return next - endingBefore(buffer, next).length;
}

/** Preserve the surviving LF when mapping between raw document offsets and native textarea offsets. */
export function convertLineEndings(text: string, ending: "\n" | "\r\n") {
    const edits: TextEdit[] = [];
    for (const match of text.matchAll(/\r\n|\r|\n/g)) {
        if (match[0] === ending) continue;
        const from = match.index;
        if (match[0] === "\r\n") edits.push({ from, to: from + 1, insert: "" });
        else edits.push({ from, to: from + 1, insert: ending });
    }
    return { text: edits.length ? applyTextEdits(text, edits) : text, mapping: new PositionMap(text.length, edits) };
}
