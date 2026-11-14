import { test } from "node:test";
import assert from "node:assert/strict";
import { PositionMap, anchoredRange, applyTextEdits, composePositionMaps, importText, exportText } from "../src/index.ts";
import type { Affinity, AnchoredRange, PositionMapping, TextEdit } from "../src/index.ts";
import { corpus } from "./fixtures/workloads.ts";

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
    assert.throws(() => cursor(1, "invalid" as "after"), TypeError);
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
    const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
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
        for (let step = 0; step < 3; step++) {
            const edits = batch(text.length), expected = mappingOracle(text, edits), actual = new PositionMap(text.length, edits), inverse = mappingOracle(expected.text, expected.reverse);
            const context = `seed=${initialSeed}; trial=${trial}; step=${step}; text=${JSON.stringify(text)}; edits=${JSON.stringify(edits)}`;
            assert.equal(applyTextEdits(text, edits), expected.text, context); assert.equal(actual.newLength, expected.text.length, context);
            check(actual, expected, ranges(text.length, edits), context);
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
