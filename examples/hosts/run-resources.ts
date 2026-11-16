import { HostCell } from "../shared/observable.ts";
import type { ResourceHandle, ResourceId, ResourceLease, RunSubmission, TabId, TextResourceHandle, Workspace } from "../../src/index.ts";
import type { Connection } from "./controller.ts";
import type { TransferSettings } from "./transfers.ts";
import { transferValidation } from "./transfers.ts";

type Status = "running" | "completed" | "failed" | "interrupted";
type Link = Readonly<{ id: ResourceId; revision: number; serverVersion: string | null }>;
export type RunInput = Readonly<{ kind: "run"; number: number; source: Link & Readonly<{ value: string }>;
    configuration: Link & Readonly<{ value: Connection }>; transfer: Link & Readonly<{ value: TransferSettings }>; mode: string }>;
type RunLog = Readonly<{ kind: "log"; runId: ResourceId; ordinal: number; message: string; progress: number }>;
type RunInfo = Readonly<{ id: ResourceId; number: number; status: Status; progress: number; logs: readonly ResourceId[] }>;
type Inspection = Readonly<{ id: ResourceId; title: string; text: string; preview: string | null; links: readonly Readonly<{ label: string; id: ResourceId }>[] }>;
export type RunResourcesSnapshot = Readonly<{ runs: readonly RunInfo[]; selected: ResourceId | null; inspection: Inspection | null }>;
const inspectionPermissions = Object.freeze({ edit: Object.freeze([]), save: false, run: false });

