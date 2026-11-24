import test from "node:test";
import assert from "node:assert/strict";
import { HostController } from "../examples/hosts/controller.ts";
import { TextBuffer } from "../src/index.ts";
const text = (host: HostController) => { const buffer = host.workspace.document(host.source.documentId).buffer; return buffer.slice(0, buffer.length); };
function edit(host: HostController, value: string): void {
    const current = host.workspace.document(host.source.documentId);
    assert.equal(host.workspace.edit({ documentId: host.source.documentId, expectedRevision: current.revision, origin: "human", edits: [{ from: 0, to: current.buffer.length, insert: value }] }).applied, true);
}
const reference = (host: HostController) => { const buffer = host.comparisonReference.getSnapshot().baseline.buffer; return buffer.slice(0, buffer.length); };

test("draft/server/history selection retains later working corrections and explicit Run ownership", async () => {
    const host = new HostController();
    try {
        edit(host, "draft\r\n😀"); host.variants.keepDraft(); host.externalWrite("server one");
        assert.equal(host.variants.review("draft"), true); edit(host, "human while loading"); const history = host.debug().history;
        assert.equal(host.variants.finishNext(), true); assert.equal(reference(host), "draft\r\n😀"); assert.equal(text(host), "human while loading"); assert.deepEqual(host.debug().history, history);
        assert.equal(host.debug().source.serverVersion, "v0"); assert.equal(host.debug().source.dirty, true); assert.equal(host.debug().pendingSaves.length, 0);
        host.variants.review("server"); host.externalWrite("server two"); edit(host, "human after another writer"); assert.equal(host.variants.finishNext(), true);
        assert.equal(reference(host), "server one"); assert.equal(host.variants.state.getSnapshot().selected!.version, "reference:server-v1");
        const run = host.run(); assert.equal(host.runCapture(0)!.source, "human after another writer"); host.finishRun(); await run;
        const historical = host.variants.state.getSnapshot().choices.find(choice => choice.kind === "history")!;
        assert.equal(host.variants.review(historical.id), true); assert.equal(host.variants.finishNext(), true); assert.equal(reference(host), "start"); assert.equal(text(host), "human after another writer");
    } finally { await host.dispose(); }
    assert.equal(host.debug().diagnostics.leases, 0); assert.equal(host.debug().hostSubscriptions, 0);
});

test("superseded and externally refreshed variant responses cannot replace a newer reference", async () => {
    const host = new HostController();
    try {
        edit(host, "draft"); host.variants.keepDraft(); host.externalWrite("server"); host.variants.review("draft"); host.variants.review("server");
        assert.equal(host.variants.finishNext(), false); assert.equal(host.variants.state.getSnapshot().status, "loading"); assert.equal(host.variants.state.getSnapshot().requested!.id, "server");
        assert.equal(host.variants.finishNext(), true); assert.equal(reference(host), "server");
        host.variants.review("draft"); host.retainComparisonReference(host.savedComparisonReference()); const capture = host.comparisonReference.getSnapshot();
        assert.equal(host.variants.finishNext(), false); assert.equal(host.comparisonReference.getSnapshot(), capture); assert.equal(text(host), "draft");
    } finally { await host.dispose(); }
});

test("version reads follow their captured tab through moves and reject replaced or closed presentations", async () => {
    for (const action of ["move", "replace", "close"] as const) {
        const host = new HostController();
        try {
            host.externalWrite("captured"); host.variants.review("server"); const before = host.comparisonReference.getSnapshot();
            if (action === "move") host.move();
            if (action === "replace") { host.replacePrimary(); host.reopenPrimary(); }
            if (action === "close") host.workspace.tabs.close(host.viewTab("primary"));
            assert.equal(host.variants.finishNext(), action === "move");
            if (action === "move") assert.equal(reference(host), "captured"); else assert.equal(host.comparisonReference.getSnapshot(), before);
            assert.equal(text(host), "start"); assert.equal(host.debug().diagnostics.leases, 0);
        } finally { await host.dispose(); }
    }
});

