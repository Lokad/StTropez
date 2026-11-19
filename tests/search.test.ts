import test from "node:test";
import { nextSeed } from "../fixtures/workloads.ts";
import assert from "node:assert/strict";
import { LiteralSearch, TextBuffer } from "../src/index.ts";
import type { LiteralSearchOptions } from "../src/index.ts";
function all(buffer: TextBuffer, query: string, budget = 3, options?: LiteralSearchOptions) {
    let previous = buffer.readMetrics(); // Include construction in the first measured advance.
    const cursor = new LiteralSearch(buffer, query, options), matches = [];
    for (;;) {
        const step = cursor.next(budget, 2), current = buffer.readMetrics();
        assert.equal(current.textExports, previous.textExports);
        // Chunk traversal is charged by the cursor; materialized boundary reads also have buffer counters.
        assert.ok(current.sliceUnits - previous.sliceUnits <= step.readUnits, "Unreported literal-search slice reads.");
        assert.ok(step.readUnits <= budget); previous = current;
        matches.push(...step.matches); if (step.done) return matches;
    }
}
test("literal search crosses piece/step boundaries, preserves UTF-16/newlines and does not export", () => {
    const tail = "x".repeat(128), buffer = TextBuffer.from("a😀\r\néa😀\r\n" + tail).replace(1, 1, "_").replace(2, 2, "!");
    assert.ok([...buffer.chunks()].length > 1, "Keep the search seam even when small edit fragments coalesce.");
    for (const query of ["_!😀\r\n", "😀", "\r\n", "é", "missing", ""]) {
        const text = "a_!😀\r\néa😀\r\n" + tail, expected = [];
        if (query) for (let from = text.indexOf(query); from >= 0; from = text.indexOf(query, from + query.length)) expected.push({ from, to: from + query.length });
        for (const budget of [1, 3, 128, 32768]) assert.deepEqual(all(buffer, query, budget), expected);
    }
    assert.deepEqual(all(TextBuffer.from("aaaaa"), "aa"), [{ from: 0, to: 2 }, { from: 2, to: 4 }]);
});

test("whole-word search checks Unicode neighbours outside scan bounds and preserves overlapping candidates", () => {
    const text = "cat scatter cat_ cat2 café cafe\u0301 😀 cat\u200d \u{10400}cat cat\r\ncat! xa!a!a ";
    let buffer = TextBuffer.from(text);
    // Produce piece boundaries inside the query and a supplementary neighbour.
    buffer = buffer.replace(1, 1, "!").replace(1, 2, "");
    const expected = [0, text.lastIndexOf("cat\r"), text.lastIndexOf("cat!")].map(from => ({ from, to: from + 3 }));
    for (const budget of [1, 2, 7, 32]) assert.deepEqual(all(buffer, "cat", budget, { wholeWord: true }), expected);
    assert.deepEqual(all(buffer, "a!a", 1, { wholeWord: true }), [{ from: text.lastIndexOf("a!a"), to: text.lastIndexOf("a!a") + 3 }]);
    assert.deepEqual(all(buffer, "cafe", 1, { wholeWord: true }), []);
    assert.deepEqual(all(TextBuffer.from("xcaty cat!"), "cat", 1, { wholeWord: true, from: 1, to: 4 }), []);
    assert.deepEqual(all(TextBuffer.from("xcaty cat!"), "cat", 1, { wholeWord: true, from: 6, to: 9 }), [{ from: 6, to: 9 }]);
    for (const query of ["\ud83d", "\ude00"]) assert.deepEqual(all(TextBuffer.from("😀 😀"), query, 1, { wholeWord: true }), []);
    assert.deepEqual(all(TextBuffer.from("😀 😀"), "😀", 1, { wholeWord: true }), [{ from: 0, to: 2 }, { from: 3, to: 5 }]);
    const pending = new LiteralSearch(buffer, "cat", { wholeWord: true }); pending.next(3); pending.dispose();
    assert.deepEqual(pending.next(1), { done: true, scanned: 3, readUnits: 0, matches: [] });
});

