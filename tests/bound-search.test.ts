import assert from "node:assert/strict";
import test from "node:test";
import { partitionPoint } from "../src/core/bound-search.ts";

test("partition points preserve empty, equal-key and lower/upper endpoint conventions", () => {
    for (const values of [[], [2], [2, 2, 2], [-1, 1, 2, 2, 4]]) {
        for (const key of [-2, -1, 0, 1, 1.5, 2, 3, 4, 5]) for (const upper of [false, true]) {
            const expected = values.findIndex(value => upper ? value > key : value >= key);
            const actual = partitionPoint(values.length, index => upper ? values[index]! <= key : values[index]! < key);
            assert.equal(actual, expected < 0 ? values.length : expected);
        }
    }
});

test("partition probes stay within logarithmic bounds across safe integer index domains", () => {
    for (const length of [0, 1, 2, 3, 31, 256, 2 ** 31, 2 ** 31 + 17, 2 ** 32 + 17, 2 ** 40 + 33, Number.MAX_SAFE_INTEGER]) {
        const cuts = length < 32 ? Array.from({ length: length + 1 }, (_, i) => i) : [0, 1, Math.floor(length / 2), length - 1, length];
        for (const cut of cuts) {
            const seen = new Set<number>(), limit = Math.ceil(Math.log2(length + 1));
            const found = partitionPoint(length, index => {
                assert.ok(Number.isSafeInteger(index) && index >= 0 && index < length);
                assert.ok(!seen.has(index)); seen.add(index); assert.ok(seen.size <= limit);
                return index < cut;
            });
            assert.equal(found, cut);
        }
    }
});
