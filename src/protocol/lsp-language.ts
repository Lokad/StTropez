import { colorPresentationMethod, documentColorMethod, documentLinkMethod, signatureHelpMethod } from "./lsp-methods.ts";
import { wireLimits, jsonSnapshot, staleRequest } from "./wire.ts";
import { createLspClient, lspFeatureHandle, type LspFeatureClient, type LspDocumentRequest, type LspPositionRequest } from "./lsp-client.ts";
import type { JsonValue } from "./wire.ts";
import { decodeLspColor, decodeLspColorPresentations, decodeLspDocumentColors, decodeLspDocumentLinks, decodeLspResolvedDocumentLink, decodeLspSignatureHelp } from "./lsp-features.ts";
import type { LspColorPresentation, LspSignatureHelp, LspColor, LspDocumentColor, LspDocumentLink, LspSignature } from "./lsp-features.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";
import type { LspConnectContext } from "./lsp-session.ts";
import type { LspDocumentOwner } from "./lsp-client.ts";

export type LspSignatureContext = Readonly<{ triggerKind: 1 | 2 | 3; triggerCharacter?: string; isRetrigger: boolean; activeSignatureHelp?: JsonValue }>;
export type LspSignatureRequest = LspPositionRequest & Readonly<{ context?: LspSignatureContext }>;
export type LspSignatureClient = LspFeatureClient<"textDocument/signatureHelp", LspSignatureRequest,
    (LspSignatureHelp & Readonly<{ isCurrent: () => boolean; selectOverload: (signature: LspSignature) => boolean }>) | null>;
export type LspLinkClient = LspFeatureClient<"textDocument/documentLink", LspDocumentRequest, Readonly<{
    items: readonly LspDocumentLink[]; isCurrent: () => boolean;
    resolve: (item: LspDocumentLink, prepare?: LspPrepare) => Promise<LspDocumentLink>;
}>>;
export type LspColorClient = LspFeatureClient<"textDocument/documentColor" | "textDocument/colorPresentation", LspDocumentRequest, Readonly<{
    items: readonly LspDocumentColor[]; isCurrent: () => boolean;
    presentations: (item: LspDocumentColor, color: LspColor, prepare?: LspPrepare, onCancel?: LspConnectContext["onCancel"]) => Promise<readonly LspColorPresentation[]>;
}>>;

export const createLspSignatureClient: (provider: LspWorkspace) => LspSignatureClient = signatureClient;

export function signatureClient(provider: LspWorkspace | LspDocumentOwner): LspSignatureClient {
    const lane = createLspClient(provider, signatureHelpMethod);
    // Prior wire context is not fresh range/edit authority. Keep only its binding identities,
    // never the old buffer/capture, and compare them after the next request has synchronized.
    let previous: Readonly<{ document: string; resource: string; uri: string; language: string; epoch: number; generation: number; wire: JsonValue }> | undefined;
    const stop = lane.subscribe(() => { const state = lane.getSnapshot();
        if (state.phase !== "ready" || previous?.epoch !== state.epoch || previous.generation !== state.registrationVersion(signatureHelpMethod)) previous = undefined;
    });
    return Object.freeze({ ...lspFeatureHandle(lane, {
        cancel: () => { previous = undefined; lane.cancel(); }, dispose: () => { previous = undefined; stop(); lane.dispose(); } }),
        run: (request: LspSignatureRequest) => {
            const { offset, context = { triggerKind: 1, isRetrigger: false } } = request;
            const wireContext = jsonSnapshot(context);
            if (context.triggerCharacter !== undefined && (!context.triggerCharacter.length || context.triggerCharacter.length > 8)
                || JSON.stringify(wireContext).length > wireLimits.signatureContextUnits) throw new TypeError("Invalid signature help context.");
            const retrigger = context.isRetrigger, inherit = context.activeSignatureHelp === undefined;
            if (!retrigger) previous = undefined;
            return lane.request(request, signatureHelpMethod, capture => {
                const doc = capture.document; let active = wireContext;
                if (previous && (previous.document !== doc.documentId || previous.resource !== doc.resourceId || previous.uri !== doc.uri || previous.language !== doc.languageId
                    || previous.epoch !== capture.epoch || previous.generation !== capture.registrationGeneration)) previous = undefined;
                if (retrigger && inherit && previous) {
                    const inherited = { ...wireContext as Record<string, JsonValue>, activeSignatureHelp: previous.wire };
                    // Optional inherited context must not make an otherwise bounded request fail.
                    if (JSON.stringify(inherited).length <= wireLimits.signatureContextUnits) active = inherited;
                }
                return { position: capture.index.at(offset), context: active };
            }, value => value.decode(() => {
                const help = decodeLspSignatureHelp(value.response, value.capture), { document: doc, epoch, registrationGeneration } = value.capture;
                const context = help?.signatures.length ? { document: doc.documentId, resource: doc.resourceId, uri: doc.uri, language: doc.languageId, epoch, generation: registrationGeneration, wire: help.wire } : undefined;
                previous = context;
                return help && Object.freeze({ ...help, isCurrent: value.isCurrent, selectOverload(signature: LspSignature) {
                    const index = help.signatures.indexOf(signature);
                    if (index < 0 || !context || previous !== context || !value.isCurrent()) return false;
                    context.wire = Object.freeze({ ...help.wire as Readonly<Record<string, JsonValue>>, activeSignature: index });
                    return true;
                } });
            }));
        } });
}
export const createLspLinkClient: (provider: LspWorkspace) => LspLinkClient = linkClient;

