import test from "node:test";
import assert from "node:assert/strict";

type Example = { path: string; line: number; language: string; code: string };
const { documentationExamples, compileDocumentation } = await import(new URL("../scripts/check-docs.mjs", import.meta.url).href) as {
    documentationExamples(path: string, markdown: string): Example[];
    compileDocumentation(examples: Example[]): Promise<{ success: boolean; output: string }>;
};

test("documentation examples preserve source lines and fence boundaries", () => {
    const markdown = ["# Guide", "", "````markdown", "```ts", "not an example", "```", "````", "",
        "  ~~~typescript", "  export const value = 1;", "  ~~~~", "", "```tsx", "export const text = 'literal';", "```"].join("\r\n");
    assert.deepEqual(documentationExamples("docs/example.md", markdown), [
        { path: "docs/example.md", line: 10, language: "typescript", code: "export const value = 1;" },
        { path: "docs/example.md", line: 14, language: "tsx", code: "export const text = 'literal';" }
    ]);
    assert.throws(() => documentationExamples("docs/example.md", "# Guide\n```ts\nconst x = 1;\n~~~/"), /example.md:2: Unclosed/);
});

test("documentation compiler rejects private imports and reports invalid public API calls at Markdown lines", async () => {
    const path = "docs/broken-example.md";
    await assert.rejects(compileDocumentation([{ path, line: 8, language: "ts",
        code: 'import { Workspace } from "../../src/index.ts";\nexport const workspace = new Workspace();' }]), /broken-example.md:8: Import .*public entry point/);
    const result = await compileDocumentation([{ path, line: 8, language: "ts",
        code: 'import { LiteralSearch } from "sttropez";\nexport const broken = new LiteralSearch("not a buffer", "query");' }]);
    assert.equal(result.success, false);
    assert.match(result.output, /docs\/broken-example\.md\(9,\d+\): error TS2345/);
    assert.match(result.output, /TextBuffer/);
    assert.doesNotMatch(result.output, /Cannot find module|artifacts[\\/]docs-check/);
});
