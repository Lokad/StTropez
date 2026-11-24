import { bufferReads } from "./buffer-reads.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer, applyTextEdits } from "../src/index.ts";
import type { TextEdit } from "../src/index.ts";
import { createRegexClient } from "../src/browser/regex-client.ts";
import { createRegexFindBackend } from "../src/browser/regex-find.ts";
import type { DocumentId } from "../src/index.ts";
import { RegexSession } from "../src/protocol/regex-session.ts";
import { regexProtocolVersion } from "../src/protocol/regex.ts";
class FixtureWorker extends EventTarget {
    readonly messages: Record<string, unknown>[] = [];
    readonly session = new RegexSession();
    terminated = false;
    automatic = true;
    postMessage(request: Record<string, unknown>): void {
        this.messages.push(request);
        if (this.automatic) this.reply(this.session.receive(request));
    }
    reply(value: unknown): void { this.dispatchEvent(new MessageEvent("message", { data: value })); }
    terminate(): void { this.terminated = true; }
}
function workerFixture(automatic = true) {
    let serial = 0; const timers = new Map<number, () => void>(), workers: FixtureWorker[] = [];
    const clock = { setTimeout: (work: () => void) => { timers.set(++serial, work); return serial; }, clearTimeout: (id: number) => timers.delete(id) } as unknown as Pick<Window, "setTimeout" | "clearTimeout">;
    return { workers, timers, options: { clock, createWorker: () => { const worker = new FixtureWorker(); worker.automatic = automatic; workers.push(worker); return worker as unknown as Worker; } } };
}
function fixture(buffer: TextBuffer, pattern = "(?:)", automatic = true, options: Parameters<ReturnType<typeof createRegexClient>["createCursor"]>[3] = {}) {
    const f = workerFixture(automatic), client = createRegexClient(f.options);
    const cursor = client.createCursor({ buffer, revision: 9, documentId: "document" as DocumentId }, pattern, true, options);
    return { ...f, client, cursor };
}

test("regex backend retains one complete source across pattern changes and captured replacement", async t => {
    const f = workerFixture(), backend = createRegexFindBackend(f.options), buffer = TextBuffer.from("alpha beta gamma\n".repeat(20000));
    t.after(() => backend.dispose());
    const capture = { documentId: "document" as DocumentId, revision: 9, buffer, query: "beta", matchCase: true, wholeWord: false };
    for (const query of ["b", "be", "bet", "beta"]) {
        const cursor = backend.search({ ...capture, query }); let count = 0;
        for (;;) { const result = await cursor.next(); count += result.matches.length; if (result.done) break; }
        assert.equal(count, 20000); cursor.dispose();
    }
    const plan = backend.replace(capture, "$&!"); let count = 0;
    for (;;) { const result = await plan.next(); for (const edit of result.edits) { assert.equal(edit.insert, "beta!"); count++; } if (result.done) break; }
    assert.equal(count, 20000); plan.dispose();
    const units = f.workers.flatMap(worker => worker.messages).reduce((sum, message) => sum + (typeof message.text === "string" ? message.text.length : 0), 0);
    t.diagnostic(`five queries: ${f.workers.length} workers, ${units} source units`);
    assert.equal(f.workers.length, 1); assert.equal(f.workers[0]!.messages.length, 5); assert.equal(units, buffer.length); assert.equal(f.workers[0]!.terminated, false);
    assert.equal(bufferReads(buffer).textExports, 0); assert.equal(f.timers.size, 0);
    backend.dispose(); assert.equal(f.workers[0]!.terminated, true);
});

test("retained regex source requires document, revision and buffer identity, including abandoned queries", async t => {
    const f = workerFixture(), client = createRegexClient(f.options); t.after(() => client.dispose());
    const buffer = TextBuffer.from("beta"), capture = { documentId: "one" as DocumentId, revision: 1, buffer };
    const search = async (value = capture) => {
        const cursor = client.createCursor(value, "beta", true); let count = 0;
        for (;;) { const result = await cursor.next(); count += result.matches.length; if (result.done) break; }
        assert.equal((await cursor.next()).scanned, value.buffer.length);
        cursor.dispose(); return count;
    };
    assert.equal(await search(), 1);
    client.createCursor(capture, "abandoned", true).dispose();
    assert.equal(await search(), 1); assert.equal(f.workers.length, 1);
    assert.equal(f.workers[0]!.messages.filter(m => m.text !== undefined).length, 1);
    assert.equal(await search({ ...capture, documentId: "two" as DocumentId }), 1);
    assert.equal(await search({ ...capture, documentId: "two" as DocumentId, revision: 2 }), 1);
    assert.equal(await search({ ...capture, documentId: "two" as DocumentId, revision: 2, buffer: TextBuffer.from("xxxx") }), 0);
    assert.equal(f.workers.length, 1); assert.equal(f.workers[0]!.messages.filter(m => m.text !== undefined).length, 4);
    const starts = f.workers[0]!.messages;
    assert.equal(starts[0]!.source, starts[1]!.source); assert.equal(new Set(starts.map(m => m.source)).size, 4);
    // An idle worker failure also invalidates the source during the next query's debounce.
    client.createCursor(capture, "waiting", true);
    f.workers[0]!.dispatchEvent(new Event("error", { cancelable: true }));
    assert.equal(f.workers[0]!.terminated, true);
    assert.equal(await search(), 1); assert.equal(f.workers.length, 2); assert.equal(f.workers[0]!.terminated, true);
    client.dispose(); assert.equal(f.workers[1]!.terminated, true); assert.throws(() => client.createCursor(capture, "beta", true), /disposed/);
});

