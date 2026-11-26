import { lineBoundary, lineContentEnd, lineEnding } from "./newlines.ts";
import { collapsedLineBlock, type FoldIndex } from "./folding.ts";
import { createClosingBracketCursor } from "./bracket-matching.ts";
import type { EditingPair, PairingContext, ResolvedLanguageConfiguration } from "./language-configuration.ts";
import type { TextBuffer } from "./text-buffer.ts";
import type { TextEdit } from "./changes.ts";
import type { Selection } from "./history.ts";
import { PositionMap } from "./positions.ts";
import { createSelectionSet, mapReplacementSelections, orderedSelections } from "./selections.ts";
import type { SelectionSet, SelectionEditPlan } from "./selections.ts";

function textEdit(from: number, to: number, insert: string): TextEdit {
    return Object.freeze({ from, to, insert });
}

function publishRanges(edits: TextEdit[], length: number, ranges: Selection[], primary: number) {
    return publish(edits, createSelectionSet(length, ranges, primary));
}

type LineShift = "move-line-up" | "move-line-down" | "copy-line-up" | "copy-line-down";
type LineInsertion = "insert-line-above" | "insert-line-below";
export type EditingCommand = LineShift | LineInsertion | "delete-lines" | "indent" | "indent-lines" | "outdent" | "line-comment" | "add-line-comment" | "remove-line-comment" | "block-comment" | "newline";
export { resolveLanguageConfiguration } from "./language-configuration.ts";
export type { EditingPair, LanguageEditContext, PairingContext, EnterIndent, LanguageConfiguration, ResolvedLanguageConfiguration } from "./language-configuration.ts";
type TypedCharacter = Readonly<{ character: string; canOvertype?: (offset: number) => boolean }>;

function whitespace(read: (from: number, to: number) => string, from: number, to: number): number {
    while (from < to) {
        const text = read(from, Math.min(to, from + 4096)), length = /^[ \t]*/.exec(text)![0].length;
        from += length;

        if (length < text.length) break;
    }
    return from;
}

function closerIndent(buffer: TextBuffer, at: number, key: string, config: ResolvedLanguageConfiguration,
    previousEnd: number, read: (from: number, to: number) => string): TextEdit | undefined {
    const line = buffer.lineAt(at), start = buffer.offsetAt(line);
    if (!line || start < previousEnd || (whitespace(read, start, at)) !== at) return;
    const cursor = createClosingBracketCursor(config, buffer, at, key);
    try {
        const { result } = cursor.next(Number.MAX_SAFE_INTEGER);
        if (result?.kind !== "matched" || result.match === null || result.direction !== -1) return;
        const openStart = buffer.offsetAt(buffer.lineAt(result.match));
        const indent = read(openStart, whitespace(read, openStart, result.match));
        if (indent !== read(start, at)) return textEdit(start, at, indent);
    } finally { cursor.dispose(); }
}
/** A leading tab completes the first stop, including any spaces before it. */
function outdentLength(indentation: string, tabSize: number): number {
    const prefix = indentation.slice(0, tabSize);
    const tab = prefix.indexOf("\t");
    return tab < 0 ? prefix.length : tab + 1;
}
type LineColumns = { offset: number; column: number; previousStop: number; indentation: boolean };

