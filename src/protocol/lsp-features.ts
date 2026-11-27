import { emptyList } from "../core/empty-list.ts";
import { invalidRange, isNonNegativeInteger } from "../core/bounds.ts";
import { wireLimits, ProtocolDecodeError, isRecord, isLspUint, isLspInteger, staleRequest, isCapturedJson, jsonEqual, decodeJson } from "./wire.ts";
import { validateTextEdits } from "../core/changes.ts";
import { positionChanges } from "../core/positions.ts";
import { lineEnding } from "../core/newlines.ts";
import { parseSnippet, offsetSnippetStops } from "../core/snippets.ts";
import { adjustInsertionText, insertionContext, validateInsertionIndentation } from "../core/insertion-text.ts";
import type { InsertionIndentation } from "../core/insertion-text.ts";
import { createSelectionSet } from "../core/selections.ts";
import type { SelectionSet } from "../core/selections.ts";
import type { SnippetStop } from "../core/snippets.ts";
import type { TextEdit } from "../core/changes.ts";
import type { DocumentationContent, DocumentationPart } from "../core/documentation.ts";
import type { DocumentChange } from "../core/workspace.ts";
import type { JsonValue } from "./wire.ts";
import type { LspDocumentCapture, LspDocumentSnapshot } from "./lsp-session.ts";
import type { LspLineIndex, LspPosition, LspRange } from "./lsp-positions.ts";
import { decodeLspCommand } from "./lsp-command-value.ts";

export type LspDiagnostic = Readonly<{ range: LspRange; placement: "placed" | "out-of-bounds"; from: number | null; to: number | null; message: string; severity: number | null; source: string | null;
    code?: number | string; codeDescription?: Readonly<{ href: string }>; tags?: readonly number[];
    relatedInformation?: readonly Readonly<{ location: Readonly<{ uri: string; range: LspRange }>; message: string }>[]; data?: JsonValue }>;
export type LspDiagnostics = Readonly<{ uri: string; version: number | null; revision: number | null; snapshotRevision: number; freshness: "versioned" | "unversioned"; items: readonly LspDiagnostic[] }>;
export type LspCompletionPlan = Readonly<{ edits: readonly TextEdit[]; head: number; snippet: readonly SnippetStop[] | null }>;
type LspCompletionSelectionPlan = LspCompletionPlan & Readonly<{ selectionSet: SelectionSet }>;
export type LspCompletion = Readonly<{ label: string; detail: string; documentation: string; filterText: string; sortText: string; preselect: boolean;
    commitCharacters: readonly string[]; source: LspDocumentSnapshot; offset: number; primary: Readonly<{ from: number; insertTo: number; replaceTo: number; text: string }>;
    /** Raw expanded primary text/stops are retained; plans use this captured formatting policy. */
    insertion: InsertionIndentation & Readonly<{ mode: 1 | 2; maxUnits: number }>;
    additional: readonly TextEdit[]; snippet: readonly SnippetStop[] | null; resolve: JsonValue | null; insert: LspCompletionPlan; replace: LspCompletionPlan }>;
export type LspCompletionOptions = Readonly<{ resolve?: boolean; commitCharacters?: readonly string[]; indentation?: InsertionIndentation }>;
export type LspCompletions = Readonly<{ incomplete: boolean; items: readonly LspCompletion[]; omitted: readonly Readonly<{ label: string; reason: string }>[] }>;
/** A valid completion edit whose optional snippet syntax is outside the supported subset. */
export class UnsupportedLspSnippetError extends Error {}
export type LspCompletionFallback = Readonly<{ from: number; to: number; replaceTo: number }>;
export type LspHover = Readonly<{ text: string; content: DocumentationContent; range: Readonly<{ from: number; to: number }> | null }>;
export type LspLocationTarget = Pick<LspDocumentCapture, "document" | "index" | "isCurrent">;
export type LspLocation = Readonly<{ target: LspLocationTarget; from: number; to: number; targetRange: Readonly<{ from: number; to: number }>;
    originRange: Readonly<{ from: number; to: number }> | null }>;
export type LspEditTarget = LspLocationTarget & Readonly<{ version: number | null }>;
export type LspDocumentEdits = Readonly<{ target: LspEditTarget; edits: readonly TextEdit[] }>;
export type LspWorkspaceEdit = Readonly<{ documents: readonly LspDocumentEdits[]; isCurrent: () => boolean }>;
export type LspApplyEdit = Readonly<{ label: string | null; edit: LspWorkspaceEdit }>;
export type LspApplyEditResult = Readonly<{ applied: boolean; failureReason?: string }>;
export type LspSignature = Readonly<{ label: string; documentation: string; content: DocumentationContent; activeParameter: number | null;
    parameters: readonly Readonly<{ from: number; to: number; documentation: string; content: DocumentationContent }>[] }>;
