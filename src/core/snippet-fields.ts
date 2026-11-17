import type { Affinity } from "./positions.ts";
import type { TextEdit } from "./changes.ts";
import type { InsertionIndentation } from "./insertion-text.ts";
import { partitionPoint } from "./bound-search.ts";

type Line = { from: number; body: number; to: number; end: number; columns: number };
const columns = (text: string, from: number, to: number, tabSize: number) => {
    let result = 0;
    for (let at = from; at < to; at++) result += text[at] === "\t" ? tabSize - result % tabSize : 1;
    return result;
};
function lines(text: string, tabSize: number): Line[] {
    const result: Line[] = []; let from = 0;
    for (;;) {
        const newline = text.indexOf("\n", from), end = newline < 0 ? text.length : newline + 1;
        const to = newline < 0 ? end : newline > from && text[newline - 1] === "\r" ? newline - 1 : newline;
        let body = from; while (body < to && (text[body] === " " || text[body] === "\t")) body++;
        result.push({ from, body, to, end, columns: columns(text, from, body, tabSize) });
        if (newline < 0) return result; from = end;
    }
}
/** Corresponding field bodies stay exact; only leading whitespace and LF/CRLF may differ.
 * This also works after literal multiline paste, whose new lines need no contextual shift. */
export function snippetFieldMapper(source: string, tabSize: number): (target: string) => Readonly<{
    map: (offset: number, affinity?: Affinity) => number;
    indentEdit: (edit: TextEdit, indentation: InsertionIndentation) => TextEdit | undefined;
}> | undefined {
    let left: Line[] | undefined;
    const sourceColumns = new Map<number, number>();
    let previousIndent: TextEdit | undefined, indentDelta = 0;
    return target => {
    if (source === target) return { map: offset => offset, indentEdit: edit => edit };
    const sourceLines = left ??= lines(source, tabSize), right = lines(target, tabSize);
    if (sourceLines.length !== right.length || sourceLines.some((line, index) => source.slice(line.body, line.to) !== target.slice(right[index]!.body, right[index]!.to))) return;
    const lineAt = (offset: number) => partitionPoint(sourceLines.length, index => sourceLines[index]!.from <= offset) - 1;
    return {
        map: (offset, affinity = "after") => {
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length) throw new RangeError("Snippet position leaves its field.");
            if (!offset) return 0; if (offset === source.length) return target.length;
            const index = lineAt(offset), a = sourceLines[index]!, b = right[index]!;
            if (offset > a.to) return affinity === "before" ? b.to : b.end;
            if (offset >= a.body) return b.body + offset - a.body;
            if (offset === a.from) return b.from;
            let columnAt = sourceColumns.get(offset);
            if (columnAt === undefined) { columnAt = columns(source, a.from, offset, tabSize); sourceColumns.set(offset, columnAt); }
            const wanted = Math.max(0, b.columns + columnAt - a.columns);
            let at = b.from, column = 0;
            while (at < b.body && column < wanted) {
                const next = column + (target[at] === "\t" ? tabSize - column % tabSize : 1);
                if (next > wanted && affinity === "before") break; column = next; at++;
            }
            return at;
        },
        indentEdit: (edit, indentation) => {
            if (edit.insert || edit.from === edit.to) return;
            const index = lineAt(edit.from), a = sourceLines[index]!, b = right[index]!;
            if (edit.to > a.body || !/^[ \t]*$/.test(edit.insert)) return;
            if (previousIndent !== edit) {
                const prefix = source.slice(a.from, edit.from) + edit.insert + source.slice(edit.to, a.body);
                indentDelta = columns(prefix, 0, prefix.length, tabSize) - a.columns; previousIndent = edit;
            }
            const count = Math.max(0, b.columns + indentDelta);
            const insert = indentation.insertSpaces ? " ".repeat(count) : "\t".repeat(Math.floor(count / tabSize)) + " ".repeat(count % tabSize);
            return { from: b.from, to: b.body, insert };
        }
    };
    };
}
