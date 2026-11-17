import assert from "node:assert/strict";
import test from "node:test";
import { TextBuffer, createSelectionSet, parseSnippet, offsetSnippetStops, planSnippetEdit, planSnippetChoice, snippetChoiceText, planSelectionEdits, planLanguageEdit, resolveLanguageConfiguration } from "../src/index.ts";
import type { SnippetStop } from "../src/index.ts";

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
    for (const insertion of [undefined, { columns: 4, tabSize: 4, insertSpaces: true, lineEnding: "\n" as const }]) {
    const raw = parseSnippet('$1$1${2:x}$0').snippet!, snippet = { ...raw, stops: insertion ? raw.stops.map(stop => ({ ...stop, ranges: stop.ranges.map(range => ({ ...range, insertion })) })) : raw.stops }, buffer = TextBuffer.from(snippet.text);
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
    }
});

function contextual(values: readonly string[], choices: readonly string[] = []) {
    let text = "";
    const first: SnippetStop["ranges"][number][] = [], second: SnippetStop["ranges"][number][] = [];
    values.forEach((value, group) => {
        const columns = group ? 4 : 8, insertion = Object.freeze({ columns, tabSize: 4, insertSpaces: true, lineEnding: value.includes("\r\n") ? "\r\n" as const : "\n" as const });
        text += " ".repeat(columns); const from = text.length; text += value;
        first.push(Object.freeze({ from, to: text.length, order: group * 2, insertion, group })); text += "|";
        second.push(Object.freeze({ from: text.length, to: text.length + 4, order: group * 2 + 1, insertion, group })); text += "next\n";
    });
    const stops: readonly SnippetStop[] = Object.freeze([{ index: 1, choices, ranges: first }, { index: 2, choices: [], ranges: second },
        { index: 0, choices: [], ranges: [{ from: text.length, to: text.length, order: values.length * 2 }] }]);
    return { buffer: TextBuffer.from(text), stops };
}

test("contextual mirrors map body edits across different lengths, then keep multiline paste literal", () => {
    const { buffer, stops } = contextual(["one😀\r\n        two", "one😀\n    two"]), at = stops[0]!.ranges[0]!.to - 2;
    const edited = planSnippetEdit(buffer, stops, 0, [{ from: at, to: at + 1, insert: "XY" }], createSelectionSet(buffer.length, [{ anchor: at, head: at + 1 }]),
        createSelectionSet(buffer.length + 1, [{ anchor: at + 2, head: at + 2 }]))!;
    assert.ok(edited); const next = buffer.apply(edited.edits).buffer;
    assert.equal(next.text(), buffer.text().replaceAll("two", "tXYo"));
    assert.deepEqual(edited.selectionSet.ranges.map(range => next.slice(range.head - 2, range.head)), ["XY", "XY"]);
    assert.deepEqual(edited.stops[1]!.ranges.map(range => next.slice(range.from, range.to)), ["next", "next"]);
    const selected = createSelectionSet(next.length, edited.stops[0]!.ranges.map(range => ({ anchor: range.from, head: range.to })), 1);
    const pasted = planSelectionEdits(next.length, selected, "raw\n\tliteral"), mirrored = planSnippetEdit(next, edited.stops, 0, pasted.edits, selected, pasted.selectionSet)!;
    assert.ok(mirrored); const result = next.apply(mirrored.edits).buffer;
    assert.equal(mirrored.selectionSet.primary, 1);
    assert.deepEqual(mirrored.stops[0]!.ranges.map(range => result.slice(range.from, range.to)), ["raw\n\tliteral", "raw\n\tliteral"]);
    assert.deepEqual(mirrored.stops[1]!.ranges.map(range => result.slice(range.from, range.to)), ["next", "next"]);
});

test("contextual choices format each occurrence, keep the primary, and enforce one aggregate limit", () => {
    const { buffer, stops } = contextual(["a\r\n        b", "a\n    b"], ["a\nb", "x\n\tz\n"]);
    assert.equal(snippetChoiceText(stops[0]!, stops[0]!.ranges[0]!, 0), "a\r\n        b");
    const chosen = planSnippetChoice(buffer, stops, 0, 1, 1)!, next = buffer.apply(chosen.edits).buffer;
    assert.equal(chosen.selectionSet.primary, 1);
    assert.deepEqual(chosen.stops[0]!.ranges.map(range => next.slice(range.from, range.to)), ["x\r\n            z\r\n        ", "x\n        z\n    "]);
    assert.deepEqual(chosen.stops[1]!.ranges.map(range => next.slice(range.from, range.to)), ["next", "next"]);
    assert.equal(planSnippetChoice(buffer, stops, 0, 99), undefined);
    assert.throws(() => planSnippetChoice(buffer, stops, 0, 1, 1, next.length - 1), /limit/);
    assert.equal(buffer.apply(planSnippetChoice(buffer, stops, 0, 1, 1, next.length)!.edits).buffer.text(), next.text());
    const restored = planSnippetChoice(next, chosen.stops, 0, 0)!; assert.equal(next.apply(restored.edits).buffer.text(), buffer.text());
    assert.equal(snippetChoiceText({ ...stops[0]!, choices: ["\ta\r\n\r\n\r\n"] }, { from: 0, to: 0, order: 0,
        insertion: { columns: 0, tabSize: 4, insertSpaces: true, lineEnding: "\n" }, firstLine: { sourceColumns: 0, columns: 0 } }, 0, 8), "    a\n\n\n");
});

