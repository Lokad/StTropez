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

export type EditingCommand = "indent" | "indent-lines" | "outdent" | "line-comment" | "add-line-comment" | "remove-line-comment" | "block-comment" | "newline";
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
/** Internal shared convention: use this LF row's ending, or the preceding ending at EOF. */
export function lineEnding(buffer: Pick<TextBuffer, "lineCount" | "offsetAt" | "slice">, line: number): "\n" | "\r\n" {
    const end = buffer.offsetAt(line + 1 < buffer.lineCount ? line + 1 : line);
    return end >= 2 && buffer.slice(end - 2, end) === "\r\n" ? "\r\n" : "\n";
}
export function lineContentEnd(buffer: TextBuffer, line: number): number {
    return line + 1 === buffer.lineCount ? buffer.length : buffer.offsetAt(line + 1) - lineEnding(buffer, line).length;
}

/** Carets arrive in document order. Reuse the scanned prefix when several occupy one line. */
export function lineColumnScanner(read: (from: number, to: number) => string, tabSize: number) {
    let lineStart = -1, offset = 0, column = 0, previousStop = 0, indentation = true;
    return function* scan(start: number, to: number, indentOnly = false): Generator<void, { column: number; previousStop: number; indentation: boolean }> {
        if (lineStart !== start || offset > to) {
            lineStart = start; offset = previousStop = start; column = 0; indentation = true;
        }
        while (offset < to && (!indentOnly || indentation)) {
            const text = read(offset, Math.min(to, offset + 1024));
            for (let i = 0; i < text.length; i++) {
                const ch = text.charCodeAt(i);
                if (column % tabSize === 0) previousStop = offset;
                column += ch === 9 ? tabSize - column % tabSize : 1;
                offset++;
                if (ch !== 32 && ch !== 9) { indentation = false; if (indentOnly) break; }
            }
            yield;
        }
        return { column, previousStop, indentation };
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

function* indent(buffer: TextBuffer, selections: SelectionSet, config: ResolvedLanguageConfiguration,
    read: (from: number, to: number) => string, state: MutablePlanning): Generator<void, SelectionEditPlan> {
    const { tabSize, insertSpaces } = config, unit = insertSpaces ? " ".repeat(tabSize) : "\t";
    const scan = lineColumnScanner(read, tabSize), edits: TextEdit[] = [];
    const replacements = new Map<TextEdit, number>();
    let lastIndented = -1;
    for (const [index, range] of selections.ranges.entries()) {
        const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head);
        const first = buffer.lineAt(from), last = buffer.lineAt(to), start = buffer.offsetAt(first), end = lineContentEnd(buffer, first);
        if (from !== to && (first !== last || from === start && to === end)) {
            const through = first !== last && to === buffer.offsetAt(last) ? last - 1 : last;
            for (let line = Math.max(first, lastIndented + 1); line <= through; line++) {
                const at = buffer.offsetAt(line);
                edits.push({ from: at, to: at, insert: unit }); state.workUnits++;
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
        replacements.set(edit, index); state.workUnits++;
        if (checkpoint(state)) yield;
    }
    if (!replacements.size) return yield* mapped(buffer, selections, edits, state);
    // Line shifts precede an inline replacement at the same offset. Each inline caret
    // lands after its own edit, including when two replacements share a boundary.
    const hasLineShifts = edits.length > 0;
    for (const edit of replacements.keys()) edits.push(edit);
    bulk(state, edits.length);
    if (hasLineShifts) edits.sort((a, b) => a.from - b.from || a.to - b.to);
    if (checkpoint(state)) yield;
    state.phase = "map";
    const ranges: Selection[] = new Array(selections.ranges.length);
    let delta = 0;
    for (const edit of edits) {
        const index = replacements.get(edit);
        if (index !== undefined) {
            const head = edit.from + delta + edit.insert.length;
            ranges[index] = { anchor: head, head };
        }
        delta += edit.insert.length - (edit.to - edit.from);
        state.workUnits++; if (checkpoint(state)) yield;
    }
    if (hasLineShifts) {
        const map = new PositionMap(buffer.length, edits).createMapper();
        bulk(state, edits.length);
        for (const [index, range] of selections.ranges.entries()) {
            if (!ranges[index]) ranges[index] = { ...range, anchor: map(range.anchor, "after").offset, head: map(range.head, "after").offset };
            state.workUnits++; if (checkpoint(state)) yield;
        }
    }
    bulk(state, ranges.length);
    return yield* publish(edits, createSelectionSet(buffer.length + delta, ranges, selections.primary), state);
}

/** Lazy, DOM-free planning. Budgets count work, not milliseconds; only ready publishes a complete proposal. */
export function planLanguageEdit(buffer: TextBuffer, selections: SelectionSet, command: EditingCommand | TypedCharacter,
    config: ResolvedLanguageConfiguration): LanguageEditCursor {
    const state: MutablePlanning = { phase: "validate", workUnits: 0, readUnits: 0, bulkWorkUnits: 0, checkpoint: 0 };
    return kernelCursor(plan(buffer, selections, command, config, state), () => state.workUnits,
        (status, result, failure) => Object.freeze({ status, phase: state.phase, workUnits: state.workUnits,
            readUnits: state.readUnits, bulkWorkUnits: state.bulkWorkUnits, result, failure }), "Language edit");
}
function* plan(buffer: TextBuffer, selections: SelectionSet, command: EditingCommand | TypedCharacter,
    config: ResolvedLanguageConfiguration, state: MutablePlanning): Generator<void, SelectionEditPlan> {
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
    if (command === "indent") return yield* indent(buffer, selections, config, read, state);
    const commenting = command === "line-comment" || command === "add-line-comment" || command === "remove-line-comment";
    if (command === "outdent" || command === "indent-lines" || commenting) {
        if (commenting && !config.lineComment) return yield* publish(edits, selections, state);
        const intervals: { first: number; last: number }[] = [];
        for (const range of selections.ranges) {
            const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head);
            const first = buffer.lineAt(from), last = buffer.lineAt(to > from && buffer.offsetAt(buffer.lineAt(to)) === to ? to - 1 : to), previous = intervals.at(-1);
            if (previous && first <= previous.last + 1) previous.last = Math.max(previous.last, last); else intervals.push({ first, last });
            state.workUnits++; if (checkpoint(state)) yield;
        }
        const comments: { from: number; commented: boolean; blank: boolean }[] = [];
        let allCommented = true, anyText = false;
        for (const interval of intervals) for (let line = interval.first; line <= interval.last; line++) {
            const from = buffer.offsetAt(line);
            if (commenting) {
                const end = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) : buffer.length;
                const at = yield* whitespace(read, state, from, end), next = read(at, Math.min(end, at + config.lineComment!.length));
                const blank = !next || /^[\r\n]/.test(next), commented = next === config.lineComment;
                if (!blank) { anyText = true; allCommented &&= commented; }
                comments.push({ from: at, commented, blank });
            } else if (command === "indent-lines") {
                edits.push({ from, to: from, insert: unit });
            } else {
                const prefix = read(from, Math.min(buffer.length, from + config.tabSize));
                const removed = outdentLength(prefix, config.tabSize);
                if (removed) edits.push({ from, to: from + removed, insert: "" });
            }
            state.workUnits++; if (checkpoint(state)) yield;
        }
        if (commenting) for (const line of comments) {
            state.workUnits++; if (checkpoint(state)) yield;
            if (line.blank && anyText) continue;
            if (command === "add-line-comment" && line.commented || command === "remove-line-comment" && !line.commented) continue;
            const uncomment = command === "remove-line-comment" || command === "line-comment" && anyText && allCommented;
            const end = line.from + config.lineComment!.length;
            const space = uncomment && read(end, Math.min(buffer.length, end + 1)) === " " ? 1 : 0;
            edits.push({ from: line.from, to: uncomment ? end + space : line.from, insert: uncomment ? "" : config.lineComment! + " " });
        }
        return yield* mapped(buffer, selections, edits, state);
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
        } else if (command === "block-comment" && config.blockComment) {
            const { open, close } = config.blockComment;
            const includes = to - from >= open.length + close.length && read(from, from + open.length) === open && read(to - close.length, to) === close;
            const inside = from >= open.length && to + close.length <= buffer.length && read(from - open.length, from) === open && read(to, to + close.length) === close;
            if (includes || inside) {
                const left = includes ? from : from - open.length, right = includes ? to - close.length : to;
                edits.push({ from: left, to: left + open.length, insert: "" }, { from: right, to: right + close.length, insert: "" });
                const low = left + delta, high = right - open.length + delta;
                anchor = range.anchor <= range.head ? low : high; head = range.anchor <= range.head ? high : low; delta -= open.length + close.length;
            } else {
                if (from === to) edits.push({ from, to, insert: open + close });
                else edits.push({ from, to: from, insert: open }, { from: to, to, insert: close });
                anchor = range.anchor + delta + open.length; head = range.head + delta + open.length; delta += open.length + close.length;
            }
        } else if (command === "newline") {
            if (typeof config.enter === "function") state.workUnits++;
            const rule = typeof config.enter === "function" ? config.enter(context) : { indent: 0 as const };
            const line = buffer.lineAt(from), start = buffer.offsetAt(line), end = config.enter ? yield* whitespace(read, state, start, from) : start;
            let indent = read(start, end);
            if (rule.indent === -1) indent = indent.slice(outdentLength(indent, config.tabSize));
            const ending = lineEnding(reader, line), inner = indent + (rule.indent === 1 ? unit : ""), first = ending + inner;
            const insert = first + (rule.split ? ending + indent : "");
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
