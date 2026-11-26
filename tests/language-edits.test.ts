import { bufferReads } from "./buffer-reads.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { FoldIndex } from "../src/core/folding.ts";
import { TextBuffer, createFoldRegions, resolveLanguageConfiguration, planLanguageEdit, Workspace } from "../src/index.ts";
import { createSelectionSet } from "../src/core/selections.ts";
import { nextSeed } from "./fixtures/workloads.ts";
import type { LanguageConfiguration, Selection } from "../src/index.ts";

const configuration: LanguageConfiguration = { tabSize: 2, lineComment: "//", blockComment: { open: "/*", close: "*/" }, enter: "keep",
    pairs: [{ open: "{", close: "}" }, { open: '"', close: '"' }] };
test("deleting the last visible line leaves the caret on the preceding collapsed header", () => {
    const buffer = TextBuffer.from("head\r\ninner\r\nlast"), config = resolveLanguageConfiguration();
    const folds = new FoldIndex(3, createFoldRegions(buffer, [{ id: "section", from: 0, to: 13, collapsed: true }]));
    const at = buffer.length - 1, carets = createSelectionSet(buffer.length, [{ anchor: at, head: at }]);
    const result = planLanguageEdit(buffer, carets, "delete-lines", config, folds);
    assert.equal(buffer.apply(result.edits).buffer.text(), "head\r\ninner");
    assert.equal(result.selectionSet.ranges[0]!.head, 3);
    assert.throws(() => planLanguageEdit(buffer, carets, "delete-lines", config, new FoldIndex(2, [])), /planning buffer/);
});

function plan(text: string, ranges: readonly Selection[], command: Parameters<typeof planLanguageEdit>[2], config = configuration) {
    const buffer = TextBuffer.from(text), selections = createSelectionSet(text.length, ranges, ranges.length - 1);
    const value = planLanguageEdit(buffer, selections, command, resolveLanguageConfiguration(config));
    const after = buffer.apply(value.edits).buffer;
    assert.equal(bufferReads(buffer).textExports, 0);
    assert.ok(Object.isFrozen(value));
    assert.ok(Object.isFrozen(value.edits));
    assert.ok(value.edits.every(Object.isFrozen));
    return { value, text: after.slice(0, after.length), ranges: value.selectionSet.ranges.map(range => [range.anchor, range.head]) };
}
const selection = (anchor: number, head = anchor) => [{ anchor, head }];

test("indentation and line comments edit a folded block once for carets on its header and inside it", () => {
    const original = "before\n  steps\n    prepare\n      validate\n\n    publish\nafter";
    const indent = "before\n    steps\n      prepare\n        validate\n\n      publish\nafter";
    const comment = "before\n  // steps\n  //   prepare\n  //     validate\n\n  //   publish\nafter";
    for (const [command, before, after] of [
        ["indent", original, indent], ["indent-lines", original, indent], ["outdent", indent, original],
        ["line-comment", original, comment], ["add-line-comment", original, comment], ["remove-line-comment", comment, original],
    ] as const) {
        const buffer = TextBuffer.from(before), folds = new FoldIndex(buffer.lineCount, createFoldRegions(buffer, [
            { id: "steps", from: buffer.offsetAt(1), to: buffer.offsetAt(6), collapsed: true },
            { id: "prepare", from: buffer.offsetAt(2), to: buffer.offsetAt(4), collapsed: true },
        ]));
        const ranges = [...selection(before.indexOf("steps") + 2), ...selection(before.indexOf("validate") + 3)];
        const config = resolveLanguageConfiguration(configuration);
        const result = planLanguageEdit(buffer, createSelectionSet(buffer.length, ranges), command, config, folds);
        assert.equal(buffer.apply(result.edits).buffer.text(), after, command);
        const heads = [after.indexOf("steps") + 2, after.indexOf("validate") + 3];
        assert.deepEqual(result.selectionSet.ranges.map(r => r.head), heads, command);
    }
});

