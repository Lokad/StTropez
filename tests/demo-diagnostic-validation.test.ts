import assert from "node:assert/strict";
import test from "node:test";
import { Workspace } from "../src/index.ts";
import { LspLineIndex } from "../src/protocol/index.ts";
import type { LspDocumentCapture } from "../src/protocol/index.ts";
import { DemoLanguage } from "../examples/demo/language.ts";

/** Exercise the host's check loop against captured provider replies without opening a server. */
async function fixture(count: number) {
    const workspace = new Workspace(), files = Array.from({ length: count }, (_, i) => {
        const name = `${i}.ts`, resource = workspace.createTextResource({ scope: "diagnostics", resource: name, variant: "working" }, name, { value: "let value = 1;" });
        return { name, resource, tab: workspace.open({ kind: "text", documentId: resource.documentId }, "editor"), view: workspace.createDocumentView(resource.documentId) };
    });
    const captures = new Map<string, LspDocumentCapture>(), valid = files.map(() => true), calls: { uri: string; kind: string }[] = [];
    let visits = 0, beforeReply = (_uri: string) => {};
    for (const [i, file] of files.entries()) {
        const doc = workspace.document(file.resource.documentId), uri = `file:///${file.name}`;
        captures.set(uri, { document: { uri, languageId: "typescript", resourceId: doc.resourceId, documentId: doc.id, revision: doc.revision, buffer: doc.buffer },
            index: await LspLineIndex.create(doc.buffer, async () => {}), version: 1, epoch: 1, registrationGeneration: 1,
            isCurrent: () => { visits++; return valid[i]! && workspace.document(doc.id).revision === doc.revision; } });
    }
    const language = new DemoLanguage(workspace, files, "test");
    Object.assign(language, { active: true, config: { documents: Object.fromEntries(files.map(file => [file.name, { uri: `file:///${file.name}` }])), close: async () => {} },
        scope: { flush: async () => {}, captureProject: () => captures, dispose: () => {},
            request: (_method: string, params: { uri: string; kind: string }) => {
                calls.push(params); return { id: calls.length, cancel: () => {}, result: Promise.resolve().then(() => {
                    beforeReply(params.uri);
                    return { success: true, body: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, message: `Diagnostic ${calls.length}` }] };
                }) };
            } } });
    return { workspace, files, language, valid, calls, visits: () => visits,
        beforeReply: (callback: typeof beforeReply) => { beforeReply = callback; },
        check: () => (language as unknown as { check(): Promise<void> }).check(),
        dispose: () => language.dispose() };
}

test("demo diagnostic checks validate captures linearly while retaining every result", async t => {
    const f = await fixture(50); t.after(() => f.dispose());
    await f.check(); t.diagnostic(`50-document cold check: ${f.visits()} capture validations, ${f.calls.length} requests`);
    assert.equal(f.language.state.getSnapshot().diagnostics.length, 100);
    assert.ok(f.visits() <= 12 * f.files.length, `capture validation visited ${f.visits()} times for ${f.files.length} files`);
});

test("a final project guard and source generation exclude expired and cross-file late diagnostic replies", async t => {
    const f = await fixture(4); t.after(() => f.dispose()); await f.check();
    const completed = f.language.state.getSnapshot().diagnostics;
    f.beforeReply(uri => { if (uri === "file:///3.ts") f.valid[0] = false; });
    await f.check(); assert.equal(f.language.state.getSnapshot().diagnostics, completed, "an earlier binding expired before the final reply");
    f.valid[0] = true; let edited = false;
    f.beforeReply(() => {
        if (edited) return; edited = true;
        const file = f.files[2]!, doc = f.workspace.document(file.resource.documentId);
        f.workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, origin: "human", edits: [{ from: 0, to: 0, insert: "// changed\n" }] });
    });
    const before = f.calls.length; await f.check();
    assert.equal(f.calls.length - before, 1, "a change elsewhere cancels the remaining project check");
    assert.equal(f.language.state.getSnapshot().checking, true);
    assert.equal(f.language.state.getSnapshot().diagnostics[0], completed[0], "late replies cannot replace retained messages");
});
