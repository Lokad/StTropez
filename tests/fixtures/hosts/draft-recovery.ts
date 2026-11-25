import type { DocumentView, ResourceKey, ResourceTarget, TextBuffer, TextEdit, TextResourceHandle } from "../../../src/index.ts";
import type { Connection, HostController } from "./controller.ts";
import type { DraftStore, StoredDraft } from "../../../examples/shared/draft-store.ts";
import { HostCell } from "../../../examples/shared/observable.ts";
import type { TransferSettings } from "./transfers.ts";

type InputCopy = Readonly<{ session: string; ordinal: number; expectedRevision: number; reason: string; contextFrom: number; attemptedText: string; attemptedEdit: TextEdit | null }>;
type LoadedDraft = Readonly<{ identity: "temporary-loaded-source"; revision: number; serverVersion: string | null; text: string }>;
type Draft = Readonly<{ format: 3; id: string; created: number;
    source: Readonly<{ key: ResourceKey; revision: number; serverVersion: string | null; text: string }>;
    configuration: Readonly<{ key: ResourceKey; revision: number; serverVersion: string | null; value: Connection }>;
    transfer: Readonly<{ key: ResourceKey; revision: number; serverVersion: string | null; value: TransferSettings }>;
    loaded: LoadedDraft | null; input: readonly InputCopy[] }>;
type Kind = "keep" | "source" | "configuration" | "transfer" | "loaded" | "discard";
type Capture = Readonly<{ kind: Kind; confirmationToken: string; token: string | null; source: ResourceTarget; configuration: ResourceTarget;
    sourceRevision: number; configurationRevision: number; sourceVersion: string | null; configurationVersion: string | null;
    sourceAuthority: number; configurationAuthority: number; transfer: ResourceTarget; transferRevision: number; transferVersion: string | null; transferAuthority: number;
    loaded: ResourceTarget | null; loadedGeneration: number; loadedRevision: number | null; loadedVersion: string | null; loadedAuthority: number; view: DocumentView | null }>;
export type DraftSnapshot = Readonly<{ busy: boolean; present: boolean; valid: boolean; unprotected: boolean; message: string;
    confirmation: Kind | null; confirmationToken: string | null; sourceUnits: number; inputCount: number; hasTransfer: boolean; hasLoaded: boolean; preview: string | null }>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const version = (value: unknown): value is string | null => value === null || typeof value === "string";
const keyEquals = (a: unknown, b: ResourceKey): boolean => object(a) && a.scope === b.scope && a.resource === b.resource && a.variant === b.variant;
function token(): string { return [...crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16).padStart(8, "0")).join(""); }

function decode(stored: StoredDraft, controller: HostController): Draft {
    const d = stored.value, sourceKey = controller.source.metadata.getSnapshot().key, configurationKey = controller.connection.metadata.getSnapshot().key;
    if (!object(d) || d.format !== 3 || d.id !== stored.token || !integer(d.created) || !object(d.source) || !object(d.configuration) || !Array.isArray(d.input)
        || !keyEquals(d.source.key, sourceKey) || !keyEquals(d.configuration.key, configurationKey)
        || !integer(d.source.revision) || !integer(d.configuration.revision) || !version(d.source.serverVersion) || !version(d.configuration.serverVersion)
        || typeof d.source.text !== "string" || !object(d.configuration.value) || typeof d.configuration.value.path !== "string" || d.configuration.value.format !== "csv") throw new Error("Unsupported recovery draft.");
    const input: InputCopy[] = d.input.map((item: unknown) => {
        if (!object(item) || typeof item.session !== "string" || !integer(item.ordinal) || !integer(item.expectedRevision) || !integer(item.contextFrom)
            || typeof item.reason !== "string" || typeof item.attemptedText !== "string") throw new Error("Invalid recovered input.");
        const edit = item.attemptedEdit;
        if (edit !== null && (!object(edit) || !integer(edit.from) || !integer(edit.to) || edit.to < edit.from || typeof edit.insert !== "string")) throw new Error("Invalid recovered edit.");
        return Object.freeze({ session: item.session, ordinal: item.ordinal, expectedRevision: item.expectedRevision, contextFrom: item.contextFrom,
            reason: item.reason, attemptedText: item.attemptedText, attemptedEdit: edit === null ? null : Object.freeze({ from: edit.from as number, to: edit.to as number, insert: edit.insert as string }) });
    });
    const transferKey = controller.transfer.resource.metadata.getSnapshot().key, t = d.transfer;
    if (!object(t) || !keyEquals(t.key, transferKey) || !integer(t.revision) || !version(t.serverVersion)
        || !object(t.value) || typeof t.value.destination !== "string" || typeof t.value.batchSize !== "string") throw new Error("Unsupported transfer recovery draft.");
    const transfer = Object.freeze({ key: transferKey, revision: t.revision, serverVersion: t.serverVersion, value: Object.freeze(structuredClone(t.value)) as TransferSettings });
    const l = d.loaded;
    if (l !== null && (!object(l) || l.identity !== "temporary-loaded-source" || !integer(l.revision) || !version(l.serverVersion) || typeof l.text !== "string")) throw new Error("Unsupported loaded-source recovery draft.");
    const loaded: LoadedDraft | null = l === null ? null : Object.freeze({ identity: "temporary-loaded-source", revision: l.revision as number, serverVersion: l.serverVersion as string | null, text: l.text as string });
    return Object.freeze({ format: 3, id: stored.token, created: d.created, transfer, loaded,
        source: Object.freeze({ key: sourceKey, revision: d.source.revision, serverVersion: d.source.serverVersion, text: d.source.text }),
        configuration: Object.freeze({ key: configurationKey, revision: d.configuration.revision, serverVersion: d.configuration.serverVersion,
            // Keep opaque fields in the host's private clone; the resource validates and freezes on restore.
            value: Object.freeze(structuredClone(d.configuration.value)) as Connection }), input: Object.freeze(input) });
}

