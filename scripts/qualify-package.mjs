import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { sourceIdentity } from "./measurement.mjs";

const choices = { full: [], lsp: ["--lsp-only"], react: ["--react-only"], pilot: ["--pilot-only"],
    hunk: ["--hunk-only"], activation: ["--activation-only"], workspace: ["--workspace-only"] };
const selected = (process.argv.find(arg => arg.startsWith("--scenarios="))?.slice("--scenarios=".length) ?? "full,lsp,react").split(",");
assert.ok(selected.length && new Set(selected).size === selected.length && selected.every(name => Object.hasOwn(choices, name)), "Select distinct package scenarios: full,lsp,react,pilot,hunk,activation,workspace.");
// Installation transitions belong to the full route, before any staged-root reuse.
if (selected.includes("full")) selected.splice(0, 0, ...selected.splice(selected.indexOf("full"), 1));
const source = await sourceIdentity();
if (!process.argv.includes("--existing")) {
    assert.ok(process.env.npm_execpath, "Run through npm run test:package, or pack once and pass --existing.");
    execFileSync(process.execPath, [process.env.npm_execpath, "run", "pack:nuget"], { stdio: "inherit" });
}
const archive = "artifacts/nuget/feed/StTropez.Assets.0.0.0-local.nupkg";
const hash = async () => createHash("sha256").update(await readFile(archive)).digest("hex");
const packageSha256 = await hash(), results = [];
const directory = "artifacts/package/qualification";
await mkdir(directory, { recursive: true });
const staged = `${directory}/staged-consumer.json`;
for (const [index, scenario] of selected.entries()) {
    assert.equal(await hash(), packageSha256, "Package changed during qualification.");
    const args = ["scripts/test-package.mjs", ...choices[scenario]];
    if (index) args.push(`--reuse-consumer=${staged}`);
    if (process.argv.includes("--skip-transitions")) args.push("--skip-transitions");
    args.push(...process.argv.filter(arg => arg.startsWith("--browser=")));
    execFileSync(process.execPath, args, { stdio: "inherit" });
    const consumer = JSON.parse(await readFile("artifacts/package/restored-consumer.json", "utf8"));
    assert.equal(consumer.packageSha256, packageSha256);
    if (index) {
        assert.equal(consumer.consumer, results[0].consumer);
        assert.equal(consumer.assetRoot, results[0].assetRoot);
        assert.equal(consumer.reusedStage, true);
    }
    await copyFile("artifacts/package/restored-consumer.json", `${directory}/${scenario}.json`);
    if (!index) await copyFile("artifacts/package/restored-consumer.json", staged);
    results.push({ scenario, consumer: consumer.consumer, assetRoot: consumer.assetRoot, reusedStage: consumer.reusedStage });
}
assert.equal(await hash(), packageSha256);
assert.equal((await sourceIdentity()).sha256, source.sha256, "Source changed during qualification; rebuild before continuing.");
await writeFile(`${directory}/receipt.json`, JSON.stringify({ sourceSha256: source.sha256, packageSha256, results }, null, 2) + "\n");
console.log(`One immutable package and restored asset root qualified across ${selected.join(", ")}.`);
