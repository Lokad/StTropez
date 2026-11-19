import { test } from "node:test";
import assert from "node:assert/strict";
import { PositionMap, TextBuffer, applyTextEdits, validateTextEdits } from "../src/index.ts";
import { nextSeed, corpus, corpusIds, editLog } from "../fixtures/workloads.ts";

test("the selected buffer applies atomic original-coordinate batches and preserves immutable snapshots", () => {
    const original = TextBuffer.from("a😀b\r\nc"), edits = [{ from: 1, to: 3, insert: "X" }, { from: 3, to: 3, insert: "Y" }, { from: 6, to: 7, insert: "Z" }];
    const result = original.apply(edits);
    assert.equal(result.buffer.text(), applyTextEdits("a😀b\r\nc", edits));
    assert.equal(original.text(), "a😀b\r\nc"); assert.ok(Object.isFrozen(original));
    assert.equal(result.mapping.map(7).offset, result.buffer.length);
    const noOp = original.apply([{ from: 1, to: 3, insert: "😀" }]);
    assert.equal(noOp.buffer, original); assert.equal(noOp.mapping.map(2).offset, 2);
    assert.throws(() => original.apply([{ from: 0, to: 3, insert: "x" }, { from: 1, to: 1, insert: "bad" }]), RangeError);
    const duplicates = original.apply([{ from: 1, to: 1, insert: "X" }, { from: 1, to: 1, insert: "Y" }]);
    assert.equal(duplicates.buffer.slice(0, 5), "aXY😀");
    const unchanged = TextBuffer.from("ab"), netNoOp = unchanged.apply([{ from: 0, to: 1, insert: "" }, { from: 1, to: 1, insert: "a" }]);
    assert.equal(netNoOp.buffer, unchanged); assert.equal(netNoOp.mapping.map(1).offset, 1);
    assert.equal(netNoOp.changedUnits, 0);
    const partial = unchanged.apply([{ from: 0, to: 1, insert: "a" }, { from: 1, to: 2, insert: "X" }]);
    assert.equal(partial.changedUnits, 2);
});

test("routine read counters are immutable snapshots independent of explicit retention diagnostics", () => {
    const buffer = TextBuffer.from("a😀\r\nb"), before = buffer.readMetrics();
    assert.deepEqual(before, { textExports: 0, sliceUnits: 0 }); assert.ok(Object.isFrozen(before));
    assert.equal(buffer.diagnostics().textExports, 0); assert.equal(buffer.diagnostics().sliceUnits, 0);
    assert.equal(buffer.slice(2, 2), ""); assert.throws(() => buffer.slice(-1, 1), RangeError);
    assert.equal([...buffer.chunks()].join(""), "a😀\r\nb"); buffer.lineAt(2); buffer.offsetAt(1);
    assert.deepEqual(buffer.readMetrics(), before);
    assert.equal(buffer.slice(1, 3), "😀"); buffer.text();
    assert.deepEqual(before, { textExports: 0, sliceUnits: 0 });
    assert.deepEqual(buffer.readMetrics(), { textExports: 1, sliceUnits: 2 });
    const next = buffer.replace(0, 0, "x");
    assert.deepEqual(next.readMetrics(), { textExports: 0, sliceUnits: 0 }); next.slice(0, 1);
    assert.deepEqual(next.readMetrics(), { textExports: 0, sliceUnits: 1 });
    assert.deepEqual(buffer.readMetrics(), { textExports: 1, sliceUnits: 2 });
    const diagnostic = buffer.diagnostics(); assert.equal(diagnostic.retention.versions, 1); assert.equal(diagnostic.textExports, 1);
    const empty = TextBuffer.from(""); empty.slice(0, 0); empty.text();
    assert.deepEqual(empty.readMetrics(), { textExports: 1, sliceUnits: 0 });
});

