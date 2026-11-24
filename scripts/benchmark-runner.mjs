import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { createReportWriter } from "./benchmark-report.mjs";
import { sourceIdentity, environment } from "./measurement.mjs";

/** @typedef {{exitCode: number | null, signal: NodeJS.Signals | null, error?: string}} CommandResult */
/**
 * Stream child output to disk, with no shell or in-memory output buffer. Close is terminal.
 * @param {readonly string[]} args
 * @param {string} log
 * @param {string} cwd
 * @returns {Promise<CommandResult>}
 */
export async function runBenchmarkCommand(args, log, cwd) {
    const output = await open(log, "wx");
    try {
        return await new Promise(resolve => {
            const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", output.fd, output.fd], windowsHide: true });
            /** @type {Error | undefined} */
            let failure;
            child.once("error", error => { failure = error; });
            child.once("close", (exitCode, signal) => resolve({ exitCode, signal, ...(failure ? { error: failure.message } : {}) }));
        });
    } finally { await output.close(); }
}

/** @typedef {Pick<ReturnType<typeof import("./benchmark-suites.mjs").selectBenchmarks>, "key" | "suites" | "omitted">} BenchmarkPlan */
/** @typedef {{id: string, status: "pending" | "running" | "passed" | "failed" | "not-run", reason?: string, reports: readonly string[], steps: {kind: string, args: readonly string[], log: string, result?: CommandResult}[]}} SuiteResult */

/**
 * Sequential, fail-fast orchestration. Measurements remain at the individual suite owners.
 * @param {BenchmarkPlan} plan
 * @param {{directory?: string, cwd?: string}} [options]
 */
export async function runBenchmarkPlan(plan, { directory = "artifacts/bench/campaigns", cwd = process.cwd() } = {}) {
    assert.ok(/^[a-z0-9][a-z0-9-]*$/.test(plan.key) && plan.suites.length, "An explicit nonempty benchmark selection is required.");
    assert.equal(new Set(plan.suites.map(suite => suite.id)).size, plan.suites.length, "Benchmark suite IDs must be distinct.");
    for (const suite of plan.suites) assert.match(suite.id, /^[a-z0-9][a-z0-9-]*$/);
    const configuration = { selection: plan.key,
        suites: plan.suites.map(suite => ({ id: suite.id, args: suite.args })),
        environment: Object.fromEntries([...new Set(plan.suites.flatMap(suite => [...suite.environment]))].sort()
            .map(name => [name, process.env[name] ?? null])),
    };
    const variant = `${plan.key}-${createHash("sha256").update(JSON.stringify(configuration)).digest("hex").slice(0, 16)}`;
    const source = await sourceIdentity(), writer = await createReportWriter(directory, variant);
    const logs = writer.file.slice(0, -".json".length);
    await mkdir(logs);
    /** @type {SuiteResult[]} */
    const results = plan.suites.map(suite => ({ id: suite.id, status: "pending", reports: suite.reports, steps: [] }));
    const report = { kind: "benchmark-orchestration", configuration, source: { commit: source.commit, sha256: source.sha256 },
        environment: environment(), omitted: plan.omitted.map(id => ({ id, reason: "not-selected" })), results };
    /** @param {string} status @param {string | undefined} [error] */
    const publish = (status, error) => writer.write({ ...report, status, ...(error ? { error } : {}) });
    await publish("running");
    try {
        let failed = false, exitCode = 0;
        for (const [index, suite] of plan.suites.entries()) {
            const result = results[index];
            assert.ok(result);
            if (failed) { result.status = "not-run"; result.reason = "earlier-suite-failed"; continue; }
            result.status = "running";
            const record = { kind: "workload", args: suite.args, log: join(logs, `${suite.id}-workload.log`) };
            result.steps.push(record);
            await publish("running");
            console.log(`Benchmark ${suite.id}: ${record.log}`);
            const outcome = await runBenchmarkCommand(suite.args, record.log, cwd);
            Object.assign(record, { result: outcome });
            if (outcome.exitCode !== 0 || outcome.error) {
                result.status = "failed";
                result.reason = "workload-failed";
                failed = true;
                exitCode = outcome.exitCode || 1;
            }
            if (!failed) result.status = "passed";
            console.log(`Benchmark ${suite.id}: ${result.status}`);
            await publish("running");
        }
        assert.equal((await sourceIdentity()).sha256, source.sha256, "Source changed during the benchmark campaign.");
        const status = failed ? "failed" : "passed";
        await publish(status);
        return { status, exitCode, file: writer.file, latest: writer.latest, results };
    } catch (error) {
        for (const result of results) {
            if (result.status === "running") { result.status = "failed"; result.reason = "orchestration-failed"; }
            if (result.status === "pending") { result.status = "not-run"; result.reason = "orchestration-failed"; }
        }
        await publish("failed", error instanceof Error ? error.message : String(error));
        throw error;
    }
}
