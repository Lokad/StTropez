import assert from "node:assert/strict";
import { nextSeed } from "../fixtures/workloads.ts";
import test from "node:test";
import { TextBuffer } from "../src/core/text-buffer.ts";
import { adjustInsertionText, insertionContext, reindentInsertionText } from "../src/core/insertion-text.ts";

test("multiline insertion keeps relative indentation and maps body ranges through spaces and CRLF", () => {
    const buffer = TextBuffer.from("function outer() {\r\n\t\tcall\r\n}\r\n"), at = buffer.offsetAt(1) + 2;
    const context = insertionContext(buffer, at, { tabSize: 4, insertSpaces: true });
    assert.deepEqual(context, { columns: 8, tabSize: 4, insertSpaces: true, lineEnding: "\r\n" });
    const input = "if (ok) {\n\twork(😀);\n}\n", result = adjustInsertionText(input, context);
    assert.equal(result.text, "if (ok) {\r\n            work(😀);\r\n        }\r\n        ");
    const from = input.indexOf("work"), to = from + "work(😀)".length;
    assert.equal(result.text.slice(result.mapping.map(from, "after").offset, result.mapping.map(to, "before").offset), "work(😀)");
    assert.equal(result.mapping.map(input.length, "after").offset, result.text.length);
    assert.equal(result.mapPosition(from), result.text.indexOf("work"));
    assert.ok(Object.isFrozen(result) && Object.isFrozen(context));
});

test("insertion context stops at the insertion and at non-whitespace, including an empty final row", () => {
    const buffer = TextBuffer.from("\t\t\tcode\r\n"), config = { tabSize: 4, insertSpaces: false };
    assert.equal(insertionContext(buffer, 1, config).columns, 4);
    assert.equal(insertionContext(buffer, 7, config).columns, 12);
    assert.deepEqual(insertionContext(buffer, buffer.length, config), { ...config, columns: 0, lineEnding: "\r\n" });
    assert.throws(() => insertionContext(buffer, buffer.length + 1, config), RangeError);
});

test("tabs follow configured stops while first-line whitespace and non-leading characters remain literal", () => {
    const context = { tabSize: 4, insertSpaces: false, columns: 4, lineEnding: "\n" as const };
    assert.equal(adjustInsertionText("  first\r\n      body\ttext\r\n\r\nlast\rraw", context).text,
        "  first\n\t\t  body\ttext\n\t\n\tlast\rraw");
    assert.equal(adjustInsertionText("first\n \tbody", context).text, "first\n\t\tbody");
    const unchanged = adjustInsertionText("a\n\tb", { ...context, columns: 0 });
    assert.equal(unchanged.text, "a\n\tb");
    for (let i = 0; i <= unchanged.text.length; i++) assert.deepEqual(unchanged.mapping.map(i, "after"), { offset: i, deleted: false });
});

test("final insertion limits account for newline contractions before allocating indentation", () => {
    const context = { tabSize: 4, insertSpaces: true, columns: 1, lineEnding: "\n" as const };
    const input = "a\r\n\r\n", expected = "a\n \n ";
    assert.equal(adjustInsertionText(input, context, expected.length).text, expected);
    assert.throws(() => adjustInsertionText(input, context, expected.length - 1), /insertion limit/);
    assert.throws(() => adjustInsertionText("x\ny", { ...context, columns: Number.MAX_SAFE_INTEGER }, 16), /insertion limit/);
    assert.throws(() => adjustInsertionText("long", context, 3), /insertion limit/);
    assert.throws(() => adjustInsertionText("x", { ...context, tabSize: 0 }), RangeError);
    const contracts = "aa\n\tb\r\n\r\n\r\n", normalized = "aa\n    b\n\n\n";
    assert.equal(adjustInsertionText(contracts, { ...context, columns: 0 }, normalized.length).text, normalized);
});

test("format markers distinguish empty lines, trailing stops and normalized whitespace boundaries", () => {
    const result = adjustInsertionText("\n\n", { columns: 4, tabSize: 4, insertSpaces: true, lineEnding: "\r\n" });
    assert.equal(result.text, "\r\n    \r\n    ");
    assert.equal(result.mapPosition(0), 0); assert.equal(result.mapPosition(1), 6);
    assert.equal(result.mapPosition(1, "before"), 2); assert.equal(result.mapPosition(2), 12); assert.equal(result.mapPosition(2, "before"), 8);
    const tabs = adjustInsertionText("a\n  x", { columns: 3, tabSize: 4, insertSpaces: false, lineEnding: "\n" });
    assert.equal(tabs.text, "a\n\t x");
    assert.equal(tabs.mapPosition(2), 3); assert.equal(tabs.mapPosition(3), 3); assert.equal(tabs.mapPosition(4), 4);
    assert.equal(tabs.mapPosition(3, "before"), 3); assert.equal(tabs.mapPosition(2, "before"), 2);
    assert.throws(() => tabs.mapPosition(100), RangeError);
    const moved = reindentInsertionText("\n        body\n  tail", 8, { columns: 4, tabSize: 4, insertSpaces: true, lineEnding: "\r\n" });
    assert.equal(moved.text, "\r\n    body\r\ntail");
    assert.equal(moved.text.slice(moved.mapPosition(9), moved.mapPosition(13, "before")), "body");
    assert.equal(moved.mapPosition(16), moved.text.indexOf("tail"));
});

test("formatted marker bounds remain ordered and preserve raw body ranges across varied indentation", () => {
    let seed = 0x1de17;
    const random = (n: number) => { seed = nextSeed(seed); return (seed >>> 8) % n; };
    for (let trial = 0; trial < 250; trial++) {
        let input = ""; const bodies: { from: number; to: number; text: string }[] = [];
        for (let line = 0; line < 5; line++) {
            input += Array.from({ length: random(8) }, () => random(2) ? " " : "\t").join("");
            const text = `mark${trial}_${line}😀\ud800\r body`, from = input.length; input += text;
            bodies.push({ from, to: input.length, text }); input += random(2) ? "\n" : "\r\n";
        }
        const result = adjustInsertionText(input, { columns: random(13), tabSize: 1 + random(8), insertSpaces: !!random(2), lineEnding: random(2) ? "\n" : "\r\n" });
        let before = 0, after = 0;
        for (let at = 0; at <= input.length; at++) {
            const a = result.mapPosition(at, "before"), b = result.mapPosition(at, "after");
            assert.ok(a >= before && b >= after && a <= b && b <= result.text.length, `marker ${trial}:${at}`); before = a; after = b;
        }
        for (const body of bodies) assert.equal(result.text.slice(result.mapPosition(body.from), result.mapPosition(body.to, "before")), body.text);
    }
});

test("insertion context reads local whitespace without exporting or traversing a large document", t => {
    const row = "\t\tconst value = 123;\r\n", buffer = TextBuffer.from(row.repeat(100000));
    const context = insertionContext(buffer, buffer.offsetAt(50000) + 2, { tabSize: 4, insertSpaces: true });
    assert.equal(context.columns, 8); assert.deepEqual(buffer.readMetrics(), { textExports: 0, sliceUnits: 4 });
    const long = TextBuffer.from("    " + "x".repeat(1_000_000));
    assert.equal(insertionContext(long, long.length, { tabSize: 4, insertSpaces: true }).columns, 4);
    assert.deepEqual(long.readMetrics(), { textExports: 0, sliceUnits: 4096 });
    t.diagnostic(JSON.stringify({ rows: 100000, contextReadUnits: buffer.readMetrics().sliceUnits, longRowReadUnits: long.readMetrics().sliceUnits }));
});
