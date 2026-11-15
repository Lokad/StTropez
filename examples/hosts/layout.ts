import type { CloseOperation, DocumentId, ResourceId, TabId, TabTarget, TextResourceHandle, Workspace } from "../../src/index.ts";
import { HostCell } from "../shared/observable.ts";

export type Layout = Readonly<{ position: "left" | "right"; visible: boolean; formFault: boolean; primarySurface: "text" | "panel" | "loading" | "closed";
    navigation: Readonly<{ kind: "workspace" } | { kind: "review" }>;
    modal: Readonly<{ kind: "none" } | { kind: "error"; message: string } | { kind: "close"; tabId: TabId }> }>;

/** Owns host tab placement/presentation and modal state; resource lifetime stays with its owner. */
export class HostLayout {
    private readonly workspace: Workspace;
    private readonly source: TextResourceHandle;
    private readonly configuration: ResourceId;
    private primaryTab: TabId;
    private readonly secondaryTab: TabId;
    readonly formTab: TabId;
    private readonly cell = new HostCell<Layout>({ position: "left", visible: true, formFault: false, primarySurface: "text", navigation: { kind: "workspace" }, modal: { kind: "none" } });
    readonly state = this.cell.observable;
    private closeOperation: CloseOperation | undefined;
    constructor(workspace: Workspace, source: TextResourceHandle, configuration: ResourceId) {
        this.workspace = workspace; this.source = source; this.configuration = configuration;
        this.primaryTab = workspace.open({ kind: "text", documentId: source.documentId }, "left");
        this.secondaryTab = workspace.open({ kind: "text", documentId: source.documentId }, "right");
        this.formTab = workspace.open({ kind: "panel", resourceId: configuration, panelType: "configuration" }, "right");
    }
    viewTab(id: "primary" | "secondary"): TabId { return id === "primary" ? this.primaryTab : this.secondaryTab; }
    presentation(): TabTarget { return this.workspace.captureTab(this.primaryTab); }
    navigate(kind: "workspace" | "review"): void { this.cell.set({ ...this.cell.get(), navigation: { kind } }); }
    error(message: string): void { this.cell.set({ ...this.cell.get(), modal: { kind: "error", message } }); }
    surface(primarySurface: "text" | "loading"): void { this.cell.set({ ...this.cell.get(), primarySurface }); }
    /** Select the captured tab before a caller begins its load; publish its surface afterwards. */
    targetText(documentId: DocumentId): TabTarget {
        if (this.cell.get().primarySurface === "closed") this.primaryTab = this.workspace.open({ kind: "text", documentId }, this.cell.get().position);
        else this.workspace.replace(this.primaryTab, { kind: "text", documentId });
        return this.presentation();
    }
    primaryContains(documentId: DocumentId): boolean {
        const tab = this.workspace.getSnapshot().tabs.find(tab => tab.id === this.primaryTab);
        return tab?.surface.kind === "text" && tab.surface.documentId === documentId;
    }
    readonly move = (): void => {
        const position = this.cell.get().position === "left" ? "right" : "left";
        if (this.cell.get().primarySurface !== "closed") this.workspace.move(this.primaryTab, position);
        this.cell.set({ ...this.cell.get(), position });
    };
    readonly toggleViews = (): void => { this.cell.set({ ...this.cell.get(), visible: !this.cell.get().visible }); };
    readonly openClosePrompt = (): void => {
        this.closeOperation?.finish(); this.closeOperation = this.workspace.beginClose(this.primaryTab);
        this.cell.set({ ...this.cell.get(), modal: { kind: "close", tabId: this.primaryTab } });
    };
    readonly confirmClose = (): boolean => {
        const closed = this.closeOperation?.complete("close"); this.closeOperation = undefined;
        if (closed) this.cell.set({ ...this.cell.get(), primarySurface: "closed", modal: { kind: "none" } });
        return closed === true;
    };
    readonly replacePrimary = (): void => {
        this.workspace.replace(this.primaryTab, { kind: "panel", resourceId: this.configuration, panelType: "configuration" });
        this.cell.set({ ...this.cell.get(), primarySurface: "panel" });
    };
    readonly reopenPrimary = (): void => { this.targetText(this.source.documentId); this.surface("text"); };
    readonly cancelClose = (): void => { this.closeOperation?.complete("keep-open"); this.closeOperation = undefined; this.clearError(); };
    readonly clearError = (): void => { this.cell.set({ ...this.cell.get(), modal: { kind: "none" } }); };
    readonly injectFormError = (): void => { this.cell.set({ ...this.cell.get(), formFault: true }); };
    readonly recover = (): void => { this.cell.set({ ...this.cell.get(), formFault: false, modal: { kind: "none" } }); };
    subscriptions(): number { return this.cell.count(); }
    dispose(): void { this.closeOperation?.finish(); this.closeOperation = undefined; }
}