test("cancelled retained queries cannot tear down their successor and timeout drops cached source", async t => {
    const f = workerFixture(), client = createRegexClient(f.options); t.after(() => client.dispose());
    const capture = { documentId: "one" as DocumentId, revision: 1, buffer: TextBuffer.from("beta") };
    const drain = async (cursor: ReturnType<typeof client.createCursor>) => { let count = 0; for (;;) { const step = await cursor.next(); count += step.matches.length; if (step.done) return count; } };
    assert.equal(await drain(client.createCursor(capture, "beta", true)), 1);
    const old = f.workers[0]!; old.automatic = false;
    const cursor = client.createCursor(capture, "bet", true), pending = cursor.next(), rejected = assert.rejects(pending, /cancelled/);
    const next = client.createCursor(capture, "beta", true), current = drain(next);
    old.reply(null); await rejected; assert.equal(await current, 1);
    assert.equal(old.terminated, true); assert.equal(f.workers[1]!.terminated, false);
    f.workers[1]!.automatic = false;
    const timed = client.createCursor(capture, "b", true).next(), timedOut = assert.rejects(timed, /timed out/);
    f.timers.values().next().value!(); await timedOut;
    assert.equal(f.workers[1]!.terminated, true);
    assert.equal(await drain(client.createCursor(capture, "beta", true)), 1);
    assert.equal(f.workers.length, 3); assert.equal(f.workers[2]!.messages.filter(m => m.text !== undefined).length, 1);
    // Disposing an owner with a debounced, unused query still releases the completed source.
    client.createCursor(capture, "unused", true); client.dispose();
    assert.equal(f.workers[2]!.terminated, true); assert.equal(f.timers.size, 0);
});

test("one worker reply serves bounded local search steps including the empty match at EOF", async () => {
    const f = fixture(TextBuffer.from("x".repeat(32768)));
    let count = 0;
    let pages = 0;
    for (;;) {
        const step = await f.cursor.next();
        assert.ok(step.matches.length > 0 && step.matches.length <= 8192);
        assert.equal(step.matches[0]!.from, count);
        count += step.matches.length;
        pages++;
        if (step.done) break;
    }
    assert.equal(count, 32769);
    assert.ok(pages > 1);
    assert.equal(f.workers[0]!.messages.length, 1);
    f.client.dispose();
});

test("regex replacement preserves captures, large insertions, zero-width and whole-word edits", async () => {
    const cases = [
        { text: "before ab after ab", pattern: "(?<first>a)(b)(c)?", replacement: "$<first>/$2/$3/$`/$'" },
        { text: "😀x", pattern: "(?:)", replacement: "[$&]" },
        { text: "x".repeat(40000) + "y", pattern: "x{40000}", replacement: "$&$&" },
        { text: "a ".repeat(1100), pattern: "(a)", replacement: "$1!" },
    ];
    for (const { text, pattern, replacement } of cases) {
        const buffer = TextBuffer.from(text), f = fixture(buffer, pattern, true, { replacement }), edits: TextEdit[] = [];
        let pages = 0;
        for (;;) { const step = await f.cursor.next(); assert.deepEqual(step.matches, []); assert.ok(step.edits.length <= 1024); assert.ok(Object.isFrozen(step.edits));
            if (step.edits.length) pages++; edits.push(...step.edits); if (step.done) break; }
        assert.equal(applyTextEdits(text, edits), text.replace(new RegExp(pattern, "gmu"), replacement)); assert.equal(bufferReads(buffer).textExports, 0);
        if (text.length > 40000) { assert.equal(edits.length, 1); assert.equal(edits[0]!.insert.length, 80000); assert.equal(f.workers[0]!.messages.length, 1); }
        if (text.length === 2200) assert.equal(pages, 2);
        f.client.dispose(); assert.equal(f.workers[0]!.terminated, true); assert.equal(f.timers.size, 0);
    }
    for (const { text, pattern, options, expected } of [
        { text: "foobar foo foo_", pattern: "foo|foobar", options: { wholeWord: true, replacement: "<$&>" }, expected: "<foobar> <foo> foo_" },
        { text: "xab xab", pattern: "(?<=x)(ab)", options: { replacement: "$1!", range: { from: 5, to: 7 } }, expected: "xab xab!" },
        { text: "abc", pattern: "a", options: { replacement: "", maxOutputUnits: 0 }, expected: "bc" },
    ]) {
        const f = fixture(TextBuffer.from(text), pattern, true, options), edits: TextEdit[] = [];
        for (;;) { const step = await f.cursor.next(); edits.push(...step.edits); if (step.done) break; } assert.equal(applyTextEdits(text, edits), expected);
    }
});

