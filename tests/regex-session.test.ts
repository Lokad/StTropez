import test from "node:test";
import assert from "node:assert/strict";
import { RegexSession, regexChunkUnits, regexSourceLimit } from "../src/browser/regex-session.ts";
const start = (length: number, pattern = "😀(?<word>𐐀value)\\r\\nnext") => ({ operation: "regex-start", id: 1, revision: 7, length, pattern, matchCase: true });

test("regex transfer preserves cross-chunk raw spans and publishes bounded pages only after complete capture", () => {
    const session = new RegexSession(), text = "x".repeat(regexChunkUnits - 1) + "😀𐐀value\r\nnext", request = start(text.length);
    assert.deepEqual([...session.receive(request)], [{ operation: "regex-progress", id: 1, revision: 7, received: 0 }]);
    assert.deepEqual([...session.receive({ operation: "regex-chunk", id: 1, revision: 7, from: 0, text: text.slice(0, regexChunkUnits) })], [{ operation: "regex-progress", id: 1, revision: 7, received: regexChunkUnits }]);
    const received = [...session.receive({ operation: "regex-chunk", id: 1, revision: 7, from: regexChunkUnits, text: text.slice(regexChunkUnits) })]; assert.equal(received[0]!.operation, "regex-progress");
    assert.deepEqual([...session.receive({ operation: "regex-run", id: 1, revision: 7 })], [
        { operation: "regex-matches", id: 1, revision: 7, matches: [{ from: regexChunkUnits - 1, to: text.length }] }, { operation: "regex-done", id: 1, revision: 7, count: 1 },
    ]);
    const many = new RegexSession(); [...many.receive(start(1100, "(?:)"))]; [...many.receive({ operation: "regex-chunk", id: 1, revision: 7, from: 0, text: "x".repeat(1100) })];
    const replies = [...many.receive({ operation: "regex-run", id: 1, revision: 7 })], pages = replies.filter(r => r.operation === "regex-matches");
    assert.deepEqual(pages.map(p => p.matches.length), [512, 512, 77]); assert.deepEqual(replies.at(-1), { operation: "regex-done", id: 1, revision: 7, count: 1101 });
});

test("regex capture rejects malformed ordering/bounds and superseded generators cannot finish a newer request", () => {
    for (const bad of [{ ...start(1), length: regexSourceLimit + 1 }, { ...start(1), pattern: "(" }, { ...start(1), matchCase: "yes" }]) {
        const session = new RegexSession(); assert.equal([...session.receive(bad)][0]!.operation, "regex-error");
    }
    for (const bad of [{ operation: "regex-run", id: 1, revision: 7 }, { operation: "regex-chunk", id: 1, revision: 7, from: 1, text: "x" }, null, {}]) {
        const session = new RegexSession(); [...session.receive(start(1))]; assert.equal([...session.receive(bad)][0]!.operation, "regex-error");
    }
    const session = new RegexSession(); [...session.receive(start(1024, "x"))]; [...session.receive({ operation: "regex-chunk", id: 1, revision: 7, from: 0, text: "x".repeat(1024) })];
    const old = session.receive({ operation: "regex-run", id: 1, revision: 7 }); assert.equal(old.next().value.operation, "regex-matches");
    [...session.receive({ ...start(0, "$"), id: 2 })]; assert.equal(old.next().done, true);
    assert.deepEqual([...session.receive({ operation: "regex-run", id: 1, revision: 7 })], []);
    assert.deepEqual([...session.receive({ operation: "regex-run", id: 2, revision: 7 })], [
        { operation: "regex-matches", id: 2, revision: 7, matches: [{ from: 0, to: 0 }] }, { operation: "regex-done", id: 2, revision: 7, count: 1 },
    ]);
    const limited = new RegexSession(2); [...limited.receive(start(3, "x"))]; [...limited.receive({ operation: "regex-chunk", id: 1, revision: 7, from: 0, text: "xxx" })];
    assert.deepEqual([...limited.receive({ operation: "regex-run", id: 1, revision: 7 })], [{ operation: "regex-error", id: 1, revision: 7, message: "Regex match limit exceeded; narrow the expression." }]);
});
