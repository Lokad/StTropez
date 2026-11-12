import { TextBuffer, Workspace } from "../../src/index.ts";
import type { ComparisonBaseline, DocumentView, SaveReview, TabId, TextResourceHandle } from "../../src/index.ts";
import { createBrowserDraftStore } from "../hosts/draft-store.ts";
import type { DraftStore } from "../hosts/draft-store.ts";
import { demoSample } from "./samples.ts";
import type { DemoSample, SampleId } from "./samples.ts";
import { DemoRecovery } from "./recovery.ts";

export type DemoFile = Readonly<{ name: string; resource: TextResourceHandle; tab: TabId; view: DocumentView }>;
type StoredProject = Readonly<{ version: 1; files: Readonly<Record<string, string>> }>;
type Conflict = Readonly<{ token: string; baselines: ReadonlyMap<string, ComparisonBaseline> }>;

function readProject(value: unknown, names: readonly string[]): StoredProject {
    const candidate = value as Partial<StoredProject> | null;
    if (!candidate || candidate.version !== 1 || !candidate.files || Object.keys(candidate.files).length !== names.length
        || names.some(name => typeof candidate.files![name] !== "string" || candidate.files![name]!.length > 8_000_000)) {
        throw new Error("The saved project cannot be read. Its stored copy has been left untouched.");
    }
    return candidate as StoredProject;
}

