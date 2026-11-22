import { wireLimits, jsonSnapshot } from "./wire.ts";
import { createLspClient, lspFeatureHandle } from "./lsp-client.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";
import type { JsonValue } from "./wire.ts";
import { decodeLspColor, decodeLspColorPresentations, decodeLspDocumentColors, decodeLspDocumentLinks, decodeLspResolvedDocumentLink, decodeLspSignatureHelp } from "./lsp-features.ts";
import type { LspColor, LspDocumentColor, LspDocumentLink, LspSignature } from "./lsp-features.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";

export type LspSignatureContext = Readonly<{ triggerKind: 1 | 2 | 3; triggerCharacter?: string; isRetrigger: boolean; activeSignatureHelp?: JsonValue }>;
export function createLspSignatureClient(provider: LspWorkspace) {
    const lane = createLspClient(provider);
    // Prior wire context is not fresh range/edit authority. Keep only its binding identities,
    // never the old buffer/capture, and compare them after the next request has synchronized.
    let previous: Readonly<{ document: string; resource: string; uri: string; language: string; epoch: number; generation: number; wire: JsonValue }> | undefined;
    const stop = lane.subscribe(() => { const state = lane.getSnapshot();
        if (state.phase !== "ready" || previous?.epoch !== state.epoch || previous.generation !== state.registrationGeneration) previous = undefined;
    });
    return Object.freeze({ ...lspFeatureHandle(lane, ["textDocument/signatureHelp"], {
        cancel: () => { previous = undefined; lane.cancel(); }, dispose: () => { previous = undefined; stop(); lane.dispose(); } }),
        run: (document: DocumentSnapshot, offset: number, context: LspSignatureContext = { triggerKind: 1, isRetrigger: false }, prepare?: LspPrepare) => {
            const wireContext = jsonSnapshot(context);
            if (context.triggerCharacter !== undefined && (!context.triggerCharacter.length || context.triggerCharacter.length > 8)
                || JSON.stringify(wireContext).length > wireLimits.signatureContextUnits) throw new TypeError("Invalid signature help context.");
            const retrigger = context.isRetrigger, inherit = context.activeSignatureHelp === undefined;
            if (!retrigger) previous = undefined;
            const call = lane.request([document], document.id, "textDocument/signatureHelp", capture => {
                const doc = capture.document; let active = wireContext;
                if (previous && (previous.document !== doc.documentId || previous.resource !== doc.resourceId || previous.uri !== doc.uri || previous.language !== doc.languageId
                    || previous.epoch !== capture.epoch || previous.generation !== capture.registrationGeneration)) previous = undefined;
                if (retrigger && inherit && previous) {
                    const inherited = { ...wireContext as Record<string, JsonValue>, activeSignatureHelp: previous.wire };
                    // Optional inherited context must not make an otherwise bounded request fail.
                    if (JSON.stringify(inherited).length <= wireLimits.signatureContextUnits) active = inherited;
                }
                return { position: capture.index.at(offset), context: active };
            }, prepare);
            return Object.freeze({ cancel: call.cancel, result: call.result.then(value => value.decode(() => {
                const help = decodeLspSignatureHelp(value.response, value.capture), { document: doc, epoch, registrationGeneration } = value.capture;
                const context = help?.signatures.length ? { document: doc.documentId, resource: doc.resourceId, uri: doc.uri, language: doc.languageId, epoch, generation: registrationGeneration, wire: help.wire } : undefined;
                previous = context;
                return help && Object.freeze({ ...help, isCurrent: value.isCurrent, selectOverload(signature: LspSignature) {
                    const index = help.signatures.indexOf(signature);
                    if (index < 0 || !context || previous !== context || !value.isCurrent()) return false;
                    context.wire = Object.freeze({ ...help.wire as Readonly<Record<string, JsonValue>>, activeSignature: index });
                    return true;
                } });
            })) });
        } });
}
export function createLspLinkClient(provider: LspWorkspace) {
    const lane = createLspClient(provider);
    return Object.freeze({ ...lspFeatureHandle(lane, ["textDocument/documentLink"]),
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
    return Object.freeze({ ...lspFeatureHandle(lane, ["textDocument/documentColor", "textDocument/colorPresentation"]),
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
