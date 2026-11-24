import { lineContentEnd, lineEnding } from "./newlines.ts";
import { collapsedLineBlock, type FoldIndex } from "./folding.ts";
import { recordLineMovePlan, type LineSwap } from "./line-moves.ts";
import { createClosingBracketCursor } from "./bracket-matching.ts";
import type { EditingPair, PairingContext, ResolvedLanguageConfiguration } from "./language-configuration.ts";
import type { TextBuffer } from "./text-buffer.ts";
import type { TextEdit } from "./changes.ts";
import type { Selection } from "./history.ts";
import { PositionMap } from "./positions.ts";
import { createSelectionSet, mapSelectionRanges } from "./selections.ts";
import type { SelectionSet, SelectionEditPlan } from "./selections.ts";
import { kernelCursor } from "./kernel-cursor.ts";
import type { KernelCursor, KernelStatus } from "./kernel-cursor.ts";

export type LanguageEditProgress = Readonly<{
    status: KernelStatus; phase: "validate" | "plan" | "map" | "publish";
    workUnits: number; readUnits: number; bulkWorkUnits: number;
    result: SelectionEditPlan | null; failure: string | null;
}>;
export type LanguageEditCursor = KernelCursor<LanguageEditProgress>;
type Planning = Pick<LanguageEditProgress, "phase" | "workUnits" | "readUnits" | "bulkWorkUnits"> & { checkpoint: number };
type MutablePlanning = { -readonly [K in keyof Planning]: Planning[K] };
/** Bulk charges count helper input cardinality, not internal operations or elapsed time. */
function bulk(state: MutablePlanning, units: number): void { state.workUnits += units; state.bulkWorkUnits += units; }
function checkpoint(state: MutablePlanning): boolean {
    if (state.workUnits - state.checkpoint < 256) return false;
    state.checkpoint = state.workUnits; return true;
}

type LineShift = "move-line-up" | "move-line-down" | "copy-line-up" | "copy-line-down";
type LineInsertion = "insert-line-above" | "insert-line-below";
export type EditingCommand = LineShift | LineInsertion | "delete-lines" | "indent" | "indent-lines" | "outdent" | "line-comment" | "add-line-comment" | "remove-line-comment" | "block-comment" | "newline";
export { resolveLanguageConfiguration } from "./language-configuration.ts";
export type { EditingPair, LanguageEditContext, PairingContext, EnterIndent, LanguageConfiguration, ResolvedLanguageConfiguration } from "./language-configuration.ts";
type TypedCharacter = Readonly<{ character: string; canOvertype?: (offset: number) => boolean }>;

function* whitespace(read: (from: number, to: number) => string, state: MutablePlanning, from: number, to: number): Generator<void, number> {
    while (from < to) {
        const text = read(from, Math.min(to, from + 4096)), length = /^[ \t]*/.exec(text)![0].length;
        from += length;
        if (checkpoint(state)) yield;
        if (length < text.length) break;
    }
    return from;
}

function* closerIndent(buffer: TextBuffer, at: number, key: string, config: ResolvedLanguageConfiguration,
    previousEnd: number, read: (from: number, to: number) => string, state: MutablePlanning): Generator<void, TextEdit | undefined> {
    const line = buffer.lineAt(at), start = buffer.offsetAt(line);
    if (!line || start < previousEnd || (yield* whitespace(read, state, start, at)) !== at) return;
    const cursor = createClosingBracketCursor(config, buffer, at, key);
    let work = 0, reads = 0;
    try {
        for (;;) {
            const next = cursor.next(256);
            state.workUnits += next.workUnits - work; state.readUnits += next.readUnits - reads;
            work = next.workUnits; reads = next.readUnits;
            if (next.status === "running") { yield; continue; }
            if (next.result?.kind !== "matched" || next.result.match === null || next.result.direction !== -1) return;
            const openLine = buffer.lineAt(next.result.match), openStart = buffer.offsetAt(openLine);
            const openIndent = yield* whitespace(read, state, openStart, next.result.match);
            const indent = read(openStart, openIndent);
            if (indent === read(start, at)) return;
            return { from: start, to: at, insert: indent };
        }
    } finally { cursor.dispose(); }
}
/** At most tabSize characters; removing a complete tab stop preserves later tab alignment. */
function outdentLength(prefix: string, tabSize: number): number {
    let units = 0, column = 0;
    while (units < prefix.length && column < tabSize) {
        const unit = prefix[units];
        if (unit === " ") column++;
        else if (unit === "\t") column += tabSize - column % tabSize;
        else break;
        units++;
    }
    return units;
}
type LineColumns = { offset: number; column: number; previousStop: number; indentation: boolean };

