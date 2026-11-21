import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer, createSelectionSet, resolveLanguageConfiguration, planLanguageEdit, Workspace } from "../src/index.ts";
import type { LanguageConfiguration, LanguageEditProgress, Selection } from "../src/index.ts";

const configuration: LanguageConfiguration = { tabSize: 2, lineComment: "//", blockComment: { open: "/*", close: "*/" }, enter: "keep",
    pairs: [{ open: "{", close: "}" }, { open: '"', close: '"' }] };
function plan(text: string, ranges: readonly Selection[], command: Parameters<typeof planLanguageEdit>[2], config = configuration) {
    const buffer = TextBuffer.from(text), selections = createSelectionSet(text.length, ranges, ranges.length - 1);
    const iterator = planLanguageEdit(buffer, selections, command, resolveLanguageConfiguration(config));
    let step = iterator.next(256), turns = 1;
    while (step.status === "running") { turns++; step = iterator.next(256); }
    assert.equal(step.status, "ready");
    const value = step.result!; iterator.dispose();
    const after = buffer.apply(value.edits).buffer;
    assert.equal(buffer.readMetrics().textExports, 0);
    assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.edits));
    return { value, turns, text: after.slice(0, after.length), ranges: value.selectionSet.ranges.map(range => [range.anchor, range.head]) };
}
const selection = (anchor: number, head = anchor) => [{ anchor, head }];

test("Tab advances each inline range to a stop and indents complete lines in the same transaction", () => {
    const config: LanguageConfiguration = { tabSize: 4, enter: () => ({ indent: 1 }) };
    const mixed = plan("a\tbcd\nx\n", [{ anchor: 3, head: 2 }, { anchor: 4, head: 5 }, { anchor: 6, head: 7 }], "indent", config);
    assert.equal(mixed.text, "a\t    c  \n    x\n"); assert.deepEqual(mixed.ranges, [[6, 6], [9, 9], [14, 15]]);
    const blank = plan("  {\r\n  ", selection(6), "indent", config);
    assert.equal(blank.text, "  {\r\n      "); assert.deepEqual(blank.ranges, [[11, 11]]);
    assert.equal(plan(blank.text, selection(11), "indent", config).text, blank.text + "  ");
    assert.equal(plan(" \t{\n ", selection(5), "indent", { ...config, insertSpaces: false }).text, " \t{\n \t\t");
    assert.equal(plan("ab", selection(0, 1), "indent", { insertSpaces: false }).text, "\tb");
});

test("configured line indentation and comments preserve reversed selections, blank lines and end-at-next-line", () => {
    const text = "  one\n\ttwo\n\nlast";
    const indented = plan(text, selection(11, 0), "indent");
    assert.equal(indented.text, "    one\n  \ttwo\n\nlast"); assert.deepEqual(indented.ranges, [[15, 2]]);
    assert.equal(plan(indented.text, indented.value.selectionSet.ranges, "outdent").text, text);
    const commented = plan(text, selection(0, 12), "line-comment");
    assert.equal(commented.text, "  // one\n\t// two\n\nlast");
    assert.equal(plan(commented.text, commented.value.selectionSet.ranges, "line-comment").text, text);
    assert.equal(plan("// first\nsecond", selection(0, 15), "line-comment").text, "// // first\n// second");
    assert.equal(plan("", selection(0), "line-comment").text, "// ");
    assert.equal(plan("\tx", selection(0, 2), "indent", { tabSize: 4, insertSpaces: false }).text, "\t\tx");
    const directed = [{ anchor: 5, head: 2, anchorAffinity: "before", headAffinity: "before" },
        { anchor: 6, head: 9, anchorAffinity: "before", headAffinity: "before" }] as const;
    const multiple = plan("  one\ntwo", directed, "line-comment");
    assert.deepEqual(multiple.ranges, [[8, 5], [12, 15]]);
    assert.ok(multiple.value.selectionSet.ranges.every(range => range.anchorAffinity === "before" && range.headAffinity === "before"));
    // Raw public input defaults affinities after mapping, including a collapsed reversed range.
    const raw = planLanguageEdit(TextBuffer.from("  x"), { ranges: [{ anchor: 2, head: 0 }], primary: 0 }, "outdent", resolveLanguageConfiguration(configuration));
    const result = raw.next(); raw.dispose();
    assert.equal(result.status, "ready");
    assert.deepEqual(result.result!.selectionSet.ranges, [{ anchor: 0, head: 0, anchorAffinity: "after", headAffinity: "after" }]);
});

