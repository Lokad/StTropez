import test from "node:test";
import assert from "node:assert/strict";
import { AdvanceIndex, createAdvanceBuilder } from "../src/index.ts";

function prefixes(values: readonly number[]): number[] { const result = [0]; for (const value of values) result.push(result.at(-1)! + value); return result; }
function expectedWindow(values: readonly number[], low: number, high: number) {
    const points = prefixes(values); return values.flatMap((advance, index) => {
        const from = points[index]!, to = points[index + 1]!;
        const hit = from === to ? from >= low && from < high : Math.min(from, to) < high && Math.max(from, to) > low;
        return hit ? [{ index, from, to, advance }] : [];
    });
}

test("signed advance snapshots agree with independent flat prefix and spatial oracles through retained edits", () => {
    let seed = 731, values = Array.from({ length: 3000 }, (_, i) => (i % 7 - 2) / 4), index = AdvanceIndex.from(values);
    const random = (limit: number) => { seed = Math.imul(seed, 1664525) + 1013904223 >>> 0; return seed % limit; };
    const old: { index: AdvanceIndex; values: number[] }[] = [];
    for (let step = 0; step < 500; step++) {
        if (step % 50 === 0) old.push({ index, values: [...values] });
        const from = random(values.length + 1), to = Math.min(values.length, from + random(12)), insert = Array.from({ length: random(12) }, () => (random(17) - 8) / 4);
        index = index.replace(from, to, AdvanceIndex.from(insert)); values.splice(from, to - from, ...insert);
        const points = prefixes(values); assert.equal(index.total, points.at(-1)); assert.equal(index.minimum, Math.min(...points)); assert.equal(index.maximum, Math.max(...points));
        for (const offset of [0, from, values.length, random(values.length + 1)]) assert.equal(index.prefix(offset), points[offset]);
        const low = (random(1600) - 800) / 4, high = low + 20, expected = expectedWindow(values, low, high), actual = index.window(low, high, 19);
        assert.deepEqual(actual.cells, expected.slice(0, 19)); assert.equal(actual.truncated, expected.length > 19);
        assert.ok(Object.isFrozen(actual)); assert.ok(Object.isFrozen(actual.cells)); if (actual.cells.length) assert.ok(Object.isFrozen(actual.cells[0]));
        const part = index.slice(from, Math.min(from + 17, values.length)); assert.equal(part.total, values.slice(from, from + 17).reduce((a, b) => a + b, 0));
        assert.ok(index.diagnostics().height <= 2 * Math.ceil(Math.log2(index.diagnostics().leaves + 1)));
    }
    for (const retained of old) for (let i = 0, total = 0; i <= retained.values.length; i++) { assert.equal(retained.index.prefix(i), total); if (i < retained.values.length) { assert.equal(retained.index.at(i), retained.values[i]); total += retained.values[i]!; } }
    assert.ok(Object.isFrozen(index));
});

