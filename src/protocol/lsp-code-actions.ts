import { jsonSnapshot, RpcError } from "./json-rpc.ts";
import type { JsonValue } from "./json-rpc.ts";
import { decodeLspDiagnostics, decodeLspWorkspaceEdit } from "./lsp-features.ts";
import type { LspEditTarget, LspWorkspaceEdit } from "./lsp-features.ts";
import type { LspDocumentCapture } from "./lsp-session.ts";

export type LspCommand = Readonly<{ title: string; command: string; arguments: readonly JsonValue[] }>;
export type LspCodeAction = Readonly<{ title: string; kind: string | null; preferred: boolean; disabled: string | null;
    edit: LspWorkspaceEdit | null; command: LspCommand | null; resolve: JsonValue | null }>;
export type LspCodeActions = readonly LspCodeAction[];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function invalid(): never { throw new TypeError("Malformed or unsupported LSP code action."); }
const current = (capture: LspDocumentCapture) => { if (!capture.isCurrent()) throw new RpcError(-32801, "LSP code-action capture expired."); };
function same(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, index) => same(value, b[index]));
    return record(a) && record(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}
/** A complete action list is validated before any choice is published or made applicable. */
export function decodeLspCodeActions(value: unknown, origin: LspDocumentCapture, resolve: (uri: string) => LspEditTarget | undefined, canResolve = false): LspCodeActions {
    current(origin); if (value === null) return Object.freeze([]); if (!Array.isArray(value) || value.length > 64) invalid();
    let metadata = 65536, edits = 0, units = 0;
    const text = (value: unknown, maximum: number): string => { if (typeof value !== "string" || !value || value.length > maximum || (metadata -= value.length) < 0) invalid(); return value; };
    const opaque = (value: unknown, maximum: number) => { const copy = jsonSnapshot(value), size = JSON.stringify(copy).length; if (size > maximum || (metadata -= size) < 0) invalid(); return copy; };
    const command = (value: unknown): LspCommand => {
        if (!record(value)) invalid(); const title = text(value.title, 256), name = text(value.command, 256);
        if (value.arguments !== undefined && !Array.isArray(value.arguments)) invalid(); const args = opaque(value.arguments ?? [], 8192);
        return Object.freeze({ title, command: name, arguments: args as readonly JsonValue[] });
    };
    const actions = value.map((item: unknown): LspCodeAction => {
        if (!record(item)) invalid(); const title = text(item.title, 256);
        if (typeof item.command === "string") {
            if (item.edit !== undefined || item.kind !== undefined || item.disabled !== undefined || item.data !== undefined) invalid();
            return Object.freeze({ title, kind: null, preferred: false, disabled: null, edit: null, command: command(item), resolve: null });
        }
        const kind = item.kind === undefined ? null : item.kind === "" ? "" : text(item.kind, 128);
        if (item.isPreferred !== undefined && typeof item.isPreferred !== "boolean") invalid();
        let disabled: string | null = null;
        if (item.disabled !== undefined) { if (!record(item.disabled)) invalid(); disabled = text(item.disabled.reason, 1024); }
        if (item.diagnostics !== undefined) { decodeLspDiagnostics({ uri: origin.document.uri, version: origin.version, diagnostics: item.diagnostics }, origin); opaque(item.diagnostics, 16384); }
        if (item.data !== undefined) opaque(item.data, 8192);
        const edit = item.edit === undefined ? null : decodeLspWorkspaceEdit(item.edit, resolve), cmd = item.command === undefined ? null : command(item.command);
        if (edit) for (const change of edit.documents) for (const at of change.edits) { if (++edits > 1024 || (units += at.insert.length) > 65536) invalid(); }
        const deferred = canResolve && !edit && !cmd && disabled === null ? opaque(item, 16384) : null;
        return Object.freeze({ title, kind, preferred: item.isPreferred === true, disabled, edit, command: cmd, resolve: deferred });
    });
    current(origin); for (const action of actions) if (action.edit && !action.edit.isCurrent()) throw new RpcError(-32801, "LSP action target capture expired.");
    return Object.freeze(actions);
}
/** Only the advertised edit property may be added by codeAction/resolve. Opaque data is preserved. */
export function decodeLspResolvedCodeAction(value: unknown, original: LspCodeAction, origin: LspDocumentCapture, resolve: (uri: string) => LspEditTarget | undefined): LspCodeAction {
    current(origin); if (!record(original.resolve) || !record(value) || value.edit === undefined) invalid();
    const before = original.resolve, after = { ...value }; delete after.edit;
    if (!same(before, after)) throw new TypeError("Resolved LSP action changed attributes outside its advertised edit property.");
    return decodeLspCodeActions([value], origin, resolve)[0]!;
}