test("indexed line/range subscribers do not materialize the document and retained versions share backing text", () => {
    let buffer = TextBuffer.from(corpus("lines-100000")); const history = [buffer];
    for (let index = 0; index < 200; index++) {
        buffer = buffer.replace(index * 17, index * 17, "😀"); history.push(buffer);
        const offset = buffer.offsetAt(50_000);
        assert.equal(buffer.lineAt(offset), 50_000); assert.ok(buffer.slice(offset, offset + 24).length === 24);
    }
    assert.equal(buffer.diagnostics().textExports, 0);
    assert.ok(buffer.diagnostics().sliceUnits < 100);
    const retained = TextBuffer.retained(history);
    assert.equal(retained.versions, 201);
    // Each retained edit adds its insertion plus at most two 64-unit boundary pieces.
    assert.ok(retained.backingTextUnits >= 2_400_400 && retained.backingTextUnits <= 2_400_000 + 200 * (2 + 128));
    assert.ok(retained.nodes < 10_000);
    assert.equal(history[0]!.length, 2_400_000);
});

test("exact equality works across different structures and shared ranges without whole-text export", () => {
    const text = corpus("unicode"), original = TextBuffer.from(text), modified = original.replace(1, 3, "XY");
    const restored = modified.replace(1, 3, text.slice(1, 3));
    assert.equal(original.equals(modified), false); assert.equal(original.equals(restored), true);
    assert.equal(restored.equals(TextBuffer.from(text)), true);
    assert.equal(original.diagnostics().textExports, 0); assert.equal(restored.diagnostics().textExports, 0);
    assert.equal(TextBuffer.from("").equals(TextBuffer.from("")), true);
});

test("random replay preserves UTF-16, CRLF and all retained roots against a string oracle", () => {
    for (const id of corpusIds) {
        let text = corpus(id), buffer = TextBuffer.from(text);
        const history: { buffer: TextBuffer; text: string }[] = [];
        for (const [index, edit] of editLog(text.length, 200).entries()) {
            if (index % 29 === 0) history.push({ buffer, text });
            const result = buffer.apply([edit]); buffer = result.buffer; text = applyTextEdits(text, [edit]);
            assert.equal(buffer.length, text.length);
            assert.equal([...buffer.chunks(edit.from, Math.min(buffer.length, edit.from + 12))].join(""), text.slice(edit.from, edit.from + 12));
            if (index % 37 === 0) {
                assert.equal(buffer.text(), text); buffer.diagnostics();
                const lines = text.split("\n"), context = `${id}, edit ${index}: ${JSON.stringify(edit)}`;
                assert.equal(buffer.longestLineLength, lines.reduce((longest, line) => Math.max(longest, line.length), 0), context);
                assert.equal(buffer.lineCount, lines.length, context);
                for (const offset of [0, edit.from, Math.floor(text.length / 2), text.length]) {
                    assert.equal(buffer.lineAt(offset), text.slice(0, offset).split("\n").length - 1, context);
                }
                for (const line of [0, Math.floor(lines.length / 2), lines.length - 1]) {
                    const expected = lines.slice(0, line).reduce((offset, value) => offset + value.length + 1, 0);
                    assert.equal(buffer.offsetAt(line), expected, context);
                }
            }
        }
        assert.equal(buffer.text(), text); history.forEach(entry => assert.equal(entry.buffer.text(), entry.text));
    }
});

for (const text of ["", "\n", "\r\n", "a\r\nb\r\n", "\ud800x\udc00", "😀e\u0301\n👩‍💻"]) {
    test(`buffer validates ranges and line indexes without changing ${JSON.stringify(text)}`, () => {
        // A surviving suffix is a single leaf whose backing starts before the logical text.
        const prefix = "padding\r\n";
        for (const buffer of [TextBuffer.from(text), TextBuffer.from(prefix + text).replace(0, prefix.length, "")]) {
            assert.equal(buffer.replace(0, 0, ""), buffer);
            for (const [from, to] of [[-1, 0], [0, text.length + 1], [1.5, 2], [2, 1], [NaN, 0]] as const) {
                assert.throws(() => buffer.replace(from, to, "x"), RangeError);
                assert.throws(() => buffer.slice(from, to), RangeError);
                assert.throws(() => buffer.chunks(from, to), RangeError);
            }
            for (const value of [-1, 0.5, NaN, Infinity]) {
                assert.throws(() => buffer.lineAt(value), RangeError);
                assert.throws(() => buffer.offsetAt(value), RangeError);
            }
            assert.throws(() => buffer.lineAt(text.length + 1), RangeError);
            assert.throws(() => buffer.offsetAt(buffer.lineCount), RangeError);
            for (let from = 0; from <= text.length; from++) for (let to = from; to <= text.length; to++) {
                assert.equal(buffer.slice(from, to), text.slice(from, to));
            }
            assert.equal(buffer.text(), text);
            assert.equal(buffer.lineAt(0), 0); assert.equal(buffer.offsetAt(0), 0);
            assert.equal(buffer.lineAt(text.length), text.split("\n").length - 1);
            assert.equal(buffer.offsetAt(buffer.lineCount - 1), text.lastIndexOf("\n") + 1);
        }
    });
}

