import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { bulkWorkloadIds } from "./bulk-workloads.mjs";
import { sourceIdentity, environment } from "./measurement.mjs";
const rounds = Number(process.env.STTROPEZ_BULK_ROUNDS ?? 5);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10) throw new Error("Invalid bulk round count.");
const source = await sourceIdentity(), cases = [];
for (let round = 0; round < rounds; round++) for (const workload of round % 2 ? [...bulkWorkloadIds].reverse() : bulkWorkloadIds) {
    const child = spawnSync(process.execPath, ["--expose-gc", "scripts/bulk-worker.mjs", workload], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120000 });
    if (child.status !== 0 || child.error) throw new Error(`Bulk measurement failed (${workload}): ${child.error ?? child.stderr}`);
    const result = JSON.parse(child.stdout); assert.equal(result.measured, 10); assert.equal(result.applyMs.samples.length, 10); cases.push({ round, ...result });
}
assert.equal((await sourceIdentity()).sha256, source.sha256, "Source changed during the campaign.");
const report = { schemaVersion: 1, created: new Date().toISOString(), source, environment: environment(), runtime: "piece-tree-bulk-batches", rounds, cases,
    note: "Fresh Node process per workload/round, three warmups and ten measured batches. Apply includes validation/filtering/maps/construction; traversal and search elapsed times are separate. These clocks do not measure process CPU time. Full text/mapping/metadata oracle checks and explicit GC/retention are outside timing. No browser/scheduling/production-latency claim." };
await mkdir("artifacts/bench/bulk", { recursive: true }); await writeFile("artifacts/bench/bulk/latest.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(cases.map(c => ({ round: c.round, workload: c.workload, applyP95: c.applyMs.p95, traversalP95: c.traversalMs.p95, chunks: c.chunks })), null, 2));
