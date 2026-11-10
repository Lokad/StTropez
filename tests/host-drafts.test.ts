import assert from "node:assert/strict";
import test from "node:test";
import { HostController } from "../examples/hosts/controller.ts";
import { HostDraftRecovery } from "../examples/hosts/draft-recovery.ts";
import type { DraftStore, StoredDraft } from "../examples/hosts/draft-store.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function storage() {
    const shared = { value: null as StoredDraft | null, writeGate: undefined as Promise<void> | undefined, readGate: undefined as Promise<void> | undefined, failWrite: false };
    const port = (): DraftStore => ({ read: async () => { const value = structuredClone(shared.value); await shared.readGate; return value; },
        write: async (value, expected) => { await shared.writeGate; if (shared.failWrite || (shared.value?.token ?? null) !== expected) throw new Error("Storage rejected write."); shared.value = structuredClone(value); },
        remove: async expected => { if (shared.value?.token !== expected) throw new Error("Stale discard."); shared.value = null; }, watch: () => () => {}, close: async () => {} });
    return { shared, port };
}
async function idle(draft: HostDraftRecovery) { for (let i = 0; i < 100 && draft.debug().jobs; i++) await new Promise<void>(done => setTimeout(done, 0)); assert.equal(draft.debug().jobs, 0); }
function text(c: HostController) { const b = c.workspace.document(c.source.documentId).buffer; return b.slice(0, b.length); }
function edit(c: HostController, value: string) { const d = c.workspace.document(c.source.documentId); assert.equal(c.workspace.edit({ documentId: d.id, expectedRevision: d.revision, origin: "human", edits: [{ from: 0, to: d.buffer.length, insert: value }], history: { kind: "replace" } }).applied, true); }
async function seeded() { const store = storage(), c = new HostController(), d = new HostDraftRecovery(c, store.port()); await idle(d); edit(c, "stored café😀\r\ndraft"); c.setPath("stored.csv"); d.prepare("keep"); await idle(d); await d.dispose(); await c.dispose(); return store; }
async function close(c: HostController, d: HostDraftRecovery) { const a = d.dispose(), b = c.dispose(); await Promise.all([a, b]); assert.equal(c.workspace.diagnostics().subscriptions, 0); }

test("checkpoint transfers captured versions without exporting ordinary later edits", async () => {
    const store = storage(), c = new HostController(), d = new HostDraftRecovery(c, store.port()); await idle(d); edit(c, "captured"); c.setPath("captured.csv");
    const before = c.workspace.document(c.source.documentId).buffer; assert.equal(before.readMetrics().textExports, 0); const gate = deferred(); store.shared.writeGate = gate.promise; d.prepare("keep");
    edit(c, "later correction"); c.setPath("later.csv"); assert.equal(d.shouldWarnOnLeave(), true); gate.resolve(); await idle(d);
    const saved = store.shared.value!.value as { source: { text: string }; configuration: { value: { path: string } } };
    assert.equal(saved.source.text, "captured"); assert.equal(saved.configuration.value.path, "captured.csv"); assert.equal(text(c), "later correction");
    assert.equal(before.readMetrics().textExports, 1); assert.equal(c.workspace.document(c.source.documentId).buffer.readMetrics().textExports, 0); assert.equal(d.shouldWarnOnLeave(), true); await close(c, d);
});
test("new session offers independent source/configuration restore with a new undo history", async () => {
    const store = await seeded(), envelope = structuredClone(store.shared.value!);
    const extra = { remoteOptions: { columns: ["id", "Δ"], separator: ";", retained: true }, opaqueZero: -0 };
    const payload = envelope.value as { configuration: { value: Record<string, unknown> } }; payload.configuration.value = { ...payload.configuration.value, ...extra }; store.shared.value = envelope;
    const c = new HostController(), d = new HostDraftRecovery(c, store.port()); await idle(d); assert.equal(text(c), "start"); assert.equal(d.state.getSnapshot().present, true);
    d.prepare("source"); d.confirm(); await idle(d); assert.equal(text(c), "stored café😀\r\ndraft"); assert.equal(c.source.metadata.getSnapshot().serverVersion, "v0"); assert.equal(c.workspace.observeHistory(c.source.documentId).getSnapshot().undoDepth, 1);
    const initialConfiguration = c.connection.getSnapshot(); assert.equal(initialConfiguration.state === "ready" && initialConfiguration.value.path, "source.csv");
    d.prepare("configuration"); d.confirm(); await idle(d); const configuration = c.connection.getSnapshot(); assert.equal(configuration.state === "ready" && configuration.value.path, "stored.csv"); assert.equal(d.shouldWarnOnLeave(), false);
    assert.deepEqual(configuration.state === "ready" && configuration.value, { path: "stored.csv", format: "csv", ...extra });
    c.workspace.undo({ documentId: c.source.documentId, expectedRevision: c.workspace.document(c.source.documentId).revision }); assert.equal(text(c), "start"); await close(c, d);
});
test("stale source confirmation retains corrections while independent configuration can restore", async () => {
    const store = await seeded(), c = new HostController(), d = new HostDraftRecovery(c, store.port()); await idle(d); d.prepare("source"); edit(c, "human correction"); d.confirm(); await idle(d); assert.equal(text(c), "human correction");
    d.prepare("configuration"); edit(c, "further correction"); d.confirm(); await idle(d); assert.equal(text(c), "further correction"); const configuration = c.connection.getSnapshot(); assert.equal(configuration.state === "ready" && configuration.value.path, "stored.csv"); await close(c, d);
});