test("bounded builders copy source slices, publish only finished roots and roll back malformed or reentrant appends", () => {
    const builder = createAdvanceBuilder(), source = new Float64Array([3, 0, -2, 5]); builder.append(source, 1, 4); source.fill(90);
    const before = builder.snapshot(); assert.equal(before.result, null); assert.equal(before.length, 3); assert.ok(Object.isFrozen(before));
    for (const bad of [[NaN], [Infinity], new Float64Array(257)]) { assert.throws(() => builder.append(bad)); assert.equal(builder.snapshot(), before); }
    let blocked = 0; builder.append({ get length() { assert.throws(() => builder.finish()); blocked++; return 1; }, get 0() { assert.throws(() => builder.dispose()); blocked++; return 2; } });
    assert.equal(blocked, 2); const result = builder.finish(); assert.equal(builder.finish(), result); assert.equal(result.total, 5); assert.equal(result.at(1), -2);
    assert.throws(() => builder.append([1])); builder.dispose(); assert.equal(builder.snapshot().result, null); assert.equal(result.total, 5); assert.throws(() => builder.finish());
    const overflow = AdvanceIndex.builder(); overflow.append([1e308]); const saved = overflow.snapshot(); assert.throws(() => overflow.append([1e308])); assert.equal(overflow.snapshot(), saved); assert.equal(overflow.finish().total, 1e308);
    assert.throws(() => AdvanceIndex.from([1e308, -1e308, -1e308]));
    const empty = AdvanceIndex.from([]); assert.equal(empty.prefix(0), 0); assert.equal(empty.slice(0), empty); assert.equal(empty.replace(0, 0, empty), empty);
    let inputReads = 0; const bounded = AdvanceIndex.builder(), input = new Proxy({ length: 1_000_000 }, { get: (target, key) => { if (key === "length") return target.length; inputReads++; return 1.5; } }) as ArrayLike<number>;
    bounded.append(input, 999_000, 999_256); assert.equal(inputReads, 256); const captured = bounded.finish(); assert.equal(inputReads, 256); assert.equal(captured.total, 384);
    for (const invoke of [() => empty.at(0), () => result.prefix(9), () => result.window(1, 1), () => result.window(0, 1, 0), () => result.replace(-1, 0, empty)]) assert.throws(invoke);
});

test("million-entry tail windows and coordinates beyond native limits use bounded tree traversal", () => {
    const values = new Float64Array(1_000_000).fill(32.25), builder = AdvanceIndex.builder();
    for (let from = 0; from < values.length; from += 256) builder.append(values, from, Math.min(values.length, from + 256));
    const index = builder.finish(); builder.dispose(); values.fill(0);
    assert.equal(index.total, 32_250_000); assert.equal(index.prefix(999_990), 999_990 * 32.25);
    const visible = index.window(999_980 * 32.25, 999_990 * 32.25);
    assert.deepEqual(visible.cells.map(c => c.index), Array.from({ length: 10 }, (_, i) => 999_980 + i)); assert.equal(visible.truncated, false);
    assert.ok(visible.readValues <= 512); assert.ok(visible.visitedNodes < 100); assert.ok(index.diagnostics().height < 30);
});

test("signed endpoint summaries prune empty sawtooth windows and retain zero advances at a maximum", () => {
    const values = new Float64Array(200_000); for (let i = 0; i < values.length; i++) values[i] = i % 2 ? -4 : 4;
    const index = AdvanceIndex.from(values), empty = index.window(4, 5); assert.equal(empty.cells.length, 0); assert.equal(empty.readValues, 0); assert.equal(empty.visitedNodes, 1);
    const withZero = index.replace(100_000, 100_000, AdvanceIndex.from([4, 0, -4])), point = withZero.window(4, 5);
    assert.deepEqual(point.cells, [{ index: 100_001, from: 4, to: 4, advance: 0 }]); assert.equal(point.truncated, false); assert.ok(point.readValues <= 512); assert.ok(point.visitedNodes < 100);
    const overlap = index.window(1, 2, 17); assert.equal(overlap.cells.length, 17); assert.equal(overlap.truncated, true); assert.ok(overlap.readValues <= 256);
});

test("local advance replacements share unchanged numeric leaves across retained versions", () => {
    const original = AdvanceIndex.from(new Float64Array(100_000).fill(1.5)), versions = [original]; let current = original;
    for (let i = 0; i < 100; i++) { const at = (i * 719) % current.length; current = current.replace(at, at + 1, AdvanceIndex.from([2.5])); versions.push(current); }
    const retained = AdvanceIndex.retained(versions); assert.equal(retained.versions, 101); assert.ok(retained.values < 160_000); assert.ok(retained.nodes < 5000);
    assert.equal(original.total, 150_000); assert.equal(current.total, 150_100); assert.deepEqual(AdvanceIndex.retained([original, original]), { ...AdvanceIndex.retained([original]), versions: 2 });
});