export type LspSignatureHelp = Readonly<{ signatures: readonly LspSignature[]; activeSignature: number; wire: JsonValue }>;
export type LspDocumentLink = Readonly<{ from: number; to: number; target: string | null; tooltip: string; resolve: JsonValue | null }>;
export type LspColor = Readonly<{ red: number; green: number; blue: number; alpha: number }>;
export type LspDocumentColor = Readonly<{ from: number; to: number; color: LspColor }>;
export type LspColorPresentation = Readonly<{ label: string; edits: readonly TextEdit[] }>;
function invalid(): never { throw new ProtocolDecodeError("Malformed or unsupported LSP feature result."); }
function current(capture: Pick<LspDocumentCapture, "isCurrent">): void { if (!capture.isCurrent()) throw staleRequest(); }
function text(value: unknown, maximum = Number.MAX_SAFE_INTEGER, budget?: { units: number }): string {
    if (typeof value !== "string" || value.length > maximum || budget && (budget.units -= value.length) < 0) invalid(); return value;
}
function documentation(value: unknown, budget?: { units: number }, maximum = Number.MAX_SAFE_INTEGER): string {
    if (value === undefined) return ""; if (typeof value === "string") return text(value, maximum, budget);
    if (!isRecord(value) || value.kind !== "plaintext" && value.kind !== "markdown") invalid(); return text(value.value, maximum, budget);
}
function documentationContent(value: unknown, budget?: { units: number }, maximum = Number.MAX_SAFE_INTEGER): DocumentationContent {
    const body = documentation(value, budget, maximum);
    return Object.freeze(body ? [Object.freeze({ kind: isRecord(value) && value.kind === "markdown" ? "markdown" as const : "plaintext" as const, value: body })] : []);
}
function commitCharacters(value: unknown, budget?: { units: number }): readonly string[] {
    if (value === undefined) return emptyList; if (!Array.isArray(value)) invalid();
    // LSP specifies length=1; superfluous characters are ignored.
    return Object.freeze([...new Set(value.map(value => text(value, undefined, budget)).filter(value => value.length === 1))]);
}
function position(value: unknown): LspPosition {
    if (!isRecord(value) || !isLspUint(value.line) || !isLspUint(value.character)) invalid(); return Object.freeze({ line: value.line, character: value.character });
}
function range(value: unknown): Readonly<{ start: LspPosition; end: LspPosition }> {
    if (!isRecord(value)) invalid(); const start = position(value.start), end = position(value.end);
    if (start.line > end.line || start.line === end.line && start.character > end.character) invalid(); return Object.freeze({ start, end });
}
/** LSP clamps characters to the line end; nonexistent lines and reversed wire ranges remain invalid. */
export function lspRangeOffsets(index: LspLineIndex, value: unknown): Readonly<{ from: number; to: number }> {
    return rangeOffsets(index, range(value));
}
function rangeOffsets(index: LspLineIndex, { start, end }: LspRange): Readonly<{ from: number; to: number }> {
    if (start.line >= index.lineCount || end.line >= index.lineCount) invalid();
    return Object.freeze({ from: index.offsetAt(start), to: index.offsetAt(end) });
}
/** Place valid wire ranges against this explicit snapshot without inventing a provider version.
 * Unplaceable ranges retain their message and wire range; malformed structures reject the batch.
 */