test("configuration save receipt expires a pending restore and pending Save still warns with checkpoint coverage", async () => {
    const store = storage(), c = new HostController(), d = new HostDraftRecovery(c, store.port()); await idle(d);
    c.setPath("checkpoint.csv"); d.prepare("keep"); await idle(d); assert.equal(d.shouldWarnOnLeave(), false);
    const gate = deferred(); store.shared.readGate = gate.promise; d.prepare("configuration"); d.confirm();
    c.configurationSave.save(); await new Promise<void>(done => setImmediate(done)); assert.equal(d.shouldWarnOnLeave(), true);
    c.configurationSave.finish(); await new Promise<void>(done => setImmediate(done)); gate.resolve(); await idle(d);
    const state = c.connection.getSnapshot(); assert.equal(state.state === "ready" && state.value.path, "checkpoint.csv"); assert.equal(state.metadata.serverVersion, "configuration-v1"); assert.equal(state.metadata.dirty, false);
    assert.match(d.state.getSnapshot().message, /changed|stale|expired/i); assert.equal(text(c), "start"); await close(c, d);
});

test("transfer checkpoints retain invalid and opaque input, restore independently and expire after a Save receipt", async () => {
    const store = storage(), c = new HostController(), d = new HostDraftRecovery(c, store.port()); await idle(d);
    const value = { destination: "kept.csv", batchSize: "1e", opaque: { columns: ["Δ"], zero: -0 } };
    c.workspace.updateResource(c.transfer.resource, { expectedRevision: 0, origin: "human", value }); assert.equal(d.shouldWarnOnLeave(), true); d.prepare("keep"); await idle(d); assert.equal(d.shouldWarnOnLeave(), false);
    c.transfer.update("destination", "correction.csv"); d.prepare("transfer"); edit(c, "independent source"); c.setPath("independent.csv"); d.confirm(); await idle(d);
    let s = c.transfer.resource.getSnapshot(); assert.deepEqual(s.state === "ready" && s.value, value); assert.equal(text(c), "independent source"); assert.equal(c.configurationSave.validation(), null);
    c.transfer.update("batchSize", "100"); const gate = deferred(); store.shared.readGate = gate.promise; d.prepare("transfer"); d.confirm(); c.transfer.save.save(); await new Promise<void>(done => setImmediate(done)); c.transfer.save.finish(); await new Promise<void>(done => setImmediate(done)); gate.resolve(); await idle(d);
    s = c.transfer.resource.getSnapshot(); assert.equal(s.metadata.serverVersion, "transfer-v1"); assert.equal(s.state === "ready" && s.value.batchSize, "100"); assert.match(d.state.getSnapshot().message, /failed|stale|changed/i); await close(c, d);
});

