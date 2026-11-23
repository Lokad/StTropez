import { test } from "node:test";
import { unchangedPositionEdges } from "../src/core/positions.ts";
import { documentChange } from "../src/core/document-change.ts";
import assert from "node:assert/strict";
import { anchoredRange, applyTextEdits, importText, exportText, TextBuffer } from "../src/index.ts";
import { PositionMap, composePositionMaps } from "../src/kernels/index.ts";
import type { Affinity, AnchoredRange, PositionMapping, TextEdit } from "../src/index.ts";
import { nextSeed, corpus } from "../fixtures/workloads.ts";

test("position mapping defines insertion, replacement, deletion and adjacent-batch affinity", () => {
    const map = new PositionMap(6, [{ from: 1, to: 1, insert: "😀" }, { from: 1, to: 3, insert: "X" }, { from: 3, to: 3, insert: "Y" }]);
    assert.equal(map.newLength, 8);
    assert.deepEqual(map.map(0), { offset: 0, deleted: false });
    assert.deepEqual(map.map(1, "before"), { offset: 1, deleted: false });
    assert.deepEqual(map.map(1, "after"), { offset: 4, deleted: false });
    assert.deepEqual(map.map(2, "before"), { offset: 3, deleted: true });
    assert.deepEqual(map.map(2, "after"), { offset: 4, deleted: true });
    assert.deepEqual(map.map(3, "before"), { offset: 4, deleted: false });
    assert.deepEqual(map.map(3, "after"), { offset: 5, deleted: false });
    assert.deepEqual(map.map(6), { offset: 8, deleted: false });
    const insertions = new PositionMap(2, [{ from: 1, to: 1, insert: "a" }, { from: 1, to: 1, insert: "bc" }]);
    assert.equal(insertions.map(1, "before").offset, 1); assert.equal(insertions.map(1, "after").offset, 4);
    const stacked = new PositionMap(4, [
        ...Array.from({ length: 1024 }, () => ({ from: 1, to: 1, insert: "x" })),
        { from: 1, to: 3, insert: "z" }, { from: 3, to: 3, insert: "tail" },
    ]);
    assert.deepEqual(stacked.map(1, "before"), { offset: 1, deleted: false });
    assert.deepEqual(stacked.map(1, "after"), { offset: 1026, deleted: false });
    assert.deepEqual(stacked.map(2, "before"), { offset: 1025, deleted: true });
    assert.deepEqual(stacked.map(3, "after"), { offset: 1030, deleted: false });
    const cursor = stacked.createMapper();
    for (const offset of [4, 0, 1, 1, 2, 3, 3, 4, 1]) for (const side of ["after", "before", "after"] as const)
        assert.deepEqual(cursor(offset, side), stacked.map(offset, side));
    assert.throws(() => cursor(-1), RangeError); assert.throws(() => cursor(5), RangeError);
    assert.deepEqual(cursor(1, "before"), stacked.map(1, "before"));
    // Length-only maps need no document allocation, including near the safe-integer bound.
    const length = Number.MAX_SAFE_INTEGER;
    const large = new PositionMap(length, [{ from: 0, to: 0, insert: "ab" }, { from: 1, to: length - 1, insert: "" }]);
    assert.equal(large.newLength, 4); assert.deepEqual(large.map(length), { offset: 4, deleted: false });
    assert.deepEqual(large.invert().map(4), { offset: length, deleted: false });
});

test("anchored ranges exclude boundary insertions and declare full-deletion invalidation or collapse", () => {
    const map = new PositionMap(8, [{ from: 2, to: 2, insert: "left" }, { from: 6, to: 6, insert: "right" }]);
    assert.deepEqual(map.mapRange(anchoredRange(8, 2, 6)), anchoredRange(17, 6, 10));
    const deleted = new PositionMap(8, [{ from: 1, to: 3, insert: "" }, { from: 3, to: 6, insert: "" }]);
    assert.equal(deleted.mapRange(anchoredRange(8, 1, 6, { onDelete: "invalidate" })), undefined);
    assert.deepEqual(deleted.mapRange(anchoredRange(8, 1, 6)), anchoredRange(3, 1, 1));
    const replace = new PositionMap(8, [{ from: 1, to: 6, insert: "replacement" }]);
    assert.equal(replace.mapRange(anchoredRange(8, 2, 5, { onDelete: "invalidate" })), undefined);
    assert.deepEqual(replace.mapRange(anchoredRange(8, 2, 5)), anchoredRange(14, 12, 12));
    assert.equal(replace.mapRange(anchoredRange(8, 2, 2, { onDelete: "invalidate" })), undefined);
});