export function decodeLspDiagnostics(value: unknown, capture: LspDocumentCapture): LspDiagnostics {
    current(capture); if (!isRecord(value) || value.uri !== capture.document.uri || !Array.isArray(value.diagnostics)) invalid();
    const version = value.version === undefined ? null : value.version;
    if (version !== null && !isLspUint(version) || value.version === null) invalid();
    if (version !== null && version !== capture.version) throw staleRequest("Diagnostics refer to another document version.");
    const items = value.diagnostics.map((item: unknown): LspDiagnostic => {
        if (!isRecord(item)) invalid(); const wire = range(item.range); let offsets: Readonly<{ from: number; to: number }> | undefined;
        try { offsets = lspRangeOffsets(capture.index, wire); } catch (error) { if (!(error instanceof ProtocolDecodeError)) throw error; }
        const message = text(item.message), source = item.source === undefined ? null : text(item.source);
        if (item.severity !== undefined && (!isLspUint(item.severity) || item.severity < 1 || item.severity > 4)) invalid();
        if (item.code !== undefined && typeof item.code !== "string" && !isLspInteger(item.code)) invalid();
        if (item.codeDescription !== undefined && !isRecord(item.codeDescription)) invalid();
        if (item.tags !== undefined && (!Array.isArray(item.tags) || !item.tags.every(isLspInteger))) invalid();
        if (item.relatedInformation !== undefined && !Array.isArray(item.relatedInformation)) invalid();
        const relatedInformation = (item.relatedInformation as unknown[] | undefined)?.map(related => {
            if (!isRecord(related) || !isRecord(related.location)) invalid();
            return Object.freeze({ location: Object.freeze({ uri: text(related.location.uri), range: range(related.location.range) }), message: text(related.message) });
        });
        return Object.freeze({ range: wire, placement: offsets ? "placed" : "out-of-bounds", from: offsets?.from ?? null, to: offsets?.to ?? null, message, severity: item.severity as number | undefined ?? null, source,
            ...(item.code === undefined ? {} : { code: item.code as number | string }),
            ...(item.codeDescription === undefined ? {} : { codeDescription: Object.freeze({ href: text((item.codeDescription as Record<string, unknown>).href) }) }),
            // Preserve unknown isLspInteger tags for forwarding; hosts need only interpret the advertised set.
            ...(item.tags === undefined ? {} : { tags: Object.freeze([...(item.tags as number[])]) }),
            ...(relatedInformation === undefined ? {} : { relatedInformation: Object.freeze(relatedInformation) }),
            ...(item.data === undefined ? {} : { data: decodeJson(item.data) }) });
    });
    current(capture); return Object.freeze({ uri: capture.document.uri, version, revision: version === null ? null : capture.document.revision,
        snapshotRevision: capture.document.revision, freshness: version === null ? "unversioned" : "versioned", items: Object.freeze(items) });
}
/** Preserve legacy code/Markdown fragments and explicit plaintext alongside the literal fallback. */
export function decodeLspHover(value: unknown, capture: LspDocumentCapture): LspHover | null {
    current(capture); if (value === null) return null; if (!isRecord(value)) invalid(); const budget = { units: 16384 };
    const fragment = (part: unknown): DocumentationPart => {
        if (typeof part === "string") return Object.freeze({ kind: "markdown", value: text(part, wireLimits.documentationPartUnits, budget) });
        if (!isRecord(part)) invalid();
        if ("kind" in part) { if (part.kind !== "plaintext" && part.kind !== "markdown" || "language" in part) invalid(); return Object.freeze({ kind: part.kind, value: text(part.value, wireLimits.documentationPartUnits, budget) }); }
        return Object.freeze({ kind: "code", language: text(part.language, wireLimits.languageNameUnits, budget), value: text(part.value, wireLimits.documentationPartUnits, budget) });
    };
    let parts: DocumentationPart[];
    if (Array.isArray(value.contents)) { if (value.contents.length > wireLimits.hoverParts) invalid(); parts = value.contents.map(part => {
            // Arrays contain MarkedString, not MarkupContent.
            if (isRecord(part) && "kind" in part) invalid(); return fragment(part);
        }); }
    else parts = [fragment(value.contents)];
    const content = Object.freeze(parts), contents = parts.map(part => part.kind === "code" && part.language ? `${part.language}\n${part.value}` : part.value).filter(Boolean).join("\n\n");
    if (contents.length > 16384) invalid();
    const range = value.range === undefined ? null : lspRangeOffsets(capture.index, value.range); current(capture);
    return contents ? Object.freeze({ text: contents, content, range }) : null;
}
const locations = { definition: new WeakMap<object, ReturnType<typeof parseLocationEntries>>(), references: new WeakMap<object, ReturnType<typeof parseLocationEntries>>() };
function locationEntries(value: unknown, kind: "definition" | "references") {
    if (!isCapturedJson(value)) return parseLocationEntries(value, kind);
    const cache = locations[kind], previous = cache.get(value); if (previous) return previous;
    const entries = parseLocationEntries(value, kind); cache.set(value, entries); return entries;
}
function parseLocationEntries(value: unknown, kind: "definition" | "references") {
    const values = value === null ? [] : Array.isArray(value) ? value : kind === "definition" && isRecord(value) ? [value] : invalid();
    let links: boolean | undefined;
    return Object.freeze(values.map((item: unknown) => {
        if (!isRecord(item)) invalid(); const link = "targetUri" in item;
        if (link && (kind !== "definition" || !Array.isArray(value)) || links !== undefined && links !== link) invalid(); links = link;
        const uri = link ? item.targetUri : item.uri;
        if (typeof uri !== "string" || !uri || link && ("uri" in item || "range" in item)) invalid();
        const targetRange = range(link ? item.targetRange : item.range), selected = link ? range(item.targetSelectionRange) : targetRange;
        // Character containment requires the captured target: different wire columns may clamp
        // to the same line end. Reject impossible line containment before requesting that target.
        if (selected.start.line < targetRange.start.line || selected.end.line > targetRange.end.line) invalid();
        return Object.freeze({ uri, targetRange, selected, originRange: link && item.originSelectionRange !== undefined ? range(item.originSelectionRange) : null });
    }));
}
/** Validate wire syntax and line containment before asking the host to load missing targets. */
export const lspLocationUris = (value: unknown, kind: "definition" | "references"): readonly string[] => locationEntries(value, kind).map(item => item.uri);
/** Intersect supplied origin ranges at the queried position before loading any target. */
export function definitionOriginRange(value: unknown, origin: LspDocumentCapture, offset: number) {
    let result: Readonly<{ from: number; to: number }> | null = null;
    for (const item of locationEntries(value, "definition")) {
        if (!item.originRange) continue;
        const range = rangeOffsets(origin.index, item.originRange);
        if (range.from > offset || range.to <= offset) continue;
        result = result ? { from: Math.max(result.from, range.from), to: Math.min(result.to, range.to) } : range;
    }
    return result && Object.freeze(result);
}
/** Resolve opaque URIs through captured host buffers; never fetch or open a server-supplied URI. */
export function decodeLspLocations(value: unknown, kind: "definition" | "references", origin: LspDocumentCapture,
    resolve: (uri: string) => LspLocationTarget | undefined): readonly LspLocation[] {
    current(origin);
    const items = locationEntries(value, kind).map((item): LspLocation => {
        const { uri } = item;
        const target = resolve(uri); if (!target || target.document.uri !== uri || target.index.buffer !== target.document.buffer) throw new ProtocolDecodeError("LSP location URI is outside the captured host project.");
        current(target);
        const targetRange = rangeOffsets(target.index, item.targetRange), selected = item.selected === item.targetRange ? targetRange : rangeOffsets(target.index, item.selected);
        if (selected.from < targetRange.from || selected.to > targetRange.to) invalid();
        const originRange = item.originRange ? rangeOffsets(origin.index, item.originRange) : null;
        return Object.freeze({ target, from: selected.from, to: selected.to, targetRange, originRange });
    });
    current(origin); for (const item of items) current(item.target); return Object.freeze(items);
}
const workspaceEdits = new WeakMap<object, ReturnType<typeof parseWorkspaceEditEntries>>();
function workspaceEditEntries(value: unknown) {
    if (!isCapturedJson(value)) return parseWorkspaceEditEntries(value);
    const previous = workspaceEdits.get(value); if (previous) return previous;
    const entries = parseWorkspaceEditEntries(value); workspaceEdits.set(value, entries); return entries;
}
function parseWorkspaceEditEntries(value: unknown) {
    if (!isRecord(value) || value.changeAnnotations !== undefined) invalid();
    const entries: Readonly<{ uri: unknown; version?: unknown; edits: unknown }>[] = [];
    // LSP prefers versioned documentChanges when both representations are supplied.
    if (value.documentChanges !== undefined) {
        if (!Array.isArray(value.documentChanges)) invalid();
        for (const item of value.documentChanges) {
            if (!isRecord(item) || "kind" in item || !isRecord(item.textDocument) || !("version" in item.textDocument)) invalid();
            const version = item.textDocument.version;
            if (version !== null && (typeof version !== "number" || !Number.isInteger(version) || version < -0x80000000 || version > 0x7fffffff)) invalid();
            entries.push({ uri: item.textDocument.uri, version, edits: item.edits });
        }
    } else if (value.changes !== undefined) {
        if (!isRecord(value.changes)) invalid();
        for (const [uri, edits] of Object.entries(value.changes)) entries.push({ uri, edits });
    }
    return Object.freeze(entries.map(({ uri, version, edits: values }) => {
        if (typeof uri !== "string" || !uri || !Array.isArray(values)) invalid();
        const edits = Object.freeze(values.map((item: unknown) => {
            if (!isRecord(item) || "annotationId" in item) invalid(); return Object.freeze({ range: range(item.range), newText: text(item.newText) });
        }));
        return Object.freeze({ uri, version, edits });
    }));
}
export const lspWorkspaceEditUris = (value: unknown): readonly string[] => workspaceEditEntries(value).map(item => item.uri);
/** Normalize a complete text-only batch; the host checks edit authority again at application. */
export function decodeLspWorkspaceEdit(value: unknown, resolve: (uri: string) => LspEditTarget | undefined): LspWorkspaceEdit {
    const identities = new Set<string>();
    const documents = workspaceEditEntries(value).map(({ uri, version, edits: values }): LspDocumentEdits => {
        const target = resolve(uri);
        if (!target || target.document.uri !== uri || target.index.buffer !== target.document.buffer) throw new ProtocolDecodeError("LSP edit URI is outside the captured host project.");
        current(target); if (identities.has(target.document.documentId)) throw new ProtocolDecodeError("LSP edits must name each captured document once."); identities.add(target.document.documentId);
        if (version !== undefined && version !== null && version !== target.version) throw staleRequest("LSP edit refers to another wire document version.");
        const edits = values.map(item => Object.freeze({ ...rangeOffsets(target.index, item.range), insert: item.newText }))
            .sort((a, b) => a.from - b.from || a.to - b.to);
        // Stable sorting preserves the server's order for insertions at the same position.
        decodePlan(() => validateTextEdits(target.document.buffer.length, edits)); return Object.freeze({ target, edits: Object.freeze(edits) });
    });
    const isCurrent = () => documents.every(document => document.target.isCurrent());
    if (!isCurrent()) throw staleRequest();
    return Object.freeze({ documents: Object.freeze(documents), isCurrent });
}
function applyEditValue(value: unknown) {
    if (!isRecord(value) || value.label !== undefined && typeof value.label !== "string") invalid();
    return value;
}
export const lspApplyEditUris = (value: unknown): readonly string[] => lspWorkspaceEditUris(applyEditValue(value).edit);
export function decodeLspApplyEdit(value: unknown, resolve: (uri: string) => LspEditTarget | undefined): LspApplyEdit {
    const body = applyEditValue(value);
    return Object.freeze({ label: body.label as string | undefined ?? null, edit: decodeLspWorkspaceEdit(body.edit, resolve) });
}
function edit(index: LspLineIndex, value: unknown, budget?: { units: number }, maximum = Number.MAX_SAFE_INTEGER): TextEdit {
    if (!isRecord(value)) invalid(); return Object.freeze({ ...lspRangeOffsets(index, value.range), insert: text(value.newText, maximum, budget) });
}
function decodePlan<T>(read: () => T): T {
    try { return read(); } catch (error) { if (error instanceof RangeError) throw new ProtocolDecodeError(error.message); throw error; }
}
function validateCompletionEdits(length: number, edits: readonly TextEdit[]): void {
    validateTextEdits(length, edits);
    for (let i = 1; i < edits.length; i++) {
        const left = edits[i - 1]!, right = edits[i]!;
        if (left.from === right.from && left.to === left.from && right.to === right.from) invalidRange("completion insert position");
    }
}
/** Inserted text starts follow the validated batch order, including an import before a replacement
 * at the same boundary. Source-position affinity alone cannot identify each edit's inserted text. */