export function linkClient(provider: LspWorkspace | LspDocumentOwner,
    watched?: { item: LspDocumentLink; isCurrent(): boolean }): LspLinkClient {
    const lane = createLspClient(provider, documentLinkMethod);
    return Object.freeze({ ...lspFeatureHandle(lane),
        run: (request: LspDocumentRequest) => lane.request(request, documentLinkMethod, () => {
            if (!watched) return {};
            if (!watched.isCurrent()) throw staleRequest();
            return watched.item.resolve as Record<string, JsonValue>;
        }, result => {
            const { capture, isCurrent } = result;
            const items = result.decode(() => watched
                ? Object.freeze([decodeLspResolvedDocumentLink(result.response, watched.item, capture)])
                : decodeLspDocumentLinks(result.response, capture,
                    lane.options(request.document, documentLinkMethod).some(option => option.resolveProvider === true)));
            return Object.freeze({ items, isCurrent, resolve: async (item: LspDocumentLink, prepareResolve?: LspPrepare) => {
                if (!items.includes(item) || !item.resolve) throw new TypeError("Choose a captured resolvable document link.");
                const value = await result.follow(documentLinkMethod, "documentLink/resolve", item.resolve, prepareResolve);
                return result.decode(() => decodeLspResolvedDocumentLink(value, item, capture));
            } });
        }, watched ? "documentLink/resolve" : undefined) });
}
export const createLspColorClient: (provider: LspWorkspace) => LspColorClient = colorClient;

export function colorClient(provider: LspWorkspace | LspDocumentOwner): LspColorClient {
    const lane = createLspClient(provider, documentColorMethod, colorPresentationMethod);
    return Object.freeze({ ...lspFeatureHandle(lane),
        run: (request: LspDocumentRequest) => lane.request(request, documentColorMethod, () => ({}), result => {
            const { capture, isCurrent } = result;
            const items = result.decode(() => decodeLspDocumentColors(result.response, capture));
            return Object.freeze({ items, isCurrent, presentations: async (item: LspDocumentColor, color: LspColor, preparePresentation?: LspPrepare, onCancel?: LspConnectContext["onCancel"]) => {
                if (!items.includes(item)) throw new TypeError("Choose a captured document color.");
                const value = await result.follow(colorPresentationMethod, colorPresentationMethod, {
                    textDocument: { uri: capture.document.uri }, color: decodeLspColor(color), range: { start: capture.index.at(item.from), end: capture.index.at(item.to) } }, preparePresentation, onCancel);
                return result.decode(() => decodeLspColorPresentations(value, item, capture));
            } });
        }) });
}
