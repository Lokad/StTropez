import test from "node:test";
import assert from "node:assert/strict";
import { provide, validateProviderResult } from "../fixtures/language/provider.ts";
test("provider offers keep separate insertion/replacement ranges and reject the entire malformed payload", () => {
    const input = { id: 1, revision: 7, text: "😀 const saMORE = 1; // TODO", offset: 11, delay: 0 };
    const result = provide(input), validated = validateProviderResult(result, input)!;
    assert.deepEqual(result.completion, { from: 9, to: 11, replaceTo: 15, insert: "sample" });
    assert.ok(Object.isFrozen(validated)); assert.ok(Object.isFrozen(validated.diagnostics));
    for (const bad of [null, {}, { ...result, id: 2 }, { ...result, revision: 8 }, { ...result, completion: { ...result.completion, from: -1 } },
        { ...result, completion: { ...result.completion, to: 12 } }, { ...result, completion: { ...result.completion, replaceTo: 1000 } },
        { ...result, diagnostics: [...result.diagnostics, { from: 0, to: 1000, message: "bad" }] }]) assert.equal(validateProviderResult(bad, input), undefined);
});
