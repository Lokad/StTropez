import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { StreamMessageReader, StreamMessageWriter, TextDocument } from "vscode-languageserver-protocol/node.js";
import type { Message, DidOpenTextDocumentParams, DidChangeTextDocumentParams, Diagnostic, Range } from "vscode-languageserver-protocol/node.js";
import { URI } from "vscode-uri";
import { demoSample, sampleChoices } from "./samples.ts";
import type { SampleId } from "./samples.ts";

const compiler = fileURLToPath(import.meta.resolve("typescript-demo/lib/tsserver.js"));
const executable = fileURLToPath(new URL("lib/cli.mjs", import.meta.resolve("typescript-language-server/package.json")));
const initializationOptions = Object.freeze({ disableAutomaticTypingAcquisition: true, maxTsServerMemory: 512,
    tsserver: { path: compiler, useSyntaxServer: "never", logVerbosity: "off" } });
type Document = Readonly<{ uri: string; path: string }>;
type Project = { id: string; directory: string; rootUri: string; documents: Record<string, Document>; idle: NodeJS.Timeout | undefined;
    connection: WebSocket | undefined; stopping: Promise<void>; stopProcess: (() => Promise<void>) | undefined; removed: boolean };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function sameOrigin(request: IncomingMessage): boolean {
    if (!request.headers.origin) return true;
    try { const origin = new URL(request.headers.origin); return origin.protocol === "http:" && origin.host === request.headers.host; } catch { return false; }
}
function json(response: ServerResponse, code: number, value: unknown): void {
    const bytes = Buffer.from(JSON.stringify(value)); response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": bytes.length }); response.end(bytes);
}
function confined(value: unknown, project: Project, depth = 0): boolean {
    if (depth > 40) return false;
    if (Array.isArray(value)) return value.every(item => confined(item, project, depth + 1));
    if (!object(value)) return true;
    return Object.entries(value).every(([key, item]) => {
        if (["uri", "targetUri", "oldUri", "newUri"].includes(key)) return typeof item === "string" && Object.values(project.documents).some(doc => doc.uri === item);
        if (["file", "fileName", "filePath"].includes(key)) return knownPath(item, project);
        return confined(item, project, depth + 1);
    });
}
function knownPath(value: unknown, project: Project): boolean {
    const key = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    return typeof value === "string" && isAbsolute(value) && Object.values(project.documents).some(doc => key(doc.path) === key(value));
}

