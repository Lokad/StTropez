import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { corpusIds, workloadSeed } from "../fixtures/workloads.ts";
import { sourceIdentity, environment } from "./measurement.mjs";

const rounds = Number(process.env.STTROPEZ_STORAGE_ROUNDS ?? 5);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10) throw new Error("Invalid storage round count.");
const names = ["flat", "chunk", "piece"], actions = ["start", "middle", "end", "random", "paste"];
const cases = [];
for (let round = 0; round < rounds; round++) {
    const order = names.slice(round % names.length).concat(names.slice(0, round % names.length));
    for (const corpus of corpusIds) {
        for (const action of actions) {
            let expectedHash;
            for (const candidate of order) {
                const child = spawnSync(process.execPath, ["--expose-gc", "scripts/storage-worker.mjs", candidate, corpus, action],
                    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
                if (child.status !== 0 || child.error) throw new Error(`Storage worker failed (${candidate}/${corpus}/${action}): ${child.error ?? child.stderr}`);
                const result = JSON.parse(child.stdout);
                assert.equal(result.measured, 90); assert.equal(result.mixedEditLookupSliceMs.samples.length, 90);
                expectedHash ??= result.finalHash; assert.equal(result.finalHash, expectedHash);
                cases.push({ round, order, ...result });
            }
        }
    }
    console.log(`Storage round ${round + 1}/${rounds} completed (${cases.length} verified cases).`);
}
const report = { schemaVersion: 1, created: new Date().toISOString(), source: await sourceIdentity(), environment: environment(),
    seed: workloadSeed, rounds, corpusIds, actions, candidates: names,
    note: "Development comparison: flat/chunk probes and an adapter to the selected runtime piece tree, including its transaction map allocation. Candidate order rotates between rounds. Every case runs in a fresh Node process with explicit GC; construction, edit, first lookup after edits, snapshot retention, local slices and export+checksum are separate. No renderer or production latency claim.", cases };
await mkdir("artifacts/bench/storage", { recursive: true });
await writeFile("artifacts/bench/storage/latest.json", JSON.stringify(report, null, 2));
console.log(`Recorded ${cases.length} storage cases in artifacts/bench/storage/latest.json`);
