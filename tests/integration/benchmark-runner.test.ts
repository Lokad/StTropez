import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { benchmarkSuites, selectBenchmarks } from "../../scripts/benchmark-suites.mjs";
import { runBenchmarkCommand, runBenchmarkPlan, type BenchmarkPlan } from "../../scripts/benchmark-runner.mjs";

async function fixture(run: (root: string) => Promise<void>) {
    await mkdir("artifacts", { recursive: true });
    const parent = await realpath("artifacts"), root = await mkdtemp(join(parent, "benchmark-runner-test-"));
    await run(root); // Retain failures for inspection.
    assert.equal(dirname(root), parent);
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true });
}

test("source capture preserves current bytes through unstaged moves and retains strict manifest validation", async () => fixture(async root => {
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    git("init", "--quiet");
    type Source = { commit: string | null; sha256: string; files: { path: string; sha256: string }[] };
    const moduleUrl = new URL("../../scripts/measurement.mjs", import.meta.url).href;
    const capture = (manifest = "") => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval",
        `import { sourceIdentity } from ${JSON.stringify(moduleUrl)};
try { console.log(JSON.stringify({ source: await sourceIdentity() })); }
catch (error) { console.log(JSON.stringify({ error: { code: error.code, message: error.message } })); }`], {
        cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, STTROPEZ_SOURCE_MANIFEST: manifest },
    })) as { source?: Source; error?: { code?: string; message: string } };
    const contents = new Map([
        [".gitignore", "ignored/\nmanifest.json\n"], ["keep.ts", "const before = 1;\r\n"],
        ["remove.ts", "removed\n"], ["old name.ts", "renamed\n"], ["staged.ts", "staged\n"],
    ]);
    const put = async (path: string, value: string) => { contents.set(path, value); await writeFile(join(root, path), value); };
    for (const [path, value] of contents) await put(path, value);
    git("add", "--all");
    const original = capture(); assert.equal(original.error, undefined); assert.ok(original.source);
    await put("keep.ts", "const after = 'é';\r\n");
    await rm(join(root, "remove.ts")); contents.delete("remove.ts");
    await rename(join(root, "old name.ts"), join(root, "new name.ts"));
    contents.set("new name.ts", contents.get("old name.ts")!); contents.delete("old name.ts");
    await put("π file.ts", "untracked\n");
    await mkdir(join(root, "ignored")); await writeFile(join(root, "ignored/unused.ts"), "ignored\n");
    const changed = capture(); assert.equal(changed.error, undefined); assert.ok(changed.source);
    const expected = [...contents].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([path, value]) => ({ path, sha256: createHash("sha256").update(value).digest("hex") }));
    assert.deepEqual(changed.source.files, expected); assert.equal(changed.source.commit, null);
    assert.notEqual(changed.source.sha256, original.source.sha256);
    git("add", "--all"); assert.deepEqual(capture().source, changed.source);
    const manifest = join(root, "manifest.json"); await writeFile(manifest, JSON.stringify(changed.source));
    assert.deepEqual(capture(manifest).source, changed.source);
    await writeFile(join(root, "keep.ts"), "different bytes\n");
    assert.match(capture(manifest).error!.message, /Campaign source mismatch: keep\.ts/);
    await rm(join(root, "keep.ts")); assert.equal(capture(manifest).error?.code, "ENOENT");
    await mkdir(join(root, "keep.ts")); assert.ok(capture(manifest).error, "Non-file read failures are not omitted from retained manifests.");
}));

test("benchmark selection preserves named aliases, explicit prerequisites and workload arguments", async () => {
    assert.deepEqual(selectBenchmarks([]).suites.map(suite => suite.id), ["model", "editing"]);
    assert.deepEqual(selectBenchmarks(["--group=pilot"]).suites.map(suite => suite.id), ["host-input", "comparison", "save-conflicts"]);
    assert.deepEqual(selectBenchmarks(["--suite=paragraph"]).suites[0]!.args, ["--expose-gc", "scripts/benchmark-paragraph.mjs"]);
    const packaged = selectBenchmarks(["--suite=package-hunk", "--", "--browser=firefox"]).suites[0]!;
    assert.equal(packaged.setup, "pack:nuget");
    assert.deepEqual(packaged.args, ["scripts/test-package.mjs", "--hunk-only", "--bench", "--browser=firefox"]);
    const group = selectBenchmarks(["--group=all", "--list"]);
    assert.equal(group.list, true);
    assert.ok(group.omitted.includes("host-drag-scroll") && group.omitted.includes("package-react"));
    assert.match(group.suites.find(suite => suite.id === "workspace")!.note!, /model.*native workspace/);
    assert.equal(new Set([...group.suites.map(suite => suite.id), ...group.omitted]).size, Object.keys(benchmarkSuites).length);
    for (const args of [["--suite=missing"], ["--group=constructor"], ["--suite=toString"], ["--group="],
        ["--group=all", "--suite=model"], ["--list", "--list"], ["--suite=model", "--verify"], ["--group=all", "--", "--verify"]]) {
        assert.throws(() => selectBenchmarks(args));
    }
    const metadata = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
    for (const [alias, command] of Object.entries(metadata.scripts).filter(([name]) => name === "bench" || name.startsWith("bench:"))) {
        assert.ok(command.startsWith("node scripts/run-benchmarks.mjs "), alias);
        const selected = selectBenchmarks(command.split(" ").slice(2));
        if (!["bench", "bench:all", "bench:pilot"].includes(alias)) assert.deepEqual(selected.suites.map(suite => suite.id), [alias.slice(6)]);
    }
});