function completionLayout(length: number, edits: readonly TextEdit[]) {
    validateCompletionEdits(length, edits); const starts = new Map<TextEdit, number>(); let delta = 0;
    for (const edit of edits) { starts.set(edit, edit.from + delta); delta += edit.insert.length - (edit.to - edit.from); }
    if (!Number.isSafeInteger(length + delta)) invalidRange("completion length");
    return { starts, length: length + delta };
}
function plan(length: number, primary: TextEdit, additional: readonly TextEdit[], stops: readonly SnippetStop[] | null = null): LspCompletionPlan {
    const edits = [...additional, primary].sort((a, b) => a.from - b.from || a.to - b.to);
    const from = completionLayout(length, edits).starts.get(primary)!;
    const snippet = stops ? offsetSnippetStops(stops, from) : null;
    const head = snippet?.find(stop => stop.index === 0)?.ranges[0]?.from ?? from + primary.insert.length;
    return Object.freeze({ edits: Object.freeze(edits), head, snippet });
}
function completionText(source: LspDocumentSnapshot, from: number, text: string, snippet: readonly SnippetStop[] | null, insertion: LspCompletion["insertion"]) {
    if (insertion.mode === 1 || !snippet && !text.includes("\n")) return { text, snippet };
    const context = insertionContext(source.buffer, from, insertion), formatted = adjustInsertionText(text, context, insertion.maxUnits);
    const stops = snippet && Object.freeze(snippet.map(stop => Object.freeze({ ...stop, ranges: Object.freeze(stop.ranges.map(range => {
        const from = formatted.mapPosition(range.from), to = range.from === range.to ? from : Math.max(from, formatted.mapPosition(range.to, "before"));
        const firstLine = formatted.markerIndentation(range.from);
        return Object.freeze({ ...range, from, to, insertion: context, ...(firstLine ? { firstLine } : {}) });
    })) })));
    return { text: formatted.text, snippet: stops };
}
function completionPlans(source: LspDocumentSnapshot, primary: LspCompletion["primary"], additional: readonly TextEdit[], snippet: readonly SnippetStop[] | null, insertion: LspCompletion["insertion"]) {
    const formatted = completionText(source, primary.from, primary.text, snippet, insertion);
    const at = (to: number) => plan(source.buffer.length, Object.freeze({ from: primary.from, to, insert: formatted.text }), additional, formatted.snippet);
    const insert = at(primary.insertTo);
    return { insert, replace: primary.replaceTo === primary.insertTo ? insert : at(primary.replaceTo) };
}
/** Validate every edit before publication; unsupported snippet/command items have an explicit disposition. */
export function decodeLspCompletions(value: unknown, capture: LspDocumentCapture, offset: number, fallback: LspCompletionFallback | (() => LspCompletionFallback) = { from: offset, to: offset, replaceTo: offset }, options: LspCompletionOptions = {}): LspCompletions {
    // Candidate count and aggregate item text are not protocol validity rules. The session's
    // configurable RPC message limit bounds transport; hosts bound presentation independently.
    current(capture); const index = capture.index, point = index.at(offset); let incomplete = false, defaults: Record<string, unknown> = {}, values: unknown[];
    if (value === null) values = [];
    else if (Array.isArray(value)) values = value;
    else { if (!isRecord(value) || typeof value.isIncomplete !== "boolean" || !Array.isArray(value.items)) invalid(); incomplete = value.isIncomplete; values = value.items;
        if (value.itemDefaults !== undefined) { if (!isRecord(value.itemDefaults) || Object.keys(value.itemDefaults).some(key => !["editRange", "insertTextFormat", "insertTextMode", "commitCharacters", "data"].includes(key))) invalid(); defaults = value.itemDefaults;
            if (defaults.insertTextFormat !== undefined && defaults.insertTextFormat !== 1 && defaults.insertTextFormat !== 2 || defaults.insertTextMode !== undefined && defaults.insertTextMode !== 1 && defaults.insertTextMode !== 2) invalid();
            commitCharacters(defaults.commitCharacters);
            if (defaults.data !== undefined) decodeJson(defaults.data);
            if (defaults.editRange !== undefined) {
                const value = defaults.editRange; if (!isRecord(value)) invalid();
                const insert = lspRangeOffsets(index, "start" in value ? value : value.insert), replace = lspRangeOffsets(index, "start" in value ? value : value.replace);
                if (insert.from !== replace.from || insert.to > replace.to || insert.from > offset || insert.to < offset || [insert.from, insert.to, replace.to].some(at => index.at(at).line !== point.line)) invalid();
            }
        } }
    let fallbackRange: LspCompletionFallback | undefined; const omitted: { label: string; reason: string }[] = [];
    const indentation = { tabSize: options.indentation?.tabSize ?? 4, insertSpaces: options.indentation?.insertSpaces ?? true,
        maxUnits: capture.maxDocumentUnits ?? Number.MAX_SAFE_INTEGER };
    validateInsertionIndentation(indentation);
    if (!isNonNegativeInteger(indentation.maxUnits)) invalidRange("completion document limit");
    const insertions = new Map<1 | 2, LspCompletion["insertion"]>();
    const items = values.map((item: unknown): LspCompletion | undefined => {
        if (!isRecord(item) || ![1, 2].includes((item.insertTextFormat ?? defaults.insertTextFormat ?? 1) as number)) invalid();
        const mode = item.insertTextMode === undefined ? defaults.insertTextMode ?? 2 : item.insertTextMode; if (mode !== 1 && mode !== 2) invalid();
        let insertion = insertions.get(mode);
        if (!insertion) { insertion = Object.freeze({ ...indentation, mode }); insertions.set(mode, insertion); }
        const label = text(item.label); if (!label) invalid(); const detail = item.detail === undefined ? "" : text(item.detail);
        const description = documentation(item.documentation), filterText = item.filterText === undefined ? label : text(item.filterText), sortText = item.sortText === undefined ? label : text(item.sortText);
        if (item.preselect !== undefined && typeof item.preselect !== "boolean") invalid();
        const commits = commitCharacters(item.commitCharacters !== undefined ? item.commitCharacters : defaults.commitCharacters !== undefined ? defaults.commitCharacters : options.commitCharacters);
        if (item.data !== undefined) decodeJson(item.data);
        let insert: TextEdit, replace: TextEdit;
        if (item.textEdit !== undefined) {
            if (!isRecord(item.textEdit)) invalid(); const inserted = text(item.textEdit.newText);
            if ("range" in item.textEdit) { if ("insert" in item.textEdit || "replace" in item.textEdit) invalid(); insert = replace = Object.freeze({ ...lspRangeOffsets(index, item.textEdit.range), insert: inserted }); }
            else { insert = Object.freeze({ ...lspRangeOffsets(index, item.textEdit.insert), insert: inserted }); replace = Object.freeze({ ...lspRangeOffsets(index, item.textEdit.replace), insert: inserted }); }
        } else {
            const editRange = defaults.editRange, inserted = text(editRange === undefined ? item.insertText ?? label : item.textEditText ?? label);
            if (editRange !== undefined) {
                if (!isRecord(editRange)) invalid();
                if ("start" in editRange) insert = replace = Object.freeze({ ...lspRangeOffsets(index, editRange), insert: inserted });
                else { insert = Object.freeze({ ...lspRangeOffsets(index, editRange.insert), insert: inserted }); replace = Object.freeze({ ...lspRangeOffsets(index, editRange.replace), insert: inserted }); }
            } else { fallbackRange ??= typeof fallback === "function" ? fallback() : fallback;
                insert = Object.freeze({ from: fallbackRange.from, to: fallbackRange.to, insert: inserted }); replace = Object.freeze({ from: fallbackRange.from, to: fallbackRange.replaceTo, insert: inserted }); }
        }
        if (insert.from !== replace.from || insert.to > replace.to || insert.from > offset || insert.to < offset) invalid();
        for (const at of [insert.from, insert.to, replace.to]) if (index.at(at).line !== point.line) invalid();
        let additional: TextEdit[] = [];
        if (item.additionalTextEdits !== undefined) { if (!Array.isArray(item.additionalTextEdits)) invalid(); additional = item.additionalTextEdits.map(value => edit(index, value)).sort((a, b) => a.from - b.from || a.to - b.to); }
        let resolution: JsonValue | null = null;
        if (options.resolve) {
            let wire = item;
            for (const key of ["data", "commitCharacters", "insertTextFormat", "insertTextMode"]) if (wire[key] === undefined && defaults[key] !== undefined) {
                if (wire === item) wire = { ...item }; wire[key] = defaults[key];
            }
            if (item.textEdit === undefined && defaults.editRange !== undefined) {
                if (wire === item) wire = { ...item };
                wire.textEdit = { newText: insert.insert, insert: { start: index.at(insert.from), end: index.at(insert.to) }, replace: { start: index.at(replace.from), end: index.at(replace.to) } };
            }
            resolution = decodeJson(wire);
        }
        if (item.command !== undefined) {
            decodeLspCommand(item.command);
            decodePlan(() => plan(index.buffer.length, insert, additional)); decodePlan(() => plan(index.buffer.length, replace, additional));
            omitted.push(Object.freeze({ label, reason: "Completion commands are not supported." })); return;
        }
        let snippet: readonly SnippetStop[] | null = null;
        if ((item.insertTextFormat ?? defaults.insertTextFormat) === 2) {
            // Invalid edits cannot hide behind an unsupported optional snippet construct.
            decodePlan(() => plan(index.buffer.length, insert, additional)); decodePlan(() => plan(index.buffer.length, replace, additional));
            const parsed = parseSnippet(insert.insert, capture.maxDocumentUnits);
            if (!parsed.snippet) { omitted.push(Object.freeze({ label, reason: parsed.reason })); return; }
            snippet = parsed.snippet.stops; insert = Object.freeze({ ...insert, insert: parsed.snippet.text }); replace = Object.freeze({ ...replace, insert: parsed.snippet.text });
        }
        const primary = Object.freeze({ from: insert.from, insertTo: insert.to, replaceTo: replace.to, text: insert.insert });
        return Object.freeze({ label, detail, documentation: description, filterText, sortText, preselect: item.preselect === true, commitCharacters: commits,
            source: capture.document, offset, primary, insertion, additional: Object.freeze(additional), snippet, resolve: resolution,
            ...decodePlan(() => completionPlans(capture.document, primary, additional, snippet, insertion)) });
    });
    current(capture); return Object.freeze({ incomplete, items: Object.freeze(items.filter((item): item is LspCompletion => !!item)), omitted: Object.freeze(omitted) });
}
/** Advertised lazy content may change; primary edit ranges and item identity stay captured.
 * Additional ranges belong to the exact synchronized snapshot captured for the resolve request.
 */
