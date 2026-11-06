import test from "node:test";
import assert from "node:assert/strict";
import { LiteralSearch, TextBuffer } from "../src/index.ts";
function all(buffer: TextBuffer, query: string, budget = 3) {
    const cursor = new LiteralSearch(buffer, query), matches = [];
    for (;;) { const step = cursor.next(budget, 2); assert.ok(step.readUnits <= budget); matches.push(...step.matches); if (step.done) return matches; }
}
test("literal search crosses piece/step boundaries, preserves UTF-16/newlines and does not export", () => {
    const buffer = TextBuffer.from("a😀\r\néa😀\r\n").replace(1, 1, "_").replace(2, 2, "!");
    for (const query of ["_!😀\r\n", "😀", "\r\n", "é", "missing", ""]) {
        const text = "a_!😀\r\néa😀\r\n", expected = [];
        if (query) for (let from = text.indexOf(query); from >= 0; from = text.indexOf(query, from + query.length)) expected.push({ from, to: from + query.length });
        assert.deepEqual(all(buffer, query), expected);
    }
    assert.equal(buffer.diagnostics().textExports, 0);
    assert.deepEqual(all(TextBuffer.from("aaaaa"), "aa"), [{ from: 0, to: 2 }, { from: 2, to: 4 }]);
});
test("adversarial prefixes, match/read budgets, ranged scans and disposal stay explicit", () => {
    const buffer = TextBuffer.from("a".repeat(100_000) + "b"), cursor = new LiteralSearch(buffer, "aaaaab", 4);
    let step; do { step = cursor.next(1024); assert.ok(step.readUnits <= 1024); } while (!step.done);
    assert.deepEqual(step.matches, [{ from: 99_995, to: 100_001 }]);
    const many = new LiteralSearch(buffer, "a"); assert.equal(many.next(100, 2).matches.length, 2);
    many.dispose(); assert.deepEqual(many.next(), { done: true, scanned: 2, readUnits: 0, matches: [] });
    assert.throws(() => cursor.next(0), RangeError); assert.throws(() => new LiteralSearch(buffer, "a", -1), RangeError);
    assert.deepEqual(all(TextBuffer.from("xxabxx"), "ab"), [{ from: 2, to: 4 }]);
    assert.deepEqual(new LiteralSearch(buffer, "b", 0, 100_000).next(100_001).matches, []);
});
test("seeded fragmented snapshots agree with the platform literal-search oracle", () => {
    let seed = 0x51a7, text = "a😀\r\néabc".repeat(20), buffer = TextBuffer.from(text);
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let index = 0; index < 120; index++) {
        const from = next() % (text.length + 1), to = Math.min(text.length, from + next() % 4), insert = ["a", "😀", "\r\n", "é", ""][next() % 5]!;
        text = text.slice(0, from) + insert + text.slice(to); buffer = buffer.replace(from, to, insert);
        const query = ["a", "😀", "\r\n", "é", "aa", "abc"][next() % 6]!, expected = [];
        for (let offset = text.indexOf(query); offset >= 0; offset = text.indexOf(query, offset + query.length)) expected.push({ from: offset, to: offset + query.length });
        assert.deepEqual(all(buffer, query, 1 + next() % 17), expected);
    }
    assert.equal(buffer.diagnostics().textExports, 0);
});
