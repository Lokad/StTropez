import test from "node:test";
import assert from "node:assert/strict";
import { compileLspSelector, lspUriPath } from "../src/protocol/lsp-selector.ts";

test("text-document selectors cover glob syntax, language/scheme unions and explicit host URI policy", () => {
    const document = (path: string, languageId = "fixture") => ({ uri: "HOST+fixture://authority/" + path, languageId });
    const selected = (pattern: string, path: string) => compileLspSelector([{ scheme: "host+fixture", pattern }])(document(path));
    for (const [pattern, path, expected] of [
        ["**/*.ts", "a.ts", true], ["**/*.ts", "src/deep/a.ts", true], ["**/*.ts", "a.js", false],
        ["/src/*?.{ts,js}", "src/a.js", true], ["/src/*?.{ts,js}", "src/deep/a.ts", false],
        ["**/file[0-9][!a-c].ts", "file9z.ts", true], ["**/file[0-9][!a-c].ts", "file9b.ts", false],
        ["**/{a,{b,c}}.ts", "c.ts", true], ["**/literal\\?.ts", "literal%3F.ts", true],
    ] as const) assert.equal(selected(pattern, path), expected, `${pattern}: ${path}`);
    assert.equal(compileLspSelector([])(document("a")), false); assert.equal(compileLspSelector(null)(document("a")), true);
    assert.equal(compileLspSelector(["other", { language: "fixture" }])(document("a")), true);
    assert.equal(compileLspSelector([{ pattern: "/CUSTOM" }], () => "/CUSTOM")(document("a")), true);
    assert.equal(lspUriPath("opaque:custom%20path?ignored#fragment"), "custom path");
});

test("malformed/notebook selectors and excessive patterns fail without backtracking", () => {
    for (const selector of [undefined, {}, [{}], [{ notebook: "fixture" }], [{ pattern: "[z-a]" }], [{ pattern: "{a}" }], [{ pattern: "[" }], [{ pattern: "a".repeat(257) }], [{ pattern: "{a,b}".repeat(5) }]]) assert.throws(() => compileLspSelector(selector));
    const selector = compileLspSelector([{ pattern: "**/" + "a*".repeat(100) + "b" }]); assert.equal(selector({ uri: "fixture:/" + "a".repeat(3000), languageId: "fixture" }), false);
    assert.throws(() => compileLspSelector([{ pattern: "*" }])({ uri: "fixture:" + "x".repeat(4097), languageId: "fixture" }), RangeError);
});
