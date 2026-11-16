import test from "node:test";
import assert from "node:assert/strict";
import { ProviderProject } from "../fixtures/language/project.ts";
import { reviewCapability, reviewHeader, reviewFooter, validateProjectCommand, validateProjectServerRequest } from "../fixtures/language/project-commands.ts";
import type { ProjectCommand, ProjectCommandKind } from "../fixtures/language/project-commands.ts";
function fixture(texts: readonly string[] = ["\ufeffconst café = '😀';\r\ncafé", "other\r\n"]) {
    const project = new ProviderProject(9), send = (operation: string, fields: Record<string, unknown> = {}) => project.handle({ version: 1, epoch: 9, sequence: project.snapshot().sequence + 1, operation, ...fields });
    send("project-hello"); const documents = texts.map((text, i) => {
        const document = "doc-" + i; send("project-open", { document, revision: 3, length: text.length });
        for (let from = 0; from < text.length; from += 16384) send("project-chunk", { document, revision: 3, from, text: text.slice(from, from + 16384) });
        send("project-commit", { document, revision: 3 }); return { document, revision: 3, length: text.length };
    });
    let id = 0; const command = (kind: ProjectCommandKind) => { const input = validateProjectCommand({ id: ++id, kind, documents, delay: 0 }); return { input, reply: send("project-command", { input }) }; };
    const ack = (input: ProjectCommand, applied = true) => send("project-server-result", { request: input.id, applied, reason: applied ? "Accepted." : "Rejected." });
    return { project, send, command, ack, documents };
}
test("worker registration/unregistration needs an exact acknowledged request and never survives a new epoch", () => {
    const f = fixture(), first = f.command("register"); assert.equal(first.reply.operation, "project-server-request"); assert.equal(first.reply.capability, reviewCapability); assert.equal(f.project.snapshot().registered, false);
    assert.throws(() => f.send("project-command", { input: first.input }), /Acknowledge/);
    assert.throws(() => f.send("project-server-result", { request: 999, applied: true, reason: "bad" })); assert.equal(f.project.snapshot().registered, false);
    f.ack(first.input, false); assert.equal(f.project.snapshot().registered, false); const second = f.command("register"); f.ack(second.input); assert.equal(f.project.snapshot().registered, true);
    const last = f.command("unregister"); f.ack(last.input); assert.equal(f.project.snapshot().registered, false); assert.equal(new ProviderProject(10).snapshot().registered, false);
    assert.throws(() => f.send("project-command", { input: last.input }), /Duplicate/);
});
test("server edits preserve raw text across multiple captured resources and wait for host synchronization", () => {
    const originals = ["\ufeffraw\r\n😀 café\r\ntail", ""], f = fixture(originals), registration = f.command("register"); f.ack(registration.input);
    const before = f.documents.map(d => f.project.buffer(d.document)), { input, reply } = f.command("review"), request = validateProjectServerRequest(reply, input);
    assert.equal(request.edits.length, 2); request.edits.forEach((change, i) => {
        const buffer = f.project.buffer(change.document)!; assert.equal(buffer, before[i]);
        assert.equal(buffer.apply(change.edits).buffer.slice(0, originals[i]!.length + reviewHeader.length + reviewFooter.length), reviewHeader + originals[i] + reviewFooter);
    });
    const ack = f.ack(input); assert.equal(ack.applied, true); f.documents.forEach((d, i) => assert.equal(f.project.buffer(d.document), before[i]));
    assert.equal(f.project.snapshot().serverPending, false); assert.equal(f.project.snapshot().registered, true);
});
test("the whole server batch rejects malformed late targets, stale versions, overlaps and payload excess", () => {
    const f = fixture(), registration = f.command("register"); f.ack(registration.input); const { input, reply } = f.command("review");
    const good = validateProjectServerRequest(reply, input), change = good.edits[0]!;
    for (const edits of [
        [change, { document: "missing", revision: 3, edits: [{ from: 0, to: 0, insert: "x" }] }],
        [change, { ...good.edits[1]!, revision: 4 }], [change, change],
        [{ ...change, edits: [{ from: 0, to: 3, insert: "x" }, { from: 2, to: 4, insert: "y" }] }],
        [{ ...change, edits: [{ from: 0, to: 0, insert: "x".repeat(16385) }] }],
        [{ ...change, edits: [{ from: 0, to: 9999, insert: "x" }] }]
    ]) assert.throws(() => validateProjectServerRequest({ ...reply, edits }, input));
    assert.throws(() => validateProjectServerRequest({ ...reply, capability: "other" }, input)); assert.throws(() => validateProjectServerRequest({ ...reply, request: input.id + 1 }, input));
    f.ack(input, false); assert.equal(f.project.buffer(change.document)!.length, f.documents[0]!.length);
});
test("server requests exclude incomplete transfers and lock document mutations and queries until acknowledged", () => {
    const f = fixture(), registration = f.command("register"), before = f.project.snapshot();
    assert.throws(() => f.send("project-close", { document: "doc-0", revision: 3 }), /Acknowledge/); assert.deepEqual(f.project.snapshot(), before); f.ack(registration.input);
    f.send("project-change", { document: "doc-0", revision: 4, previousRevision: 3, from: 0, to: 0, units: 1, length: f.documents[0]!.length + 1 });
    assert.throws(() => f.command("review"), /Complete the document/); assert.equal(f.project.snapshot().serverPending, false);
});
test("100k review commands inspect bounded edges, custom status returns metadata and repeated markers are a no-op", () => {
    const original = "const unchanged = 123;\r\n".repeat(100000), f = fixture([reviewHeader + original + reviewFooter]), registration = f.command("register"); f.ack(registration.input);
    const buffer = f.project.buffer("doc-0")!, before = buffer.readMetrics(), { input, reply } = f.command("review"); assert.deepEqual(validateProjectServerRequest(reply, input).edits, []); f.ack(input);
    const status = f.command("status"); assert.equal(status.reply.operation, "project-command-result"); assert.equal(status.reply.registered, true); assert.match(status.reply.reason as string, /1 synchronized/);
    const after = buffer.readMetrics(); assert.equal(after.textExports, before.textExports); assert.ok(after.sliceUnits - before.sliceUnits < 100); assert.equal(buffer, f.project.buffer("doc-0"));
});
