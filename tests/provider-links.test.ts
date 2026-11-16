import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer } from "../src/index.ts";
import { ModuleLinksCursor, validateLinksInput, validateLinksResult } from "../fixtures/language/links.ts";
import { ProviderProject } from "../fixtures/language/project.ts";
const alias = { module: "sample-utils", resource: "target-resource", document: "target", revision: 7, length: 25 };
function scan(text: string) { const input = validateLinksInput({ id: 1, document: "source", resource: "source-resource", revision: 3, length: text.length, aliases: [alias], delay: 0 }), buffer = TextBuffer.from(text), cursor = new ModuleLinksCursor(input, buffer); let work = 0;
    for (;;) { const step = cursor.next(); assert.ok(step.work >= work && step.work - work <= 16384); work = step.work; if (step.result) { assert.equal(work, text.length); return { input, buffer, result: step.result }; } }
}
test("document links reuse exact import-line grammar with raw BOM/CRLF ranges, bounded long lines and unresolved modules", () => {
    const line = 'import "sample-utils";', text = '\ufeff' + line + '\r\n' + 'import "missing-utils";\n' + "x".repeat(1000000) + '\r\n' + line;
    const x = scan(text), result = validateLinksResult(x.result, x.input, x.buffer); assert.equal(result.links.length, 3); assert.deepEqual(result.links[0], { from: 9, to: 21, module: "sample-utils", tooltip: "Open the captured sample-utils resource", target: { resource: alias.resource, document: alias.document, revision: 7, length: 25 } });
    assert.equal(result.links[1]!.target, null); assert.equal(result.links[2]!.from, text.length - line.length + 8); assert.equal(x.buffer.readMetrics().textExports, 0); assert.ok(Object.isFrozen(result.links[0]!.target));
    for (const unsupported of ["import 'sample-utils';", ' import "sample-utils";', 'import "sample-utils"; // trailing', 'import "sample-utils"' + " ".repeat(1000000)]) { const y = scan(unsupported); assert.equal(validateLinksResult(y.result, y.input, y.buffer).links.length, 0); }
});
test("complete link validation rejects malformed late entries, unknown URI targets, wrong revisions and split/oversized ranges", () => {
    const x = scan('import "sample-utils";\r\nimport "missing-utils";'), first = x.result.links[0]!;
    for (const value of [{ ...x.result, complete: false }, { ...x.result, id: 2 }, { ...x.result, links: [first, first] }, { ...x.result, links: [first, { ...first, from: -1 }] },
        { ...x.result, links: [{ ...first, target: "javascript:execute()" }] }, { ...x.result, links: [{ ...first, target: { ...first.target, revision: 8 } }] },
        { ...x.result, links: [{ ...first, target: { ...first.target, resource: "unknown" } }] }, { ...x.result, links: [{ ...first, to: 1000000 }] },
        { ...x.result, links: [{ ...first, from: first.from + 1 }] }, { ...x.result, links: [{ ...first, module: "other-utils" }] }]) assert.throws(() => validateLinksResult(value, x.input, x.buffer));
    const safe = validateLinksResult({ ...x.result, links: [{ ...first, tooltip: '<img onerror="execute()">' }] }, x.input, x.buffer); assert.match(safe.links[0]!.tooltip, /<img/);
    for (const change of [{ aliases: [alias, alias] }, { aliases: [{ ...alias, module: "bad\nname" }] }, { aliases: [{ ...alias, document: "source" }] }, { length: 16777217 }, { delay: NaN }]) assert.throws(() => validateLinksInput({ ...x.input, ...change }));
});
test("link capacity is explicit, never a silently partial navigable list", () => {
    const line = 'import "sample-utils";\n', exact = scan(line.repeat(1024)), over = scan(line.repeat(1025)); assert.equal(validateLinksResult(exact.result, exact.input, exact.buffer).links.length, 1024); assert.equal(over.result.truncated, true); assert.throws(() => validateLinksResult(over.result, over.input, over.buffer), /exceed/);
});
test("resident links require acknowledged source versions, serialize bounded scans and leave buffers immutable", () => {
    const project = new ProviderProject(4), send = (operation: string, fields: Record<string, unknown> = {}) => project.handle({ version: 1, epoch: 4, sequence: project.snapshot().sequence + 1, operation, ...fields }); send("project-hello");
    const text = "x".repeat(100000) + '\r\nimport "sample-utils";', x = scan(text); send("project-open", { document: "source", revision: 3, length: text.length }); for (let from = 0; from < text.length; from += 16384) send("project-chunk", { document: "source", revision: 3, from, text: text.slice(from, from + 16384) }); send("project-commit", { document: "source", revision: 3 });
    const before = project.buffer("source"); assert.throws(() => send("project-links", { input: { ...x.input, revision: 2 } })); send("project-links", { input: x.input }); assert.equal(project.snapshot().linksPending, true); assert.throws(() => send("project-close", { document: "source", revision: 3 })); assert.throws(() => send("project-links-next", { request: 2 }));
    let work = 0; for (;;) { const reply = send("project-links-next", { request: 1 }); assert.ok((reply.work as number) - work <= 16384); work = reply.work as number; if (reply.operation === "project-links-result") { assert.equal(work, text.length); validateLinksResult(reply.result, x.input, x.buffer); break; } }
    assert.equal(project.buffer("source"), before); assert.equal(before!.readMetrics().textExports, 0); assert.equal(project.snapshot().linksPending, false); assert.throws(() => send("project-links", { input: x.input }));
});
