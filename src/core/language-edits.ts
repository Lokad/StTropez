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

export type EditingCommand = "indent" | "outdent" | "line-comment" | "block-comment" | "newline";
export type EditingPair = Readonly<{ open: string; close: string }>;
export type LanguageEditContext = Readonly<{ buffer: TextBuffer; from: number; to: number }>;
export type PairingContext = LanguageEditContext & Readonly<{ pair: EditingPair; operation: "open" | "close" | "surround" }>;
export type EnterIndent = Readonly<{ indent: -1 | 0 | 1; split?: boolean }>;
/** Callbacks inspect this exact immutable buffer; language analysis and its cost belong to the host. */
export type LanguageConfiguration = Readonly<{
    tabSize?: number; insertSpaces?: boolean;
    lineComment?: string; blockComment?: EditingPair;
    pairs?: readonly EditingPair[];
    allowPair?: (context: PairingContext) => boolean;
    enter?: "keep" | ((context: LanguageEditContext) => EnterIndent);
}>;
export type ResolvedLanguageConfiguration = LanguageConfiguration & Readonly<{ tabSize: number; insertSpaces: boolean; pairs: readonly EditingPair[] }>;
const defaultPairs: readonly EditingPair[] = [{ open: "(", close: ")" }, { open: "[", close: "]" }, { open: "{", close: "}" }];

export function resolveLanguageConfiguration(value: LanguageConfiguration = {}): ResolvedLanguageConfiguration {
    const tabSize = value.tabSize ?? 4;
    if (!Number.isSafeInteger(tabSize) || tabSize < 1 || tabSize > 256) throw new RangeError("tabSize must be an integer from 1 to 256.");
    const pair = (value: EditingPair, single: boolean): EditingPair => {
        if (!value.open || !value.close || /[\r\n]/.test(value.open + value.close) || single && (value.open.length !== 1 || value.close.length !== 1)) throw new RangeError("Invalid editing delimiter.");
        return Object.freeze({ open: value.open, close: value.close });
    };
    if (value.lineComment !== undefined && (!value.lineComment || /[\r\n]/.test(value.lineComment))) throw new RangeError("Invalid line comment delimiter.");
    const pairs = Object.freeze((value.pairs ?? defaultPairs).map(value => pair(value, true)));
    if (new Set(pairs.map(pair => pair.open)).size !== pairs.length) throw new RangeError("Duplicate opening delimiter.");
    return Object.freeze({ ...value, tabSize, insertSpaces: value.insertSpaces ?? true, pairs,
        ...(value.blockComment ? { blockComment: pair(value.blockComment, false) } : {}) });
}

function* whitespace(read: (from: number, to: number) => string, state: MutablePlanning, from: number, to: number): Generator<void, number> {
    while (from < to) {
        const text = read(from, Math.min(to, from + 4096)), length = /^[ \t]*/.exec(text)![0].length;
        from += length;
        if (checkpoint(state)) yield;
        if (length < text.length) break;
    }
    return from;
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

/** Lazy, DOM-free planning. Budgets count work, not milliseconds; only ready publishes a complete proposal. */
export function planLanguageEdit(buffer: TextBuffer, selections: SelectionSet, command: EditingCommand | Readonly<{ character: string }>,
    config: ResolvedLanguageConfiguration): LanguageEditCursor {
    const state: MutablePlanning = { phase: "validate", workUnits: 0, readUnits: 0, bulkWorkUnits: 0, checkpoint: 0 };
    return kernelCursor(plan(buffer, selections, command, config, state), () => state.workUnits,
        (status, result, failure) => Object.freeze({ status, phase: state.phase, workUnits: state.workUnits,
            readUnits: state.readUnits, bulkWorkUnits: state.bulkWorkUnits, result, failure }), "Language edit");
}
function* plan(buffer: TextBuffer, selections: SelectionSet, command: EditingCommand | Readonly<{ character: string }>,
    config: ResolvedLanguageConfiguration, state: MutablePlanning): Generator<void, SelectionEditPlan> {
    bulk(state, selections.ranges.length);
    const normalized = createSelectionSet(buffer.length, selections.ranges, selections.primary);
    if (checkpoint(state)) yield;
    if (normalized.primary !== selections.primary || normalized.ranges.length !== selections.ranges.length) throw new RangeError("Language edits require normalized range order.");
    let selected = false;
    for (let index = 0; index < selections.ranges.length; index++) {
        const range = selections.ranges[index]!, expected = normalized.ranges[index]!;
        if (range.anchor !== expected.anchor || range.head !== expected.head) throw new RangeError("Language edits require normalized range order.");
        selected ||= range.anchor !== range.head;
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
    if (command === "indent" || command === "outdent" || command === "line-comment") {
        if (command === "line-comment" && !config.lineComment) return yield* publish(edits, selections, state);
        if (command !== "indent" || selected) {
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
                if (command === "line-comment") {
                    const end = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) : buffer.length;
                    const at = yield* whitespace(read, state, from, end), next = read(at, Math.min(end, at + config.lineComment!.length));
                    const blank = !next || /^[\r\n]/.test(next), commented = next === config.lineComment;
                    if (!blank) { anyText = true; allCommented &&= commented; }
                    comments.push({ from: at, commented, blank });
                } else {
                    const prefix = read(from, Math.min(buffer.length, from + config.tabSize));
                    const removed = outdentLength(prefix, config.tabSize);
                    if (command === "indent" || removed) edits.push({ from, to: from + (command === "outdent" ? removed : 0), insert: command === "outdent" ? "" : unit });
                }
                state.workUnits++; if (checkpoint(state)) yield;
            }
            if (command === "line-comment") for (const line of comments) {
                state.workUnits++; if (checkpoint(state)) yield;
                if (line.blank && anyText) continue;
                const uncomment = anyText && allCommented;
                const end = line.from + config.lineComment!.length;
                const space = uncomment && read(end, Math.min(buffer.length, end + 1)) === " " ? 1 : 0;
                edits.push({ from: line.from, to: uncomment ? end + space : line.from, insert: uncomment ? "" : config.lineComment! + " " });
            }
            return yield* mapped(buffer, selections, edits, state);
        }
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
            if (from === to && closing && next === key && allowed(closing, "close")) { anchor = head = from + delta + 1; }
            else if (opening && from !== to && allowed(opening, "surround")) {
                edits.push({ from, to: from, insert: opening.open }, { from: to, to, insert: opening.close });
                anchor = range.anchor + delta + 1; head = range.head + delta + 1; delta += 2;
            } else {
                const pair = from === to && opening && (!next || /[\s)\]}"'`]/.test(next)) && allowed(opening, "open");
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
        } else if (command === "indent") {
            edits.push({ from, to, insert: unit }); anchor = head = from + delta + unit.length; delta += unit.length - (to - from);
        } else { anchor = range.anchor + delta; head = range.head + delta; }
        ranges.push({ anchor, head }); state.workUnits++; if (checkpoint(state)) yield;
    }
    state.phase = "map"; bulk(state, ranges.length);
    const selectionSet = createSelectionSet(buffer.length + delta, ranges, selections.primary);
    if (checkpoint(state)) yield;
    return yield* publish(edits, selectionSet, state);
}
