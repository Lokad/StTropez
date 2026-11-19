import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTypeScript, TypeScriptSyntax } from "../examples/demo/syntax.ts";
import { DemoSyntaxSession } from "../examples/demo/syntax-session.ts";
import type { SyntaxRequest } from "../examples/demo/syntax-session.ts";

test("demo compiler classifies multiline syntax and emits actual JavaScript", () => {
    const text = '/* Start\n comment */\nconst label: string = `Hello\n${2 + 3}!`;\n';
    const { spans, javascript } = analyzeTypeScript(text);
    const classificationAt = (offset: number) => {
        for (let i = 0; i < spans.length; i += 3) if (spans[i]! <= offset && spans[i]! + spans[i + 1]! > offset) return spans[i + 2];
        return undefined;
    };
    assert.equal(classificationAt(text.indexOf("comment")), 1);
    assert.equal(classificationAt(text.indexOf("const")), 3);
    assert.equal(classificationAt(text.indexOf("Hello")), 6);
    assert.equal(classificationAt(text.indexOf("2 +")), 4);
    assert.equal(classificationAt(text.indexOf("!")), 6);
    assert.ok(!javascript.includes(": string")); assert.match(javascript, /const label = `Hello/);
    // A real edit closes the comment earlier; the following declaration must regain keyword color.
    const fixed = analyzeTypeScript('/* Start */\nconst count = 42;');
    assert.ok(Array.from({ length: fixed.spans.length / 3 }, (_, i) => [fixed.spans[i * 3], fixed.spans[i * 3 + 2]])
        .some(([from, kind]) => from === 12 && kind === 3));
});

test("saved TypeScript snapshots classify and outline their own imports and blocks without emitting", () => {
    const text = 'import one = require("./one");\r\nimport type { Two } from "./two";\r\nimport "./three";\r\n\r\nfunction f() {\r\n  return one;\r\n}';
    const snapshot = analyzeTypeScript(text, { emit: false, folds: true });
    assert.equal(snapshot.javascript, "");
    assert.deepEqual(snapshot.folds, [
        { from: 0, to: text.indexOf("\r\n\r\n") + 2, group: "imports" },
        { from: text.indexOf("function"), to: text.length, group: "code" },
    ]);
    assert.ok(snapshot.spans.length > 0);
    const pair = 'import {\n  one,\n} from "./one";\n\n// import "./decoy";\nimport "./two";\n';
    const changed = analyzeTypeScript(pair, { emit: false, folds: true });
    assert.deepEqual(changed.folds, [{ from: 0, to: pair.indexOf("\n\n") + 1, group: "code" }]);
    const split = 'import "./a";\nimport "./b";\nvoid import("./lazy");\nimport "./c";\nimport "./d";\nimport "./e";';
    assert.deepEqual(analyzeTypeScript(split, { emit: false, folds: true }).folds,
        [{ from: split.indexOf('import "./c"'), to: split.length, group: "imports" }]);
    assert.deepEqual(analyzeTypeScript(text).folds, []); // Ordinary typing does not add outlining work.
});

test("retained syntax snapshots give exact change ranges and agree with fresh analysis through edits and resets", () => {
    const syntax = new TypeScriptSyntax(); let text = '/* 😀 */\r\nconst title: string = "hi";\r\nfunction f() {\r\n  return title;\r\n}';
    syntax.reset(text); const initial = syntax.snapshot;
    assert.deepEqual(syntax.analyze(), analyzeTypeScript(text));
    const edits = [{ from: 2, to: 2, insert: "comment " }, { from: 0, to: 2, insert: "//" },
        { from: 0, to: 3, insert: "/* " }, { from: 14, to: 15, insert: "\r\n" }, { from: 0, to: 0, insert: "const n = 2;\n" }];
    for (const [index, edit] of edits.entries()) {
        const before = syntax.snapshot, oldText = text;
        syntax.replace(edit.from, edit.to, edit.insert); text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
        assert.equal(before.getText(0, before.getLength()), oldText);
        assert.deepEqual(syntax.snapshot.getChangeRange(before), { span: { start: edit.from, length: edit.to - edit.from }, newLength: edit.insert.length });
        const options = { emit: index % 2 === 0, folds: true };
        assert.deepEqual(syntax.analyze(options), analyzeTypeScript(text, options));
    }
    assert.equal(syntax.snapshot.getChangeRange(initial), undefined); // Older compiler caches safely reparse.
    const current = syntax.snapshot; syntax.replace(0, 0, ""); assert.equal(syntax.snapshot, current);
    assert.throws(() => syntax.replace(0, text.length + 1, ""), RangeError); assert.equal(syntax.snapshot, current);
    syntax.reset('export const other = "different resource";');
    assert.equal(syntax.snapshot.getChangeRange(current), undefined);
    assert.deepEqual(syntax.analyze(), analyzeTypeScript('export const other = "different resource";'));
    syntax.dispose(); syntax.dispose(); assert.equal(syntax.snapshot.getLength(), 0);
    assert.throws(() => syntax.analyze(), /disposed/); assert.throws(() => syntax.reset(""), /disposed/);
});

test("syntax worker commits complete versioned uploads and rejects cancelled or stale replacements", () => {
    const session = new DemoSyntaxSession();
    const finish = (job: number, options = { emit: false, folds: true }) => session.accept({ kind: "finish", job, options });
    const start = (job: number, text: string, change?: Extract<SyntaxRequest, { kind: "start" }>["change"]) => {
        session.accept({ kind: "start", job, ...(change ? { change } : {}) });
        for (const part of [text.slice(0, 3), text.slice(3)]) session.accept({ kind: "chunk", job, text: part });
    };
    const initial = "const n: number = 1;", changed = "const n: number = 23;";
    start(1, initial); assert.deepEqual(finish(1), { job: 1, kind: "result", ...analyzeTypeScript(initial, { emit: false, folds: true }) });
    start(2, "discarded", { base: 1, from: 0, to: 0 }); session.accept({ job: 2, kind: "cancel" }); assert.equal(finish(2), undefined);
    start(3, "23", { base: 1, from: 18, to: 19 });
    session.accept({ job: 2, kind: "chunk", text: "stale" });
    assert.deepEqual(finish(3), { job: 3, kind: "result", ...analyzeTypeScript(changed, { emit: false, folds: true }) });
    start(2, "late full seed"); assert.equal(finish(2), undefined);
    start(4, "bad", { base: 1, from: 0, to: 0 }); assert.deepEqual(finish(4), { job: 4, kind: "failed" });
    start(5, "", { base: 3, from: 0, to: 0 });
    assert.deepEqual(finish(5, { emit: true, folds: false }), { job: 5, kind: "result", ...analyzeTypeScript(changed) });
    start(6, "const reset = true;"); assert.deepEqual(finish(6), { job: 6, kind: "result", ...analyzeTypeScript("const reset = true;", { emit: false, folds: true }) });
    session.dispose(); assert.equal(session.accept({ job: 7, kind: "start" }), undefined);
});
