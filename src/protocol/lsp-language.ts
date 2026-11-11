import type { DocumentSnapshot } from "../core/workspace.ts";
import { jsonSnapshot, RpcError } from "./json-rpc.ts";
import type { JsonValue } from "./json-rpc.ts";
import { decodeLspColor, decodeLspColorPresentations, decodeLspDocumentColors, decodeLspDocumentLinks, decodeLspResolvedDocumentLink, decodeLspSignatureHelp } from "./lsp-features.ts";
import type { LspColor, LspDocumentColor, LspDocumentLink } from "./lsp-features.ts";
import type { LspDocument, LspDocumentCapture, LspDocumentFeature } from "./lsp-session.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";

/** Shared small request lifetime for the three independent feature clients below. */
function languageLane(provider: LspWorkspace) {
    const scope = provider.createScope(); let binding: LspDocument | undefined, serial = 0, disposed = false;
    const cancel = () => { if (!disposed) { serial++; scope.disconnect(); } };
    const attach = (document: DocumentSnapshot) => {
        if (disposed) throw new Error("LSP language client is disposed.");
        if (binding && binding.getSnapshot().documentId !== document.id) { binding.close(); binding = undefined; }
        binding = scope.attachDocument(document.id); return binding;
    };
    const read = (document: DocumentSnapshot, method: LspDocumentFeature, params: (capture: LspDocumentCapture) => Record<string, JsonValue>, prepare?: LspPrepare) => {
        cancel(); const token = serial;
        const guard = () => { if (disposed || token !== serial) throw new RpcError(-32800, "LSP language request cancelled."); };
        const result = (async () => {
            const target = attach(document); await scope.connect(); guard();
            if (target.getSnapshot().revision !== document.revision || target.getSnapshot().buffer !== document.buffer) throw new RpcError(-32801, "LSP language document changed.");
            if (prepare) await prepare(scope); guard(); let capture: LspDocumentCapture | undefined;
            const wire = scope.requestDocument(method, target, (_index, _document, value) => {
                if (value.document.documentId !== document.id || value.document.resourceId !== document.resourceId || value.document.revision !== document.revision || value.document.buffer !== document.buffer) throw new RpcError(-32801, "LSP language document changed before sending.");
                capture = value; return params(value);
            });
            const response = await wire.result; guard();
            if (!capture?.isCurrent()) throw new RpcError(-32801, "LSP language capture expired.");
            const current = () => !disposed && token === serial && capture!.isCurrent();
            return Object.freeze({ response, capture, isCurrent: current, target });
        })();
        return Object.freeze({ result, cancel: () => { if (token === serial) cancel(); } });
    };
    const follow = async (capture: LspDocumentCapture, isCurrent: () => boolean, target: LspDocument, feature: LspDocumentFeature, method: string, params: JsonValue, prepare?: LspPrepare) => {
        const guard = () => { if (disposed || !isCurrent() || !capture.isCurrent()) throw new RpcError(-32801, "LSP language result expired."); };
        guard(); if (prepare) await prepare(scope); guard();
        if (!scope.canRequest(feature, target)) throw new RpcError(-32601, "LSP language feature unavailable.");
        let call;
        if (method === feature) { const body = { ...params as Record<string, JsonValue> }; delete body.textDocument; call = scope.requestDocument(feature, target, () => body); }
        else call = scope.request(method, params);
        const value = await call.result; guard(); return value;
    };
    return Object.freeze({ read, follow, cancel, state: provider.state, subscribe: (listener: () => void) => scope.state.subscribe(listener),
        options: (document: DocumentSnapshot, method: LspDocumentFeature) => scope.featureOptions(method, attach(document)),
        snapshot: () => Object.freeze({ connected: scope.state.getSnapshot().phase === "ready", disposed, protocol: scope.snapshotOwnership() }),
        dispose: () => { if (disposed) return; disposed = true; serial++; scope.dispose(); binding = undefined; } });
}
export type LspSignatureContext = Readonly<{ triggerKind: 1 | 2 | 3; triggerCharacter?: string; isRetrigger: boolean; activeSignatureHelp?: JsonValue }>;
export function createLspSignatureClient(provider: LspWorkspace) {
    const lane = languageLane(provider);
    return Object.freeze({ state: lane.state, subscribe: lane.subscribe, snapshot: lane.snapshot, cancel: lane.cancel, dispose: lane.dispose,
        options: (document: DocumentSnapshot) => lane.options(document, "textDocument/signatureHelp"),
        run: (document: DocumentSnapshot, offset: number, context: LspSignatureContext = { triggerKind: 1, isRetrigger: false }, prepare?: LspPrepare) => {
            const wireContext = jsonSnapshot(context);
            if (![1, 2, 3].includes(context.triggerKind) || typeof context.isRetrigger !== "boolean" || context.triggerCharacter !== undefined && (typeof context.triggerCharacter !== "string" || !context.triggerCharacter.length || context.triggerCharacter.length > 8)
                || JSON.stringify(wireContext).length > 131072) throw new TypeError("Invalid signature help context.");
            const call = lane.read(document, "textDocument/signatureHelp", capture => ({ position: capture.index.at(offset), context: wireContext }), prepare);
            return Object.freeze({ cancel: call.cancel, result: call.result.then(({ response, capture, isCurrent }) => {
                const help = decodeLspSignatureHelp(response, capture); return help && Object.freeze({ ...help, isCurrent });
            }) });
        } });
}
export function createLspLinkClient(provider: LspWorkspace) {
    const lane = languageLane(provider);
    return Object.freeze({ state: lane.state, subscribe: lane.subscribe, snapshot: lane.snapshot, cancel: lane.cancel, dispose: lane.dispose,
        run: async (document: DocumentSnapshot, prepare?: LspPrepare) => {
            const { response, capture, isCurrent, target } = await lane.read(document, "textDocument/documentLink", () => ({}), prepare).result;
            const items = decodeLspDocumentLinks(response, capture, lane.options(document, "textDocument/documentLink").some(option => option.resolveProvider === true));
            return Object.freeze({ items, isCurrent, resolve: async (item: LspDocumentLink, prepareResolve?: LspPrepare) => {
                if (!items.includes(item) || !item.resolve) throw new TypeError("Choose a captured resolvable document link.");
                const value = await lane.follow(capture, isCurrent, target, "textDocument/documentLink", "documentLink/resolve", item.resolve, prepareResolve);
                return decodeLspResolvedDocumentLink(value, item, capture);
            } });
        } });
}
export function createLspColorClient(provider: LspWorkspace) {
    const lane = languageLane(provider);
    return Object.freeze({ state: lane.state, subscribe: lane.subscribe, snapshot: lane.snapshot, cancel: lane.cancel, dispose: lane.dispose,
        run: async (document: DocumentSnapshot, prepare?: LspPrepare) => {
            const { response, capture, isCurrent, target } = await lane.read(document, "textDocument/documentColor", () => ({}), prepare).result;
            const items = decodeLspDocumentColors(response, capture);
            return Object.freeze({ items, isCurrent, presentations: async (item: LspDocumentColor, color: LspColor, preparePresentation?: LspPrepare) => {
                if (!items.includes(item)) throw new TypeError("Choose a captured document color.");
                const value = await lane.follow(capture, isCurrent, target, "textDocument/colorPresentation", "textDocument/colorPresentation", {
                    textDocument: { uri: capture.document.uri }, color: decodeLspColor(color), range: { start: capture.index.at(item.from), end: capture.index.at(item.to) } }, preparePresentation);
                return decodeLspColorPresentations(value, item, capture);
            } });
        } });
}