// Deliberately slow: splice one edit at a time, right to left, carrying a marker for every
// original boundary. Markers keep their original anchors so a collapsed replacement edge
// cannot accidentally attach to an insertion at a different original position.
function mappingOracle(text: string, edits: readonly TextEdit[]) {
    const markers = Array.from({ length: text.length + 1 }, (_, offset) => ({
        before: { offset, deleted: false }, after: { offset, deleted: false },
    })), removed = Array<boolean>(text.length).fill(false);
    let next = text;
    for (const edit of [...edits].reverse()) {
        next = next.slice(0, edit.from) + edit.insert + next.slice(edit.to);
        removed.fill(true, edit.from, edit.to);
        for (let anchor = 0; anchor <= text.length; anchor++) for (const side of ["before", "after"] as const) {
            const marker = markers[anchor]![side], units = edit.insert.length;
            if (anchor > edit.from && anchor >= edit.to) marker.offset += units - (edit.to - edit.from);
            else if (anchor > edit.from && anchor < edit.to) { marker.offset = edit.from + (side === "after" ? units : 0); marker.deleted = true; }
            else if (anchor === edit.from && side === "after") {
                if (edit.from === edit.to) marker.offset += units;
                else marker.offset = edit.from + units;
            }
        }
    }
    // Build reverse edits from actual removed text and emitted output, independently of map.invert.
    const reverse: TextEdit[] = []; let output = "", cursor = 0;
    for (const edit of edits) {
        output += text.slice(cursor, edit.from);
        reverse.push({ from: output.length, to: output.length + edit.insert.length, insert: text.slice(edit.from, edit.to) });
        output += edit.insert; cursor = edit.to;
    }
    assert.equal(output + text.slice(cursor), next);
    const map = (offset: number, side: Affinity = "after") => markers[offset]![side];
    return { text: next, reverse, map, mapRange: (range: AnchoredRange): AnchoredRange | undefined => {
        const from = map(range.from, range.fromAffinity), to = map(range.to, range.toAffinity);
        const deleted = range.from === range.to ? from.deleted : removed.slice(range.from, range.to).every(Boolean);
        return range.onDelete === "invalidate" && deleted ? undefined : { ...range, from: from.offset, to: Math.max(from.offset, to.offset) };
    } };
}