test("Tab advances each inline range to a stop and indents complete lines in the same transaction", () => {
    const config: LanguageConfiguration = { tabSize: 4, enter: () => ({ indent: 1 }) };
    const mixed = plan("a\tbcd\nx\n", [{ anchor: 3, head: 2 }, { anchor: 4, head: 5 }, { anchor: 6, head: 7 }], "indent", config);
    assert.equal(mixed.text, "a\t    c  \n    x\n"); assert.deepEqual(mixed.ranges, [[6, 6], [9, 9], [10, 15]]);
    const overlap = plan("   xy\nz", [{ anchor: 1, head: 4 }, { anchor: 5, head: 7 }], "indent", config);
    assert.equal(overlap.text, "    y\n    z"); assert.deepEqual(overlap.ranges, [[4, 4], [5, 11]]);
    const blanks = plan("\n\nx", [{ anchor: 2, head: 0 }, { anchor: 3, head: 3 }], "indent", config);
    assert.equal(blanks.text, "\n\nx   "); assert.deepEqual(blanks.ranges, [[2, 0], [6, 6]]);
    const blank = plan("  {\r\n  ", selection(6), "indent", config);
    assert.equal(blank.text, "  {\r\n      "); assert.deepEqual(blank.ranges, [[11, 11]]);
    assert.equal(plan(blank.text, selection(11), "indent", config).text, blank.text + "  ");
    assert.equal(plan(" \t{\n ", selection(5), "indent", { ...config, insertSpaces: false }).text, " \t{\n \t\t");
    assert.equal(plan("ab", selection(0, 1), "indent", { insertSpaces: false }).text, "\tb");
});

test("configured line indentation and comments preserve reversed selections, blank lines and end-at-next-line", () => {
    const text = "  one\n\ttwo\n\nlast";
    const indented = plan(text, selection(11, 0), "indent");
    assert.equal(indented.text, "    one\n\t  two\n\nlast"); assert.deepEqual(indented.ranges, [[15, 0]]);
    assert.equal(plan(indented.text, indented.value.selectionSet.ranges, "outdent").text, text);
    const commented = plan(text, selection(0, 12), "line-comment");
    assert.equal(commented.text, "  // one\n\t// two\n\nlast");
    assert.equal(plan(commented.text, commented.value.selectionSet.ranges, "line-comment").text, text);
    assert.equal(plan("// first\nsecond", selection(0, 15), "line-comment").text, "// // first\n// second");
    const mixed = "// keep\r\n    deeper\r\n\t \r\n", reversed = selection(mixed.length, 0);
    const once = plan(mixed, reversed, "add-line-comment"), twice = plan(once.text, once.value.selectionSet.ranges, "add-line-comment");
    assert.equal(once.text, "// // keep\r\n//     deeper\r\n\t \r\n");
    assert.equal(plan(twice.text, twice.value.selectionSet.ranges, "remove-line-comment").text, once.text);
    const original = plan(once.text, once.value.selectionSet.ranges, "remove-line-comment");
    assert.equal(original.text, mixed); assert.deepEqual(original.ranges, [[mixed.length, 0]]);
    const carriageReturns = "\rvalue\n\r\n# tail\n\r";
    const hash = { lineComment: "#" };
    const added = plan(carriageReturns, selection(carriageReturns.length, 0), "line-comment", hash);
    assert.equal(added.text, "# \rvalue\n\r\n# # tail\n# \r");
    const removed = plan(added.text, added.value.selectionSet.ranges, "line-comment", hash);
    assert.equal(removed.text, carriageReturns);
    assert.deepEqual(removed.ranges, [[carriageReturns.length, 0]]);
    const tabs = "   a\n \tb\n  \tc", cfg = { ...configuration, tabSize: 4 };
    const aligned = plan(tabs, selection(0, tabs.length), "line-comment", cfg);
    assert.equal(aligned.text, " //   a\n // \tb\n //  \tc");
    assert.equal(plan(aligned.text, aligned.value.selectionSet.ranges, "line-comment", cfg).text, tabs);
    assert.equal(plan("  // a\n b", [...selection(4), ...selection(8)], "line-comment").text, "  a\n // b");
    assert.equal(plan("", selection(0), "line-comment").text, "// ");
    assert.equal(plan("\tx", selection(0, 2), "indent", { tabSize: 4, insertSpaces: false }).text, "\t\tx");
    const directed = [{ anchor: 5, head: 2, anchorAffinity: "before", headAffinity: "before" },
        { anchor: 6, head: 9, anchorAffinity: "before", headAffinity: "before" }] as const;
    const multiple = plan("  one\ntwo", directed, "line-comment");
    assert.deepEqual(multiple.ranges, [[8, 5], [12, 15]]);
    assert.ok(multiple.value.selectionSet.ranges.every(range => range.anchorAffinity === "before" && range.headAffinity === "before"));
    // Raw public input defaults affinities after mapping, including a collapsed reversed range.
    const result = planLanguageEdit(TextBuffer.from("  x"), { ranges: [{ anchor: 2, head: 0 }], primary: 0 }, "outdent", resolveLanguageConfiguration(configuration));
    assert.deepEqual(result.selectionSet.ranges, [{ anchor: 0, head: 0, anchorAffinity: "after", headAffinity: "after" }]);
});

