import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { InitializeRequest, InitializedNotification, ResponseError, TextDocument, RegistrationRequest, UnregistrationRequest } from "vscode-languageserver-protocol/node.js";
import type { InitializeResult, DidOpenTextDocumentParams, DidChangeTextDocumentParams, DidCloseTextDocumentParams, RegistrationParams, UnregistrationParams } from "vscode-languageserver-protocol/node.js";
import type { RpcTransport } from "../../src/protocol/json-rpc.ts";
import { referencePeer } from "./reference-peer.ts";

/** Generic development peer. It is separate from the internal worker-v1 fixture and production assets. */
export function attachProtocolFixture(server: Server) {
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 }), release = new Set<() => void>();
    const onUpgrade = (request: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
        if (new URL(request.url ?? "/", "http://localhost").pathname !== "/lsp-fixture") { socket.destroy(); return; }
        sockets.handleUpgrade(request, socket, head, connection => sockets.emit("connection", connection, request));
    };
    server.on("upgrade", onUpgrade);
    sockets.on("connection", socket => {
        let owner: Parameters<RpcTransport["subscribe"]>[0] | undefined, held = 0, initialized = false;
        const port: RpcTransport = {
            send: text => { if (socket.readyState !== 1) throw new Error("Fixture transport closed"); socket.send(text); },
            subscribe: listener => { if (owner) throw new Error("Fixture transport already owned"); owner = listener; return () => { if (owner === listener) owner = undefined; }; },
            dispose: () => socket.close(1000, "Fixture closed"),
        };
        socket.on("message", (data, binary) => { if (binary) socket.close(1003, "Text only"); else owner?.message(data.toString()); });
        socket.on("error", () => socket.close());
        const peer = referencePeer(port);
        const documents = new Map<string, TextDocument>(), syncFailures: string[] = [];
        peer.onRequest(InitializeRequest.type, (params): InitializeResult => ({ capabilities: { positionEncoding: "utf-16", textDocumentSync: 2,
            hoverProvider: params.initializationOptions?.fixtureDynamic !== true }, serverInfo: { name: "Generic protocol fixture" } }));
        peer.onNotification(InitializedNotification.type, () => { initialized = true; });
        const sync = (update: () => void) => { try { if (!initialized) throw new Error("Synchronization before initialized"); update(); } catch (error) { syncFailures.push(String(error)); } };
        peer.onNotification("textDocument/didOpen", (params: DidOpenTextDocumentParams) => sync(() => { const doc = params.textDocument;
            if (documents.has(doc.uri)) throw new Error("Duplicate open"); documents.set(doc.uri, TextDocument.create(doc.uri, doc.languageId, doc.version, doc.text)); }));
        peer.onNotification("textDocument/didChange", (params: DidChangeTextDocumentParams) => sync(() => {
            const before = documents.get(params.textDocument.uri); if (!before || params.textDocument.version <= before.version) throw new Error("Invalid change version");
            let text = before.getText(); for (const change of params.contentChanges) { if (!("range" in change)) throw new Error("Expected incremental changes");
                text = TextDocument.applyEdits(TextDocument.create(before.uri, before.languageId, before.version, text), [{ range: change.range, newText: change.text }]); }
            documents.set(before.uri, TextDocument.create(before.uri, before.languageId, params.textDocument.version, text));
        }));
        peer.onNotification("textDocument/didClose", (params: DidCloseTextDocumentParams) => sync(() => { if (!documents.delete(params.textDocument.uri)) throw new Error("Close without open"); }));
        peer.onRequest("fixture/register", (params: RegistrationParams) => peer.sendRequest(RegistrationRequest.type, params));
        peer.onRequest("fixture/unregister", (params: UnregistrationParams) => peer.sendRequest(UnregistrationRequest.type, params));
        peer.onRequest("fixture/document", (params: { uri: string; from: number; to: number }) => {
            const doc = documents.get(params.uri); if (!doc) throw new ResponseError(-32602, "Document not open");
            return { uri: doc.uri, version: doc.version, length: doc.getText().length, text: doc.getText().slice(params.from, params.to), syncFailures: [...syncFailures] };
        });
        peer.onRequest("textDocument/hover", (params: { textDocument: { uri: string }; position: { line: number; character: number } }) => {
            if (!documents.has(params.textDocument.uri)) throw new ResponseError(-32602, "Document not open");
            return { contents: { kind: "plaintext", value: `Fixture ${params.textDocument.uri}:${params.position.line}:${params.position.character}` } };
        });
        peer.onRequest("shutdown", () => null); peer.onNotification("exit", () => port.dispose());
        peer.onRequest("fixture/echo", (params: unknown) => params);
        peer.onRequest("fixture/roundtrip", (params: unknown) => peer.sendRequest("host/echo", params));
        peer.onRequest("fixture/notice", (params: unknown) => { peer.sendNotification("fixture/notice", params); return null; });
        peer.onRequest("fixture/state", () => ({ held, initialized }));
        peer.onRequest("fixture/fail", () => { throw new ResponseError(-32001, "Fixture rejection", { retryable: true }); });
        peer.onRequest("fixture/hold", (_params: unknown, token) => new Promise((_resolve, reject) => {
            held++; const stop = token.onCancellationRequested(() => { held--; stop.dispose(); reject(new ResponseError(-32800, "Fixture cancelled")); });
        }));
        peer.onNotification("fixture/disconnect", () => port.dispose());
        peer.onNotification("fixture/binary", () => socket.send(Buffer.from("{}"), { binary: true }));
        peer.listen();
        const dispose = () => { peer.dispose(); socket.terminate(); }; release.add(dispose);
        socket.on("close", () => { const listener = owner; owner = undefined; listener?.close(new Error("Fixture socket closed")); peer.dispose(); release.delete(dispose); });
    });
    return () => { server.off("upgrade", onUpgrade); for (const dispose of [...release]) dispose(); release.clear(); sockets.close(); };
}
