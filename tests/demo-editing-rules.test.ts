import { bufferReads } from "./buffer-reads.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer } from "../src/index.ts";
import { DemoEditingRules } from "../examples/demo/editing-rules.ts";
import { analyzeTypeScript } from "../examples/demo/syntax.ts";

test("demo rules preserve lexical authority through new lines, stale earlier edits and multiline literals", () => {
    const rules = new DemoEditingRules(), text = "function f() {}\n/* block\ncomment */\nconst t = `multi\nline`;";
    const base = TextBuffer.from(text); rules.accept(base, analyzeTypeScript(text).spans);
    const allow = (buffer: TextBuffer, from: number) => rules.configuration().allowPair!({ buffer, from, to: from, pair: { open: '"', close: '"' }, operation: "open" });
    assert.equal(allow(base, text.indexOf("comment") + 3), false);
    assert.equal(allow(base, text.indexOf("line`")), false);
    const at = text.indexOf("}"), entered = base.apply([{ from: at, to: at, insert: "\n  \n" }]).buffer;
    assert.equal(allow(entered, at + 3), true);
    const quoted = entered.apply([{ from: at + 3, to: at + 3, insert: '"hello' }]).buffer;
    assert.equal(allow(quoted, at + 9), false);
    const commented = base.apply([{ from: 0, to: 0, insert: "/*" }]).buffer;
    assert.equal(allow(commented, at + 2), false);
    const regex = TextBuffer.from("const r = /abc"), escaped = TextBuffer.from('const s = "a\\');
    assert.equal(allow(regex, regex.length), false); assert.equal(allow(escaped, escaped.length), false);
    const markers = 'const label = "/*"; const value = n / d /* scaled */;', capture = TextBuffer.from(markers);
    rules.accept(capture, analyzeTypeScript(markers).spans);
    const opener = (from: number) => rules.configuration().allowPair!({ buffer: capture, from, to: from + 2,
        pair: { open: "/*", close: "*/" }, operation: "open" });
    assert.equal(opener(markers.indexOf("/*")), false); assert.equal(opener(markers.lastIndexOf("/*")), true);

    const header = "// documentation\n".repeat(500);
    const before = TextBuffer.from(header + "total.toFixed()");
    rules.accept(before, analyzeTypeScript(before.slice(0, before.length)).spans);
    const atArgument = before.length - 1;
    const typed = TextBuffer.from(header + "total.toFixed(2)");
    rules.edited(before, typed, atArgument);
    assert.equal(rules.configuration().allowPair!({ buffer: typed, from: atArgument + 1, to: atArgument + 1,
        pair: { open: "(", close: ")" }, operation: "close" }), true);
});

test("demo pairing bounds synchronous reads on large unknown prefixes without exporting text", () => {
    const buffer = TextBuffer.from("x\n".repeat(100000)), rules = new DemoEditingRules();
    assert.equal(rules.configuration().allowPair!({ buffer, from: 100000, to: 100000, pair: { open: "{", close: "}" }, operation: "open" }), false);
    assert.deepEqual(bufferReads(buffer), { textExports: 0, sliceUnits: 0 });
});