/** Reuse a line's scanned columns. An indentation-only scan stops at its first text character. */
export function lineColumnScanner(read: (from: number, to: number) => string, tabSize: number) {
    let lineStart = -1, offset = 0, column = 0, previousStop = 0;
    let firstText: LineColumns | undefined;
    return function* scan(start: number, to: number, indentOnly = false, maxColumn = Infinity): Generator<void, LineColumns> {
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
            yield;
        }
        return { offset, column, previousStop, indentation: !firstText || offset === firstText.offset };
    };
}
function* mapped(buffer: TextBuffer, selections: SelectionSet, edits: TextEdit[], state: MutablePlanning): Generator<void, SelectionEditPlan> {
    state.phase = "map";
    bulk(state, edits.length);
    const mapping = new PositionMap(buffer.length, edits);
    if (checkpoint(state)) yield;
    bulk(state, selections.ranges.length);
    const selectionSet = mapSelectionRanges(mapping, selections, "after");
    if (checkpoint(state)) yield;
    return yield* publish(edits, selectionSet, state);
}
function* publish(edits: TextEdit[], selectionSet: SelectionSet, state: MutablePlanning): Generator<void, SelectionEditPlan> {
    state.phase = "publish";
    for (const edit of edits) {
        Object.freeze(edit); state.workUnits++;
        if (checkpoint(state)) yield;
    }
    bulk(state, edits.length);
    const result = Object.freeze({ edits: Object.freeze(edits), selectionSet });
    if (checkpoint(state)) yield;
    return result;
}