/** Host-owned checkpoints. Ordinary edits only compare immutable handles; they never export text. */
export class HostDraftRecovery {
    private readonly controller: HostController;
    private readonly store: DraftStore;
    private readonly session = token();
    private envelope: StoredDraft | null = null;
    private draft: Draft | undefined;
    private loaded = false;
    private busy = false;
    private mutations = 0;
    private disposed = false;
    private disposal: Promise<void> | undefined;
    private serial = 0;
    private sourceAuthority = 0;
    private configurationAuthority = 0;
    private transferAuthority = 0;
    private loadedAuthority = 0;
    private loadedStops: (() => void)[] = [];
    private confirmation: Capture | undefined;
    private protectedSource: TextBuffer | undefined;
    private protectedConfiguration: unknown;
    private protectedTransfer: unknown;
    private protectedInput: unknown;
    private protectedLoaded: Readonly<{ resource: TextResourceHandle; buffer: TextBuffer }> | undefined;
    private readonly jobs = new Set<Promise<void>>();
    private readonly stops: (() => void)[] = [];
    private detachNavigation: (() => void) | undefined;
    private hasComposition: () => boolean = () => false;
    private readonly cell = new HostCell<DraftSnapshot>({ busy: true, present: false, valid: false, unprotected: false, message: "Loading stored draft…", confirmation: null, confirmationToken: null, sourceUnits: 0, inputCount: 0, hasTransfer: false, hasLoaded: false, preview: null });
    readonly state = this.cell.observable;
    constructor(controller: HostController, store: DraftStore) {
        this.controller = controller; this.store = store;
        const authority = (kind: "source" | "configuration" | "transfer") => { const m = (kind === "source" ? controller.source : kind === "configuration" ? controller.connection : controller.transfer.resource).metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]); };
        let source = authority("source"), configuration = authority("configuration"), transfer = authority("transfer");
        this.stops.push(controller.workspace.observeDocument(controller.source.documentId).subscribe(() => this.publish()),
            controller.source.metadata.subscribe(() => { const next = authority("source"); if (next !== source) { source = next; this.sourceAuthority++; } this.publish(); }),
            controller.connection.subscribe(() => { const next = authority("configuration"); if (next !== configuration) { configuration = next; this.configurationAuthority++; } this.publish(); }),
            controller.transfer.resource.subscribe(() => { const next = authority("transfer"); if (next !== transfer) { transfer = next; this.transferAuthority++; } this.publish(); }),
            controller.recovery.subscribe(() => this.publish()), store.watch(() => this.reload()));
        const observeLoaded = () => {
            this.loadedStops.splice(0).forEach(stop => stop()); this.loadedAuthority++; this.protectedLoaded = undefined;
            const resource = controller.loadedSource.getSnapshot().resource;
            if (resource) {
                const authority = () => { const m = resource.metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]); };
                let previous = authority();
                this.loadedStops.push(controller.workspace.observeDocument(resource.documentId).subscribe(() => this.publish()),
                    resource.metadata.subscribe(() => { const next = authority(); if (next !== previous) { previous = next; this.loadedAuthority++; } this.publish(); }));
            }
            this.publish();
        };
        this.stops.push(controller.loadedSource.subscribe(observeLoaded), () => this.loadedStops.splice(0).forEach(stop => stop())); observeLoaded();
        this.reload();
    }
    private needsProtection(): boolean {
        const c = this.controller, source = c.source.metadata.getSnapshot(), configuration = c.connection.getSnapshot(), transfer = c.transfer.resource.getSnapshot(), loaded = c.loadedSource.getSnapshot().resource;
        return source.dirty && (source.state !== "ready" || c.workspace.document(c.source.documentId).buffer !== this.protectedSource)
            || configuration.metadata.dirty && (configuration.state !== "ready" || configuration.value() !== this.protectedConfiguration)
            || transfer.metadata.dirty && (transfer.state !== "ready" || transfer.value() !== this.protectedTransfer)
            || c.recovery.getSnapshot().items.length > 0 && c.recovery.getSnapshot().items !== this.protectedInput
            || !!loaded?.metadata.getSnapshot().dirty && (loaded.getSnapshot().state !== "ready" || loaded !== this.protectedLoaded?.resource || c.workspace.document(loaded.documentId).buffer !== this.protectedLoaded.buffer);
    }
    private publish(message = this.cell.get().message, preview = this.cell.get().preview): void {
        if (this.disposed) return;
        const next: DraftSnapshot = { busy: this.busy, present: this.envelope !== null, valid: !!this.draft, unprotected: this.needsProtection(), message,
            confirmation: this.confirmation?.kind ?? null, confirmationToken: this.confirmation?.confirmationToken ?? null, sourceUnits: this.draft?.source.text.length ?? 0, inputCount: this.draft?.input.length ?? 0, hasTransfer: this.draft?.transfer != null, hasLoaded: this.draft?.loaded != null, preview };
        const old = this.cell.get(); if (Object.keys(next).some(k => next[k as keyof DraftSnapshot] !== old[k as keyof DraftSnapshot])) this.cell.set(next);
    }
    private track(task: Promise<void>): void { this.jobs.add(task); void task.then(() => this.jobs.delete(task), () => this.jobs.delete(task)); }
    readonly reload = (): void => {
        if (this.disposed) return; const serial = ++this.serial; this.busy = true; this.loaded = false; this.confirmation = undefined;
        this.protectedSource = undefined; this.protectedConfiguration = undefined; this.protectedTransfer = undefined; this.protectedInput = undefined; this.protectedLoaded = undefined; this.publish("Loading stored draft…", null);
        this.track((async () => { try { const stored = await this.store.read(); if (this.disposed || serial !== this.serial) return;
            this.envelope = stored; this.draft = undefined; this.loaded = true;
            if (stored) this.draft = decode(stored, this.controller);
            this.publish(stored ? "A stored draft is available. Restore choices never apply automatically." : "No stored draft. Keep a checkpoint before leaving unsaved inputs.");
        } catch { if (!this.disposed && serial === this.serial) this.publish("Recovery storage or its draft is unavailable. Current inputs are retained."); }
        finally { if (!this.disposed && serial === this.serial) { this.busy = false; this.publish(); } } })());
    };
    private capture(kind: Kind): Capture {
        const c = this.controller, source = c.source.metadata.getSnapshot(), configuration = c.connection.getSnapshot(), loaded = c.loadedSource.getSnapshot(), metadata = loaded.resource?.metadata.getSnapshot();
        return Object.freeze({ kind, confirmationToken: token(), token: this.envelope?.token ?? null, source: c.workspace.captureResource(c.source.id), configuration: c.workspace.captureResource(c.connection.id),
            sourceRevision: c.workspace.document(c.source.documentId).revision, configurationRevision: configuration.revision,
            sourceVersion: source.serverVersion, configurationVersion: configuration.metadata.serverVersion,
            sourceAuthority: this.sourceAuthority, configurationAuthority: this.configurationAuthority,
            transfer: c.workspace.captureResource(c.transfer.resource.id), transferRevision: c.transfer.resource.getSnapshot().revision,
            transferVersion: c.transfer.resource.metadata.getSnapshot().serverVersion, transferAuthority: this.transferAuthority,
            loaded: loaded.resource ? c.workspace.captureResource(loaded.resource.id) : null, loadedGeneration: loaded.generation,
            loadedRevision: loaded.resource && metadata?.state === "ready" ? c.workspace.document(loaded.resource.documentId).revision : null,
            loadedVersion: metadata?.serverVersion ?? null, loadedAuthority: this.loadedAuthority,
            view: kind === "source" ? c.captureRecoveryView(c.source.documentId) ?? null : kind === "loaded" && loaded.resource ? c.captureRecoveryView(loaded.resource.documentId) ?? null : null });
    }
    private currentLoaded(capture: Capture, editing: boolean): boolean {
        const c = this.controller, slot = c.loadedSource.getSnapshot(), resource = slot.resource, metadata = resource?.metadata.getSnapshot();
        if (slot.generation !== capture.loadedGeneration || editing && capture.loadedAuthority !== this.loadedAuthority) return false;
        if (capture.loaded === null) return resource === null;
        return !!resource && !!c.workspace.resolveResource(capture.loaded) && metadata?.state === "ready"
            && c.workspace.document(resource.documentId).revision === capture.loadedRevision && metadata.serverVersion === capture.loadedVersion
            && (!editing || metadata.capabilities.edit.includes("human") && metadata.editLock === null);
    }
    private current(capture: Capture): boolean {
        const c = this.controller, source = c.source.metadata.getSnapshot(), configuration = c.connection.getSnapshot();
        if (this.disposed || !c.workspace.resolveResource(capture.source) || !c.workspace.resolveResource(capture.configuration) || !c.workspace.resolveResource(capture.transfer)) return false;
        if (capture.kind === "discard") return true;
        if (capture.view && !c.workspace.ownsDocumentView(capture.view)) return false;
        const sourceCurrent = source.state === "ready" && c.workspace.document(c.source.documentId).revision === capture.sourceRevision && source.serverVersion === capture.sourceVersion;
        const configurationCurrent = configuration.state === "ready" && configuration.revision === capture.configurationRevision && configuration.metadata.serverVersion === capture.configurationVersion;
        const transfer = c.transfer.resource.getSnapshot(), transferCurrent = transfer.state === "ready" && transfer.revision === capture.transferRevision && transfer.metadata.serverVersion === capture.transferVersion;
        if (capture.kind === "keep") return sourceCurrent && configurationCurrent && transferCurrent && this.currentLoaded(capture, false) && c.canCaptureRecovery() && !this.hasComposition();
        if (capture.kind === "loaded") return this.currentLoaded(capture, true) && c.canCaptureRecovery() && !this.hasComposition();
        if (capture.kind === "source") return sourceCurrent && c.canCaptureRecovery() && !this.hasComposition() && capture.sourceAuthority === this.sourceAuthority && source.capabilities.edit.includes("human") && source.editLock === null;
        if (capture.kind === "transfer") return transferCurrent && !this.hasComposition() && capture.transferAuthority === this.transferAuthority && transfer.metadata.capabilities.edit.includes("human") && transfer.metadata.editLock === null;
        return configurationCurrent && !this.hasComposition() && capture.configurationAuthority === this.configurationAuthority && configuration.metadata.capabilities.edit.includes("human") && configuration.metadata.editLock === null;
    }
    readonly prepare = (kind: Kind): void => {
        if (this.disposed || this.busy) return;
        if (!this.loaded) { this.publish("Retry recovery storage before keeping a draft. Current inputs are retained."); return; }
        if (kind !== "keep" && !this.envelope || (kind === "source" || kind === "configuration" || kind === "transfer") && !this.draft) return;
        if (kind === "loaded" && !this.draft?.loaded) return;
        let capture: Capture;
        try { capture = this.capture(kind); if (!this.current(capture)) throw new Error("Unavailable inputs."); }
        catch { this.publish("Finish pending input or unavailable resource work first."); return; }
        this.confirmation = capture;
        if (kind === "keep" && !this.envelope) this.confirm();
        else this.publish(kind === "keep" ? "Replace the stored copy with the current inputs?" : kind === "discard" ? "Discard the stored copy? Current inputs stay here."
            : kind === "source" ? `Restore source over the current working text? Stored base ${this.draft!.source.serverVersion ?? "none"}; current base ${capture.sourceVersion ?? "none"}.`
            : kind === "configuration" ? "Restore the stored configuration over the current configuration?"
            : kind === "loaded" ? "Restore the stored loaded-source draft? Original source inputs stay unchanged." : "Restore the stored transfer settings over the current transfer settings?");
    };
    readonly cancel = (expected: string | null = this.confirmation?.confirmationToken ?? null): void => {
        if (this.disposed || this.busy || expected !== (this.confirmation?.confirmationToken ?? null)) return;
        this.confirmation = undefined; this.publish("Draft action canceled."); };
    readonly inspect = (): void => { if (this.draft) this.publish("Stored text previews (up to 4,096 characters each).", this.draft.source.text.slice(0, 4096) + (this.draft.loaded ? "\nLoaded source:\n" + this.draft.loaded.text.slice(0, 4096) : "") + (this.draft.input.length ? "\nRecovered input from an earlier capture:\n" + this.draft.input.at(-1)!.attemptedText.slice(0, 4096) : "")); };
    readonly confirm = (expected: string | null = this.confirmation?.confirmationToken ?? null): void => {
        if (this.disposed || this.busy || expected !== (this.confirmation?.confirmationToken ?? null)) return;
        const capture = this.confirmation; if (!capture || !this.current(capture)) { this.confirmation = undefined; this.publish("Inputs changed. Choose the draft action again."); return; }
        const c = this.controller, document = c.workspace.document(c.source.documentId), configuration = c.connection.getSnapshot(), input = c.recovery.getSnapshot().items;
        const transfer = c.transfer.resource.getSnapshot(); if (configuration.state !== "ready" || transfer.state !== "ready") return;
        const loaded = c.loadedSource.getSnapshot().resource, loadedState = loaded?.getSnapshot(), loadedDocument = loadedState?.state === "ready" ? c.workspace.document(loaded!.documentId) : undefined;
        const serial = ++this.serial; this.busy = true; this.mutations++; this.confirmation = undefined; this.publish("Completing draft action…", null);
        this.track((async () => { try {
            // Yield before the explicit full transfer; ordinary edits only retained immutable captures.
            await new Promise<void>(done => setTimeout(done, 0)); if (this.disposed || serial !== this.serial) return;
            const record: Draft | undefined = capture.kind === "keep" ? Object.freeze({ format: 3, id: token(), created: Date.now(),
            source: Object.freeze({ key: document.key, revision: document.revision, serverVersion: capture.sourceVersion, text: document.buffer.text() }),
            configuration: Object.freeze({ key: configuration.metadata.key, revision: configuration.revision, serverVersion: capture.configurationVersion, value: Object.freeze({ ...configuration.value() }) }),
            transfer: Object.freeze({ key: transfer.metadata.key, revision: transfer.revision, serverVersion: capture.transferVersion, value: transfer.value() }),
            loaded: loadedState?.metadata.dirty && loadedDocument ? Object.freeze({ identity: "temporary-loaded-source", revision: loadedDocument.revision, serverVersion: capture.loadedVersion, text: loadedDocument.buffer.text() }) : null,
            input: Object.freeze([...(this.draft?.input.filter(i => i.session !== this.session) ?? []), ...input.map((i, ordinal) => Object.freeze({ session: this.session, ordinal,
                expectedRevision: i.expectedRevision, reason: i.reason, contextFrom: i.contextFrom, attemptedText: i.attemptedText, attemptedEdit: i.attemptedEdit }))]) }) : undefined;
            if (record) {
                await this.store.write(Object.freeze({ token: record.id, value: record }), capture.token); if (this.disposed || serial !== this.serial) return;
                this.envelope = Object.freeze({ token: record.id, value: record }); this.draft = record; this.protectedSource = document.buffer;
                this.protectedConfiguration = configuration.value(); this.protectedTransfer = transfer.value(); this.protectedInput = input;
                this.protectedLoaded = record.loaded && loaded && loaded === c.loadedSource.getSnapshot().resource && loadedDocument ? { resource: loaded, buffer: loadedDocument.buffer } : undefined;
                this.publish("Draft checkpoint retained. Later changes need another checkpoint.");
            } else if (capture.kind === "discard") {
                await this.store.remove(capture.token!); if (this.disposed || serial !== this.serial) return;
                this.envelope = null; this.draft = undefined; this.protectedSource = undefined; this.protectedConfiguration = undefined; this.protectedTransfer = undefined; this.protectedInput = undefined; this.protectedLoaded = undefined;
                this.publish("Stored draft discarded. Current inputs are unchanged.");
            } else {
                const stored = await this.store.read(); if (this.disposed || serial !== this.serial) return;
                if (!stored || stored.token !== capture.token || !this.current(capture)) throw new Error("Stale restore.");
                const draft = decode(stored, c);
                if (capture.kind === "loaded") {
                    const resource = c.restoreLoadedDraft(draft.loaded!.text, capture.loadedGeneration, capture.view ?? undefined);
                    if (!resource) throw new Error("Loaded-source restore unavailable.");
                    this.protectedLoaded = { resource, buffer: c.workspace.document(resource.documentId).buffer };
                    this.publish("Loaded-source draft restored. Reopen loaded source to inspect; undo returns to its current base."); return;
                }
                const result = capture.kind === "source" ? c.workspace.replaceText(c.source.documentId, draft.source.text,
                    { expectedRevision: capture.sourceRevision, origin: "human", history: "record", ...(capture.view ? { view: capture.view } : {}) })
                    : capture.kind === "configuration" ? c.workspace.updateResource(c.connection, { expectedRevision: capture.configurationRevision, origin: "human", value: draft.configuration.value })
                    : c.workspace.updateResource(c.transfer.resource, { expectedRevision: capture.transferRevision, origin: "human", value: draft.transfer.value });
                if (!result.applied) throw new Error("Restore unavailable.");
                if (capture.kind === "source") this.protectedSource = c.workspace.document(c.source.documentId).buffer;
                else if (capture.kind === "configuration") { const restored = c.connection.getSnapshot(); this.protectedConfiguration = restored.state === "ready" ? restored.value() : undefined; }
                else { const restored = c.transfer.resource.getSnapshot(); this.protectedTransfer = restored.state === "ready" ? restored.value() : undefined; }
                this.publish(capture.kind === "source" ? "Source draft restored. Undo returns to the loaded source." : capture.kind === "configuration" ? "Configuration draft restored independently." : "Transfer draft restored independently.");
            }
        } catch { if (!this.disposed && serial === this.serial) {
            // A peer may have replaced the covered copy before its notification arrived.
            this.protectedSource = undefined; this.protectedConfiguration = undefined; this.protectedTransfer = undefined; this.protectedInput = undefined; this.protectedLoaded = undefined;
            this.publish("Draft action failed or became stale. Current inputs are retained; recheck storage before relying on a stored copy.");
        } }
        finally { this.mutations--; if (!this.disposed && serial === this.serial) { this.busy = false; this.publish(); } } })());
    };
    shouldWarnOnLeave(): boolean { return !this.disposed && (this.mutations > 0 || this.needsProtection() || this.hasComposition() || !this.controller.canCaptureRecovery() || this.controller.hasPendingRecoveryWork(false)); }
    attachNavigation(owner: Window & typeof globalThis): void {
        if (this.detachNavigation) throw new Error("Navigation guard already attached.");
        const composing = new Set<EventTarget>();
        const start = (event: CompositionEvent) => { if (event.target instanceof owner.Node && owner.document.getElementById("host")?.contains(event.target)) composing.add(event.target); };
        const end = (event: CompositionEvent) => { if (event.target) composing.delete(event.target); };
        this.hasComposition = () => { for (const target of composing) if (!(target instanceof owner.Node) || !target.isConnected) composing.delete(target); return composing.size > 0; };
        const beforeUnload = (event: BeforeUnloadEvent) => { if (this.shouldWarnOnLeave()) { event.preventDefault(); event.returnValue = "Current work is not protected."; } };
        owner.addEventListener("beforeunload", beforeUnload); owner.document.addEventListener("compositionstart", start, true); owner.document.addEventListener("compositionend", end, true);
        this.detachNavigation = () => { owner.removeEventListener("beforeunload", beforeUnload); owner.document.removeEventListener("compositionstart", start, true); owner.document.removeEventListener("compositionend", end, true); composing.clear(); this.hasComposition = () => false; };
    }
    debug() { return Object.freeze({ ...this.cell.get(), preview: this.cell.get().preview === null ? null : Object.freeze({ units: this.cell.get().preview!.length }), jobs: this.jobs.size, subscriptions: this.cell.count(), disposed: this.disposed }); }
    dispose(): Promise<void> { if (this.disposal) return this.disposal; this.disposed = true; this.serial++; this.detachNavigation?.(); this.stops.forEach(stop => stop()); this.protectedLoaded = undefined;
        this.disposal = Promise.allSettled([...this.jobs]).then(() => this.store.close()); return this.disposal; }
}
