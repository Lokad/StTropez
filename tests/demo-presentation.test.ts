import assert from "node:assert/strict";
import test from "node:test";
import { Workspace } from "../src/index.ts";
import { DemoPresentation } from "../examples/demo/presentation.ts";
import { DemoSyntaxSession } from "../examples/demo/syntax-session.ts";
import type { SyntaxRequest, SyntaxResponse } from "../examples/demo/syntax-session.ts";

function harness() {
    let serial = 0; const tasks = new Map<number, () => void>(), workers: FakeWorker[] = [];
    class FakeWorker extends EventTarget {
        readonly messages: SyntaxRequest[] = [];
        readonly session = new DemoSyntaxSession();
        private consumed = 0;
        terminated = false;
        constructor() { super(); workers.push(this); }
        postMessage(message: SyntaxRequest): void { assert.equal(this.terminated, false); this.messages.push(structuredClone(message)); }
        terminate(): void { this.terminated = true; this.session.dispose(); }
        deliver(message: SyntaxResponse): void { this.dispatchEvent(new MessageEvent("message", { data: message })); }
        flush(deliver = true): SyntaxResponse[] {
            const replies: SyntaxResponse[] = [];
            for (; this.consumed < this.messages.length; this.consumed++) {
                const reply = this.session.accept(this.messages[this.consumed]!);
                if (reply) { replies.push(reply); if (deliver) this.deliver(reply); }
            }
            return replies;
        }
    }
    const values = { Worker: FakeWorker, document: { baseURI: "https://example.test/" }, window: {
        setTimeout: (callback: () => void) => { const id = ++serial; tasks.set(id, callback); return id; },
        clearTimeout: (id: number) => { tasks.delete(id); },
    } };
    const previous = Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const turn = () => { const item = tasks.entries().next().value; if (item) { tasks.delete(item[0]); item[1](); } };
    return { workers, turn, drain: () => { let remaining = 10000; while (tasks.size) { assert.ok(remaining-- > 0); turn(); } }, close: () => {
        for (const worker of workers) worker.terminate();
        for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    } };
}
const units = (messages: readonly SyntaxRequest[]) => messages.reduce((count, m) => count + (m.kind === "chunk" ? m.text.length : 0), 0);

test("presentation sends bounded deltas from queued finishes, rejects late results and emits on demand", () => {
    const h = harness(), presentation = new DemoPresentation(() => {}), workspace = new Workspace();
    try {
        const text = "const count: number = 1;\n" + "// padding\n".repeat(20000);
        const id = workspace.createDocument({ scope: "syntax", resource: "one", variant: "working" }, "one", text);
        const capture = () => workspace.document(id), worker = h.workers[0]!;
        presentation.update(capture()); h.drain(); worker.flush();
        assert.equal(units(worker.messages), text.length); assert.equal(presentation.status, "ready");
        const at = text.indexOf("1;"), edit = (insert: string) => {
            workspace.edit({ documentId: id, expectedRevision: capture().revision, edits: [{ from: at, to: at + 1, insert }], origin: "host" });
            presentation.update(capture()); h.drain();
        };
        const count = worker.messages.length;
        edit("2"); const earlier = worker.flush(false)[0]!;
        edit("3"); const latest = worker.flush(false)[0]!;
        assert.ok(units(worker.messages.slice(count)) <= 256);
        worker.deliver(latest); worker.deliver(earlier);
        assert.equal(presentation.status, "ready"); assert.match(presentation.javascript, /const count = 3;/);
        assert.equal(worker.messages.filter(m => m.kind === "start" && !m.change).length, 1);
        presentation.setEmit(false); edit("4"); worker.flush();
        assert.equal(presentation.status, "ready"); assert.equal(presentation.javascript, "");
        assert.deepEqual(worker.messages.at(-1), { kind: "finish", job: latest.job + 1, options: { emit: false } });
        const hidden = worker.messages.length;
        presentation.setEmit(true); h.drain(); worker.flush();
        assert.equal(units(worker.messages.slice(hidden)), 0); assert.match(presentation.javascript, /const count = 4;/);
        const pending = worker.messages.length;
        for (const [from, to, insert] of [[at, at + 1, "56"], [at + 1, at + 2, "7"]] as const) {
            workspace.edit({ documentId: id, expectedRevision: capture().revision, origin: "human", edits: [{ from, to, insert }] });
            presentation.update(capture());
        }
        h.drain(); worker.flush();
        assert.equal(units(worker.messages.slice(pending)), 2); assert.match(presentation.javascript, /const count = 57;/);
        const other = new Workspace(), otherId = other.createDocument({ scope: "syntax", resource: "two", variant: "working" }, "two", "const separate = true;");
        const beforeSwitch = worker.messages.length;
        presentation.update(other.document(otherId)); h.drain(); worker.flush();
        assert.equal(worker.messages.slice(beforeSwitch).find(m => m.kind === "start")?.kind, "start");
        assert.ok(worker.messages.slice(beforeSwitch).some(m => m.kind === "start" && !m.change));
        assert.match(presentation.javascript, /separate/);
        presentation.update(other.document(otherId), true); assert.equal(worker.terminated, true);
        presentation.update(other.document(otherId)); h.drain(); const restarted = h.workers[1]!; restarted.flush();
        assert.ok(restarted.messages.some(m => m.kind === "start" && !m.change)); assert.match(presentation.javascript, /separate/);
        assert.equal(capture().buffer.readMetrics().textExports, 0);
    } finally { presentation.dispose(); h.close(); }
});

test("presentation cancels partial uploads and retry owns a fresh worker while old events stay inert", () => {
    const h = harness(), presentation = new DemoPresentation(() => {}), workspace = new Workspace();
    try {
        const large = workspace.createDocument({ scope: "syntax", resource: "large", variant: "working" }, "large", "// text\n".repeat(30000));
        const small = workspace.createDocument({ scope: "syntax", resource: "small", variant: "working" }, "small", "const tiny = 1;");
        const first = h.workers[0]!;
        presentation.update(workspace.document(large)); h.turn();
        assert.equal(units(first.messages), 65536);
        presentation.update(workspace.document(small)); h.drain(); first.flush();
        assert.ok(first.messages.some(m => m.kind === "cancel" && m.job === 1));
        assert.equal(first.messages.some(m => m.kind === "finish" && m.job === 1), false);
        assert.match(presentation.javascript, /tiny/);
        first.dispatchEvent(new Event("error", { cancelable: true })); assert.equal(presentation.status, "failed");
        presentation.retry(); const current = h.workers[1]!; assert.equal(first.terminated, true);
        first.dispatchEvent(new Event("error", { cancelable: true })); assert.equal(presentation.status, "pending");
        h.drain(); current.flush(); assert.equal(presentation.status, "ready");
        assert.ok(current.messages.some(m => m.kind === "start" && !m.change));
        presentation.update(workspace.document(large)); h.turn(); const count = current.messages.length;
        presentation.dispose(); h.drain();
        assert.equal(current.terminated, true); assert.equal(current.messages.length, count + 1); // Explicit upload cancellation.
    } finally { presentation.dispose(); h.close(); }
});