function* blockComments(buffer: TextBuffer, selections: SelectionSet, pair: EditingPair, allowPair: ResolvedLanguageConfiguration["allowPair"],
    read: (from: number, to: number) => string, state: MutablePlanning): Generator<void, SelectionEditPlan> {
    const { open, close } = pair, edits: TextEdit[] = [];
    const comments: { from: number; to: number }[] = [];
    // Read each window once as ordered selections advance. The overlap keeps a
    // multi-unit delimiter intact at a window edge, including in fragmented text.
    let windowStart = 0, window = "";
    function* find(delimiter: string, from: number, before: number): Generator<void, number> {
        const limit = Math.min(before, buffer.length - delimiter.length + 1);
        while (from < limit) {
            if (from < windowStart || from + delimiter.length > windowStart + window.length) {
                windowStart = from;
                window = read(from, Math.min(buffer.length, from + 2048 + Math.max(open.length, close.length) - 1));
                if (checkpoint(state)) yield;
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
            const start = yield* find(open, after, from + 1);
            if (start < 0) { after = from + 1; break; }
            if (allowPair && !allowPair({ buffer, from: start, to: start + open.length, pair, operation: "open" })) {
                after = start + open.length; state.workUnits++; if (checkpoint(state)) yield; continue;
            }
            const end = yield* find(close, start + open.length, buffer.length);
            if (end < 0) { after = buffer.length + 1; break; }
            enclosing = { from: start, to: end + close.length }; after = enclosing.to;
            state.workUnits++; if (checkpoint(state)) yield;
        }
        if (enclosing && from >= enclosing.from && to <= enclosing.to && (to > from || from > enclosing.from && from < enclosing.to)
            && enclosing !== comments.at(-1)) {
            comments.push(enclosing);
            let innerFrom = enclosing.from + open.length, innerTo = enclosing.to - close.length;
            if (innerFrom < innerTo && read(innerFrom, innerFrom + 1) === " ") innerFrom++;
            if (innerFrom < innerTo && read(innerTo - 1, innerTo) === " ") innerTo--;
            edits.push({ from: enclosing.from, to: innerFrom, insert: "" }, { from: innerTo, to: enclosing.to, insert: "" });
        }
        state.workUnits++; if (checkpoint(state)) yield;
    }
    bulk(state, edits.length);
    const removals = new PositionMap(buffer.length, edits), map = removals.createMapper();
    const ranges: Selection[] = [];
    let next = 0, inserted = 0;
    for (const range of selections.ranges) {
        const forward = range.anchor <= range.head, from = forward ? range.anchor : range.head, to = forward ? range.head : range.anchor;
        while (next < comments.length && comments[next]!.to <= from) next++;
        const comment = comments[next];
        let low = map(from).offset + inserted, high = map(to).offset + inserted;
        // Unwrap once. A neighboring caret inside the delimiter follows that deletion.
        if (!comment || comment.from >= to) {
            const padding = from === to ? "" : " ";
            if (from === to) edits.push({ from, to, insert: open + close });
            else edits.push({ from, to: from, insert: open + padding }, { from: to, to, insert: padding + close });
            low += open.length + padding.length; high += open.length + padding.length;
            inserted += open.length + close.length + 2 * padding.length;
        }
        ranges.push(forward ? { anchor: low, head: high } : { anchor: high, head: low });
        state.workUnits++; if (checkpoint(state)) yield;
    }
    state.phase = "map";
    if (comments.length && inserted) {
        bulk(state, edits.length);
        edits.sort((a, b) => a.from - b.from || a.to - b.to);
    }
    bulk(state, ranges.length);
    return yield* publish(edits, createSelectionSet(removals.newLength + inserted, ranges, selections.primary), state);
}

function touchedLines(buffer: TextBuffer, range: Selection) {
    const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head);
    const last = buffer.lineAt(to);
    return { first: buffer.lineAt(from), last: to > from && to === buffer.offsetAt(last) ? last - 1 : last };
}

function* lineGroups(buffer: TextBuffer, selections: SelectionSet, adjacent: boolean, state: MutablePlanning, folds?: FoldIndex) {
    const groups: { first: number; last: number; firstRange: number; endRange: number }[] = [];
    for (const [i, range] of selections.ranges.entries()) {
        const lines = touchedLines(buffer, range), previous = groups.at(-1);
        if (folds?.collapsedCount) {
            const first = collapsedLineBlock(folds, lines.first);
            const last = lines.first === lines.last ? first : collapsedLineBlock(folds, lines.last);
            if (first) lines.first = first.lineFrom;
            if (last) lines.last = last.lineTo - 1;
        }
        if (previous && lines.first <= previous.last + Number(adjacent)) {
            previous.last = Math.max(previous.last, lines.last); previous.endRange = i + 1;
        } else groups.push({ ...lines, firstRange: i, endRange: i + 1 });
        state.workUnits++; if (checkpoint(state)) yield;
    }
    return groups;
}