test("buffer trees stay balanced under alternating end edits, deletes and retained history", () => {
    let buffer = TextBuffer.from("x".repeat(100_000));
    const history: { buffer: TextBuffer; text: string }[] = [];
    for (let index = 0; index < 1_000; index++) {
        const offset = index % 2 ? 0 : buffer.length;
        buffer = buffer.replace(offset, offset, `${index}\n`);
        if (index % 50 === 0) history.push({ buffer, text: buffer.text() });
    }
    for (let index = 0; index < 100; index++) buffer = buffer.replace(0, Math.min(17, buffer.length), "");
    const shape = buffer.diagnostics(), retained = TextBuffer.retained(history.map(entry => entry.buffer));
    assert.ok(shape.height <= 2 * Math.log2(shape.retention.nodes + 1));
    assert.ok(retained.backingTextUnits < buffer.length * history.length);
    history.forEach(entry => assert.equal(entry.buffer.text(), entry.text));
});

test("sequential single edits bound fragments while retaining large backings and exact earlier roots", () => {
    const text = "source\r\n😀x\ud800\n".repeat(4000), original = TextBuffer.from(text), units = ["a", "\r", "\n", "\ud83d", "\ude00", "\ud800", "\udc00"];
    for (const [from, reverse] of [[0, false], [text.length / 2, false], [text.length, false], [text.length / 2, true]] as const) {
        let buffer = original; const inserted: string[] = [], retained: { buffer: TextBuffer; text: string }[] = [{ buffer, text }];
        for (let index = 0; index < 4096; index++) {
            const unit = units[index % units.length]!, at = from + (reverse ? 0 : index);
            buffer = buffer.replace(at, at, unit); inserted.push(unit);
            if (index % 1024 === 1023) retained.push({ buffer, text: text.slice(0, from) + (reverse ? [...inserted].reverse() : inserted).join("") + text.slice(from) });
        }
        const shape = buffer.diagnostics(), live = TextBuffer.retained([original, buffer]);
        assert.ok(shape.retention.nodes < 256, `One-character edits retained ${shape.retention.nodes} nodes.`);
        assert.ok([...buffer.chunks(from + 1000, from + 1200)].length < 8, "A short read must not visit one piece per typed unit.");
        assert.ok(live.backingTextUnits <= text.length + inserted.length + 128, "Coalescing must not copy large unchanged ranges.");
        for (const entry of retained) {
            assert.equal(entry.buffer.slice(0, entry.buffer.length), entry.text); assert.equal(entry.buffer.lineCount, entry.text.split("\n").length);
            assert.equal(entry.buffer.readMetrics().textExports, 0); entry.buffer.diagnostics();
        }
        // Deleting the inserted run restores exact raw text without changing any retained version.
        const deleted = buffer.replace(from, from + inserted.length, ""); assert.equal(deleted.slice(0, deleted.length), text);
        assert.equal(buffer.slice(from, from + inserted.length), (reverse ? [...inserted].reverse() : inserted).join(""));
    }
});

test("longest line indexing survives splits, joined lines, CRLF, empty lines and retained roots", () => {
    for (const text of ["", "\n", "abc\r\nlonger\n", "x".repeat(100_000), "a\n".repeat(10_000)]) {
        const original = TextBuffer.from(text);
        let buffer = original, oracle = text;
        for (const edit of [{ from: 0, to: 0, insert: "long\nline" }, { from: 0, to: 5, insert: "" }, { from: 0, to: 0, insert: "😀" }]) {
            buffer = buffer.apply([edit]).buffer; oracle = applyTextEdits(oracle, [edit]);
            assert.equal(buffer.longestLineLength, oracle.split("\n").reduce((longest, line) => Math.max(longest, line.length), 0));
        }
        assert.equal(original.longestLineLength, text.split("\n").reduce((longest, line) => Math.max(longest, line.length), 0));
        assert.equal(buffer.diagnostics().textExports, 0);
    }
});