/** Reuse a line's scanned columns. An indentation-only scan stops at its first text character. */
export function lineColumnScanner(read: (from: number, to: number) => string, tabSize: number) {
    let lineStart = -1, offset = 0, column = 0, previousStop = 0;
    let firstText: LineColumns | undefined;
    return function scan(start: number, to: number, indentOnly = false, maxColumn = Infinity): LineColumns {
        if (lineStart !== start || offset > to || column > maxColumn) {
            lineStart = start; offset = previousStop = start; column = 0; firstText = undefined;
        }
        if (indentOnly && firstText && firstText.offset < to) return firstText;
        while (offset < to && column < maxColumn) {
            const chunk = indentOnly && offset === start ? 32 : 1024;
            const text = read(offset, Math.min(to, offset + chunk));
            for (let i = 0; i < text.length; i++) {
                const ch = text.charCodeAt(i);
                if (!firstText && ch !== 32 && ch !== 9) firstText = { offset, column, previousStop, indentation: false };
                if (indentOnly && firstText) return firstText;
                const next = column + (ch === 9 ? tabSize - column % tabSize : 1);
                if (next > maxColumn) return { offset, column, previousStop, indentation: !firstText };
                if (column % tabSize === 0) previousStop = offset;
                column = next;
                offset++;
                if (column === maxColumn) break;
            }
        }
        return { offset, column, previousStop, indentation: !firstText || offset === firstText.offset };
    };
}
function publish(edits: TextEdit[], selectionSet: SelectionSet): SelectionEditPlan {
    return Object.freeze({ edits: Object.freeze(edits), selectionSet });
}

function blockComments(buffer: TextBuffer, selections: SelectionSet, pair: EditingPair, allowPair: ResolvedLanguageConfiguration["allowPair"],
    read: (from: number, to: number) => string): SelectionEditPlan {
    const { open, close } = pair, edits: TextEdit[] = [];
    const comments: { from: number; to: number }[] = [];
    // Read each window once as ordered selections advance. The overlap keeps a
    // multi-unit delimiter intact at a window edge, including in fragmented text.
    let windowStart = 0, window = "";
    function find(delimiter: string, from: number, before: number): number {
        const limit = Math.min(before, buffer.length - delimiter.length + 1);
        while (from < limit) {
            if (from < windowStart || from + delimiter.length > windowStart + window.length) {
                windowStart = from;
                window = read(from, Math.min(buffer.length, from + 2048 + Math.max(open.length, close.length) - 1));
            }
            const end = Math.min(limit, windowStart + window.length - delimiter.length + 1);
            const part = window.slice(from - windowStart, end - windowStart + delimiter.length - 1);
            const found = part.indexOf(delimiter);
            if (found >= 0) return from + found;
            from = end;
        }
        return -1;
    }
    let after = 0, enclosing: { from: number; to: number } | undefined;
    for (const range of selections.ranges) {
        const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head);
        // Selections explicitly touching their delimiters toggle even when the host
        // has no lexical information for the new text.
        const includes = to - from >= open.length + close.length && read(from, from + open.length) === open && read(to - close.length, to) === close;
        let left = from, right = to;
        if (!includes && left && read(left - 1, left) === " ") left--;
        if (!includes && right < buffer.length && read(right, right + 1) === " ") right++;
        const surrounded = !includes && left >= open.length && right + close.length <= buffer.length
            && read(left - open.length, left) === open && read(right, right + close.length) === close;
        if (includes || surrounded) {
            const start = includes ? from : left - open.length, end = includes ? to : right + close.length;
            if (start >= (comments.at(-1)?.to ?? 0)) {
                enclosing = { from: start, to: end }; after = end;
            }
        }
        while (after <= from) {
            const start = find(open, after, from + 1);
            if (start < 0) { after = from + 1; break; }
            if (allowPair && !allowPair({ buffer, from: start, to: start + open.length, pair, operation: "open" })) {
                after = start + open.length;

                continue;
            }
            const end = find(close, start + open.length, buffer.length);
            if (end < 0) { after = buffer.length + 1; break; }
            enclosing = { from: start, to: end + close.length }; after = enclosing.to;
        }
        if (enclosing && from >= enclosing.from && to <= enclosing.to && (to > from || from > enclosing.from && from < enclosing.to)
            && enclosing !== comments.at(-1)) {
            comments.push(enclosing);
            let innerFrom = enclosing.from + open.length, innerTo = enclosing.to - close.length;
            if (innerFrom < innerTo && read(innerFrom, innerFrom + 1) === " ") innerFrom++;
            if (innerFrom < innerTo && read(innerTo - 1, innerTo) === " ") innerTo--;
            edits.push(textEdit(enclosing.from, innerFrom, ""), textEdit(innerTo, enclosing.to, ""));
        }
    }

    const removals = new PositionMap(buffer.length, edits), map = removals.createMapper();
    const ranges: Selection[] = [];
    const opening = open + " ", closing = " " + close;
    let next = 0, inserted = 0;
    for (const range of selections.ranges) {
        const forward = range.anchor <= range.head, from = forward ? range.anchor : range.head, to = forward ? range.head : range.anchor;
        while (next < comments.length && comments[next]!.to <= from) next++;
        const comment = comments[next];
        let low = map(from).offset + inserted, high = map(to).offset + inserted;
        // Unwrap once. A neighboring caret inside the delimiter follows that deletion.
        if (!comment || comment.from >= to) {
            if (from === to) edits.push(textEdit(from, to, opening + closing));
            else edits.push(textEdit(from, from, opening), textEdit(to, to, closing));
            low += opening.length;
            high += opening.length;
            inserted += opening.length + closing.length;
        }
        ranges.push(forward ? { anchor: low, head: high } : { anchor: high, head: low });
    }

    if (comments.length && inserted) {
        edits.sort((a, b) => a.from - b.from || a.to - b.to);
    }
    return publishRanges(edits, removals.newLength + inserted, ranges, selections.primary);
}

