import { createLspClient } from "./lsp-client.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";
import { jsonSnapshot } from "./json-rpc.ts";
import type { JsonValue } from "./json-rpc.ts";
import { decodeLspColor, decodeLspColorPresentations, decodeLspDocumentColors, decodeLspDocumentLinks, decodeLspResolvedDocumentLink, decodeLspSignatureHelp } from "./lsp-features.ts";
import type { LspColor, LspDocumentColor, LspDocumentLink } from "./lsp-features.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";

export type LspSignatureContext = Readonly<{ triggerKind: 1 | 2 | 3; triggerCharacter?: string; isRetrigger: boolean; activeSignatureHelp?: JsonValue }>;
export function createLspSignatureClient(provider: LspWorkspace) {
    const lane = createLspClient(provider);
    return Object.freeze({ state: lane.state, subscribe: lane.subscribe, snapshot: lane.snapshot, cancel: lane.cancel, dispose: lane.dispose,
        options: (document: DocumentSnapshot) => lane.options(document, "textDocument/signatureHelp"),
        run: (document: DocumentSnapshot, offset: number, context: LspSignatureContext = { triggerKind: 1, isRetrigger: false }, prepare?: LspPrepare) => {
            const wireContext = jsonSnapshot(context);
            if (![1, 2, 3].includes(context.triggerKind) || typeof context.isRetrigger !== "boolean" || context.triggerCharacter !== undefined && (typeof context.triggerCharacter !== "string" || !context.triggerCharacter.length || context.triggerCharacter.length > 8)
                || JSON.stringify(wireContext).length > 131072) throw new TypeError("Invalid signature help context.");
            const call = lane.request([document], document.id, "textDocument/signatureHelp", capture => ({ position: capture.index.at(offset), context: wireContext }), prepare);
            return Object.freeze({ cancel: call.cancel, result: call.result.then(value => value.decode(() => {
                const help = decodeLspSignatureHelp(value.response, value.capture); return help && Object.freeze({ ...help, isCurrent: value.isCurrent });
            })) });
        } });
}
export function createLspLinkClient(provider: LspWorkspace) {
    const lane = createLspClient(provider);
    return Object.freeze({ state: lane.state, subscribe: lane.subscribe, snapshot: lane.snapshot, cancel: lane.cancel, dispose: lane.dispose,
        run: async (document: DocumentSnapshot, prepare?: LspPrepare) => {
            const result = await lane.request([document], document.id, "textDocument/documentLink", () => ({}), prepare).result;
            const { capture, isCurrent } = result;
            const items = result.decode(() => decodeLspDocumentLinks(result.response, capture, lane.options(document, "textDocument/documentLink").some(option => option.resolveProvider === true)));
            return Object.freeze({ items, isCurrent, resolve: async (item: LspDocumentLink, prepareResolve?: LspPrepare) => {
                if (!items.includes(item) || !item.resolve) throw new TypeError("Choose a captured resolvable document link.");
                const value = await result.follow("textDocument/documentLink", "documentLink/resolve", item.resolve, prepareResolve);
                return result.decode(() => decodeLspResolvedDocumentLink(value, item, capture));
            } });
        } });
}
export function createLspColorClient(provider: LspWorkspace) {
    const lane = createLspClient(provider);
    return Object.freeze({ state: lane.state, subscribe: lane.subscribe, snapshot: lane.snapshot, cancel: lane.cancel, dispose: lane.dispose,
        run: async (document: DocumentSnapshot, prepare?: LspPrepare) => {
            const result = await lane.request([document], document.id, "textDocument/documentColor", () => ({}), prepare).result;
            const { capture, isCurrent } = result;
            const items = result.decode(() => decodeLspDocumentColors(result.response, capture));
            return Object.freeze({ items, isCurrent, presentations: async (item: LspDocumentColor, color: LspColor, preparePresentation?: LspPrepare) => {
                if (!items.includes(item)) throw new TypeError("Choose a captured document color.");
                const value = await result.follow("textDocument/colorPresentation", "textDocument/colorPresentation", {
                    textDocument: { uri: capture.document.uri }, color: decodeLspColor(color), range: { start: capture.index.at(item.from), end: capture.index.at(item.to) } }, preparePresentation);
                return result.decode(() => decodeLspColorPresentations(value, item, capture));
            } });
        } });
}
