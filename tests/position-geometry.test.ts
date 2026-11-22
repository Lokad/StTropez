import test from "node:test";
import assert from "node:assert/strict";
import { PositionMap } from "../src/kernels/index.ts";
import { batchGeometry, composeGeometry } from "../src/core/position-geometry.ts";

test("successive one-unit deletions retain bounded geometry even when their constant pieces start as singletons", () => {
    let summary = batchGeometry(new PositionMap(100, []), [], []);
    for (let count = 1; count <= 2048; count++) {
        const from = 4 + count - 1, to = from + 1, map = new PositionMap(100 + count, [{ from, to, insert: "" }]);
        summary = composeGeometry(batchGeometry(map, [from, from + 1, to, to + 1], [{ from, to }]), summary);
        // One plateau and the two unchanged sides; no retained piece per original step.
        assert.ok(summary.points.every(pieces => pieces.length <= 3), `uncoalesced geometry after ${count} deletions`);
        assert.ok(summary.covers.every(spans => spans.length <= 1));
        assert.equal(summary.expandedPointDeletes.length, 0);
    }
});
