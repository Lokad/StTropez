import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyTextEdits } from "../src/core/changes.ts";
import { PositionMap } from "../src/core/positions.ts";
import { LiteralSearch } from "../src/core/search.ts";
import { bulkWorkload } from "./bulk-workloads.mjs";
import { distribution } from "./measurement.mjs";
if (!globalThis.gc) throw new Error("Bulk measurements require explicit GC.");
const [id, modulePath = "src/core/text-buffer.ts"] = process.argv.slice(2), { TextBuffer } = await import(pathToFileURL(resolve(modulePath)).href);
const workload = bulkWorkload(id), edits = workload.edits; let text = workload.text, before = TextBuffer.from(text);
for (const edit of workload.setup ?? []) { before = before.replace(edit.from, edit.to, edit.insert); text = applyTextEdits(text, [edit]); }
const expected = applyTextEdits(text, edits), mapping = new PositionMap(text.length, edits);
const expectedLines = expected.split("\n"), expectedLongest = expectedLines.reduce((maximum, line) => Math.max(maximum, line.length), 0), lineStarts = [0];
for (const line of expectedLines) lineStarts.push(lineStarts.at(-1) + line.length + 1);
const apply = [], traverse = [], search = [], warmup = 3, measured = 10; let current = before, chunks = 0;
function run(record) {
    const start = performance.now(), result = before.apply(edits), applied = performance.now();
    current = result.buffer; assert.ok(current instanceof TextBuffer); let units = 0; chunks = 0;
    const traverseStart = performance.now(); for (const value of current.chunks()) { units += value.length; chunks++; } const traversed = performance.now();
    const cursor = new LiteralSearch(current, "___absent_marker___"), searchStart = performance.now(); let matches = 0, scanned = 0;
    for (;;) { const step = cursor.next(); matches += step.matches.length; scanned += step.readUnits; if (step.done) break; } const searched = performance.now();
    assert.equal(units, expected.length); assert.equal(scanned, expected.length); assert.equal(matches, 0); assert.equal(current.longestLineLength, expectedLongest); assert.equal(current.lineCount, expectedLines.length);
    for (const line of [0, Math.floor(expectedLines.length / 2), expectedLines.length - 1]) { assert.equal(current.offsetAt(line), lineStarts[line]); assert.equal(current.lineAt(lineStarts[line]), line); }
    let offset = 0;
    for (const value of current.chunks()) { assert.equal(value, expected.slice(offset, offset + value.length)); offset += value.length; }
    assert.equal(offset, expected.length); assert.equal(before.readMetrics().textExports, 0); assert.equal(current.readMetrics().textExports, 0);
    for (const point of [0, Math.floor(text.length / 2), text.length]) for (const side of ["before", "after"]) assert.deepEqual(result.mapping.map(point, side), mapping.map(point, side));
    if (record) { apply.push(applied - start); traverse.push(traversed - traverseStart); search.push(searched - searchStart); }
}
for (let index = 0; index < warmup; index++) run(false);
globalThis.gc(); const heapBefore = process.memoryUsage().heapUsed;
for (let index = 0; index < measured; index++) run(true);
globalThis.gc(); const heapRetained = process.memoryUsage().heapUsed;
const retention = TextBuffer.retained([before, current]);
console.log(JSON.stringify({ workload: id, inputLength: text.length, outputLength: expected.length, editCount: edits.length, warmup, measured, chunks,
    applyMs: distribution(apply), traversalMs: distribution(traverse), searchMs: distribution(search), retention,
    heap: { before: heapBefore, retained: heapRetained, note: "GC samples include runtime/JIT/string-sharing noise; logical backing units are not heap bytes. The last warm result exists at the baseline sample." } }));
