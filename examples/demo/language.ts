import type { DocumentLanguage, Observable, Workspace } from "../../src/index.ts";
import { BrowserLspWorkspace } from "../../src/browser/index.ts";
import { ProtocolDecodeError, createLspFoldingClient, lspRangeOffsets } from "../../src/protocol/index.ts";
import type { LspFoldingClient, LspWorkspace } from "../../src/protocol/index.ts";
import { decodeLspDiagnostics } from "../../src/kernels/index.ts";
import type { LspWorkspaceScope, LspCall, LspScopeAccess, LspTargetResolver } from "../../src/protocol/index.ts";
import { HostCell } from "../shared/observable.ts";
import type { DemoFile } from "./project.ts";
import type { DemoProvider, DemoProviderFactory } from "./provider-contract.ts";
import { DemoDiagnosticState } from "./diagnostic-state.ts";
import type { DemoDiagnostic } from "./diagnostic-state.ts";
type State = Readonly<{
    status: "suspended" | "starting" | "ready" | "failed";
    checking: boolean;
    message: string;
    diagnostics: readonly DemoDiagnostic[];
}>;
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
type Inventory = Readonly<{
    names: readonly string[];
    backing: () => Readonly<Record<string, string>>;
    load: (name: string, text: string) => DemoFile;
}>;

function fileLanguage(config: DemoProvider | undefined, name: string): DocumentLanguage | null {
    const file = config?.documents[name];
    return file ? { uri: file.uri, languageId: "typescript" } : null;
}

