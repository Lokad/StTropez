import { createWorkingSource } from "./working-source.ts";
import type { DocumentId, TextResourceHandle, Workspace } from "../../../src/index.ts";
import type { HostLayout } from "./layout.ts";

/** Temporary documents retain unsaved edits after their pane closes. */
export class HostLoadedSource {
    private readonly workspace: Workspace;
    private readonly layout: HostLayout;
    private loaded: TextResourceHandle | undefined;
    private pendingLoad: (() => void) | undefined;
    private discardLoaded: Readonly<{ resource: TextResourceHandle; revision: number }> | undefined;
    private collecting = false;
    private readonly detachedCleanup = new Set<(documentId: DocumentId) => void>();
    private disposed = false;
    constructor(workspace: Workspace, layout: HostLayout) {
        this.workspace = workspace;
        this.layout = layout;
    }
    get pending(): boolean { return this.pendingLoad !== undefined; }
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
            this.workspace.releaseResource(loaded.id, discard && latest.revision === state.revision); this.loaded = undefined; this.discardLoaded = undefined;
        } finally { this.collecting = false; }
    }
    readonly begin = (): void => {
        if (this.disposed) return;
        if (this.pending) throw new Error("A fixture load is already pending.");
        if (this.loaded?.metadata.getSnapshot().dirty) {
            this.layout.error("Loaded source has unsaved changes. Reopen or explicitly discard it before starting another load."); return;
        }
        const loaded = this.loaded ?? createWorkingSource(this.workspace,
            `loaded-${this.workspace.getSnapshot().revision}`, "Loaded source");
        const target = this.layout.targetText(loaded.id);
        const operation = this.workspace.beginLoad(loaded);
        this.layout.surface("loading");
        this.pendingLoad = () => {
            operation.accept({ value: "loaded resource", serverVersion: "loaded-v1" });
            if (this.layout.panes.primary.getSnapshot() === target) this.layout.surface("text");
            this.collect();
        };
        this.loaded = loaded;
    };
    readonly reopen = (): void => {
        const loaded = this.loaded; if (this.disposed || !loaded || this.pending) return;
        this.layout.targetText(loaded.id); this.layout.surface("text");
    };
    readonly discard = (): void => {
        const loaded = this.loaded; if (this.disposed || !loaded || this.pending) return;
        this.discardLoaded = { resource: loaded, revision: loaded.getSnapshot().revision };
        if (this.layout.primaryContains(loaded.id)) this.layout.reopenPrimary();
        this.collect();
    };
    readonly finish = (): void => { const finish = this.pendingLoad; this.pendingLoad = undefined; finish?.(); };
    dispose(): void {
        if (this.disposed) return; this.disposed = true;
        this.finish(); this.detachedCleanup.clear();
    }
}