export function decodeLspResolvedCompletion(value: unknown, original: LspCompletion, capture: LspDocumentCapture): LspCompletion {
    current(capture);
    if (!isRecord(original.resolve) || !isRecord(value)) invalid();
    if (original.source.uri !== capture.document.uri || original.source.documentId !== capture.document.documentId
        || original.source.revision !== capture.document.revision || original.source.buffer !== capture.document.buffer) throw staleRequest();
    const before = { ...original.resolve }, after = { ...value };
    for (const key of ["detail", "documentation", "additionalTextEdits", "insertText", "textEdit"]) { delete before[key]; delete after[key]; }
    if (!jsonEqual(before, after)) throw new ProtocolDecodeError("Resolved LSP completion changed an immutable item property.");
    const detail = value.detail === undefined ? original.detail : text(value.detail), description = value.documentation === undefined ? original.documentation : documentation(value.documentation);
    let additional = original.additional;
    if (value.additionalTextEdits !== undefined) { if (!Array.isArray(value.additionalTextEdits)) invalid(); additional = Object.freeze(value.additionalTextEdits.map(value => edit(capture.index, value)).sort((a, b) => a.from - b.from || a.to - b.to)); }
    const primary = original.primary; let inserted: string | undefined;
    if (original.resolve.textEdit !== undefined && value.textEdit === undefined) invalid();
    if (value.textEdit !== undefined) {
        if (!isRecord(value.textEdit)) invalid();
        inserted = text(value.textEdit.newText);
        const { newText: _text, ...range } = value.textEdit;
        const { newText: _beforeText, ...priorRange } = isRecord(original.resolve.textEdit) ? original.resolve.textEdit : {};
        if (!jsonEqual(range, priorRange)) {
            const insert = lspRangeOffsets(capture.index, "range" in range ? range.range : range.insert);
            const replace = lspRangeOffsets(capture.index, "range" in range ? range.range : range.replace);
            if (Object.keys(range).some(key => !["range", "insert", "replace"].includes(key)) || "range" in range && ("insert" in range || "replace" in range)
                || insert.from !== primary.from || replace.from !== primary.from || insert.to !== primary.insertTo || replace.to !== primary.replaceTo) throw new ProtocolDecodeError("Resolved completion retargeted its captured primary range.");
        }
    } else if (value.insertText !== undefined) inserted = text(value.insertText);
    let snippet = original.snippet;
    if (inserted !== undefined && original.resolve.insertTextFormat === 2) {
        // An unsupported snippet must not hide invalid or overlapping additional edits.
        const snippetText = inserted;
        decodePlan(() => plan(capture.document.buffer.length, { from: primary.from, to: primary.insertTo, insert: snippetText }, additional));
        decodePlan(() => plan(capture.document.buffer.length, { from: primary.from, to: primary.replaceTo, insert: snippetText }, additional));
        const parsed = parseSnippet(inserted, capture.maxDocumentUnits); if (!parsed.snippet) throw new UnsupportedLspSnippetError(parsed.reason);
        inserted = parsed.snippet.text; snippet = parsed.snippet.stops;
    }
    const nextPrimary = inserted === undefined ? primary : Object.freeze({ ...primary, text: inserted });
    const result = Object.freeze({ ...original, primary: nextPrimary, snippet, detail, documentation: description, additional, resolve: null,
        ...decodePlan(() => completionPlans(capture.document, nextPrimary, additional, snippet, original.insertion)) });
    current(capture); return result;
}
/** Map one item through a proved typing insertion or backward deletion within its primary range. */
export function rebaseLspCompletion<C extends Pick<DocumentChange, "previousRevision" | "origin" | "kind" | "mapping">>(
    original: LspCompletion, next: LspDocumentSnapshot, change: C, caret: number,
): LspCompletion | undefined {
    const before = original.source, mapping = change.mapping, units = next.buffer.length - before.buffer.length, primary = original.primary;
    if (change.previousRevision !== before.revision || next.revision !== before.revision + 1 || change.origin !== "human"
        || next.uri !== before.uri || next.documentId !== before.documentId || next.languageId !== before.languageId
        || mapping.oldLength !== before.buffer.length || mapping.newLength !== next.buffer.length || Math.abs(units) > 2048
        || caret !== original.offset || caret < primary.from || caret > primary.insertTo) return;
    const changes = positionChanges(mapping), edit = changes?.length === 1 ? changes[0] : undefined;
    if (!edit || edit.to !== caret) return;
    const inserted = change.kind === "typing" && units > 0 && edit.from === caret && edit.insertedLength === units;
    const deleted = change.kind === "delete" && units < 0 && edit.from === caret + units && edit.from >= primary.from && edit.insertedLength === 0;
    if (!inserted && !deleted) return;
    // The edit is wholly inside both primary ranges. An import before the replacement
    // stays there even when it shares the first character with the typed prefix.
    const nextPrimary = Object.freeze({ ...primary, insertTo: primary.insertTo + units, replaceTo: primary.replaceTo + units });
    let primaryIndex = 0;
    const additional = original.additional.length ? Object.freeze(original.additional.map(extra => {
        if (extra.to <= primary.from) { primaryIndex++; return extra; }
        return Object.freeze({ ...extra, from: extra.from + units, to: extra.to + units });
    })) : original.additional;
    if (nextPrimary.insertTo === primary.from && additional.some(extra => extra.from === primary.from && extra.to === primary.from)) return;

    // Accepting erases the prefix edit. The formatted text, final caret and stops
    // therefore stay the same unless contextual formatting sees a different line ending.
    const at = (previous: LspCompletionPlan, to: number): LspCompletionPlan => {
        const edits = [...additional];
        edits.splice(primaryIndex, 0, Object.freeze({ ...previous.edits[primaryIndex]!, to }));
        return Object.freeze({ ...previous, edits: Object.freeze(edits) });
    };
    const result = { ...original, source: next, offset: caret + units, primary: nextPrimary, additional };
    if (original.insertion.mode === 2 && (original.snippet || primary.text.includes("\n"))
        && lineEnding(before.buffer, before.buffer.lineAt(primary.from)) !== lineEnding(next.buffer, next.buffer.lineAt(primary.from)))
        return Object.freeze({ ...result, ...completionPlans(next, nextPrimary, additional, original.snippet, original.insertion) });
    const insert = at(original.insert, nextPrimary.insertTo);
    return Object.freeze({ ...result, insert, replace: nextPrimary.replaceTo === nextPrimary.insertTo ? insert : at(original.replace, nextPrimary.replaceTo) });
}
/** One atomic batch, optionally replicated at captured collapsed carets with identical replacement
 * text. Additional edits apply once. Each caret uses its own indentation and retains its selection. */
