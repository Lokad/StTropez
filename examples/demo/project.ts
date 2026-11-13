import { TextBuffer, Workspace } from "../../src/index.ts";
import type { ComparisonBaseline, DocumentView, SaveReview, TabId, TextResourceHandle } from "../../src/index.ts";
import { createBrowserDraftStore } from "../hosts/draft-store.ts";
import type { DraftStore } from "../hosts/draft-store.ts";
import { demoSample } from "./samples.ts";
import type { DemoSample, SampleId } from "./samples.ts";
import { DemoRecovery } from "./recovery.ts";
import { DemoLanguage } from "./language.ts";

export type DemoFile = Readonly<{ name: string; resource: TextResourceHandle; tab: TabId; view: DocumentView; readOnly?: boolean }>;
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
    private loaded: readonly DemoFile[] = Object.freeze([]);
    get files(): readonly DemoFile[] { return this.loaded; }
    private get editable(): readonly DemoFile[] { return this.loaded.filter(file => !file.readOnly); }
    private readonly unloaded: Record<string, string>;
    readonly sample: DemoSample;
    readonly recovery: DemoRecovery;
    readonly language: DemoLanguage;
    private readonly store: DraftStore;
    private token: string | null = null;
    private readonly baselines = new Map<string, ComparisonBaseline>();
    private disposed = false;
    private languageDisposed = false;
    private conflict: Conflict | undefined;
    private reviewedRevisions: readonly number[] | undefined;
    saving = false;
    message = "Changes are kept in this page until you save locally.";
    private readonly inputIdle: () => boolean;
    private constructor(id: SampleId, store: DraftStore, token: string | null, saved: StoredProject | null, inputIdle: () => boolean) {
        this.inputIdle = inputIdle;
        this.sample = demoSample(id); this.store = store; this.token = token;
        this.unloaded = { ...(saved?.files ?? this.sample.files) };
        for (const name of this.sample.initialFiles ?? Object.keys(this.sample.files)) this.load(name);
        if (saved) this.message = "Opened the copy saved in this browser.";
        this.recovery = new DemoRecovery(this.workspace, () => this.editable, id, () => this.token, inputIdle, undefined,
            { names: Object.keys(this.sample.files), unloaded: () => this.unloaded, prepare: () => this.prepareEditable() });
        this.language = new DemoLanguage(this.workspace, () => this.files, id, {
            names: Object.keys({ ...this.sample.files, ...this.sample.declarations }),
            backing: () => ({ ...this.unloaded, ...this.sample.declarations }), load: (name, text) => this.load(name, text),
        });
    }
    private load(name: string, text?: string): DemoFile {
        if (this.disposed) throw new Error("The sample is closed.");
        const existing = this.files.find(file => file.name === name);
        if (existing) {
            if (text !== undefined && this.workspace.document(existing.resource.documentId).text !== text) throw new Error("The file changed while loading.");
            return existing;
        }
        const readOnly = Object.hasOwn(this.sample.declarations ?? {}, name);
        if (!readOnly && !Object.hasOwn(this.unloaded, name)) throw new Error("Unknown sample file.");
        const value = readOnly ? this.sample.declarations![name]! : this.unloaded[name]!;
        if (text !== undefined && text !== value) throw new Error("The loaded file differs from the captured sample inventory.");
        const resource = this.workspace.createTextResource({ scope: `demo:${this.sample.id}`, resource: name, variant: "working" }, name,
            { value, serverVersion: this.token }, readOnly ? { edit: [], save: false, run: false } : undefined);
        const tab = this.workspace.open({ kind: "text", documentId: resource.documentId }, "editor"), view = this.workspace.createDocumentView(resource.documentId);
        const file = Object.freeze({ name, resource, tab, view, readOnly });
        this.baselines.set(name, { buffer: this.workspace.document(resource.documentId).buffer, version: this.token ?? "sample" });
        this.loaded = Object.freeze([...this.loaded, file]); if (!readOnly) delete this.unloaded[name];
        this.recovery?.filesChanged(); this.language?.filesChanged(); return file;
    }
    private prepareEditable(): void { for (const name of Object.keys(this.unloaded)) this.load(name); }
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
        return (this.reviewedRevisions ? this.conflict!.baselines.get(file.name) : undefined) ?? this.baselines.get(file.name)!;
    }
    dirty(): boolean { return this.files.some(file => file.resource.metadata.getSnapshot().dirty); }
    hasConflict(): boolean { return this.conflict !== undefined; }
    isReviewingConflict(): boolean { return this.reviewedRevisions !== undefined; }
    reviewConflict(): boolean {
        if (this.disposed || this.saving || !this.conflict) return false;
        this.prepareEditable(); this.reviewedRevisions = this.editable.map(file => this.workspace.document(file.resource.documentId).revision);
        this.message = "Comparing against the other page's saved copy. Review each file before saving your version.";
        return true;
    }
    canSaveReviewed(): boolean {
        return !this.disposed && !this.saving && !!this.reviewedRevisions
            && this.editable.every((file, i) => this.workspace.document(file.resource.documentId).revision === this.reviewedRevisions![i]);
    }
    download(): string {
        return JSON.stringify({ version: 1, files: { ...this.unloaded, ...Object.fromEntries(this.editable.map(file => [file.name, this.workspace.document(file.resource.documentId).text])) } }, null, 2);
    }
    async save(changed: () => void, reviewed = false): Promise<void> {
        if (this.disposed || this.saving) return;
        if (!this.inputIdle()) { this.message = "An edit is still in progress. Save again when it finishes."; changed(); return; }
        if (reviewed && !this.canSaveReviewed()) return;
        this.prepareEditable();
        this.saving = true;
        const expected = reviewed ? this.conflict!.token : this.token;
        const tickets = this.editable.map(file => ({ file, ticket: this.workspace.captureSave(file.resource, reviewed
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
            await this.recovery.settleSavedDraft();
            if (this.disposed) return;
            this.message = "Saved in this browser. Later edits remain unsaved.";
        } catch (error) {
            // The store checks the captured token in one read/write transaction across every file.
            const remote = await this.store.read().catch(() => null);
            for (const { ticket } of tickets) { if (remote && remote.token !== expected) ticket.conflict(); else ticket.fail(); }
            this.reviewedRevisions = undefined;
            if (remote && remote.token !== expected) {
                try {
                    const saved = readProject(remote.value, Object.keys(this.sample.files));
                    this.conflict = { token: remote.token, baselines: new Map(Object.entries(saved.files).map(([name, text]) => [name, { buffer: TextBuffer.from(text), version: remote.token }])) };
                } catch { this.conflict = undefined; }
            }
            this.message = remote && remote.token !== expected
                ? "Another page saved this sample. Your edits are intact. Review the saved copy or download your changes."
                : error instanceof Error ? `Could not save: ${error.message}` : "Could not save. Your edits are intact.";
        } finally {
            tickets.forEach(({ ticket }) => ticket.finish()); this.saving = false;
            if (this.disposed) { if (this.languageDisposed) this.release(); } else changed();
        }
    }
    reset(): void {
        this.prepareEditable();
        this.workspace.editDocuments(this.editable.map(file => {
            const document = this.workspace.document(file.resource.documentId);
            return { documentId: document.id, expectedRevision: document.revision, origin: "host" as const,
                edits: [{ from: 0, to: document.buffer.length, insert: this.sample.files[file.name]! }] };
        }));
        this.message = "Sample restored. Undo restores your edits; Save locally replaces the saved copy.";
    }
    dispose(): void {
        if (this.disposed) return; this.disposed = true;
        this.recovery.dispose();
        void this.language.dispose().then(() => { this.languageDisposed = true; if (!this.saving) this.release(); });
    }
    private release(): void {
        this.files.forEach(file => { file.view.dispose(); this.workspace.close(file.tab); this.workspace.releaseResource(file.resource.id, true); });
        void this.store.close();
    }
}