test("line comments read a whole marker across a scan boundary", () => {
    const config = { ...configuration, lineComment: "-->" };
    const body = "x".repeat(1017);
    const plain = body + "\r\n😀\r\n\t \r\n";
    // The second marker starts at UTF-16 offset 1023.
    const marked = "--> " + body + "\r\n--> 😀\r\n\t \r\n";
    assert.equal(plan(plain, selection(plain.length, 0), "add-line-comment", config).text, marked);
    for (const command of ["line-comment", "remove-line-comment"] as const) {
        const result = plan(marked, selection(marked.length, 0), command, config);
        assert.equal(result.text, plain);
        assert.deepEqual(result.ranges, [[plain.length, 0]]);
    }
});

test("line shifts step over visible blocks and keep the caret column, including at document edges", () => {
    const blocks = ["first", "alpha\ninside", "bravo\ninner\nleaf", "last\ntail"];
    const buffer = TextBuffer.from(blocks.join("\n")), config = resolveLanguageConfiguration();
    const offsets = blocks.map((_, i) => blocks.slice(0, i).reduce((sum, block) => sum + block.length + 1, 0));
    const folds = new FoldIndex(buffer.lineCount, createFoldRegions(buffer, blocks.flatMap((block, i) => block.includes("\n")
        ? [{ id: String(i), from: offsets[i]!, to: Math.min(buffer.length, offsets[i]! + block.length + 1), collapsed: true }] : [])));
    for (const command of ["move-line-up", "move-line-down", "copy-line-up", "copy-line-down"] as const) {
        for (const [i, block] of blocks.entries()) {
            const at = offsets[i]! + 1, selection = createSelectionSet(buffer.length, [{ anchor: at, head: at }]);
            const result = planLanguageEdit(buffer, selection, command, config, folds);
            const expected = blocks.slice(), delta = command.endsWith("up") ? -1 : 1;
            let target = i;
            if (command.startsWith("copy")) { target = delta < 0 ? i : i + 1; expected.splice(target, 0, block); }
            else if (i + delta >= 0 && i + delta < expected.length) {
                target = i + delta; expected.splice(i, 1); expected.splice(target, 0, block);
            }
            assert.equal(buffer.apply(result.edits).buffer.text(), expected.join("\n"), command);
            assert.equal(result.selectionSet.ranges[0]!.head, expected.slice(0, target).reduce((sum, line) => sum + line.length + 1, 1), command);
        }
    }
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
    const result = planLanguageEdit(buffer, createSelectionSet(buffer.length, selection(2, buffer.length - 1)), "move-line-up", resolveLanguageConfiguration());
    assert.equal(result.edits.length, 2);
    assert.ok(bufferReads(buffer).sliceUnits < 10);
});