test("legacy checkpoints retain source/configuration recovery without inventing a transfer copy", async () => {
    const store = await seeded(), envelope = structuredClone(store.shared.value!); const payload = envelope.value as Record<string, unknown>; payload.format = 1; delete payload.transfer; store.shared.value = envelope;
    const c = new HostController(), d = new HostDraftRecovery(c, store.port()); await idle(d); assert.equal(d.state.getSnapshot().valid, true); assert.equal(d.state.getSnapshot().hasTransfer, false);
    c.transfer.update("batchSize", "invalid"); d.prepare("transfer"); assert.equal(d.state.getSnapshot().confirmation, null); d.prepare("configuration"); d.confirm(); await idle(d); const s = c.transfer.resource.getSnapshot(); assert.equal(s.state === "ready" && s.value.batchSize, "invalid"); assert.equal(d.shouldWarnOnLeave(), true); await close(c, d);
});
for (const change of ["revision", "authority"] as const) test(`restore revalidates ${change} after asynchronous storage read`, async () => {
    const store = await seeded(), c = new HostController(), d = new HostDraftRecovery(c, store.port()); await idle(d); const gate = deferred(); store.shared.readGate = gate.promise; d.prepare("source"); d.confirm();
    if (change === "revision") edit(c, "later human text"); else { const m = c.source.metadata.getSnapshot(); c.workspace.setCapabilities(c.source.id, { ...m.capabilities, edit: ["host"] }); c.workspace.setCapabilities(c.source.id, m.capabilities); }
    gate.resolve(); await idle(d); assert.equal(text(c), change === "revision" ? "later human text" : "start"); assert.ok(store.shared.value); await close(c, d);
});
test("failed write and stale discard preserve the previous stored copy and live inputs", async () => {
    const store = await seeded(), old = structuredClone(store.shared.value), c = new HostController(), d = new HostDraftRecovery(c, store.port()); await idle(d); edit(c, "latest local work"); store.shared.failWrite = true; d.prepare("keep"); d.confirm(); await idle(d); assert.deepEqual(store.shared.value, old); assert.equal(text(c), "latest local work");
    d.prepare("discard"); store.shared.value = { token: "newer", value: old!.value }; d.confirm(); await idle(d); assert.equal(store.shared.value.token, "newer"); assert.equal(text(c), "latest local work"); await close(c, d);
});

