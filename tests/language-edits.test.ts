import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer, createSelectionSet, resolveLanguageConfiguration, planLanguageEdit, Workspace } from "../src/index.ts";
import type { EditingCommand, LanguageConfiguration, Selection } from "../src/index.ts";

const configuration: LanguageConfiguration = { tabSize: 2, lineComment: "//", blockComment: { open: "/*", close: "*/" }, enter: "keep",
    pairs: [{ open: "{", close: "}" }, { open: '"', close: '"' }] };
function plan(text: string, ranges: readonly Selection[], command: EditingCommand | { character: string }, config = configuration) {
    const buffer = TextBuffer.from(text), selections = createSelectionSet(text.length, ranges, ranges.length - 1);
    const iterator = planLanguageEdit(buffer, selections, command, resolveLanguageConfiguration(config));
    let step = iterator.next(), turns = 1;
    while (!step.done) { turns++; step = iterator.next(); }
    const value = step.value, after = buffer.apply(value.edits).buffer;
    assert.equal(buffer.readMetrics().textExports, 0);
    assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.edits));
    return { value, turns, text: after.slice(0, after.length), ranges: value.selectionSet.ranges.map(range => [range.anchor, range.head]) };
}
const selection = (anchor: number, head = anchor) => [{ anchor, head }];

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
    const raw = planLanguageEdit(TextBuffer.from("  x"), { ranges: [{ anchor: 2, head: 0 }], primary: 0 }, "outdent", resolveLanguageConfiguration(configuration)).next();
    assert.equal(raw.done, true);
    assert.deepEqual(raw.value!.selectionSet.ranges, [{ anchor: 0, head: 0, anchorAffinity: "after", headAffinity: "after" }]);
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
    const skip = plan(pair.text, pair.value.selectionSet.ranges, { character: '"' }, config);
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