test("large line indexes remain exact across split backings and retained versions", () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => `${index % 127 === 0 ? "👩‍💻e\u0301" : "row"}${index}${index % 3 === 0 ? "\r" : ""}`);
    const text = rows.join("\n"), original = TextBuffer.from(text), versions = [original];
    const boundaries = [0, 1, 65_535, 65_536, 99_999, 100_000];
    let buffer = original, expected = text;
    for (const row of boundaries) {
        const from = buffer.offsetAt(row), edit = { from, to: from, insert: "prefix\r\n😀\n" };
        buffer = buffer.apply([edit]).buffer; expected = applyTextEdits(expected, [edit]); versions.push(buffer);
        const lines = expected.split("\n"); let offset = 0, longest = 0;
        for (let line = 0; line < lines.length; line++) {
            assert.equal(buffer.offsetAt(line), offset);
            assert.equal(buffer.lineAt(offset), line);
            if (lines[line]!.length) assert.equal(buffer.lineAt(offset + lines[line]!.length - 1), line);
            if (line + 1 < lines.length) assert.equal(buffer.lineAt(offset + lines[line]!.length), line);
            longest = Math.max(longest, lines[line]!.length); offset += lines[line]!.length + 1;
        }
        assert.equal(buffer.offsetAt(lines.length - 1) + lines.at(-1)!.length, expected.length);
        assert.equal(buffer.longestLineLength, longest); assert.equal(buffer.lineCount, lines.length);
        assert.equal([...buffer.chunks()].join(""), expected); assert.ok(Object.isFrozen(buffer));
    }
    assert.equal([...original.chunks()].join(""), text);
    assert.equal(original.lineCount, rows.length); assert.equal(original.offsetAt(99_999), text.lastIndexOf("\n") + 1);
    for (const version of versions) assert.equal(version.readMetrics().textExports, 0);
});

test("multi-range batches preserve the string oracle and map untouched original boundaries", () => {
    let text = "a😀\r\ne\u0301👩‍💻\ud800".repeat(50), buffer = TextBuffer.from(text), seed = 0x5eeda11;
    const random = (maximum: number): number => { seed = nextSeed(seed); return seed % maximum; };
    for (let step = 0; step < 300; step++) {
        const edits = [], inserts = ["", "\r\n", "😀", "e\u0301", "👩‍💻", "\ud800"];
        let cursor = 0;
        for (let index = 0; index < 5 && cursor < text.length; index++) {
            const from = cursor + random(Math.max(1, Math.floor((text.length - cursor) / 2)));
            const to = Math.min(text.length, from + random(5));
            edits.push({ from, to, insert: inserts[random(inserts.length)]! }); cursor = to + 1;
        }
        const before = buffer, result = buffer.apply(edits), expected = applyTextEdits(text, edits);
        assert.equal(result.buffer.text(), expected); assert.equal(before.text(), text);
        assert.equal(result.mapping.newLength, expected.length);
        for (let offset = 0; offset < text.length; offset += 7) {
            if (edits.some(edit => offset >= edit.from && offset <= edit.to)) continue;
            const mapped = result.mapping.map(offset);
            assert.equal(expected.charCodeAt(mapped.offset), text.charCodeAt(offset));
            assert.equal(result.mapping.invert().map(mapped.offset).offset, offset);
        }
        buffer = result.buffer; text = expected;
    }
    assert.throws(() => validateTextEdits(-1, []), RangeError);
    assert.throws(() => validateTextEdits(Number.NaN, []), RangeError);
});

