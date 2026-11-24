import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer } from "../src/index.ts";
import { ModuleLinksCursor, validateLinksInput } from "../fixtures/language/links.ts";
const alias = { module: "sample-utils", resource: "target-resource", document: "target", revision: 7, length: 25 };
function scan(text: string) {
    const cursor = new ModuleLinksCursor({ id: 1, document: "source", resource: "source-resource", revision: 3, length: text.length, aliases: [alias], delay: 0 }, TextBuffer.from(text));
    let work = 0;
    for (;;) {
        const step = cursor.next();
        assert.ok(step.work >= work && step.work - work <= 16384);
        work = step.work;
        if (step.result) {
            assert.equal(work, text.length);
            return step.result;
        }
    }
}

test("document links reuse exact import-line grammar with raw BOM/CRLF ranges, bounded long lines and unresolved modules", () => {
    const line = 'import "sample-utils";', text = '\ufeff' + line + '\r\n' + 'import "missing-utils";\n' + "x".repeat(32_768) + '\r\n' + line;
    const result = scan(text); assert.equal(result.links.length, 3); assert.deepEqual(result.links[0], { from: 9, to: 21, module: "sample-utils", tooltip: "Open the captured sample-utils resource", target: { resource: alias.resource, document: alias.document, revision: 7, length: 25 } });
    assert.equal(result.links[1]!.target, null); assert.equal(result.links[2]!.from, text.length - line.length + 8); assert.ok(Object.isFrozen(result.links[0]!.target));
    for (const unsupported of ["import 'sample-utils';", ' import "sample-utils";', 'import "sample-utils"; // trailing', 'import "sample-utils"' + " ".repeat(32_768)]) assert.equal(scan(unsupported).links.length, 0);
});
test("link capture rejects conflicting aliases and out-of-range inputs", () => {
    const input = { id: 1, document: "source", resource: "source-resource", revision: 3, length: 0, aliases: [alias], delay: 0 };
    for (const change of [{ aliases: [alias, alias] }, { aliases: [{ ...alias, module: "bad\nname" }] }, { aliases: [{ ...alias, document: "source" }] }, { length: 16777217 }, { delay: NaN }]) assert.throws(() => validateLinksInput({ ...input, ...change }));
});
test("the scanner marks a truncated link list", () => {
    const line = 'import "sample-utils";\n';
    const exact = scan(line.repeat(1024)), over = scan(line.repeat(1025));
    assert.equal(exact.links.length, 1024);
    assert.equal(exact.truncated, false);
    assert.equal(over.links.length, 1024);
    assert.equal(over.truncated, true);
});
