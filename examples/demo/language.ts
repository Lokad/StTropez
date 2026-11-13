import type { DocumentId, Observable, Workspace } from "../../src/index.ts";
import { LspWorkspace } from "../../src/protocol/index.ts";
import type { LspWorkspaceScope, RpcCall, LspSessionAccess } from "../../src/protocol/index.ts";
import { HostCell } from "../shared/observable.ts";
import type { DemoFile } from "./project.ts";
import { openDemoProvider } from "./provider.ts";
import type { DemoProvider } from "./provider.ts";

export type DemoDiagnostic = Readonly<{ documentId: DocumentId; name: string; revision: number; from: number; to: number; message: string; code: number }>;
type State = Readonly<{ status: "suspended" | "starting" | "ready" | "failed"; checking: boolean; message: string; diagnostics: readonly DemoDiagnostic[] }>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Provider/diagnostic ownership for one demo project; editor views have shorter independent lifetimes. */
export class DemoLanguage {
    private readonly workspace: Workspace;
    private readonly files: readonly DemoFile[];
    private readonly sample: string;
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
    private buffers;
    private lifecycle = 0;
    private diagnosticGeneration = 0;
    private active = false;
    private disposed = false;
    private disposal: Promise<void> | undefined;
    constructor(workspace: Workspace, files: readonly DemoFile[], sample: string) {
        this.workspace = workspace; this.files = files; this.sample = sample;
        this.buffers = files.map(file => workspace.document(file.resource.documentId).buffer);
        this.stopWorkspace = workspace.subscribe(() => {
            const next = files.map(file => workspace.document(file.resource.documentId).buffer);
            if (next.every((buffer, i) => buffer === this.buffers[i])) return;
            this.buffers = next; this.invalidate(); if (this.active) this.schedule();
        });
    }
    private publish(patch: Partial<State>): void { if (!this.disposed) this.cell.set({ ...this.cell.get(), ...patch }); }
    private invalidate(): void {
        this.diagnosticGeneration++; if (this.timer) clearTimeout(this.timer); this.timer = undefined;
        for (const call of this.calls) call.cancel(); this.calls.clear();
        this.publish({ checking: this.active, diagnostics: [] });
    }
    private valid(lifecycle: number): boolean { return !this.disposed && this.active && lifecycle === this.lifecycle; }
    connect(): Promise<LspWorkspace> {
        if (this.disposed) return Promise.reject(new Error("Language project is disposed."));
        this.active = true;
        if (this.owner) {
            const owner = this.owner, lifecycle = this.lifecycle;
            if (owner.state.getSnapshot().phase === "ready") return Promise.resolve(owner);
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
                config = await openDemoProvider(this.sample, abort.signal, this.files.map(file => file.name));
                if (!this.valid(lifecycle)) throw new Error("Language startup was cancelled.");
                const capturedProvider = config;
                const mappings = new Map(this.files.map(file => [file.resource.documentId, config!.documents[file.name]!]));
                owner = new LspWorkspace(this.workspace, {
                    connect: context => capturedProvider.connect(context),
                    rootUri: config.rootUri, clientInfo: { name: "StTropez demo" },
                    schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
                    features: ["textDocument/completion", "textDocument/hover", "textDocument/signatureHelp", "textDocument/definition", "textDocument/references", "textDocument/rename", "textDocument/codeAction", "textDocument/foldingRange", "textDocument/documentHighlight"], diagnostics: false,
                    maxDocumentUnits: 8_000_000, maxTotalUnits: 16_000_000, rpc: { maxMessageUnits: 16 * 1024 * 1024 },
                    documentInfo: document => { const info = mappings.get(document.id); return info && { uri: info.uri, languageId: "typescript" }; },
                });
                abort.signal.addEventListener("abort", () => owner?.dispose(), { once: true });
                const scope = owner.createScope(); scope.setDocuments(this.files.map(file => this.workspace.document(file.resource.documentId)));
                await owner.connect();
                if (!this.valid(lifecycle)) throw new Error("Language startup was cancelled.");
                this.owner = owner; this.scope = scope; this.config = config;
                this.stopProvider = owner.state.subscribe(() => {
                    if (owner!.state.getSnapshot().phase === "disconnected" && this.active) {
                        this.invalidate(); this.publish({ status: "failed", checking: false, message: "TypeScript disconnected. Editing is available; retry to reconnect." });
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
    async prepareActions(session: LspSessionAccess, file: DemoFile): Promise<void> {
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
            const project = scope.captureProject(), results: DemoDiagnostic[] = [];
            const capturesCurrent = () => current() && [...project.values()].every(capture => capture.isCurrent());
            for (const file of this.files) {
                const uri = this.config!.documents[file.name]!.uri, capture = project.get(uri)!;
                for (const kind of ["syntactic", "semantic"] as const) {
                    if (!capturesCurrent()) return;
                    const call = scope.request("sttropez/diagnostics", { uri, kind }); this.calls.add(call);
                    let response: unknown; try { response = await call.result; } finally { this.calls.delete(call); }
                    if (!capturesCurrent()) return;
                    if (!object(response) || response.success !== true || !Array.isArray(response.body)) throw new Error("Invalid TypeScript diagnostics.");
                    for (const value of response.body) {
                        if (!object(value) || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.length) || typeof value.message !== "string" || !Number.isSafeInteger(value.code)) throw new Error("Invalid TypeScript diagnostic range.");
                        const from = value.start as number, to = from + (value.length as number);
                        if (from < 0 || to < from || to > capture.document.buffer.length) throw new Error("TypeScript diagnostic is outside its captured file.");
                        results.push({ documentId: file.resource.documentId, name: file.name, revision: capture.document.revision, from, to, message: value.message, code: value.code as number });
                    }
                }
            }
            if (capturesCurrent()) this.publish({ checking: false, status: "ready", message: "Language service ready.", diagnostics: results });
        } catch (error) {
            if (current()) this.publish({ checking: false, status: "failed", message: error instanceof Error ? error.message : "Type checking is unavailable." });
        }
    }
    suspend(): void {
        this.active = false; this.lifecycle++; this.abort?.abort(); this.abort = undefined; this.opening = undefined;
        this.invalidate(); this.owner?.disconnect(); this.publish({ status: "suspended", checking: false, message: "Language service is idle." });
    }
    retry(): Promise<LspWorkspace> {
        this.stopProvider?.(); this.stopProvider = undefined; this.scope?.dispose(); this.scope = undefined; this.owner?.dispose(); this.owner = undefined;
        if (this.config) void this.remove(this.config); this.config = undefined; this.suspend(); return this.connect();
    }
    private remove(config: DemoProvider): Promise<void> { return config.close(); }
    dispose(): Promise<void> {
        if (this.disposal) return this.disposal;
        const opening = this.opening, config = this.config;
        this.suspend(); this.disposed = true; this.stopWorkspace(); this.stopProvider?.();
        this.scope?.dispose(); this.owner?.dispose();
        this.scope = undefined; this.owner = undefined; this.config = undefined;
        // Public request/scope cancellation releases retention through microtasks. Finish startup
        // and host cleanup, then cross the task boundary before the project releases its resources.
        this.disposal = Promise.allSettled([opening, config && this.remove(config)]).then(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
        return this.disposal;
    }
}
