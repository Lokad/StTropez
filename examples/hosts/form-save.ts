import { HostCell } from "../shared/observable.ts";
import type { Immutable, Observable, ResourceHandle, ResourceSnapshot, ResourceTarget, SaveResponse, SaveReview, SaveSubmission, SnapshotValue, Workspace, WorkspaceCommands } from "../../src/index.ts";

type State<T> = Readonly<{ pending: boolean; message: string; conflict: Readonly<{ version: string; value: Immutable<T> | null }> | null; preview: string | null }>;
type Pending<T> = Readonly<{ submission: SaveSubmission<T>; resolve: (response: SaveResponse<T>) => void; reject: (error: Error) => void }>;
type Reviewed = Readonly<{ target: ResourceTarget; version: string; baseline: string | null }>;
export type FormSavePresentation<T> = Readonly<{ title: string; noun: string; resource: ResourceSnapshot<T>; status: string; validation: string | null; preview: string | null;
    canSave: boolean; canReview: boolean; canSaveReviewed: boolean; capture: SaveSubmission<T> | null; review: Reviewed | null; disposed: boolean }>;
export type FormPolicy<T> = Readonly<{ title: string; noun: string; prefix: string; validate: (value: Immutable<T>) => string | null;
    canonical: (value: Immutable<T>) => Immutable<T>; external: (value: Immutable<T>, text?: string) => Immutable<T> }>;