test("seeded batches, inverse edits and compositions map every UTF-16 boundary and range against a splice oracle", () => {
    const initialSeed = 0x417c29, coverage = new Set<string>(); let seed = initialSeed;
    const edges = (map: PositionMapping, before: string, after: string) => {
        const value = unchangedPositionEdges(map)!; assert.ok(value);
        assert.ok(value.prefix >= 0 && value.prefix <= Math.min(before.length, after.length));
        assert.ok(value.suffix >= 0 && value.suffix <= Math.min(before.length, after.length));
        assert.equal(before.slice(0, value.prefix), after.slice(0, value.prefix));
        assert.equal(before.slice(before.length - value.suffix), after.slice(after.length - value.suffix));
        assert.deepEqual(map.map(value.prefix, "before"), { offset: value.prefix, deleted: false });
        assert.deepEqual(map.map(before.length - value.suffix, "after"), { offset: after.length - value.suffix, deleted: false });
        const change = documentChange({ mapping: map, origin: "host", kind: "replace", previousRevision: 0, revision: 1, transactionId: 1 },
            TextBuffer.from(before), TextBuffer.from(after));
        assert.equal(applyTextEdits(before, change.edits), after);
        const split = (text: string, at: number) => at > 0 && /\r\n|[\ud800-\udbff][\udc00-\udfff]/.test(text.slice(at - 1, at + 1));
        let delta = 0;
        for (const { from, to, insert } of change.edits) {
            const start = from + delta, end = start + insert.length;
            assert.ok(!split(before, from) && !split(before, to) && !split(after, start) && !split(after, end));
            delta = end - to;
        }
    };
    const random = (n: number) => { seed = nextSeed(seed); return seed % n; };
    const inserts = ["", "a", "xyz", "\r\n", "😀", "é", "\ud800", "\udc00"];
    const batch = (length: number) => {
        const edits: TextEdit[] = []; let end = 0;
        for (let count = random(13); count > 0; count--) {
            const from = end + random(Math.min(4, length - end) + 1), to = from + random(Math.min(6, length - from) + 1), insert = inserts[random(inserts.length)]!;
            if (from === to) coverage.add(insert ? "insert" : "noop"); else coverage.add(insert ? "replace" : "delete");
            if (edits.length && from === end) coverage.add("adjacent");
            if (edits.at(-1)?.from === from) coverage.add("stacked");
            if (to - from > 1) coverage.add("interior");
            if (insert.includes("\r\n")) coverage.add("crlf");
            if (/[\ud800-\udfff]/.test(insert)) coverage.add("surrogate");
            edits.push({ from, to, insert }); end = to;
        }
        if (!edits.length) coverage.add("empty"); return edits;
    };
    const ranges = (length: number, edits: readonly TextEdit[]) => {
        const spans: [number, number][] = [[0, 0], [length, length], [0, length]];
        if (length <= 8) for (let from = 0; from <= length; from++) for (let to = from; to <= length; to++) spans.push([from, to]);
        for (const { from, to } of edits) spans.push([from, to], [from, from], [to, to], [Math.max(0, from - 1), Math.min(length, to + 1)]);
        for (let i = 0; i < 6; i++) { const from = random(length + 1); spans.push([from, from + random(length - from + 1)]); }
        return spans;
    };
    const check = (actual: PositionMapping, expected: Pick<ReturnType<typeof mappingOracle>, "map" | "mapRange">, spans: readonly [number, number][], context: string) => {
        const cursor = actual.createMapper?.();
        for (let offset = 0; offset <= actual.oldLength; offset++) for (const side of ["after", "before"] as const) {
            assert.deepEqual(actual.map(offset, side), expected.map(offset, side), `${context}; offset=${offset}, ${side}`);
            if (cursor) assert.deepEqual(cursor(offset, side), expected.map(offset, side), `${context}; cursor offset=${offset}, ${side}`);
        }
        for (const [from, to] of spans) for (const fromAffinity of ["before", "after"] as const) for (const toAffinity of ["before", "after"] as const) for (const onDelete of ["collapse", "invalidate"] as const) {
            const range = { from, to, fromAffinity, toAffinity, onDelete };
            assert.deepEqual(actual.mapRange(range), expected.mapRange(range), `${context}; range=${JSON.stringify(range)}`);
        }
    };
    for (let trial = 0; trial < 400; trial++) {
        const original = corpus("unicode").slice(0, trial % 49), maps: PositionMapping[] = [], oracles: ReturnType<typeof mappingOracle>[] = [], inverses: ReturnType<typeof mappingOracle>[] = [];
        let text = original; const batches: TextEdit[][] = [];
        const steps = 3 + trial % 7, anchors = [...new Set([0, Math.floor(original.length / 2), original.length])];
        for (let step = 0; step < steps; step++) {
            // Dense unit runs exercise both prepend/append compaction and its inverse. Half
            // finish with an arbitrary batch, checking the transition back to general geometry.
            const edits = trial % 5 === 0 && (step + 1 < steps || trial % 10 !== 0) ? anchors.map((at, index) => {
                const from = at + index * step + (trial % 2 ? step : 0); return { from, to: from, insert: "q" };
            }) : batch(text.length);
            const expected = mappingOracle(text, edits), actual = new PositionMap(text.length, edits), inverse = mappingOracle(expected.text, expected.reverse);
            const context = `seed=${initialSeed}; trial=${trial}; step=${step}; text=${JSON.stringify(text)}; edits=${JSON.stringify(edits)}`;
            assert.equal(applyTextEdits(text, edits), expected.text, context); assert.equal(actual.newLength, expected.text.length, context);
            check(actual, expected, ranges(text.length, edits), context);
            edges(actual, text, expected.text); edges(actual.invert(), expected.text, text);
            assert.equal(inverse.text, text, context); assert.equal(actual.invert().oldLength, expected.text.length, context); assert.equal(actual.invert().newLength, text.length, context);
            check(actual.invert(), inverse, ranges(expected.text.length, expected.reverse), context + "; inverse");
            check(actual.invert().invert(), expected, ranges(text.length, edits), context + "; double inverse");
            maps.push(actual); oracles.push(expected); inverses.unshift(inverse); batches.push(edits); text = expected.text;
        }
        const sequence = (steps: readonly ReturnType<typeof mappingOracle>[]) => ({
            map: (offset: number, side: Affinity = "after") => steps.reduce((prior, step) => { const next = step.map(prior.offset, side); return { offset: next.offset, deleted: prior.deleted || next.deleted }; }, { offset, deleted: false }),
            mapRange: (range: AnchoredRange) => steps.reduce<AnchoredRange | undefined>((prior, step) => prior && step.mapRange(prior), range),
        });
        const composed = composePositionMaps(...maps), context = `seed=${initialSeed}; trial=${trial}; batches=${JSON.stringify(batches)}`;
        assert.equal(composed.oldLength, original.length); assert.equal(composed.newLength, text.length);
        assert.equal(composed.invert().oldLength, text.length); assert.equal(composed.invert().newLength, original.length);
        check(composed, sequence(oracles), ranges(original.length, batches[0]!), context + "; composition");
        check(composed.invert(), sequence(inverses), ranges(text.length, oracles.at(-1)!.reverse), context + "; inverse composition");
        const incremental = maps.slice(1).reduce((prior, next) => composePositionMaps(prior, next), maps[0]!);
        edges(composed, original, text); edges(composed.invert(), text, original); edges(incremental, original, text);
        check(incremental, sequence(oracles), ranges(original.length, batches[0]!), context + "; incremental composition");
    }
    assert.deepEqual([...coverage].sort(), ["adjacent", "crlf", "delete", "empty", "insert", "interior", "noop", "replace", "stacked", "surrogate"]);
});

