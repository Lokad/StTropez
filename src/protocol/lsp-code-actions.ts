import { ProtocolDecodeError, isRecord, staleRequest, jsonEqual, decodeJson } from "./wire.ts";
import type { JsonValue } from "./wire.ts";
import { decodeLspDiagnostics, decodeLspWorkspaceEdit, lspWorkspaceEditUris } from "./lsp-features.ts";
import type { LspDiagnostic, LspEditTarget, LspWorkspaceEdit } from "./lsp-features.ts";
import type { LspDocumentCapture } from "./lsp-session.ts";
import { decodeLspCommand } from "./lsp-command-value.ts";
import type { LspCommand } from "./lsp-command-value.ts";

export type LspCodeAction = Readonly<{ title: string; kind: string | null; preferred: boolean; disabled: string | null;
    edit: LspWorkspaceEdit | null; command: LspCommand | null; resolve: JsonValue | null; diagnostics?: readonly LspDiagnostic[] }>;
export type LspCodeActions = readonly LspCodeAction[];
function invalid(): never { throw new ProtocolDecodeError("Malformed or unsupported LSP code action."); }
const current = (capture: LspDocumentCapture) => { if (!capture.isCurrent()) throw staleRequest("LSP code-action capture expired."); };
export function lspCodeActionUris(value: unknown): readonly string[] {
    if (value === null) return []; if (!Array.isArray(value)) invalid();
    return value.flatMap(item => { if (!isRecord(item)) invalid(); return item.edit === undefined ? [] : lspWorkspaceEditUris(item.edit); });
}
/** A complete action list is validated before any choice is published or made applicable. */
export function decodeLspCodeActions(value: unknown, origin: LspDocumentCapture, resolve: (uri: string) => LspEditTarget | undefined, canResolve = false): LspCodeActions {
    current(origin); if (value === null) return Object.freeze([]); if (!Array.isArray(value)) invalid();
    const text = (value: unknown): string => { if (typeof value !== "string" || !value) invalid(); return value; };
    const actions = value.map((item: unknown): LspCodeAction => {
        if (!isRecord(item)) invalid(); const title = text(item.title);
        if (typeof item.command === "string") {
            if (item.edit !== undefined || item.kind !== undefined || item.disabled !== undefined || item.data !== undefined) invalid();
            return Object.freeze({ title, kind: null, preferred: false, disabled: null, edit: null, command: decodeLspCommand(item), resolve: null });
        }
        const kind = item.kind === undefined ? null : item.kind === "" ? "" : text(item.kind);
        if (item.isPreferred !== undefined && typeof item.isPreferred !== "boolean") invalid();
        let disabled: string | null = null;
        if (item.disabled !== undefined) { if (!isRecord(item.disabled)) invalid(); disabled = text(item.disabled.reason); }
        const diagnostics = item.diagnostics === undefined ? undefined
            : decodeLspDiagnostics({ uri: origin.document.uri, version: origin.version, diagnostics: item.diagnostics }, origin).items;
        if (diagnostics?.some(item => item.placement !== "placed")) invalid();
        if (item.data !== undefined) decodeJson(item.data);
        const edit = item.edit === undefined ? null : decodeLspWorkspaceEdit(item.edit, resolve), cmd = item.command === undefined ? null : decodeLspCommand(item.command);
        const deferred = canResolve && !edit && !cmd && disabled === null ? decodeJson(item) : null;
        return Object.freeze({ title, kind, preferred: item.isPreferred === true, disabled, edit, command: cmd, resolve: deferred,
            ...(diagnostics === undefined ? {} : { diagnostics }) });
    });
    current(origin); for (const action of actions) if (action.edit && !action.edit.isCurrent()) throw staleRequest("LSP action target capture expired.");
    return Object.freeze(actions);
}
/** Only the advertised edit property may be added by codeAction/resolve. Opaque data is preserved. */
export function decodeLspResolvedCodeAction(value: unknown, original: LspCodeAction, origin: LspDocumentCapture, resolve: (uri: string) => LspEditTarget | undefined): LspCodeAction {
    current(origin); if (!isRecord(original.resolve) || !isRecord(value) || value.edit === undefined) invalid();
    const before = original.resolve, after = { ...value }; delete after.edit;
    if (!jsonEqual(before, after)) throw new ProtocolDecodeError("Resolved LSP action changed attributes outside its advertised edit property.");
    return decodeLspCodeActions([value], origin, resolve)[0]!;
}
