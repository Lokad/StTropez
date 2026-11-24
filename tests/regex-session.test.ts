import test from "node:test";
import assert from "node:assert/strict";
import { RegexSession } from "../src/protocol/regex-session.ts";
import { regexProtocolVersion as version } from "../src/protocol/regex.ts";

const query = { version, source: 1, id: 1, revision: 7, pattern: "x", matchCase: true };

test("one request captures a bounded source and only the same identity can reuse it", () => {
    const session = new RegexSession();
    const text = "x".repeat(511999) + "Y";
    const start = { ...query, length: text.length, text, pattern: "xY" };
    const expected = { version, id: 1, revision: 7, operation: "regex-matches", offsets: Uint32Array.of(511998, 512000) };
    assert.deepEqual(session.receive(start), expected);
    const retained = { ...query, id: 2, length: text.length, pattern: "(?<=x)Y" };
    assert.deepEqual(session.receive(retained), { ...expected, id: 2, offsets: Uint32Array.of(511999, 512000) });
    assert.equal(session.receive({ ...retained, id: 3, revision: 8 })?.operation, "regex-error");
    for (const invalid of [
        { ...start, version: version + 1 }, { ...start, length: 512001 }, { ...start, length: 1 },
        { ...start, source: 99 }, { ...start, pattern: "x".repeat(4097) },
        { ...start, matchCase: "yes" }, { ...start, replacement: "x".repeat(32769) },
        { ...start, replacement: "", maxOutputUnits: 512001 }, { ...start, range: { from: 0, to: 1 } },
    ]) assert.equal(session.receive(invalid)?.operation, "regex-error");
});

test("replacement checks a captured range and bounds expansion before returning edits", () => {
    const session = new RegexSession();
    const start = { ...query, text: "😀xx", length: 4, replacement: "$&!", pattern: "x" };
    assert.deepEqual(session.receive(start), { id: 1, revision: 7, version, operation: "regex-edits",
        offsets: Uint32Array.of(2, 3, 2, 3, 4, 4), insertions: "x!x!" });
    for (const value of [{ maxOutputUnits: 3 }, { range: { from: 0, to: 1 } }, { range: { from: 0, to: 2 } }])
        assert.equal(session.receive({ ...start, ...value })?.operation, "regex-error");
    const text = "x".repeat(512000);
    assert.equal(session.receive({ ...query, text, length: text.length, pattern: "$", replacement: "!" })?.operation, "regex-error");
    const invalid = session.receive({ ...start, pattern: "x".repeat(4000) + "\n(" });
    assert.ok(invalid?.operation === "regex-error");
    assert.match(invalid.message, /^Invalid regular expression: .*group/i);
    assert.ok(!invalid.message.includes("xxxx"));
});