function* lineComments(buffer: TextBuffer, selections: SelectionSet, command: "line-comment" | "add-line-comment" | "remove-line-comment",
    marker: string, tabSize: number, read: (from: number, to: number) => string, state: MutablePlanning): Generator<void, SelectionEditPlan> {
    const edits: TextEdit[] = [];
    const intervals = yield* lineGroups(buffer, selections, false, state), scan = lineColumnScanner(read, tabSize);
    const remove = (from: number) => {
        const end = from + marker.length;
        const space = read(end, Math.min(buffer.length, end + 1)) === " ";
        edits.push({ from, to: end + Number(space), insert: "" });
    };
    for (const interval of intervals) {
        const lines: { start: number; offset: number; column: number; blank: boolean }[] = [];
        let minimum = Infinity, allCommented = true, start = buffer.offsetAt(interval.first);
        for (let line = interval.first; line <= interval.last; line++) {
            const end = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) : buffer.length;
            const { offset, column } = yield* scan(start, end, true), next = read(offset, Math.min(end, offset + marker.length));
            const blank = !next || /^[\r\n]/.test(next), commented = next === marker;
            if (command === "remove-line-comment") {
                if (commented) remove(offset);
            } else {
                if (!blank) { minimum = Math.min(minimum, column); allCommented &&= commented; }
                lines.push({ start, offset, column, blank });
            }
            start = end;
            state.workUnits++; if (checkpoint(state)) yield;
        }
        const uncomment = command === "line-comment" && minimum !== Infinity && allCommented;
        let common = minimum;
        if (!uncomment && minimum > 0 && minimum !== Infinity) for (const line of lines) {
            state.workUnits++; if (checkpoint(state)) yield;
            if (line.blank || line.column === minimum) continue;
            if (line.offset - line.start === line.column) { line.offset = line.start + minimum; line.column = minimum; }
            else {
                const point = yield* scan(line.start, Math.min(line.offset, line.start + minimum), false, minimum);
                line.offset = point.offset; line.column = point.column; common = Math.min(common, point.column);
            }
        }
        for (const line of lines) {
            state.workUnits++; if (checkpoint(state)) yield;
            if (line.blank && minimum !== Infinity) continue;
            if (uncomment) remove(line.offset);
            else {
                // If a tab straddled the minimum, every column back to its start lies
                // in this same tab stop. Only literal spaces need to be stepped over.
                const from = common === 0 ? line.start : common === Infinity ? line.offset : line.offset - (line.column - common);
                edits.push({ from, to: from, insert: marker + " " });
            }
        }
    }
    return yield* mapped(buffer, selections, edits, state);
}

function* enterIndent(buffer: TextBuffer, from: number, to: number, config: ResolvedLanguageConfiguration, unit: string,
    read: (from: number, to: number) => string, state: MutablePlanning) {
    if (!config.enter) return { outer: "", inner: "", split: false };
    if (typeof config.enter === "function") state.workUnits++;
    const rule = typeof config.enter === "function" ? config.enter({ buffer, from, to }) : { indent: 0 as const };
    const start = buffer.offsetAt(buffer.lineAt(from)), end = yield* whitespace(read, state, start, from);
    let outer = read(start, end);
    if (rule.indent === -1) outer = outer.slice(outdentLength(outer, config.tabSize));
    return { outer, inner: outer + (rule.indent === 1 ? unit : ""), split: rule.split === true };
}