/** Provider/diagnostic ownership for one demo project; editor views have shorter independent lifetimes. */
export class DemoLanguage {
    private readonly workspace: Workspace;
    private readonly getFiles: () => readonly DemoFile[];
    private get files(): readonly DemoFile[] {
        return this.getFiles();
    }
    private readonly inventory: Inventory | undefined;
    private readonly sample: string;
    private readonly openProvider: DemoProviderFactory;
    private readonly cell = new HostCell<State>({
        status: "suspended",
        checking: false,
        message: "Language service is idle.",
        diagnostics: []
    });
    readonly state: Observable<State> = this.cell.observable;
    private owner: LspWorkspace | undefined;
    private scope: LspWorkspaceScope | undefined;
    private folds: LspFoldingClient | undefined;
    private config: DemoProvider | undefined;
    private opening: Promise<LspWorkspace> | undefined;
    private abort: AbortController | undefined;
    private stopProvider: (() => void) | undefined;
    private readonly stopWorkspace: () => void;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly calls = new Set<LspCall<unknown>>();
    private readonly diagnostics = new DemoDiagnosticState();
    private lifecycle = 0;
    private diagnosticGeneration = 0;
    private active = false;
    private disposed = false;
    private disposal: Promise<void> | undefined;
    constructor(
        workspace: Workspace,
        files: readonly DemoFile[] | (() => readonly DemoFile[]),
        sample: string,
        openProvider: DemoProviderFactory,
        inventory?: Inventory
    ) {
        this.openProvider = openProvider;
        this.workspace = workspace;
        this.getFiles = typeof files === "function" ? files : () => files;
        this.sample = sample;
        this.inventory = inventory;
        this.diagnostics.update(this.files.map((file) => workspace.document(file.resource.id)));
        this.stopWorkspace = workspace.subscribe(() => {
            if (!this.diagnostics.update(this.files.map((file) => workspace.document(file.resource.id)))) return;
            this.invalidate();
            if (this.active) this.schedule();
        });
    }
    filesChanged(): void {
        this.diagnostics.update(this.files.map((file) => this.workspace.document(file.resource.id)));
        this.scope?.setDocuments(this.files.map((file) => this.workspace.document(file.resource.id)));
        this.invalidate();
        if (this.active) this.schedule();
    }
    languageFor(name: string): DocumentLanguage | null {
        return fileLanguage(this.config, name);
    }
    private publish(patch: Partial<State>): void {
        if (!this.disposed) this.cell.set({ ...this.cell.get(), ...patch });
    }
    private invalidate(clear = false): void {
        this.diagnosticGeneration++;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        for (const call of this.calls) call.cancel();
        this.calls.clear();
        if (clear) this.diagnostics.clear();
        this.publish({ checking: this.active, diagnostics: this.diagnostics.diagnostics });
    }
    private valid(lifecycle: number): boolean {
        return !this.disposed && this.active && lifecycle === this.lifecycle;
    }
    get preparedProvider(): LspWorkspace | undefined {
        return this.active ? this.owner : undefined;
    }
    get foldingClient() {
        return this.owner?.getSnapshot().phase === "ready" ? this.folds : undefined;
    }
    async connect(): Promise<LspWorkspace> {
        const opening = this.prepare(),
            lifecycle = this.lifecycle;
        const owner = await opening;
        if (this.owner !== owner || !this.valid(lifecycle)) throw new Error("Language startup was cancelled.");
        if (owner.getSnapshot().phase === "ready") return owner;
        this.publish({ status: "starting", message: "Starting TypeScript…", checking: true });
        try {
            await owner.connect();
            if (!this.valid(lifecycle)) throw new Error("Language startup was cancelled.");
            this.publish({ status: "ready", message: "Language service ready." });
            this.schedule();
            return owner;
        } catch (error) {
            if (this.valid(lifecycle))
                this.publish({
                    status: "failed",
                    checking: false,
                    message: "TypeScript could not connect. Retry to start a new service."
                });
            throw error;
        }
    }
    prepare(): Promise<LspWorkspace> {
        if (this.disposed) return Promise.reject(new Error("Language project is disposed."));
        this.active = true;
        if (this.owner) return Promise.resolve(this.owner);
        if (this.opening) return this.opening;
        const lifecycle = ++this.lifecycle,
            abort = new AbortController();
        this.abort = abort;
        this.publish({ status: "starting", message: "Starting TypeScript…", checking: true });
        const work = (async () => {
            let config: DemoProvider | undefined, owner: LspWorkspace | undefined;
            try {
                config = await this.openProvider(
                    this.sample,
                    abort.signal,
                    this.inventory?.names ?? this.files.map((file) => file.name),
                    this.inventory?.backing()
                );
                if (!this.valid(lifecycle)) throw new Error("Language startup was cancelled.");
                const capturedProvider = config;
                for (const file of this.files)
                    this.workspace.setDocumentLanguage(file.resource.id, fileLanguage(config, file.name));
                const resolveTarget: LspTargetResolver = async (uri, context) => {
                    const targetLifecycle = this.lifecycle;
                    const name = Object.keys(capturedProvider.documents).find(
                        (name) => capturedProvider.documents[name]!.uri === uri
                    );
                    if (
                        !name ||
                        !this.inventory ||
                        this.config !== capturedProvider ||
                        !this.valid(targetLifecycle) ||
                        !context.isCurrent()
                    )
                        return undefined;
                    let file = this.files.find((file) => file.name === name);
                    if (!file) {
                        const call = this.scope!.request("sttropez/readDocument", { uri }),
                            stop = context.onCancel(() => call.cancel());
                        let response: unknown;
                        try {
                            response = await call.result;
                        } finally {
                            stop();
                        }
                        if (!this.valid(targetLifecycle) || !context.isCurrent())
                            throw new Error("The target load expired.");
                        if (
                            !object(response) ||
                            response.uri !== uri ||
                            typeof response.text !== "string" ||
                            response.text.length > 8_000_000
                        )
                            throw new Error("Invalid target contents.");
                        file = this.inventory.load(name, response.text);
                    }
                    return { document: this.workspace.document(file.resource.id) };
                };
                owner = new BrowserLspWorkspace(this.workspace, {
                    connect: capturedProvider.connect,
                    rootUri: config.rootUri,
                    clientInfo: { name: "StTropez demo" },
                    markdownDocumentation: true,
                    diagnostics: false,
                    workspaceEdits: true,
                    applyEdit: true,
                    maxDocumentUnits: 8_000_000,
                    maxTotalUnits: 16_000_000,
                    rpc: { maxMessageUnits: 16 * 1024 * 1024 },
                    resolveTarget
                });
                abort.signal.addEventListener("abort", () => owner?.dispose(), { once: true });
                const scope = owner.createScope();
                scope.setDocuments(this.files.map((file) => this.workspace.document(file.resource.id)));
                const folds = createLspFoldingClient(owner);
                const stopProvider = owner.subscribe(() => {
                    const connection = owner!.getSnapshot();
                    if (connection.phase === "disconnected" && connection.epoch > 0 && this.active) {
                        this.invalidate(true);
                        this.publish({
                            status: "failed",
                            checking: false,
                            message: "TypeScript disconnected. Editing is available; retry to reconnect."
                        });
                    }
                });
                this.owner = owner;
                this.scope = scope;
                this.config = config;
                this.folds = folds;
                this.stopProvider = stopProvider;
                return owner;
            } catch (error) {
                owner?.dispose();
                if (config) await this.remove(config);
                if (this.valid(lifecycle))
                    this.publish({
                        status: "failed",
                        checking: false,
                        message: error instanceof Error ? error.message : "TypeScript is unavailable."
                    });
                throw error;
            } finally {
                if (this.lifecycle === lifecycle) {
                    this.opening = undefined;
                    this.abort = undefined;
                }
            }
        })();
        this.opening = work;
        return work;
    }
    private schedule(): void {
        if (!this.active || this.owner?.getSnapshot().phase !== "ready" || this.disposed) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.check();
        }, 180);
    }
    async prepareActions(session: LspScopeAccess, file: DemoFile): Promise<void> {
        const config = this.config,
            lifecycle = this.lifecycle;
        if (!config || !this.valid(lifecycle) || !this.files.includes(file))
            throw new Error("The language service is unavailable.");
        const uri = this.workspace.document(file.resource.id).language!.uri;
        for (const kind of ["syntactic", "semantic"] as const) {
            const value = await session.request("sttropez/diagnostics", { uri, kind }).result;
            if (!this.valid(lifecycle) || this.config !== config) throw new Error("The quick-fix context changed.");
            if (!object(value) || value.success !== true || !Array.isArray(value.body))
                throw new Error("Current diagnostics are unavailable.");
        }
    }
    private async check(): Promise<void> {
        const scope = this.scope;
        if (!scope || !this.active || this.disposed) return;
        const generation = this.diagnosticGeneration,
            lifecycle = this.lifecycle;
        const current = () => this.valid(lifecycle) && generation === this.diagnosticGeneration && scope === this.scope;
        try {
            await scope.flush();
            if (!current()) return;
            const project = scope.captureProject(),
                documents = this.files.map((file) => this.workspace.document(file.resource.id)),
                results: DemoDiagnostic[] = [];
            // Any source or inventory change invalidates this generation. Check the request's
            // target at each await, then all bindings once before publishing the project result.
            const capturesCurrent = () => current() && [...project.values()].every((capture) => capture.isCurrent());
            for (const file of this.files) {
                const document = this.workspace.document(file.resource.id),
                    syntax = this.diagnostics.syntax(document);
                const uri = document.language!.uri,
                    capture = project.get(uri)!;
                for (const kind of ["syntactic", "semantic"] as const) {
                    if (!current() || !capture.isCurrent()) return;
                    if (kind === "syntactic" && syntax) {
                        results.push(...syntax);
                        continue;
                    }
                    // Semantic diagnostics may change in untouched importers. The demo provider
                    // supplies no dependency proof, so keep the project-wide semantic fallback.
                    const call = scope.request("sttropez/diagnostics", { uri, kind });
                    this.calls.add(call);
                    let response: unknown;
                    try {
                        response = await call.result;
                    } finally {
                        this.calls.delete(call);
                    }
                    if (!current() || !capture.isCurrent()) return;
                    if (!object(response) || response.success !== true || !Array.isArray(response.body))
                        throw new Error("Invalid TypeScript diagnostics.");
                    // This custom response is correlated to our request/project, but has no provider version.
                    const batch = decodeLspDiagnostics({ uri, diagnostics: response.body }, capture);
                    const items: DemoDiagnostic[] = [];
                    for (const value of batch.items) {
                        if (value.from === null || value.to === null)
                            throw new Error("TypeScript diagnostic is outside its captured file.");
                        const related = (value.relatedInformation ?? []).map((info) => {
                            const target = project.get(info.location.uri),
                                file = this.files.find((file) => file.resource.id === target?.document.documentId);
                            let placed: DemoDiagnostic["related"][number]["target"] = null;
                            if (target && file) {
                                try {
                                    const offsets = lspRangeOffsets(target.index, info.location.range);
                                    placed = Object.freeze({
                                        documentId: file.resource.id,
                                        revision: target.document.revision,
                                        ...offsets
                                    });
                                } catch (error) {
                                    if (!(error instanceof ProtocolDecodeError)) throw error;
                                }
                            }
                            const name =
                                Object.keys(this.config!.documents).find(
                                    (name) => this.config!.documents[name]!.uri === info.location.uri
                                ) ?? info.location.uri;
                            return Object.freeze({
                                name,
                                message: info.message,
                                line: info.location.range.start.line,
                                character: info.location.range.start.character,
                                target: placed
                            });
                        });
                        items.push(
                            Object.freeze({
                                ...value,
                                documentId: file.resource.id,
                                name: file.name,
                                revision: capture.document.revision,
                                from: value.from,
                                to: value.to,
                                related: Object.freeze(related)
                            })
                        );
                    }
                    if (kind === "syntactic") this.diagnostics.acceptSyntax(document, items);
                    results.push(...items);
                }
            }
            if (capturesCurrent() && this.diagnostics.accept(documents, results))
                this.publish({
                    checking: false,
                    status: "ready",
                    message: "Language service ready.",
                    diagnostics: this.diagnostics.diagnostics
                });
        } catch (error) {
            if (current())
                this.publish({
                    checking: false,
                    status: "failed",
                    message: error instanceof Error ? error.message : "Type checking is unavailable."
                });
        }
    }
    suspend(): void {
        this.active = false;
        this.lifecycle++;
        this.abort?.abort();
        this.abort = undefined;
        this.opening = undefined;
        this.invalidate(true);
        this.owner?.disconnect();
        this.publish({ status: "suspended", checking: false, message: "Language service is idle." });
    }
    resetProvider(): void {
        this.folds?.dispose();
        this.folds = undefined;
        this.stopProvider?.();
        this.stopProvider = undefined;
        this.scope?.dispose();
        this.scope = undefined;
        this.owner?.dispose();
        this.owner = undefined;
        if (this.config) void this.remove(this.config);
        this.config = undefined;
        this.suspend();
        for (const file of this.files) this.workspace.setDocumentLanguage(file.resource.id, null);
    }
    private remove(config: DemoProvider): Promise<void> {
        return config.close();
    }
    dispose(): Promise<void> {
        if (this.disposal) return this.disposal;
        const opening = this.opening,
            config = this.config;
        this.suspend();
        this.disposed = true;
        this.stopWorkspace();
        this.stopProvider?.();
        this.folds?.dispose();
        this.folds = undefined;
        this.diagnostics.update([]);
        this.scope?.dispose();
        this.owner?.dispose();
        this.scope = undefined;
        this.owner = undefined;
        this.config = undefined;
        // Public request/scope cancellation releases retention through microtasks. Finish startup
        // and host cleanup, then cross the task boundary before the project releases its resources.
        this.disposal = Promise.allSettled([opening, config && this.remove(config)]).then(
            () => new Promise<void>((resolve) => setTimeout(resolve, 0))
        );
        return this.disposal;
    }
}
