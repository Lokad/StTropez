import test from "node:test";
import assert from "node:assert/strict";
import { createSelectionSet, TextBuffer } from "../src/index.ts";
import { NavigationSession, validateNavigationInput } from "../fixtures/language/navigation.ts";
import { renameName, renameSelections, validateRenamePreview } from "../fixtures/language/rename.ts";
function scan(texts: readonly string[], symbol = "café", budget = 16384) {
    const input = validateNavigationInput({ operation: "navigation-start", id: 1, kind: "references", symbol, includeDeclaration: true, delay: 0, documents: texts.map((s, i) => ({ document: "doc" + i, revision: i + 3, length: s.length })) }), s = new NavigationSession(input);
    for (const [i, text] of texts.entries()) {
        const document = "doc" + i; s.handle({ operation: "navigation-document", id: 1, document });
        for (let from = 0; from < text.length; from += budget) s.handle({ operation: "navigation-chunk", id: 1, document, from, text: text.slice(from, from + budget) });
        s.handle({ operation: "navigation-end-document", id: 1, document });
    }
    return { result: s.handle({ operation: "navigation-finish", id: 1 }), capture: { input, document: "doc0", offset: texts[0]!.indexOf(symbol) + 2 }, buffers: new Map(texts.map((t, i) => ["doc" + i, TextBuffer.from(t)])) };
}
test("rename reuses complete streamed lexical matches with raw Unicode/CRLF and immutable ranges", () => {
    const texts = ["const café = 1;\r\ncafé; // café\r\n'café'", "café;"];
    for (const size of [1, 3, 16384]) { const x = scan(texts, "café", size), value = validateRenamePreview(x.result, x.capture, x.buffers); assert.equal(value.locations.length, 3); assert.ok(Object.isFrozen(value.locations)); }
    for (const valid of ["newName", "café", "𐐀value", "_", "a".repeat(256)]) assert.equal(renameName(valid), true);
    for (const invalid of ["", "1name", "$value", "a-b", "class", "null", "x".repeat(257), "<img>", "a\n"]) assert.equal(renameName(invalid), false);
});
test("rename rejects whole malformed late targets and stale revisions before returning a preview", () => {
    const x = scan(["café;", "café;"]), locations = x.result.locations as Record<string, unknown>[];
    for (const bad of [{ ...x.result, locations: [...locations, { ...locations[1], revision: 99 }] }, { ...x.result, locations: [...locations, { ...locations[1], document: "missing" }] },
        { ...x.result, locations: [...locations, locations[0]] }, { ...x.result, locations: [locations[0], { ...locations[1], to: 999 }] }]) assert.throws(() => validateRenamePreview(bad, x.capture, x.buffers));
    assert.throws(() => validateRenamePreview(x.result, { ...x.capture, document: "missing" }, x.buffers));
});
test("rename cannot apply a truncated scan or an origin inside opaque text or dollar identifiers", () => {
    const over = scan(["café;".repeat(1025)]); assert.throws(() => validateRenamePreview(over.result, over.capture, over.buffers), /exceeds/);
    for (const text of ["'café'; café;", "// café\ncafé;", "$café; café;", "café$; café;"]) { const x = scan([text]); assert.throws(() => validateRenamePreview(x.result, x.capture, x.buffers)); }
    const exact = scan(["café;".repeat(1024)]); assert.equal(validateRenamePreview(exact.result, exact.capture, exact.buffers).locations.length, 1024);
});
test("rename selection policy retains direction, complete sets and name-relative positions without splitting a surrogate", () => {
    const before = createSelectionSet(30, [{ anchor: 11, head: 8 }, { anchor: 30, head: 30 }], 0), edits = [{ from: 6, to: 15, insert: "inventory" }];
    assert.deepEqual(renameSelections(30, before, edits), before);
    const short = renameSelections(30, before, [{ ...edits[0]!, insert: "x" }]); assert.deepEqual(short.ranges.map(r => [r.anchor, r.head]), [[7, 7], [22, 22]]); assert.equal(short.primary, 0);
    const astral = renameSelections(10, createSelectionSet(10, [{ anchor: 1, head: 3 }]), [{ from: 0, to: 5, insert: "𐐀name" }]); assert.deepEqual(astral.ranges.map(r => [r.anchor, r.head]), [[0, 3]]);
});
