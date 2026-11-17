import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { sourceIdentity } from "./measurement.mjs";
import { packageScenarios as choices } from "./package-scenarios.mjs";
import { withPackageConsumer } from "./package-consumer.mjs";

const selected = (process.argv.find(arg => arg.startsWith("--scenarios="))?.slice("--scenarios=".length) ?? "full,lsp,react").split(",");
assert.ok(selected.length && new Set(selected).size === selected.length && selected.every(name => Object.hasOwn(choices, name)), `Select distinct package scenarios: ${Object.keys(choices).join(",")}.`);
assert.ok(!selected.includes("demo") || selected.some(name => name !== "demo"), "Pair demo with a restored consumer, for example --scenarios=full,lsp,demo.");
// Installation transitions belong to the full route, before any staged-root reuse.
if (selected.includes("full")) selected.splice(0, 0, ...selected.splice(selected.indexOf("full"), 1));
if (selected.includes("demo")) selected.push(...selected.splice(selected.indexOf("demo"), 1));
const source = await sourceIdentity();
if (!process.argv.includes("--existing")) {
    assert.ok(process.env.npm_execpath, "Run through npm run test:package, or pack once and pass --existing.");
    execFileSync(process.execPath, [process.env.npm_execpath, "run", "pack:nuget"], { stdio: "inherit" });
}
const archive = "artifacts/nuget/feed/StTropez.Assets.0.0.0-local.nupkg";
const hash = async () => createHash("sha256").update(await readFile(archive)).digest("hex");
const packageSha256 = await hash(), results = [];
const evidence = "artifacts/package/qualification";
let directory, staged;
const metadata = new Set();
await withPackageConsumer({ keep: process.argv.includes("--keep-consumer"), record: async retention => {
    directory = `${evidence}/${basename(retention.consumer)}`;
    staged = `${directory}/staged-consumer.json`;
    await mkdir(directory, { recursive: true });
    const receipt = { sourceSha256: source.sha256, packageSha256, results, retention };
    await writeFile(`${directory}/receipt.json`, JSON.stringify(receipt, null, 2) + "\n");
    await writeFile(`${evidence}/receipt.json`, JSON.stringify({ ...receipt, directory }, null, 2) + "\n");
    for (const path of metadata) {
        const consumer = JSON.parse(await readFile(path, "utf8"));
        assert.equal(consumer.consumer, retention.consumer, "Consumer evidence changed during qualification.");
        await writeFile(path, JSON.stringify({ ...consumer, retention }, null, 2) + "\n");
    }
} }, async ownedConsumer => {
    for (const [index, scenario] of selected.entries()) {
        assert.equal(await hash(), packageSha256, "Package changed during qualification.");
        const args = [scenario === "demo" ? "scripts/package-demo.mjs" : "scripts/test-package.mjs", ...choices[scenario]];
        if (index) args.push(`--reuse-consumer=${staged}`);
        else args.push(`--consumer-directory=${ownedConsumer}`);
        if (process.argv.includes("--skip-transitions")) args.push("--skip-transitions");
        args.push(...process.argv.filter(arg => arg.startsWith("--browser=")));
        execFileSync(process.execPath, args, { stdio: "inherit" });
        const consumer = JSON.parse(await readFile("artifacts/package/restored-consumer.json", "utf8"));
        assert.equal(consumer.packageSha256, packageSha256);
        assert.equal(consumer.consumer, ownedConsumer, "Qualification must use its own fresh consumer.");
        if (index) {
            assert.equal(consumer.consumer, results[0].consumer);
            assert.equal(consumer.assetRoot, results[0].assetRoot);
            assert.equal(consumer.reusedStage, true);
        }
        await copyFile("artifacts/package/restored-consumer.json", `${directory}/${scenario}.json`);
        metadata.add("artifacts/package/restored-consumer.json");
        metadata.add(`${directory}/${scenario}.json`);
        if (!index) await copyFile("artifacts/package/restored-consumer.json", staged);
        if (!index) metadata.add(staged);
        results.push({ scenario, consumer: consumer.consumer, assetRoot: consumer.assetRoot, reusedStage: consumer.reusedStage });
    }
    assert.equal(await hash(), packageSha256);
    assert.equal((await sourceIdentity()).sha256, source.sha256, "Source changed during qualification; rebuild before continuing.");
});
console.log(`One immutable package and restored asset root qualified across ${selected.join(", ")}.`);
console.log(`Consumer retention and scenario evidence: ${directory}/receipt.json`);