export function lspCompletionPlan(item: LspCompletion, mode: "insert" | "replace", character?: string, selections?: SelectionSet): LspCompletionSelectionPlan {
    if (character !== undefined && (character.length !== 1 || !item.commitCharacters.includes(character))) invalid();
    const { source, primary } = item, buffer = source.buffer;
    if (selections) {
        const normalized = createSelectionSet(buffer.length, selections.ranges, selections.primary);
        if (normalized.primary !== selections.primary || normalized.ranges.length !== selections.ranges.length
            || normalized.ranges.some((range, index) => range.anchor !== range.head || range.head !== selections.ranges[index]!.head)
            || normalized.ranges[normalized.primary]!.head !== item.offset) invalidRange("completion carets");
    }
    const inserted = character === undefined || primary.text.endsWith(character) ? primary.text : primary.text + character;
    if (!selections || selections.ranges.length === 1) {
        const formatted = character === undefined ? null : completionText(source, primary.from, inserted, null, item.insertion);
        const result = formatted ? plan(buffer.length, Object.freeze({ from: primary.from, to: mode === "insert" ? primary.insertTo : primary.replaceTo, insert: formatted.text }), item.additional) : item[mode];
        const first = result.snippet?.[0], length = buffer.length + result.edits.reduce((n, edit) => n + edit.insert.length - (edit.to - edit.from), 0);
        return Object.freeze({ ...result, selectionSet: createSelectionSet(length, first && first.index !== 0
            ? first.ranges.map(range => ({ anchor: range.from, head: range.to })) : [{ anchor: result.head, head: result.head }]) });
    }
    // Validate the complete translated batch before allocating formatted copies. Prefix and
    // suffix equality avoid applying provider edits to unrelated text at secondary carets.
    const targets = selections.ranges.map(({ head }) => {
        const delta = head - item.offset, from = primary.from + delta, insertTo = primary.insertTo + delta, replaceTo = primary.replaceTo + delta;
        if (from < 0 || replaceTo > buffer.length || [from, insertTo, replaceTo].some(at => buffer.lineAt(at) !== buffer.lineAt(head)))
            invalidRange("completion line");
        if (delta) for (let at = primary.from; at < primary.replaceTo; at += 4096) {
            const end = Math.min(at + 4096, primary.replaceTo);
            if (buffer.slice(at, end) !== buffer.slice(at + delta, end + delta)) invalidRange("completion replacement");
        }
        return { from, to: mode === "insert" ? insertTo : replaceTo, insert: "" };
    });
    const batch = [...item.additional, ...targets].sort((a, b) => a.from - b.from || a.to - b.to);
    validateCompletionEdits(buffer.length, batch);
    let remaining = item.insertion.maxUnits - buffer.length - batch.reduce((n, edit) => n + edit.insert.length - (edit.to - edit.from), 0);
    if (remaining < 0) invalidRange("completion length");
    const formatted = targets.map(target => {
        const result = completionText(source, target.from, inserted, character === undefined ? item.snippet : null, { ...item.insertion, maxUnits: remaining });
        remaining -= result.text.length; if (remaining < 0) invalidRange("completion length"); return result;
    });
    const primaries = targets.map((target, index) => Object.freeze({ ...target, insert: formatted[index]!.text }));
    const edits = Object.freeze([...item.additional, ...primaries]
        .sort((a, b) => a.from - b.from || a.to - b.to));
    const layout = completionLayout(buffer.length, edits);
    let order = 0;
    const groups = primaries.map((primaryEdit, index) => {
        const from = layout.starts.get(primaryEdit)!, value = formatted[index]!, base = order;
        const snippet = value.snippet && Object.freeze(value.snippet.map(stop => Object.freeze({ ...stop, ranges: Object.freeze(stop.ranges.map(range => {
            order = Math.max(order, base + range.order + 1); return Object.freeze({ ...range, from: from + range.from, to: from + range.to, order: base + range.order, group: index });
        })) })));
        return { snippet, head: snippet?.find(stop => stop.index === 0)?.ranges[0]?.from ?? from + value.text.length };
    });
    const snippet = groups[0]!.snippet && Object.freeze(groups[0]!.snippet.map((stop, index) => Object.freeze({ ...stop,
        ranges: Object.freeze(groups.flatMap(group => group.snippet![index]!.ranges)) })));
    const first = snippet?.[0], ranges = first && first.index !== 0 ? first.ranges.map(range => ({ anchor: range.from, head: range.to })) : groups.map(group => ({ anchor: group.head, head: group.head }));
    const selected = first && first.index !== 0 ? selections.primary * groups[0]!.snippet![0]!.ranges.length : selections.primary;
    return Object.freeze({ edits, head: groups[selections.primary]!.head, snippet, selectionSet: createSelectionSet(layout.length, ranges, selected) });
}
/** Literal display only; active indices use the protocol's default-to-first policy. */
export function decodeLspSignatureHelp(value: unknown, capture: LspDocumentCapture): LspSignatureHelp | null {
    current(capture); if (value === null) return null;
    if (!isRecord(value) || !Array.isArray(value.signatures) || value.signatures.length > 32
        || value.activeSignature !== undefined && !isLspUint(value.activeSignature) || value.activeParameter !== undefined && !isLspUint(value.activeParameter)) invalid();
    const budget = { units: 65536 }, signatures = value.signatures.map((item: unknown): LspSignature => {
        if (!isRecord(item) || item.parameters !== undefined && (!Array.isArray(item.parameters) || item.parameters.length > wireLimits.signatureParameters) || item.activeParameter !== undefined && !isLspUint(item.activeParameter)) invalid();
        const label = text(item.label, 4096, budget), content = documentationContent(item.documentation, budget, 16384);
        const parameters = (item.parameters as unknown[] | undefined ?? []).map(parameter => {
            if (!isRecord(parameter)) invalid(); const at = parameter.label; let from: number, to: number;
            if (typeof at === "string") { text(at, 4096, budget); from = label.indexOf(at); to = from + at.length; if (from < 0) invalid(); }
            else { if (!Array.isArray(at) || at.length !== 2 || !isLspUint(at[0]) || !isLspUint(at[1]) || at[0] > at[1] || at[1] > label.length) invalid(); from = at[0]; to = at[1]; }
            const content = documentationContent(parameter.documentation, budget, 16384);
            return Object.freeze({ from, to, documentation: content[0]?.value ?? "", content });
        });
        const active = item.activeParameter ?? value.activeParameter ?? 0;
        return Object.freeze({ label, documentation: content[0]?.value ?? "", content, parameters: Object.freeze(parameters), activeParameter: parameters.length ? typeof active === "number" && active < parameters.length ? active : 0 : null });
    });
    const active = value.activeSignature as number | undefined ?? 0, wire = decodeJson(value); text(JSON.stringify(wire), wireLimits.signatureContextUnits, { units: wireLimits.signatureContextUnits }); current(capture);
    return Object.freeze({ signatures: Object.freeze(signatures), activeSignature: active < signatures.length ? active : 0, wire });
}
export function decodeLspDocumentLinks(value: unknown, capture: LspDocumentCapture, resolve = false): readonly LspDocumentLink[] {
    current(capture); if (value === null) return emptyList;
    if (!Array.isArray(value) || value.length > 1024) invalid(); const budget = { units: 65536 }, opaque = { units: 65536 };
    const links = value.map((item: unknown): LspDocumentLink => {
        if (!isRecord(item)) invalid(); const range = lspRangeOffsets(capture.index, item.range), target = item.target === undefined ? null : text(item.target, 4096, budget);
        if (target === "") invalid(); const tooltip = item.tooltip === undefined ? "" : text(item.tooltip, 4096, budget);
        if (item.data !== undefined) text(JSON.stringify(decodeJson(item.data)), wireLimits.linkDataUnits, opaque);
        const wire = resolve ? decodeJson(item) : null; if (wire) text(JSON.stringify(wire), 16384, opaque);
        return Object.freeze({ ...range, target, tooltip, resolve: wire });
    }); current(capture); return Object.freeze(links);
}
export function decodeLspResolvedDocumentLink(value: unknown, original: LspDocumentLink, capture: LspDocumentCapture): LspDocumentLink {
    current(capture); if (!isRecord(original.resolve) || !isRecord(value)) invalid();
    const before = { ...original.resolve }, after = { ...value }; for (const key of ["target", "tooltip"]) { delete before[key]; delete after[key]; }
    if (!jsonEqual(before, after)) throw new ProtocolDecodeError("Resolved document link changed its captured range or identity.");
    const link = decodeLspDocumentLinks([value], capture)[0]!; if (link.from !== original.from || link.to !== original.to) invalid(); return link;
}
export function decodeLspColor(value: unknown): LspColor {
    if (!isRecord(value) || ![value.red, value.green, value.blue, value.alpha].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)) invalid();
    return Object.freeze({ red: value.red as number, green: value.green as number, blue: value.blue as number, alpha: value.alpha as number });
}
export function decodeLspDocumentColors(value: unknown, capture: LspDocumentCapture): readonly LspDocumentColor[] {
    current(capture); if (!Array.isArray(value) || value.length > 1024) invalid();
    const colors = value.map((item: unknown) => { if (!isRecord(item)) invalid(); return Object.freeze({ ...lspRangeOffsets(capture.index, item.range), color: decodeLspColor(item.color) }); });
    current(capture); return Object.freeze(colors);
}
export function decodeLspColorPresentations(value: unknown, reference: LspDocumentColor, capture: LspDocumentCapture): readonly LspColorPresentation[] {
    current(capture); if (!Array.isArray(value) || value.length > wireLimits.colorPresentations) invalid(); capture.index.at(reference.from); capture.index.at(reference.to);
    const budget = { units: 65536 }; let count = 0;
    const presentations = value.map((item: unknown) => {
        if (!isRecord(item)) invalid(); const label = text(item.label, 4096, budget), primary = item.textEdit === undefined ? Object.freeze({ from: reference.from, to: reference.to, insert: label }) : edit(capture.index, item.textEdit, budget, 16384);
        if (item.additionalTextEdits !== undefined && (!Array.isArray(item.additionalTextEdits) || item.additionalTextEdits.length > 32)) invalid();
        const additional = (item.additionalTextEdits as unknown[] | undefined ?? []).map(value => edit(capture.index, value, budget, 16384));
        if ((count += 1 + additional.length) > 1024) invalid();
        return Object.freeze({ label, edits: decodePlan(() => plan(capture.document.buffer.length, primary, additional)).edits });
    }); current(capture); return Object.freeze(presentations);
}