for (const kind of ["keep", "discard"] as const) for (const input of ["source", "configuration", "transfer", "rejected input"] as const) test(`failed ${kind} invalidates ${input} coverage after an unseen peer replacement`, async () => {
    const store = storage(), c = new HostController(), d = new HostDraftRecovery(c, store.port());
    try { await idle(d); if (input === "source") edit(c, "owned unsaved work");
        else if (input === "configuration") c.setPath("owned.csv");
        else if (input === "transfer") c.transfer.update("destination", "owned-target.csv");
        else c.captureInputConflict(c.source.documentId, { documentId: c.source.documentId, expectedRevision: 0, reason: "composition-detached", contextFrom: 0, attemptedText: "owned preedit", attemptedEdit: { from: 0, to: 0, insert: "owned preedit" } });
        d.prepare("keep"); await idle(d); assert.equal(d.shouldWarnOnLeave(), false);
        const peer = structuredClone(store.shared.value!.value) as { id: string; source: { text: string }; configuration: { value: { path: string } }; transfer: { value: { destination: string } }; input: unknown[] }; peer.id = "peer-newer"; peer.source.text = "other page draft"; peer.configuration.value.path = "peer.csv"; peer.transfer.value.destination = "peer-target.csv"; peer.input = [];
        store.shared.value = { token: peer.id, value: peer }; const before = c.workspace.document(c.source.documentId), history = c.workspace.observeHistory(c.source.documentId).getSnapshot(), beforeText = text(c), configuration = c.connection.getSnapshot(), recovered = c.recovery.getSnapshot();
        d.prepare(kind); d.confirm(); await idle(d);
        assert.equal(text(c), beforeText); assert.equal(c.workspace.document(c.source.documentId).revision, before.revision); assert.deepEqual(c.workspace.observeHistory(c.source.documentId).getSnapshot(), history); assert.deepEqual(c.connection.getSnapshot(), configuration); assert.deepEqual(c.recovery.getSnapshot(), recovered); assert.deepEqual(store.shared.value, { token: peer.id, value: peer });
        assert.equal(d.shouldWarnOnLeave(), true); assert.equal(d.state.getSnapshot().unprotected, true);
    } finally { await close(c, d); }
});
test("unsupported stored data never applies and explicit discard leaves current work alone", async () => {
    const store = storage(); store.shared.value = { token: "bad", value: { format: 999, source: { text: "injected" } } }; const c = new HostController(), d = new HostDraftRecovery(c, store.port()); await idle(d); assert.equal(d.state.getSnapshot().valid, false); d.prepare("source"); d.confirm(); assert.equal(text(c), "start");
    edit(c, "owned work"); d.prepare("discard"); d.confirm(); await idle(d); assert.equal(store.shared.value, null); assert.equal(text(c), "owned work"); assert.equal(d.shouldWarnOnLeave(), true); await close(c, d);
});
test("pending input prevents checkpoint transfer and disposal expires a delayed restore", async () => {
    const store = await seeded(), c = new HostController(), d = new HostDraftRecovery(c, store.port()); await idle(d); const stop = c.registerInputCaptureGuard(() => false); d.prepare("keep"); d.confirm(); await idle(d); assert.equal(c.workspace.document(c.source.documentId).buffer.readMetrics().textExports, 0); assert.equal(d.shouldWarnOnLeave(), true); stop();
    const gate = deferred(); store.shared.readGate = gate.promise; d.prepare("source"); d.confirm(); const disposal = d.dispose(); gate.resolve(); await disposal; assert.equal(text(c), "start"); await c.dispose(); assert.equal(c.workspace.diagnostics().subscriptions, 0);
});
test("rejected preedit survives storage without becoming committed text in a new session", async () => {
    const store = storage(), c = new HostController(), d = new HostDraftRecovery(c, store.port()); await idle(d);
    c.captureInputConflict(c.source.documentId, { documentId: c.source.documentId, expectedRevision: 0, reason: "composition-detached", attemptedText: "uncommitted café😀", contextFrom: 0, attemptedEdit: { from: 0, to: 0, insert: "uncommitted café😀" } });
    d.prepare("keep"); await idle(d); assert.equal(text(c), "start"); assert.equal(d.shouldWarnOnLeave(), false); await close(c, d);
    const next = new HostController(), recovered = new HostDraftRecovery(next, store.port()); await idle(recovered); assert.equal(text(next), "start"); assert.equal(next.recovery.getSnapshot().items.length, 0); assert.equal(recovered.state.getSnapshot().inputCount, 1);
    recovered.inspect(); assert.ok(recovered.state.getSnapshot().preview!.includes("uncommitted café😀")); await close(next, recovered);
});
test("foreign resource keys cannot restore a stored source", async () => {
    const store = await seeded(); const raw = store.shared.value!.value as { source: { key: { resource: string } } }; raw.source.key.resource = "another-resource";
    const c = new HostController(), d = new HostDraftRecovery(c, store.port()); await idle(d); assert.equal(d.state.getSnapshot().valid, false); d.prepare("source"); d.confirm(); await idle(d); assert.equal(text(c), "start"); assert.ok(store.shared.value); await close(c, d);
});
