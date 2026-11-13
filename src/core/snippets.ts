import { applyTextEdits, validateTextEdits } from "./changes.ts";
import type { TextEdit } from "./changes.ts";
import { PositionMap } from "./positions.ts";
import { createSelectionSet } from "./selections.ts";
import type { SelectionSet } from "./selections.ts";
import type { TextBuffer } from "./text-buffer.ts";

export type SnippetOccurrence = Readonly<{ from: number; to: number; order: number }>;
export type SnippetStop = Readonly<{ index: number; choices: readonly string[]; ranges: readonly SnippetOccurrence[] }>;
export type Snippet = Readonly<{ text: string; stops: readonly SnippetStop[] }>;
export type SnippetParseResult = Readonly<{ snippet: Snippet; reason?: never } | { reason: string; snippet?: never }>;
class UnsupportedSnippet extends Error {}

/** Numbered stops, literal defaults/choices and mirrors; no variables, nesting or transforms. */
export function parseSnippet(source: string, maxExpandedUnits = Number.MAX_SAFE_INTEGER): SnippetParseResult {
    if (typeof source !== "string" || !Number.isSafeInteger(maxExpandedUnits) || maxExpandedUnits < 0) throw new TypeError("Invalid snippet input or expansion limit.");
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
    edits: readonly TextEdit[], before: SelectionSet, after: SelectionSet): SnippetEditPlan | undefined {
    const stop = stops[active], selected = before.ranges[before.primary];
    if (!stop || stop.index === 0 || !selected || edits.length !== before.ranges.length) return;
    const occurrence = stop.ranges.find(range => range.from <= Math.min(selected.anchor, selected.head) && range.to >= Math.max(selected.anchor, selected.head));
    const primary = edits[before.primary]; if (!occurrence || !primary || primary.from < occurrence.from || primary.to > occurrence.to) return;
    validateTextEdits(buffer.length, edits);
    const from = primary.from - occurrence.from, to = primary.to - occurrence.from;
    const permitted = new Set(stop.ranges.map(range => `${range.from + from}:${range.from + to}`));
    if (edits.some(edit => edit.insert !== primary.insert || !permitted.has(`${edit.from}:${edit.to}`))) return;
    const text = applyTextEdits(buffer.slice(occurrence.from, occurrence.to), [{ from, to, insert: primary.insert }]);
    const mapping = new PositionMap(buffer.length, edits), origin = mapping.map(occurrence.from, "before").offset;
    const caret = after.ranges[after.primary]!, anchor = caret.anchor - origin, head = caret.head - origin;
    if (anchor < 0 || head < 0 || anchor > text.length || head > text.length) return;
    const replacements = Object.freeze(stop.ranges.map(range => Object.freeze({ from: range.from + from, to: range.from + to, insert: primary.insert })));
    const occurrences = stops.flatMap((item, index) => item.ranges.map(range => ({ range, active: index === active }))).sort((a, b) => a.range.order - b.range.order);
    const mapped = new Map<SnippetOccurrence, SnippetOccurrence>(); let delta = 0;
    for (const item of occurrences) {
        const range = item.range, from = range.from + delta, to = item.active ? from + text.length : range.to + delta;
        mapped.set(range, Object.freeze({ ...range, from, to })); if (item.active) delta += text.length - (range.to - range.from);
    }
    const next = Object.freeze(stops.map(stop => Object.freeze({ ...stop, ranges: Object.freeze(stop.ranges.map(range => mapped.get(range)!)) })));
    return Object.freeze({ edits: replacements, stops: next, selectionSet: createSelectionSet(buffer.length + delta,
        next[active]!.ranges.map(range => ({ anchor: range.from + anchor, head: range.from + head })), stop.ranges.indexOf(occurrence)) });
}