function projectedLines(first: number, last: number, folds?: FoldIndex) {
    const start = collapsedLineBlock(folds, first);
    const end = first === last ? start : collapsedLineBlock(folds, last);
    return { first: start?.lineFrom ?? first, last: end ? end.lineTo - 1 : last };
}

function lineGroups(buffer: TextBuffer, selections: SelectionSet, adjacent: boolean, folds?: FoldIndex) {
    const groups: { first: number; last: number; firstRange: number; endRange: number }[] = [];
    for (const [i, range] of selections.ranges.entries()) {
        const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head);
        const last = buffer.lineAt(to);
        const through = to > from && to === buffer.offsetAt(last) ? last - 1 : last;
        const lines = projectedLines(buffer.lineAt(from), through, folds);
        const previous = groups.at(-1);
        if (previous && lines.first <= previous.last + Number(adjacent)) {
            previous.last = Math.max(previous.last, lines.last); previous.endRange = i + 1;
        } else groups.push({ ...lines, firstRange: i, endRange: i + 1 });
    }
    return groups;
}

function lineComments(buffer: TextBuffer, selections: SelectionSet, command: "line-comment" | "add-line-comment" | "remove-line-comment",
    marker: string, tabSize: number, read: (from: number, to: number) => string, folds?: FoldIndex): SelectionEditPlan {
    const edits: TextEdit[] = [];
    for (const interval of lineGroups(buffer, selections, false, folds)) {
        const limit = lineBoundary(buffer, interval.last + 1);
        let base = 0;
        let window = "";
        // A short row usually shares its read with several following rows.
        function readAhead(from: number, to: number) {
            if (from < base || to > base + window.length) {
                base = from;
                window = read(from, Math.min(limit, Math.max(from + 1024, to)));
            }
            return window.slice(from - base, to - base);
        }
        const scan = lineColumnScanner(readAhead, tabSize);
        const lines: { start: number; offset: number; column: number; blank: boolean; markerEnd: number }[] = [];
        let minimum = Infinity;
        let allCommented = true;
        let start = buffer.offsetAt(interval.first);
        for (let line = interval.first; line <= interval.last; line++) {
            const first = window[start - base] ?? readAhead(start, start + 1);
            const newline = window.indexOf("\n", start - base);
            const end = newline < 0 ? lineBoundary(buffer, line + 1) : base + newline + 1;
            let offset = start;
            let column = 0;
            if (first === " " || first === "\t") {
                ({ offset, column } = scan(start, end, true));
            }
            const next = readAhead(offset, Math.min(end, offset + marker.length + 1));
            const markerEnd = next.startsWith(marker) ? offset + marker.length + Number(next[marker.length] === " ") : 0;
            if (command === "remove-line-comment") {
                if (markerEnd) edits.push(textEdit(offset, markerEnd, ""));
            } else {
                const blank = !next || /^\r?\n/.test(next);
                if (!blank) {
                    minimum = Math.min(minimum, column);
                    allCommented &&= !!markerEnd;
                }
                lines.push({ start, offset, column, blank, markerEnd });
            }
            start = end;
        }
        const uncomment = command === "line-comment" && minimum !== Infinity && allCommented;
        let common = minimum;
        if (!uncomment && minimum > 0 && minimum !== Infinity) for (const line of lines) {
            if (line.blank || line.column === minimum) continue;
            if (line.offset - line.start === line.column) { line.offset = line.start + minimum; line.column = minimum; }
            else {
                const point = scan(line.start, Math.min(line.offset, line.start + minimum), false, minimum);
                line.offset = point.offset; line.column = point.column; common = Math.min(common, point.column);
            }
        }
        for (const line of lines) {
            if (line.blank && minimum !== Infinity) continue;
            if (uncomment) edits.push(textEdit(line.offset, line.markerEnd, ""));
            else {
                // If a tab straddled the minimum, every column back to its start lies
                // in this same tab stop. Only literal spaces need to be stepped over.
                const from = common === 0 ? line.start : common === Infinity ? line.offset : line.offset - (line.column - common);
                edits.push(textEdit(from, from, marker + " "));
            }
        }
    }

    // Comment edits only insert or delete. Every endpoint inside a deletion collapses to its start.
    return publish(edits, mapReplacementSelections(buffer.length, selections, edits));
}

