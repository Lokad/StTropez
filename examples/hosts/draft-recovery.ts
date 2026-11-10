import type { ResourceKey, ResourceTarget, TextBuffer, TextEdit } from "../../src/index.ts";
import type { Connection, HostController } from "./controller.ts";
import type { DraftStore, StoredDraft } from "./draft-store.ts";
import { HostCell } from "../shared/observable.ts";
import type { TransferSettings } from "./transfers.ts";

type InputCopy = Readonly<{ session: string; ordinal: number; expectedRevision: number; reason: string; contextFrom: number; attemptedText: string; attemptedEdit: TextEdit | null }>;
type Draft = Readonly<{ format: 2; id: string; created: number;
    source: Readonly<{ key: ResourceKey; revision: number; serverVersion: string | null; text: string }>;
    configuration: Readonly<{ key: ResourceKey; revision: number; serverVersion: string | null; value: Connection }>;
    transfer: Readonly<{ key: ResourceKey; revision: number; serverVersion: string | null; value: TransferSettings }> | null;
    input: readonly InputCopy[] }>;
type Kind = "keep" | "source" | "configuration" | "transfer" | "discard";
type Capture = Readonly<{ kind: Kind; token: string | null; source: ResourceTarget; configuration: ResourceTarget;
    sourceRevision: number; configurationRevision: number; sourceVersion: string | null; configurationVersion: string | null;
    sourceAuthority: number; configurationAuthority: number; transfer: ResourceTarget; transferRevision: number; transferVersion: string | null; transferAuthority: number }>;
type DraftState = Readonly<{ busy: boolean; present: boolean; valid: boolean; unprotected: boolean; message: string;
    confirmation: Kind | null; sourceUnits: number; inputCount: number; hasTransfer: boolean; preview: string | null }>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const version = (value: unknown): value is string | null => value === null || typeof value === "string";
const keyEquals = (a: unknown, b: ResourceKey): boolean => object(a) && a.scope === b.scope && a.resource === b.resource && a.variant === b.variant;
function token(): string { return [...crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16).padStart(8, "0")).join(""); }

