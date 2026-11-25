import { test } from "node:test";
import assert from "node:assert/strict";
import { scrollAxis } from "../src/browser/scroll.ts";

test("logical scroll ranges remain reachable beyond physical browser extents", () => {
    for (const extent of [0, 1, 640, 4_000_000, 24_000_000, 1e12]) {
        const axis = scrollAxis(extent, 640);
        assert.ok(axis.physicalExtent <= 4_000_000 && axis.physicalExtent >= 640);
        for (const fraction of [0, .001, .5, .999, 1]) {
            const logical = axis.maximum * fraction;
            assert.ok(Math.abs(axis.toLogical(axis.toPhysical(logical)) - logical) <= Math.max(1e-6, extent * 1e-15));
        }
        assert.equal(axis.toLogical(-1), 0); assert.equal(axis.toPhysical(Infinity), axis.physicalMaximum);
    }
    assert.throws(() => scrollAxis(Number.NaN, 100), RangeError);
    const ordinary = scrollAxis(76_824, 653);
    assert.equal(ordinary.toPhysical(38_448), 38_448);
    assert.equal(ordinary.toLogical(38_448), 38_448);
});
