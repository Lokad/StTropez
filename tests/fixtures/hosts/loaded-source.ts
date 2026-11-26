import { createWorkingSource } from "./working-source.ts";
import type { DocumentId, DocumentView, TextResourceHandle, Workspace } from "../../../src/index.ts";
import { HostCell } from "../../../examples/shared/observable.ts";
import type { HostLayout } from "./layout.ts";

type LoadedPorts = Readonly<{ canCaptureRecovery: () => boolean; reopenPrimary: () => void }>;

/** A generation-addressed temporary source slot. Dirty values outlive their presentations. */
export class HostLoadedSource {
    private readonly workspace: Workspace;
    private readonly layout: HostLayout;
    private readonly ports: LoadedPorts;
    private readonly cell = new HostCell<Readonly<{ generation: number; resource: TextResourceHandle | null }>>({ generation: 0, resource: null });
    readonly state = this.cell.observable;
    private pendingLoad: (() => void) | undefined;
    private discardLoaded: Readonly<{ resource: TextResourceHandle; revision: number }> | undefined;
    private collecting = false;
    private readonly detachedCleanup = new Set<(documentId: DocumentId) => void>();
    private disposed = false;
    constructor(workspace: Workspace, layout: HostLayout, ports: LoadedPorts) { this.workspace = workspace; this.layout = layout; this.ports = ports; }
    private get loaded(): TextResourceHandle | undefined { return this.cell.get().resource ?? undefined; }
    private setLoaded(resource: TextResourceHandle | undefined): void {
        if (resource !== this.loaded) this.cell.set({ generation: this.cell.get().generation + 1, resource: resource ?? null });
    }
    get pending(): boolean { return this.pendingLoad !== undefined; }
    hasPendingRecoveryWork(includeLoaded: boolean): boolean { return this.pending || includeLoaded && this.loaded?.metadata.getSnapshot().dirty === true; }
    registerDetachedCleanup(cleanup: (documentId: DocumentId) => void): () => void {
        if (this.disposed) return () => {};
        this.detachedCleanup.add(cleanup); return () => { this.detachedCleanup.delete(cleanup); };
    }
    /** Clean temporary loads are evicted only after all presentations and operations detach. */
    collect(): void {
        const loaded = this.loaded;
        if (!loaded || this.pending || this.collecting) return;
        const state = loaded.getSnapshot(), discard = this.discardLoaded?.resource === loaded && this.discardLoaded.revision === state.revision;
        if (this.discardLoaded && !discard) {
            this.discardLoaded = undefined;
            if (state.metadata.dirty) this.layout.error("Loaded source changed after the discard request. Reopen it or discard again.");
        }
        if (state.metadata.dirty && !discard || this.layout.primaryContains(loaded.id) || this.layout.panes.secondary.getSnapshot().documentId === loaded.id) return;
        this.collecting = true;
        try {
            for (const cleanup of this.detachedCleanup) cleanup(loaded.id);
            if (this.workspace.ownership(loaded.id).leases) return;
            const latest = loaded.getSnapshot();
            if (latest.metadata.dirty && (!discard || latest.revision !== state.revision)) {
                this.discardLoaded = undefined;
                this.layout.error("Loaded source changed during cleanup. Reopen it or discard again."); return;
            }
            this.workspace.releaseResource(loaded.id, discard && latest.revision === state.revision); this.setLoaded(undefined); this.discardLoaded = undefined;
        } finally { this.collecting = false; }
    }
    restoreDraft(text: string, generation: number, view?: DocumentView): TextResourceHandle | undefined {
        if (this.disposed || !this.ports.canCaptureRecovery() || this.pending || generation !== this.cell.get().generation) return;
        const previous = this.loaded, resource = previous ?? this.createResource(true), state = resource.getSnapshot();
        if (state.state !== "ready") return;
        const result = this.workspace.replaceText(resource.id, text,
            { expectedRevision: state.revision, origin: "human", history: "record", ...(view ? { view } : {}) });
        if (!result.applied) { if (!previous) this.workspace.releaseResource(resource.id, true); return; }
        this.setLoaded(resource); return resource;
    }
    private createResource(ready = false): TextResourceHandle {
        return createWorkingSource(this.workspace, `loaded-${this.workspace.getSnapshot().revision}`, "Loaded source",
            ready ? { value: "loaded resource", serverVersion: "loaded-v1" } : undefined);
    }
    readonly begin = (): void => {
        if (this.disposed) return;
        if (this.pending) throw new Error("A fixture load is already pending.");
        if (this.loaded?.metadata.getSnapshot().dirty) {
            this.layout.error("Loaded source has unsaved changes. Reopen or explicitly discard it before starting another load."); return;
        }
        const loaded = this.loaded ?? this.createResource(), target = this.layout.targetText(loaded.id), operation = this.workspace.beginLoad(loaded);
        this.layout.surface("loading");
        this.pendingLoad = () => {
            operation.accept({ value: "loaded resource", serverVersion: "loaded-v1" });
            if (this.layout.panes.primary.getSnapshot() === target) this.layout.surface("text");
            this.collect();
        };
        this.setLoaded(loaded);
    };
    readonly reopen = (): void => {
        const loaded = this.loaded; if (this.disposed || !loaded || this.pending) return;
        this.layout.targetText(loaded.id); this.layout.surface("text");
    };
    readonly discard = (): void => {
        const loaded = this.loaded; if (this.disposed || !loaded || this.pending) return;
        this.discardLoaded = { resource: loaded, revision: loaded.getSnapshot().revision };
        if (this.layout.primaryContains(loaded.id)) this.ports.reopenPrimary();
        this.collect();
    };
    readonly finish = (): void => { const finish = this.pendingLoad; this.pendingLoad = undefined; finish?.(); };
    subscriptions(): number { return this.cell.count(); }
    dispose(): void {
        if (this.disposed) return; this.disposed = true;
        this.finish(); this.detachedCleanup.clear();
    }
}