function enterIndent(buffer: TextBuffer, from: number, to: number, config: ResolvedLanguageConfiguration, unit: string,
    read: (from: number, to: number) => string) {
    if (!config.enter) return { outer: "", inner: "", split: false };

    const rule = typeof config.enter === "function" ? config.enter({ buffer, from, to }) : { indent: 0 as const };
    const start = buffer.offsetAt(buffer.lineAt(from)), end = whitespace(read, start, from);
    let outer = read(start, end);
    if (rule.indent === -1) outer = outer.slice(outdentLength(outer, config.tabSize));
    return { outer, inner: outer + (rule.indent === 1 ? unit : ""), split: rule.split === true };
}

function insertOrDeleteLines(buffer: TextBuffer, selections: SelectionSet, command: LineInsertion | "delete-lines",
    config: ResolvedLanguageConfiguration, unit: string, read: (from: number, to: number) => string, folds?: FoldIndex): SelectionEditPlan {
    const edits: TextEdit[] = [], ranges: Selection[] = [];
    let delta = 0;
    for (const group of lineGroups(buffer, selections, command === "delete-lines", folds)) {
        const start = buffer.offsetAt(group.first), end = lineContentEnd(buffer, group.last);
        let rowStart: number, rowLength = 0;
        if (command === "delete-lines") {
            const following = group.last + 1 < buffer.lineCount;
            const from = !following && group.first > 0 ? lineContentEnd(buffer, group.first - 1) : start;
            const to = lineBoundary(buffer, group.last + 1);
            const neighbor = following ? group.last + 1 : group.first - 1;
            const survivor = neighbor < 0 ? neighbor : collapsedLineBlock(folds, neighbor)?.lineFrom ?? neighbor;
            rowLength = survivor < 0 ? 0 : lineContentEnd(buffer, survivor) - buffer.offsetAt(survivor);
            rowStart = delta + (!following && survivor >= 0 ? buffer.offsetAt(survivor) : start);
            if (from !== to) edits.push(textEdit(from, to, ""));
            delta -= to - from;
        } else {
            const above = command === "insert-line-above", preceding = above ? group.first - 1 : group.last;
            const beforeLine = above || group.last + 1 < buffer.lineCount && !!collapsedLineBlock(folds, group.last);
            const at = beforeLine ? buffer.offsetAt(above ? group.first : group.last + 1) : end;
            const context = preceding < 0 ? 0 : lineContentEnd(buffer, preceding);
            const indent = preceding < 0 ? "" : (enterIndent(buffer, context, context, config, unit, read)).inner;
            const ending = lineEnding(buffer, Math.max(0, preceding)), insert = beforeLine ? indent + ending : ending + indent;
            edits.push(textEdit(at, at, insert));
            rowStart = at + delta + indent.length + (beforeLine ? 0 : ending.length);
            delta += insert.length;
        }
        for (let i = group.firstRange; i < group.endRange; i++) {
            const previous = selections.ranges[i]!.head;
            const column = rowLength ? Math.min(rowLength, previous - buffer.offsetAt(buffer.lineAt(previous))) : 0;
            ranges.push({ anchor: rowStart + column, head: rowStart + column });
        }
    }
    return publishRanges(edits, buffer.length + delta, ranges, selections.primary);
}