test("deleting generated indentation changes each mirror instead of collapsing to an empty edit", () => {
    const { buffer, stops } = contextual(["a\n        b", "a\n    b"]), at = stops[0]!.ranges[0]!.from + 2;
    const plan = planSnippetEdit(buffer, stops, 0, [{ from: at, to: at + 1, insert: "" }], createSelectionSet(buffer.length, [{ anchor: at, head: at + 1 }]),
        createSelectionSet(buffer.length - 1, [{ anchor: at, head: at }]))!;
    assert.ok(plan); const next = buffer.apply(plan.edits).buffer;
    assert.deepEqual(plan.stops[0]!.ranges.map(range => next.slice(range.from, range.to)), ["a\n       b", "a\n   b"]);
    assert.deepEqual(plan.stops[1]!.ranges.map(range => next.slice(range.from, range.to)), ["next", "next"]);
});

test("editor newline plans mirror current local indentation, including after literal paste changed it", () => {
    for (const enter of [undefined, "keep"] as const) for (const values of [["a\n        b", "a\n    b"], ["raw\nb", "raw\nb"]]) {
        const { buffer, stops } = contextual(values), selections = createSelectionSet(buffer.length, stops[0]!.ranges.map(range => ({ anchor: range.to, head: range.to })), 1);
        const command = planLanguageEdit(buffer, selections, "newline", resolveLanguageConfiguration(enter ? { enter } : {}));
        let step = command.next(); while (step.status === "running") step = command.next();
        assert.ok(step.result); const result = step.result; command.dispose();
        const plan = planSnippetEdit(buffer, stops, 0, result.edits, selections, result.selectionSet, !!enter)!;
        assert.ok(plan, JSON.stringify({ values, edits: result.edits, selections, after: result.selectionSet })); const next = buffer.apply(plan.edits).buffer;
        assert.equal(next.text(), buffer.apply(result.edits).buffer.text());
        assert.equal(plan.selectionSet.primary, 1); assert.deepEqual(plan.selectionSet, result.selectionSet);
        assert.deepEqual(plan.stops[1]!.ranges.map(range => next.slice(range.from, range.to)), ["next", "next"]);
        // With only the primary selected, the same intended newline reaches all mirrors.
        const primary = selections.ranges[selections.primary]!, one = createSelectionSet(buffer.length, [primary]);
        const edit = result.edits[1]!, head = edit.from + edit.insert.length;
        const single = planSnippetEdit(buffer, stops, 0, [edit], one, createSelectionSet(buffer.length + edit.insert.length, [{ anchor: head, head }]), !!enter)!;
        assert.ok(single); assert.equal(buffer.apply(single.edits).buffer.text(), next.text());
    }
});

test("a contextual mirror edit in a large document reads only its active fields", t => {
    const local = contextual(["a\n        b", "a\n    b"]), prefix = "unrelated\n".repeat(50000);
    const buffer = TextBuffer.from(prefix + local.buffer.text() + prefix), stops = offsetSnippetStops(local.stops, prefix.length), at = stops[0]!.ranges[0]!.to - 1;
    const plan = planSnippetEdit(buffer, stops, 0, [{ from: at, to: at + 1, insert: "😀" }], createSelectionSet(buffer.length, [{ anchor: at, head: at + 1 }]),
        createSelectionSet(buffer.length + 1, [{ anchor: at + 2, head: at + 2 }]))!;
    assert.ok(plan); assert.deepEqual(buffer.readMetrics(), { textExports: 0, sliceUnits: 18 });
    const next = buffer.apply(plan.edits).buffer;
    assert.deepEqual(plan.stops[0]!.ranges.map(range => next.slice(range.from, range.to)), ["a\n        😀", "a\n    😀"]);
    t.diagnostic(JSON.stringify({ documentUnits: buffer.length, fieldReadUnits: 18, textExports: 0 }));
});
