import test from "node:test";
import assert from "node:assert/strict";
import { createSelectionSet } from "../src/index.ts";
import { renameName, renameSelections } from "../fixtures/language/rename.ts";
test("synthetic rename accepts its Unicode identifier subset and rejects reserved or oversized names", () => {
    for (const valid of ["newName", "café", "𐐀value", "_", "a".repeat(256)]) assert.equal(renameName(valid), true);
    for (const invalid of ["", "1name", "$value", "a-b", "class", "null", "x".repeat(257), "<img>", "a\n"]) assert.equal(renameName(invalid), false);
});


test("rename selection policy retains direction, complete sets and name-relative positions without splitting a surrogate", () => {
    const before = createSelectionSet(30, [{ anchor: 11, head: 8 }, { anchor: 30, head: 30 }], 0), edits = [{ from: 6, to: 15, insert: "inventory" }];
    assert.deepEqual(renameSelections(30, before, edits), before);
    const short = renameSelections(30, before, [{ ...edits[0]!, insert: "x" }]); assert.deepEqual(short.ranges.map(r => [r.anchor, r.head]), [[7, 7], [22, 22]]); assert.equal(short.primary, 0);
    const astral = renameSelections(10, createSelectionSet(10, [{ anchor: 1, head: 3 }]), [{ from: 0, to: 5, insert: "𐐀name" }]); assert.deepEqual(astral.ranges.map(r => [r.anchor, r.head]), [[0, 3]]);
});