function decode(stored: StoredDraft, controller: HostController): Draft {
    const d = stored.value, sourceKey = controller.source.metadata.getSnapshot().key, configurationKey = controller.connection.metadata.getSnapshot().key;
    if (!object(d) || d.format !== 1 && d.format !== 2 || d.id !== stored.token || !integer(d.created) || !object(d.source) || !object(d.configuration) || !Array.isArray(d.input)
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
    if (d.format === 2 && (!object(t) || !keyEquals(t.key, transferKey) || !integer(t.revision) || !version(t.serverVersion)
        || !object(t.value) || typeof t.value.destination !== "string" || typeof t.value.batchSize !== "string")) throw new Error("Unsupported transfer recovery draft.");
    const transfer = d.format === 2 && object(t) ? Object.freeze({ key: transferKey, revision: t.revision as number, serverVersion: t.serverVersion as string | null, value: Object.freeze(structuredClone(t.value)) as TransferSettings }) : null;
    return Object.freeze({ format: 2, id: stored.token, created: d.created, transfer,
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
    private confirmation: Capture | undefined;
    private protectedSource: TextBuffer | undefined;
    private protectedConfiguration: unknown;
    private protectedTransfer: unknown;
    private protectedInput: unknown;
    private readonly jobs = new Set<Promise<void>>();
    private readonly stops: (() => void)[] = [];
    private detachNavigation: (() => void) | undefined;
    private hasComposition: () => boolean = () => false;
    private readonly cell = new HostCell<DraftState>({ busy: true, present: false, valid: false, unprotected: false, message: "Loading stored draft…", confirmation: null, sourceUnits: 0, inputCount: 0, hasTransfer: false, preview: null });
    readonly state = this.cell.observable;
    constructor(controller: HostController, store: DraftStore) {
        this.controller = controller; this.store = store;
        const authority = (kind: "source" | "configuration" | "transfer") => { const m = (kind === "source" ? controller.source : kind === "configuration" ? controller.connection : controller.transfer.resource).metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]); };
        let source = authority("source"), configuration = authority("configuration"), transfer = authority("transfer");
        this.stops.push(controller.workspace.observeDocument(controller.source.documentId).subscribe(() => this.publish()),
            controller.source.metadata.subscribe(() => { const next = authority("source"); if (next !== source) { source = next; this.sourceAuthority++; } this.publish(); }),
            controller.connection.subscribe(() => { const next = authority("configuration"); if (next !== configuration) { configuration = next; this.configurationAuthority++; } this.publish(); }),
            controller.transfer.resource.subscribe(() => { const next = authority("transfer"); if (next !== transfer) { transfer = next; this.transferAuthority++; } this.publish(); }),
            controller.recovery.subscribe(() => this.publish()), store.watch(() => { this.protectedSource = undefined; this.protectedConfiguration = undefined; this.protectedTransfer = undefined; this.protectedInput = undefined; this.reload(); }));
        this.reload();
    }
    private needsProtection(): boolean {
        const c = this.controller, source = c.source.metadata.getSnapshot(), configuration = c.connection.getSnapshot(), transfer = c.transfer.resource.getSnapshot();
        return source.dirty && (source.state !== "ready" || c.workspace.document(c.source.documentId).buffer !== this.protectedSource)
            || configuration.metadata.dirty && (configuration.state !== "ready" || configuration.value !== this.protectedConfiguration)
            || transfer.metadata.dirty && (transfer.state !== "ready" || transfer.value !== this.protectedTransfer)
            || c.recovery.getSnapshot().items.length > 0 && c.recovery.getSnapshot().items !== this.protectedInput;
    }
    private publish(message = this.cell.get().message, preview = this.cell.get().preview): void {
        if (this.disposed) return;
        const next: DraftState = { busy: this.busy, present: this.envelope !== null, valid: !!this.draft, unprotected: this.needsProtection(), message,
            confirmation: this.confirmation?.kind ?? null, sourceUnits: this.draft?.source.text.length ?? 0, inputCount: this.draft?.input.length ?? 0, hasTransfer: this.draft?.transfer != null, preview };
        const old = this.cell.get(); if (Object.keys(next).some(k => next[k as keyof DraftState] !== old[k as keyof DraftState])) this.cell.set(next);
    }
    private track(task: Promise<void>): void { this.jobs.add(task); void task.then(() => this.jobs.delete(task), () => this.jobs.delete(task)); }
    readonly reload = (): void => {
        if (this.disposed) return; const serial = ++this.serial; this.busy = true; this.loaded = false; this.confirmation = undefined;
        this.protectedSource = undefined; this.protectedConfiguration = undefined; this.protectedTransfer = undefined; this.protectedInput = undefined; this.publish("Loading stored draft…", null);
        this.track((async () => { try { const stored = await this.store.read(); if (this.disposed || serial !== this.serial) return;
            this.envelope = stored; this.draft = undefined; this.loaded = true;
            if (stored) this.draft = decode(stored, this.controller);
            this.publish(stored ? "A stored draft is available. Restore choices never apply automatically." : "No stored draft. Keep a checkpoint before leaving unsaved inputs.");
        } catch { if (!this.disposed && serial === this.serial) this.publish("Recovery storage or its draft is unavailable. Current inputs are retained."); }
        finally { if (!this.disposed && serial === this.serial) { this.busy = false; this.publish(); } } })());
    };
    private capture(kind: Kind): Capture {
        const c = this.controller, source = c.source.metadata.getSnapshot(), configuration = c.connection.getSnapshot();
        return Object.freeze({ kind, token: this.envelope?.token ?? null, source: c.workspace.captureResource(c.source.id), configuration: c.workspace.captureResource(c.connection.id),
            sourceRevision: c.workspace.document(c.source.documentId).revision, configurationRevision: configuration.revision,
            sourceVersion: source.serverVersion, configurationVersion: configuration.metadata.serverVersion,
            sourceAuthority: this.sourceAuthority, configurationAuthority: this.configurationAuthority,
            transfer: c.workspace.captureResource(c.transfer.resource.id), transferRevision: c.transfer.resource.getSnapshot().revision,
            transferVersion: c.transfer.resource.metadata.getSnapshot().serverVersion, transferAuthority: this.transferAuthority });
    }
    private current(capture: Capture): boolean {
        const c = this.controller, source = c.source.metadata.getSnapshot(), configuration = c.connection.getSnapshot();
        if (this.disposed || !c.workspace.resolveResource(capture.source) || !c.workspace.resolveResource(capture.configuration) || !c.workspace.resolveResource(capture.transfer)) return false;
        if (capture.kind === "discard") return true;
        const sourceCurrent = source.state === "ready" && c.workspace.document(c.source.documentId).revision === capture.sourceRevision && source.serverVersion === capture.sourceVersion;
        const configurationCurrent = configuration.state === "ready" && configuration.revision === capture.configurationRevision && configuration.metadata.serverVersion === capture.configurationVersion;
        const transfer = c.transfer.resource.getSnapshot(), transferCurrent = transfer.state === "ready" && transfer.revision === capture.transferRevision && transfer.metadata.serverVersion === capture.transferVersion;
        if (capture.kind === "keep") return sourceCurrent && configurationCurrent && transferCurrent && c.canCaptureRecovery() && !this.hasComposition();
        if (capture.kind === "source") return sourceCurrent && c.canCaptureRecovery() && !this.hasComposition() && capture.sourceAuthority === this.sourceAuthority && source.capabilities.edit.includes("human") && source.editLock === null;
        if (capture.kind === "transfer") return transferCurrent && !this.hasComposition() && capture.transferAuthority === this.transferAuthority && transfer.metadata.capabilities.edit.includes("human") && transfer.metadata.editLock === null;
        return configurationCurrent && !this.hasComposition() && capture.configurationAuthority === this.configurationAuthority && configuration.metadata.capabilities.edit.includes("human") && configuration.metadata.editLock === null;
    }
    readonly prepare = (kind: Kind): void => {
        if (this.disposed || this.busy) return;
        if (!this.loaded) { this.publish("Retry recovery storage before keeping a draft. Current inputs are retained."); return; }
        if (kind !== "keep" && !this.envelope || (kind === "source" || kind === "configuration") && !this.draft) return;
        if (kind === "transfer" && !this.draft?.transfer) return;
        let capture: Capture;
        try { capture = this.capture(kind); if (!this.current(capture)) throw new Error("Unavailable inputs."); }
        catch { this.publish("Finish pending input or unavailable resource work first."); return; }
        this.confirmation = capture;
        if (kind === "keep" && !this.envelope) this.confirm();
        else this.publish(kind === "keep" ? "Replace the stored copy with the current inputs?" : kind === "discard" ? "Discard the stored copy? Current inputs stay here."
            : kind === "source" ? `Restore source over the current working text? Stored base ${this.draft!.source.serverVersion ?? "none"}; current base ${capture.sourceVersion ?? "none"}.`
            : kind === "configuration" ? "Restore the stored configuration over the current configuration?" : "Restore the stored transfer settings over the current transfer settings?");
    };
    readonly cancel = (): void => { this.confirmation = undefined; this.publish("Draft action canceled."); };
    readonly inspect = (): void => { if (this.draft) this.publish("Stored source and last recovered input preview (up to 4,096 characters each).", this.draft.source.text.slice(0, 4096) + (this.draft.input.length ? "\nRecovered input from an earlier capture:\n" + this.draft.input.at(-1)!.attemptedText.slice(0, 4096) : "")); };
    readonly confirm = (): void => {
        const capture = this.confirmation; if (!capture || this.busy || !this.current(capture)) { this.confirmation = undefined; this.publish("Inputs changed. Choose the draft action again."); return; }
        const c = this.controller, document = c.workspace.document(c.source.documentId), configuration = c.connection.getSnapshot(), input = c.recovery.getSnapshot().items;
        const transfer = c.transfer.resource.getSnapshot(); if (configuration.state !== "ready" || transfer.state !== "ready") return;
        const serial = ++this.serial; this.busy = true; this.mutations++; this.confirmation = undefined; this.publish("Completing draft action…", null);
        this.track((async () => { try {
            // Yield before the explicit full transfer; ordinary edits only retained immutable captures.
            await new Promise<void>(done => setTimeout(done, 0)); if (this.disposed || serial !== this.serial) return;
            const record: Draft | undefined = capture.kind === "keep" ? Object.freeze({ format: 2, id: token(), created: Date.now(),
            source: Object.freeze({ key: document.key, revision: document.revision, serverVersion: capture.sourceVersion, text: document.buffer.text() }),
            configuration: Object.freeze({ key: configuration.metadata.key, revision: configuration.revision, serverVersion: capture.configurationVersion, value: Object.freeze({ ...configuration.value }) }),
            transfer: Object.freeze({ key: transfer.metadata.key, revision: transfer.revision, serverVersion: capture.transferVersion, value: transfer.value }),
            input: Object.freeze([...(this.draft?.input.filter(i => i.session !== this.session) ?? []), ...input.map((i, ordinal) => Object.freeze({ session: this.session, ordinal,
                expectedRevision: i.expectedRevision, reason: i.reason, contextFrom: i.contextFrom, attemptedText: i.attemptedText, attemptedEdit: i.attemptedEdit }))]) }) : undefined;
            if (record) {
                await this.store.write(Object.freeze({ token: record.id, value: record }), capture.token); if (this.disposed || serial !== this.serial) return;
                this.envelope = Object.freeze({ token: record.id, value: record }); this.draft = record; this.protectedSource = document.buffer;
                this.protectedConfiguration = configuration.value; this.protectedTransfer = transfer.value; this.protectedInput = input;
                this.publish("Draft checkpoint retained. Later changes need another checkpoint.");
            } else if (capture.kind === "discard") {
                await this.store.remove(capture.token!); if (this.disposed || serial !== this.serial) return;
                this.envelope = null; this.draft = undefined; this.protectedSource = undefined; this.protectedConfiguration = undefined; this.protectedTransfer = undefined; this.protectedInput = undefined;
                this.publish("Stored draft discarded. Current inputs are unchanged.");
            } else {
                const stored = await this.store.read(); if (this.disposed || serial !== this.serial) return;
                if (!stored || stored.token !== capture.token || !this.current(capture)) throw new Error("Stale restore.");
                const draft = decode(stored, c);
                const result = capture.kind === "source" ? c.workspace.edit({ documentId: c.source.documentId, expectedRevision: capture.sourceRevision, origin: "human",
                    edits: [{ from: 0, to: document.buffer.length, insert: draft.source.text }], history: { kind: "replace" } })
                    : capture.kind === "configuration" ? c.workspace.updateResource(c.connection, { expectedRevision: capture.configurationRevision, origin: "human", value: draft.configuration.value })
                    : c.workspace.updateResource(c.transfer.resource, { expectedRevision: capture.transferRevision, origin: "human", value: draft.transfer!.value });
                if (!result.applied) throw new Error("Restore unavailable.");
                if (capture.kind === "source") this.protectedSource = c.workspace.document(c.source.documentId).buffer;
                else if (capture.kind === "configuration") { const restored = c.connection.getSnapshot(); this.protectedConfiguration = restored.state === "ready" ? restored.value : undefined; }
                else { const restored = c.transfer.resource.getSnapshot(); this.protectedTransfer = restored.state === "ready" ? restored.value : undefined; }
                this.publish(capture.kind === "source" ? "Source draft restored. Undo returns to the loaded source." : capture.kind === "configuration" ? "Configuration draft restored independently." : "Transfer draft restored independently.");
            }
        } catch { if (!this.disposed && serial === this.serial) {
            // A peer may have replaced the covered copy before its notification arrived.
            this.protectedSource = undefined; this.protectedConfiguration = undefined; this.protectedTransfer = undefined; this.protectedInput = undefined;
            this.publish("Draft action failed or became stale. Current inputs are retained; recheck storage before relying on a stored copy.");
        } }
        finally { this.mutations--; if (!this.disposed && serial === this.serial) { this.busy = false; this.publish(); } } })());
    };
    shouldWarnOnLeave(): boolean { return !this.disposed && (this.mutations > 0 || this.needsProtection() || this.hasComposition() || !this.controller.canCaptureRecovery() || this.controller.hasPendingRecoveryWork()); }
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
    dispose(): Promise<void> { if (this.disposal) return this.disposal; this.disposed = true; this.serial++; this.detachNavigation?.(); this.stops.forEach(stop => stop());
        this.disposal = Promise.allSettled([...this.jobs]).then(() => this.store.close()); return this.disposal; }
}