function shiftLines(buffer: TextBuffer, selections: SelectionSet, command: LineShift,
    read: (from: number, to: number) => string, folds?: FoldIndex): SelectionEditPlan {
    const copy = command === "copy-line-up" || command === "copy-line-down", up = command.endsWith("-up");
    const edits: TextEdit[] = [], ranges: Selection[] = [];
    let delta = 0;
    for (const group of lineGroups(buffer, selections, true, folds)) {
        const start = buffer.offsetAt(group.first), end = lineContentEnd(buffer, group.last);
        const after = lineBoundary(buffer, group.last + 1);
        let destination = start + delta, newEnding = after - end;
        if (copy) {
            const body = read(start, end), separator = lineEnding(buffer, group.last);
            const beforeNext = !up && after > end && !!collapsedLineBlock(folds, group.last);
            const at = up ? start : beforeNext ? after : end;
            edits.push(textEdit(at, at, up || beforeNext ? body + separator : separator + body));
            if (up) newEnding = separator.length;
            else destination += body.length + separator.length;
            delta += body.length + separator.length;
        } else if (up && group.first > 0) {
            // Move the neighbouring row around the selection. A million selected lines
            // cost no more buffer reads than one selected line.
            const first = collapsedLineBlock(folds, group.first - 1)?.lineFrom ?? group.first - 1;
            const before = buffer.offsetAt(first), beforeEnd = lineContentEnd(buffer, group.first - 1);
            const neighbour = read(before, beforeEnd);
            edits.push(Object.freeze({ from: before, to: start, insert: "", lineMove: true }),
                textEdit(end, end, read(beforeEnd, start) + neighbour));
            destination = before; newEnding = start - beforeEnd;
        } else if (!up && group.last + 1 < buffer.lineCount) {
            const through = collapsedLineBlock(folds, group.last + 1)?.lineTo ?? group.last + 2;
            const nextEnd = lineContentEnd(buffer, through - 1);
            const neighbour = read(after, nextEnd);
            edits.push(Object.freeze({ from: start, to: start, insert: neighbour + read(end, after), lineMove: true }),
                textEdit(end, nextEnd, ""));
            destination += nextEnd - end;
            newEnding = lineBoundary(buffer, through) - nextEnd;
        }
        const offset = (at: number) => {
            if (at <= end) return destination + at - start;
            const withinEnding = at === after ? newEnding : Math.min(at - end, newEnding);
            return destination + end - start + withinEnding;
        };
        for (let i = group.firstRange; i < group.endRange; i++) {
            const range = selections.ranges[i]!;
            ranges.push({ ...range, anchor: offset(range.anchor), head: offset(range.head) });
        }
    }
    return publishRanges(edits, buffer.length + delta, ranges, selections.primary);
}

