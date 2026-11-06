import { test } from "node:test";
import assert from "node:assert/strict";
import { PositionMap, anchoredRange, applyTextEdits, composePositionMaps, importText, exportText } from "../src/index.ts";
import { corpus, editLog } from "./fixtures/workloads.ts";

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

test("random replay maps preserve ordered positions and invert untouched UTF-16 boundaries", () => {
    let text = corpus("unicode");
    for (const edit of editLog(text.length, 400)) {
        const map = new PositionMap(text.length, [edit]), inverse = map.invert();
        const next = applyTextEdits(text, [edit]); assert.equal(next.length, map.newLength);
        for (const side of ["before", "after"] as const) {
            let previous = -1;
            const offsets = [...new Set([0, Math.max(0, edit.from - 1), edit.from, edit.to, Math.min(text.length, edit.to + 1), text.length])].sort((a, b) => a - b);
            for (const offset of offsets) {
                const mapped = map.map(offset, side);
                assert.ok(mapped.offset >= previous && mapped.offset <= next.length); previous = mapped.offset;
                if (offset < edit.from || offset > edit.to) assert.equal(inverse.map(mapped.offset, side).offset, offset);
                assert.equal(mapped.deleted, offset > edit.from && offset < edit.to);
            }
        }
        text = next;
    }
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