test("a preview supersedes an outstanding reference read and refuses a stale whole-document edit", async () => {
    const host = new HostController();
    try {
        host.variants.review("server");
        host.previewProposalText("proposed");
        assert.equal(host.variants.finishNext(), false);
        assert.equal(reference(host), "proposed"); assert.equal(text(host), "start");
        edit(host, "human correction");
        const before = host.debug();
        host.applyProposal();
        assert.equal(text(host), "human correction"); assert.deepEqual(host.debug().history, before.history);
        assert.equal(host.debug().source.revision, before.source.revision);
        host.previewProposalText("discarded"); host.variants.review("server"); assert.equal(host.variants.finishNext(), true);
        host.applyProposal(); assert.equal(text(host), "human correction");
        host.previewProposalText("fresh"); host.applyProposal();
        assert.equal(text(host), "fresh"); assert.equal(reference(host), "human correction");
    } finally { await host.dispose(); }
});

test("failed/cancelled retrieval and bounded historical eviction preserve immutable snapshots and ownership", async () => {
    const host = new HostController();
    try {
        const subscriptions = host.workspace.diagnostics().subscriptions;
        assert.equal(subscriptions, 0); assert.equal(host.debug().hostSubscriptions, 0);
        const initial = host.variants.state.getSnapshot(), evicted = initial.choices.find(choice => choice.kind === "history")!.id;
        assert.throws(() => { (initial.choices[0] as { label: string }).label = "mutated"; }, TypeError);
        const supplied = { buffer: TextBuffer.from("historical raw\r\n"), version: "historical-1" }; host.variants.remember(supplied);
        const choice = host.variants.state.getSnapshot().choices.find(value => value.version === supplied.version)!;
        supplied.buffer = TextBuffer.from("mutated"); supplied.version = "mutated";
        assert.equal(host.variants.review(choice.id), true); assert.equal(host.workspace.diagnostics().subscriptions, subscriptions);
        assert.equal(host.variants.finishNext(), true); assert.equal(host.workspace.diagnostics().subscriptions, subscriptions); assert.equal(host.debug().hostSubscriptions, 0); assert.equal(reference(host), "historical raw\r\n");
        for (let i = 0; i < 12; i++) { edit(host, `draft ${i}`); host.variants.keepDraft(); }
        const state = host.variants.state.getSnapshot(); assert.equal(state.choices.filter(choice => choice.kind === "history").length, 8); assert.equal(Object.isFrozen(state.choices), true); assert.equal(initial.choices.length, 3);
        assert.equal(host.variants.review(evicted), false); const before = host.comparisonReference.getSnapshot();
        host.variants.review("server"); host.variants.failNext(); assert.equal(host.variants.state.getSnapshot().status, "failed"); assert.equal(host.comparisonReference.getSnapshot(), before); assert.equal(host.workspace.diagnostics().subscriptions, subscriptions);
        host.variants.review("server"); host.variants.review("saved"); assert.equal(host.workspace.diagnostics().subscriptions, subscriptions);
        host.variants.cancel(); assert.equal(host.variants.finishNext(), false); assert.equal(host.debug().diagnostics.leases, 0); assert.equal(host.workspace.diagnostics().subscriptions, subscriptions);
        host.variants.review("draft"); await host.dispose(); const stopped = host.debug(); assert.equal(host.variants.finishNext(), false); host.variants.keepDraft(); assert.equal(host.variants.review("server"), false);
        assert.deepEqual(host.debug(), stopped); assert.equal(text(host), "draft 11"); assert.equal(stopped.hostSubscriptions, 0);
    } finally { await host.dispose(); }
});

test("large immutable variant captures avoid whole-text exports and reference reads stay available while read-only", async () => {
    const host = new HostController();
    try {
        const value = "line value\r\n".repeat(10_000) + "tail\r"; edit(host, value); const buffer = host.workspace.document(host.source.documentId).buffer;
        host.variants.keepDraft(); host.workspace.setCapabilities(host.source.id, { edit: ["host"], save: true });
        host.variants.review("draft"); assert.equal(host.variants.finishNext(), true); assert.equal(host.comparisonReference.getSnapshot().baseline.buffer, buffer);
        assert.equal(buffer.readMetrics().textExports, 0); assert.equal(host.workspace.document(host.source.documentId).buffer, buffer);
    } finally { await host.dispose(); }
});
