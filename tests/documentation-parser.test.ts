import test from "node:test";
import assert from "node:assert/strict";
import { parseDocumentation } from "../src/core/documentation.ts";

test("documentation parsing preserves escapes, nested emphasis and unterminated fences", () => {
    const content = parseDocumentation([{ kind: "markdown", value: "\\*literal\\* and **strong with _emphasis_ inside** and ``a ` b``.\n\n```ts\nUnclosed <tag>\n" }]);
    assert.deepEqual(content, [
        { kind: "paragraph", children: [
            { kind: "text", value: "*literal* and " },
            { kind: "strong", children: [{ kind: "text", value: "strong with " }, { kind: "em", children: [{ kind: "text", value: "emphasis" }] }, { kind: "text", value: " inside" }] },
            { kind: "text", value: " and " }, { kind: "code", value: "a ` b" }, { kind: "text", value: "." },
        ] },
        { kind: "code", value: "Unclosed <tag>\n", language: "ts" },
    ]);
});