test("benchmark campaigns sequence setup and workloads, retain logs and account for failure without promoting it", async () => fixture(async root => {
    await writeFile(join(root, "npm.mjs"), String.raw`import { appendFileSync } from 'node:fs';
import assert from 'node:assert/strict'; assert.deepEqual(process.argv.slice(2), ['run', 'pack:nuget']);
appendFileSync('order.txt', 'setup\n'); console.log('prepared');`);
    await writeFile(join(root, "workload.mjs"), String.raw`import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict'; assert.ok(readFileSync('order.txt','utf8').endsWith('setup\n'));
if (existsSync('fail')) { console.error('injected failure'); process.exit(7); }
process.stdout.write('x'.repeat(131072)); process.stderr.write('finished'); appendFileSync('order.txt', 'workload\n');`);
    await writeFile(join(root, "last.mjs"), String.raw`import { appendFileSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict'; assert.ok(readFileSync('order.txt','utf8').endsWith('workload\n')); appendFileSync('order.txt', 'last\n');`);
    const plan: BenchmarkPlan = { key: "group-fixture", omitted: ["unselected"], suites: [
        { id: "prepared", setup: "pack:nuget", args: ["workload.mjs"], environment: [], reports: [] },
        { id: "last", args: ["last.mjs"], environment: [], reports: [] },
    ] };
    const options = { cwd: root, directory: join(root, "reports"), npmPath: join(root, "npm.mjs") };
    const passed = await runBenchmarkPlan(plan, options), saved = await readFile(passed.latest, "utf8");
    assert.equal(passed.status, "passed"); assert.equal(passed.exitCode, 0);
    assert.equal(await readFile(join(root, "order.txt"), "utf8"), "setup\nworkload\nlast\n");
    assert.equal(await readFile(passed.results[0]!.steps[1]!.log, "utf8"), "x".repeat(131072) + "finished");
    assert.deepEqual(JSON.parse(saved).omitted, [{ id: "unselected", reason: "not-selected" }]);
    await writeFile(join(root, "fail"), "");
    const failed = await runBenchmarkPlan(plan, options);
    assert.equal(failed.status, "failed"); assert.equal(failed.exitCode, 7);
    assert.deepEqual(failed.results.map(result => result.status), ["failed", "not-run"]);
    assert.equal(failed.results[1]!.reason, "earlier-suite-failed");
    assert.equal(await readFile(join(root, "order.txt"), "utf8"), "setup\nworkload\nlast\nsetup\n");
    assert.equal(await readFile(passed.latest, "utf8"), saved);
    assert.equal(JSON.parse(await readFile(failed.file, "utf8")).status, "failed");
    assert.match(await readFile(failed.results[0]!.steps[1]!.log, "utf8"), /injected failure/);
}));

test("benchmark configuration separates environment modes and forwards arguments without a shell", async () => fixture(async root => {
    await writeFile(join(root, "echo.mjs"), "console.log(JSON.stringify({args: process.argv.slice(2), mode: process.env.STTROPEZ_RUNNER_TEST_MODE}));");
    const args = ["echo.mjs", "space in argument", "`literal`", "$(literal)", "; exit 9"];
    const plan: BenchmarkPlan = { key: "suite-fixture-modes", omitted: [], suites: [
        { id: "echo", args, environment: ["STTROPEZ_RUNNER_TEST_MODE"], reports: [] },
    ] };
    const prior = process.env.STTROPEZ_RUNNER_TEST_MODE;
    try {
        process.env.STTROPEZ_RUNNER_TEST_MODE = "full";
        const full = await runBenchmarkPlan(plan, { cwd: root, directory: join(root, "reports") });
        process.env.STTROPEZ_RUNNER_TEST_MODE = "smoke";
        const smoke = await runBenchmarkPlan(plan, { cwd: root, directory: join(root, "reports") });
        assert.notEqual(full.latest, smoke.latest);
        assert.deepEqual(JSON.parse(await readFile(smoke.results[0]!.steps[0]!.log, "utf8")), { args: args.slice(1), mode: "smoke" });
        assert.equal(JSON.parse(await readFile(full.latest, "utf8")).configuration.environment.STTROPEZ_RUNNER_TEST_MODE, "full");
    } finally {
        if (prior === undefined) delete process.env.STTROPEZ_RUNNER_TEST_MODE;
        else process.env.STTROPEZ_RUNNER_TEST_MODE = prior;
    }
    const missing = await runBenchmarkCommand(["echo.mjs"], join(root, "missing.log"), resolve(root, "absent"));
    assert.notEqual(missing.exitCode, 0); assert.match(missing.error!, /ENOENT/);
}));
