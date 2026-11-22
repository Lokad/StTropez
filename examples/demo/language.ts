import type { Observable, Workspace } from "../../src/index.ts";
import { BrowserLspWorkspace } from "../../src/browser/index.ts";
import { type LspWorkspace, LspLineIndex, decodeLspDiagnostics, lspRangeOffsets } from "../../src/protocol/index.ts";
import type { LspWorkspaceScope, RpcCall, LspScopeAccess, LspTargetResolver } from "../../src/protocol/index.ts";
import { HostCell } from "../shared/observable.ts";
import type { DemoFile } from "./project.ts";
import type { DemoProvider, DemoProviderFactory } from "./provider-contract.ts";
import { DemoDiagnosticState } from "./diagnostic-state.ts";
import type { DemoDiagnostic } from "./diagnostic-state.ts";
type State = Readonly<{ status: "suspended" | "starting" | "ready" | "failed"; checking: boolean; message: string; diagnostics: readonly DemoDiagnostic[] }>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
type Inventory = Readonly<{ names: readonly string[]; backing: () => Readonly<Record<string, string>>; load: (name: string, text: string) => DemoFile }>;

/** Provider/diagnostic ownership for one demo project; editor views have shorter independent lifetimes. */
export class DemoLanguage {
    private readonly workspace: Workspace;
    private readonly getFiles: () => readonly DemoFile[];
    private get files(): readonly DemoFile[] { return this.getFiles(); }
    private readonly inventory: Inventory | undefined;
    private readonly sample: string;
    private readonly openProvider: DemoProviderFactory;
    private readonly cell = new HostCell<State>({ status: "suspended", checking: false, message: "Language service is idle.", diagnostics: [] });
    readonly state: Observable<State> = this.cell.observable;
    private owner: LspWorkspace | undefined;
    private scope: LspWorkspaceScope | undefined;
    private config: DemoProvider | undefined;
    private opening: Promise<LspWorkspace> | undefined;
    private abort: AbortController | undefined;
    private stopProvider: (() => void) | undefined;
    private readonly stopWorkspace: () => void;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly calls = new Set<RpcCall<unknown>>();
    private readonly diagnostics = new DemoDiagnosticState();
    private lifecycle = 0;
    private diagnosticGeneration = 0;
    private active = false;
    private disposed = false;
    private disposal: Promise<void> | undefined;
    constructor(workspace: Workspace, files: readonly DemoFile[] | (() => readonly DemoFile[]), sample: string, openProvider: DemoProviderFactory, inventory?: Inventory) {
        this.openProvider = openProvider;
        this.workspace = workspace; this.getFiles = typeof files === "function" ? files : () => files; this.sample = sample; this.inventory = inventory;
        this.diagnostics.update(this.files.map(file => workspace.document(file.resource.documentId)));
        this.stopWorkspace = workspace.subscribe(() => {
            if (!this.diagnostics.update(this.files.map(file => workspace.document(file.resource.documentId)))) return;
            this.invalidate(); if (this.active) this.schedule();
        });
    }
    filesChanged(): void {
        this.diagnostics.update(this.files.map(file => this.workspace.document(file.resource.documentId)));
        this.scope?.setDocuments(this.files.map(file => this.workspace.document(file.resource.documentId)));
        this.invalidate(); if (this.active) this.schedule();
    }
    documentUri(file: DemoFile): string | undefined { return !this.disposed && this.files.includes(file) ? this.config?.documents[file.name]?.uri : undefined; }
    private publish(patch: Partial<State>): void { if (!this.disposed) this.cell.set({ ...this.cell.get(), ...patch }); }
    private invalidate(clear = false): void {
        this.diagnosticGeneration++; if (this.timer) clearTimeout(this.timer); this.timer = undefined;
        for (const call of this.calls) call.cancel(); this.calls.clear();
        if (clear) this.diagnostics.clear();
        this.publish({ checking: this.active, diagnostics: this.diagnostics.diagnostics });
    }
    private valid(lifecycle: number): boolean { return !this.disposed && this.active && lifecycle === this.lifecycle; }
    get connectedProvider(): LspWorkspace | undefined {
        return this.active && this.owner?.getSnapshot().phase === "ready" ? this.owner : undefined;
    }
    connect(): Promise<LspWorkspace> {
        if (this.disposed) return Promise.reject(new Error("Language project is disposed."));
        this.active = true;
        if (this.owner) {
            const owner = this.owner, lifecycle = this.lifecycle;
            if (owner.getSnapshot().phase === "ready") return Promise.resolve(owner);
            this.publish({ status: "starting", message: "Starting TypeScript…", checking: true });
            return owner.connect().then(() => {
                if (!this.valid(lifecycle)) throw new Error("Language startup was cancelled.");
                this.publish({ status: "ready", message: "Language service ready." }); this.schedule(); return owner;
            }).catch(error => { if (this.valid(lifecycle)) this.publish({ status: "failed", checking: false, message: "TypeScript could not reconnect. Retry to start a new service." }); throw error; });
        }
        if (this.opening) return this.opening;
        const lifecycle = ++this.lifecycle, abort = new AbortController(); this.abort = abort;
        this.publish({ status: "starting", message: "Starting TypeScript…", checking: true });
        const work = (async () => {
            let config: DemoProvider | undefined, owner: LspWorkspace | undefined;
            try {
                config = await this.openProvider(this.sample, abort.signal, this.inventory?.names ?? this.files.map(file => file.name), this.inventory?.backing());
                if (!this.valid(lifecycle)) throw new Error("Language startup was cancelled.");
                const capturedProvider = config;
                const resolveTarget: LspTargetResolver = async (uri, context) => {
                    const targetLifecycle = this.lifecycle;
                    const name = Object.keys(capturedProvider.documents).find(name => capturedProvider.documents[name]!.uri === uri);
                    if (!name || !this.inventory || this.config !== capturedProvider || !this.valid(targetLifecycle) || !context.isCurrent()) return undefined;
                    let file = this.files.find(file => file.name === name);
                    if (!file) {
                        const call = this.scope!.request("sttropez/readDocument", { uri }), stop = context.onCancel(() => call.cancel());
                        let response: unknown; try { response = await call.result; } finally { stop(); }
                        if (!this.valid(targetLifecycle) || !context.isCurrent()) throw new Error("The target load expired.");
                        if (!object(response) || response.uri !== uri || typeof response.text !== "string" || response.text.length > 8_000_000) throw new Error("Invalid target contents.");
                        file = this.inventory.load(name, response.text);
                    }
                    const resource = file.resource, document = this.workspace.document(resource.documentId), metadata = resource.metadata.getSnapshot();
                    const lease = this.workspace.acquire(resource.id), identity = this.workspace.captureResource(resource.id);
                    const current = () => this.valid(targetLifecycle) && this.config === capturedProvider && this.workspace.resolveResource(identity) === resource
                        && this.workspace.document(document.id).buffer === document.buffer && this.workspace.document(document.id).revision === document.revision
                        && resource.metadata.getSnapshot().capabilities === metadata.capabilities && resource.metadata.getSnapshot().editLock === metadata.editLock;
                    try {
                        const index = await LspLineIndex.create(document.buffer, async () => { await new Promise(resolve => setTimeout(resolve, 0)); if (!current() || !context.isCurrent()) throw new Error("The target changed."); });
                        if (!current() || !context.isCurrent()) throw new Error("The target changed.");
                        const binding = this.scope!.setDocuments(this.files.map(file => this.workspace.document(file.resource.documentId))).get(document.id);
                        const sent = binding && this.scope!.synchronized(binding);
                        return { target: { document: { uri, languageId: "typescript", resourceId: resource.id, documentId: document.id, revision: document.revision, buffer: document.buffer },
                            index, version: sent?.document.buffer === document.buffer ? sent.version : null, isCurrent: current }, release: lease.release };
                    } catch (error) { lease.release(); throw error; }
                };
                owner = new BrowserLspWorkspace(this.workspace, {
                    connect: capturedProvider.connect,
                    rootUri: config.rootUri, clientInfo: { name: "StTropez demo" }, markdownDocumentation: true,
                    features: ["textDocument/completion", "textDocument/hover", "textDocument/signatureHelp", "textDocument/definition", "textDocument/references", "textDocument/rename", "textDocument/codeAction", "textDocument/foldingRange", "textDocument/documentHighlight"], diagnostics: false, workspaceEdits: true, applyEdit: true,
                    maxDocumentUnits: 8_000_000, maxTotalUnits: 16_000_000, rpc: { maxMessageUnits: 16 * 1024 * 1024 },
                    documentInfo: document => { const file = this.files.find(file => file.resource.documentId === document.id), info = file && capturedProvider.documents[file.name];
                        return info && { uri: info.uri, languageId: "typescript" }; }, resolveTarget,
                });
                abort.signal.addEventListener("abort", () => owner?.dispose(), { once: true });
                const scope = owner.createScope(); scope.setDocuments(this.files.map(file => this.workspace.document(file.resource.documentId)));
                await owner.connect();
                if (!this.valid(lifecycle)) throw new Error("Language startup was cancelled.");
                this.owner = owner; this.scope = scope; this.config = config;
                this.stopProvider = owner.subscribe(() => {
                    if (owner!.getSnapshot().phase === "disconnected" && this.active) {
                        this.invalidate(true); this.publish({ status: "failed", checking: false, message: "TypeScript disconnected. Editing is available; retry to reconnect." });
                    }
                });
                this.publish({ status: "ready", message: "Language service ready." }); this.schedule(); return owner;
            } catch (error) {
                owner?.dispose(); if (config) await this.remove(config);
                if (this.valid(lifecycle)) this.publish({ status: "failed", checking: false, message: error instanceof Error ? error.message : "TypeScript is unavailable." });
                throw error;
            } finally { if (this.lifecycle === lifecycle) { this.opening = undefined; this.abort = undefined; } }
        })();
        this.opening = work; return work;
    }
    private schedule(): void {
        if (!this.active || !this.scope || this.disposed) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = undefined; void this.check(); }, 180);
    }
    async prepareActions(session: LspScopeAccess, file: DemoFile): Promise<void> {
        const config = this.config, lifecycle = this.lifecycle;
        if (!config || !this.valid(lifecycle) || !this.files.includes(file)) throw new Error("The language service is unavailable.");
        const uri = config.documents[file.name]!.uri;
        for (const kind of ["syntactic", "semantic"] as const) {
            const value = await session.request("sttropez/diagnostics", { uri, kind }).result;
            if (!this.valid(lifecycle) || this.config !== config) throw new Error("The quick-fix context changed.");
            if (!object(value) || value.success !== true || !Array.isArray(value.body)) throw new Error("Current diagnostics are unavailable.");
        }
    }
    private async check(): Promise<void> {
        const scope = this.scope; if (!scope || !this.active || this.disposed) return;
        const generation = this.diagnosticGeneration, lifecycle = this.lifecycle;
        const current = () => this.valid(lifecycle) && generation === this.diagnosticGeneration && scope === this.scope;
        try {
            await scope.flush(); if (!current()) return;
            const project = scope.captureProject(), documents = this.files.map(file => this.workspace.document(file.resource.documentId)), results: DemoDiagnostic[] = [];
            // Any source or inventory change invalidates this generation. Check the request's
            // target at each await, then all bindings once before publishing the project result.
            const capturesCurrent = () => current() && [...project.values()].every(capture => capture.isCurrent());
            for (const file of this.files) {
                const uri = this.config!.documents[file.name]!.uri, capture = project.get(uri)!;
                const document = this.workspace.document(file.resource.documentId), syntax = this.diagnostics.syntax(document);
                for (const kind of ["syntactic", "semantic"] as const) {
                    if (!current() || !capture.isCurrent()) return;
                    if (kind === "syntactic" && syntax) { results.push(...syntax); continue; }
                    // Semantic diagnostics may change in untouched importers. The demo provider
                    // supplies no dependency proof, so keep the project-wide semantic fallback.
                    const call = scope.request("sttropez/diagnostics", { uri, kind }); this.calls.add(call);
                    let response: unknown; try { response = await call.result; } finally { this.calls.delete(call); }
                    if (!current() || !capture.isCurrent()) return;
                    if (!object(response) || response.success !== true || !Array.isArray(response.body)) throw new Error("Invalid TypeScript diagnostics.");
                    // This custom response is correlated to our request/project, but has no provider version.
                    const batch = decodeLspDiagnostics({ uri, diagnostics: response.body }, capture);
                    const items: DemoDiagnostic[] = [];
                    for (const value of batch.items) {
                        if (value.from === null || value.to === null) throw new Error("TypeScript diagnostic is outside its captured file.");
                        const related = (value.relatedInformation ?? []).map(info => {
                            const target = project.get(info.location.uri), file = this.files.find(file => file.resource.documentId === target?.document.documentId);
                            let placed: DemoDiagnostic["related"][number]["target"] = null;
                            if (target && file) { try { placed = Object.freeze({ documentId: file.resource.documentId, revision: target.document.revision, ...lspRangeOffsets(target.index, info.location.range) }); } catch { /* Retain the message without offering an invalid location. */ } }
                            const name = Object.keys(this.config!.documents).find(name => this.config!.documents[name]!.uri === info.location.uri) ?? info.location.uri;
                            return Object.freeze({ name, message: info.message, line: info.location.range.start.line, character: info.location.range.start.character, target: placed });
                        });
                        items.push(Object.freeze({ ...value, documentId: file.resource.documentId, name: file.name, revision: capture.document.revision,
                            from: value.from, to: value.to, related: Object.freeze(related) }));
                    }
                    if (kind === "syntactic") this.diagnostics.acceptSyntax(document, items);
                    results.push(...items);
                }
            }
            if (capturesCurrent() && this.diagnostics.accept(documents, results)) this.publish({ checking: false, status: "ready", message: "Language service ready.", diagnostics: this.diagnostics.diagnostics });
        } catch (error) {
            if (current()) this.publish({ checking: false, status: "failed", message: error instanceof Error ? error.message : "Type checking is unavailable." });
        }
    }
    suspend(): void {
        this.active = false; this.lifecycle++; this.abort?.abort(); this.abort = undefined; this.opening = undefined;
        this.invalidate(true); this.owner?.disconnect(); this.publish({ status: "suspended", checking: false, message: "Language service is idle." });
    }
    retry(): Promise<LspWorkspace> {
        this.stopProvider?.(); this.stopProvider = undefined; this.scope?.dispose(); this.scope = undefined; this.owner?.dispose(); this.owner = undefined;
        if (this.config) void this.remove(this.config); this.config = undefined; this.suspend(); return this.connect();
    }
    private remove(config: DemoProvider): Promise<void> { return config.close(); }
    dispose(): Promise<void> {
        if (this.disposal) return this.disposal;
        const opening = this.opening, config = this.config;
        this.suspend(); this.disposed = true; this.stopWorkspace(); this.stopProvider?.(); this.diagnostics.update([]);
        this.scope?.dispose(); this.owner?.dispose();
        this.scope = undefined; this.owner = undefined; this.config = undefined;
        // Public request/scope cancellation releases retention through microtasks. Finish startup
        // and host cleanup, then cross the task boundary before the project releases its resources.
        this.disposal = Promise.allSettled([opening, config && this.remove(config)]).then(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
        return this.disposal;
    }
}
