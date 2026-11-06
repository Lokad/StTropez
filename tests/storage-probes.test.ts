import { test } from "node:test";
import assert from "node:assert/strict";
import { candidates, ChunkTree, retained } from "../experiments/text-storage.ts";
import type { Storage } from "../experiments/text-storage.ts";
import { corpus, corpusIds, editLog } from "./fixtures/workloads.ts";

for (const [name, Candidate] of Object.entries(candidates)) {
    test(`${name} storage probe preserves random UTF-16 replay, line lookups and retained snapshots`, () => {
        for (const id of corpusIds) {
            let oracle = corpus(id), store: Storage = new Candidate(oracle);
            const history: { store: Storage; text: string }[] = [];
            for (const [index, edit] of editLog(oracle.length, 160).entries()) {
                if (index % 31 === 0) history.push({ store, text: oracle });
                store = store.replace(edit.from, edit.to, edit.insert);
                oracle = oracle.slice(0, edit.from) + edit.insert + oracle.slice(edit.to);
                assert.equal(store.length, oracle.length);
                assert.equal(store.slice(Math.max(0, edit.from - 3), Math.min(store.length, edit.from + 7)), oracle.slice(Math.max(0, edit.from - 3), Math.min(store.length, edit.from + 7)));
                if (index % 17 === 0) {
                    assert.equal(store.text(), oracle);
                    const lines = oracle.split("\n");
                    assert.equal(store.lineCount, lines.length);
                    for (const offset of [0, Math.floor(oracle.length / 2), oracle.length]) {
                        assert.equal(store.lineAt(offset), oracle.slice(0, offset).split("\n").length - 1);
                    }
                    for (const line of [0, Math.floor(lines.length / 2), lines.length - 1]) {
                        const expected = lines.slice(0, line).reduce((offset, text) => offset + text.length + 1, 0);
                        assert.equal(store.offsetAt(line), expected);
                    }
                }
                if (store instanceof ChunkTree) store.inspect(new Set(), new Set());
            }
            assert.equal(store.text(), oracle);
            history.forEach(entry => assert.equal(entry.store.text(), entry.text));
            const stats = retained(history.map(entry => entry.store));
            assert.ok(stats.versions > 0 && stats.nodes > 0);
        }
    });
    test(`${name} storage validates ranges and keeps CRLF, unpaired surrogates and empty/trailing lines exact`, () => {
        for (const text of ["", "\n", "\r\n", "a\r\nb\r\n", "\ud800x\udc00", "😀e\u0301\n👩‍💻"]) {
            const store = new Candidate(text), before = store.text();
            assert.equal(store.replace(0, 0, ""), store);
            for (const [from, to] of [[-1, 0], [0, text.length + 1], [1.5, 2], [2, 1], [NaN, 0]]) assert.throws(() => store.replace(from!, to!, "x"), RangeError);
            assert.throws(() => store.lineAt(text.length + 1), RangeError);
            assert.throws(() => store.offsetAt(store.lineCount), RangeError);
            assert.equal(store.text(), before);
            assert.equal(store.offsetAt(0), 0); assert.equal(store.lineAt(0), 0);
        }
    });
}

test("tree probes remain balanced under alternating end edits, deletes and retained history", () => {
    for (const Candidate of [candidates.chunk, candidates.piece]) {
        let store = new Candidate("x".repeat(100_000));
        const history: Storage[] = [];
        for (let index = 0; index < 1_000; index++) {
            const offset = index % 2 ? 0 : store.length;
            store = store.replace(offset, offset, `${index}\n`) as typeof store;
            if (index % 50 === 0) history.push(store);
        }
        for (let index = 0; index < 100; index++) store = store.replace(0, Math.min(17, store.length), "") as typeof store;
        const nodes = new Set<object>(), buffers = new Set<object>(), shape = store.inspect(nodes, buffers);
        assert.ok(shape.height <= 2 * Math.log2(shape.nodes + 1));
        assert.ok(retained(history).backingTextUnits < store.length * history.length);
    }
});
