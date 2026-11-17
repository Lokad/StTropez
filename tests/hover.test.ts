import test from "node:test";
import assert from "node:assert/strict";
import { provideHover, validateHoverInput } from "../fixtures/language/hover.ts";
test("bounded hover contracts retain exact raw Unicode ranges and immutable plain text", () => {
    const text = "😀 const café = 1;\r\n𐐀value", input = { operation: "hover" as const, id: 1, revision: 7, text, offset: 7, delay: 0 };
    const result = provideHover(input);
    assert.deepEqual(result.range, { from: 3, to: 8 }); assert.equal(result.text, "const\nDeclares a constant binding."); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.range));
    for (const name of ["café", "𐐀value"]) { const from = text.indexOf(name), request = { ...input, offset: from + 1 }, hover = provideHover(request);
        assert.deepEqual(hover.range, { from, to: from + name.length }); assert.equal(hover.text, `${name}\nSymbol in this source.`); }
    assert.deepEqual(provideHover({ ...input, offset: 0 }), { operation: "hover", id: 1, revision: 7, range: null, text: "" });
    assert.equal(provideHover({ ...input, text: "x".repeat(300), offset: 100 }).range, null);
});
test("synthetic hover rejects malformed and oversized requests", () => {
    const input = { operation: "hover" as const, id: 1, revision: 2, text: "𐐀value", offset: 2, delay: 0 };
    for (const bad of [null, {}, { ...input, operation: "completion" }, { ...input, id: 0 }, { ...input, revision: -1 }, { ...input, text: "x".repeat(4097) },
        { ...input, offset: -1 }, { ...input, offset: 99 }, { ...input, delay: Infinity }, { ...input, fault: "unknown" }]) assert.equal(validateHoverInput(bad), undefined);
    assert.ok(Object.isFrozen(validateHoverInput(input))); assert.throws(() => provideHover({ ...input, text: "x".repeat(4097) }), TypeError);

});