test("line commands apply once per selected row and preserve directed moves through EOF", () => {
    let seed = 17;
    const pick = (limit: number) => {
        seed = nextSeed(seed);
        return Math.floor(seed / 0x100000000 * limit);
    };
    for (let sample = 0; sample < 160; sample++) {
        const lines = Array.from({ length: 1 + pick(9) }, (_, i) =>
            " ".repeat(pick(5)) + (pick(2) ? "// " : "") + "row" + i + "x".repeat(pick(8)));
        if (sample % 4 >= 2) lines.push("");
        const ending = sample % 2 && lines.length > 1 ? "\r\n" : "\n";
        const rows = lines.map((text, i) => ({
            text, selected: pick(3) === 0 || i === sample % lines.length,
            anchor: pick(text.length + 1), head: pick(text.length + 1),
        }));
        const selected = rows.filter(row => row.selected);
        function offset(order: typeof rows, index: number) {
            return order.slice(0, index).reduce((n, row) => n + row.text.length + ending.length, 0);
        }
        const ranges = selected.map(row => {
            const start = offset(rows, rows.indexOf(row));
            return { anchor: start + row.anchor, head: start + row.head };
        });
        const blocks: (typeof rows)[] = [];
        for (const [i, row] of rows.entries()) {
            if (!row.selected) continue;
            if (!rows[i - 1]?.selected) blocks.push([]);
            blocks.at(-1)!.push(row);
        }
        for (const command of ["move-line-up", "move-line-down", "copy-line-up", "copy-line-down", "delete-lines"] as const) {
            const order = rows.slice();
            for (const block of blocks) {
                const at = order.indexOf(block[0]!);
                const after = at + block.length;
                if (command === "delete-lines") order.splice(at, block.length);
                else if (command === "copy-line-up" || command === "copy-line-down") {
                    // Keep the selected row objects on the side that receives the caret.
                    order.splice(command === "copy-line-up" ? after : at, 0, ...block.map(row => ({ ...row })));
                } else if (command === "move-line-up" && at > 0) {
                    const neighbor = order.splice(at - 1, 1)[0]!;
                    order.splice(after - 1, 0, neighbor);
                } else if (command === "move-line-down" && after < order.length) {
                    const neighbor = order.splice(after, 1)[0]!;
                    order.splice(at, 0, neighbor);
                }
            }
            const context = JSON.stringify({ command, lines, ending, ranges });
            const actual = plan(lines.join(ending), ranges, command);
            assert.equal(actual.text, order.map(row => row.text).join(ending), context);
            const expected = selected.map(row => {
                if (command === "delete-lines") {
                    const i = rows.indexOf(row);
                    const survivor = rows.slice(i + 1).find(other => !other.selected) ?? order.at(-1);
                    const caret = survivor ? offset(order, order.indexOf(survivor)) + Math.min(row.head, survivor.text.length) : 0;
                    return [caret, caret];
                }
                const start = offset(order, order.indexOf(row));
                return [start + row.anchor, start + row.head];
            });
            const distinct = expected.filter(([a, h], i) => !expected.slice(0, i).some(r => r[0] === a && r[1] === h));
            distinct.sort((a, b) => Math.min(...a) - Math.min(...b));
            assert.deepEqual(actual.ranges, distinct, context);
        }
        for (const command of ["indent-lines", "outdent", "add-line-comment", "remove-line-comment"] as const) {
            const expected = rows.map(({ text, selected }) => {
                if (!selected) return text;
                const indent = text.length - text.trimStart().length;
                if (command === "indent-lines") return " ".repeat(2 - indent % 2) + text;
                if (command === "outdent") return text.slice(Math.min(indent, indent % 2 || 2));
                const body = text.slice(indent);
                return text.slice(0, indent) + (command === "add-line-comment" ? "// " + body : body.replace(/^\/\/ ?/, ""));
            });
            assert.equal(plan(lines.join(ending), ranges, command).text, expected.join(ending),
                JSON.stringify({ command, lines, ending, ranges }));
        }
    }
});

