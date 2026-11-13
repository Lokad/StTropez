import { jsonEqual, jsonSnapshot, RpcError } from "./json-rpc.ts";
import type { JsonValue } from "./json-rpc.ts";
import { decodeLspDiagnostics, decodeLspWorkspaceEdit, lspWorkspaceEditUris } from "./lsp-features.ts";
import type { LspEditTarget, LspWorkspaceEdit } from "./lsp-features.ts";
import type { LspDocumentCapture } from "./lsp-session.ts";

export type LspCommand = Readonly<{ title: string; command: string; arguments: readonly JsonValue[] }>;
export type LspCodeAction = Readonly<{ title: string; kind: string | null; preferred: boolean; disabled: string | null;
    edit: LspWorkspaceEdit | null; command: LspCommand | null; resolve: JsonValue | null }>;
export type LspCodeActions = readonly LspCodeAction[];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function invalid(): never { throw new TypeError("Malformed or unsupported LSP code action."); }
const current = (capture: LspDocumentCapture) => { if (!capture.isCurrent()) throw new RpcError(-32801, "LSP code-action capture expired."); };
export function lspCodeActionUris(value: unknown): readonly string[] {
    if (value === null) return []; if (!Array.isArray(value)) invalid();
    return value.flatMap(item => { if (!record(item)) invalid(); return item.edit === undefined ? [] : lspWorkspaceEditUris(item.edit); });
}
/** A complete action list is validated before any choice is published or made applicable. */
export function decodeLspCodeActions(value: unknown, origin: LspDocumentCapture, resolve: (uri: string) => LspEditTarget | undefined, canResolve = false): LspCodeActions {
    current(origin); if (value === null) return Object.freeze([]); if (!Array.isArray(value)) invalid();
    const text = (value: unknown): string => { if (typeof value !== "string" || !value) invalid(); return value; };
    const command = (value: unknown): LspCommand => {
        if (!record(value)) invalid(); const title = text(value.title), name = text(value.command);
        if (value.arguments !== undefined && !Array.isArray(value.arguments)) invalid(); const args = jsonSnapshot(value.arguments ?? []);
        return Object.freeze({ title, command: name, arguments: args as readonly JsonValue[] });
    };
    const actions = value.map((item: unknown): LspCodeAction => {
        if (!record(item)) invalid(); const title = text(item.title);
        if (typeof item.command === "string") {
            if (item.edit !== undefined || item.kind !== undefined || item.disabled !== undefined || item.data !== undefined) invalid();
            return Object.freeze({ title, kind: null, preferred: false, disabled: null, edit: null, command: command(item), resolve: null });
        }
        const kind = item.kind === undefined ? null : item.kind === "" ? "" : text(item.kind);
        if (item.isPreferred !== undefined && typeof item.isPreferred !== "boolean") invalid();
        let disabled: string | null = null;
        if (item.disabled !== undefined) { if (!record(item.disabled)) invalid(); disabled = text(item.disabled.reason); }
        if (item.diagnostics !== undefined) {
            const diagnostics = decodeLspDiagnostics({ uri: origin.document.uri, version: origin.version, diagnostics: item.diagnostics }, origin);
            if (diagnostics.items.some(item => item.placement !== "placed")) invalid(); jsonSnapshot(item.diagnostics);
        }
        if (item.data !== undefined) jsonSnapshot(item.data);
        const edit = item.edit === undefined ? null : decodeLspWorkspaceEdit(item.edit, resolve), cmd = item.command === undefined ? null : command(item.command);
        const deferred = canResolve && !edit && !cmd && disabled === null ? jsonSnapshot(item) : null;
        return Object.freeze({ title, kind, preferred: item.isPreferred === true, disabled, edit, command: cmd, resolve: deferred });
    });
    current(origin); for (const action of actions) if (action.edit && !action.edit.isCurrent()) throw new RpcError(-32801, "LSP action target capture expired.");
    return Object.freeze(actions);
}
/** Only the advertised edit property may be added by codeAction/resolve. Opaque data is preserved. */
export function decodeLspResolvedCodeAction(value: unknown, original: LspCodeAction, origin: LspDocumentCapture, resolve: (uri: string) => LspEditTarget | undefined): LspCodeAction {
    current(origin); if (!record(original.resolve) || !record(value) || value.edit === undefined) invalid();
    const before = original.resolve, after = { ...value }; delete after.edit;
    if (!jsonEqual(before, after)) throw new TypeError("Resolved LSP action changed attributes outside its advertised edit property.");
    return decodeLspCodeActions([value], origin, resolve)[0]!;
}
