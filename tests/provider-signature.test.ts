import test from "node:test";
import assert from "node:assert/strict";
import { SignatureScanner } from "./fixtures/language/signature.ts";
function scan(text: string, size = 16384) {
    const input = { id: 1, document: "source", revision: 2, length: text.length, offset: text.length, delay: 0 }, scanner = new SignatureScanner();
    for (let from = 0; from < text.length; from += size) scanner.feed(text.slice(from, from + size), from);
    return scanner.result(input);
}
test("signature context stays exact across every chunk boundary with Unicode/CRLF, nested calls, comments, strings and regex", () => {
    const text = "\ufeffconst r = /lookup\\([,)]/;\r\n/* lookup('fake', */\r\nlookup /* comment */ ('😀,', format(1, 'fr'), { a: [1, 2] }, /[,()]/, ";
    for (let size = 1; size <= text.length; size++) { const result = scan(text, size); assert.equal(result.reason, "ready"); assert.deepEqual(result.call, { name: "lookup", open: text.indexOf("('😀"), argument: 4 }); assert.equal(result.signatures.length, 2); }
});
test("the innermost call and active argument follow closures/grouping and do not invent support for unknown callees", () => {
    for (const [text, name, argument] of [["lookup('x', format(1, ", "format", 1], ["lookup((1 + 2), ", "lookup", 1], ["lookup('x', format(1)), lookup(", "lookup", 0], ["café('texte', ", "café", 1]] as const) {
        const result = scan(text, 2); assert.equal(result.call?.name, name); assert.equal(result.call?.argument, argument);
    }
    assert.equal(scan("lookup('x', unknown(").reason, "unsupported"); assert.equal(scan("lookup('x', " + "x".repeat(257) + "(").reason, "unsupported");
    assert.equal(scan("__proto__(").reason, "unsupported"); assert.equal(scan("lookup('x')").reason, "no-call");
});
test("strings, comments and opaque templates refuse help at the caret and nesting limits are explicit", () => {
    for (const text of ["lookup('a", "lookup(\"a", "lookup(`template ${format(", "lookup(// comment", "lookup(/* comment", "lookup(/[,("]) assert.equal(scan(text, 1).reason, "literal");
    assert.equal(scan("lookup(" + "[".repeat(128)).reason, "depth-limit");
    const scanner = new SignatureScanner(); assert.throws(() => scanner.feed("x", 1)); assert.throws(() => scanner.feed("x".repeat(16385), 0));
    assert.throws(() => scanner.result({ id: 1, document: "source", revision: 0, length: 10, offset: 10, delay: 0 }), /Incomplete/);
});
test("a distant lexical state stays correct across separated lines", () => {
    const prefix = "const unchanged = 123;\r\n".repeat(1_000);
    const result = scan(prefix + "lookup('key', "); assert.equal(result.call?.argument, 1); assert.equal(result.call?.open, prefix.length + 6);
    assert.equal(scan("/*" + prefix + "lookup('fake', ").reason, "no-call");
});
