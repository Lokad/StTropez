import { TextBuffer, Workspace } from "../../src/index.ts";
import { createNavigationHistory } from "../../src/browser/index.ts";
import type { ComparisonBaseline, DocumentView, SaveReview, SaveTicket, TextResourceHandle } from "../../src/index.ts";
import { createBrowserDraftStore } from "../shared/draft-store.ts";
import type { DraftStore, StoredDraft } from "../shared/draft-store.ts";
import { demoSample } from "./samples.ts";
import type { DemoSample, SampleId } from "./samples.ts";
import { DemoRecovery, matchesText } from "./recovery.ts";
import { DemoLanguage } from "./language.ts";
import type { DemoProviderFactory } from "./provider-contract.ts";
import { HostSourceNotes } from "../shared/source-notes.ts";
import { CleanupScope } from "../shared/cleanup-scope.ts";

export type DemoFile = Readonly<{ name: string; resource: TextResourceHandle; view: DocumentView; readOnly?: boolean }>;
type StoredProject = Readonly<{ version: 1; files: Readonly<Record<string, string>> }>;
type Conflict = Readonly<{ token: string; baselines: ReadonlyMap<string, ComparisonBaseline> }>;
type Review = Readonly<{ copy: Conflict; revisions: ReadonlyMap<DemoFile, number> }>;
type CapturedFile = Readonly<{ ticket: SaveTicket<string>; buffer: TextBuffer }>;
type PendingSave = Readonly<{ captured: ReadonlyMap<DemoFile, CapturedFile>; done: Promise<string | null> }>;
type ProjectStorage = Readonly<{
    createStore?: (name: string) => DraftStore;
    peerChanged?: (project: DemoProject) => void;
}>;

function readProject(stored: StoredDraft, names: readonly string[]): StoredProject {
    const candidate = stored.value as Partial<StoredProject> | null;
    if (stored.token === "invalid" || !candidate || candidate.version !== 1
        || !candidate.files || Object.keys(candidate.files).length !== names.length
        || names.some(name => typeof candidate.files![name] !== "string" || candidate.files![name]!.length > 8_000_000)) {
        throw new Error("The saved project cannot be read. Its stored copy has been left untouched.");
    }
    return candidate as StoredProject;
}