function* insertOrDeleteLines(buffer: TextBuffer, selections: SelectionSet, command: LineInsertion | "delete-lines",
    config: ResolvedLanguageConfiguration, unit: string, read: (from: number, to: number) => string, state: MutablePlanning, folds?: FoldIndex): Generator<void, SelectionEditPlan> {
    const edits: TextEdit[] = [], ranges: Selection[] = [];
    let delta = 0;
    for (const group of yield* lineGroups(buffer, selections, command === "delete-lines", state, folds)) {
        const start = buffer.offsetAt(group.first), end = lineContentEnd(buffer, group.last);
        let rowStart: number, rowLength = 0;
        if (command === "delete-lines") {
            const following = group.last + 1 < buffer.lineCount;
            const from = !following && group.first > 0 ? lineContentEnd(buffer, group.first - 1) : start;
            const to = following ? buffer.offsetAt(group.last + 1) : end;
            const neighbor = following ? group.last + 1 : group.first - 1;
            const survivor = neighbor < 0 ? neighbor : collapsedLineBlock(folds, neighbor)?.lineFrom ?? neighbor;
            rowLength = survivor < 0 ? 0 : lineContentEnd(buffer, survivor) - buffer.offsetAt(survivor);
            rowStart = delta + (!following && survivor >= 0 ? buffer.offsetAt(survivor) : start);
            if (from !== to) edits.push({ from, to, insert: "" });
            delta -= to - from;
        } else {
            const above = command === "insert-line-above", preceding = above ? group.first - 1 : group.last;
            const beforeLine = above || group.last + 1 < buffer.lineCount && !!collapsedLineBlock(folds, group.last);
            const at = beforeLine ? buffer.offsetAt(above ? group.first : group.last + 1) : end;
            const context = preceding < 0 ? 0 : lineContentEnd(buffer, preceding);
            const indent = preceding < 0 ? "" : (yield* enterIndent(buffer, context, context, config, unit, read, state)).inner;
            const ending = lineEnding(buffer, Math.max(0, preceding)), insert = beforeLine ? indent + ending : ending + indent;
            edits.push({ from: at, to: at, insert });
            rowStart = at + delta + indent.length + (beforeLine ? 0 : ending.length);
            delta += insert.length; bulk(state, insert.length);
        }
        for (let i = group.firstRange; i < group.endRange; i++) {
            const previous = selections.ranges[i]!.head;
            const column = rowLength ? Math.min(rowLength, previous - buffer.offsetAt(buffer.lineAt(previous))) : 0;
            ranges.push({ anchor: rowStart + column, head: rowStart + column });
            state.workUnits++; if (checkpoint(state)) yield;
        }
    }
    state.phase = "map"; bulk(state, ranges.length);
    return yield* publish(edits, createSelectionSet(buffer.length + delta, ranges, selections.primary), state);
}

function* blockText(read: (from: number, to: number) => string, state: MutablePlanning, from: number, to: number): Generator<void, string> {
    if (to - from <= 4096) return read(from, to);
    const chunks: string[] = [];
    for (let at = from; at < to; at += 4096) {
        chunks.push(read(at, Math.min(at + 4096, to)));
        if (checkpoint(state)) yield;
    }
    bulk(state, to - from);
    return chunks.join("");
}

function* shiftLines(buffer: TextBuffer, selections: SelectionSet, command: LineShift,
    read: (from: number, to: number) => string, state: MutablePlanning, folds?: FoldIndex): Generator<void, SelectionEditPlan> {
    const copy = command === "copy-line-up" || command === "copy-line-down", up = command.endsWith("-up");
    const edits: TextEdit[] = [], ranges: Selection[] = [], swaps: LineSwap[] = [];
    let delta = 0;
    for (const group of yield* lineGroups(buffer, selections, true, state, folds)) {
        const start = buffer.offsetAt(group.first), end = lineContentEnd(buffer, group.last);
        const after = group.last + 1 < buffer.lineCount ? buffer.offsetAt(group.last + 1) : end;
        let destination = start + delta, newEnding = after - end;
        if (copy) {
            const body = yield* blockText(read, state, start, end), separator = lineEnding(buffer, group.last);
            const beforeNext = !up && after > end && !!collapsedLineBlock(folds, group.last);
            const at = up ? start : beforeNext ? after : end;
            edits.push({ from: at, to: at, insert: up || beforeNext ? body + separator : separator + body });
            if (up) newEnding = separator.length;
            else destination += body.length + separator.length;
            delta += body.length + separator.length;
        } else if (up && group.first > 0) {
            // Move the neighbouring row around the selection. A million selected lines
            // cost no more buffer reads than one selected line.
            const first = collapsedLineBlock(folds, group.first - 1)?.lineFrom ?? group.first - 1;
            const before = buffer.offsetAt(first), beforeEnd = lineContentEnd(buffer, group.first - 1);
            const neighbour = yield* blockText(read, state, before, beforeEnd);
            edits.push({ from: before, to: start, insert: "" }, { from: end, to: end, insert: read(beforeEnd, start) + neighbour });
            destination = before; newEnding = start - beforeEnd;
            swaps.push({ first, middle: group.first, end: group.last + 1 });
        } else if (!up && group.last + 1 < buffer.lineCount) {
            const through = collapsedLineBlock(folds, group.last + 1)?.lineTo ?? group.last + 2;
            const nextEnd = lineContentEnd(buffer, through - 1);
            const neighbour = yield* blockText(read, state, after, nextEnd);
            edits.push({ from: start, to: start, insert: neighbour + read(end, after) }, { from: end, to: nextEnd, insert: "" });
            destination += nextEnd - end;
            newEnding = through < buffer.lineCount ? buffer.offsetAt(through) - nextEnd : 0;
            swaps.push({ first: group.first, middle: group.last + 1, end: through });
        }
        const offset = (at: number) => {
            if (at <= end) return destination + at - start;
            const withinEnding = at === after ? newEnding : Math.min(at - end, newEnding);
            return destination + end - start + withinEnding;
        };
        for (let i = group.firstRange; i < group.endRange; i++) {
            const range = selections.ranges[i]!;
            ranges.push({ ...range, anchor: offset(range.anchor), head: offset(range.head) });
            state.workUnits++; if (checkpoint(state)) yield;
        }
    }
    state.phase = "map"; bulk(state, ranges.length);
    const result = yield* publish(edits, createSelectionSet(buffer.length + delta, ranges, selections.primary), state);
    recordLineMovePlan(buffer, result.edits, swaps);
    return result;
}

