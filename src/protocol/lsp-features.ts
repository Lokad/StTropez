import { validateTextEdits } from "../core/changes.ts";
import { PositionMap } from "../core/positions.ts";
import type { TextEdit } from "../core/changes.ts";
import { RpcError } from "./json-rpc.ts";
import type { LspDocumentCapture } from "./lsp-session.ts";
import type { LspLineIndex, LspPosition, LspRange } from "./lsp-positions.ts";

export type LspDiagnostic = Readonly<{ range: LspRange; placement: "placed" | "out-of-bounds"; from: number | null; to: number | null; message: string; severity: number | null; source: string | null }>;
export type LspDiagnostics = Readonly<{ uri: string; version: number | null; revision: number | null; snapshotRevision: number; freshness: "versioned" | "unversioned"; items: readonly LspDiagnostic[] }>;
export type LspCompletionPlan = Readonly<{ edits: readonly TextEdit[]; head: number }>;
export type LspCompletion = Readonly<{ label: string; detail: string; insert: LspCompletionPlan; replace: LspCompletionPlan }>;
export type LspCompletions = Readonly<{ incomplete: boolean; items: readonly LspCompletion[] }>;
export type LspCompletionFallback = Readonly<{ from: number; to: number; replaceTo: number }>;
export type LspHover = Readonly<{ text: string; range: Readonly<{ from: number; to: number }> | null }>;
export type LspLocationTarget = Pick<LspDocumentCapture, "document" | "index" | "isCurrent">;
export type LspLocation = Readonly<{ target: LspLocationTarget; from: number; to: number; targetRange: Readonly<{ from: number; to: number }>;
    originRange: Readonly<{ from: number; to: number }> | null }>;
export type LspEditTarget = LspLocationTarget & Readonly<{ version: number | null }>;
export type LspDocumentEdits = Readonly<{ target: LspEditTarget; edits: readonly TextEdit[] }>;
export type LspWorkspaceEdit = Readonly<{ documents: readonly LspDocumentEdits[]; isCurrent: () => boolean }>;
export type LspApplyEdit = Readonly<{ label: string | null; edit: LspWorkspaceEdit }>;
export type LspApplyEditResult = Readonly<{ applied: boolean; failureReason?: string }>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const uint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
function invalid(): never { throw new TypeError("Malformed or unsupported LSP feature result."); }
function current(capture: Pick<LspDocumentCapture, "isCurrent">): void { if (!capture.isCurrent()) throw new RpcError(-32801, "LSP feature capture expired."); }
function text(value: unknown, maximum: number, budget: { units: number }): string {
    if (typeof value !== "string" || value.length > maximum || (budget.units -= value.length) < 0) invalid(); return value;
}
function position(value: unknown): LspPosition {
    if (!record(value) || !uint(value.line) || !uint(value.character)) invalid(); return Object.freeze({ line: value.line, character: value.character });
}
function range(value: unknown): Readonly<{ start: LspPosition; end: LspPosition }> {
    if (!record(value)) invalid(); const start = position(value.start), end = position(value.end);
    if (start.line > end.line || start.line === end.line && start.character > end.character) invalid(); return Object.freeze({ start, end });
}
/** Strict source ranges: edit/diagnostic validation never silently clamps a malformed server position. */
export function lspRangeOffsets(index: LspLineIndex, value: unknown): Readonly<{ from: number; to: number }> {
    const { start, end } = range(value), from = index.offsetAt(start), to = index.offsetAt(end), a = index.at(from), b = index.at(to);
    if (a.line !== start.line || a.character !== start.character || b.line !== end.line || b.character !== end.character) invalid();
    return Object.freeze({ from, to });
}
/** Place valid wire ranges against this explicit snapshot without inventing a provider version.
 * Unplaceable ranges retain their message and wire range; malformed structures reject the batch.
 */
