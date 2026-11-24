import { test } from "node:test";
import assert from "node:assert/strict";
import { TextBuffer } from "../src/index.ts";
import { inputContext } from "../src/browser/input-context.ts";
import { graphemeBoundaries } from "../src/browser/text-geometry.ts";

test("a bounded native context maps exact CRLF/Unicode offsets without serializing its buffer", () => {
    const buffer = TextBuffer.from("a😀\r\ne\u0301👩‍💻tail"), context = inputContext(buffer, { anchor: 5, head: 5 });
    assert.equal(context.text, "a😀\ne\u0301👩‍💻tail"); assert.equal(context.nativeHead, 4); assert.equal(context.toModel(4), 5);
    assert.equal(context.toModel(3), 3); assert.equal(buffer.diagnostics().textExports, 0); assert.ok(Object.isFrozen(context));
});
test("large forward/backward selections map through one placeholder with bounded reads", () => {
    const buffer = TextBuffer.from("x".repeat(24_000));
    for (const selection of [{ anchor: 0, head: buffer.length }, { anchor: 20_000, head: 1_000 }]) {
        const context = inputContext(buffer, selection);
        assert.ok(context.text.length <= 513);
        assert.equal(context.toModel(context.nativeAnchor), selection.anchor); assert.equal(context.toModel(context.nativeHead), selection.head);
    }
    assert.equal(buffer.diagnostics().textExports, 0); assert.ok(buffer.diagnostics().sliceUnits <= 512);
});
test("grapheme boundaries keep surrogate pairs, combining marks, emoji joins and CRLF together", () => {
    assert.deepEqual(graphemeBoundaries("a😀e\u0301👩‍💻\r\n"), [0, 1, 3, 5, 10, 12]);
    assert.deepEqual(graphemeBoundaries(""), [0]);
});