test("fragmented whole-word scans agree with an independent flat code-point oracle at tiny budgets", () => {
    const word = /^[\p{L}\p{N}\p{Pc}\p{M}\u200c\u200d]$/u;
    function oracle(text: string, query: string) {
        const boundaries = new Set([0]); let offset = 0;
        for (const point of text) { offset += point.length; boundaries.add(offset); }
        const result = []; let from = text.indexOf(query);
        while (from >= 0) {
            const to = from + query.length, before = Array.from(text.slice(0, from)).at(-1) ?? "", after = Array.from(text.slice(to))[0] ?? "";
            const accept = boundaries.has(from) && boundaries.has(to) && !word.test(before) && !word.test(after);
            if (accept) result.push({ from, to });
            from = text.indexOf(query, from + (accept ? query.length : 1));
        }
        return result;
    }
    let seed = 0x73a1, text = "cat cat_ e\u0301 café Ελληνικά 漢字 😀 \u{10400}cat a!a ".repeat(4), buffer = TextBuffer.from(text);
    const next = () => (seed = nextSeed(seed));
    for (let index = 0; index < 80; index++) {
        const from = next() % (text.length + 1), to = Math.min(text.length, from + next() % 3), insert = ["cat", "_", "😀", "\u0301", " ", "a!a"][next() % 6]!;
        text = text.slice(0, from) + insert + text.slice(to); buffer = buffer.replace(from, to, insert);
        const query = ["cat", "a!a", "é", "😀", "漢", "e\u0301"][next() % 6]!;
        assert.deepEqual(all(buffer, query, 1 + next() % 9, { wholeWord: true }), oracle(text, query));
    }
});
test("adversarial prefixes, match/read budgets, ranged scans and disposal stay explicit", context => {
    const query = "aaaaab", buffer = TextBuffer.from("a".repeat(100_000) + "b"), cursor = new LiteralSearch(buffer, query, { from: 4 });
    const indexOf = String.prototype.indexOf; let nativeCalls = 0;
    const probe = context.mock.method(String.prototype, "indexOf", function (this: string, search: string, from = 0) {
        if (search === query) { nativeCalls++; assert.ok(this.length - from <= 1024, "Native scans must obey the same cooperative span bound."); }
        return indexOf.call(this, search, from);
    });
    let step; do { step = cursor.next(1024); assert.ok(step.readUnits <= 1024); } while (!step.done);
    probe.mock.restore(); assert.ok(nativeCalls > 0, "Exercise the bounded native path as well as the streaming seam path.");
    assert.deepEqual(step.matches, [{ from: 99_995, to: 100_001 }]);
    const many = new LiteralSearch(buffer, "a"); assert.equal(many.next(100, 2).matches.length, 2);
    many.dispose(); assert.deepEqual(many.next(), { done: true, scanned: 2, readUnits: 0, matches: [] });
    assert.throws(() => cursor.next(0), RangeError); assert.throws(() => new LiteralSearch(buffer, "a", { from: -1 }), RangeError);
    assert.deepEqual(all(TextBuffer.from("xxabxx"), "ab"), [{ from: 2, to: 4 }]);
    assert.deepEqual(new LiteralSearch(buffer, "b", { from: 0, to: 100_000 }).next(100_001).matches, []);
});
test("seeded fragmented snapshots agree with the platform literal-search oracle", () => {
    let seed = 0x51a7, text = "a😀\r\néabc".repeat(20), buffer = TextBuffer.from(text);
    const next = () => (seed = nextSeed(seed));
    for (let index = 0; index < 120; index++) {
        const from = next() % (text.length + 1), to = Math.min(text.length, from + next() % 4), insert = ["a", "😀", "\r\n", "é", ""][next() % 5]!;
        text = text.slice(0, from) + insert + text.slice(to); buffer = buffer.replace(from, to, insert);
        const query = ["a", "😀", "\r\n", "é", "aa", "abc"][next() % 6]!, expected = [];
        for (let offset = text.indexOf(query); offset >= 0; offset = text.indexOf(query, offset + query.length)) expected.push({ from: offset, to: offset + query.length });
        assert.deepEqual(all(buffer, query, 1 + next() % 17), expected);
    }
});

