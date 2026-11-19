import { applyTextEdits, validateTextEdits } from "./changes.ts";
import type { TextEdit } from "./changes.ts";
import { PositionMap } from "./positions.ts";
import { createSelectionSet } from "./selections.ts";
import type { SelectionSet } from "./selections.ts";
import type { TextBuffer } from "./text-buffer.ts";
import { adjustInsertionText, insertionContext, reindentInsertionText } from "./insertion-text.ts";
import type { InsertionContext, InsertionMarkerIndentation } from "./insertion-text.ts";
import { snippetFieldMapper } from "./snippet-fields.ts";

export type SnippetOccurrence = Readonly<{ from: number; to: number; order: number; insertion?: InsertionContext; firstLine?: InsertionMarkerIndentation; group?: number }>;
export type SnippetStop = Readonly<{ index: number; choices: readonly string[]; ranges: readonly SnippetOccurrence[] }>;
export type Snippet = Readonly<{ text: string; stops: readonly SnippetStop[] }>;
export type SnippetParseResult = Readonly<{ snippet: Snippet; reason?: never } | { reason: string; snippet?: never }>;
class UnsupportedSnippet extends Error {}

/** Numbered stops, literal defaults/choices and mirrors; no variables, nesting or transforms. */
export function parseSnippet(source: string, maxExpandedUnits = Number.MAX_SAFE_INTEGER): SnippetParseResult {
    if (!Number.isSafeInteger(maxExpandedUnits) || maxExpandedUnits < 0) throw new TypeError("Invalid snippet input or expansion limit.");
    const fail = (reason: string): never => { throw new UnsupportedSnippet(reason); };
    type Part = string | { index: number };
    const parts: Part[] = [], definitions = new Map<number, { text: string; choices: readonly string[] }>();
    let at = 0, literal = "";
    const flush = () => { if (literal) { parts.push(literal); literal = ""; } };
    const escaped = (choice = false): string => {
        const next = source[at + 1];
        if (next && ("\\$}".includes(next) || choice && ",|".includes(next))) { at += 2; return next; }
        at++; return "\\";
    };
    try {
        while (at < source.length) {
            const char = source[at];
            if (char === "\\") { literal += escaped(); continue; }
            if (char !== "$") { literal += char; at++; continue; }
            if (!/[0-9{_a-zA-Z]/.test(source[at + 1] ?? "")) { literal += "$"; at++; continue; }
            flush(); at++; const braced = source[at] === "{"; if (braced) at++;
            const start = at; while (/[0-9]/.test(source[at] ?? "")) at++;
            if (at === start) fail("Snippet variables are not supported.");
            const index = Number(source.slice(start, at)); if (!Number.isSafeInteger(index)) fail("Invalid snippet stop number.");
            let text: string | undefined, choices: readonly string[] = Object.freeze([]);
            if (braced) {
                const delimiter = source[at++];
                if (delimiter === ":" || delimiter === "|") {
                    const values: string[] = []; let value = "", closed = false;
                    while (at < source.length) {
                        if (source[at] === "\\") { value += escaped(delimiter === "|"); continue; }
                        if (delimiter === ":" && source[at] === "}") { at++; closed = true; break; }
                        if (delimiter === "|" && source[at] === "|" && source[at + 1] === "}") { at += 2; closed = true; break; }
                        if (delimiter === ":" && source[at] === "$" && /[0-9{_a-zA-Z]/.test(source[at + 1] ?? "")) fail("Nested snippet placeholders and variables are not supported.");
                        if (delimiter === "|" && source[at] === ",") { values.push(value); value = ""; at++; }
                        else value += source[at++];
                    }
                    if (!closed) fail("Unclosed snippet placeholder or choice.");
                    values.push(value); choices = Object.freeze(delimiter === "|" ? values : []); text = values[0]!;
                } else if (delimiter !== "}") fail("Snippet transforms or malformed stops are not supported.");
            }
            if (text !== undefined) {
                const prior = definitions.get(index);
                if (prior && (prior.text !== text || JSON.stringify(prior.choices) !== JSON.stringify(choices))) fail("Conflicting defaults for one snippet stop.");
                definitions.set(index, { text, choices });
            }
            parts.push({ index });
        }
        flush();
        let length = 0;
        for (const part of parts) { length += typeof part === "string" ? part.length : definitions.get(part.index)?.text.length ?? 0;
            if (length > maxExpandedUnits) fail("Expanded snippet exceeds the insertion limit."); }
        const output: string[] = [], groups = new Map<number, SnippetOccurrence[]>(); let offset = 0;
        for (const [order, part] of parts.entries()) {
            const text = typeof part === "string" ? part : definitions.get(part.index)?.text ?? "";
            if (typeof part !== "string") { const ranges = groups.get(part.index) ?? [];
                ranges.push(Object.freeze({ from: offset, to: offset + text.length, order })); groups.set(part.index, ranges); }
            output.push(text); offset += text.length;
        }
        if (!groups.has(0)) groups.set(0, [Object.freeze({ from: offset, to: offset, order: parts.length })]);
        const stops = [...groups].sort(([a], [b]) => a === 0 ? 1 : b === 0 ? -1 : a - b)
            .map(([index, ranges]) => Object.freeze({ index, choices: definitions.get(index)?.choices ?? Object.freeze([]), ranges: Object.freeze(ranges) }));
        return Object.freeze({ snippet: Object.freeze({ text: output.join(""), stops: Object.freeze(stops) }) });
    } catch (error) { if (error instanceof UnsupportedSnippet) return Object.freeze({ reason: error.message }); throw error; }
}

export function offsetSnippetStops(stops: readonly SnippetStop[], offset: number): readonly SnippetStop[] {
    return Object.freeze(stops.map(stop => Object.freeze({ ...stop, ranges: Object.freeze(stop.ranges.map(range => Object.freeze({ ...range, from: range.from + offset, to: range.to + offset }))) })));
}

export type SnippetEditPlan = Readonly<{ edits: readonly TextEdit[]; selectionSet: SelectionSet; stops: readonly SnippetStop[] }>;

/** Mirror an ordinary input edit through every flat occurrence, including coincident empty stops. */
export function planSnippetEdit(buffer: TextBuffer, stops: readonly SnippetStop[], active: number,
    edits: readonly TextEdit[], before: SelectionSet, after: SelectionSet, adjustNewlines = false): SnippetEditPlan | undefined {
    const stop = stops[active], selected = before.ranges[before.primary];
    if (!stop || stop.index === 0 || !selected || edits.length !== before.ranges.length) return;
    const occurrence = stop.ranges.find(range => range.from <= Math.min(selected.anchor, selected.head) && range.to >= Math.max(selected.anchor, selected.head));
    const primary = edits[before.primary]; if (!occurrence || !primary || primary.from < occurrence.from || primary.to > occurrence.to) return;
    validateTextEdits(buffer.length, edits);
    if (stop.ranges.some(range => range.insertion)) return contextualEdit(buffer, stops, active, edits, before, after, occurrence, adjustNewlines);
    const from = primary.from - occurrence.from, to = primary.to - occurrence.from;
    const permitted = new Set(stop.ranges.map(range => `${range.from + from}:${range.from + to}`));
    if (edits.some(edit => edit.insert !== primary.insert || !permitted.has(`${edit.from}:${edit.to}`))) return;
    const text = applyTextEdits(buffer.slice(occurrence.from, occurrence.to), [{ from, to, insert: primary.insert }]);
    const mapping = new PositionMap(buffer.length, edits), origin = mapping.map(occurrence.from, "before").offset;
    const caret = after.ranges[after.primary]!, anchor = caret.anchor - origin, head = caret.head - origin;
    if (anchor < 0 || head < 0 || anchor > text.length || head > text.length) return;
    return finishSnippetEdit(buffer.length, stops, active, stop.ranges.map(range => ({ edit: { from: range.from + from, to: range.from + to, insert: primary.insert }, anchor, head })), stop.ranges.indexOf(occurrence));
}
type FieldEdit = { edit: TextEdit; anchor: number; head: number };
function finishSnippetEdit(length: number, stops: readonly SnippetStop[], active: number, edits: readonly FieldEdit[], primary: number): SnippetEditPlan {
    const activeRanges = new Map(stops[active]!.ranges.map((range, index) => [range, edits[index]!]));
    const replacements = Object.freeze(edits.map(item => Object.freeze(item.edit))); validateTextEdits(length, replacements);
    const occurrences = stops.flatMap(item => item.ranges).sort((a, b) => a.order - b.order);
    const mapped = new Map<SnippetOccurrence, SnippetOccurrence>(); let delta = 0;
    for (const range of occurrences) {
        const edit = activeRanges.get(range)?.edit, growth = edit ? edit.insert.length - (edit.to - edit.from) : 0;
        const from = range.from + delta, to = range.to + delta + growth;
        mapped.set(range, Object.freeze({ ...range, from, to })); delta += growth;
    }
    const next = Object.freeze(stops.map(stop => Object.freeze({ ...stop, ranges: Object.freeze(stop.ranges.map(range => mapped.get(range)!)) })));
    return Object.freeze({ edits: replacements, stops: next, selectionSet: createSelectionSet(length + delta,
        next[active]!.ranges.map((range, index) => ({ anchor: range.from + edits[index]!.anchor, head: range.from + edits[index]!.head })), primary) });
}

function contextualEdit(buffer: TextBuffer, stops: readonly SnippetStop[], active: number, edits: readonly TextEdit[], before: SelectionSet, after: SelectionSet,
    occurrence: SnippetOccurrence, adjustNewlines: boolean): SnippetEditPlan | undefined {
    const stop = stops[active]!, primary = edits[before.primary]!, source = buffer.slice(occurrence.from, occurrence.to);
    const relative = { from: primary.from - occurrence.from, to: primary.to - occurrence.from, insert: primary.insert };
    const value = applyTextEdits(source, [relative]), origin = new PositionMap(buffer.length, edits).map(occurrence.from, "before").offset;
    const caret = after.ranges[after.primary]!, anchor = caret.anchor - origin, head = caret.head - origin;
    if (anchor < 0 || head < 0 || anchor > value.length || head > value.length) return;
    const fields: { range: SnippetOccurrence; text: string; value: string; edit: TextEdit; anchor: number; head: number }[] = [];
    const beforeMapping = snippetFieldMapper(source, occurrence.insertion?.tabSize ?? 4), afterMapping = snippetFieldMapper(value, occurrence.insertion?.tabSize ?? 4);
    const newlineContext = adjustNewlines && relative.insert.includes("\n") && occurrence.insertion ? insertionContext(buffer, primary.from, occurrence.insertion) : undefined;
    for (const range of stop.ranges) {
        const text = range === occurrence ? source : buffer.slice(range.from, range.to), mapping = beforeMapping(text);
        if (!mapping) return;
        const from = mapping.map(relative.from), to = relative.from === relative.to ? from : Math.max(from, mapping.map(relative.to, "before"));
        const insert = newlineContext && range.insertion
            ? reindentInsertionText(relative.insert, newlineContext.columns, insertionContext(buffer, range.from + from, range.insertion)).text : relative.insert;
        const indent = range !== occurrence && range.insertion && (relative.from !== 0 || relative.to !== source.length) ? mapping.indentEdit(relative, range.insertion) : undefined;
        const edit = range === occurrence ? relative : indent ?? { from, to, insert }, next = range === occurrence ? value : applyTextEdits(text, [edit]);
        const selected = afterMapping(next); if (!selected) return;
        fields.push({ range, text, value: next, edit: { from: range.from + edit.from, to: range.from + edit.to, insert: edit.insert },
            anchor: selected.map(anchor, caret.anchorAffinity), head: selected.map(head, caret.headAffinity) });
    }
    // Every actual selection/edit must agree with the mirrored intent. An unrelated batch
    // ends snippet mode; the editor can still apply that original user edit normally.
    let cursor = 0;
    for (const [index, edit] of edits.entries()) {
        const selection = before.ranges[index]!;
        const from = Math.min(selection.anchor, selection.head, edit.from), to = Math.max(selection.anchor, selection.head, edit.to);
        while (cursor < fields.length && fields[cursor]!.range.to < from) cursor++;
        let accepted = false;
        for (let candidate = cursor; candidate < fields.length && fields[candidate]!.range.from <= from; candidate++) {
            const field = fields[candidate]!;
            if (field.range.to >= to && applyTextEdits(field.text, [{ from: edit.from - field.range.from, to: edit.to - field.range.from, insert: edit.insert }]) === field.value) { accepted = true; break; }
        }
        if (!accepted) return;
    }
    return finishSnippetEdit(buffer.length, stops, active, fields, stop.ranges.indexOf(occurrence));
}

/** The provider's choice text is contextual only at explicit choice acceptance. Ordinary
 * paste and composition stay literal; editor newline commands opt into contextual transfer. */
export function snippetChoiceText(stop: SnippetStop, range: SnippetOccurrence, choice: number, maxUnits = Number.MAX_SAFE_INTEGER): string | undefined {
    if (!Number.isSafeInteger(maxUnits) || maxUnits < 0) throw new RangeError("Invalid snippet insertion limit.");
    const value = stop.choices[choice];
    if (value === undefined) return;
    if (range.insertion) {
        if (range.firstLine) {
            const context = range.insertion, { sourceColumns, columns } = range.firstLine; let end = 0, target = sourceColumns;
            while (end < value.length && (value[end] === " " || value[end] === "\t")) { target += value[end] === "\t" ? context.tabSize - target % context.tabSize : 1; end++; }
            target = Math.max(columns, target + context.columns);
            const first = context.tabSize - columns % context.tabSize;
            const tabs = context.insertSpaces || target - columns < first ? 0 : 1 + Math.floor((target - columns - first) / context.tabSize);
            const spaces = target - columns - (tabs ? first + (tabs - 1) * context.tabSize : 0);
            const limit = Math.min(Number.MAX_SAFE_INTEGER, maxUnits - (tabs + spaces - end));
            if (limit < 0) throw new RangeError("Snippet choice exceeds the insertion limit.");
            const adjusted = adjustInsertionText(value, context, limit).text;
            return "\t".repeat(tabs) + " ".repeat(spaces) + adjusted.slice(end);
        }
        return adjustInsertionText(value, range.insertion, maxUnits).text;
    }
    if (value.length > maxUnits) throw new RangeError("Snippet choice exceeds the insertion limit."); return value;
}
export function planSnippetChoice(buffer: TextBuffer, stops: readonly SnippetStop[], active: number, choice: number, primary = 0, maxUnits = Number.MAX_SAFE_INTEGER): SnippetEditPlan | undefined {
    if (!Number.isSafeInteger(maxUnits) || maxUnits < 0) throw new RangeError("Invalid snippet document limit.");
    const stop = stops[active]; if (!stop || stop.index === 0 || !stop.ranges[primary] || stop.choices[choice] === undefined) return;
    let remaining = maxUnits - buffer.length + stop.ranges.reduce((n, range) => n + range.to - range.from, 0);
    if (remaining < 0) throw new RangeError("Snippet choice exceeds the document limit.");
    const edits = stop.ranges.map(range => {
        const insert = snippetChoiceText(stop, range, choice, remaining)!; remaining -= insert.length;
        return { edit: { from: range.from, to: range.to, insert }, anchor: insert.length, head: insert.length };
    });
    return finishSnippetEdit(buffer.length, stops, active, edits, primary);
}
