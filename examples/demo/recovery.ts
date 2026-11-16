import type { DocumentSnapshot, Observable, ResourceMetadata, ResourceTarget, TabTarget } from "../../src/index.ts";
import type { Workspace } from "../../src/index.ts";
import { HostCell } from "../shared/observable.ts";
import { createBrowserDraftStore } from "../hosts/draft-store.ts";
import type { DraftStore, StoredDraft } from "../hosts/draft-store.ts";
import type { DemoFile } from "./project.ts";
import { CleanupScope } from "../shared/cleanup-scope.ts";

type Draft = Readonly<{ version: 1; sample: string; baseVersion: string | null; files: Readonly<Record<string, string>> }>;
type Capture = readonly Readonly<{ file: DemoFile; document: DocumentSnapshot; metadata: ResourceMetadata; target: ResourceTarget; tab: TabTarget }>[];
type Offer = Readonly<{ envelope: StoredDraft; draft: Draft; capture: Capture }>;
type RecoveryState = Readonly<{ status: "checking" | "idle" | "pending" | "writing" | "protected" | "offer" | "failed";
    busy: boolean; present: boolean; message: string }>;
type Inventory = Readonly<{ names: readonly string[]; unloaded: () => Readonly<Record<string, string>>; prepare: () => void }>;

function decode(envelope: StoredDraft, sample: string, names: readonly string[]): Draft {
    const value = envelope.value as Partial<Draft> | null;
    if (envelope.token === "invalid" || !value || value.version !== 1 || value.sample !== sample || value.baseVersion !== null && typeof value.baseVersion !== "string"
        || !value.files || typeof value.files !== "object" || Array.isArray(value.files) || Object.keys(value.files).length !== names.length
        || names.some(name => !Object.hasOwn(value.files!, name) || typeof value.files![name] !== "string" || value.files![name]!.length > 8_000_000)) {
        throw new Error("The recovery draft cannot be read. It has been left untouched.");
    }
    return value as Draft;
}

function matches(capture: Capture, draft: Draft): boolean {
    return capture.every(item => {
        const buffer = item.document.buffer, text = draft.files[item.file.name]!;
        if (buffer.length !== text.length) return false;
        let offset = 0;
        for (const chunk of buffer.chunks()) {
            if (chunk !== text.slice(offset, offset + chunk.length)) return false;
            offset += chunk.length;
        }
        return true;
    });
}

/** Multi-file demo policy. Reuses the fixture's CAS store; no alternate document/history engine. */
export class DemoRecovery {
    private readonly workspace: Workspace;
    private readonly getFiles: () => readonly DemoFile[];
    private get files(): readonly DemoFile[] { return this.getFiles(); }
    private readonly inventory: Inventory | undefined;
    private readonly sample: string;
    private readonly baseVersion: () => string | null;
    private readonly inputIdle: () => boolean;
    private readonly store: DraftStore;
    private readonly cell = new HostCell<RecoveryState>({ status: "checking", busy: false, present: false, message: "Checking recovery…" });
    readonly state: Observable<RecoveryState> = this.cell.observable;
    private token: string | null = null;
    private checkpointed: Capture | undefined;
    private offer: Offer | undefined;
    private loaded = false;
    private disposed = false;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private running: Promise<void> | undefined;
    private refreshRequested = false;
    private generation = 0;
    private observed: Capture;
    private readonly owners = new CleanupScope();
    private disposal: Promise<void> | undefined;

