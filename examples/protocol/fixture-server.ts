import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { InitializeRequest, InitializedNotification, ResponseError, TextDocument, RegistrationRequest, UnregistrationRequest } from "vscode-languageserver-protocol/node.js";
import type { CancellationToken, CompletionList, InitializeResult, DidOpenTextDocumentParams, DidChangeTextDocumentParams, DidCloseTextDocumentParams, RegistrationParams, UnregistrationParams } from "vscode-languageserver-protocol/node.js";
import { setImmediate } from "node:timers/promises";
import type { RpcTransport } from "../../src/protocol/json-rpc.ts";
import { referencePeer } from "./reference-peer.ts";
import { provide } from "../probes/provider.ts";
import { provideHover } from "../probes/hover.ts";
import { SymbolScanner } from "../probes/navigation.ts";
import { renameName } from "../probes/rename.ts";
import type { Location, TextEdit, WorkspaceEdit } from "vscode-languageserver-protocol/node.js";

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
        const pending = new Set<() => void>(); let completionConfig: { delay: number; fault?: "malformed" | "failure" } = { delay: 0 }, completionStyle = "edits";
        let hoverConfig: { delay: number; fault?: "malformed" | "failure" | "markup" } | undefined, navigationConfig: { delay: number; fault?: "malformed" | "failure" } = { delay: 0 }, definitionLinks = false;
        let renameConfig: { delay: number; fault?: "malformed" | "failure" } = { delay: 0 }, versionedEdits = false;
        const deferred = <T>(delay: number, token: CancellationToken, compute: () => T | Promise<T>) => new Promise<T>((resolve, reject) => {
            let done = false, stop: { dispose: () => void } | undefined;
            const finish = () => { if (done) return false; done = true; clearTimeout(timer); stop?.dispose(); pending.delete(cancel); return true; };
            const cancel = () => { if (finish()) reject(new ResponseError(-32800, "Fixture request cancelled")); };
            const timer = setTimeout(() => { void Promise.resolve().then(() => { if (token.isCancellationRequested) throw new ResponseError(-32800, "Fixture request cancelled"); return compute(); })
                .then(value => { if (finish()) resolve(value); }, error => { if (finish()) reject(error); }); }, delay);
            pending.add(cancel); stop = token.onCancellationRequested(cancel); if (done) stop.dispose(); if (token.isCancellationRequested) cancel();
        });
        const diagnosticItems = (doc: TextDocument) => {
            const text = doc.getText(), items = []; let at = 0;
            while ((at = text.indexOf("TODO", at)) >= 0 && items.length < 256) { items.push({ range: { start: doc.positionAt(at), end: doc.positionAt(at + 4) }, message: "Resolve this placeholder.", severity: 2 }); at += 4; }
            return items;
        };
        const publish = (doc: TextDocument) => { peer.sendNotification("textDocument/publishDiagnostics", { uri: doc.uri, version: doc.version, diagnostics: diagnosticItems(doc) }); };
        peer.onRequest(InitializeRequest.type, (params): InitializeResult => { definitionLinks = params.capabilities.textDocument?.definition?.linkSupport === true;
            versionedEdits = params.capabilities.workspace?.workspaceEdit?.documentChanges === true;
            return { capabilities: { positionEncoding: "utf-16", textDocumentSync: 2, definitionProvider: true, referencesProvider: true, renameProvider: true,
                completionProvider: { triggerCharacters: ["."] }, hoverProvider: params.initializationOptions?.fixtureDynamic !== true }, serverInfo: { name: "Generic protocol fixture" } }; });
        peer.onNotification(InitializedNotification.type, () => { initialized = true; });
        const sync = (update: () => void) => { try { if (!initialized) throw new Error("Synchronization before initialized"); update(); } catch (error) { syncFailures.push(String(error)); } };
        peer.onNotification("textDocument/didOpen", (params: DidOpenTextDocumentParams) => sync(() => { const doc = params.textDocument;
            if (documents.has(doc.uri)) throw new Error("Duplicate open"); const opened = TextDocument.create(doc.uri, doc.languageId, doc.version, doc.text); documents.set(doc.uri, opened); publish(opened); }));
        peer.onNotification("textDocument/didChange", (params: DidChangeTextDocumentParams) => sync(() => {
            const before = documents.get(params.textDocument.uri); if (!before || params.textDocument.version <= before.version) throw new Error("Invalid change version");
            let text = before.getText(); for (const change of params.contentChanges) { if (!("range" in change)) throw new Error("Expected incremental changes");
                text = TextDocument.applyEdits(TextDocument.create(before.uri, before.languageId, before.version, text), [{ range: change.range, newText: change.text }]); }
            const changed = TextDocument.create(before.uri, before.languageId, params.textDocument.version, text); documents.set(before.uri, changed); publish(changed);
        }));
        peer.onNotification("textDocument/didClose", (params: DidCloseTextDocumentParams) => sync(() => { if (!documents.delete(params.textDocument.uri)) throw new Error("Close without open"); }));
        peer.onRequest("fixture/register", (params: RegistrationParams) => peer.sendRequest(RegistrationRequest.type, params));
        peer.onRequest("fixture/unregister", (params: UnregistrationParams) => peer.sendRequest(UnregistrationRequest.type, params));
        peer.onRequest("fixture/document", (params: { uri: string; from: number; to: number }) => {
            const doc = documents.get(params.uri); if (!doc) throw new ResponseError(-32602, "Document not open");
            return { uri: doc.uri, version: doc.version, length: doc.getText().length, text: doc.getText().slice(params.from, params.to), syncFailures: [...syncFailures] };
        });
        const symbolAt = (doc: TextDocument, position: { line: number; character: number }) => {
            const text = doc.getText(), offset = doc.offsetAt(position), from = Math.max(0, offset - 2047), to = Math.min(text.length, offset + 2047);
            const result = provideHover({ operation: "hover", id: 1, revision: doc.version, text: text.slice(from, to), offset: offset - from, delay: 0 });
            return { text, from, result, range: result.range && { start: doc.positionAt(from + result.range.from), end: doc.positionAt(from + result.range.to) } };
        };
        peer.onRequest("fixture/hoverConfig", (params: NonNullable<typeof hoverConfig>) => {
            if (!params || !Number.isFinite(params.delay) || params.delay < 0 || params.delay > 1000 || params.fault !== undefined && !["malformed", "failure", "markup"].includes(params.fault)) throw new ResponseError(-32602, "Invalid hover configuration"); hoverConfig = { ...params }; return null;
        });
        peer.onRequest("textDocument/hover", (params: { textDocument: { uri: string }; position: { line: number; character: number } }, token) => {
            const doc = documents.get(params.textDocument.uri); if (!doc) throw new ResponseError(-32602, "Document not open");
            const config = hoverConfig;
            if (!config) return { contents: { kind: "plaintext", value: `Fixture ${params.textDocument.uri}:${params.position.line}:${params.position.character}` } };
            hoverConfig = { delay: 0 };
            return deferred(config.delay, token, () => {
                if (config.fault === "failure") throw new ResponseError(-32001, "Fixture hover unavailable");
                if (config.fault === "malformed") return { contents: ["valid prefix", { language: "fixture", value: 42 }] };
                if (config.fault === "markup") return { contents: { kind: "markdown", value: '<img src="x" onerror="hoverExecuted=1"> **literal information**' } };
                const symbol = symbolAt(doc, params.position); if (!symbol.result.range) return null;
                return { contents: [{ language: "fixture", value: symbol.text.slice(symbol.from + symbol.result.range.from, symbol.from + symbol.result.range.to) }, symbol.result.text], range: symbol.range };
            });
        });
        peer.onRequest("fixture/navigationConfig", (params: typeof navigationConfig) => {
            if (!params || !Number.isFinite(params.delay) || params.delay < 0 || params.delay > 1000 || params.fault !== undefined && !["malformed", "failure"].includes(params.fault)) throw new ResponseError(-32602, "Invalid navigation configuration"); navigationConfig = { ...params }; return null;
        });
        const scanLocations = async (project: readonly TextDocument[], name: string, kind: "definition" | "references", includeDeclaration: boolean, token: CancellationToken) => {
            const locations: Location[] = []; let overflow = false;
            for (const doc of project) {
                const scanner = new SymbolScanner(name, (from, to, declaration) => {
                    if (kind === "definition" ? !declaration : declaration && !includeDeclaration) return;
                    if (locations.length === 1024) { overflow = true; return; } locations.push({ uri: doc.uri, range: { start: doc.positionAt(from), end: doc.positionAt(to) } });
                });
                const text = doc.getText(); for (let at = 0; at < text.length; at += 16384) { if (token.isCancellationRequested) throw new ResponseError(-32800, "Fixture request cancelled"); scanner.chunk(text.slice(at, at + 16384)); if (at % 65536 === 0) await setImmediate(); } scanner.finish();
            }
            if (overflow) throw new ResponseError(-32000, "Fixture result exceeds its declared limit"); return locations;
        };
        peer.onRequest("fixture/renameConfig", (params: typeof renameConfig) => {
            if (!params || !Number.isFinite(params.delay) || params.delay < 0 || params.delay > 1000 || params.fault !== undefined && !["malformed", "failure"].includes(params.fault)) throw new ResponseError(-32602, "Invalid rename configuration"); renameConfig = { ...params }; return null;
        });
        peer.onRequest("textDocument/rename", (params: { textDocument: { uri: string }; position: { line: number; character: number }; newName: string }, token) => {
            const origin = documents.get(params.textDocument.uri); if (!origin || typeof params.newName !== "string" || !renameName(params.newName)) throw new ResponseError(-32602, "Fixture rename needs an open source and a supported new identifier");
            const config = renameConfig, project = [...documents.values()]; renameConfig = { delay: 0 };
            return deferred(config.delay, token, async (): Promise<WorkspaceEdit | null> => {
                if (config.fault === "failure") throw new ResponseError(-32001, "Fixture rename unavailable");
                const symbol = symbolAt(origin, params.position); if (!symbol.result.range) return null;
                const name = symbol.text.slice(symbol.from + symbol.result.range.from, symbol.from + symbol.result.range.to);
                const locations = await scanLocations(project, name, "references", true, token);
                if (!locations.some(location => location.uri === origin.uri && origin.offsetAt(location.range.start) <= origin.offsetAt(params.position) && origin.offsetAt(params.position) <= origin.offsetAt(location.range.end))) return null;
                const changes = new Map<string, TextEdit[]>();
                for (const location of locations) { const edits = changes.get(location.uri) ?? []; edits.push({ range: location.range, newText: params.newName }); changes.set(location.uri, edits); }
                const marker = "// fixture rename\r\n";
                if (!origin.getText().startsWith(marker)) { if (locations.length === 1024) throw new ResponseError(-32000, "Fixture rename exceeds its edit limit"); const edits = changes.get(origin.uri) ?? []; edits.unshift({ range: { start: origin.positionAt(0), end: origin.positionAt(0) }, newText: marker }); changes.set(origin.uri, edits); }
                if (config.fault === "malformed") changes.set("host+fixture:unknown-target", [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "invalid final target" }]);
                return versionedEdits ? { documentChanges: [...changes].map(([uri, edits]) => ({ textDocument: { uri, version: project.find(doc => doc.uri === uri)?.version ?? null }, edits: [...edits].reverse() })) } : { changes: Object.fromEntries(changes) };
            });
        });
        for (const kind of ["definition", "references"] as const) peer.onRequest(`textDocument/${kind}`, (params: { textDocument: { uri: string }; position: { line: number; character: number }; context?: { includeDeclaration: boolean } }, token) => {
            const origin = documents.get(params.textDocument.uri); if (!origin) throw new ResponseError(-32602, "Document not open");
            if (kind === "references" && typeof params.context?.includeDeclaration !== "boolean") throw new ResponseError(-32602, "References require declaration context");
            const config = navigationConfig, project = [...documents.values()]; navigationConfig = { delay: 0 };
            return deferred(config.delay, token, async () => {
                if (config.fault === "failure") throw new ResponseError(-32001, "Fixture navigation unavailable");
                const symbol = symbolAt(origin, params.position); if (!symbol.result.range) return [];
                const name = symbol.text.slice(symbol.from + symbol.result.range.from, symbol.from + symbol.result.range.to);
                const locations = await scanLocations(project, name, kind, params.context?.includeDeclaration ?? true, token);
                if (config.fault === "malformed") locations.push({ uri: "host+fixture:unknown-target", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } });
                if (kind === "definition" && definitionLinks) return locations.map(location => ({ originSelectionRange: symbol.range, targetUri: location.uri, targetRange: location.range, targetSelectionRange: location.range }));
                return kind === "definition" && locations.length === 1 ? locations[0] : locations;
            });
        });
        peer.onRequest("fixture/completionConfig", (params: typeof completionConfig) => {
            if (!params || !Number.isFinite(params.delay) || params.delay < 0 || params.delay > 1000 || params.fault !== undefined && !["malformed", "failure"].includes(params.fault)) throw new ResponseError(-32602, "Invalid fixture configuration");
            completionConfig = { ...params }; return null;
        });
        peer.onRequest("fixture/completionStyle", (params: { style: string }) => {
            if (!params || !["edits", "defaults", "plain"].includes(params.style)) throw new ResponseError(-32602, "Invalid completion style"); completionStyle = params.style; return null;
        });
        peer.onRequest("fixture/diagnostics", (params: { mode: "normal" | "malformed" | "stale" | "unversioned" | "clear" | "html" }) => {
            const doc = documents.values().next().value; if (!doc) throw new ResponseError(-32602, "No fixture document");
            const diagnostics = params.mode === "clear" ? [] : diagnosticItems(doc);
            if (params.mode === "malformed") diagnostics.push({ range: { start: { line: 0, character: 0 }, end: { line: doc.lineCount + 10, character: 0 } }, message: "Invalid final diagnostic", severity: 2 });
            if (params.mode === "html") diagnostics.push({ range: { start: doc.positionAt(0), end: doc.positionAt(0) }, message: "<img src=x onerror=unsafe()>", severity: 2 });
            peer.sendNotification("textDocument/publishDiagnostics", { uri: doc.uri, ...(params.mode === "unversioned" ? {} : { version: params.mode === "stale" ? doc.version - 1 : doc.version }), diagnostics }); return { version: doc.version };
        });
        peer.onRequest("textDocument/completion", (params: { textDocument: { uri: string }; position: { line: number; character: number } }, token) => {
            const doc = documents.get(params.textDocument.uri); if (!doc) throw new ResponseError(-32602, "Document not open");
            const config = completionConfig, style = completionStyle; completionConfig = { delay: 0 };
            return new Promise<CompletionList>((resolve, reject) => {
                let done = false; const finish = () => { if (done) return false; done = true; clearTimeout(timer); stop.dispose(); pending.delete(cancel); return true; };
                const cancel = () => { if (finish()) reject(new ResponseError(-32800, "Fixture completion cancelled")); };
                const timer = setTimeout(() => {
                    if (!finish()) return; if (config.fault === "failure") { reject(new ResponseError(-32001, "Fixture completion unavailable")); return; }
                    const text = doc.getText(), offset = doc.offsetAt(params.position), from = Math.max(0, offset - 2048), to = Math.min(text.length, offset + 2048);
                    const completion = provide({ id: 1, revision: doc.version, text: text.slice(from, to), offset: offset - from, delay: 0 }).completion;
                    const insert = { start: doc.positionAt(from + completion.from), end: doc.positionAt(offset) }, replace = { start: insert.start, end: doc.positionAt(from + completion.replaceTo) };
                    const items: CompletionList["items"] = [{ label: "sample", textEdit: { newText: "sample", insert, replace } },
                        { label: "sampleWithImport", textEdit: { newText: "sampleValue", insert, replace }, ...(from + completion.from > 0 ? { additionalTextEdits: [{ range: { start: doc.positionAt(0), end: doc.positionAt(0) }, newText: "// fixture import\r\n" }] } : {}) }];
                    if (config.fault === "malformed") items.push({ label: "invalid final item", textEdit: { newText: "bad", range: { start: insert.start, end: { line: doc.lineCount + 10, character: 0 } } } });
                    if (style === "edits" || config.fault) resolve({ isIncomplete: false, items });
                    else resolve({ isIncomplete: false, ...(style === "defaults" ? { itemDefaults: { editRange: { insert, replace }, insertTextFormat: 1, insertTextMode: 1 } } : {}),
                        items: items.map(({ textEdit, ...item }, index) => ({ ...item,
                            ...(style === "plain" ? { insertText: textEdit!.newText, textEditText: "ignored without defaults" } : { insertText: "ignored with default range", ...(index ? { textEditText: textEdit!.newText } : {}) }) })) });
                }, config.delay);
                const stop = token.onCancellationRequested(cancel); pending.add(cancel);
            });
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
        const dispose = () => { for (const cancel of [...pending]) cancel(); peer.dispose(); socket.terminate(); }; release.add(dispose);
        socket.on("close", () => { for (const cancel of [...pending]) cancel(); const listener = owner; owner = undefined; listener?.close(new Error("Fixture socket closed")); peer.dispose(); release.delete(dispose); });
    });
    return () => { server.off("upgrade", onUpgrade); for (const dispose of [...release]) dispose(); release.clear(); sockets.close(); };
}