function indent(buffer: TextBuffer, selections: SelectionSet, command: "indent" | "indent-lines" | "outdent", config: ResolvedLanguageConfiguration,
    read: (from: number, to: number) => string, folds?: FoldIndex): SelectionEditPlan {
    const { tabSize, insertSpaces } = config, unit = insertSpaces ? " ".repeat(tabSize) : "\t";
    const scan = lineColumnScanner(read, tabSize), edits: TextEdit[] = [];
    const reader = { length: buffer.length, lineCount: buffer.lineCount, offsetAt: (line: number) => buffer.offsetAt(line), slice: read };
    const replacements = new Map<TextEdit, number>();
    let lastIndented = -1;
    for (const [index, range] of selections.ranges.entries()) {
        const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head);
        const first = buffer.lineAt(from), last = buffer.lineAt(to), start = buffer.offsetAt(first), end = lineContentEnd(reader, first);
        const through = first !== last && to === buffer.offsetAt(last) ? last - 1 : last;
        const lines = projectedLines(first, through, folds);
        const folded = lines.first < first || lines.last > through;
        if (command !== "indent" || folded || from !== to && (first !== last || from === start && to === end)) {
            for (let line = Math.max(lines.first, lastIndented + 1); line <= lines.last; line++) {
                const prefix = scan(buffer.offsetAt(line), line === first ? end : lineContentEnd(reader, line), true);
                if ((first === last && !folded) || !prefix.indentation) {
                    if (command !== "outdent") {
                        edits.push(textEdit(prefix.offset, prefix.offset,
                            insertSpaces ? " ".repeat(tabSize - prefix.column % tabSize) : "\t"));
                    } else if (prefix.previousStop < prefix.offset) {
                        edits.push(textEdit(prefix.previousStop, prefix.offset, ""));
                    }
                }
            }
            lastIndented = lines.last;
            continue;
        }
        const { column, indentation } = scan(start, from);
        let edit = textEdit(from, to, insertSpaces ? " ".repeat(tabSize - column % tabSize) : "\t");
        if (config.enter && first > 0 && from === to && indentation) {
            const before = selections.ranges[index - 1], after = selections.ranges[index + 1];
            const shared = before && Math.max(before.anchor, before.head) >= start || after && Math.min(after.anchor, after.head) <= end;
            if (!shared) {
                const whole = scan(start, end, true);
                if (whole.indentation) {
                    const previousEnd = lineContentEnd(buffer, first - 1), previousStart = buffer.offsetAt(first - 1);
                    const previousIndent = whitespace(read, previousStart, previousEnd);
                    const rule = typeof config.enter === "function" ? config.enter({ buffer, from: previousEnd, to: previousEnd }).indent : 0;
                    const skip = rule === -1 ? outdentLength(read(previousStart, Math.min(previousIndent, previousStart + tabSize)), tabSize) : 0;
                    const prefix = previousStart + skip, previous = scan(prefix, previousIndent);
                    const extra = rule === 1 ? (insertSpaces ? tabSize : tabSize - previous.column % tabSize) : 0;
                    if (whole.column < previous.column + extra) {
                        edit = textEdit(start, end, read(prefix, previousIndent) + (rule === 1 ? unit : ""));
                    }
                }
            }
        }
        replacements.set(edit, index);
    }
    // Line shifts precede an inline replacement at the same offset. Each inline caret
    // lands after its own edit, including when two replacements share a boundary.
    const mixed = edits.length > 0 && replacements.size > 0;
    for (const edit of replacements.keys()) edits.push(edit);

    if (mixed) edits.sort((a, b) => a.from - b.from || a.to - b.to);

    const ranges: Selection[] = new Array(selections.ranges.length);
    let delta = 0, count = 0, consumed = 0;
    for (const edit of edits) {
        // An inline selection can replace the very whitespace where a block shift would insert.
        if (edit.from < consumed) continue;
        edits[count++] = edit; consumed = edit.to;
        const index = replacements.get(edit);
        if (index !== undefined) {
            const head = edit.from + delta + edit.insert.length;
            ranges[index] = { anchor: head, head };
        }
        delta += edit.insert.length - (edit.to - edit.from);
    }
    edits.length = count;
    if (replacements.size < selections.ranges.length) {
        const map = new PositionMap(buffer.length, edits).createMapper();

        for (const [index, range] of selections.ranges.entries()) {
            if (!ranges[index]) {
                const endpoint = (at: number) => map(at, range.anchor !== range.head && buffer.offsetAt(buffer.lineAt(at)) === at ? "before" : "after").offset;
                ranges[index] = { ...range, anchor: endpoint(range.anchor), head: endpoint(range.head) };
            }
        }
    }
    return publishRanges(edits, buffer.length + delta, ranges, selections.primary);
}

