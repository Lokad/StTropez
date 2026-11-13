import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTypeScript } from "../examples/demo/syntax.ts";

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
    const text = 'import { one } from "./one";\r\nimport { two } from "./two";\r\n\r\nfunction f() {\r\n  return one + two;\r\n}';
    const snapshot = analyzeTypeScript(text, { emit: false, folds: true });
    assert.equal(snapshot.javascript, "");
    assert.deepEqual(snapshot.folds, [
        { from: 0, to: text.indexOf("\r\n\r\n") + 2, group: "imports" },
        { from: text.indexOf("function"), to: text.length, group: "code" },
    ]);
    assert.ok(snapshot.spans.length > 0);
    const changed = analyzeTypeScript(text.replace('import { two } from "./two";\r\n', ""), { emit: false, folds: true });
    assert.equal(changed.folds.some(range => range.group === "imports"), false);
    assert.deepEqual(analyzeTypeScript(text).folds, []); // Ordinary typing does not add outlining work.
});