test("moving and copying line blocks retains directed selections, mixed endings and final-line boundaries", () => {
    const source = "aa\r\nb\ncc", reversed = selection(6, 4);
    for (const [command, text, anchor, head] of [
        ["move-line-up", "b\r\naa\ncc", 3, 0], ["move-line-down", "aa\r\ncc\nb", 8, 7],
        ["copy-line-up", "aa\r\nb\nb\ncc", 6, 4], ["copy-line-down", "aa\r\nb\nb\ncc", 8, 6],
    ] as const) {
        const shifted = plan(source, reversed, command);
        assert.equal(shifted.text, text); assert.deepEqual(shifted.ranges, [[anchor, head]]);
    }
    const adjacent = plan("a\nb\nc", [{ anchor: 2, head: 2 }, { anchor: 4, head: 4 }], "move-line-up");
    assert.equal(adjacent.text, "b\nc\na"); assert.deepEqual(adjacent.ranges, [[0, 0], [2, 2]]);
    const buffer = TextBuffer.from("a\n" + "b\n".repeat(100_000) + "c");
    const cursor = planLanguageEdit(buffer, createSelectionSet(buffer.length, selection(2, buffer.length - 1)), "move-line-up", resolveLanguageConfiguration());
    const result = cursor.next(256); cursor.dispose();
    assert.equal(result.status, "ready"); assert.equal(result.result!.edits.length, 2); assert.ok(result.readUnits < 10);
});

test("block comments and pair surrounds retain directed and adjacent selections without copying selected text", () => {
    const selected = [{ anchor: 2, head: 0 }, { anchor: 2, head: 4 }];
    const comment = plan("abcd", selected, "block-comment");
    assert.equal(comment.text, "/*ab*//*cd*/"); assert.deepEqual(comment.ranges, [[4, 2], [8, 10]]);
    assert.equal(plan(comment.text, comment.value.selectionSet.ranges, "block-comment").text, "abcd");
    const pair = plan("abcd", selected, { character: '"' });
    assert.equal(pair.text, '"ab""cd"'); assert.deepEqual(pair.ranges, [[3, 1], [5, 7]]);
    assert.equal(plan("/*ab*/", selection(6, 0), "block-comment").text, "ab");
    assert.deepEqual(plan("", selection(0), "block-comment").ranges, [[2, 2]]);
});

test("host pairing and Enter rules see exact buffers and can reject string/comment contexts", () => {
    const config: LanguageConfiguration = { ...configuration, allowPair: context => context.buffer.slice(0, Math.min(2, context.buffer.length)) !== "//",
        enter: ({ buffer, from, to }) => ({ indent: buffer.slice(from - 1, from) === "{" ? 1 : 0, split: buffer.slice(to, to + 1) === "}" }) };
    assert.equal(plan("// ", selection(3), { character: '"' }, config).text, '// "');
    const pair = plan("", selection(0), { character: '"' }, config);
    assert.equal(pair.text, '""'); assert.deepEqual(pair.ranges, [[1, 1]]);
    assert.equal(plan(pair.text, pair.value.selectionSet.ranges, { character: '"' }, config).text, '"""');
    const skip = plan(pair.text, pair.value.selectionSet.ranges, { character: '"', canOvertype: at => at === 1 }, config);
    assert.equal(skip.text, '""'); assert.equal(skip.value.edits.length, 0); assert.deepEqual(skip.ranges, [[2, 2]]);
    const enter = plan("  {}", selection(3), "newline", config);
    assert.equal(enter.text, "  {\n    \n  }"); assert.deepEqual(enter.ranges, [[8, 8]]);
});

