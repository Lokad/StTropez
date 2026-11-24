import test from "node:test";
import assert from "node:assert/strict";

import { documentationExamples, compileDocumentation } from "../../scripts/check-docs.mjs";
import { parseDocumentation, auditPage, auditLinks } from "../../scripts/documentation-audit.mjs";

test("documentation examples preserve source lines and fence boundaries", () => {
    const markdown = ["# Guide", "", "````markdown", "```ts", "not an example", "```", "````", "",
        "  ~~~typescript", "  export const value = 1;", "  ~~~~", "", "```tsx", "export const text = 'literal';", "```"].join("\r\n");
    assert.deepEqual(documentationExamples("docs/example.md", markdown), [
        { path: "docs/example.md", line: 10, language: "typescript", code: "export const value = 1;" },
        { path: "docs/example.md", line: 14, language: "tsx", code: "export const text = 'literal';" }
    ]);
    assert.throws(() => documentationExamples("docs/example.md", "# Guide\n```ts\nconst x = 1;\n~~~/"), /example.md:2: Unclosed/);
    assert.deepEqual(documentationExamples("nested.md", "> ```ts\n> export const quoted = 1;\n> ```\n\n- Item\n\n  ~~~ts\n  export const listed = 2;\n  ~~~"), [
        { path: "nested.md", line: 2, language: "ts", code: "export const quoted = 1;" },
        { path: "nested.md", line: 8, language: "ts", code: "export const listed = 2;" }
    ]);
    assert.throws(() => documentationExamples("nested.md", "> ```ts\n> const x = 1;"), /nested.md:1: Unclosed/);
    assert.throws(() => documentationExamples("indented.md", "```sh\nvalue\n    ```"), /indented.md:1: Unclosed/);
    assert.deepEqual(documentationExamples("outer.md", "````sh\n    ````\n````"), []);
});

test("documentation links resolve rendered headings, references and repository paths without interpreting example assets", async () => {
    const contents: Record<string, string> = {
        "docs/guide.md": ["# Guide", "[one](target%20page.md#héllo-code)", "[two][heading]", "![image](../images/icon.svg)",
            "[custom](target%20page.md#custom)", "[source](../src/code.ts#L2-L3)", "[directory](../src/)", "[root](../)",
            "`browser/index.js` and `protocol/index.d.ts`", "```md", "[fake](absent.md)", "```", "[heading]: target%20page.md#héllo-code-1"].join("\n"),
        "docs/target page.md": "# Héllo *`code`*\n\nHéllo **code**\n================\n\n<a id=\"custom\"></a>\n",
        "images/icon.svg": "<svg/>", "src/code.ts": "one\ntwo\nthree", "README.md": "# Project"
    };
    const files = new Set(Object.keys(contents)), read = async (path: string) => {
        if (!(path in contents)) throw new Error("missing");
        return contents[path]!;
    };
    const good = parseDocumentation("docs/guide.md", contents["docs/guide.md"]!);
    assert.deepEqual(await auditLinks([good], files, read), []);
    const broken = parseDocumentation("docs/guide.md", [
        "[missing](missing.md)", "[anchor](target%20page.md#missing)", "[ignored](../artifacts/run.md)",
        "[escape](../../outside.md)", "[absolute](/docs/guide.md)", "[encoding](bad%ZZ.md)",
        "[line](../src/code.ts#L4)", "[deleted](../deleted.md)", "[local](file:///C:/private.txt)"
    ].join("\n"));
    files.add("deleted.md");
    const issues = await auditLinks([broken], files, read);
    assert.deepEqual(issues.map(issue => [issue.path, issue.line, issue.code]), Array.from({ length: 9 }, (_, i) => ["docs/guide.md", i + 1, "link"]));
    assert.match(issues[2]!.message, /missing or ignored/);
    assert.match(issues[7]!.message, /working tree/);
    const html = parseDocumentation("html.md", '<!-- comment --><a href="missing.md">hidden link</a><!-- comment -->');
    assert.equal(html.diagnostics[0]?.code, "html");
});

test("documentation policy checks examples, support links and authored prose while retaining real identifiers and commands", () => {
    const valid = "# API\n\nPurpose.\n\n## Mount an editor\n\n```ts\nexport const now = 'pilot';\n```\n\n## Contract\n\n`mountTextEditor`, `?editor=candidate`, `bench:pilot` and `now` keep their names.\nThe budget is 4 ms; F12 opens developer tools.\n\n## Disposal\n\nDispose resources.\n\n## Not covered\n\nSee [support](README.md#support-matrix).";
    assert.deepEqual(auditPage(parseDocumentation("docs/api.md", valid), { api: true }), []);
    const prose = parseDocumentation("docs/api.md", "# API\n\nThe operation\nprevi**ous**ly returned data.\n\nM3 delivered 12 tests passed on 2026-11-16 at commit abc1234.");
    const issues = auditPage(prose);
    assert.equal(issues.length, 5);
    assert.deepEqual(issues.map(issue => issue.line), [4, 6, 6, 6, 6]);
    assert.equal(auditPage(prose, { vocabulary: false }).length, 0);
    assert.deepEqual(auditPage(parseDocumentation("docs/api.md", "# API"), { api: true }).map(issue => issue.code), ["example", "support"]);
});

test("documentation compiler rejects private imports and reports invalid public API calls at Markdown lines", async () => {
    const path = "docs/broken-example.md";
    await assert.rejects(compileDocumentation([{ path, line: 8, language: "ts",
        code: "// syntax error on the next line\nexport const broken = ;" }]), /broken-example.md:9: Invalid module syntax/);
    await assert.rejects(compileDocumentation([{ path, line: 8, language: "ts",
        code: 'import { Workspace } from "../../src/index.ts";\nexport const workspace = new Workspace();' }]), /broken-example.md:8: Import .*public entry point/);
    const result = await compileDocumentation([{ path, line: 8, language: "ts",
        code: 'import { LiteralSearch } from "sttropez/kernels";\nexport const broken = new LiteralSearch("not a buffer", "query");' }]);
    assert.equal(result.success, false);
    assert.match(result.output, /docs\/broken-example\.md\(9,\d+\): error TS2345/);
    assert.match(result.output, /TextBuffer/);
    assert.doesNotMatch(result.output, /Cannot find module|artifacts[\\/]docs-check/);
});
