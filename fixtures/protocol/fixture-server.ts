import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { InitializeRequest, InitializedNotification, ResponseError, TextDocument, RegistrationRequest, UnregistrationRequest, CancellationTokenSource } from "vscode-languageserver-protocol/node.js";
import type { CancellationToken, CompletionList, InitializeResult, DidOpenTextDocumentParams, DidChangeTextDocumentParams, DidCloseTextDocumentParams, RegistrationParams, UnregistrationParams } from "vscode-languageserver-protocol/node.js";
import { setImmediate } from "node:timers/promises";
import type { RpcTransport } from "../../src/protocol/json-rpc.ts";
import { referencePeer } from "./reference-peer.ts";
import { provide } from "../language/provider.ts";
import { provideHover } from "../language/hover.ts";
import { SymbolScanner } from "../language/navigation.ts";
import { renameName } from "../language/rename.ts";
import type { Location, TextEdit, WorkspaceEdit } from "vscode-languageserver-protocol/node.js";
import type { CodeAction, Command } from "vscode-languageserver-protocol/node.js";
import { TextBuffer } from "../../src/index.ts";
import { ModuleActionCursor } from "../language/actions.ts";
import { validDomainModule } from "../language/domain.ts";
import { reviewHeader, reviewFooter } from "../language/project-commands.ts";
import type { ApplyWorkspaceEditResult } from "vscode-languageserver-protocol/node.js";
import { SignatureScanner } from "../language/signature.ts";
import { ModuleLinksCursor } from "../language/links.ts";
import { DocumentColorsCursor, hexColor, rgbaColor, validateRgba } from "../language/colors.ts";

type RequestPolicy<Fault extends string> = Readonly<{ delay: number; fault?: Fault }>;
function requestPolicy<Fault extends string>(value: unknown, faults: readonly Fault[]): RequestPolicy<Fault> {
    if (value === undefined) return { delay: 0 };
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ResponseError(-32602, "Invalid fixture request policy");
    const policy = value as RequestPolicy<Fault>;
    if (!Number.isFinite(policy.delay) || policy.delay < 0 || policy.delay > 1000 || policy.fault !== undefined && !faults.includes(policy.fault)) throw new ResponseError(-32602, "Invalid fixture request policy");
    return { delay: policy.delay, ...(policy.fault === undefined ? {} : { fault: policy.fault }) };
}
function moduleUris(value: unknown): readonly Readonly<{ module: string; uri: string }>[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 100 || value.some(alias => !alias || typeof alias.module !== "string" || !validDomainModule(alias.module) || typeof alias.uri !== "string" || !alias.uri || alias.uri.length > 4096)) throw new ResponseError(-32602, "Invalid fixture module URIs");
    return value.map(alias => ({ module: alias.module, uri: alias.uri }));
}

