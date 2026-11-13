import assert from "node:assert/strict";
import test from "node:test";
import { TextBuffer, createSelectionSet, parseSnippet, planSnippetEdit } from "../src/index.ts";

test("snippets expand forward mirrors, literal defaults, escaped choices and numeric/final stops", () => {
    const result = parseSnippet('$2 ${1:😀name} = ${2|one\\,two,three\\|four|}; $1$0');
    assert.ok(result.snippet); const { text, stops } = result.snippet;
    assert.equal(text, 'one,two 😀name = one,two; 😀name');
    assert.deepEqual(stops.map(stop => stop.index), [1, 2, 0]);
    assert.deepEqual(stops[1]!.choices, ['one,two', 'three|four']);
    assert.deepEqual(stops[0]!.ranges.map(range => text.slice(range.from, range.to)), ['😀name', '😀name']);
    assert.equal(stops[2]!.ranges[0]!.from, text.length);
    assert.equal(parseSnippet('\\$ \\} \\\\ ${1:literal \\$}').snippet?.text, '$ } \\ literal $');
    assert.ok(Object.isFrozen(stops[0]!.ranges[0]));
});

test("unsupported snippet constructs have reasons and expansion is checked before allocating mirrors", () => {
    for (const source of ['$TM_FILENAME', '${1:a${2:b}}', '${1/a/b/}', '${1|a,b', '${1:a}${1:b}']) assert.equal(typeof parseSnippet(source).reason, 'string');
    assert.match(parseSnippet('${1:abcd}$1$1', 8).reason!, /insertion limit/);
    assert.equal(parseSnippet('$1$0').snippet?.text, '');
});

test("ordinary edits update mirrors and following stops in one atomic plan", () => {
    const snippet = parseSnippet('${1:hello} + $1 = ${2|yes,no|}$0').snippet!, buffer = TextBuffer.from(snippet.text);
    const before = createSelectionSet(buffer.length, [{ anchor: 1, head: 4 }]);
    const changed = planSnippetEdit(buffer, snippet.stops, 0, [{ from: 1, to: 4, insert: '😀' }], before,
        createSelectionSet(buffer.length - 1, [{ anchor: 3, head: 3 }]))!;
    assert.ok(changed); const next = buffer.apply(changed.edits).buffer;
    assert.equal(next.text(), 'h😀o + h😀o = yes');
    assert.deepEqual(changed.selectionSet.ranges.map(range => range.head), [3, 10]);
    assert.equal(next.slice(changed.stops[1]!.ranges[0]!.from, changed.stops[1]!.ranges[0]!.to), 'yes');
    assert.equal(planSnippetEdit(buffer, snippet.stops, 0, [{ from: 0, to: buffer.length, insert: 'outside' }], before,
        createSelectionSet(7, [{ anchor: 7, head: 7 }])), undefined);
});

test("coincident empty and adjacent mirrored stops stay distinct after typing and deletion", () => {
    const snippet = parseSnippet('$1$1${2:x}$0').snippet!, buffer = TextBuffer.from(snippet.text);
    const changed = planSnippetEdit(buffer, snippet.stops, 0, [{ from: 0, to: 0, insert: 'a' }],
        createSelectionSet(1, [{ anchor: 0, head: 0 }]), createSelectionSet(2, [{ anchor: 1, head: 1 }]))!;
    assert.equal(buffer.apply(changed.edits).buffer.text(), 'aax');
    assert.deepEqual(changed.stops[0]!.ranges.map(({ from, to }) => [from, to]), [[0, 1], [1, 2]]);
    assert.equal(changed.stops[1]!.ranges[0]!.from, 2);
    const next = buffer.apply(changed.edits).buffer;
    const removed = planSnippetEdit(next, changed.stops, 0, [{ from: 0, to: 1, insert: '' }, { from: 1, to: 2, insert: '' }],
        changed.selectionSet, createSelectionSet(1, [{ anchor: 0, head: 0 }]))!;
    assert.equal(next.apply(removed.edits).buffer.text(), 'x');
    assert.deepEqual(removed.stops[0]!.ranges.map(({ from, to }) => [from, to]), [[0, 0], [0, 0]]);
});