test("case-insensitive literals preserve raw spans across pieces and tiny read budgets", () => {
    const text = "k K K σ Σ ς i I ı İ ss SS ß 𐐀 𐐨 é É a.b [X] 😀 \ud800!\udc00", buffer = TextBuffer.from(text).replace(1, 1, "!").replace(1, 2, "");
    const quote = (query: string) => Array.from(query, point => `\\u{${point.codePointAt(0)!.toString(16)}}`).join("");
    for (const query of ["k", "σ", "i", "ss", "ß", "𐐀", "é", "é", "A.B", "[x]", "😀", "\ud800", "\udc00"]) {
        const expected = [...text.matchAll(new RegExp(quote(query), "giu"))].map(match => ({ from: match.index, to: match.index + match[0].length }));
        for (const budget of [1, 2, 7, 32]) assert.deepEqual(all(buffer, query, budget, { matchCase: false }), expected, `${JSON.stringify(query)} budget ${budget}`);
    }
    const prefix = "x".repeat(128), pair = TextBuffer.from(prefix + "\ud801").replace(prefix.length + 1, prefix.length + 1, "\udc00x");
    assert.ok([...pair.chunks()].some(chunk => chunk.endsWith("\ud801")));
    assert.deepEqual(all(pair, "𐐨", 1, { matchCase: false }), [{ from: prefix.length, to: prefix.length + 2 }]);
    assert.deepEqual(all(TextBuffer.from("AaAAA"), "aa", 1, { matchCase: false }), [{ from: 0, to: 2 }, { from: 2, to: 4 }]);
    assert.deepEqual(all(TextBuffer.from("k K K"), "k"), [{ from: 0, to: 1 }]);
    const pending = new LiteralSearch(TextBuffer.from("𐐀"), "𐐨", { matchCase: false }); pending.next(1); pending.dispose();
    assert.deepEqual(pending.next(1), { done: true, scanned: 1, readUnits: 0, matches: [] });
});

test("fragmented caseless whole-word scans agree with an independent Unicode regex oracle", () => {
    const word = /^[\p{L}\p{N}\p{Pc}\p{M}\u200c\u200d]$/u;
    function oracle(text: string, query: string, wholeWord: boolean) {
        const pattern = new RegExp(Array.from(query, point => `\\u{${point.codePointAt(0)!.toString(16)}}`).join(""), "giu"), matches = [];
        for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
            const from = found.index, to = from + found[0].length, before = Array.from(text.slice(0, from)).at(-1) ?? "", after = Array.from(text.slice(to))[0] ?? "";
            if (!wholeWord || !word.test(before) && !word.test(after)) matches.push({ from, to });
            else pattern.lastIndex = from + String.fromCodePoint(text.codePointAt(from)!).length;
        }
        return matches;
    }
    let seed = 0x71ba, text = "k K_ K𐐀 𐐨 SS ß a!A!a é É 😀 ".repeat(4), buffer = TextBuffer.from(text);
    const random = () => (seed = nextSeed(seed));
    for (let index = 0; index < 100; index++) {
        const from = random() % (text.length + 1), to = Math.min(text.length, from + random() % 3), insert = ["K", "K", "𐐀", "σ", "\ud800", " ", "a!a"][random() % 7]!;
        text = text.slice(0, from) + insert + text.slice(to); buffer = buffer.replace(from, to, insert);
        const query = ["k", "𐐨", "ss", "Σ", "a!A", "é", "\ud800"][random() % 7]!, wholeWord = random() % 2 === 0;
        assert.deepEqual(all(buffer, query, 1 + random() % 7, { matchCase: false, wholeWord }), oracle(text, query, wholeWord));
    }
    const ranged = TextBuffer.from("xKy K!");
    assert.deepEqual(all(ranged, "k", 1, { matchCase: false, wholeWord: true, from: 1, to: 2 }), []);
    assert.deepEqual(all(ranged, "k", 1, { matchCase: false, wholeWord: true, from: 4, to: 5 }), [{ from: 4, to: 5 }]);
});