/** Plan one complete edit against the captured text, selections and folds. */
export function planLanguageEdit(buffer: TextBuffer, input: SelectionSet, command: EditingCommand | TypedCharacter,
    config: ResolvedLanguageConfiguration, folds?: FoldIndex): SelectionEditPlan {
    if (folds && folds.lineCount !== buffer.lineCount) throw new RangeError("Fold index must cover the planning buffer.");
    const selections = orderedSelections(buffer.length, input);

    const read = (from: number, to: number) => buffer.slice(from, to);
    const reader = { lineCount: buffer.lineCount, offsetAt: (line: number) => buffer.offsetAt(line), slice: read };
    const unit = config.insertSpaces ? " ".repeat(config.tabSize) : "\t", edits: TextEdit[] = [];
    if (command === "insert-line-above" || command === "insert-line-below" || command === "delete-lines")
        return insertOrDeleteLines(buffer, selections, command, config, unit, read, folds);
    if (command === "move-line-up" || command === "move-line-down" || command === "copy-line-up" || command === "copy-line-down")
        return shiftLines(buffer, selections, command, read, folds);
    if (command === "indent" || command === "indent-lines" || command === "outdent") return indent(buffer, selections, command, config, read, folds);
    if (command === "block-comment" && config.blockComment) return blockComments(buffer, selections, config.blockComment, config.allowPair, read);
    if (command === "line-comment" || command === "add-line-comment" || command === "remove-line-comment") {
        if (!config.lineComment) return publish(edits, selections);
        return lineComments(buffer, selections, command, config.lineComment, config.tabSize, read, folds);
    }
    const ranges: Selection[] = []; let delta = 0;
    for (const range of selections.ranges) {
        const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head), context = { buffer, from, to };
        let anchor: number, head: number;
        if (typeof command === "object") {
            const key = command.character, next = read(to, Math.min(buffer.length, to + 1));

            const closing = config.pairs.find(pair => pair.close === key), opening = config.pairs.find(pair => pair.open === key);
            const allowed = (pair: EditingPair, operation: PairingContext["operation"]) => config.allowPair?.({ ...context, pair, operation }) ?? true;
            if (from === to && closing && closing.open !== key) {
                const indent = closerIndent(buffer, from, key, config, edits.at(-1)?.to ?? 0, read);
                if (indent) { edits.push(indent); delta += indent.insert.length - (indent.to - indent.from); }
            }
            const atCloser = from === to && closing !== undefined && next === key;
            if (atCloser && allowed(closing, "close") && command.canOvertype?.(from)) { anchor = head = from + delta + 1; }
            else if (opening && from !== to && allowed(opening, "surround")) {
                edits.push(textEdit(from, from, opening.open), textEdit(to, to, opening.close));
                anchor = range.anchor + delta + 1; head = range.head + delta + 1; delta += 2;
            } else {
                const pair = from === to && !atCloser && opening && (!next || /[\s)\]}"'`]/.test(next)) && allowed(opening, "open");
                const insert = pair ? key + opening.close : key;
                edits.push(textEdit(from, to, insert));
                anchor = head = from + delta + key.length;
                delta += insert.length - (to - from);
            }
        } else if (command === "newline") {
            const indent = enterIndent(buffer, from, to, config, unit, read);
            const ending = lineEnding(reader, buffer.lineAt(from)), first = ending + indent.inner;
            const insert = first + (indent.split ? ending + indent.outer : "");

            edits.push(textEdit(from, to, insert));
            anchor = head = from + delta + first.length;
            delta += insert.length - (to - from);
        } else { anchor = range.anchor + delta; head = range.head + delta; }
        ranges.push({ anchor, head });
    }
    return publishRanges(edits, buffer.length + delta, ranges, selections.primary);
}
