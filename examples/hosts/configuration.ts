import { HostCell } from "../shared/observable.ts";
import type { ResourceHandle, ResourceTarget, SaveResponse, SaveReview, SaveSubmission, Workspace, WorkspaceCommands } from "../../src/index.ts";
import type { Connection } from "./controller.ts";

type Conflict = Readonly<{ version: string; value: Connection | null }>;
type State = Readonly<{ pending: boolean; message: string; conflict: Conflict | null; preview: string | null }>;
type Pending = Readonly<{ submission: SaveSubmission<Connection>; resolve: (response: SaveResponse<Connection>) => void; reject: (error: Error) => void }>;
type Reviewed = Readonly<{ target: ResourceTarget; version: string; baseline: string | null }>;

export function configurationValidation(value: Connection): string | null {
    return typeof value.path !== "string" || !value.path.trim() ? "Path is required."
        : value.format !== "csv" ? "This fixture supports CSV configuration only." : null;
}

/** Host policy and deferred local service; the generic resource save ticket owns capture/receipts. */
export class ConfigurationSave {
    private readonly workspace: Workspace;
    private readonly commands: WorkspaceCommands;
    private readonly resource: ResourceHandle<Connection>;
    private readonly track: (task: Promise<unknown>) => void;
    private readonly cell = new HostCell<State>({ pending: false, message: "Configuration is saved independently of source and Run.", conflict: null, preview: null });
    readonly state = this.cell.observable;
    private request: Pending | undefined;
    private reviewed: Reviewed | undefined;
    private serverValue: Connection;
    private serverVersion: string | null;
    private serial = 0;
    private disposed = false;
    constructor(workspace: Workspace, commands: WorkspaceCommands, resource: ResourceHandle<Connection>, track: (task: Promise<unknown>) => void) {
        this.workspace = workspace; this.commands = commands; this.resource = resource; this.track = track;
        const initial = resource.getSnapshot(); if (initial.state !== "ready") throw new Error("Configuration fixture must start ready.");
        this.serverValue = initial.value; this.serverVersion = initial.metadata.serverVersion;
    }
    validation(): string | null { const s = this.resource.getSnapshot(); return s.state === "ready" ? configurationValidation(s.value) : "Configuration is unavailable."; }
    private available(): boolean {
        const s = this.resource.getSnapshot(); return !this.disposed && !this.cell.get().pending && s.state === "ready"
            && s.metadata.capabilities.save && s.metadata.editLock === null && s.metadata.saveStatus !== "saving" && this.validation() === null;
    }
    canSave(): boolean { const m = this.resource.metadata.getSnapshot(); return this.available() && (m.dirty || m.saveStatus === "failed") && this.cell.get().conflict === null; }
    canReview(): boolean { return !this.disposed && !this.cell.get().pending && this.cell.get().conflict !== null && this.resource.getSnapshot().state === "ready"; }
    canSaveReviewed(): boolean { return this.available() && this.reviewed !== undefined && this.cell.get().conflict !== null
        && this.workspace.resolveResource(this.reviewed.target) === this.resource && this.resource.metadata.getSnapshot().serverVersion === this.reviewed.baseline; }
    private publish(patch: Partial<State>): void { if (!this.disposed) this.cell.set({ ...this.cell.get(), ...patch }); }
    readonly save = (): void => {
        if (this.disposed || this.cell.get().pending) return;
        if (!this.canSave()) { this.publish({ message: this.validation() ?? (this.cell.get().conflict ? "Review the remote configuration before saving." : "Configuration is saved or saving is unavailable.") }); return; }
        this.submit();
    };
    private submit(review?: SaveReview): void {
        this.publish({ pending: true, message: "Saving captured configuration…" });
        if (this.disposed) return;
        try {
            const task = this.commands.save(this.resource, { save: submission => {
                if (this.disposed) throw new Error("Configuration save was interrupted.");
                return new Promise<SaveResponse<Connection>>((resolve, reject) => { this.request = { submission, resolve, reject }; this.publish({ message: "Configuration request captured. Editing and Run remain independent." }); });
            } }, review).then(result => {
                if (this.disposed) return;
                if (result.kind === "saved") { this.reviewed = undefined; this.publish({ pending: false, conflict: null, preview: null, message: "Captured configuration saved. Later edits are retained." }); }
                else if (result.kind === "conflict") { this.reviewed = undefined; this.publish({ pending: false, conflict: { version: result.serverVersion, value: null }, preview: null, message: "Configuration save conflicted. Current values are retained; review the remote configuration." }); }
                else this.publish({ pending: false, message: "Configuration save failed. Current values are retained; retry when ready." });
            });
            this.track(task);
        } catch { this.publish({ pending: false, message: "Configuration save is unavailable. Current values are retained." }); }
    }
    readonly finish = (): void => {
        if (this.disposed) return; const request = this.request; this.request = undefined; if (!request) return;
        if (request.submission.expectedServerVersion !== this.serverVersion) { request.resolve({ kind: "conflict", serverVersion: this.serverVersion ?? "configuration-v0" }); return; }
        this.serverValue = Object.freeze({ ...request.submission.value, path: request.submission.value.path.trim() });
        this.serverVersion = `configuration-v${++this.serial}`;
        request.resolve({ kind: "saved", serverVersion: this.serverVersion, canonical: this.serverValue });
    };
    readonly fail = (): void => { if (this.disposed) return; const request = this.request; this.request = undefined; request?.reject(new Error("Synthetic configuration save failure")); };
    readonly externalWrite = (path = "remote.csv"): void => {
        if (this.disposed) return; this.serverValue = Object.freeze({ ...this.serverValue, path }); this.serverVersion = `configuration-v${++this.serial}`;
        this.publish({ message: "Synthetic remote configuration changed. Local values are retained." });
    };
    readonly review = (): void => {
        if (!this.canReview()) return; const current = this.resource.getSnapshot(); if (current.state !== "ready") return;
        const version = this.serverVersion ?? "configuration-v0", text = JSON.stringify(this.serverValue, null, 2);
        this.reviewed = Object.freeze({ target: this.workspace.captureResource(this.resource.id), version, baseline: current.metadata.serverVersion });
        this.publish({ conflict: { version, value: this.serverValue }, preview: text.slice(0, 4096) + (text.length > 4096 ? "\n… Preview limited to 4,096 characters; full server value retained." : ""), message: "Remote configuration captured. Correct local fields, then save the reviewed configuration." });
    };
    readonly saveReviewed = (): void => {
        if (this.disposed || this.cell.get().pending) return;
        if (!this.canSaveReviewed()) { this.publish({ message: this.validation() ?? "Configuration review expired or saving is unavailable. Review again." }); return; }
        this.submit({ target: this.reviewed!.target, expectedRevision: this.resource.getSnapshot().revision, expectedServerVersion: this.reviewed!.version });
    };
    statusText(): string {
        const m = this.resource.metadata.getSnapshot(), state = this.cell.get();
        return `Configuration ${m.dirty ? "Unsaved" : "Saved"} · Save status: ${state.pending ? "saving" : m.saveStatus} · ${this.validation() ?? state.message}`;
    }
    capture() { const s = this.request?.submission; return s ? Object.freeze({ resourceId: s.target.id, revision: s.revision, value: s.value, expectedServerVersion: s.expectedServerVersion }) : null; }
    debug() { return Object.freeze({ pending: this.cell.get().pending, request: this.request ? { resourceId: this.request.submission.target.id, revision: this.request.submission.revision, expectedServerVersion: this.request.submission.expectedServerVersion } : null,
        conflictVersion: this.cell.get().conflict?.version ?? null, reviewedVersion: this.reviewed?.version ?? null, reviewReady: this.canSaveReviewed(), subscriptions: this.cell.count(), disposed: this.disposed }); }
    dispose(): void { if (this.disposed) return; this.disposed = true; this.cell.set({ ...this.cell.get(), pending: false }); const request = this.request; this.request = undefined; request?.reject(new Error("Configuration save was interrupted.")); }
}
