import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { distribution, timingSummary } from "../scripts/measurement.mjs";
import { createReportWriter } from "../scripts/benchmark-report.mjs";
type Report = { status: string; variant?: string; observations: number[] };

test("smoke, in-progress and failed reports preserve completed evidence and terminal records", async () => {
    await mkdir("artifacts", { recursive: true }); const root = await mkdtemp(resolve("artifacts/report-test-"));
    const full = await createReportWriter(root, "full"), smoke = await createReportWriter(root, "smoke"), failed = await createReportWriter(root, "full");
    const read = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Report;
    const first: Report = { status: "running", observations: [1] };
    const pending = full.write(first); first.observations.push(2); await pending;
    assert.deepEqual((await read(full.file)).observations, [1]); await assert.rejects(read(full.latest), { code: "ENOENT" });
    await full.write({ status: "passed", observations: [1, 2] }); const completed = await readFile(full.latest, "utf8");
    await smoke.write({ status: "passed", observations: [9] });
    await failed.write({ status: "running", observations: [3] }); await failed.write({ status: "failed", observations: [3] });
    assert.equal(await readFile(full.latest, "utf8"), completed); assert.equal(await readFile(full.file, "utf8"), completed);
    assert.equal((await read(failed.file)).status, "failed"); assert.equal((await read(smoke.latest)).variant, "smoke");
    await assert.rejects(full.write({ status: "failed", observations: [] }), /completed/);
    const later = await createReportWriter(root, "full"); await later.write({ status: "passed", observations: [4] });
    assert.deepEqual((await read(full.latest)).observations, [4]); assert.equal(await readFile(full.file, "utf8"), completed);
    assert.notEqual(later.file, full.file);
    for (const variant of ["", "../full", "Full", "full/smoke"]) await assert.rejects(createReportWriter(root, variant), /variant/);
    const invalid = await createReportWriter(root, "regex-whole-word-ignore-case");
    await assert.rejects(invalid.write({ status: "passed", variant: "literal", observations: [] }), /variant/);
    await assert.rejects(invalid.write({ status: "unknown", observations: [] }), /status/);
    await assert.rejects(read(invalid.latest), { code: "ENOENT" });
    assert.ok(full.file.startsWith(join(root, "full", "runs")));
});

test("small measurement batches report n and maximum while larger batches expose nearest-rank p95", () => {
    for (const n of [1, 10, 19, 20, 40]) {
        const samples = Array.from({ length: n }, (_, i) => n - i), result = distribution(samples);
        assert.equal(result.n, n); assert.equal(result.max, n); assert.equal(result.p50, Math.ceil(n / 2));
        assert.equal(result.p95, Math.ceil(n * .95)); assert.equal(result.statistic, n < 20 ? "max" : "p95");
        assert.deepEqual(timingSummary(result), { n, max: n, p50: Math.ceil(n / 2), ...(n >= 20 ? { p95: Math.ceil(n * .95) } : {}) });
        assert.deepEqual(result.samples, samples); assert.equal(samples[0], n);
    }
    const partial = Array<number>(3); partial[0] = 1; partial[2] = 2;
    for (const samples of [[], [-1], [NaN], [Infinity], Array<number>(2), partial]) assert.throws(() => distribution(samples), /invalid/);
});