test("inserting and deleting lines keeps local endings, collapses overlapping rows and clamps surviving columns", () => {
    const source = "  x\r\nbb\nc";
    const above = plan(source, [{ anchor: 5, head: 5 }, { anchor: 6, head: 6 }], "insert-line-above");
    assert.equal(above.text, "  x\r\n  \r\nbb\nc"); assert.deepEqual(above.ranges, [[7, 7]]);
    const below = plan(source, [{ anchor: 2, head: 2 }, { anchor: 6, head: 6 }], "insert-line-below");
    assert.equal(below.text, "  x\r\n  \r\nbb\n\nc"); assert.deepEqual(below.ranges, [[7, 7], [12, 12]]);
    assert.equal(plan(source, selection(2), "insert-line-above").text, "\r\n" + source);
    const last = plan(source, selection(9), "delete-lines");
    assert.equal(last.text, "  x\r\nbb"); assert.deepEqual(last.ranges, [[6, 6]]);
    const middle = plan(source, selection(8, 7), "delete-lines");
    assert.equal(middle.text, "  x\r\nc"); assert.deepEqual(middle.ranges, [[6, 6]]);
    const all = plan(source, selection(source.length, 0), "delete-lines");
    assert.equal(all.text, ""); assert.deepEqual(all.ranges, [[0, 0]]);
    const blank = plan("a\r\n", selection(3), "delete-lines");
    assert.equal(blank.text, "a"); assert.deepEqual(blank.ranges, [[0, 0]]);
});

test("block comments and pair surrounds retain directed and adjacent selections without copying selected text", () => {
    const selected = [{ anchor: 2, head: 0 }, { anchor: 2, head: 4 }];
    const comment = plan("abcd", selected, "block-comment");
    assert.equal(comment.text, "/* ab *//* cd */"); assert.deepEqual(comment.ranges, [[5, 3], [11, 13]]);
    assert.equal(plan(comment.text, comment.value.selectionSet.ranges, "block-comment").text, "abcd");
    const pair = plan("abcd", selected, { character: '"' });
    assert.equal(pair.text, '"ab""cd"'); assert.deepEqual(pair.ranges, [[3, 1], [5, 7]]);
    assert.equal(plan("/*ab*/", selection(6, 0), "block-comment").text, "ab");
    const empty = plan("", selection(0), "block-comment");
    assert.equal(empty.text, "/*  */");
    assert.deepEqual(empty.ranges, [[3, 3]]);
    assert.equal(plan(empty.text, empty.value.selectionSet.ranges, "block-comment").text, "");
    const touching = plan("a/**/b", [2, 3, 4, 6].map(head => ({ anchor: head, head })), "block-comment");
    assert.equal(touching.text, "ab/*  */"); assert.deepEqual(touching.ranges, [[1, 1], [5, 5]]);
    const between = plan("/**/X/**/", [...selection(2), ...selection(7), ...selection(6, 3)], "block-comment");
    assert.equal(between.text, "X"); assert.deepEqual(between.ranges, [[1, 0]]);
    const source = 'const marker = "/*";\n/*  one\r\n two  */';
    const real = source.lastIndexOf("/*"), inside = source.indexOf("two") + 1;
    const inferred = plan(source, selection(inside), "block-comment", { ...configuration, allowPair: ({ from }) => from === real });
    assert.equal(inferred.text, 'const marker = "/*";\n one\r\n two ');
    assert.deepEqual(inferred.ranges, [[inside - 3, inside - 3]]);
    assert.equal(plan("/* a */ x /* b */", selection(8), "block-comment").text, "/* a */ /*  */x /* b */");
    const padded = plan(" x ", selection(3, 0), "block-comment");
    assert.equal(padded.text, "/*  x  */");
    assert.deepEqual(plan(padded.text, padded.value.selectionSet.ranges, "block-comment").ranges, [[3, 0]]);
});