export function decodeLspDiagnostics(value: unknown, capture: LspDocumentCapture): LspDiagnostics {
    current(capture); if (!record(value) || value.uri !== capture.document.uri || !Array.isArray(value.diagnostics) || value.diagnostics.length > 256) invalid();
    const version = value.version === undefined ? null : value.version;
    if (version !== null && !uint(version) || value.version === null) invalid();
    if (version !== null && version !== capture.version) throw new RpcError(-32801, "Diagnostics refer to another document version.");
    const budget = { units: 65536 }, items = value.diagnostics.map((item: unknown): LspDiagnostic => {
        if (!record(item)) invalid(); const wire = range(item.range); let offsets: Readonly<{ from: number; to: number }> | undefined;
        try { offsets = lspRangeOffsets(capture.index, wire); } catch (error) { if (!(error instanceof TypeError || error instanceof RangeError)) throw error; }
        const message = text(item.message, 4096, budget), source = item.source === undefined ? null : text(item.source, 1024, budget);
        if (item.severity !== undefined && (!uint(item.severity) || item.severity < 1 || item.severity > 4)) invalid();
        return Object.freeze({ range: wire, placement: offsets ? "placed" : "out-of-bounds", from: offsets?.from ?? null, to: offsets?.to ?? null, message, severity: item.severity as number | undefined ?? null, source });
    });
    current(capture); return Object.freeze({ uri: capture.document.uri, version, revision: version === null ? null : capture.document.revision,
        snapshotRevision: capture.document.revision, freshness: version === null ? "unversioned" : "versioned", items: Object.freeze(items) });
}
/** Markup and legacy marked strings are displayed literally; the client advertises plain text only. */
export function decodeLspHover(value: unknown, capture: LspDocumentCapture): LspHover | null {
    current(capture); if (value === null) return null; if (!record(value)) invalid(); const budget = { units: 16384 };
    const fragment = (part: unknown): string => {
        if (typeof part === "string") return text(part, 8192, budget);
        if (!record(part)) invalid();
        if ("kind" in part) { if (part.kind !== "plaintext" && part.kind !== "markdown" || "language" in part) invalid(); return text(part.value, 8192, budget); }
        const language = text(part.language, 128, budget), body = text(part.value, 8192, budget); return language ? `${language}\n${body}` : body;
    };
    let contents: string;
    if (Array.isArray(value.contents)) { if (value.contents.length > 64) invalid(); contents = value.contents.map(part => {
            // Arrays contain MarkedString, not MarkupContent.
            if (record(part) && "kind" in part) invalid(); return fragment(part);
        }).filter(Boolean).join("\n\n"); }
    else contents = fragment(value.contents);
    if (contents.length > 16384) invalid();
    const range = value.range === undefined ? null : lspRangeOffsets(capture.index, value.range); current(capture);
    return contents ? Object.freeze({ text: contents, range }) : null;
}
/** Resolve opaque URIs through captured host buffers; never fetch or open a server-supplied URI. */
export function decodeLspLocations(value: unknown, kind: "definition" | "references", origin: LspDocumentCapture,
    resolve: (uri: string) => LspLocationTarget | undefined): readonly LspLocation[] {
    current(origin); const values = value === null ? [] : Array.isArray(value) ? value : kind === "definition" && record(value) ? [value] : invalid();
    if (values.length > 1024) invalid(); let links: boolean | undefined;
    const items = values.map((item: unknown): LspLocation => {
        if (!record(item)) invalid(); const link = "targetUri" in item;
        if (link && (kind !== "definition" || !Array.isArray(value)) || links !== undefined && links !== link) invalid(); links = link;
        const uri = link ? item.targetUri : item.uri;
        if (typeof uri !== "string" || !uri || uri.length > 4096 || link && ("uri" in item || "range" in item)) invalid();
        const target = resolve(uri); if (!target || target.document.uri !== uri || target.index.buffer !== target.document.buffer) throw new TypeError("LSP location URI is outside the captured host project.");
        current(target);
        const targetRange = lspRangeOffsets(target.index, link ? item.targetRange : item.range), selected = link ? lspRangeOffsets(target.index, item.targetSelectionRange) : targetRange;
        if (selected.from < targetRange.from || selected.to > targetRange.to) invalid();
        const originRange = link && item.originSelectionRange !== undefined ? lspRangeOffsets(origin.index, item.originSelectionRange) : null;
        return Object.freeze({ target, from: selected.from, to: selected.to, targetRange, originRange });
    });
    current(origin); for (const item of items) current(item.target); return Object.freeze(items);
}
/** Normalize a complete text-only batch; the host checks edit authority again at application. */
export function decodeLspWorkspaceEdit(value: unknown, resolve: (uri: string) => LspEditTarget | undefined): LspWorkspaceEdit {
    if (!record(value) || value.changeAnnotations !== undefined) invalid();
    const budget = { units: 65536 }, identities = new Set<string>(); let count = 0;
    const entries: Readonly<{ uri: unknown; version?: unknown; edits: unknown }>[] = [];
    // LSP prefers versioned documentChanges when both representations are supplied.
    if (value.documentChanges !== undefined) {
        if (!Array.isArray(value.documentChanges) || value.documentChanges.length > 100) invalid();
        for (const item of value.documentChanges) {
            if (!record(item) || "kind" in item || !record(item.textDocument) || !("version" in item.textDocument)) invalid();
            const version = item.textDocument.version;
            if (version !== null && (typeof version !== "number" || !Number.isInteger(version) || version < -0x80000000 || version > 0x7fffffff)) invalid();
            entries.push({ uri: item.textDocument.uri, version, edits: item.edits });
        }
    } else if (value.changes !== undefined) {
        if (!record(value.changes) || Object.keys(value.changes).length > 100) invalid();
        for (const [uri, edits] of Object.entries(value.changes)) entries.push({ uri, edits });
    }
    const documents = entries.map(({ uri, version, edits: values }): LspDocumentEdits => {
        if (typeof uri !== "string" || !uri || uri.length > 4096 || !Array.isArray(values) || (count += values.length) > 1024) invalid();
        const target = resolve(uri);
        if (!target || target.document.uri !== uri || target.index.buffer !== target.document.buffer) throw new TypeError("LSP edit URI is outside the captured host project.");
        current(target); if (identities.has(target.document.documentId)) throw new TypeError("LSP edits must name each captured document once."); identities.add(target.document.documentId);
        if (version !== undefined && version !== null && version !== target.version) throw new RpcError(-32801, "LSP edit refers to another wire document version.");
        const edits = values.map((item: unknown) => { if (!record(item) || "annotationId" in item) invalid(); return edit(target.index, item, budget); })
            .sort((a, b) => a.from - b.from || a.to - b.to);
        // Stable sorting preserves the server's order for insertions at the same position.
        validateTextEdits(target.document.buffer.length, edits); return Object.freeze({ target, edits: Object.freeze(edits) });
    });
    const isCurrent = () => documents.every(document => document.target.isCurrent());
    if (!isCurrent()) throw new RpcError(-32801, "LSP edit capture expired.");
    return Object.freeze({ documents: Object.freeze(documents), isCurrent });
}
export function decodeLspApplyEdit(value: unknown, resolve: (uri: string) => LspEditTarget | undefined): LspApplyEdit {
    if (!record(value) || value.label !== undefined && (typeof value.label !== "string" || value.label.length > 256)) invalid();
    return Object.freeze({ label: value.label as string | undefined ?? null, edit: decodeLspWorkspaceEdit(value.edit, resolve) });
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
