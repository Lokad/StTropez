import test from "node:test";
import assert from "node:assert/strict";
import { FindIndex } from "../src/core/find-index.ts";
import { createFindReplacementPlan } from "../src/core/find.ts";
import type { FindPlanStep } from "../src/core/find.ts";

const positions = () => { const index = new FindIndex(); index.append({ from: 0, to: 3 }); index.append({ from: 4, to: 7 }); return index; };

test("replacement assembly owns streamed edits before a backend reuses its buffers", () => {
    const receive = createFindReplacementPlan(positions(), 2), first = { from: 0, to: 3, insert: "dog" };
    const chunk = [first]; assert.equal(receive({ done: false, edits: chunk }), undefined);
    first.from = 9; first.insert = "changed"; chunk.length = 0;
    const second = { from: 4, to: 7, insert: "fox" }, complete = receive({ done: true, edits: [second] });
    second.insert = "changed";
    assert.deepEqual(complete, [{ from: 0, to: 3, insert: "dog" }, { from: 4, to: 7, insert: "fox" }]);
    assert.ok(Object.isFrozen(complete)); assert.ok(complete!.every(Object.isFrozen));
});

test("replacement assembly rejects malformed, oversized, incomplete and excess steps", () => {
    const first = { from: 0, to: 3, insert: "dog" }, second = { from: 4, to: 7, insert: "fox" };
    const cases: readonly [unknown, RegExp][] = [
        [null, /Invalid replacement plan step/],
        [{ done: "yes", edits: [] }, /Invalid replacement plan step/],
        [{ done: true, edits: {} }, /Invalid replacement plan step/],
        [{ done: false, edits: Array(1025).fill(first) }, /Invalid replacement plan step/],
        [{ done: true, edits: [first] }, /Incomplete replacement plan/],
        [{ done: true, edits: [first, second, second] }, /Invalid replacement plan\./],
        [{ done: true, edits: [{ ...first, insert: 7 }] }, /Invalid replacement plan\./],
    ];
    for (const [step, error] of cases) assert.throws(() => createFindReplacementPlan(positions(), 2)(step as FindPlanStep), error);
    const receive = createFindReplacementPlan(positions(), 2);
    assert.equal(receive({ done: false, edits: [first] }), undefined);
    assert.throws(() => receive({ done: true, edits: [] }), /Incomplete replacement plan/);
});