/** The host composes existing workspace/save/storage primitives; it owns no alternative text model. */
export class DemoProject {
    readonly workspace = new Workspace();
    readonly files: readonly DemoFile[];
    readonly sample: DemoSample;
    readonly recovery: DemoRecovery;
    private readonly store: DraftStore;
    private token: string | null = null;
    private readonly baselines = new Map<string, ComparisonBaseline>();
    private disposed = false;
    private conflict: Conflict | undefined;
    private reviewedRevisions: readonly number[] | undefined;
    saving = false;
    message = "Changes are kept in this page until you save locally.";
    private constructor(id: SampleId, store: DraftStore, token: string | null, saved: StoredProject | null, inputIdle: () => boolean) {
        this.sample = demoSample(id); this.store = store; this.token = token;
        this.files = Object.entries(this.sample.files).map(([name, initial]) => {
            const resource = this.workspace.createTextResource({ scope: `demo:${id}`, resource: name, variant: "working" }, name,
                { value: saved?.files[name] ?? initial, serverVersion: token });
            const tab = this.workspace.open({ kind: "text", documentId: resource.documentId }, "editor");
            const view = this.workspace.createDocumentView(resource.documentId);
            this.baselines.set(name, { buffer: this.workspace.document(resource.documentId).buffer, version: token ?? "sample" });
            return { name, resource, tab, view };
        });
        if (saved) this.message = "Opened the copy saved in this browser.";
        this.recovery = new DemoRecovery(this.workspace, this.files, id, () => this.token, inputIdle);
    }
    static async open(id: SampleId, inputIdle: () => boolean): Promise<DemoProject> {
        const store = createBrowserDraftStore(window, { name: "sttropez-demo-projects-v1", slot: id });
        try {
            const stored = await store.read();
            let saved: StoredProject | null = null;
            if (stored) {
                const names = Object.keys(demoSample(id).files);
                saved = readProject(stored.value, names);
            }
            return new DemoProject(id, store, stored?.token ?? null, saved, inputIdle);
        } catch (error) {
            await store.close();
            // Storage failure must leave the editor available; saves continue to fail safely.
            const project = new DemoProject(id, createBrowserDraftStore(window, { name: "sttropez-demo-projects-v1", slot: id }), null, null, inputIdle);
            project.message = error instanceof Error ? error.message : "Local storage is unavailable. You can still edit.";
            return project;
        }
    }
    baseline(file: DemoFile): ComparisonBaseline {
        return this.reviewedRevisions ? this.conflict!.baselines.get(file.name)! : this.baselines.get(file.name)!;
    }
    dirty(): boolean { return this.files.some(file => file.resource.metadata.getSnapshot().dirty); }
    hasConflict(): boolean { return this.conflict !== undefined; }
    isReviewingConflict(): boolean { return this.reviewedRevisions !== undefined; }
    reviewConflict(): boolean {
        if (this.disposed || this.saving || !this.conflict) return false;
        this.reviewedRevisions = this.files.map(file => this.workspace.document(file.resource.documentId).revision);
        this.message = "Comparing against the other page's saved copy. Review each file before saving your version.";
        return true;
    }
    canSaveReviewed(): boolean {
        return !this.disposed && !this.saving && !!this.reviewedRevisions
            && this.files.every((file, i) => this.workspace.document(file.resource.documentId).revision === this.reviewedRevisions![i]);
    }
    download(): string {
        return JSON.stringify({ version: 1, files: Object.fromEntries(this.files.map(file => [file.name, this.workspace.document(file.resource.documentId).text])) }, null, 2);
    }
    async save(changed: () => void, reviewed = false): Promise<void> {
        if (this.disposed || this.saving) return;
        if (reviewed && !this.canSaveReviewed()) return;
        this.saving = true;
        const expected = reviewed ? this.conflict!.token : this.token;
        const tickets = this.files.map(file => ({ file, ticket: this.workspace.captureSave(file.resource, reviewed
            ? { target: this.workspace.captureResource(file.resource.id), expectedRevision: this.workspace.document(file.resource.documentId).revision,
                expectedServerVersion: expected! } satisfies SaveReview : undefined),
            buffer: this.workspace.document(file.resource.documentId).buffer }));
        const token = crypto.randomUUID();
        try {
            const submissions = tickets.map(({ ticket }) => ticket.start());
            this.message = "Saving locally…"; changed();
            await this.store.write({ token, value: { version: 1, files: Object.fromEntries(submissions.map((submission, i) => [tickets[i]!.file.name, submission.value])) } }, expected);
            if (this.disposed) return;
            this.token = token;
            this.conflict = undefined; this.reviewedRevisions = undefined;
            for (const { file, ticket, buffer } of tickets) {
                ticket.accept({ serverVersion: token }); this.baselines.set(file.name, { buffer, version: token });
            }
            this.message = "Saved in this browser. Later edits remain unsaved.";
        } catch (error) {
            // The store checks the captured token in one read/write transaction across every file.
            const remote = await this.store.read().catch(() => null);
            for (const { ticket } of tickets) { if (remote && remote.token !== expected) ticket.conflict(); else ticket.fail(); }
            this.reviewedRevisions = undefined;
            if (remote && remote.token !== expected) {
                try {
                    const saved = readProject(remote.value, this.files.map(file => file.name));
                    this.conflict = { token: remote.token, baselines: new Map(Object.entries(saved.files).map(([name, text]) => [name, { buffer: TextBuffer.from(text), version: remote.token }])) };
                } catch { this.conflict = undefined; }
            }
            this.message = remote && remote.token !== expected
                ? "Another page saved this sample. Your edits are intact. Review the saved copy or download your changes."
                : error instanceof Error ? `Could not save: ${error.message}` : "Could not save. Your edits are intact.";
        } finally {
            tickets.forEach(({ ticket }) => ticket.finish()); this.saving = false;
            if (this.disposed) this.release(); else changed();
        }
    }
    reset(): void {
        this.workspace.editDocuments(this.files.map(file => {
            const document = this.workspace.document(file.resource.documentId);
            return { documentId: document.id, expectedRevision: document.revision, origin: "host" as const,
                edits: [{ from: 0, to: document.buffer.length, insert: this.sample.files[file.name]! }] };
        }));
        this.message = "Sample restored. Undo restores your edits; Save locally replaces the saved copy.";
    }
    dispose(): void {
        if (this.disposed) return; this.disposed = true;
        this.recovery.dispose();
        if (!this.saving) this.release();
    }
    private release(): void {
        this.files.forEach(file => { file.view.dispose(); this.workspace.close(file.tab); this.workspace.releaseResource(file.resource.id, true); });
        void this.store.close();
    }
}
