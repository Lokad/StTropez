import { TextBuffer, Workspace } from "../../src/index.ts";
import type { ComparisonBaseline, DocumentView, SaveReview, SaveTicket, TabId, TextResourceHandle } from "../../src/index.ts";
import { createBrowserDraftStore } from "../hosts/draft-store.ts";
import type { DraftStore } from "../hosts/draft-store.ts";
import { demoSample } from "./samples.ts";
import type { DemoSample, SampleId } from "./samples.ts";
import { DemoRecovery } from "./recovery.ts";
import { DemoLanguage } from "./language.ts";
import type { DemoProviderFactory } from "./provider-contract.ts";
import { HostSourceNotes } from "../shared/source-notes.ts";
import { CleanupScope } from "../shared/cleanup-scope.ts";

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
    // Only open() publishes a project, after both services have been acquired.
    private services!: Readonly<{ recovery: DemoRecovery; language: DemoLanguage }>;
    get recovery(): DemoRecovery { return this.services.recovery; }
    get language(): DemoLanguage { return this.services.language; }
    private readonly fileOwners = new CleanupScope();
    private readonly store: DraftStore;
    private token: string | null = null;
    private readonly baselines = new Map<string, ComparisonBaseline>();
    private disposed = false;
    private languageDisposed = false;
    private conflict: Conflict | undefined;
    private reviewedRevisions: readonly number[] | undefined;
    private includeOpenedFileInSave: ((file: DemoFile) => void) | undefined;
    saving = false;
    private notice: { text: string; keepOnEdit?: true } | undefined = { text: "Changes are kept in this page until you save locally." };
    get message(): string {
        if (this.notice) return this.notice.text;
        if (this.reviewedRevisions && !this.canSaveReviewed()) return "The files changed after review. Review the saved copy again before saving.";
        return this.dirty() ? "Unsaved changes." : this.token ? "Saved in this browser." : "Files match the original sample.";
    }
    set message(text: string) { this.notice = { text }; }
    private readonly inputIdle: () => boolean;
    private readonly noteModels = new Map<DemoFile, HostSourceNotes>();
    notesFor(file: DemoFile): HostSourceNotes {
        let model = this.noteModels.get(file);
        if (!model) { model = new HostSourceNotes(this.workspace, file.resource.documentId); this.noteModels.set(file, model); this.seedNotes(file, model); }
        return model;
    }
    private seedNotes(file: DemoFile, model: HostSourceNotes): void {
        if (file.name !== "workflow.rules") return;
        const doc = this.workspace.document(file.resource.documentId), prefix = doc.buffer.slice(0, Math.min(doc.buffer.length, 16384));
        for (const [token, text] of [["columns sku", "Inventory source"], ["when quantity", "Review policy"]]) {
            const from = prefix.indexOf(token!); if (from >= 0) model.add(doc.revision, from, from + token!.length, text!);
        }
    }
    private constructor(id: SampleId, store: DraftStore, token: string | null, saved: StoredProject | null, inputIdle: () => boolean) {
        this.inputIdle = inputIdle;
        this.sample = demoSample(id); this.store = store; this.token = token;
        this.unloaded = { ...(saved?.files ?? this.sample.files) };
        if (saved) this.message = "Opened the copy saved in this browser.";
    }
    private load(name: string, text?: string): DemoFile {
        if (this.disposed) throw new Error("The sample is closed.");
        const existing = this.files.find(file => file.name === name);
        if (existing) {
            if (text !== undefined && this.workspace.document(existing.resource.documentId).text() !== text) throw new Error("The file changed while loading.");
            return existing;
        }
        const readOnly = Object.hasOwn(this.sample.declarations ?? {}, name);
        if (!readOnly && !Object.hasOwn(this.unloaded, name)) throw new Error("Unknown sample file.");
        const value = readOnly ? this.sample.declarations![name]! : this.unloaded[name]!;
        if (text !== undefined && text !== value) throw new Error("The loaded file differs from the captured sample inventory.");
        const owners = new CleanupScope(); let file: DemoFile;
        try {
            const resource = this.workspace.createTextResource({ scope: `demo:${this.sample.id}`, resource: name, variant: "working" }, name,
                { value, serverVersion: this.token }, readOnly ? { edit: [], save: false, run: false } : undefined);
            owners.defer(() => { this.workspace.releaseResource(resource.id, true); });
            const tab = this.workspace.tabs.open({ kind: "text", documentId: resource.documentId }, "editor");
            owners.defer(() => { this.workspace.tabs.close(tab); });
            const view = this.workspace.createDocumentView(resource.documentId); owners.defer(() => view.dispose());
            owners.defer(this.workspace.onDocumentChange(resource.documentId, () => {
                if (!this.notice?.keepOnEdit) this.notice = undefined;
            }));
            file = Object.freeze({ name, resource, tab, view, readOnly });
            this.baselines.set(name, { buffer: this.workspace.document(resource.documentId).buffer, version: this.token ?? "sample" });
            this.loaded = Object.freeze([...this.loaded, file]); if (!readOnly) delete this.unloaded[name];
            this.fileOwners.defer(owners.dispose);
        } catch (error) { return owners.rollback(error); }
        if (!readOnly) this.includeOpenedFileInSave?.(file);
        this.services?.recovery.filesChanged(); this.services?.language.filesChanged(); return file;
    }
    private prepareEditable(): void { for (const name of Object.keys(this.unloaded)) this.load(name); }
    static async open(id: SampleId, inputIdle: () => boolean, openProvider: DemoProviderFactory,
        createStore: (name: string) => DraftStore = name => createBrowserDraftStore(window, { name, slot: id })): Promise<DemoProject> {
        const store = createStore("sttropez-demo-projects-v1");
        let project: DemoProject | undefined, recoveryStore: DraftStore | undefined, recovery: DemoRecovery | undefined;
        try {
            let saved: StoredProject | null = null, token: string | null = null, message: string | undefined;
            try {
                const stored = await store.read();
                if (stored) { saved = readProject(stored.value, Object.keys(demoSample(id).files)); token = stored.token; }
            } catch (error) {
                // Only unavailable/unreadable storage selects the editable sample fallback.
                // Retain a null token so saving cannot overwrite an unreadable stored copy.
                message = error instanceof Error ? error.message : "Local storage is unavailable. You can still edit.";
            }
            recoveryStore = createStore("sttropez-demo-recovery-v1");
            const next = project = new DemoProject(id, store, token, saved, inputIdle);
            for (const name of next.sample.initialFiles ?? Object.keys(next.sample.files)) next.load(name);
            recovery = new DemoRecovery(next.workspace, () => next.editable, id, () => next.token, inputIdle, recoveryStore,
                { names: Object.keys(next.sample.files), unloaded: () => next.unloaded, prepare: () => next.prepareEditable() });
            const language = new DemoLanguage(next.workspace, () => next.files, id, openProvider, {
                names: Object.keys({ ...next.sample.files, ...next.sample.declarations }),
                backing: () => ({ ...next.unloaded, ...next.sample.declarations }), load: (name, text) => next.load(name, text),
            });
            next.services = { recovery, language };
            if (message !== undefined) next.notice = { text: message, keepOnEdit: true };
            return next;
        } catch (error) {
            const errors = [error];
            if (project) project.disposed = true;
            // Recovery owns its store only after construction; settle its work before releasing files.
            try { if (recovery) await recovery.dispose(); else await recoveryStore?.close(); }
            catch (cleanupError) { errors.push(cleanupError); }
            try { project?.fileOwners.dispose(); } catch (cleanupError) { errors.push(cleanupError); }
            try { await store.close(); } catch (cleanupError) { errors.push(cleanupError); }
            if (errors.length > 1) throw new AggregateError(errors, "Project startup and cleanup failed.");
            throw error;
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
        return JSON.stringify({ version: 1, files: { ...this.unloaded, ...Object.fromEntries(this.editable.map(file => [file.name, this.workspace.document(file.resource.documentId).text()])) } }, null, 2);
    }
    async save(changed: () => void, reviewed = false): Promise<void> {
        if (this.disposed || this.saving) return;
        if (!this.inputIdle()) { this.notice = { text: "An edit is still in progress. Save again when it finishes.", keepOnEdit: true }; changed(); return; }
        if (reviewed && !this.canSaveReviewed()) return;
        const expected = reviewed ? this.conflict!.token : this.token;
        const tickets: { file: DemoFile; ticket: SaveTicket<string>; buffer: TextBuffer }[] = [];
        let writing = false;
        this.saving = true;
        try {
            const capture = (file: DemoFile) => {
                const document = this.workspace.document(file.resource.documentId);
                const ticket = this.workspace.captureSave(file.resource, reviewed
                    ? { target: this.workspace.captureResource(file.resource.id), expectedRevision: document.revision,
                        expectedServerVersion: expected! } satisfies SaveReview : undefined);
                tickets.push({ file, ticket, buffer: document.buffer });
                return ticket;
            };
            for (const file of this.editable) capture(file);
            const token = crypto.randomUUID();
            const files = { ...this.unloaded };
            for (const { file, ticket } of tickets) files[file.name] = ticket.start().value;
            // If navigation opens a submitted file before storage replies, acknowledge its original
            // buffer with the other tickets. Typing in the newly opened tab stays dirty.
            this.includeOpenedFileInSave = file => { capture(file).start(); };
            try {
                this.notice = { text: "Saving locally…", keepOnEdit: true }; changed();
                writing = true;
                await this.store.write({ token, value: { version: 1, files } }, expected);
            } finally { this.includeOpenedFileInSave = undefined; }
            if (this.disposed) return;
            this.token = token;
            this.conflict = undefined; this.reviewedRevisions = undefined;
            for (const { file, ticket, buffer } of tickets) {
                ticket.accept({ serverVersion: token }); this.baselines.set(file.name, { buffer, version: token });
            }
            await this.recovery.settleSavedDraft();
            if (this.disposed) return;
            this.notice = this.dirty() ? { text: "Saved in this browser. Later edits remain unsaved." } : undefined;
        } catch (error) {
            // The store checks the captured token in one read/write transaction across every file.
            const remote = writing ? await this.store.read().catch(() => null) : null;
            for (const { ticket } of tickets) { if (remote && remote.token !== expected) ticket.conflict(); else ticket.fail(); }
            this.reviewedRevisions = undefined;
            if (remote && remote.token !== expected) {
                try {
                    const saved = readProject(remote.value, Object.keys(this.sample.files));
                    this.conflict = { token: remote.token, baselines: new Map(Object.entries(saved.files).map(([name, text]) => [name, { buffer: TextBuffer.from(text), version: remote.token }])) };
                } catch { this.conflict = undefined; }
            }
            const text = remote && remote.token !== expected
                ? "Another page saved this sample. Your edits are intact. Review the saved copy or download your changes."
                : error instanceof Error ? `Could not save: ${error.message}` : "Could not save. Your edits are intact.";
            this.notice = { text, keepOnEdit: true };
        } finally {
            tickets.forEach(({ ticket }) => ticket.finish()); this.saving = false;
            if (this.disposed) { if (this.languageDisposed) this.release(); } else changed();
        }
    }
    reset(): void {
        this.prepareEditable();
        const result = this.workspace.editDocuments(this.editable.map(file => {
            const document = this.workspace.document(file.resource.documentId);
            return { documentId: document.id, expectedRevision: document.revision, origin: "host" as const,
                text: this.sample.files[file.name]! };
        }));
        if (!result.applied) { this.message = "The sample could not be reset. Your edits are intact."; return; }
        for (const [file, model] of this.noteModels) { model.clear(); this.seedNotes(file, model); }
        this.message = "Sample restored. Undo restores your edits; Save locally replaces the saved copy.";
    }
    dispose(): void {
        if (this.disposed) return; this.disposed = true;
        void this.recovery.dispose();
        for (const model of this.noteModels.values()) model.dispose(); this.noteModels.clear();
        void this.language.dispose().then(() => { this.languageDisposed = true; if (!this.saving) this.release(); });
    }
    private release(): void {
        try { this.fileOwners.dispose(); } finally { void this.store.close(); }
    }
}
