import { validateTextEdits } from "../core/changes.ts";
import { PositionMap } from "../core/positions.ts";
import type { TextEdit } from "../core/changes.ts";
import { RpcError } from "./json-rpc.ts";
import type { LspDocumentCapture } from "./lsp-session.ts";
import type { LspLineIndex, LspPosition } from "./lsp-positions.ts";

export type LspDiagnostic = Readonly<{ from: number | null; to: number | null; message: string; severity: number | null; source: string | null }>;
export type LspDiagnostics = Readonly<{ uri: string; version: number | null; revision: number | null; items: readonly LspDiagnostic[] }>;
export type LspCompletionPlan = Readonly<{ edits: readonly TextEdit[]; head: number }>;
export type LspCompletion = Readonly<{ label: string; detail: string; insert: LspCompletionPlan; replace: LspCompletionPlan }>;
export type LspCompletions = Readonly<{ incomplete: boolean; items: readonly LspCompletion[] }>;
export type LspCompletionFallback = Readonly<{ from: number; to: number; replaceTo: number }>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const uint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
function invalid(): never { throw new TypeError("Malformed or unsupported LSP feature result."); }
function current(capture: LspDocumentCapture): void { if (!capture.isCurrent()) throw new RpcError(-32801, "LSP feature capture expired."); }
function text(value: unknown, maximum: number, budget: { units: number }): string {
    if (typeof value !== "string" || value.length > maximum || (budget.units -= value.length) < 0) invalid(); return value;
}
function position(value: unknown): LspPosition {
    if (!record(value) || !uint(value.line) || !uint(value.character)) invalid(); return Object.freeze({ line: value.line, character: value.character });
}
function range(value: unknown): Readonly<{ start: LspPosition; end: LspPosition }> {
    if (!record(value)) invalid(); const start = position(value.start), end = position(value.end);
    if (start.line > end.line || start.line === end.line && start.character > end.character) invalid(); return { start, end };
}
/** Strict source ranges: edit/diagnostic validation never silently clamps a malformed server position. */
export function lspRangeOffsets(index: LspLineIndex, value: unknown): Readonly<{ from: number; to: number }> {
    const { start, end } = range(value), from = index.offsetAt(start), to = index.offsetAt(end), a = index.at(from), b = index.at(to);
    if (a.line !== start.line || a.character !== start.character || b.line !== end.line || b.character !== end.character) invalid();
    return Object.freeze({ from, to });
}
/** Unversioned messages remain visible information, with no claimed source anchors/revision. */
export function decodeLspDiagnostics(value: unknown, capture: LspDocumentCapture): LspDiagnostics {
    current(capture); if (!record(value) || value.uri !== capture.document.uri || !Array.isArray(value.diagnostics) || value.diagnostics.length > 256) invalid();
    const version = value.version === undefined ? null : value.version;
    if (version !== null && !uint(version) || value.version === null) invalid();
    if (version !== null && version !== capture.version) throw new RpcError(-32801, "Diagnostics refer to another document version.");
    const budget = { units: 65536 }, items = value.diagnostics.map((item: unknown): LspDiagnostic => {
        if (!record(item)) invalid(); const wire = range(item.range), offsets = version === null ? null : lspRangeOffsets(capture.index, wire);
        const message = text(item.message, 4096, budget), source = item.source === undefined ? null : text(item.source, 1024, budget);
        if (item.severity !== undefined && (!uint(item.severity) || item.severity < 1 || item.severity > 4)) invalid();
        return Object.freeze({ from: offsets?.from ?? null, to: offsets?.to ?? null, message, severity: item.severity as number | undefined ?? null, source });
    });
    current(capture); return Object.freeze({ uri: capture.document.uri, version, revision: version === null ? null : capture.document.revision, items: Object.freeze(items) });
}
function edit(index: LspLineIndex, value: unknown, budget: { units: number }): TextEdit {
    if (!record(value)) invalid(); return Object.freeze({ ...lspRangeOffsets(index, value.range), insert: text(value.newText, 16384, budget) });
}
function plan(index: LspLineIndex, primary: TextEdit, additional: readonly TextEdit[]): LspCompletionPlan {
    const edits = [...additional, primary].sort((a, b) => a.from - b.from || a.to - b.to); validateTextEdits(index.buffer.length, edits);
    for (let i = 1; i < edits.length; i++) if (edits[i]!.from === edits[i - 1]!.from) invalid();
    const head = new PositionMap(index.buffer.length, additional).map(primary.from, "before").offset + primary.insert.length;
    return Object.freeze({ edits: Object.freeze(edits), head });
}
/** Complete validation precedes publication; no server-supplied command, snippet or HTML is executed. */
export function decodeLspCompletions(value: unknown, capture: LspDocumentCapture, offset: number, fallback: LspCompletionFallback | (() => LspCompletionFallback) = { from: offset, to: offset, replaceTo: offset }): LspCompletions {
    current(capture); const index = capture.index, point = index.at(offset), budget = { units: 65536 }; let incomplete = false, defaults: Record<string, unknown> = {}, values: unknown[];
    if (value === null) values = [];
    else if (Array.isArray(value)) values = value;
    else { if (!record(value) || typeof value.isIncomplete !== "boolean" || !Array.isArray(value.items)) invalid(); incomplete = value.isIncomplete; values = value.items;
        if (value.itemDefaults !== undefined) { if (!record(value.itemDefaults) || Object.keys(value.itemDefaults).some(key => !["editRange", "insertTextFormat", "insertTextMode"].includes(key))) invalid(); defaults = value.itemDefaults;
            if (defaults.insertTextFormat !== undefined && defaults.insertTextFormat !== 1 || defaults.insertTextMode !== undefined && defaults.insertTextMode !== 1) invalid();
            if (defaults.editRange !== undefined) {
                const value = defaults.editRange; if (!record(value)) invalid();
                const insert = lspRangeOffsets(index, "start" in value ? value : value.insert), replace = lspRangeOffsets(index, "start" in value ? value : value.replace);
                if (insert.from !== replace.from || insert.to > replace.to || insert.from > offset || insert.to < offset || [insert.from, insert.to, replace.to].some(at => index.at(at).line !== point.line)) invalid();
            }
        } }
    if (values.length > 256) invalid(); let edits = 0, fallbackRange: LspCompletionFallback | undefined;
    const items = values.map((item: unknown): LspCompletion => {
        if (!record(item) || item.command !== undefined || (item.insertTextFormat ?? defaults.insertTextFormat ?? 1) !== 1 || (item.insertTextMode ?? defaults.insertTextMode ?? 1) !== 1) invalid();
        const label = text(item.label, 1024, budget); if (!label) invalid(); const detail = item.detail === undefined ? "" : text(item.detail, 4096, budget);
        let insert: TextEdit, replace: TextEdit;
        if (item.textEdit !== undefined) {
            if (!record(item.textEdit)) invalid(); const inserted = text(item.textEdit.newText, 16384, budget);
            if ("range" in item.textEdit) { if ("insert" in item.textEdit || "replace" in item.textEdit) invalid(); insert = replace = Object.freeze({ ...lspRangeOffsets(index, item.textEdit.range), insert: inserted }); }
            else { insert = Object.freeze({ ...lspRangeOffsets(index, item.textEdit.insert), insert: inserted }); replace = Object.freeze({ ...lspRangeOffsets(index, item.textEdit.replace), insert: inserted }); }
        } else {
            const editRange = defaults.editRange, inserted = text(editRange === undefined ? item.insertText ?? label : item.textEditText ?? label, 16384, budget);
            if (editRange !== undefined) {
                if (!record(editRange)) invalid();
                if ("start" in editRange) insert = replace = Object.freeze({ ...lspRangeOffsets(index, editRange), insert: inserted });
                else { insert = Object.freeze({ ...lspRangeOffsets(index, editRange.insert), insert: inserted }); replace = Object.freeze({ ...lspRangeOffsets(index, editRange.replace), insert: inserted }); }
            } else { fallbackRange ??= typeof fallback === "function" ? fallback() : fallback;
                insert = Object.freeze({ from: fallbackRange.from, to: fallbackRange.to, insert: inserted }); replace = Object.freeze({ from: fallbackRange.from, to: fallbackRange.replaceTo, insert: inserted }); }
        }
        if (insert.from !== replace.from || insert.to > replace.to || insert.from > offset || insert.to < offset) invalid();
        for (const at of [insert.from, insert.to, replace.to]) if (index.at(at).line !== point.line) invalid();
        let additional: TextEdit[] = [];
        if (item.additionalTextEdits !== undefined) { if (!Array.isArray(item.additionalTextEdits) || item.additionalTextEdits.length > 32) invalid(); additional = item.additionalTextEdits.map(value => edit(index, value, budget)).sort((a, b) => a.from - b.from || a.to - b.to); }
        if ((edits += 1 + additional.length) > 1024) invalid();
        return Object.freeze({ label, detail, insert: plan(index, insert, additional), replace: plan(index, replace, additional) });
    });
    current(capture); return Object.freeze({ incomplete, items: Object.freeze(items) });
}