/** Demo-only process/transport host. Production modules never import Node, a server or a compiler. */
export function attachDemoProvider(server: Server) {
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 });
    const projects = new Map<string, Project>(), removals = new Set<Promise<void>>(), requests = new Set<Promise<boolean>>();
    let closing = false, processes = 0;
    async function remove(project: Project): Promise<void> {
        if (project.removed) { await project.stopping; return; }
        project.removed = true; projects.delete(project.id); if (project.idle) clearTimeout(project.idle);
        project.connection?.terminate(); await project.stopProcess?.(); await project.stopping;
        // Only an allocated direct child of the OS temp directory may be recursively removed.
        const target = resolve(project.directory);
        if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("sttropez-demo-")) throw new Error("Unexpected demo workspace cleanup target.");
        await rm(target, { recursive: true, force: true });
    }
    function retire(project: Project): Promise<void> {
        const work = remove(project); removals.add(work); void work.finally(() => removals.delete(work)).catch(() => {}); return work;
    }
    function idle(project: Project): void {
        if (project.removed || closing) return;
        if (project.idle) clearTimeout(project.idle);
        project.idle = setTimeout(() => { void retire(project).catch(() => {}); }, 120_000); project.idle.unref();
    }
    function connect(project: Project, socket: WebSocket): void {
        project.connection = socket; if (project.idle) clearTimeout(project.idle); project.idle = undefined;
        const child = spawn(process.execPath, [executable, "--stdio"], { cwd: project.directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        processes++; let stopped = false, closed = false, writeQueue = Promise.resolve();
        const reader = new StreamMessageReader(child.stdout), writer = new StreamMessageWriter(child.stdin);
        const shutdownId = "sttropez-demo-shutdown";
        const resolving = new Map<string | number, Readonly<{ data: unknown; present: boolean }>>();
        const completing = new Map<string | number, Readonly<{ line: number; character: number }>>();
        const documents = new Map<string, TextDocument>();
        type Problem = Readonly<{ from: number; to: number; wire: Diagnostic }>;
        type Kind = "semantic" | "syntactic";
        const diagnosing = new Map<string | number, Readonly<{ document: TextDocument; project: readonly TextDocument[]; kind: Kind }>>(), acting = new Set<string | number>();
        const problems = new Map<string, { document: TextDocument; semantic?: readonly Problem[]; syntactic?: readonly Problem[] }>();
        let finish!: () => void, force: NodeJS.Timeout | undefined;
        const terminal = new Promise<void>(resolve => { finish = resolve; });
        const send = (value: unknown) => {
            writeQueue = writeQueue.then(() => writer.write(value as Message));
            void writeQueue.catch(() => { socket.terminate(); }); return writeQueue;
        };
        const stop = () => {
            if (closed) return terminal;
            if (!stopped) {
                stopped = true;
                void send({ jsonrpc: "2.0", id: shutdownId, method: "shutdown" }).catch(() => {});
                force = setTimeout(() => {
                    if (closed) return;
                    if (process.platform === "win32" && child.pid) {
                        // Fallback targets only this still-owned child's process tree.
                        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); killer.on("error", () => child.kill());
                    } else child.kill();
                }, 3000);
            }
            return terminal;
        };
        project.stopProcess = stop;
        const subscription = reader.listen(message => {
            const value = message as unknown as Record<string, unknown>;
            if (value.id === shutdownId) { void send({ jsonrpc: "2.0", method: "exit" }).then(() => child.stdin.end()).catch(() => {}); return; }
            if (typeof value.id === "string" || typeof value.id === "number") {
                const diagnostic = diagnosing.get(value.id); diagnosing.delete(value.id);
                // Correlate read-command results with the actual mirrored document, never a later
                // version or the provider's unversioned diagnostic pushes.
                if (diagnostic && diagnostic.project.length === documents.size && diagnostic.project.every(doc => documents.get(doc.uri) === doc)) {
                    const doc = diagnostic.document, previous = problems.get(doc.uri); if (previous) delete previous[diagnostic.kind];
                    if (object(value.result) && value.result.success === true && Array.isArray(value.result.body)) {
                        const batch: Problem[] = [];
                        for (const item of value.result.body.slice(0, 256)) {
                            if (!object(item) || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.length) || !Number.isSafeInteger(item.code) || typeof item.message !== "string") break;
                            const from = item.start as number, to = from + (item.length as number);
                            if (from < 0 || to < from || to > doc.getText().length || item.message.length > 4096) break;
                            batch.push({ from, to, wire: { range: { start: doc.positionAt(from), end: doc.positionAt(to) }, message: item.message, code: item.code as number,
                                severity: item.category === "warning" ? 2 : 1, source: "typescript" } });
                        }
                        if (batch.length === Math.min(256, value.result.body.length)) {
                            const cached = problems.get(doc.uri) ?? { document: doc }; cached[diagnostic.kind] = batch; problems.set(doc.uri, cached);
                        }
                    }
                }
                if (acting.delete(value.id) && Array.isArray(value.result)) value.result = value.result.map(action => {
                    if (!object(action) || !object(action.edit) || !object(action.command) || action.command.command !== "_typescript.applyCodeActionCommand"
                        || action.command.title !== "" || !Array.isArray(action.command.arguments) || action.command.arguments.length !== 1) return action;
                    const argument = action.command.arguments[0]; if (!object(argument) || !object(argument.action)) return action;
                    const commands = argument.action.commands;
                    if (commands !== undefined && (!Array.isArray(commands) || commands.length !== 0)) return action;
                    // The pinned provider adds this empty-title no-op to pure quick fixes. No
                    // provider command is executed; its edit still passes the generic decoder.
                    const { command: _noOp, ...pure } = action; return pure;
                });
                const original = resolving.get(value.id); resolving.delete(value.id);
                // This pinned provider replaces its cache key during resolve. Keep opaque client data
                // stable; all edits, labels and behavior-bearing fields still reach strict decoding.
                if (original && object(value.result)) { if (original.present) value.result.data = original.data; else delete value.result.data; }
                const position = completing.get(value.id); completing.delete(value.id);
                if (position && object(value.result) && Array.isArray(value.result.items)) {
                    // The pinned server can return a computed-property candidate that only replaces
                    // the earlier dot, outside a later typed prefix. Such a range cannot satisfy the
                    // LSP completion contract at this caret. Retain the valid candidates unchanged.
                    value.result.items = value.result.items.filter(item => {
                        if (!object(item) || !object(item.textEdit) || !object(item.textEdit.range)) return true;
                        const range = item.textEdit.range;
                        if (!object(range.start) || !object(range.end) || typeof range.start.line !== "number" || typeof range.end.line !== "number"
                            || typeof range.start.character !== "number" || typeof range.end.character !== "number") return true;
                        return (range.start.line < position.line || range.start.line === position.line && range.start.character <= position.character)
                            && (range.end.line > position.line || range.end.line === position.line && range.end.character >= position.character);
                    });
                }
            }
            if (!stopped && socket.readyState === 1) socket.send(JSON.stringify(message));
        });
        child.stderr.resume();
        child.on("error", () => { socket.terminate(); child.stdin.destroy(); });
        child.on("close", () => {
            closed = true; if (force) clearTimeout(force); subscription.dispose(); reader.dispose(); writer.dispose(); processes--;
            if (project.connection === socket) { project.connection = undefined; project.stopProcess = undefined; idle(project); }
            socket.terminate(); finish();
        });
        const reject = (id: unknown, text: string) => {
            if ((typeof id === "number" || typeof id === "string") && socket.readyState === 1) socket.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: text } }));
        };
        socket.on("message", (bytes, binary) => {
            if (stopped || binary) { socket.terminate(); return; }
            let message: unknown; try { message = JSON.parse(bytes.toString()); } catch { socket.close(1003, "Expected JSON-RPC text"); return; }
            if (!object(message) || message.jsonrpc !== "2.0") { socket.close(1003, "Expected JSON-RPC message"); return; }
            if (message.method === "initialize") {
                if (!object(message.params)) { reject(message.id, "Expected initialization parameters."); return; }
                message.params = { ...message.params, rootUri: project.rootUri, rootPath: project.directory,
                    workspaceFolders: [{ uri: project.rootUri, name: "Demo project" }], initializationOptions };
            } else if (!confined(message.params, project)) { reject(message.id, "Only this demo project's documents are available."); return; }
            if (message.method === "sttropez/diagnostics") {
                const params = message.params;
                const document = object(params) && Object.values(project.documents).find(doc => doc.uri === params.uri);
                const kind = object(params) ? params.kind : undefined;
                if (!document || kind !== "semantic" && kind !== "syntactic") { reject(message.id, "Expected a captured demo diagnostic request."); return; }
                const captured = documents.get(document.uri);
                if (!captured || diagnosing.size >= 128 || typeof message.id !== "string" && typeof message.id !== "number") { reject(message.id, "Expected an open document and a bounded diagnostic request."); return; }
                diagnosing.set(message.id, { document: captured, project: [...documents.values()], kind });
                message.method = "workspace/executeCommand";
                message.params = { command: "typescript.tsserverRequest", arguments: [kind === "semantic" ? "semanticDiagnosticsSync" : "syntacticDiagnosticsSync", { file: document.path }, {}] };
            }
            if (message.method === "workspace/didChangeWorkspaceFolders" || message.method === "workspace/didChangeConfiguration") { reject(message.id, "The demo owns project configuration."); return; }
            try {
                if (message.method === "textDocument/didOpen") {
                    const doc = (message.params as DidOpenTextDocumentParams).textDocument;
                    problems.clear();
                    documents.set(doc.uri, TextDocument.create(doc.uri, doc.languageId, doc.version, doc.text));
                } else if (message.method === "textDocument/didChange") {
                    const params = message.params as DidChangeTextDocumentParams, before = documents.get(params.textDocument.uri);
                    if (!before) throw new Error("Document not open."); let text = before.getText();
                    for (const change of params.contentChanges) text = "range" in change
                        ? TextDocument.applyEdits(TextDocument.create(before.uri, before.languageId, before.version, text), [{ range: change.range, newText: change.text }]) : change.text;
                    documents.set(before.uri, TextDocument.create(before.uri, before.languageId, params.textDocument.version, text));
                    problems.clear();
                } else if (message.method === "textDocument/didClose" && object(message.params) && object(message.params.textDocument)) {
                    const uri = String(message.params.textDocument.uri); documents.delete(uri); problems.clear();
                }
            } catch { socket.close(1003, "Invalid demo document synchronization"); return; }
            if (message.method === "completionItem/resolve" && object(message.params) && (typeof message.id === "number" || typeof message.id === "string")) {
                if (resolving.size >= 128) { reject(message.id, "Too many pending completion resolutions."); return; }
                resolving.set(message.id, { data: message.params.data, present: Object.hasOwn(message.params, "data") });
            }
            if (message.method === "textDocument/codeAction") {
                const params = message.params, doc = object(params) && object(params.textDocument) && documents.get(String(params.textDocument.uri));
                const cached = doc ? problems.get(doc.uri) : undefined;
                if (!doc || cached?.document !== doc || !cached.semantic || !cached.syntactic || !object(params) || !object(params.range)
                    || typeof message.id !== "string" && typeof message.id !== "number" || acting.size >= 128) { reject(message.id, "Request current captured diagnostics before quick fixes."); return; }
                const range = params.range as unknown as Range;
                if (!range.start || !range.end || ![range.start.line, range.start.character, range.end.line, range.end.character].every(n => Number.isSafeInteger(n) && n >= 0)) { reject(message.id, "Expected a diagnostic range."); return; }
                const from = doc.offsetAt(range.start), to = doc.offsetAt(range.end);
                if (to < from) { reject(message.id, "Expected an ordered diagnostic range."); return; }
                const overlapping = [...cached.syntactic, ...cached.semantic].filter(item => from === to ? item.from <= from && item.to >= to
                    : item.from === item.to ? from <= item.from && item.from <= to : item.from < to && item.to > from).slice(0, 256);
                params.context = { triggerKind: 1, only: ["quickfix"], diagnostics: overlapping.map(item => item.wire) }; acting.add(message.id);
            }
            if (message.method === "textDocument/completion" && object(message.params) && object(message.params.position)
                && typeof message.params.position.line === "number" && typeof message.params.position.character === "number" && (typeof message.id === "number" || typeof message.id === "string")) {
                if (completing.size >= 128) { reject(message.id, "Too many pending completion lists."); return; }
                const { line, character } = message.params.position;
                completing.set(message.id, { line, character });
            }
            if (message.method === "$/cancelRequest" && object(message.params) && (typeof message.params.id === "number" || typeof message.params.id === "string")) {
                resolving.delete(message.params.id); completing.delete(message.params.id); diagnosing.delete(message.params.id); acting.delete(message.params.id);
            }
            if (message.method === "workspace/executeCommand") {
                const params = message.params;
                const args = object(params) ? params.arguments : undefined;
                if (!object(params) || params.command !== "typescript.tsserverRequest" || !Array.isArray(args)
                    || !["semanticDiagnosticsSync", "syntacticDiagnosticsSync", "suggestionDiagnosticsSync"].includes(String(args[0]))
                    || !object(args[1]) || !knownPath(args[1].file, project)) {
                    reject(message.id, "This demo supports captured diagnostic commands only."); return;
                }
                params.arguments = [args[0], { file: args[1].file, includeLinePosition: true }, { expectsResult: true, isAsync: false }];
            }
            void send(message).catch(() => {});
        });
        socket.on("error", () => { void stop(); });
        socket.on("close", () => { project.stopping = stop(); });
    }
    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const match = /^\/demo-provider\/([a-f0-9-]+)$/.exec(new URL(request.url ?? "/", "http://localhost").pathname);
        if (!match) return;
        const project = projects.get(match[1]!);
        if (closing || !sameOrigin(request) || !project || project.connection && project.connection.readyState < 2) { socket.destroy(); return; }
        if (project.connection) project.stopping = project.stopProcess?.() ?? project.stopping;
        // Recheck after waiting so simultaneous upgrades cannot own the same workspace.
        let cancelled = false; socket.once("close", () => { cancelled = true; });
        void project.stopping.then(() => {
            if (cancelled || closing || project.removed || project.connection) { socket.destroy(); return; }
            sockets.handleUpgrade(request, socket, head, connection => connect(project, connection));
        }).catch(() => socket.destroy());
    };
    server.on("upgrade", upgrade);
    async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
            const url = new URL(request.url ?? "/", "http://localhost");
            if (url.pathname !== "/demo-provider" && !url.pathname.startsWith("/demo-provider/")) return false;
            if (closing || !sameOrigin(request)) { json(response, 403, { error: "Demo provider is unavailable for this origin." }); return true; }
            if (request.method === "DELETE") {
                const project = projects.get(url.pathname.slice("/demo-provider/".length));
                if (project) await retire(project); response.writeHead(204).end(); return true;
            }
            if (request.method !== "POST" || url.pathname !== "/demo-provider") { json(response, 405, { error: "Use POST to open a demo project." }); return true; }
            const sample = url.searchParams.get("sample");
            if (!sampleChoices.some(choice => choice.id === sample)) { json(response, 400, { error: "Unknown demo sample." }); return true; }
            if (projects.size >= 32) { json(response, 503, { error: "Close another demo page before opening a provider." }); return true; }
            const directory = await mkdtemp(join(resolve(tmpdir()), "sttropez-demo-"));
            const project: Project = { id: crypto.randomUUID(), directory, rootUri: URI.file(directory).toString(), documents: {},
                idle: undefined, connection: undefined, stopping: Promise.resolve(), stopProcess: undefined, removed: false };
            projects.set(project.id, project);
            try {
                const files = demoSample(sample as SampleId).files;
                await Promise.all(Object.entries(files).map(async ([name, text]) => {
                    if (basename(name) !== name || !name.endsWith(".ts")) throw new Error("Unexpected demo filename.");
                    const path = join(directory, name); project.documents[name] = { path, uri: URI.file(path).toString() }; await writeFile(path, text, { flag: "wx" });
                }));
                await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noResolve: true }, include: ["*.ts"] }), { flag: "wx" });
                if (closing || response.destroyed) { await retire(project); if (!response.destroyed) json(response, 503, { error: "Demo provider is closing." }); return true; }
                idle(project); json(response, 200, { endpoint: `/demo-provider/${project.id}`, rootUri: project.rootUri, documents: project.documents,
                    versions: { server: "5.1.3", typescript: "5.9.3", protocol: "3.17", positions: "utf-16" } });
            } catch { await retire(project); if (!response.destroyed) json(response, 500, { error: "Could not create the demo language workspace." }); }
            return true;
    }
    return Object.freeze({
        snapshot: () => ({ projects: projects.size, connections: [...projects.values()].filter(project => project.connection).length, processes, removals: removals.size }),
        handle: (request: IncomingMessage, response: ServerResponse) => {
            const work = handle(request, response); requests.add(work); void work.finally(() => requests.delete(work)).catch(() => {}); return work;
        },
        close: async () => {
            closing = true; server.off("upgrade", upgrade);
            await Promise.allSettled([...requests]);
            await Promise.all([...projects.values()].map(retire)); await Promise.all([...removals]); sockets.close();
        },
    });
}
