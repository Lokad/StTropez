import type { DocumentId, ResourceId, TextResourceHandle, Workspace } from "../../../src/index.ts";
import { HostCell } from "../../../examples/shared/observable.ts";

export type HostPane = Readonly<{ documentId: DocumentId | null; generation: number }>;
export type Layout = Readonly<{ position: "left" | "right"; visible: boolean; formFault: boolean; primarySurface: "text" | "panel" | "loading" | "closed";
    navigation: Readonly<{ kind: "workspace" } | { kind: "review" }>;
    modal: Readonly<{ kind: "none" } | { kind: "error"; message: string; source?: "source-save" } | { kind: "close" }> }>;

/** Owns host tab placement/presentation and modal state; resource lifetime stays with its owner. */
export class HostLayout {
    private readonly workspace: Workspace;
    private readonly source: TextResourceHandle;
    private readonly configuration: ResourceId;
    private readonly primary: HostCell<HostPane>;
    private readonly secondary: HostCell<HostPane>;
    readonly panes;
    private readonly cell = new HostCell<Layout>({ position: "left", visible: true, formFault: false, primarySurface: "text", navigation: { kind: "workspace" }, modal: { kind: "none" } });
    readonly state = this.cell.observable;
    private closeIfCurrent: (() => boolean) | undefined;
    constructor(workspace: Workspace, source: TextResourceHandle, configuration: ResourceId) {
        this.workspace = workspace; this.source = source; this.configuration = configuration;
        this.primary = new HostCell<HostPane>({ documentId: source.documentId, generation: 0 });
        this.secondary = new HostCell<HostPane>({ documentId: source.documentId, generation: 0 });
        this.panes = { primary: this.primary.observable, secondary: this.secondary.observable };
    }
    setSecondary(documentId: DocumentId | null): void {
        this.secondary.set({ documentId, generation: this.secondary.get().generation + 1 });
    }
    navigate(kind: "workspace" | "review"): void { this.cell.set({ ...this.cell.get(), navigation: { kind } }); }
    error(message: string, source?: "source-save"): void {
        this.cell.set({ ...this.cell.get(), modal: { kind: "error", message, ...(source && { source }) } });
    }
    surface(primarySurface: "text" | "loading"): void { this.cell.set({ ...this.cell.get(), primarySurface }); }
    targetText(documentId: DocumentId | null): HostPane {
        const next = { documentId, generation: this.primary.get().generation + 1 };
        this.primary.set(next);
        return next;
    }
    primaryContains(documentId: DocumentId): boolean { return this.primary.get().documentId === documentId; }
    readonly move = (): void => {
        const position = this.cell.get().position === "left" ? "right" : "left";
        this.cell.set({ ...this.cell.get(), position });
    };
    readonly toggleViews = (): void => { this.cell.set({ ...this.cell.get(), visible: !this.cell.get().visible }); };
    readonly openClosePrompt = (): void => {
        const target = this.primary.get();
        if (this.cell.get().primarySurface === "closed") return;
        const resource = target.documentId ? this.workspace.resourceForDocument(target.documentId)
            : this.workspace.resource(this.configuration);
        const revision = resource.getSnapshot().revision;
        this.closeIfCurrent = () => {
            if (this.primary.get() !== target || resource.getSnapshot().revision !== revision) return false;
            this.targetText(null);
            return true;
        };
        this.cell.set({ ...this.cell.get(), modal: { kind: "close" } });
    };
    readonly confirmClose = (): boolean => {
        const close = this.closeIfCurrent;
        this.closeIfCurrent = undefined;
        const closed = close?.();
        if (closed) this.cell.set({ ...this.cell.get(), primarySurface: "closed", modal: { kind: "none" } });
        return closed === true;
    };
    readonly replacePrimary = (): void => {
        this.targetText(null);
        this.cell.set({ ...this.cell.get(), primarySurface: "panel" });
    };
    readonly reopenPrimary = (): void => { this.targetText(this.source.documentId); this.surface("text"); };
    readonly cancelClose = (): void => { this.closeIfCurrent = undefined; this.clearError(); };
    readonly clearError = (): void => { this.cell.set({ ...this.cell.get(), modal: { kind: "none" } }); };
    readonly injectFormError = (): void => { this.cell.set({ ...this.cell.get(), formFault: true }); };
    readonly recover = (): void => { this.cell.set({ ...this.cell.get(), formFault: false, modal: { kind: "none" } }); };
    subscriptions(): number { return this.cell.count() + this.primary.count() + this.secondary.count(); }
    dispose(): void { this.closeIfCurrent = undefined; }
}
