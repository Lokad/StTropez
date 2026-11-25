import test from "node:test";
import assert from "node:assert/strict";
import { renameName } from "./fixtures/language/rename.ts";
test("synthetic rename accepts its Unicode identifier subset and rejects reserved or oversized names", () => {
    for (const valid of ["newName", "café", "𐐀value", "_", "a".repeat(256)]) assert.equal(renameName(valid), true);
    for (const invalid of ["", "1name", "$value", "a-b", "class", "null", "x".repeat(257), "<img>", "a\n"]) assert.equal(renameName(invalid), false);
});