test("composed mappings propagate deletion, reject stale dimensions and retain immutable inputs", () => {
    const edits = [{ from: 1, to: 2, insert: "😀" }], first = new PositionMap(4, edits);
    edits[0]!.insert = "mutated";
    const second = new PositionMap(5, [{ from: 0, to: 0, insert: "!" }]), composed = composePositionMaps(first, second);
    assert.equal(first.newLength, 5); assert.equal(composed.oldLength, 4); assert.equal(composed.newLength, 6);
    assert.equal(composed.map(4).offset, 6); assert.equal(composed.invert().map(6).offset, 4);
    assert.throws(() => composePositionMaps(second, first), RangeError);
    assert.throws(() => first.map(-1), RangeError); assert.throws(() => first.map(5), RangeError);
    assert.throws(() => new PositionMap(4, [{ from: 0, to: 3, insert: "" }, { from: 2, to: 4, insert: "" }]), RangeError);
    assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(composed));
    // Opaque host semantics, including subclasses, must not be inferred from edit geometry.
    class CustomMap extends PositionMap {
        override map(offset: number, side: Affinity = "after") { return Object.freeze({ ...super.map(offset, side), deleted: true }); }
    }
    const custom = composePositionMaps(new CustomMap(4, []), first);
    assert.equal(unchangedPositionEdges(custom), undefined); assert.equal(unchangedPositionEdges(new CustomMap(4, [])), undefined);
    assert.deepEqual(custom.map(0), { offset: 0, deleted: true });
});