test("block comment discovery shares bounded scans across distant and adjacent carets", () => {
    const source = "x".repeat(2048) + "<!--" + "y".repeat(30000) + "-->", buffer = TextBuffer.from(source);
    const ranges = Array.from({ length: 120 }, (_, i) => ({ anchor: 2060 + 200 * i, head: 2060 + 200 * i }));
    const result = planLanguageEdit(buffer, createSelectionSet(source.length, ranges), "block-comment",
        resolveLanguageConfiguration({ blockComment: { open: "<!--", close: "-->" } }));
    assert.ok(bufferReads(buffer).sliceUnits < source.length * 2);
    assert.equal(buffer.apply(result.edits).buffer.length, source.length - 7);
    assert.equal(result.selectionSet.ranges.length, ranges.length);
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

test("line commands use visual stops and Enter follows its configured indentation rule", () => {
    for (const insertSpaces of [true, false]) for (const [prefix, previousStop, enterPrefix] of [
        ["  \t", "", ""], [" \t\t", " \t", "\t"], ["\t  \t", "\t", "  \t"], ["     \t", "    ", " \t"],
        ["  ", "", ""], ["      ", "    ", "  "], ["", "", ""],
    ]) {
        const config: LanguageConfiguration = { tabSize: 4, insertSpaces, enter: () => ({ indent: -1 }) };
        const source = prefix + "foo", result = plan(source, selection(source.length, 0), "outdent", config);
        assert.equal(result.text, previousStop + "foo"); assert.deepEqual(result.ranges, [[previousStop!.length + 3, 0]]);
        assert.equal(plan(prefix + "x\r\n", selection(prefix!.length), "newline", config).text, prefix + "\r\n" + enterPrefix + "x\r\n");
    }
});

test("large comment and indentation edits form one shared undo transaction", () => {
    const text = "x\n".repeat(2048), result = plan(text, selection(0, text.length), "line-comment");
    assert.equal(result.text, "// x\n".repeat(2048));
    const spaces = plan(" ".repeat(20000) + "x", selection(20000), "newline");
    assert.equal(spaces.text, " ".repeat(20000) + "\n" + " ".repeat(20000) + "x");
    const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "comments", variant: "working" }, "Comments", { value: text });
    const view = workspace.createDocumentView(resource.documentId); view.setSelection(0, { anchor: 0, head: text.length });
    assert.equal(workspace.edit({ documentId: resource.documentId, expectedRevision: 0, origin: "human", view, ...result.value, history: { kind: "replace" } }).applied, true);
    assert.equal(workspace.observeHistory(resource.documentId).getSnapshot().undoDepth, 1);
    assert.equal(workspace.undo({ documentId: resource.documentId, expectedRevision: 1 }).applied, true);
    assert.equal(workspace.document(resource.documentId).text(), text);
    view.dispose(); workspace.releaseResource(resource.id, true);
});

test("a no-op language plan owns its raw selections", () => {
    const ranges = Array.from({ length: 300 }, (_, i) => ({ anchor: 2 * i + 1, head: 2 * i }));
    const input = { ranges, primary: 1 };
    const plan = planLanguageEdit(TextBuffer.from("ab".repeat(300)), input, "remove-line-comment", resolveLanguageConfiguration());
    input.primary = 0;
    ranges[1]!.head = 0;
    assert.deepEqual(plan.edits, []);
    assert.equal(plan.selectionSet.primary, 1);
    assert.deepEqual(plan.selectionSet.ranges[1], { anchor: 3, head: 2 });
    assert.ok(Object.isFrozen(plan.selectionSet.ranges[1]));
});

test("language planning reports invalid selections and propagates a host rule failure", () => {
    const buffer = TextBuffer.from("x");
    assert.throws(() => planLanguageEdit(buffer, { ranges: [{ anchor: 1, head: 1 }, { anchor: 0, head: 0 }], primary: 0 },
        "indent", resolveLanguageConfiguration()), /normalized range order/);
    const failure = new Error("host rule failed");
    assert.throws(() => planLanguageEdit(buffer, createSelectionSet(1, [{ anchor: 0, head: 0 }]), "newline",
        resolveLanguageConfiguration({ enter: () => { throw failure; } })), error => error === failure);
});