test("packed batches preserve raw seams, duplicate insertion order and exact mappings across backing boundaries", () => {
    const text = "x".repeat(70_000) + "\r\n😀é👩‍💻\ud800\t", before = TextBuffer.from(text);
    const edits = [{ from: 0, to: 0, insert: "\ud83d" }, { from: 0, to: 0, insert: "\ude00" },
        { from: 1, to: 2, insert: "\n".repeat(65_536) }, { from: 2, to: 3, insert: "\r" + "Z".repeat(65_537) },
        { from: 60_000, to: 60_001, insert: "é".repeat(64) }, { from: 70_000, to: 70_000, insert: "👩‍💻" }, { from: text.length - 1, to: text.length, insert: "" }];
    const result = before.apply(edits), expected = applyTextEdits(text, edits), mapping = new PositionMap(text.length, edits);
    assert.equal([...result.buffer.chunks()].join(""), expected); assert.equal([...before.chunks()].join(""), text);
    assert.equal(result.buffer.lineCount, expected.split("\n").length);
    assert.equal(result.buffer.longestLineLength, Math.max(...expected.split("\n").map(line => line.length)));
    for (const offset of [0, 1, 2, 3, 60_000, 60_001, 70_000, text.length - 1, text.length]) for (const side of ["before", "after"] as const) assert.deepEqual(result.mapping.map(offset, side), mapping.map(offset, side));
    for (const from of [0, 1, 65_534, 65_536, 65_538, 131_070, expected.length - 8]) {
        const to = Math.min(expected.length, from + 13); assert.equal([...result.buffer.chunks(from, to)].join(""), expected.slice(from, to));
        assert.equal(result.buffer.lineAt(from), expected.slice(0, from).split("\n").length - 1);
    }
    TextBuffer.retained([before, result.buffer]); assert.equal(result.buffer.readMetrics().textExports, 0);
    const empty = TextBuffer.from("").apply([{ from: 0, to: 0, insert: "\r" }, { from: 0, to: 0, insert: "\n😀" }]).buffer;
    assert.equal([...empty.chunks()].join(""), "\r\n😀"); assert.equal(empty.offsetAt(1), 2);
});

test("dense batches bound fragmentation while sparse batches share large unchanged backing ranges", () => {
    const line = "const sample = 1234567;\n", lines = 100_000, before = TextBuffer.from(line.repeat(lines));
    const edits = Array.from({ length: lines }, (_, index) => ({ from: index * line.length, to: index * line.length + 5, insert: "let" }));
    const changed = before.apply(edits).buffer, expected = "let sample = 1234567;\n".repeat(lines); let offset = 0, chunks = 0;
    for (const value of changed.chunks()) { assert.ok(value.length <= 65_536); assert.equal(value, expected.slice(offset, offset + value.length)); offset += value.length; chunks++; }
    assert.equal(offset, expected.length); assert.ok(chunks < 128);
    const retained = TextBuffer.retained([before, changed]); assert.ok(retained.nodes < 256); assert.ok(retained.backingBuffers < 128);
    const sparse = before.apply([{ from: 1, to: 2, insert: "!" }, { from: before.length - 2, to: before.length - 1, insert: "!" }]).buffer;
    assert.ok(TextBuffer.retained([before, sparse]).backingTextUnits <= before.length + 128);
    assert.equal(sparse.slice(100, 200), before.slice(100, 200)); assert.equal(before.readMetrics().textExports, 0); assert.equal(changed.readMetrics().textExports, 0);
    let fragmented = before;
    for (let index = 0; index < 512; index++) fragmented = fragmented.replace(index * 100, index * 100, "z");
    const oldNodes = fragmented.diagnostics().retention.nodes;
    const shared = fragmented.apply([{ from: 1, to: 2, insert: "!" }, { from: fragmented.length - 2, to: fragmented.length - 1, insert: "!" }]).buffer;
    assert.ok(TextBuffer.retained([fragmented, shared]).nodes < oldNodes * 1.1 + 128, "Sparse batches must retain untouched subtrees instead of rebuilding the source tree.");
    const cancellation = TextBuffer.from("ab");
    const noOp = cancellation.apply([{ from: 0, to: 1, insert: "" }, { from: 1, to: 1, insert: "a" }]);
    assert.equal(noOp.buffer, cancellation); assert.equal(noOp.changedUnits, 0); assert.deepEqual(noOp.mapping.map(1), { offset: 1, deleted: false });
});