function* indent(buffer: TextBuffer, selections: SelectionSet, command: "indent" | "indent-lines" | "outdent", config: ResolvedLanguageConfiguration,
    read: (from: number, to: number) => string, state: MutablePlanning): Generator<void, SelectionEditPlan> {
    const { tabSize, insertSpaces } = config, unit = insertSpaces ? " ".repeat(tabSize) : "\t";
    const scan = lineColumnScanner(read, tabSize), edits: TextEdit[] = [];
    const reader = { length: buffer.length, lineCount: buffer.lineCount, offsetAt: (line: number) => buffer.offsetAt(line), slice: read };
    const replacements = new Map<TextEdit, number>();
    let lastIndented = -1;
    for (const [index, range] of selections.ranges.entries()) {
        state.workUnits++; if (checkpoint(state)) yield;
        const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head);
        const first = buffer.lineAt(from), last = buffer.lineAt(to), start = buffer.offsetAt(first), end = lineContentEnd(reader, first);
        if (command !== "indent" || from !== to && (first !== last || from === start && to === end)) {
            const through = first !== last && to === buffer.offsetAt(last) ? last - 1 : last;
            for (let line = Math.max(first, lastIndented + 1); line <= through; line++) {
                const prefix = yield* scan(buffer.offsetAt(line), line === first ? end : lineContentEnd(reader, line), true);
                if (first === last || !prefix.indentation) {
                    if (command !== "outdent") {
                        edits.push({ from: prefix.offset, to: prefix.offset, insert: insertSpaces ? " ".repeat(tabSize - prefix.column % tabSize) : "\t" });
                    } else if (prefix.previousStop < prefix.offset) {
                        edits.push({ from: prefix.previousStop, to: prefix.offset, insert: "" });
                    }
                }
                state.workUnits++;
                if (checkpoint(state)) yield;
            }
            lastIndented = through;
            continue;
        }
        const { column, indentation } = yield* scan(start, from);
        let edit: TextEdit = { from, to, insert: insertSpaces ? " ".repeat(tabSize - column % tabSize) : "\t" };
        if (config.enter && first > 0 && from === to && indentation) {
            const before = selections.ranges[index - 1], after = selections.ranges[index + 1];
            const shared = before && Math.max(before.anchor, before.head) >= start || after && Math.min(after.anchor, after.head) <= end;
            if (!shared) {
                const whole = yield* scan(start, end, true);
                if (whole.indentation) {
                    const previousEnd = lineContentEnd(buffer, first - 1), previousStart = buffer.offsetAt(first - 1);
                    const previousIndent = yield* whitespace(read, state, previousStart, previousEnd);
                    const rule = typeof config.enter === "function" ? config.enter({ buffer, from: previousEnd, to: previousEnd }).indent : 0;
                    const skip = rule === -1 ? outdentLength(read(previousStart, Math.min(previousIndent, previousStart + tabSize)), tabSize) : 0;
                    const prefix = previousStart + skip, previous = yield* scan(prefix, previousIndent);
                    const extra = rule === 1 ? (insertSpaces ? tabSize : tabSize - previous.column % tabSize) : 0;
                    if (whole.column < previous.column + extra) edit = { from: start, to: end, insert: read(prefix, previousIndent) + (rule === 1 ? unit : "") };
                }
            }
        }
        replacements.set(edit, index);
    }
    // Line shifts precede an inline replacement at the same offset. Each inline caret
    // lands after its own edit, including when two replacements share a boundary.
    const mixed = edits.length > 0 && replacements.size > 0;
    for (const edit of replacements.keys()) edits.push(edit);
    bulk(state, edits.length);
    if (mixed) edits.sort((a, b) => a.from - b.from || a.to - b.to);
    if (checkpoint(state)) yield;
    state.phase = "map";
    const ranges: Selection[] = new Array(selections.ranges.length);
    let delta = 0, count = 0, consumed = 0;
    for (const edit of edits) {
        state.workUnits++; if (checkpoint(state)) yield;
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
        bulk(state, edits.length);
        for (const [index, range] of selections.ranges.entries()) {
            if (!ranges[index]) {
                const endpoint = (at: number) => map(at, range.anchor !== range.head && buffer.offsetAt(buffer.lineAt(at)) === at ? "before" : "after").offset;
                ranges[index] = { ...range, anchor: endpoint(range.anchor), head: endpoint(range.head) };
            }
            state.workUnits++; if (checkpoint(state)) yield;
        }
    }
    bulk(state, ranges.length);
    return yield* publish(edits, createSelectionSet(buffer.length + delta, ranges, selections.primary), state);
}