    constructor(workspace: Workspace, files: readonly DemoFile[] | (() => readonly DemoFile[]), sample: string, baseVersion: () => string | null,
        inputIdle: () => boolean, store = createBrowserDraftStore(window, { name: "sttropez-demo-recovery-v1", slot: sample }), inventory?: Inventory) {
        this.workspace = workspace; this.getFiles = typeof files === "function" ? files : () => files; this.inventory = inventory; this.sample = sample; this.baseVersion = baseVersion;
        this.inputIdle = inputIdle; this.store = store; this.observed = this.capture();
        try {
            this.owners.defer(workspace.subscribe(() => this.filesChanged()));
            this.owners.defer(store.watch(() => { void this.refresh(); }));
            void this.refresh();
        } catch (error) { this.disposed = true; this.owners.rollback(error); }
    }
    filesChanged(): void {
        const next = this.capture();
        if (next.length === this.observed.length && next.every((item, index) => item.document.id === this.observed[index]!.document.id
            && item.document.buffer === this.observed[index]!.document.buffer && item.metadata.dirty === this.observed[index]!.metadata.dirty
            && item.metadata.serverVersion === this.observed[index]!.metadata.serverVersion)) return;
        this.observed = next; this.generation++; this.schedule();
    }
    private capture(): Capture {
        return this.files.map(file => ({ file, document: this.workspace.document(file.resource.documentId), metadata: file.resource.metadata.getSnapshot(),
            target: this.workspace.captureResource(file.resource.id), tab: this.workspace.captureTab(file.tab) }));
    }
    private targetsCurrent(capture: Capture): boolean {
        const files = this.files;
        return !this.disposed && this.inputIdle() && capture.length === files.length && capture.every(item => files.includes(item.file) && this.workspace.resolveResource(item.target) === item.file.resource
            && this.workspace.resolveTab(item.tab)?.surface.kind === "text" && this.workspace.ownsDocumentView(item.file.view)
            && this.workspace.document(item.document.id).revision === item.document.revision
            && item.file.resource.metadata.getSnapshot() === item.metadata && item.metadata.editLock === null
            && item.metadata.saveStatus !== "saving" && item.metadata.capabilities.edit.includes("human"));
    }
    private publish(status: RecoveryState["status"], message: string): void {
        if (!this.disposed) this.cell.set({ status, busy: this.running !== undefined, present: this.offer !== undefined, message });
    }
    private offerMessage(): string {
        return `This browser has an unsaved draft for ${this.files.map(file => file.name).join(", ")}. Restore it, download it, or keep your current files.`;
    }
    private cancelTimer(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
    private schedule(): void {
        this.cancelTimer();
        if (this.disposed || !this.loaded || this.running || this.offer || this.cell.get().status === "failed") return;
        if (!this.dirty() && this.token === null) return;
        if (this.checkpointed && this.observed.length === this.checkpointed.length && this.observed.every((item, index) => item.document.id === this.checkpointed![index]!.document.id && item.document.buffer === this.checkpointed![index]!.document.buffer
            && item.metadata.dirty === this.checkpointed![index]!.metadata.dirty && item.metadata.serverVersion === this.checkpointed![index]!.metadata.serverVersion)) return;
        this.publish("pending", "Updating recovery…");
        // The input/notification path compares immutable handles; text export happens only here.
        this.timer = setTimeout(() => { this.timer = undefined; void this.checkpoint(); }, 300);
    }
    private run(action: () => Promise<void>): Promise<void> {
        if (this.disposed || this.running) return this.running ?? Promise.resolve();
        this.cancelTimer();
        const generation = this.generation;
        // Start on a microtask so running is installed before any publication or store callback.
        this.running = Promise.resolve().then(action).catch(error => {
            this.publish("failed", error instanceof Error ? error.message : "Recovery is unavailable. Your edits are intact.");
        }).finally(() => {
            this.running = undefined;
            if (this.disposed) return;
            this.cell.set({ ...this.cell.get(), busy: false });
            if (this.refreshRequested) { this.refreshRequested = false; void this.refresh(); }
            else if (generation !== this.generation) this.schedule();
        });
        return this.running;
    }
    refresh(): Promise<void> {
        if (this.disposed) return Promise.resolve();
        if (this.running) { this.refreshRequested = true; return this.running; }
        let capture = this.capture();
        return this.run(async () => {
            this.publish("checking", "Checking recovery…");
            const envelope = await this.store.read(); if (this.disposed) return;
            this.loaded = true;
            if (envelope?.token === this.token && !this.offer) {
                if (envelope && !this.dirty() && this.targetsCurrent(capture)) {
                    await this.store.remove(envelope.token);
                    if (!this.disposed) { this.token = null; this.checkpointed = undefined; this.publish("idle", "All changes are saved."); }
                    return;
                }
                this.publish(this.token ? "protected" : "idle", this.token ? "Recovery draft captured in this browser." : "Recovery is ready.");
                return;
            }
            this.offer = undefined;
            this.checkpointed = undefined;
            if (envelope) {
                const draft = decode(envelope, this.sample, this.inventory?.names ?? this.files.map(file => file.name));
                // A complete draft may name a file that has no editor resource yet. Materialize
                // the saved/default inventory before offering an atomic restore, retaining any
                // stale original capture so loading can never silently authorize later edits.
                if (this.inventory && this.files.length !== this.inventory.names.length) {
                    const originalCurrent = this.targetsCurrent(capture); this.inventory.prepare();
                    if (originalCurrent) capture = this.capture();
                }
                // A save may finish just before the page closes, ahead of deferred draft cleanup.
                // Compare content during this asynchronous read, never on an edit notification.
                // Only the exact redundant token can be removed; distinct peer work stays offered.
                if (this.targetsCurrent(capture) && matches(capture, draft)) {
                    if (capture.some(item => item.metadata.dirty)) {
                        this.token = envelope.token; this.checkpointed = capture;
                        this.publish("protected", "Recovery draft captured in this browser.");
                    } else {
                        await this.store.remove(envelope.token);
                        if (!this.disposed) { this.token = null; this.publish("idle", "All changes are saved."); }
                    }
                    return;
                }
                this.offer = { envelope, draft, capture }; this.token = envelope.token;
                this.publish("offer", this.offerMessage());
            } else { this.token = null; this.publish("idle", "Recovery is ready."); }
        }).then(() => { if (!this.disposed && !this.offer && this.dirty() && !this.running) this.schedule(); });
    }
    private dirty(): boolean { return this.files.some(file => file.resource.metadata.getSnapshot().dirty); }
    /** Save completion must not leave this page's older draft behind a deferred cleanup timer. */
    async settleSavedDraft(): Promise<void> {
        if (this.disposed || this.dirty()) return;
        this.cancelTimer();
        while (!this.disposed && this.running) await this.running;
        if (this.disposed) return;
        if (this.dirty()) { this.schedule(); return; }
        // An offered draft belongs to another page/session until explicitly claimed or discarded.
        if (this.loaded && !this.offer) await this.checkpoint();
    }
    private checkpoint(): Promise<void> {
        if (this.disposed || this.offer || !this.loaded) return Promise.resolve();
        const capture = this.capture(), dirty = this.dirty(), expected = this.token, baseVersion = this.baseVersion(), unloaded = { ...this.inventory?.unloaded() };
        return this.run(async () => {
            this.publish("writing", "Updating recovery…");
            if (!dirty) {
                if (expected) await this.store.remove(expected);
                if (!this.disposed) { this.token = null; this.checkpointed = undefined; this.publish("idle", "All changes are saved."); }
                return;
            }
            const token = crypto.randomUUID();
            const draft: Draft = { version: 1, sample: this.sample, baseVersion,
                files: { ...unloaded, ...Object.fromEntries(capture.map(item => [item.file.name, item.document.text()])) } };
            await this.store.write({ token, value: draft }, expected);
            if (!this.disposed) { this.token = token; this.checkpointed = capture; this.publish("protected", "Recovery draft captured in this browser."); }
        });
    }
    canRestore(): boolean { return !this.running && !!this.offer && this.targetsCurrent(this.offer.capture); }
    download(): string | undefined { return this.offer ? JSON.stringify(this.offer.draft, null, 2) : undefined; }
    restore(): Promise<void> {
        if (!this.canRestore()) return Promise.resolve();
        const offer = this.offer!, token = crypto.randomUUID();
        return this.run(async () => {
            this.publish("offer", "Restoring the captured draft…");
            // Claim the exact offered token in a write transaction before applying any editor edits.
            await this.store.write({ token, value: offer.draft }, offer.envelope.token);
            if (this.disposed) return;
            this.token = token; this.offer = { ...offer, envelope: { token, value: offer.draft } };
            if (!this.targetsCurrent(offer.capture)) {
                this.publish("offer", "Your files changed while restoring. They were left intact; download the draft or keep current files."); return;
            }
            const result = this.workspace.editDocuments(offer.capture.map(item => ({ documentId: item.document.id, expectedRevision: item.document.revision,
                origin: "host", history: { kind: "replace" }, edits: [{ from: 0, to: item.document.buffer.length, insert: offer.draft.files[item.file.name]! }] })));
            if (!result.applied) { this.publish("offer", "Restore is unavailable. Your current files are intact."); return; }
            this.offer = undefined; this.checkpointed = this.capture(); this.publish("protected", "Draft restored. Undo returns to your previous files; Save locally commits these changes.");
        });
    }
    keepCurrent(): Promise<void> {
        if (!this.offer) return Promise.resolve();
        const expected = this.offer.envelope.token;
        return this.run(async () => {
            this.publish("offer", "Discarding the offered draft…");
            await this.store.remove(expected);
            if (this.disposed) return;
            this.token = null; this.offer = undefined; this.checkpointed = undefined; this.publish("idle", "Kept your current files."); this.generation++;
        });
    }
    dispose(): Promise<void> {
        if (this.disposal) return this.disposal;
        this.disposed = true; this.cancelTimer();
        const errors: unknown[] = [], running = this.running;
        // Publish completion before callbacks so repeated/reentrant disposal shares ownership.
        this.disposal = Promise.resolve().then(async () => {
            try { await running; } catch (error) { errors.push(error); }
            try { await this.store.close(); } catch (error) { errors.push(error); }
            if (errors.length === 1) throw errors[0];
            if (errors.length) throw new AggregateError(errors, "Recovery cleanup failed.");
        });
        try { this.owners.dispose(); } catch (error) { errors.push(error); }
        return this.disposal;
    }
}
