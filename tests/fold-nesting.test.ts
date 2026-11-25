import assert from "node:assert/strict";
import { nextSeed } from "./fixtures/workloads.ts";
import test from "node:test";
import { appendNestedFold } from "../src/core/fold-nesting.ts";

test("fold nesting agrees with all accepted intervals and keeps the conflicting parent after rejection", () => {
    type Rows = Readonly<{ lineFrom: number; lineTo: number }>;
    function verify(rows: readonly Rows[]) {
        const accepted: Rows[] = [], stack: Rows[] = [];
        for (const row of rows) {
            const active = accepted.filter(prior => prior.lineTo > row.lineFrom);
            const valid = active.every(prior => row.lineTo <= prior.lineTo);
            assert.equal(appendNestedFold(stack, row), valid);
            if (valid) { accepted.push(row); active.push(row); }
            assert.deepEqual(stack, active);
            if (!valid) assert.equal(stack.at(-1), active.at(-1));
        }
    }
    verify([[0, 20], [1, 6], [2, 6], [3, 25], [6, 20], [7, 21], [8, 10], [10, 12], [20, 30]]
        .map(([lineFrom, lineTo]) => Object.freeze({ lineFrom: lineFrom!, lineTo: lineTo! })));
    let seed = 2741;
    for (let trial = 0; trial < 300; trial++) verify(Array.from({ length: 100 }, (_, lineFrom) => {
        seed = nextSeed(seed);
        return Object.freeze({ lineFrom, lineTo: lineFrom + 2 + seed % 150 });
    }));
});
