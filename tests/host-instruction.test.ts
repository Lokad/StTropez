import test from "node:test";
import assert from "node:assert/strict";
import { applyTextEdits } from "../src/index.ts";
import { HostController } from "../examples/hosts/controller.ts";
import { instructionEdit, parseInstruction } from "../examples/hosts/instruction-syntax.ts";

const text = (h: HostController) => { const b = h.workspace.document(h.source.documentId).buffer; return b.slice(0, b.length); };
function edit(h: HostController, from: number, to: number, insert: string) { const d = h.workspace.document(h.source.documentId); assert.equal(h.workspace.edit({ documentId: d.id, expectedRevision: d.revision, origin: "human", edits: [{ from, to, insert }], history: { kind: "replace" } }).applied, true); }
function setup(value: string) { const h = new HostController(); edit(h, 0, 5, value); h.instruction.anchor(value.indexOf("// @transfer")); return h; }

test("instruction edits preserve unknown tokens, known escapes, whitespace, Unicode and CRLF string spelling", () => {
    const source = '  // @transfer { "unknown": {"n":-0,"s":"a,}😀","list":[true,null,1e400]}, "destination" : "a\\u0041\\r\\nb", "\\u0062atchSize":"1000" }\t';
    const p = parseInstruction(source); assert.equal(p.values.destination, "aA\r\nb");
    const e = instructionEdit(p, "destination", "aA\r\nbx")!; const next = applyTextEdits(source, [e]); assert.equal(next, source.replace('\\nb"', '\\nbx"'));
    assert.equal(instructionEdit(p, "destination", p.values.destination), null);
    const batch = instructionEdit(parseInstruction(next), "batchSize", "1e")!; const invalid = applyTextEdits(next, [batch]); assert.equal(invalid, next.replace('"1000"', '"1e"')); assert.match(parseInstruction(invalid).validation!, /Batch/);
    assert.throws(() => parseInstruction('// @transfer {"destination":"a", "destination":"b"}'), /Duplicate/); assert.throws(() => parseInstruction('// @transfer {"destination":'), /invalid/);
    const missing = '// @transfer {"x":-0 }'; assert.equal(parseInstruction(applyTextEdits(missing, [instructionEdit(parseInstruction(missing), "destination", "😀")!])).values.destination, "😀");
});

test("anchored source fields map through edits and undo and retain invalid syntax", async () => {
    const line = '// @transfer { "destination":"one.csv", "batchSize":"1000", "unknown":-0 }', h = setup("before\r\n" + line + "\r\nafter");
    try {
        const c = h.instruction.capture("destination")!; edit(h, 0, 0, "prefix\r\n"); assert.equal(h.instruction.state.getSnapshot().from, 16);
        assert.equal(h.instruction.edit(c, "two.csv"), true); assert.equal(text(h), "prefix\r\nbefore\r\n" + line.replace("one.csv", "two.csv") + "\r\nafter");
        const d = h.workspace.document(h.source.documentId); h.workspace.undo({ documentId: d.id, expectedRevision: d.revision }); assert.equal(h.instruction.state.getSnapshot().values.destination, "one.csv");
        const s = h.instruction.state.getSnapshot(); edit(h, s.from, s.to, '// @transfer {"destination":'); assert.equal(h.instruction.state.getSnapshot().canEdit, false); assert.match(h.instruction.state.getSnapshot().validation!, /invalid/);
        const invalid = text(h); assert.equal(h.instruction.edit(c, "retained.csv"), false); assert.equal(text(h), invalid); assert.equal(h.recoveryText(), "retained.csv");
        const now = h.workspace.document(h.source.documentId); h.workspace.undo({ documentId: now.id, expectedRevision: now.revision }); assert.equal(h.instruction.state.getSnapshot().values.destination, "one.csv");
        const from = h.instruction.state.getSnapshot().from, to = h.instruction.state.getSnapshot().to; edit(h, from, to + 2, ""); assert.equal(h.instruction.state.getSnapshot().located, false);
        const gone = h.workspace.document(h.source.documentId); h.workspace.undo({ documentId: gone.id, expectedRevision: gone.revision }); assert.equal(h.instruction.state.getSnapshot().located, true); assert.equal(h.instruction.state.getSnapshot().values.destination, "one.csv");
    } finally { await h.dispose(); assert.equal(h.workspace.diagnostics().subscriptions, 0); }
});

