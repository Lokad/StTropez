import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { candidates, ChunkTree, retained } from "../experiments/text-storage.ts";
import { corpus, editLog } from "../fixtures/workloads.ts";
import { distribution, environment } from "./measurement.mjs";

const [candidate, corpusId, action, measurement = "timing"] = process.argv.slice(2);
const Candidate = candidates[candidate];
if (!Candidate || !["start", "middle", "end", "random", "paste"].includes(action)) throw new Error("Unknown storage scenario.");
if (!globalThis.gc) throw new Error("Storage probes require --expose-gc; missing memory samples must fail.");
const initial = corpus(corpusId), count = 100, warmup = 10;
let oracle = initial;
const plan = [];
const random = editLog(initial.length, count);
for (let index = 0; index < count; index++) {
    let from, to, insert;
    if (action === "random") ({ from, to, insert } = random[index]);
    else if (action === "paste") {
        from = Math.floor(oracle.length / 2); to = Math.min(oracle.length, from + (index % 2 ? 6_000 : 0));
        insert = index % 2 ? "" : "pasted 😀 line\r\n".repeat(400);
    } else {
        from = action === "start" ? 0 : action === "end" ? oracle.length : Math.floor(oracle.length / 2);
        to = from; insert = "z";
    }
    oracle = oracle.slice(0, from) + insert + oracle.slice(to);
    const offset = Math.floor(oracle.length * .613), line = oracle.slice(0, offset).split("\n").length - 1;
    const lineStart = offset === 0 ? 0 : oracle.lastIndexOf("\n", offset - 1) + 1;
    const sliceFrom = Math.max(0, from - 4), sliceTo = Math.min(oracle.length, from + 12);
    // Copy tiny expected slices: an engine substring can otherwise retain every large oracle version.
    plan.push({ from, to, insert, offset, line, lineStart, sliceFrom, sliceTo, slice: oracle.slice(sliceFrom, sliceTo).split("").join("") });
}
const expectedHash = createHash("sha256").update(Buffer.from(oracle, "utf16le")).digest("hex");
const initialLine = initial.split("\n").length - 1;
oracle = null;
globalThis.gc();
const heapBefore = process.memoryUsage().heapUsed;
const constructionStart = performance.now();
let current = new Candidate(initial);
// First-read startup includes line indexing for every candidate.
const actualInitialLine = current.lineAt(initial.length);
const constructionMs = performance.now() - constructionStart;
assert.equal(actualInitialLine, initialLine);
const versions = [current], edit = [], lookupAfterEdit = [], snapshot = [], slice = [], mixed = [];
for (const [index, step] of plan.entries()) {
    const start = performance.now();
    current = current.replace(step.from, step.to, step.insert);
    const edited = performance.now();
    const actualLine = current.lineAt(step.offset), actualOffset = current.offsetAt(actualLine);
    const located = performance.now();
    versions.push(current);
    const captured = performance.now();
    const localText = current.slice(step.sliceFrom, step.sliceTo);
    const sliced = performance.now();
    assert.equal(actualLine, step.line); assert.equal(actualOffset, step.lineStart); assert.equal(localText, step.slice);
    assert.ok(current instanceof Candidate, "A different storage path satisfied the probe.");
    if (index >= warmup) {
        edit.push(edited - start); lookupAfterEdit.push(located - edited); snapshot.push(captured - located);
        slice.push(sliced - captured); mixed.push(sliced - start);
    }
}
if (current instanceof ChunkTree) current.inspect(new Set(), new Set());
// Measure retained memory before materializing text or calculating logical retention.
globalThis.gc(); const heapWithHistory = process.memoryUsage().heapUsed;
const logicalHistory = retained(versions);
// Avoid splice's returned array retaining all old roots in a live bytecode register at the GC sample.
versions.length = 0; versions.push(current);
globalThis.gc(); const heapCurrentOnly = process.memoryUsage().heapUsed;
const logicalCurrent = retained(versions);
const exportStart = performance.now();
const exported = current.text();
const actualHash = createHash("sha256").update(Buffer.from(exported, "utf16le")).digest("hex");
const exportAndChecksumMs = performance.now() - exportStart;
assert.equal(actualHash, expectedHash);
const warmLookup = [];
for (let index = 0; index < 100; index++) {
    const offset = index * 97 % (current.length + 1), start = performance.now();
    const line = current.lineAt(offset), located = current.offsetAt(line);
    warmLookup.push(performance.now() - start); assert.ok(located <= offset);
}
console.log(JSON.stringify({ candidate, corpus: corpusId, action, measurement, environment: environment(),
    count, warmup, measured: count - warmup, initialLength: initial.length, finalLength: current.length, finalHash: actualHash,
    constructionAndFirstLookupMs: constructionMs, editMs: distribution(edit), coldLookupAfterEditMs: distribution(lookupAfterEdit),
    retainSnapshotMs: distribution(snapshot), sliceMs: distribution(slice), mixedEditLookupSliceMs: distribution(mixed),
    warmLookupMs: distribution(warmLookup), exportAndUtf16ChecksumMs: exportAndChecksumMs,
    memory: { heapBefore, heapWithHistory, heapCurrentOnly, historyDelta: heapWithHistory - heapBefore,
        currentDelta: heapCurrentOnly - heapBefore, logicalHistory, logicalCurrent,
        note: "GC heap samples include runtime allocation/noise. Logical counts are not engine byte estimates; strings can share hidden backing allocations. Snapshots are immutable object references." } }));