/** Deferred host fixture; core owns immutable capture, serialized saves and guarded receipts. */
export class FormSave<T extends SnapshotValue> {
    private readonly workspace: Workspace;
    private readonly commands: WorkspaceCommands;
    private readonly resource: ResourceHandle<T>;
    private readonly track: (task: Promise<unknown>) => void;
    private readonly policy: FormPolicy<T>;
    private readonly cell: HostCell<State<T>>;
    readonly state;
    readonly presentation: Observable<FormSavePresentation<T>>;
    private cached: { state: State<T>; resource: ResourceSnapshot<T>; request: Pending<T> | undefined; reviewed: Reviewed | undefined; reviewCurrent: boolean; disposed: boolean; value: FormSavePresentation<T> } | undefined;
    private request: Pending<T> | undefined;
    private reviewed: Reviewed | undefined;
    private serverValue: Immutable<T>;
    private serverVersion: string | null;
    private serial = 0;
    private disposed = false;
    constructor(workspace: Workspace, commands: WorkspaceCommands, resource: ResourceHandle<T>, track: (task: Promise<unknown>) => void, policy: FormPolicy<T>) {
        this.workspace = workspace; this.commands = commands; this.resource = resource; this.track = track; this.policy = policy;
        const initial = resource.getSnapshot(); if (initial.state !== "ready") throw new Error(`${policy.title} fixture must start ready.`);
        this.serverValue = initial.value(); this.serverVersion = initial.metadata.serverVersion;
        this.cell = new HostCell<State<T>>({ pending: false, message: `${policy.title} is saved independently of source and Run.`, conflict: null, preview: null }); this.state = this.cell.observable;
        this.presentation = Object.freeze({ getSnapshot: () => this.presentationSnapshot(), subscribe: (listener: () => void) => {
            const stopState = this.state.subscribe(listener);
            try { const stopResource = this.resource.subscribe(listener); return () => { stopResource(); stopState(); }; }
            catch (error) { stopState(); throw error; }
        } });
    }
    private presentationSnapshot(): FormSavePresentation<T> {
        const state = this.cell.get(), resource = this.resource.getSnapshot(), request = this.request, reviewed = this.reviewed, disposed = this.disposed, cached = this.cached;
        const reviewCurrent = reviewed !== undefined && this.workspace.resolveResource(reviewed.target) === this.resource;
        if (cached && cached.state === state && cached.resource === resource && cached.request === request && cached.reviewed === reviewed && cached.reviewCurrent === reviewCurrent && cached.disposed === disposed) return cached.value;
        const validation = resource.state === "ready" ? this.policy.validate(resource.value()) : `${this.policy.title} is unavailable.`, metadata = resource.metadata;
        const available = !disposed && !state.pending && resource.state === "ready" && metadata.capabilities.save && metadata.editLock === null && metadata.saveStatus !== "saving" && validation === null;
        const value: FormSavePresentation<T> = Object.freeze({ title: this.policy.title, noun: this.policy.noun, resource, validation, preview: state.preview, disposed,
            status: `${this.policy.title} ${metadata.dirty ? "Unsaved" : "Saved"} · Save status: ${state.pending ? "saving" : metadata.saveStatus} · ${validation ?? state.message}`,
            canSave: available && (metadata.dirty || metadata.saveStatus === "failed") && state.conflict === null,
            canReview: !disposed && !state.pending && state.conflict !== null && resource.state === "ready",
            canSaveReviewed: available && reviewed !== undefined && state.conflict !== null && reviewCurrent && metadata.serverVersion === reviewed.baseline,
            capture: request?.submission ?? null, review: reviewed ?? null });
        this.cached = { state, resource, request, reviewed, reviewCurrent, disposed, value }; return value;
    }
    validation(): string | null { return this.presentation.getSnapshot().validation; }
    canSave(): boolean { return this.presentation.getSnapshot().canSave; }
    canReview(): boolean { return this.presentation.getSnapshot().canReview; }
    canSaveReviewed(): boolean { return this.presentation.getSnapshot().canSaveReviewed; }
    private publish(patch: Partial<State<T>>): void { if (!this.disposed) this.cell.set({ ...this.cell.get(), ...patch }); }
    readonly save = (): void => {
        if (this.disposed || this.cell.get().pending) return;
        if (!this.canSave()) { this.publish({ message: this.validation() ?? (this.cell.get().conflict ? `Review the remote ${this.policy.noun} before saving.` : `${this.policy.title} is saved or saving is unavailable.`) }); return; }
        this.submit();
    };
    private submit(review?: SaveReview): void {
        this.publish({ pending: true, message: `Saving captured ${this.policy.noun}…` }); if (this.disposed) return;
        try {
            const task = this.commands.save(this.resource, { save: submission => {
                if (this.disposed) throw new Error(`${this.policy.title} save was interrupted.`);
                return new Promise<SaveResponse<T>>((resolve, reject) => { this.request = { submission, resolve, reject }; this.publish({ message: `${this.policy.title} request captured. Editing and Run remain independent.` }); });
            } }, review).then(result => {
                if (this.disposed) return;
                if (result.kind === "saved") { this.reviewed = undefined; this.publish({ pending: false, conflict: null, preview: null, message: `Captured ${this.policy.noun} saved. Later edits are retained.` }); }
                else if (result.kind === "conflict") { this.reviewed = undefined; this.publish({ pending: false, conflict: { version: result.serverVersion, value: null }, preview: null, message: `${this.policy.title} save conflicted. Current values are retained; review the remote ${this.policy.noun}.` }); }
                else this.publish({ pending: false, message: `${this.policy.title} save failed. Current values are retained; retry when ready.` });
            }); this.track(task);
        } catch { this.publish({ pending: false, message: `${this.policy.title} save is unavailable. Current values are retained.` }); }
    }
    readonly finish = (expected: SaveSubmission<T> | null = this.request?.submission ?? null): void => {
        if (this.disposed) return; const request = this.request; if (!request || request.submission !== expected) return; this.request = undefined;
        if (request.submission.expectedServerVersion !== this.serverVersion) request.resolve({ kind: "conflict", serverVersion: this.serverVersion ?? `${this.policy.prefix}-v0` });
        else {
            this.serverValue = this.policy.canonical(request.submission.value); this.serverVersion = `${this.policy.prefix}-v${++this.serial}`;
            // SavePort accepts T; this fixture supplies its already immutable form snapshot. Core copies it again.
            request.resolve({ kind: "saved", serverVersion: this.serverVersion, canonical: this.serverValue as T });
        }
        this.publish({});
    };
    readonly fail = (expected: SaveSubmission<T> | null = this.request?.submission ?? null): void => { if (this.disposed) return; const request = this.request; if (!request || request.submission !== expected) return;
        this.request = undefined; request.reject(new Error(`Synthetic ${this.policy.noun} save failure`)); this.publish({}); };
    readonly externalWrite = (text?: string): void => { if (this.disposed) return; this.serverValue = this.policy.external(this.serverValue, text); this.serverVersion = `${this.policy.prefix}-v${++this.serial}`;
        this.publish({ message: `Synthetic remote ${this.policy.noun} changed. Local values are retained.` }); };
    readonly review = (): void => {
        if (!this.canReview()) return; const current = this.resource.getSnapshot(); if (current.state !== "ready") return;
        const version = this.serverVersion ?? `${this.policy.prefix}-v0`, text = JSON.stringify(this.serverValue, null, 2);
        this.reviewed = Object.freeze({ target: this.workspace.captureResource(this.resource.id), version, baseline: current.metadata.serverVersion });
        this.publish({ conflict: { version, value: this.serverValue }, preview: text.slice(0, 4096) + (text.length > 4096 ? "\n… Preview limited to 4,096 characters; full server value retained." : ""), message: `Remote ${this.policy.noun} captured. Correct local fields, then save the reviewed ${this.policy.noun}.` });
    };
    readonly saveReviewed = (expected: Reviewed | null = this.reviewed ?? null): void => { if (this.disposed || this.cell.get().pending || expected !== (this.reviewed ?? null)) return;
        if (!this.canSaveReviewed()) { this.publish({ message: this.validation() ?? `${this.policy.title} review expired or saving is unavailable. Review again.` }); return; }
        this.submit({ target: this.reviewed!.target, expectedRevision: this.resource.getSnapshot().revision, expectedServerVersion: this.reviewed!.version }); };
    statusText(): string { return this.presentation.getSnapshot().status; }
    capture() { const s = this.request?.submission; return s ? Object.freeze({ resourceId: s.target.id, revision: s.revision, value: s.value, expectedServerVersion: s.expectedServerVersion }) : null; }
    debug() { return Object.freeze({ pending: this.cell.get().pending, request: this.request ? { resourceId: this.request.submission.target.id, revision: this.request.submission.revision, expectedServerVersion: this.request.submission.expectedServerVersion } : null,
        conflictVersion: this.cell.get().conflict?.version ?? null, reviewedVersion: this.reviewed?.version ?? null, reviewReady: this.canSaveReviewed(), subscriptions: this.cell.count(), disposed: this.disposed }); }
    dispose(): void { if (this.disposed) return; this.disposed = true; const request = this.request; this.request = undefined; this.cell.set({ ...this.cell.get(), pending: false }); request?.reject(new Error(`${this.policy.title} save was interrupted.`)); }
}
