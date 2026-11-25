import test from "node:test";
import assert from "node:assert/strict";
import { provide } from "./fixtures/language/provider.ts";
test("synthetic completion keeps separate insertion and replacement ranges", () => {
    const input = { id: 1, revision: 7, text: "😀 const saMORE = 1; // TODO", offset: 11, delay: 0 };
    const result = provide(input);
    assert.deepEqual(result.completion, { from: 9, to: 11, replaceTo: 15, insert: "sample" });

});