test("newline commands inherit the current or preceding LF/CRLF terminator without normalizing source", () => {
    for (const [text, at, expected, head] of [
        ["a\r\nb\r\n", 1, "a\r\n\r\nb\r\n", 3],
        ["a\r\nb", 4, "a\r\nb\r\n", 6],
        ["a\r\n", 3, "a\r\n\r\n", 5],
        ["a\nb\r\nc", 3, "a\nb\r\n\r\nc", 5],
        ["a\r\nb\nc", 4, "a\r\nb\n\nc", 5],
        ["a\rb", 3, "a\rb\n", 4],
        ["", 0, "\n", 1],
    ] as const) {
        const result = plan(text, selection(at), "newline");
        assert.equal(result.text, expected); assert.deepEqual(result.ranges, [[head, head]]);
    }
    const config: LanguageConfiguration = { tabSize: 4, enter: () => ({ indent: 1, split: true }) };
    const split = plan("  {}\r\nnext", selection(3), "newline", config);
    assert.equal(split.text, "  {\r\n      \r\n  }\r\nnext"); assert.deepEqual(split.ranges, [[11, 11]]);
    const selected = plan("one\r\ntwo\nlast", selection(8, 1), "newline", {});
    assert.equal(selected.text, "o\r\n\nlast"); assert.deepEqual(selected.ranges, [[3, 3]]);
    const multiple = plan("a\r\nb\nc", [{ anchor: 1, head: 1 }, { anchor: 4, head: 4 }, { anchor: 6, head: 6 }], "newline");
    assert.equal(multiple.text, "a\r\n\r\nb\n\nc\n"); assert.deepEqual(multiple.ranges, [[3, 3], [7, 7], [10, 10]]);
});

test("a first-on-line closer copies its matching opener's indentation in the same edit", () => {
    const source = "\tif (ok) {\r\n\t  [\r\n\t      ";
    const config: LanguageConfiguration = { allowPair: ({ buffer, from, to }) => {
        assert.equal(buffer.length, source.length); assert.ok(from <= to && to <= buffer.length); return true;
    } };
    const close = plan(source, selection(source.length), { character: "]" }, config);
    assert.equal(close.text, "\tif (ok) {\r\n\t  [\r\n\t  ]");
    assert.deepEqual(close.ranges, [[close.text.length, close.text.length]]);
    assert.equal(plan(source, selection(source.length), { character: "}" }, config).text, source + "}");
    assert.equal(plan(source, selection(source.length), { character: "]" }, { allowPair: () => false }).text, source + "]");
    const tracked = plan("  {\n      }", selection(10), { character: "}", canOvertype: () => true }, {});
    assert.equal(tracked.text, "  {\n  }"); assert.deepEqual(tracked.ranges, [[7, 7]]);
});

test("outdent removes one visual indentation unit even when spaces precede tabs", () => {
    for (const insertSpaces of [true, false]) for (const [prefix, expected] of [
        ["  \t", ""], [" \t\t", "\t"], ["\t  \t", "  \t"], ["     \t", " \t"], ["  ", ""], ["      ", "  "], ["", ""],
    ]) {
        const config: LanguageConfiguration = { tabSize: 4, insertSpaces, enter: () => ({ indent: -1 }) };
        const source = prefix + "foo", result = plan(source, selection(source.length, 0), "outdent", config);
        assert.equal(result.text, expected + "foo"); assert.deepEqual(result.ranges, [[expected!.length + 3, 0]]);
        assert.equal(plan(prefix + "x\r\n", selection(prefix!.length), "newline", config).text, prefix + "\r\n" + expected + "x\r\n");
    }
});

test("large comments and whitespace yield without partial edits and form one shared undo transaction", () => {
    const text = "x\n".repeat(2048), result = plan(text, selection(0, text.length), "line-comment");
    assert.ok(result.turns > 8); assert.equal(result.text, "// x\n".repeat(2048));
    const spaces = plan(" ".repeat(20000) + "x", selection(20000), "newline");
    assert.ok(spaces.turns > 4); assert.equal(spaces.text, " ".repeat(20000) + "\n" + " ".repeat(20000) + "x");
    const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "comments", variant: "working" }, "Comments", { value: text });
    const view = workspace.createDocumentView(resource.documentId); view.setSelection(0, { anchor: 0, head: text.length });
    assert.equal(workspace.edit({ documentId: resource.documentId, expectedRevision: 0, origin: "human", view, ...result.value, history: { kind: "replace" } }).applied, true);
    assert.equal(workspace.observeHistory(resource.documentId).getSnapshot().undoDepth, 1);
    assert.equal(workspace.undo({ documentId: resource.documentId, expectedRevision: 1 }).applied, true);
    assert.equal(workspace.document(resource.documentId).text(), text);
    view.dispose(); workspace.releaseResource(resource.id, true);
});