/** Lazy, DOM-free planning. Budgets count work, not milliseconds; only ready publishes a complete proposal. */
export function planLanguageEdit(buffer: TextBuffer, selections: SelectionSet, command: EditingCommand | TypedCharacter,
    config: ResolvedLanguageConfiguration, folds?: FoldIndex): LanguageEditCursor {
    const state: MutablePlanning = { phase: "validate", workUnits: 0, readUnits: 0, bulkWorkUnits: 0, checkpoint: 0 };
    return kernelCursor(plan(buffer, selections, command, config, state, folds), () => state.workUnits,
        (status, result, failure) => Object.freeze({ status, phase: state.phase, workUnits: state.workUnits,
            readUnits: state.readUnits, bulkWorkUnits: state.bulkWorkUnits, result, failure }), "Language edit");
}
function* plan(buffer: TextBuffer, selections: SelectionSet, command: EditingCommand | TypedCharacter,
    config: ResolvedLanguageConfiguration, state: MutablePlanning, folds?: FoldIndex): Generator<void, SelectionEditPlan> {
    if (folds && folds.lineCount !== buffer.lineCount) throw new RangeError("Fold index must cover the planning buffer.");
    bulk(state, selections.ranges.length);
    const normalized = createSelectionSet(buffer.length, selections.ranges, selections.primary);
    if (checkpoint(state)) yield;
    if (normalized.primary !== selections.primary || normalized.ranges.length !== selections.ranges.length) throw new RangeError("Language edits require normalized range order.");
    for (let index = 0; index < selections.ranges.length; index++) {
        const range = selections.ranges[index]!, expected = normalized.ranges[index]!;
        if (range.anchor !== expected.anchor || range.head !== expected.head) throw new RangeError("Language edits require normalized range order.");
        state.workUnits++; if (checkpoint(state)) yield;
    }
    state.phase = "plan";
    const read = (from: number, to: number): string => {
        const text = buffer.slice(from, to); state.readUnits += text.length;
        if (text.length > 4096) bulk(state, text.length); else state.workUnits += text.length;
        return text;
    };
    const reader = { lineCount: buffer.lineCount, offsetAt: (line: number) => buffer.offsetAt(line), slice: read };
    const unit = config.insertSpaces ? " ".repeat(config.tabSize) : "\t", edits: TextEdit[] = [];
    if (command === "insert-line-above" || command === "insert-line-below" || command === "delete-lines")
        return yield* insertOrDeleteLines(buffer, selections, command, config, unit, read, state, folds);
    if (command === "move-line-up" || command === "move-line-down" || command === "copy-line-up" || command === "copy-line-down")
        return yield* shiftLines(buffer, selections, command, read, state, folds);
    if (command === "indent" || command === "indent-lines" || command === "outdent") return yield* indent(buffer, selections, command, config, read, state);
    if (command === "block-comment" && config.blockComment) return yield* blockComments(buffer, selections, config.blockComment, config.allowPair, read, state);
    if (command === "line-comment" || command === "add-line-comment" || command === "remove-line-comment") {
        if (!config.lineComment) return yield* publish(edits, selections, state);
        return yield* lineComments(buffer, selections, command, config.lineComment, config.tabSize, read, state);
    }
    const ranges: Selection[] = []; let delta = 0;
    for (const range of selections.ranges) {
        const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head), context = { buffer, from, to };
        let anchor: number, head: number;
        if (typeof command === "object") {
            const key = command.character, next = read(to, Math.min(buffer.length, to + 1));
            bulk(state, config.pairs.length * 2);
            const closing = config.pairs.find(pair => pair.close === key), opening = config.pairs.find(pair => pair.open === key);
            const allowed = (pair: EditingPair, operation: PairingContext["operation"]) => { state.workUnits++; return config.allowPair?.({ ...context, pair, operation }) ?? true; };
            if (from === to && closing && closing.open !== key) {
                const indent = yield* closerIndent(buffer, from, key, config, edits.at(-1)?.to ?? 0, read, state);
                if (indent) { edits.push(indent); delta += indent.insert.length - (indent.to - indent.from); }
            }
            const atCloser = from === to && closing !== undefined && next === key;
            if (atCloser && allowed(closing, "close") && command.canOvertype?.(from)) { anchor = head = from + delta + 1; }
            else if (opening && from !== to && allowed(opening, "surround")) {
                edits.push({ from, to: from, insert: opening.open }, { from: to, to, insert: opening.close });
                anchor = range.anchor + delta + 1; head = range.head + delta + 1; delta += 2;
            } else {
                const pair = from === to && !atCloser && opening && (!next || /[\s)\]}"'`]/.test(next)) && allowed(opening, "open");
                const insert = pair ? key + opening.close : key;
                edits.push({ from, to, insert }); anchor = head = from + delta + key.length; delta += insert.length - (to - from);
            }
        } else if (command === "newline") {
            const indent = yield* enterIndent(buffer, from, to, config, unit, read, state);
            const ending = lineEnding(reader, buffer.lineAt(from)), first = ending + indent.inner;
            const insert = first + (indent.split ? ending + indent.outer : "");
            bulk(state, insert.length);
            edits.push({ from, to, insert }); anchor = head = from + delta + first.length; delta += insert.length - (to - from);
        } else { anchor = range.anchor + delta; head = range.head + delta; }
        ranges.push({ anchor, head }); state.workUnits++; if (checkpoint(state)) yield;
    }
    state.phase = "map"; bulk(state, ranges.length);
    const selectionSet = createSelectionSet(buffer.length + delta, ranges, selections.primary);
    if (checkpoint(state)) yield;
    return yield* publish(edits, selectionSet, state);
}