test("composed maps retain transient deletion, expanded anchors and safe-integer boundaries without net-edit shortcuts", () => {
    const first = new PositionMap(2, [{ from: 1, to: 1, insert: "ab" }]), second = new PositionMap(4, [{ from: 1, to: 2, insert: "" }]);
    const composed = composePositionMaps(first, second), net = new PositionMap(2, [{ from: 1, to: 1, insert: "b" }]);
    assert.deepEqual(composed.invert().map(1), { offset: 1, deleted: true });
    assert.deepEqual(net.invert().map(1), { offset: 1, deleted: false });
    const erased = composePositionMaps(first, first.invert());
    const expands = anchoredRange(2, 1, 1, { fromAffinity: "before", toAffinity: "after", onDelete: "invalidate" });
    assert.equal(erased.mapRange(expands), undefined);
    assert.deepEqual(erased.map(1), { offset: 1, deleted: false });
    assert.deepEqual(erased.mapRange({ ...expands, toAffinity: "before" }), { ...expands, toAffinity: "before" });
    const partial = composePositionMaps(new PositionMap(2, [{ from: 1, to: 1, insert: "abc" }]), new PositionMap(5, [{ from: 0, to: 2, insert: "" }]));
    assert.equal(partial.map(1, "before").deleted, true);
    assert.deepEqual(partial.mapRange(expands), { ...expands, from: 0, to: 2 }); // Expanded range still contains surviving text.
    const overlapping = composePositionMaps(new PositionMap(6, [{ from: 0, to: 0, insert: "X" }, { from: 0, to: 3, insert: "A" }]),
        new PositionMap(5, [{ from: 1, to: 4, insert: "" }]));
    const invalidating = (from: number, to: number) => anchoredRange(6, from, to, { fromAffinity: "before", toAffinity: "before", onDelete: "invalidate" });
    assert.equal(overlapping.mapRange(invalidating(0, 3)), undefined);
    assert.equal(overlapping.mapRange(invalidating(1, 5)), undefined);
    assert.deepEqual(overlapping.mapRange(invalidating(0, 5)), { ...invalidating(0, 5), from: 0, to: 1 });
    const length = Number.MAX_SAFE_INTEGER;
    const shrinking = new PositionMap(length, [{ from: 1, to: length - 1, insert: "" }]);
    const next = new PositionMap(2, [{ from: 1, to: 1, insert: "xy" }]);
    const huge = composePositionMaps(shrinking, next);
    for (const offset of [0, 1, 2, length - 2, length - 1, length]) for (const side of ["before", "after"] as const) {
        const a = shrinking.map(offset, side), b = next.map(a.offset, side);
        assert.deepEqual(huge.map(offset, side), { offset: b.offset, deleted: a.deleted || b.deleted });
    }
    assert.deepEqual(huge.invert().map(4), { offset: length, deleted: false });
    assert.deepEqual(huge.mapRange(anchoredRange(length, 1, length - 1, { onDelete: "invalidate" })), undefined);
});

test("newline conversion is explicit, maps CRLF offsets and preserves surrogate/combining/ZWJ text", () => {
    const text = "a😀\r\ne\u0301\r👩‍💻\n\ud800", preserved = importText(text, "preserve"), normalized = importText(text, "lf");
    assert.equal(preserved.text, text); assert.equal(preserved.detected, "mixed");
    assert.equal(normalized.text, "a😀\ne\u0301\n👩‍💻\n\ud800");
    assert.equal(normalized.mapping.map(5).offset, 4);
    assert.equal(exportText(normalized.text, "crlf").text, "a😀\r\ne\u0301\r\n👩‍💻\r\n\ud800");
    assert.equal(exportText(text, "preserve").text, text);
    for (const ending of ["lf", "crlf", "cr"] as const) {
        const exported = exportText(normalized.text, ending);
        assert.equal(importText(exported.text, "lf").text, normalized.text);
        assert.equal(exported.mapping.newLength, exported.text.length);
    }
    assert.equal(importText("\ud800\udc00\ud800", "lf").text, "\ud800\udc00\ud800");
    const cluster = "👩‍💻e\u0301", map = new PositionMap(cluster.length, [{ from: 0, to: 0, insert: "😀" }]);
    assert.deepEqual(map.mapRange(anchoredRange(cluster.length, 0, "👩‍💻".length)), anchoredRange(cluster.length + 2, 2, 7));
});