/** Generic development LSP peer, excluded from production assets. */
export function attachProtocolFixture(server: Server, options: Readonly<{ allowOtherUpgrades?: boolean }> = {}) {
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 }), release = new Set<() => void>();
    const onUpgrade = (request: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
        if (new URL(request.url ?? "/", "http://localhost").pathname !== "/lsp-fixture") { if (!options.allowOtherUpgrades) socket.destroy(); return; }
        sockets.handleUpgrade(request, socket, head, connection => sockets.emit("connection", connection, request));
    };
    server.on("upgrade", onUpgrade);
    sockets.on("connection", (socket, request) => {
        let needsPreface = new URL(request.url ?? "/", "http://localhost").searchParams.has("preface");
        let owner: Parameters<RpcTransport["subscribe"]>[0] | undefined, held = 0, initialized = false;
        const port: RpcTransport = {
            send: text => { if (socket.readyState !== 1) throw new Error("Fixture transport closed"); socket.send(text); },
            subscribe: listener => { if (owner) throw new Error("Fixture transport already owned"); owner = listener; return () => { if (owner === listener) owner = undefined; }; },
            dispose: () => socket.close(1000, "Fixture closed"),
        };
        socket.on("message", (data, binary) => {
            if (binary) { socket.close(1003, "Text only"); return; }
            if (needsPreface) {
                if (data.toString() !== "fixture pre-protocol message") { socket.close(1008, "Expected fixture preface"); return; }
                needsPreface = false; return;
            }
            owner?.message(data.toString());
        });
        socket.on("error", () => socket.close());
        const peer = referencePeer(port);
        // A queued notification can meet a peer that closed after its last document change.
        // Observe the async writer failure so one disposed test client cannot stop the server.
        const notify = (method: string, params: unknown) => peer.sendNotification(method, params).catch(() => { if (socket.readyState === 1) socket.close(1011, "Fixture notification failed"); });
        const documents = new Map<string, TextDocument>(), syncFailures: string[] = [], syncCounts = new Map<string, { open: number; change: number; close: number }>(); let initializeCount = 0;
        const countSync = (uri: string, kind: "open" | "change" | "close") => { const counts = syncCounts.get(uri) ?? { open: 0, change: 0, close: 0 }; counts[kind]++; syncCounts.set(uri, counts); };
        const pending = new Set<() => void>(); let completionStyle = "edits", interactiveCompletion = false, hostProfile = false;
        let projectModuleUris: ReturnType<typeof moduleUris> = [];
        let definitionLinks = false, versionedEdits = false;
        let actionGeneration = 0, actionLiterals = false, actionResolve = false;
        const actionResolutions = new Map<number, { source: TextDocument; edit: WorkspaceEdit }>();
        const expireActions = (uri: string) => { for (const [id, action] of actionResolutions) if (action.source.uri === uri) actionResolutions.delete(id); };
        let projectRegistered = false, applyEditSupport = false, projectStyle: "markers" | "many" | "wide" = "markers", cancelApply: (() => void) | undefined;
        let registrationTail = Promise.resolve(), registrationsPending = 0;
        let lastCommand: unknown = null;
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
        const publish = (doc: TextDocument) => { void notify("textDocument/publishDiagnostics", { uri: doc.uri, version: doc.version, diagnostics: diagnosticItems(doc) }); };
        peer.onRequest(InitializeRequest.type, (params): InitializeResult => { initializeCount++; definitionLinks = params.capabilities.textDocument?.definition?.linkSupport === true;
            versionedEdits = params.capabilities.workspace?.workspaceEdit?.documentChanges === true;
            actionLiterals = params.capabilities.textDocument?.codeAction?.codeActionLiteralSupport !== undefined;
            actionResolve = params.capabilities.textDocument?.codeAction?.dataSupport === true && params.capabilities.textDocument.codeAction.resolveSupport?.properties.includes("edit") === true;
            applyEditSupport = params.capabilities.workspace?.applyEdit === true;
            hostProfile = params.initializationOptions?.fixtureHostProfile === true;
            projectModuleUris = moduleUris(params.initializationOptions?.fixtureModuleUris);
            return { capabilities: { positionEncoding: "utf-16", textDocumentSync: 2, definitionProvider: true, referencesProvider: true, documentHighlightProvider: true, renameProvider: true,
                codeActionProvider: { resolveProvider: true, codeActionKinds: ["quickfix", "refactor", "source"] }, executeCommandProvider: { commands: ["fixture.status"] },
                ...(hostProfile ? {} : { completionProvider: { triggerCharacters: ["."] } }), ...(params.initializationOptions?.fixtureDynamicLanguage ? {} : { signatureHelpProvider: { triggerCharacters: ["("], retriggerCharacters: [","] }, documentLinkProvider: { resolveProvider: true }, colorProvider: true }), hoverProvider: params.initializationOptions?.fixtureDynamic !== true }, serverInfo: { name: "Generic protocol fixture" } }; });
        peer.onNotification(InitializedNotification.type, () => { initialized = true; });
        const sync = (update: () => void) => { try { if (!initialized) throw new Error("Synchronization before initialized"); update(); } catch (error) { syncFailures.push(String(error)); } };
        peer.onNotification("textDocument/didOpen", (params: DidOpenTextDocumentParams) => sync(() => { const doc = params.textDocument;
            if (documents.has(doc.uri)) throw new Error("Duplicate open"); const opened = TextDocument.create(doc.uri, doc.languageId, doc.version, doc.text); documents.set(doc.uri, opened); countSync(doc.uri, "open"); publish(opened); }));
        peer.onNotification("textDocument/didChange", (params: DidChangeTextDocumentParams) => sync(() => {
            const before = documents.get(params.textDocument.uri); if (!before || params.textDocument.version <= before.version) throw new Error("Invalid change version");
            let text = before.getText(); for (const change of params.contentChanges) { if (!("range" in change)) throw new Error("Expected incremental changes");
                text = TextDocument.applyEdits(TextDocument.create(before.uri, before.languageId, before.version, text), [{ range: change.range, newText: change.text }]); }
            const changed = TextDocument.create(before.uri, before.languageId, params.textDocument.version, text); documents.set(before.uri, changed); expireActions(before.uri); countSync(before.uri, "change"); publish(changed);
        }));
        peer.onNotification("textDocument/didClose", (params: DidCloseTextDocumentParams) => sync(() => { if (!documents.delete(params.textDocument.uri)) throw new Error("Close without open"); expireActions(params.textDocument.uri); countSync(params.textDocument.uri, "close"); }));
        peer.onRequest("fixture/synchronization", () => ({ initialize: initializeCount, failures: [...syncFailures], documents: [...syncCounts].map(([uri, counts]) => ({ uri, ...counts, version: documents.get(uri)?.version ?? null })) }));
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
        peer.onRequest("textDocument/documentColor", (params: { textDocument: { uri: string }; _fixture?: unknown }, token) => {
            const doc = documents.get(params.textDocument.uri); if (!doc) throw new ResponseError(-32602, "Document not open");
            const config = requestPolicy(params._fixture, ["malformed", "failure", "incomplete", "markup"]);
            return deferred(config.delay, token, async () => {
                if (config.fault === "failure") throw new ResponseError(-32001, "Fixture colors unavailable"); const buffer = TextBuffer.from(doc.getText());
                const cursor = new DocumentColorsCursor({ id: 1, document: "source", revision: doc.version, length: buffer.length, delay: 0 }, buffer); let step = cursor.next();
                while (!step.result) { if (token.isCancellationRequested) throw new ResponseError(-32800, "Fixture colors cancelled"); await setImmediate(); step = cursor.next(); }
                if (step.result.truncated) throw new ResponseError(-32001, "Fixture color result limit exceeded");
                const colors = step.result.colors.map(item => ({ range: { start: doc.positionAt(item.from), end: doc.positionAt(item.to) }, color: item.color }));
                if (config.fault === "malformed") colors.push({ range: { start: doc.positionAt(0), end: { line: doc.lineCount + 1, character: 0 } }, color: { red: 2, green: 0, blue: 0, alpha: 1 } });
                return config.fault === "incomplete" ? { partial: colors } : colors;
            });
        });
        peer.onRequest("textDocument/colorPresentation", (params: { textDocument: { uri: string }; color: unknown; range: import("vscode-languageserver-protocol/node.js").Range; _fixture?: unknown }, token) => {
            const doc = documents.get(params.textDocument.uri); if (!doc) throw new ResponseError(-32602, "Document not open");
            const config = requestPolicy(params._fixture, ["malformed", "failure", "incomplete", "markup"]);
            return deferred(config.delay, token, () => {
                if (config.fault === "failure") throw new ResponseError(-32001, "Fixture presentations unavailable"); const color = validateRgba(params.color), hex = hexColor(color), rgba = rgbaColor(color);
                const choices: import("vscode-languageserver-protocol/node.js").ColorPresentation[] = [...hex ? [{ label: hex }] : [],
                    { label: config.fault === "markup" ? "<b>Literal color label</b>" : rgba, textEdit: { range: params.range, newText: rgba },
                        additionalTextEdits: [{ range: { start: doc.positionAt(0), end: doc.positionAt(0) }, newText: "// color presentation\r\n" }] }];
                if (config.fault === "malformed") choices.push({ label: "invalid final", textEdit: { range: { start: doc.positionAt(0), end: { line: doc.lineCount + 1, character: 0 } }, newText: "bad" } });
                return config.fault === "incomplete" ? { partial: choices } : choices;
            });
        });
        peer.onRequest("textDocument/documentLink", (params: { textDocument: { uri: string }; _fixture?: unknown }, token) => {
            const doc = documents.get(params.textDocument.uri); if (!doc) throw new ResponseError(-32602, "Document not open");
            const config = requestPolicy(params._fixture, ["malformed", "failure", "incomplete", "markup"]);
            const supplied = (params._fixture as { aliases?: unknown } | undefined)?.aliases, aliases = supplied === undefined ? projectModuleUris : moduleUris(supplied);
            return deferred(config.delay, token, async () => {
                if (config.fault === "failure") throw new ResponseError(-32001, "Fixture links unavailable"); const buffer = TextBuffer.from(doc.getText());
                const cursor = new ModuleLinksCursor({ id: 1, resource: "fixture", document: "source", revision: doc.version, length: buffer.length, aliases: [], delay: 0 }, buffer);
                let step = cursor.next(); while (!step.result) { if (token.isCancellationRequested) throw new ResponseError(-32800, "Fixture links cancelled"); await setImmediate(); step = cursor.next(); }
                if (step.result.truncated) throw new ResponseError(-32001, "Fixture link result limit exceeded");
                const links = step.result.links.map(link => ({ range: { start: doc.positionAt(link.from), end: doc.positionAt(link.to) }, tooltip: config.fault === "markup" ? "<b>Literal link tooltip</b>" : `Resolve ${link.module}`,
                    data: { uri: doc.uri, version: doc.version, module: link.module, target: aliases.find(alias => alias.module === link.module)?.uri ?? null } }));
                if (config.fault === "malformed") links.push({ range: { start: { line: 0, character: 0 }, end: { line: doc.lineCount + 1, character: 0 } }, tooltip: "Invalid final link", data: { uri: doc.uri, version: doc.version, module: "bad", target: null } });
                return config.fault === "incomplete" ? { partial: links } : links;
            });
        });
        peer.onRequest("documentLink/resolve", (params: { range: unknown; data: { uri: string; version: number; module: string; target: string | null }; _fixture?: unknown }, token) => {
            const { _fixture, ...link } = params, config = requestPolicy(_fixture, ["outside", "malformed"]);
            return deferred(config.delay, token, () => {
                const doc = documents.get(params.data?.uri); if (!doc || params.data.version !== doc.version) throw new ResponseError(-32801, "Fixture link expired");
                return { ...link, ...(config.fault === "malformed" ? { range: { start: { line: 0, character: 0 }, end: { line: doc.lineCount + 1, character: 0 } } } : {}),
                    ...(config.fault === "outside" ? { target: "host+fixture:outside-project" } : params.data.target ? { target: params.data.target } : {}), tooltip: `Resolved ${params.data.module}` };
            });
        });
        peer.onRequest("textDocument/signatureHelp", (params: { textDocument: { uri: string }; position: { line: number; character: number }; _fixture?: unknown }, token) => {
            const doc = documents.get(params.textDocument.uri); if (!doc) throw new ResponseError(-32602, "Document not open");
            const config = requestPolicy(params._fixture, ["malformed", "failure", "markup"]);
            return deferred(config.delay, token, async () => {
                if (config.fault === "failure") throw new ResponseError(-32001, "Fixture signature unavailable");
                const text = doc.getText(), offset = doc.offsetAt(params.position), scanner = new SignatureScanner();
                for (let from = 0; from < offset; from += 16384) { if (token.isCancellationRequested) throw new ResponseError(-32800, "Fixture signature cancelled"); scanner.feed(text.slice(from, Math.min(offset, from + 16384)), from); await setImmediate(); }
                const result = scanner.result({ id: 1, document: doc.uri, revision: doc.version, length: text.length, offset, delay: 0 });
                return { activeSignature: result.activeSignature, activeParameter: result.call?.argument ?? 0, signatures: [
                    ...result.signatures.map(item => ({ label: item.label, documentation: config.fault === "markup" ? "<b>Literal signature documentation</b>" : item.documentation,
                        parameters: item.parameters.map(parameter => ({ label: [parameter.from, parameter.to], documentation: parameter.documentation })) })),
                    ...config.fault === "malformed" ? [{ label: 7 }] : []] };
            });
        });
        peer.onRequest("textDocument/hover", (params: { textDocument: { uri: string }; position: { line: number; character: number }; _fixture?: unknown }, token) => {
            const doc = documents.get(params.textDocument.uri); if (!doc) throw new ResponseError(-32602, "Document not open");
            if (params._fixture === undefined) return { contents: { kind: "plaintext", value: `Fixture ${params.textDocument.uri}:${params.position.line}:${params.position.character}` } };
            const config = requestPolicy(params._fixture, ["malformed", "failure", "markup"]);
            return deferred(config.delay, token, () => {
                if (config.fault === "failure") throw new ResponseError(-32001, "Fixture hover unavailable");
                if (config.fault === "malformed") return { contents: ["valid prefix", { language: "fixture", value: 42 }] };
                if (config.fault === "markup") return { contents: { kind: "markdown", value: '<img src="x" onerror="hoverExecuted=1"> **literal information**' } };
                const symbol = symbolAt(doc, params.position); if (!symbol.result.range) return null;
                return { contents: [{ language: "fixture", value: symbol.text.slice(symbol.from + symbol.result.range.from, symbol.from + symbol.result.range.to) }, symbol.result.text], range: symbol.range };
            });
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
        peer.onRequest("textDocument/documentHighlight", async (params: { textDocument: { uri: string }; position: { line: number; character: number } }, token) => {
            const doc = documents.get(params.textDocument.uri); if (!doc) throw new ResponseError(-32602, "Document not open");
            const symbol = symbolAt(doc, params.position); if (!symbol.result.range) return [];
            const name = symbol.text.slice(symbol.from + symbol.result.range.from, symbol.from + symbol.result.range.to);
            // The lexical fixture proves document-local protocol shape, not read/write semantics.
            return (await scanLocations([doc], name, "references", true, token)).map(location => ({ range: location.range, kind: 1 }));
        });
        peer.onRequest("textDocument/rename", (params: { textDocument: { uri: string }; position: { line: number; character: number }; newName: string; _fixture?: unknown }, token) => {
            const origin = documents.get(params.textDocument.uri); if (!origin || typeof params.newName !== "string" || !renameName(params.newName)) throw new ResponseError(-32602, "Fixture rename needs an open source and a supported new identifier");
            const config = requestPolicy(params._fixture, ["malformed", "failure"]), project = [...documents.values()];
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
        for (const kind of ["definition", "references"] as const) peer.onRequest(`textDocument/${kind}`, (params: { textDocument: { uri: string }; position: { line: number; character: number }; context?: { includeDeclaration: boolean }; _fixture?: unknown }, token) => {
            const origin = documents.get(params.textDocument.uri); if (!origin) throw new ResponseError(-32602, "Document not open");
            if (kind === "references" && typeof params.context?.includeDeclaration !== "boolean") throw new ResponseError(-32602, "References require declaration context");
            const config = requestPolicy(params._fixture, ["malformed", "failure"]), project = [...documents.values()];
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
        const workspaceTextEdits = (project: readonly TextDocument[], changes: ReadonlyMap<string, readonly TextEdit[]>): WorkspaceEdit => versionedEdits
            ? { documentChanges: [...changes].map(([uri, edits]) => ({ textDocument: { uri, version: project.find(doc => doc.uri === uri)?.version ?? null }, edits: [...edits] })) }
            : { changes: Object.fromEntries([...changes].map(([uri, edits]) => [uri, [...edits]])) };
        peer.onRequest("fixture/reviewRegistration", (params: { registered: boolean; _fixture?: unknown }, token) => {
            if (typeof params?.registered !== "boolean") throw new ResponseError(-32602, "Invalid review registration");
            const config = requestPolicy(params._fixture, ["malformed", "failure", "ack"]), registered = params.registered;
            if (registered && !applyEditSupport) throw new ResponseError(-32601, "Review needs an edit-review capable client");
            if (registrationsPending >= 64) throw new ResponseError(-32000, "Too many pending review registrations");
            registrationsPending++;
            const result = registrationTail.then(async () => {
                if (socket.readyState !== 1) throw new ResponseError(-32800, "Fixture registration cancelled");
                await deferred(config.delay, token, () => null);
                if (token.isCancellationRequested) throw new ResponseError(-32800, "Fixture registration cancelled");
                if (config.fault === "failure") throw new ResponseError(-32001, "Fixture registration unavailable");
                // Once dispatched, retain this transition until its acknowledgement even if
                // the initiating request is cancelled. The next owner must see the actual state.
                if (projectRegistered !== registered) {
                    if (registered) await peer.sendRequest(RegistrationRequest.type, { registrations: [{ id: "fixture-review", method: "workspace/executeCommand", registerOptions: { commands: ["fixture.review"] } }] });
                    else await peer.sendRequest(UnregistrationRequest.type, { unregisterations: [{ id: "fixture-review", method: "workspace/executeCommand" }] });
                    projectRegistered = registered;
                }
                return { registered: projectRegistered };
            });
            registrationTail = result.then(() => { registrationsPending--; }, () => { registrationsPending--; });
            return result;
        });
        peer.onRequest("fixture/projectStyle", (params: { style: typeof projectStyle }) => { if (!params || !["markers", "many", "wide"].includes(params.style)) throw new ResponseError(-32602, "Invalid review style"); projectStyle = params.style; return null; });
        peer.onNotification("fixture/cancelApply", () => cancelApply?.());
        peer.onRequest("fixture/lastCommand", () => lastCommand);
        peer.onRequest("workspace/executeCommand", (params: { command: string; arguments?: unknown[]; _fixture?: unknown }, token) => {
            if (!["fixture.status", "fixture.review", "fixture.unadvertised"].includes(params?.command)) throw new ResponseError(-32602, "Unknown fixture command");
            const argument = params.arguments?.[0];
            const policy = params.command === "fixture.review" && argument && typeof argument === "object" && "reviewPolicy" in argument
                ? argument.reviewPolicy : params._fixture;
            const config = requestPolicy(policy, ["malformed", "failure", "ack"]), project = [...documents.values()], style = projectStyle;
            lastCommand = { command: params.command, arguments: params.arguments ?? [], documents: project.map(doc => ({ uri: doc.uri, version: doc.version, prefix: doc.getText().slice(0, 64) })) };
            return deferred(config.delay, token, async () => {
                if (config.fault === "failure") throw new ResponseError(-32001, "Fixture provider command unavailable");
                if (params.command === "fixture.status") { if (config.fault === "ack") port.dispose(); return { documents: documents.size }; }
                if ((params.command === "fixture.review" && !projectRegistered) || !applyEditSupport) throw new ResponseError(-32601, "Review command needs authority and an edit-review capable client");
                const argument = params.arguments?.[0] as { uri?: string; expectedPrefix?: string } | undefined;
                if (argument?.expectedPrefix && !project.find(doc => doc.uri === argument.uri)?.getText().startsWith(argument.expectedPrefix)) throw new ResponseError(-32602, "The action edit was not synchronized before its command");
                const changes = new Map<string, TextEdit[]>(); let count = 0;
                for (const doc of project) {
                    const text = doc.getText(), edits: TextEdit[] = [];
                    if (style === "wide") edits.push({ range: { start: doc.positionAt(0), end: doc.positionAt(text.length) }, newText: "// provider rewritten\r\n" });
                    else {
                        if (!text.startsWith(reviewHeader) || !text.endsWith(reviewFooter)) edits.push({ range: { start: doc.positionAt(0), end: doc.positionAt(0) }, newText: reviewHeader }, { range: { start: doc.positionAt(text.length), end: doc.positionAt(text.length) }, newText: reviewFooter });
                        if (style === "many") { let at = -1; while ((at = text.indexOf("TODO", at + 1)) >= 0) { if (edits.length === 1024) throw new ResponseError(-32000, "Fixture review edit limit exceeded"); edits.push({ range: { start: doc.positionAt(at), end: doc.positionAt(at + 4) }, newText: "DONE" }); } }
                    }
                    if ((count += edits.length) > 1024) throw new ResponseError(-32000, "Fixture review edit limit exceeded"); if (edits.length) changes.set(doc.uri, edits);
                }
                if (config.fault === "malformed") changes.set("host+fixture:unknown-target", [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "invalid final target" }]);
                const cancellation = new CancellationTokenSource(), cancel = () => cancellation.cancel(), stop = token.onCancellationRequested(cancel); cancelApply = cancel;
                try {
                    const outcome = await peer.sendRequest<ApplyWorkspaceEditResult>("workspace/applyEdit", { label: "Review captured working resources", edit: workspaceTextEdits(project, changes) }, cancellation.token);
                    if (config.fault === "ack" && outcome.applied) port.dispose(); return outcome;
                } catch (error) { if (cancellation.token.isCancellationRequested) return { applied: false, failureReason: "Provider edit request cancelled." }; throw error; }
                finally { if (cancelApply === cancel) cancelApply = undefined; stop.dispose(); cancellation.dispose(); }
            });
        });
        peer.onRequest("textDocument/codeAction", (params: { textDocument: { uri: string }; range: Location["range"]; context: { diagnostics: unknown[]; triggerKind?: number }; _fixture?: unknown }, token) => {
            const origin = documents.get(params.textDocument.uri); if (!origin || !Array.isArray(params.context?.diagnostics)) throw new ResponseError(-32602, "Code actions need captured context");
            const config = requestPolicy(params._fixture, ["malformed", "failure", "incomplete", "markup"]), project = [...documents.values()], generation = ++actionGeneration;
            const supplied = (params._fixture as { module?: unknown } | undefined)?.module, module = supplied === undefined ? "sample-utils" : supplied;
            if (typeof module !== "string" || !validDomainModule(module)) throw new ResponseError(-32602, "Invalid action module");
            return deferred(config.delay, token, async (): Promise<(CodeAction | Command)[]> => {
                if (config.fault === "failure") throw new ResponseError(-32001, "Fixture actions unavailable");
                const status = { title: "Provider status command", command: "fixture.status", arguments: [] };
                if (!actionLiterals) return [status];
                const text = origin.getText(), cursor = new ModuleActionCursor({ operation: "action-start", id: 1, document: origin.uri, revision: origin.version, length: text.length, from: origin.offsetAt(params.range.start), to: origin.offsetAt(params.range.end), module, delay: 0 }, TextBuffer.from(text));
                let step = cursor.next(), turn = 0; while (!step.result) { if (token.isCancellationRequested) throw new ResponseError(-32800, "Fixture action cancelled"); if (++turn % 4 === 0) await setImmediate(); step = cursor.next(); }
                const found = step.result.action, importEdit = workspaceTextEdits(project, new Map([[origin.uri, found.edits.flatMap(change => [...change.edits].map(edit => ({ range: { start: origin.positionAt(edit.from), end: origin.positionAt(edit.to) }, newText: edit.insert })))]]));
                const marker = "// fixture action\r\n", changes = new Map(project.filter(doc => !doc.getText().startsWith(marker)).map(doc => [doc.uri, [{ range: { start: doc.positionAt(0), end: doc.positionAt(0) }, newText: marker }]]));
                const reviewEdit = workspaceTextEdits(project, changes), todoEdits: TextEdit[] = []; let todo = -1;
                while ((todo = text.indexOf("TODO", todo + 1)) >= 0) { if (todoEdits.length === 1024) throw new ResponseError(-32000, "Fixture TODO action exceeds its edit limit"); todoEdits.push({ range: { start: origin.positionAt(todo), end: origin.positionAt(todo + 4) }, newText: "DONE" }); }
                const lazyEdit = todoEdits.length ? workspaceTextEdits(project, new Map([[origin.uri, todoEdits]])) : importEdit;
                if (token.isCancellationRequested || socket.readyState !== 1) throw new ResponseError(-32800, "Fixture action cancelled");
                if (documents.get(origin.uri) !== origin) throw new ResponseError(-32801, "Fixture action source changed");
                // Keep earlier valid offers resolvable. At capacity, new offers carry their
                // already-computed edits eagerly; rejected response shapes retain no entries.
                const lazy = actionResolve && actionResolutions.size < 64 && config.fault !== "malformed" && config.fault !== "incomplete";
                if (lazy) actionResolutions.set(generation, { source: origin, edit: lazyEdit });
                const actions: (CodeAction | Command)[] = [{ title: config.fault === "markup" ? '<img src=x onerror="actionExecuted=1">' : found.title, kind: "source.addImport", isPreferred: true, ...(found.disabled ? { disabled: { reason: found.disabled } } : {}), edit: importEdit },
                    { title: "Add review markers across captured resources", kind: "refactor.rewrite", edit: reviewEdit, ...(changes.size ? {} : { disabled: { reason: "All captured sources already have review markers." } }) },
                    { title: todoEdits.length ? "Load TODO fixes preview" : "Load alternate import preview", kind: todoEdits.length ? "source.fixAll" : "source.addImport", ...(lazy ? { data: { token: generation, opaque: { label: "captured", uri: origin.uri } } } : { edit: lazyEdit }) },
                    { title: "Unavailable context example", kind: "refactor", disabled: { reason: "The fixture requires another context." } }, status,
                    { title: "Edit then provider command", kind: "source", edit: reviewEdit, command: status },
                    { title: "Review provider edits command", command: "fixture.review", arguments: [{ uri: origin.uri, opaque: { note: "😀" } }] },
                    { title: "Edit then provider review command", kind: "source", edit: reviewEdit, command: { title: "Review provider edits", command: "fixture.review", arguments: [{ uri: origin.uri, expectedPrefix: marker, opaque: { note: "😀" } }] } },
                    { title: "Unadvertised provider command", kind: "source", edit: reviewEdit, command: { title: "Host-authorized review", command: "fixture.unadvertised", arguments: [{ uri: origin.uri, expectedPrefix: marker }] } }];
                if (config.fault === "malformed") actions.push({ title: "Invalid final choice", edit: workspaceTextEdits(project, new Map([["host+fixture:unknown-target", [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "bad" }]]])) });
                if (config.fault === "incomplete") return { partial: actions } as unknown as (CodeAction | Command)[];
                return actions;
            });
        });
        peer.onRequest("codeAction/resolve", (params: CodeAction & { _fixture?: unknown }, token) => {
            const { _fixture, ...action } = params, config = requestPolicy(_fixture, ["malformed", "failure", "incomplete", "markup"]);
            return deferred(config.delay, token, () => {
                if (config.fault === "failure") throw new ResponseError(-32001, "Fixture action resolution unavailable");
                const retained = actionResolutions.get(params.data?.token);
                if (!retained || documents.get(retained.source.uri) !== retained.source) throw new ResponseError(-32602, "Unknown captured action");
                const edit = retained.edit;
                if (config.fault === "incomplete") return action;
                if (config.fault === "markup") return { ...action, title: "Changed during resolve", edit };
                if (config.fault === "malformed") return { ...action, edit: { ...edit, documentChanges: [...edit.documentChanges ?? [], { textDocument: { uri: "host+fixture:unknown-target", version: null }, edits: [] }] } };
                return { ...action, edit };
            });
        });
        peer.onRequest("fixture/completionStyle", async (params: { style: string }) => {
            if (!params || !["edits", "defaults", "plain", "interactive", "incomplete"].includes(params.style)) throw new ResponseError(-32602, "Invalid completion style");
            const interactive = params.style === "interactive" || params.style === "incomplete";
            if (interactive && !interactiveCompletion) await peer.sendRequest(RegistrationRequest.type, { registrations: [{ id: "fixture-completion", method: "textDocument/completion",
                registerOptions: { documentSelector: hostProfile ? [{ scheme: "host+fixture", language: "fixture" }] : null,
                    resolveProvider: true, triggerCharacters: hostProfile ? [".", " "] : ["."], allCommitCharacters: [";"] } }] });
            if (!interactive && interactiveCompletion) await peer.sendRequest(UnregistrationRequest.type, { unregisterations: [{ id: "fixture-completion", method: "textDocument/completion" }] });
            interactiveCompletion = interactive; completionStyle = params.style; return null;
        });
        peer.onRequest("completionItem/resolve", (params: CompletionList["items"][number], token) => {
            return deferred(0, token, () => {
                const data = params.data as { uri?: string; import?: boolean } | undefined, doc = data?.uri ? documents.get(data.uri) : undefined;
                if (!doc) throw new ResponseError(-32602, "Completion resolve document unavailable");
                const additionalTextEdits = data?.import ? [{ range: { start: doc.positionAt(0), end: doc.positionAt(0) }, newText: "// resolved import\r\n" }] : [];
                return { ...params, detail: `Resolved ${params.label}`, documentation: "<b>Literal completion detail</b>", additionalTextEdits };
            });
        });
        peer.onRequest("fixture/diagnostics", (params: { uri: string; mode: "normal" | "malformed" | "out-of-bounds" | "stale" | "unversioned" | "clear" | "html" }) => {
            if (!params || typeof params.uri !== "string" || !["normal", "malformed", "out-of-bounds", "stale", "unversioned", "clear", "html"].includes(params.mode)) throw new ResponseError(-32602, "Diagnostics require a document URI and valid mode");
            const doc = documents.get(params.uri); if (!doc) throw new ResponseError(-32602, "Diagnostic document is not open");
            const diagnostics = params.mode === "clear" ? [] : diagnosticItems(doc);
            if (params.mode === "malformed") diagnostics.push({ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 0 } }, message: "Invalid final diagnostic", severity: 2 });
            if (params.mode === "out-of-bounds") diagnostics.push({ range: { start: { line: doc.lineCount + 10, character: 0 }, end: { line: doc.lineCount + 10, character: 1 } }, message: "Unplaceable diagnostic", severity: 2 });
            if (params.mode === "html") diagnostics.push({ range: { start: doc.positionAt(0), end: doc.positionAt(0) }, message: "<img src=x onerror=unsafe()>", severity: 2 });
            return notify("textDocument/publishDiagnostics", { uri: doc.uri, ...(params.mode === "unversioned" ? {} : { version: params.mode === "stale" ? doc.version - 1 : doc.version }), diagnostics }).then(() => ({ version: doc.version }));
        });
        peer.onRequest("textDocument/completion", (params: { textDocument: { uri: string }; position: { line: number; character: number }; context?: { triggerKind?: number }; _fixture?: unknown }, token) => {
            const doc = documents.get(params.textDocument.uri); if (!doc) throw new ResponseError(-32602, "Document not open");
            const config = requestPolicy(params._fixture, ["malformed", "failure"]), style = completionStyle;
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
                    if (style === "interactive" || style === "incomplete") {
                        resolve({ isIncomplete: style === "incomplete" && params.context?.triggerKind !== 3, itemDefaults: { commitCharacters: [";"], data: { uri: doc.uri } }, items: [
                            { label: "Displayed sibling", filterText: "sibling", sortText: "00", preselect: true, textEdit: { newText: "sibling", insert, replace } },
                            ...items.map(({ additionalTextEdits: _additional, ...item }, index) => ({ ...item, filterText: index ? "sampleValue" : "sample", sortText: index ? "20" : "10", data: { uri: doc.uri, import: index === 1 } })),
                            ...(hostProfile ? [{ label: "sampleSnippet", insertTextFormat: 2 as const, textEdit: { newText: "sample(${1:value})$0", insert, replace }, data: { uri: doc.uri, import: true } }] : [])] }); return;
                    }
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
        peer.onRequest("fixture/notice", (params: unknown) => notify("fixture/notice", params).then(() => null));
        peer.onRequest("fixture/state", () => ({ held, initialized }));
        peer.onRequest("fixture/fail", () => { throw new ResponseError(-32001, "Fixture rejection", { retryable: true }); });
        peer.onRequest("fixture/hold", (_params: unknown, token) => new Promise((_resolve, reject) => {
            held++; const stop = token.onCancellationRequested(() => { held--; stop.dispose(); reject(new ResponseError(-32800, "Fixture cancelled")); });
        }));
        peer.onNotification("fixture/disconnect", () => port.dispose());
        peer.onNotification("fixture/binary", () => socket.send(Buffer.from("{}"), { binary: true }));
        peer.listen();
        const dispose = () => { for (const cancel of [...pending]) cancel(); actionResolutions.clear(); peer.dispose(); socket.terminate(); }; release.add(dispose);
        socket.on("close", () => { for (const cancel of [...pending]) cancel(); actionResolutions.clear(); const listener = owner; owner = undefined; listener?.close(new Error("Fixture socket closed")); peer.dispose(); release.delete(dispose); });
    });
    return () => { server.off("upgrade", onUpgrade); for (const dispose of [...release]) dispose(); release.clear(); sockets.close(); };
}
