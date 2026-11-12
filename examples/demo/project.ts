import { Workspace } from "../../src/index.ts";
import type { ComparisonBaseline, DocumentView, TabId, TextResourceHandle } from "../../src/index.ts";
import { createBrowserDraftStore } from "../hosts/draft-store.ts";
import type { DraftStore } from "../hosts/draft-store.ts";
import { demoSample } from "./samples.ts";
import type { DemoSample, SampleId } from "./samples.ts";

export type DemoFile = Readonly<{ name: string; resource: TextResourceHandle; tab: TabId; view: DocumentView }>;
type StoredProject = Readonly<{ version: 1; files: Readonly<Record<string, string>> }>;

/** The host composes existing workspace/save/storage primitives; it owns no alternative text model. */
export class DemoProject {
    readonly workspace = new Workspace();
    readonly files: readonly DemoFile[];
    readonly sample: DemoSample;
    private readonly store: DraftStore;
    private token: string | null = null;
    private readonly baselines = new Map<string, ComparisonBaseline>();
    private disposed = false;
    saving = false;
    message = "Changes are kept in this page until you save locally.";
    private constructor(id: SampleId, store: DraftStore, token: string | null, saved: StoredProject | null) {
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
    }
    static async open(id: SampleId): Promise<DemoProject> {
        const store = createBrowserDraftStore(window, { name: "sttropez-demo-projects-v1", slot: id });
        try {
            const stored = await store.read();
            let saved: StoredProject | null = null;
            if (stored) {
                const value = stored.value as Partial<StoredProject> | null;
                const names = Object.keys(demoSample(id).files);
                if (!value || value.version !== 1 || !value.files || Object.keys(value.files).length !== names.length
                    || names.some(name => typeof value.files![name] !== "string" || value.files![name]!.length > 8_000_000)) {
                    throw new Error("The saved project cannot be read. Its stored copy has been left untouched.");
                }
                saved = value as StoredProject;
            }
            return new DemoProject(id, store, stored?.token ?? null, saved);
        } catch (error) {
            await store.close();
            // Storage failure must leave the editor available; saves continue to fail safely.
            const project = new DemoProject(id, createBrowserDraftStore(window, { name: "sttropez-demo-projects-v1", slot: id }), null, null);
            project.message = error instanceof Error ? error.message : "Local storage is unavailable. You can still edit.";
            return project;
        }
    }
    baseline(file: DemoFile): ComparisonBaseline { return this.baselines.get(file.name)!; }
    dirty(): boolean { return this.files.some(file => file.resource.metadata.getSnapshot().dirty); }
    async save(changed: () => void): Promise<void> {
        if (this.disposed || this.saving) return;
        this.saving = true;
        const tickets = this.files.map(file => ({ file, ticket: this.workspace.captureSave(file.resource),
            buffer: this.workspace.document(file.resource.documentId).buffer }));
        const token = crypto.randomUUID();
        try {
            const submissions = tickets.map(({ ticket }) => ticket.start());
            this.message = "Saving locally…"; changed();
            await this.store.write({ token, value: { version: 1, files: Object.fromEntries(submissions.map((submission, i) => [tickets[i]!.file.name, submission.value])) } }, this.token);
            if (this.disposed) return;
            this.token = token;
            for (const { file, ticket, buffer } of tickets) {
                ticket.accept({ serverVersion: token }); this.baselines.set(file.name, { buffer, version: token });
            }
            this.message = "Saved in this browser. Later edits remain unsaved.";
        } catch (error) {
            // The store checks the captured token in one read/write transaction across every file.
            const remote = await this.store.read().catch(() => null);
            for (const { ticket } of tickets) { if (remote && remote.token !== this.token) ticket.conflict(); else ticket.fail(); }
            this.message = remote && remote.token !== this.token
                ? "Another page saved this sample. Your edits are intact; reload to open its saved copy, or copy your changes first."
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
        if (!this.saving) this.release();
    }
    private release(): void {
        this.files.forEach(file => { file.view.dispose(); this.workspace.close(file.tab); this.workspace.releaseResource(file.resource.id, true); });
        void this.store.close();
    }
}