/** The host composes existing workspace/save/storage primitives; it owns no alternative text model. */
export class DemoProject {
    readonly workspace = new Workspace();
    readonly navigation = createNavigationHistory(this.workspace);
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
    private review: Review | undefined;
    private pendingPeerRead = false;
    private readingPeer = false;
    private readonly captureOpenedFile = new Set<(file: DemoFile) => void>();
    private lastSave: PendingSave | undefined;
    saving = false;
    private notice: { text?: string; keepOnEdit?: true; editRefusal?: string } = {
        text: "Changes are kept in this page until you save locally."
    };
    setEditRefusal(text?: string): void {
        if (text === undefined) delete this.notice.editRefusal;
        else this.notice.editRefusal = text;
    }
    get message(): string {
        if (this.notice.editRefusal !== undefined) return this.notice.editRefusal;
        if (this.notice.text !== undefined) return this.notice.text;
        if (this.review && !this.saving) return this.canSaveReviewed()
            ? "Review each file, then keep your version or take the other page's saved files."
            : "The files changed after review. Review the saved copy again.";
        return this.dirty() ? "Unsaved changes." : this.token ? "Saved in this browser." : "Files match the original sample.";
    }
    set message(text: string) { this.notice = { text }; }
    private readonly inputIdle: () => boolean;
    private readonly peerChanged: ((project: DemoProject) => void) | undefined;
    private readonly noteModels = new Map<DemoFile, HostSourceNotes>();
    notesFor(file: DemoFile): HostSourceNotes {
        let model = this.noteModels.get(file);
        if (!model) { model = new HostSourceNotes(this.workspace, file.resource.id); this.noteModels.set(file, model); this.seedNotes(file, model); }
        return model;
    }
    private seedNotes(file: DemoFile, model: HostSourceNotes): void {
        if (file.name !== "workflow.rules") return;
        const doc = this.workspace.document(file.resource.id), prefix = doc.buffer.slice(0, Math.min(doc.buffer.length, 16384));
        for (const [token, text] of [["columns sku", "Inventory source"], ["when quantity", "Review policy"]]) {
            const from = prefix.indexOf(token!); if (from >= 0) model.add(doc.revision, from, from + token!.length, text!);
        }
    }
    private constructor(id: SampleId, store: DraftStore, token: string | null, saved: StoredProject | null,
        inputIdle: () => boolean, peerChanged?: (project: DemoProject) => void) {
        this.inputIdle = inputIdle;
        this.peerChanged = peerChanged;
        this.sample = demoSample(id); this.store = store; this.token = token;
        this.unloaded = { ...(saved?.files ?? this.sample.files) };
        if (saved) this.message = "Opened the copy saved in this browser.";
    }
    private load(name: string, text?: string): DemoFile {
        if (this.disposed) throw new Error("The sample is closed.");
        const existing = this.files.find(file => file.name === name);
        if (existing) {
            if (text !== undefined && this.workspace.document(existing.resource.id).text() !== text) throw new Error("The file changed while loading.");
            return existing;
        }
        const readOnly = Object.hasOwn(this.sample.declarations ?? {}, name);
        if (!readOnly && !Object.hasOwn(this.unloaded, name)) throw new Error("Unknown sample file.");
        const value = readOnly ? this.sample.declarations![name]! : this.unloaded[name]!;
        if (text !== undefined && text !== value) throw new Error("The loaded file differs from the captured sample inventory.");
        const owners = new CleanupScope(); let file: DemoFile;
        try {
            const resource = this.workspace.createTextResource({ scope: `demo:${this.sample.id}`, resource: name, variant: "working" }, name,
                {
                    value,
                    serverVersion: this.token,
                    capabilities: readOnly ? { edit: [], save: false } : undefined,
                    language: this.services?.language.languageFor(name) ?? null,
                });
            owners.defer(() => { this.workspace.releaseResource(resource.id, true); });
            const view = this.workspace.createDocumentView(resource.id); owners.defer(() => view.dispose());
            owners.defer(this.workspace.onDocumentChange(resource.id, () => {
                if (this.notice.keepOnEdit) this.setEditRefusal();
                else this.notice = {};
            }));
            file = Object.freeze({ name, resource, view, readOnly });
            this.baselines.set(name, { buffer: this.workspace.document(resource.id).buffer, version: this.token ?? "sample" });
            this.loaded = Object.freeze([...this.loaded, file]); if (!readOnly) delete this.unloaded[name];
            this.fileOwners.defer(owners.dispose);
        } catch (error) { return owners.rollback(error); }
        if (!readOnly) for (const capture of this.captureOpenedFile) capture(file);
        this.services?.recovery.filesChanged(); this.services?.language.filesChanged(); return file;
    }
    private prepareEditable(): void { for (const name of Object.keys(this.unloaded)) this.load(name); }
    static async open(id: SampleId, inputIdle: () => boolean, openProvider: DemoProviderFactory,
        { createStore = name => createBrowserDraftStore(window, { name, slot: id }), peerChanged }: ProjectStorage = {}): Promise<DemoProject> {
        const store = createStore("sttropez-demo-projects-v1");
        let project: DemoProject | undefined, recoveryStore: DraftStore | undefined, recovery: DemoRecovery | undefined;
        try {
            let changedWhileOpening = false;
            const stopWatching = store.watch(() => {
                if (project) project.queuePeerRead();
                else changedWhileOpening = true;
            });
            let saved: StoredProject | null = null, token: string | null = null, message: string | undefined;
            try {
                const stored = await store.read();
                if (stored) { saved = readProject(stored, Object.keys(demoSample(id).files)); token = stored.token; }
            } catch (error) {
                // Only unavailable/unreadable storage selects the editable sample fallback.
                // Retain a null token so saving cannot overwrite an unreadable stored copy.
                message = error instanceof Error ? error.message : "Local storage is unavailable. You can still edit.";
            }
            recoveryStore = createStore("sttropez-demo-recovery-v1");
            const next = project = new DemoProject(id, store, token, saved, inputIdle, peerChanged);
            next.fileOwners.defer(stopWatching);
            for (const name of next.sample.initialFiles ?? Object.keys(next.sample.files)) next.load(name);
            recovery = new DemoRecovery(next.workspace, () => next.editable, id, () => next.token, inputIdle, recoveryStore,
                { names: Object.keys(next.sample.files), unloaded: () => next.unloaded, prepare: () => next.prepareEditable() });
            const language = new DemoLanguage(next.workspace, () => next.files, id, openProvider, {
                names: Object.keys({ ...next.sample.files, ...next.sample.declarations }),
                backing: () => ({ ...next.unloaded, ...next.sample.declarations }), load: (name, text) => next.load(name, text),
            });
            next.services = { recovery, language };
            if (message !== undefined) next.notice = { text: message, keepOnEdit: true };
            if (changedWhileOpening) next.queuePeerRead();
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
        return this.review?.copy.baselines.get(file.name) ?? this.baselines.get(file.name)!;
    }
    dirty(): boolean { return this.files.some(file => file.resource.metadata.getSnapshot().dirty); }
    hasConflict(): boolean { return this.conflict !== undefined; }
    referenceLabel(): string {
        if (!this.review) return "Saved copy";
        return this.review.copy === this.conflict ? "Other page's saved copy" : "Previously reviewed copy";
    }
    reviewConflict(): boolean {
        if (this.disposed || this.saving || !this.conflict) return false;
        this.prepareEditable();
        this.review = { copy: this.conflict, revisions: new Map(this.editable.map(file =>
            [file, this.workspace.document(file.resource.id).revision])) };
        this.notice = {};
        return true;
    }
    canSaveReviewed(): boolean {
        const review = this.review;
        return !this.disposed && !this.saving && !!review && review.copy === this.conflict
            && this.editable.every(file => this.workspace.document(file.resource.id).revision === review.revisions.get(file));
    }
    private matchesFiles(files: StoredProject["files"], side: "working" | "saved"): boolean {
        return Object.entries(this.unloaded).every(([name, text]) => text === files[name])
            && this.editable.every(file => {
                const buffer = side === "working" ? this.workspace.document(file.resource.id).buffer
                    : this.baselines.get(file.name)!.buffer;
                return matchesText(buffer, files[file.name]!);
            });
    }
    private peerFiles(stored: StoredDraft): StoredProject["files"] {
        // A newer unreadable row must also retire permission to use a previously reviewed copy.
        if (this.conflict?.token !== stored.token) this.conflict = undefined;
        return readProject(stored, Object.keys(this.sample.files)).files;
    }
    private showPeerCopy(stored: StoredDraft | null): void {
        if (stored) {
            const files = this.peerFiles(stored);
            if (this.matchesFiles(files, "saved") || this.adoptMatchingWorkingCopy(files, stored.token)) {
                // Only the project storage token changed, or our exact working files were saved elsewhere.
                this.token = stored.token;
                this.conflict = undefined;
                this.review = undefined;
                this.notice = {};
                return;
            }
            this.conflict ??= { token: stored.token, baselines: new Map(Object.entries(files).map(([name, text]) =>
                [name, { buffer: TextBuffer.from(text), version: stored.token }])) };
            if (this.review?.copy === this.conflict) {
                this.notice = {};
                return;
            }
        } else {
            this.token = null;
            this.conflict = undefined;
        }
        const text = !stored ? "The saved copy was removed. Save locally to keep your current files."
            : this.review ? "The other page saved again. Review the new saved copy."
            : "Another page saved this sample. Review the saved copy when you're ready.";
        this.notice = { text, keepOnEdit: true };
    }
    private adoptMatchingWorkingCopy(files: StoredProject["files"], token: string): boolean {
        if (!this.matchesFiles(files, "working")) return false;
        const versions = this.editable.map(file => ({
            documentId: file.resource.id, text: this.workspace.document(file.resource.id).buffer,
            serverVersion: token, name: file.name,
        }));
        if (!this.workspace.adoptSavedDocuments(versions, { history: "record" }).applied) return false;
        for (const { name, text } of versions) this.baselines.set(name, { buffer: text, version: token });
        return true;
    }
    private queuePeerRead(): void {
        if (this.disposed) return;
        this.pendingPeerRead = true;
        void this.checkPeerSave();
    }
    private async checkPeerSave(): Promise<void> {
        if (this.readingPeer || this.saving || this.disposed) return;
        this.readingPeer = true;
        try {
            while (this.pendingPeerRead && !this.saving && !this.disposed) {
                this.pendingPeerRead = false;
                try {
                    const stored = await this.store.read();
                    if (this.disposed || this.pendingPeerRead) continue;
                    if (!stored && this.token === null && !this.conflict) continue;
                    if (stored && stored.token === (this.conflict?.token ?? this.token)) continue;
                    this.showPeerCopy(stored);
                } catch (error) {
                    if (this.disposed || this.pendingPeerRead) continue;
                    this.conflict = undefined;
                    this.notice = { text: error instanceof Error ? error.message : "Could not read the saved copy.", keepOnEdit: true };
                }
                this.peerChanged?.(this);
            }
        } finally {
            this.readingPeer = false;
        }
    }
    private beginStorage(): void {
        this.saving = true;
        if (this.readingPeer) this.pendingPeerRead = true;
    }
    async takeReviewedCopy(changed: () => void, stillOpen: () => boolean): Promise<void> {
        const review = this.review, conflict = this.conflict;
        if (!review || !conflict || !this.canSaveReviewed() || !this.inputIdle()) return;
        this.beginStorage();
        try {
            changed();
            const stored = await this.store.read();
            if (this.disposed || !stillOpen()) return;
            if (stored?.token !== conflict.token) {
                this.showPeerCopy(stored);
                return;
            }
            const versions = Array.from(review.revisions, ([file, expectedRevision]) => ({
                documentId: file.resource.id, expectedRevision, text: conflict.baselines.get(file.name)!.buffer, serverVersion: conflict.token,
            }));
            if (!this.inputIdle() || !this.workspace.adoptSavedDocuments(versions, { history: "record" }).applied) {
                this.review = undefined; this.message = "Your files changed or are busy. Review the saved copy again.";
                return;
            }
            this.token = conflict.token;
            for (const [name, baseline] of conflict.baselines) this.baselines.set(name, baseline);
            this.conflict = undefined; this.review = undefined;
            this.message = "Using the reviewed saved files.";
            await this.recovery.settleSavedDraft();
        } catch (error) {
            if (!this.disposed && stillOpen()) this.message = error instanceof Error ? error.message : "Could not read the saved copy.";
        } finally { this.finishStorage(changed); }
    }
    download(): string {
        return JSON.stringify({ version: 1, files: { ...this.unloaded, ...Object.fromEntries(this.editable.map(file => [file.name, this.workspace.document(file.resource.id).text()])) } }, null, 2);
    }
    /** On a missed peer notification, retry once against an identical baseline. Every write checks its token. */
    private async writeFiles(files: StoredProject["files"], expected: string | null, reviewed: boolean):
        Promise<string | StoredDraft | null> {
        const names = Object.keys(files);
        const sameSubmission = (saved: StoredProject["files"]) => names.every(name => files[name] === saved[name]);
        if (!reviewed && expected !== null && this.matchesFiles(files, "saved")) {
            const peer = await this.store.read();
            // Saving an unchanged project must leave a review in another tab usable.
            return peer && sameSubmission(this.peerFiles(peer)) ? peer.token : peer;
        }
        const entry = { token: crypto.randomUUID(), value: { version: 1, files } };
        for (let attempt = 0; ; attempt++) {
            try {
                await this.store.write(entry, expected);
                return entry.token;
            } catch (error) {
                const peer = await this.store.read().catch(() => undefined);
                if (peer === undefined || (peer?.token ?? null) === expected) throw error;
                if (!peer || reviewed || this.disposed) return peer;
                const saved = this.peerFiles(peer);
                if (sameSubmission(saved)) return peer.token;
                if (attempt || !this.matchesFiles(saved, "saved")) return peer;
                expected = peer.token;
            }
        }
    }
    canSave(): boolean {
        if (this.disposed) return false;
        if (!this.saving) return true;
        const last = this.lastSave;
        return !!last && this.editable.some(file => this.workspace.document(file.resource.id).revision
            !== (last.captured.get(file)?.ticket.revision ?? 0));
    }
    async save(changed: () => void, reviewed = false): Promise<void> {
        if (this.disposed || (this.saving && !this.lastSave)) return;
        if (!this.inputIdle()) {
            this.message = "Save skipped while an edit was pending. Save again to keep your changes.";
            changed();
            return;
        }
        if (reviewed && !this.canSaveReviewed()) return;
        const previous = this.lastSave;
        if (previous && !this.canSave()) {
            await previous.done;
            return;
        }
        const reviewedToken = reviewed ? this.conflict!.token : undefined;
        const captured = new Map<DemoFile, CapturedFile>();
        const files = { ...this.unloaded };
        let started = false;
        const capture = (file: DemoFile) => {
            const document = this.workspace.document(file.resource.id);
            const ticket = this.workspace.captureSave(file.resource, reviewedToken === undefined ? undefined
                : { target: this.workspace.captureResource(file.resource.id), expectedRevision: document.revision,
                    expectedServerVersion: reviewedToken } satisfies SaveReview);
            captured.set(file, { ticket, buffer: document.buffer });
            if (started) ticket.start();
            return ticket;
        };
        try {
            for (const file of this.editable) files[file.name] = capture(file).value;
        } catch (error) {
            for (const { ticket } of captured.values()) ticket.finish();
            this.showSaveFailure(error);
            changed();
            return;
        }
        // Opening a submitted file must acknowledge its original buffer. Later typing stays dirty.
        this.captureOpenedFile.add(capture);
        this.beginStorage();
        const write = async (expected: string | null) => {
            try {
                if (this.disposed) return;
                for (const { ticket } of captured.values()) ticket.start();
                started = true;
                this.notice = { text: "Saving locally…", keepOnEdit: true };
                changed();
                const result = await this.writeFiles(files, expected, reviewed);
                if (this.disposed) return;
                if (typeof result !== "string") {
                    for (const { ticket } of captured.values()) ticket.conflict();
                } else {
                    this.token = result;
                    this.conflict = undefined;
                    this.review = undefined;
                    for (const [file, { ticket, buffer }] of captured) {
                        ticket.accept({ serverVersion: result });
                        this.baselines.set(file.name, { buffer, version: result });
                    }
                }
                return result;
            } catch (error) {
                for (const { ticket } of captured.values()) ticket.fail();
                throw error;
            } finally {
                this.captureOpenedFile.delete(capture);
                for (const { ticket } of captured.values()) ticket.finish();
            }
        };
        const submit = async (acknowledged: string | null) => {
            try {
                const result = await write(reviewedToken ?? acknowledged);
                if (result === undefined || this.disposed) return acknowledged;
                if (typeof result !== "string") {
                    if (this.lastSave?.captured === captured) this.showPeerCopy(result);
                    // A queued press cannot inherit permission to replace a conflicting or deleted copy.
                    return acknowledged;
                }
                await this.recovery.settleSavedDraft();
                if (!this.disposed && this.lastSave?.captured === captured) {
                    this.notice = this.dirty() ? { text: "Saved in this browser. Later edits remain unsaved." } : {};
                }
                return result;
            } catch (error) {
                this.showSaveFailure(error);
                return acknowledged;
            } finally {
                if (this.lastSave?.captured === captured) {
                    this.lastSave = undefined;
                    this.finishStorage(changed);
                }
            }
        };
        // All files in one sample share a single conditional storage write.
        const done = (previous?.done ?? Promise.resolve(this.token)).then(submit);
        this.lastSave = { captured, done };
        if (previous) changed();
        await done;
    }
    private showSaveFailure(error: unknown): void {
        this.review = undefined;
        const text = error instanceof Error ? `Could not save: ${error.message}` : "Could not save. Your edits are intact.";
        this.notice = { text, keepOnEdit: true };
    }
    private finishStorage(changed: () => void): void {
        this.saving = false;
        if (this.disposed) {
            if (this.languageDisposed) this.release();
        } else {
            if (this.pendingPeerRead) void this.checkPeerSave();
            changed();
        }
    }
    reset(): void {
        this.prepareEditable();
        const result = this.workspace.editDocuments(this.editable.map(file => {
            const document = this.workspace.document(file.resource.id);
            return { documentId: document.id, expectedRevision: document.revision, origin: "host" as const,
                text: this.sample.files[file.name]! };
        }));
        if (!result.applied) { this.message = "The sample could not be reset. Your edits are intact."; return; }
        for (const [file, model] of this.noteModels) { model.clear(); this.seedNotes(file, model); }
        this.message = "Sample restored. Undo restores your edits; Save locally replaces the saved copy.";
    }
    dispose(): void {
        if (this.disposed) return; this.disposed = true;
        this.navigation.dispose();
        void this.recovery.dispose();
        for (const model of this.noteModels.values()) model.dispose(); this.noteModels.clear();
        void this.language.dispose().then(() => { this.languageDisposed = true; if (!this.saving) this.release(); });
    }
    private release(): void {
        try { this.fileOwners.dispose(); } finally { void this.store.close(); }
    }
}
