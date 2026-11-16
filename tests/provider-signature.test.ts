import test from "node:test";
import assert from "node:assert/strict";
import { SignatureScanner, signatureTriggerName, validateSignatureInput, validateSignatureResult } from "../fixtures/language/signature.ts";
import { ProviderProject } from "../fixtures/language/project.ts";
function scan(text: string, size = 16384) {
    const input = validateSignatureInput({ id: 1, document: "source", revision: 2, length: text.length, offset: text.length, delay: 0 }), scanner = new SignatureScanner();
    for (let from = 0; from < text.length; from += size) scanner.feed(text.slice(from, from + size), from);
    return { input, result: validateSignatureResult(scanner.result(input), input) };
}
test("signature context stays exact across every chunk boundary with Unicode/CRLF, nested calls, comments, strings and regex", () => {
    const text = "\ufeffconst r = /lookup\\([,)]/;\r\n/* lookup('fake', */\r\nlookup /* comment */ ('😀,', format(1, 'fr'), { a: [1, 2] }, /[,()]/, ";
    for (let size = 1; size <= text.length; size++) { const { result } = scan(text, size); assert.equal(result.reason, "ready"); assert.deepEqual(result.call, { name: "lookup", open: text.indexOf("('😀"), argument: 4 }); assert.equal(result.signatures.length, 2); }
});
test("the innermost call and active argument follow closures/grouping and do not invent support for unknown callees", () => {
    for (const [text, name, argument] of [["lookup('x', format(1, ", "format", 1], ["lookup((1 + 2), ", "lookup", 1], ["lookup('x', format(1)), lookup(", "lookup", 0], ["café('texte', ", "café", 1]] as const) {
        const { result } = scan(text, 2); assert.equal(result.call?.name, name); assert.equal(result.call?.argument, argument);
    }
    assert.equal(scan("lookup('x', unknown(").result.reason, "unsupported"); assert.equal(scan("lookup('x', " + "x".repeat(257) + "(").result.reason, "unsupported");
    assert.equal(scan("__proto__(").result.reason, "unsupported"); assert.equal(scan("lookup('x')").result.reason, "no-call");
});
test("strings, comments and opaque templates refuse help at the caret and nesting limits are explicit", () => {
    for (const text of ["lookup('a", "lookup(\"a", "lookup(`template ${format(", "lookup(// comment", "lookup(/* comment", "lookup(/[,("]) assert.equal(scan(text, 1).result.reason, "literal");
    assert.equal(scan("lookup(" + "[".repeat(128)).result.reason, "depth-limit");
    const scanner = new SignatureScanner(); assert.throws(() => scanner.feed("x", 1)); assert.throws(() => scanner.feed("x".repeat(16385), 0));
});
test("a distant lexical state stays correct in100k rows without a main-thread context window assumption", () => {
    const prefix = "const unchanged = 123;\r\n".repeat(100000);
    const { result } = scan(prefix + "lookup('key', "); assert.equal(result.call?.argument, 1); assert.equal(result.call?.open, prefix.length + 6);
    assert.equal(scan("/*" + prefix + "lookup('fake', ").result.reason, "no-call");
});
test("signature payload validation rejects malformed late overloads, reordered ranges and split UTF-16 labels before publication", () => {
    const { input, result } = scan("lookup('x', "), first = result.signatures[0]!;
    for (const signatures of [
        [...result.signatures, { ...first, parameters: [{ from: -1, to: 1, documentation: "bad" }] }],
        [{ ...first, parameters: [...first.parameters].reverse() }], [{ ...first, label: "😀value", parameters: [{ from: 1, to: 2, documentation: "bad" }] }],
        [{ ...first, documentation: "x".repeat(2049) }], Array.from({ length: 9 }, () => first)
    ]) assert.throws(() => validateSignatureResult({ ...result, signatures }, input));
    for (const patch of [{ document: "other" }, { revision: 3 }, { activeSignature: 99 }, { call: { ...result.call!, open: input.offset } }, { call: null }]) assert.throws(() => validateSignatureResult({ ...result, ...patch }, input));
    assert.equal(validateSignatureResult({ ...result, signatures: [{ ...first, documentation: "<img src=x>" }] }, input).signatures[0]!.documentation, "<img src=x>");
});
test("input bounds and incomplete scans are rejected before worker state can be consumed", () => {
    assert.equal(signatureTriggerName("const value = lookup"), true); assert.equal(signatureTriggerName("object.café "), true); assert.equal(signatureTriggerName("notlookup"), false); assert.equal(signatureTriggerName("ordinary text,"), false); assert.throws(() => signatureTriggerName("x".repeat(513)));
    const input = validateSignatureInput({ id: 1, document: "source", revision: 0, length: 10, offset: 10, delay: 0 });
    for (const patch of [{ id: 0 }, { revision: -1 }, { offset: 11 }, { length: 16777217 }, { delay: 1001 }]) assert.throws(() => validateSignatureInput({ ...input, ...patch }));
    assert.throws(() => new SignatureScanner().result(input), /Incomplete/);
});
test("actual project signature continuations lock mutations, require synchronized revisions and scan at most16k units per reply", () => {
    const text = "const unchanged = 123;\r\n".repeat(2000) + "lookup('key', ", project = new ProviderProject(3);
    const send = (operation: string, fields: Record<string, unknown> = {}) => project.handle({ version: 1, epoch: 3, sequence: project.snapshot().sequence + 1, operation, ...fields });
    send("project-hello"); send("project-open", { document: "source", revision: 2, length: text.length });
    for (let from = 0; from < text.length; from += 16384) send("project-chunk", { document: "source", revision: 2, from, text: text.slice(from, from + 16384) }); send("project-commit", { document: "source", revision: 2 });
    const input = validateSignatureInput({ id: 9, document: "source", revision: 2, length: text.length, offset: text.length, delay: 0 });
    assert.throws(() => send("project-signature", { input: { ...input, revision: 3 } }), /synchronized/); send("project-signature", { input });
    assert.throws(() => send("project-close", { document: "source", revision: 2 }), /Complete the signature/); let work = 0, reply;
    do { reply = send("project-signature-next", { request: input.id }); if (reply.operation.endsWith("progress")) { assert.ok((reply.work as number) - work <= 16384); work = reply.work as number; } } while (!reply.operation.endsWith("result"));
    assert.equal(work, text.length); assert.equal(validateSignatureResult(reply.result, input).call?.argument, 1); assert.equal(project.buffer("source")!.readMetrics().textExports, 0); assert.equal(project.snapshot().signaturePending, false);
});