test("invalid or stale worker replies cannot publish a completed search or replacement", async () => {
    const version = regexProtocolVersion;
    const matches = (offsets: number[]) => ({ operation: "regex-matches", offsets: Uint32Array.from(offsets) });
    const plan = (offsets: number[], insertions: string) => ({ operation: "regex-edits", offsets: Uint32Array.from(offsets), insertions });
    for (const [options, reply] of [
        [{}, matches([0, 1])], [{}, matches([0, 0, 0, 2])], [{}, matches([0, 2, 0, 2])],
        [{}, matches([0, 4])], [{}, matches([2, 0])], [{}, matches([0])], [{}, matches(new Array(10).fill(0))],
        [{}, { operation: "regex-matches", offsets: [0, 2] }], [{}, { ...matches([0, 2]), version: version + 1 }],
        [{}, { operation: "regex-matches", offsets: Uint32Array.of(0, 2, 9).subarray(0, 2) }],
        [{ replacement: "x" }, matches([0, 2])], [{ replacement: "x" }, plan([0, 2, 2], "x")],
        [{ replacement: "x" }, plan([0, 2, 1], "xx")], [{ replacement: "x" }, plan([0, 2, 1, 2, 3, 0], "x")],
        [{ replacement: "x", range: { from: 0, to: 2 } }, plan([], "")],
        [{ replacement: "x", range: { from: 0, to: 2 } }, plan([2, 3, 1], "x")],
        [{ replacement: "x", maxOutputUnits: 0 }, plan([0, 2, 1], "x")],
    ] as const) {
        const f = fixture(TextBuffer.from("😀x"), ".", false, options);
        const pending = f.cursor.next();
        const worker = f.workers[0]!;
        worker.reply({ id: 99, revision: 9, version, offsets: null });
        worker.reply({ id: 1, revision: 8, version, offsets: null });
        assert.equal(f.timers.size, 1);
        worker.reply({ id: 1, revision: 9, version, ...reply });
        await assert.rejects(pending, /Invalid|Unsupported/);
        assert.equal(worker.terminated, true);
        assert.equal(f.timers.size, 0);
    }
});

test("a worker construction failure reaches the search caller intact", async t => {
    const denied = new Error("Worker URL rejected");
    const f = workerFixture(), client = createRegexClient({ ...f.options, createWorker: () => { throw denied; } });
    t.after(client.dispose);
    const cursor = client.createCursor({ documentId: "a" as DocumentId, revision: 0, buffer: TextBuffer.from("a") }, "a", true);
    await assert.rejects(cursor.next(), error => error === denied);
    assert.equal(f.timers.size, 0);
});

test("regex client cancellation, timeout and malformed responses release the lane without continuing transfer", async () => {
    for (const action of ["cancel", "timeout", "malformed", "error"] as const) {
        const f = fixture(TextBuffer.from("text"), "x", false), pending = f.cursor.next(), worker = f.workers[0]!;
        if (action === "cancel") f.cursor.dispose();
        else if (action === "timeout") f.timers.values().next().value!();
        else if (action === "malformed") worker.reply(null);
        else worker.dispatchEvent(new Event("error", { cancelable: true }));
        await assert.rejects(pending); assert.equal(worker.terminated, true); assert.equal(f.timers.size, 0); assert.equal(worker.messages.length, 1); f.cursor.dispose();
    }
    const f = fixture(TextBuffer.from("text"), "x", false);
    const pending = f.cursor.next();
    f.workers[0]!.reply({ operation: "regex-matches", version: regexProtocolVersion, id: 1, revision: 9, offsets: new Uint32Array() });
    f.cursor.dispose();
    await assert.rejects(pending, /cancelled/);
    assert.equal(f.timers.size, 0);
});
