import { createAgentReview } from "../../src/index.ts";
import type { ComparisonBaseline, Observable, Operation, TabTarget, TextResourceHandle, Workspace } from "../../src/index.ts";
import { HostCell } from "../shared/observable.ts";

export type ReviewVariant = Readonly<{ id: string; kind: "saved" | "server" | "draft" | "history"; label: string; version: string }>;
export type VariantReviewSnapshot = Readonly<{ generation: number; choices: readonly ReviewVariant[]; selected: ReviewVariant | null; requested: ReviewVariant | null;
    status: "idle" | "loading" | "ready" | "expired" | "failed" | "disposed"; pending: number; message: string }>;
type ReferencePublication = Readonly<{ generation: number; baseline: ComparisonBaseline }>;
type VariantPorts = Readonly<{ presentation: () => TabTarget; reference: Observable<ReferencePublication>; publish: (baseline: ComparisonBaseline) => void;
    present: () => void; beginReferenceRequest: () => () => boolean; saved: () => ComparisonBaseline; server: () => ComparisonBaseline }>;
const captureBaseline = (value: ComparisonBaseline): ComparisonBaseline => Object.freeze({ buffer: value.buffer, version: value.version });

/** Local host variant retrieval. Reference selection never changes the execution/saving resource. */
export class ReviewVariants {
    private readonly workspace: Workspace;
    private readonly source: TextResourceHandle;
    private readonly ports: VariantPorts;
    private readonly cell: HostCell<VariantReviewSnapshot>;
    private readonly lane: string;
    private readonly history = new Map<string, ComparisonBaseline>();
    private readonly loads: { operation: Operation; reference: ReferencePublication; currentRequest: () => boolean; baseline: ComparisonBaseline; choice: ReviewVariant; ownerGeneration: number }[] = [];
    private draft: ComparisonBaseline | undefined;
    private serial = 0;
    private disposed = false;
    private ownerGeneration = 0;
    private unsubscribeOwner: (() => void) | undefined;
    readonly state: Observable<VariantReviewSnapshot>;
    constructor(workspace: Workspace, source: TextResourceHandle, ports: VariantPorts) {
        if (workspace.resourceForDocument(source.documentId) !== source) throw new Error("Variant source belongs to another workspace.");
        this.lane = `review-variant:${workspace.allocateIdentity()}`;
        this.workspace = workspace; this.source = source; this.ports = ports;
        this.history.set(`history-${++this.serial}`, captureBaseline(ports.saved()));
        this.cell = new HostCell<VariantReviewSnapshot>({ generation: 0, choices: this.choices(), selected: null, requested: null, status: "idle", pending: 0, message: "Choose an immutable version to review." });
        this.state = this.cell.observable;
    }
    referenceChanged(): void {
        if (!this.disposed) this.cell.set({ ...this.cell.get(), selected: null, requested: null,
            status: this.loads.length ? "expired" : "idle", message: "The reference changed independently of version selection." });
    }
    private watchOwner(): void {
        if (this.unsubscribeOwner) return;
        const agent = createAgentReview(this.workspace, this.source); let previous = agent.getSnapshot();
        const unsubscribeAgent = agent.subscribe(() => { const current = agent.getSnapshot();
            if (current.association?.id !== previous.association?.id || current.association?.generation !== previous.association?.generation
                || current.request?.id !== previous.request?.id || current.proposalGeneration !== previous.proposalGeneration) this.ownerGeneration++;
            previous = current;
        });
        this.unsubscribeOwner = unsubscribeAgent;
    }
    private releaseOwner(): void {
        if (!this.loads.length) { this.unsubscribeOwner?.(); this.unsubscribeOwner = undefined; }
    }
    private choices(): readonly ReviewVariant[] {
        const saved = this.ports.saved(), server = this.ports.server();
        const choices: ReviewVariant[] = [{ id: "saved", kind: "saved", label: "Saved version", version: saved.version },
            { id: "server", kind: "server", label: "Server version", version: server.version },
            ...(this.draft ? [{ id: "draft", kind: "draft" as const, label: "Kept draft", version: this.draft.version }] : []),
            ...[...this.history].map(([id, baseline]) => ({ id, kind: "history" as const, label: "Historical version", version: baseline.version }))];
        return Object.freeze(choices.map(choice => Object.freeze(choice)));
    }
    refreshCatalog(): void { if (!this.disposed) this.cell.set({ ...this.cell.get(), choices: this.choices() }); }
    remember(baseline: ComparisonBaseline): void {
        if (this.disposed || [...this.history.values()].some(item => item.buffer === baseline.buffer && item.version === baseline.version)) return;
        this.history.set(`history-${++this.serial}`, captureBaseline(baseline));
        while (this.history.size > 8) this.history.delete(this.history.keys().next().value!);
        this.refreshCatalog();
    }
    readonly keepDraft = (): void => {
        if (this.disposed || this.source.getSnapshot().state !== "ready") return;
        if (this.draft) this.remember(this.draft);
        const current = this.workspace.document(this.source.documentId);
        this.draft = Object.freeze({ buffer: current.buffer, version: `reference:draft-${++this.serial}-r${current.revision}` });
        this.cell.set({ ...this.cell.get(), choices: this.choices(), message: "Kept the current committed text as an immutable draft." });
    };
    review(id: string): boolean {
        if (this.disposed || this.source.getSnapshot().state !== "ready") return false;
        const choice = this.choices().find(item => item.id === id), baseline = id === "saved" ? this.ports.saved() : id === "server" ? this.ports.server() : id === "draft" ? this.draft : this.history.get(id);
        if (!choice || !baseline) { this.cell.set({ ...this.cell.get(), generation: this.cell.get().generation + 1, status: "expired", message: "That version is no longer available." }); return false; }
        const presentation = this.ports.presentation(), tab = this.workspace.resolveTab(presentation);
        if (tab?.surface.kind !== "text" || tab.surface.documentId !== this.source.documentId) return false;
        this.ports.present();
        const operation = this.workspace.beginOperation(this.source.id, this.lane, presentation);
        this.watchOwner();
        this.loads.push({ operation, baseline: captureBaseline(baseline), choice, reference: this.ports.reference.getSnapshot(),
            currentRequest: this.ports.beginReferenceRequest(), ownerGeneration: this.ownerGeneration });
        this.cell.set({ ...this.cell.get(), generation: this.cell.get().generation + 1, choices: this.choices(), requested: choice, status: "loading", pending: this.loads.length,
            message: "Loading the captured version. Working text stays editable." }); return true;
    }
    private current(load: (typeof this.loads)[number]): boolean {
        return !this.disposed && load.currentRequest() && load.operation.presentationCurrent() && this.ports.reference.getSnapshot() === load.reference
            && this.ownerGeneration === load.ownerGeneration;
    }
    readonly finishNext = (): boolean => {
        const load = this.loads.shift(); if (!load) return false;
        try {
            if (!this.current(load)) {
                if (!this.disposed && load.operation.isCurrent()) this.cell.set({ ...this.cell.get(), requested: null, status: "expired", message: "The captured review changed. Working text was retained." });
                return false;
            }
            this.ports.publish(load.baseline);
            this.cell.set({ ...this.cell.get(), selected: load.choice, requested: null, status: "ready", message: "Reviewing the captured version. Save and Run still use the working source." }); return true;
        } finally { load.operation.finish(); this.releaseOwner(); if (!this.disposed) this.cell.set({ ...this.cell.get(), pending: this.loads.length }); }
    };
    readonly failNext = (): void => {
        const load = this.loads.shift(); if (!load) return;
        try { if (this.current(load)) this.cell.set({ ...this.cell.get(), requested: null, status: "failed", message: "Version loading failed. The current reference and working text were retained." }); }
        finally { load.operation.finish(); this.releaseOwner(); if (!this.disposed) this.cell.set({ ...this.cell.get(), pending: this.loads.length }); }
    };
    readonly cancel = (): void => {
        if (this.disposed) return;
        for (const load of this.loads.splice(0)) { load.operation.cancel(); load.operation.finish(); }
        this.releaseOwner();
        this.cell.set({ ...this.cell.get(), requested: null, status: "idle", pending: 0, message: "Version loading cancelled. Working text was retained." });
    };
    dispose(): void {
        if (this.disposed) return; this.cancel(); this.disposed = true; this.history.clear(); this.draft = undefined;
        this.cell.set({ generation: this.cell.get().generation + 1, choices: [], selected: null, requested: null, status: "disposed", pending: 0, message: "Version review disposed." });
    }
}