test("in-flight field edits reject same-field/authority changes but preserve unrelated instruction updates", async () => {
    const h = setup('// @transfer {"destination":"a.csv","batchSize":"1000","x":-0}');
    try {
        let c = h.instruction.capture("destination")!; const at = text(h).indexOf('"x":-0'); edit(h, at, at + 6, '"x":-0,"other":[1,2]'); assert.equal(h.instruction.edit(c, "b.csv"), true); assert.ok(text(h).includes('"other":[1,2]'));
        c = h.instruction.capture("destination")!; assert.equal(h.instruction.edit(h.instruction.capture("destination")!, "newer.csv"), true); const before = text(h); assert.equal(h.instruction.edit(c, "stale.csv"), false); assert.equal(text(h), before);
        c = h.instruction.capture("batchSize")!; const caps = h.source.metadata.getSnapshot().capabilities; h.workspace.setCapabilities(h.source.id, { ...caps, edit: ["host"] }); h.workspace.setCapabilities(h.source.id, caps); assert.equal(h.instruction.edit(c, "2000"), false); assert.equal(h.instruction.state.getSnapshot().values.batchSize, "1000");
    } finally { await h.dispose(); }
});

test("explicit captured copy preserves independent transfer edits and unknown values without Save/Run", async () => {
    const h = setup('// @transfer {"destination":"captured.csv","batchSize":"2000"}');
    try {
        const t = h.transfer.resource; h.workspace.updateResource(t, { expectedRevision: 0, origin: "human", value: { destination: "original.csv", batchSize: "1000", opaque: { zero: -0 } } });
        h.instruction.captureCopy(); assert.equal(h.hasPendingRecoveryWork(), true); h.transfer.update("destination", "later.csv"); h.instruction.finishCopy(); let s = t.getSnapshot(); assert.equal(s.state === "ready" && s.value().destination, "later.csv");
        h.instruction.captureCopy(); h.instruction.edit(h.instruction.capture("destination")!, "source-later.csv"); h.instruction.finishCopy(); s = t.getSnapshot(); assert.deepEqual(s.state === "ready" && s.value(), { destination: "captured.csv", batchSize: "2000", opaque: { zero: -0 } });
        assert.equal(h.debug().activity.writes, 0); assert.equal(h.debug().activity.pendingRuns, 0); assert.equal(h.debug().pendingSaves.length, 0);
        h.instruction.captureCopy(); const caps = t.metadata.getSnapshot().capabilities; h.workspace.setCapabilities(t.id, { ...caps, edit: [] }); h.workspace.setCapabilities(t.id, caps); h.instruction.finishCopy(); assert.match(h.instruction.state.getSnapshot().message, /expired/);
        h.instruction.captureCopy(); await h.dispose(); assert.equal(h.workspace.diagnostics().leases, 0); assert.equal(h.workspace.diagnostics().subscriptions, 0);
    } finally { await h.dispose(); }
});

test("oversized instruction lines retain source without whole-line reads or an editable form", async () => {
    const raw = '// @transfer {"destination":"' + "x".repeat(24_000) + '","batchSize":"1000"}', h = setup(raw);
    try { assert.equal(h.instruction.state.getSnapshot().canEdit, false); assert.match(h.instruction.state.getSnapshot().validation!, /4,096/);
        assert.equal(h.instruction.capture("destination"), null); assert.ok(h.instruction.debug().lineReadUnits <= 2);
        h.instruction.captureCopy(); assert.equal(h.instruction.debug().pendingCopy, false); assert.equal(h.workspace.document(h.source.documentId).buffer.length, raw.length);
    } finally { await h.dispose(); }
});