/** Immutable captured inputs/log entries; transient progress and inspector selection belong to the host. */
export class RunResources {
    private readonly workspace: Workspace;
    private readonly source: TextResourceHandle;
    private readonly configuration: ResourceHandle<Connection>;
    private readonly transfer: ResourceHandle<TransferSettings>;
    private readonly cell = new HostCell<RunResourcesSnapshot>({ runs: [], selected: null, inspection: null });
    readonly state = this.cell.observable;
    private readonly resources = new Map<ResourceId, ResourceHandle<RunInput> | ResourceHandle<RunLog>>();
    private readonly pending = new Map<ResourceId, ResourceLease>();
    private readonly tabs = new Map<ResourceId, TabId>();
    private serial = 0;
    private disposed = false;
    constructor(workspace: Workspace, source: TextResourceHandle, configuration: ResourceHandle<Connection>, transfer: ResourceHandle<TransferSettings>) {
        this.workspace = workspace; this.source = source; this.configuration = configuration; this.transfer = transfer;
    }
    validation(): string | null { const s = this.transfer.getSnapshot(); return s.state !== "ready" || !s.metadata.capabilities.run ? "Transfer settings are unavailable for Run." : transferValidation(s.value); }
    start(submission: RunSubmission<string, Connection, Readonly<{ mode: string }>>): ResourceId {
        if (this.disposed) throw new Error("Run resources are disposed.");
        const error = this.validation(), transfer = this.transfer.getSnapshot(); if (error || transfer.state !== "ready") throw new Error(error ?? "Transfer settings unavailable.");
        const lease = this.workspace.acquire(this.transfer.id), number = ++this.serial;
        try {
            const input = this.workspace.createResource<RunInput>({ scope: "host-fixture", resource: `run-${number}`, variant: "snapshot" }, `Run ${number}`, { value: { kind: "run", number,
                source: { id: submission.source.target.id, revision: submission.source.revision, serverVersion: submission.source.serverVersion, value: submission.source.value },
                configuration: { id: submission.configuration.target.id, revision: submission.configuration.revision, serverVersion: submission.configuration.serverVersion, value: submission.configuration.value },
                transfer: { id: this.transfer.id, revision: transfer.revision, serverVersion: transfer.metadata.serverVersion, value: transfer.value }, mode: submission.settings.mode } }, inspectionPermissions);
            this.resources.set(input.id, input); this.pending.set(input.id, lease);
            this.cell.set({ ...this.cell.get(), runs: [...this.cell.get().runs, { id: input.id, number, status: "running", progress: 0, logs: [] }] });
            this.log(input.id, "Run started with captured source, configuration and transfer settings.", 0); return input.id;
        } catch (error) { lease.release(); throw error; }
    }
    private log(id: ResourceId, message: string, progress: number, status: Status = "running"): void {
        const current = this.cell.get().runs.find(run => run.id === id); if (!current) return;
        const ordinal = current.logs.length + 1, entry = this.workspace.createResource<RunLog>({ scope: "host-fixture", resource: `run-${current.number}-log-${ordinal}`, variant: "snapshot" },
            `Run ${current.number} log ${ordinal}`, { value: { kind: "log", runId: id, ordinal, message, progress } }, inspectionPermissions);
        this.resources.set(entry.id, entry); this.cell.set({ ...this.cell.get(), runs: this.cell.get().runs.map(run => run.id === id ? { ...run, status, progress, logs: [...run.logs, entry.id] } : run) });
    }
    readonly advance = (id: ResourceId): void => { if (this.disposed || !this.pending.has(id)) return; const current = this.cell.get().runs.find(run => run.id === id)!;
        if (current.progress >= 90) return; const progress = Math.min(90, current.progress + 30); this.log(id, `Synthetic progress ${progress}%. Captured inputs are unchanged.`, progress); };
    finish(id: ResourceId, status: Exclude<Status, "running">): void {
        const lease = this.pending.get(id); if (!lease) return; this.pending.delete(id);
        try { this.log(id, status === "completed" ? "Run completed." : status === "failed" ? "Run failed. Captured inputs and prior logs are retained." : "Run interrupted during host disposal.", status === "completed" ? 100 : this.cell.get().runs.find(run => run.id === id)!.progress, status); }
        finally { lease.release(); }
    }
    readonly open = (id: ResourceId): void => {
        if (this.disposed || !this.resources.has(id) && ![this.source.id, this.configuration.id, this.transfer.id].includes(id)) return;
        const tab = this.tabs.get(id); if (!tab || !this.workspace.getSnapshot().tabs.some(t => t.id === tab)) this.tabs.set(id, this.workspace.open({ kind: "panel", resourceId: id, panelType: "resource-inspection" }, "right"));
        this.cell.set({ ...this.cell.get(), selected: id, inspection: this.readInspection(id) });
    };
    capture(id: ResourceId): RunInput | null { const s = this.resources.get(id)?.getSnapshot(); return s?.state === "ready" && s.value.kind === "run" ? s.value : null; }
    inspect(): Inspection | null { return this.cell.get().inspection; }
    private readInspection(id: ResourceId): Inspection | null {
        const s = this.resources.get(id)?.getSnapshot();
        if (s?.state === "ready") { const value = s.value;
            return value.kind === "log" ? { id, title: s.metadata.title, text: value.message, preview: null, links: [{ label: "Inspect captured Run", id: value.runId }] }
                : { id, title: s.metadata.title, text: `Captured source ${value.source.id} revision ${value.source.revision}, ${value.source.value.length} UTF-16 units (preview limited to 512); configuration ${value.configuration.id} revision ${value.configuration.revision} (${value.configuration.value.path}); transfer ${value.transfer.id} revision ${value.transfer.revision} (${value.transfer.value.destination}, batch ${value.transfer.value.batchSize}); mode ${value.mode}.`,
                    preview: value.source.value.slice(0, 512), links: [{ label: "Inspect current source", id: value.source.id }, { label: "Inspect current configuration", id: value.configuration.id }, { label: "Inspect current transfer settings", id: value.transfer.id }] };
        }
        if (id === this.source.id) { const d = this.workspace.document(this.source.documentId); return { id, title: "Current source", text: `Working source revision ${d.revision} at inspection. Refresh to inspect later edits; captured Run inputs remain separate.`, preview: d.buffer.slice(0, Math.min(512, d.buffer.length)), links: [] }; }
        const handle = id === this.configuration.id ? this.configuration : this.transfer, current = handle.getSnapshot();
        return { id, title: current.metadata.title, text: `Current resource ${id} revision ${current.revision} at inspection. Refresh to inspect later edits; captured Run inputs remain separate.`, preview: current.state === "ready" ? JSON.stringify(current.value).slice(0, 512) : null, links: [] };
    }
    debug() { return { runs: this.cell.get().runs, selected: this.cell.get().selected, pending: this.pending.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.disposed = true; for (const id of [...this.pending.keys()]) this.finish(id, "interrupted"); for (const tab of this.tabs.values()) this.workspace.close(tab); this.tabs.clear(); }
}
