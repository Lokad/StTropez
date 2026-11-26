import type { FormId, FormSave } from "./form-save.ts";
import { HostCell } from "../../../examples/shared/observable.ts";
import type { DocumentId, TextResourceHandle, Workspace } from "../../../src/index.ts";
import type { SubmittedRun } from "./fixture-services.ts";
import type { Connection } from "./controller.ts";
import type { TransferSettings } from "./transfers.ts";
import { transferValidation } from "./transfers.ts";

type Status = "running" | "completed" | "failed" | "interrupted";
type Link<Id> = Readonly<{ id: Id; revision: number; serverVersion: string | null }>;
export type RunInput = Readonly<{ kind: "run"; number: number; source: Link<DocumentId> & Readonly<{ value: string }>;
    configuration: Link<FormId> & Readonly<{ value: Connection }>; transfer: Link<FormId> & Readonly<{ value: TransferSettings }>; mode: string }>;
type RunLog = Readonly<{ kind: "log"; runId: number; ordinal: number; message: string; progress: number }>;
type RunInfo = Readonly<{ id: number; number: number; status: Status; progress: number; logs: readonly number[] }>;
export type InspectionId = number | DocumentId | FormId;
type Inspection = Readonly<{ id: InspectionId; title: string; text: string; preview: string | null; links: readonly Readonly<{ label: string; id: InspectionId }>[] }>;
export type RunResourcesSnapshot = Readonly<{ runs: readonly RunInfo[]; selected: InspectionId | null; inspection: Inspection | null }>;

/** Immutable captured inputs/log entries; transient progress and inspector selection belong to the host. */
export class RunResources {
    private readonly workspace: Workspace;
    private readonly source: TextResourceHandle;
    private readonly configuration: FormSave<Connection>;
    private readonly transfer: FormSave<TransferSettings>;
    private readonly cell = new HostCell<RunResourcesSnapshot>({ runs: [], selected: null, inspection: null });
    readonly state = this.cell.observable;
    private readonly entries = new Map<number, RunInput | RunLog>();
    private readonly pending = new Set<number>();
    private disposed = false;
    constructor(workspace: Workspace, source: TextResourceHandle, configuration: FormSave<Connection>, transfer: FormSave<TransferSettings>) {
        this.workspace = workspace; this.source = source; this.configuration = configuration; this.transfer = transfer;
    }
    validation(): string | null { const s = this.transfer.values.getSnapshot(); return transferValidation(s.value); }
    start(submission: SubmittedRun): number {
        if (this.disposed) throw new Error("Run resources are disposed.");
        const error = this.validation(), transfer = this.transfer.values.getSnapshot();
        if (error) throw new Error(error);
        const id = this.entries.size + 1;
        const number = this.cell.get().runs.length + 1;
        const { source, configuration } = submission;
        const input: RunInput = Object.freeze({ kind: "run", number, mode: submission.settings.mode,
            source: Object.freeze({ id: source.id, revision: source.revision,
                serverVersion: source.serverVersion, value: source.value }),
            configuration: Object.freeze({ id: configuration.id, revision: configuration.revision,
                serverVersion: configuration.serverVersion, value: configuration.value }),
            transfer: Object.freeze({ id: this.transfer.id, revision: transfer.revision,
                serverVersion: transfer.serverVersion, value: transfer.value }),
        });
        this.pending.add(id);
        this.entries.set(id, input);
        const log = this.entries.size + 1;
        this.entries.set(log, { kind: "log", runId: id, ordinal: 1, progress: 0,
            message: "Run started with captured source, configuration and transfer settings." });
        this.cell.set({ ...this.cell.get(), runs: [...this.cell.get().runs,
            { id, number, status: "running", progress: 0, logs: [log] }] });
        return id;
    }
    private log(id: number, message: string, progress: number, status: Status = "running"): void {
        const current = this.cell.get().runs.find(run => run.id === id);
        if (!current) return;
        const key = this.entries.size + 1;
        this.entries.set(key, { kind: "log", runId: id, ordinal: current.logs.length + 1, message, progress });
        this.cell.set({ ...this.cell.get(), runs: this.cell.get().runs.map(run =>
            run.id === id ? { ...run, status, progress, logs: [...run.logs, key] } : run) });
    }
    readonly advance = (id: number): void => { if (this.disposed || !this.pending.has(id)) return; const current = this.cell.get().runs.find(run => run.id === id)!;
        if (current.progress >= 90) return; const progress = Math.min(90, current.progress + 30); this.log(id, `Synthetic progress ${progress}%. Captured inputs are unchanged.`, progress); };
    finish(id: number, status: Exclude<Status, "running">): void {
        if (!this.pending.delete(id)) return;
        this.log(id, status === "completed" ? "Run completed." : status === "failed" ? "Run failed. Captured inputs and prior logs are retained." : "Run interrupted during host disposal.", status === "completed" ? 100 : this.cell.get().runs.find(run => run.id === id)!.progress, status);
    }
    readonly open = (id: InspectionId): void => {
        if (this.disposed) return;
        const inspection = this.readInspection(id);
        if (inspection) this.cell.set({ ...this.cell.get(), selected: id, inspection });
    };
    capture(id: number): RunInput | null {
        const value = this.entries.get(id);
        return value?.kind === "run" ? value : null;
    }
    inspect(): Inspection | null { return this.cell.get().inspection; }
    private readInspection(id: InspectionId): Inspection | null {
        if (typeof id === "number") {
            const value = this.entries.get(id);
            if (!value) return null;
            return value.kind === "log" ? { id, title: "Run " + this.capture(value.runId)!.number + " log " + value.ordinal, text: value.message, preview: null, links: [{ label: "Inspect captured Run", id: value.runId }] }
                : { id, title: "Run " + value.number, text: `Captured source ${value.source.id} revision ${value.source.revision}, ${value.source.value.length} UTF-16 units (preview limited to 512); configuration ${value.configuration.id} revision ${value.configuration.revision} (${value.configuration.value.path}); transfer ${value.transfer.id} revision ${value.transfer.revision} (${value.transfer.value.destination}, batch ${value.transfer.value.batchSize}); mode ${value.mode}.`,
                    preview: value.source.value.slice(0, 512), links: [{ label: "Inspect current source", id: value.source.id }, { label: "Inspect current configuration", id: value.configuration.id }, { label: "Inspect current transfer settings", id: value.transfer.id }] };
        }
        if (id === this.source.id) { const d = this.workspace.document(this.source.id); return { id, title: "Current source", text: `Working source revision ${d.revision} at inspection. Refresh to inspect later edits; captured Run inputs remain separate.`, preview: d.buffer.slice(0, Math.min(512, d.buffer.length)), links: [] }; }
        if (id !== this.configuration.id && id !== this.transfer.id) return null;
        const handle = id === this.configuration.id ? this.configuration : this.transfer, current = handle.values.getSnapshot();
        return { id, title: handle.title, text: `Current resource ${id} revision ${current.revision} at inspection. Refresh to inspect later edits; captured Run inputs remain separate.`, preview: JSON.stringify(current.value).slice(0, 512), links: [] };
    }
    debug() { return { runs: this.cell.get().runs, selected: this.cell.get().selected, pending: this.pending.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const id of this.pending.keys()) this.finish(id, "interrupted");
    }
}