test("language cursor charges reads, blank comment records and final assembly without publishing partial plans", () => {
    for (const [text, command, expected] of [
        ["x\n" + "\n".repeat(4096), "line-comment", "// x\n" + "\n".repeat(4096)],
        [" ".repeat(20000), "newline", " ".repeat(20000) + "\n" + " ".repeat(20000)],
    ] as const) {
        const buffer = TextBuffer.from(text), selections = createSelectionSet(text.length,
            [{ anchor: command === "newline" ? text.length : 0, head: text.length }]);
        const cursor = planLanguageEdit(buffer, selections, command, resolveLanguageConfiguration(configuration));
        let previous = cursor.snapshot(), planningWithoutReads = 0;
        assert.equal(previous.phase, "validate"); assert.equal(previous.workUnits, 0);
        assert.deepEqual(buffer.readMetrics(), { textExports: 0, sliceUnits: 0 });
        const phases = new Set<LanguageEditProgress["phase"]>([previous.phase]);
        while (previous.status === "running") {
            const current = cursor.next(256); phases.add(current.phase);
            assert.ok(Object.isFrozen(current)); assert.equal(current.readUnits, buffer.readMetrics().sliceUnits);
            assert.ok(current.workUnits >= previous.workUnits); assert.ok(current.bulkWorkUnits >= previous.bulkWorkUnits);
            // These fixtures have bounded scan/record steps; bulk assembly is deliberately separate.
            assert.ok(current.workUnits - previous.workUnits - (current.bulkWorkUnits - previous.bulkWorkUnits) <= 256 + 4096 + 8);
            if (current.status === "running") assert.equal(current.result, null);
            if (current.phase === "plan" && previous.phase === "plan" && current.readUnits === previous.readUnits
                && current.bulkWorkUnits === previous.bulkWorkUnits && current.workUnits > previous.workUnits) planningWithoutReads++;
            previous = current;
        }
        assert.equal(previous.status, "ready"); assert.ok(phases.has("plan")); assert.ok(phases.has("publish"));
        assert.equal(buffer.apply(previous.result!.edits).buffer.text(), expected);
        if (command === "line-comment") assert.ok(planningWithoutReads >= 10, "Skipped blank records still yield charged work");
        else assert.ok(previous.bulkWorkUnits >= 40000, "Long indentation read and output remain visible bulk work");
        assert.ok(previous.result!.edits.every(Object.isFrozen));
        cursor.dispose(); assert.equal(cursor.snapshot().result, null);
        assert.equal(previous.result!.edits.length, 1, "A returned immutable plan survives cursor disposal");
    }
});

test("language cursor releases cancelled planning and records validation or host callback failure", () => {
    const buffer = TextBuffer.from("x\n".repeat(2048)), selections = createSelectionSet(buffer.length, [{ anchor: 0, head: buffer.length }]);
    for (const advance of [false, true]) {
        const cursor = planLanguageEdit(buffer, selections, "line-comment", resolveLanguageConfiguration(configuration));
        if (advance) assert.equal(cursor.next(256).status, "running");
        const before = buffer.readMetrics(); cursor.dispose();
        assert.equal(cursor.next().status, "disposed"); assert.equal(cursor.snapshot().result, null);
        assert.deepEqual(buffer.readMetrics(), before);
    }
    const invalid = planLanguageEdit(buffer, { ranges: [{ anchor: 4, head: 4 }, { anchor: 0, head: 0 }], primary: 0 }, "indent", resolveLanguageConfiguration());
    assert.equal(invalid.snapshot().status, "running");
    assert.throws(() => invalid.next(), /normalized range order/);
    assert.equal(invalid.snapshot().status, "failed"); assert.match(invalid.snapshot().failure!, /normalized range order/); invalid.dispose();
    const failure = new Error("host rule failed");
    const cursor = planLanguageEdit(buffer, createSelectionSet(buffer.length, [{ anchor: 0, head: 0 }]), "newline",
        resolveLanguageConfiguration({ enter: () => { assert.throws(() => cursor.dispose(), /busy/); throw failure; } }));
    assert.throws(() => cursor.next(), error => error === failure);
    assert.equal(cursor.snapshot().status, "failed"); assert.equal(cursor.snapshot().failure, failure.message);
    assert.equal(cursor.snapshot().result, null); cursor.dispose();
});
