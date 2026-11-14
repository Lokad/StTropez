import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import ts from "typescript-demo";
import { moduleSpecifiers } from "./module-specifiers.mjs";
import { attachDemoProvider } from "../examples/demo/provider-server.ts";
import { runDemoWalkthrough, runDemoConflict, runDemoCompletionCatalogue, runDemoSnippets, runDemoProjectResults, runDemoEditingRules, runDemoFolding, runDemoHighlights, runDemoDocumentation, runDemoActions } from "../tests/browser/demo-walkthrough.ts";
import { runDemoUnopenedNavigation } from "../tests/browser/demo-walkthrough.ts";
import { runDemoHostIntegrations } from "../tests/browser/demo-host-integrations.ts";
import { sourceIdentity } from "./measurement.mjs";
import { consumerCompilerRoots, within } from "./package-react-host.mjs";
import { demoMeasurementHook, measureDemo } from "./measure-demo.mjs";

const project = resolve("."), source = await sourceIdentity();
const reusePath = process.argv.find(arg => arg.startsWith("--reuse-consumer="))?.slice("--reuse-consumer=".length);
assert.ok(reusePath, "Restore a package first, then pass --reuse-consumer=<metadata>; use --scenarios=full,lsp,demo.");
const browserName = process.argv.find(arg => arg.startsWith("--browser="))?.slice("--browser=".length) ?? "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(browserName));
const prepareOnly = process.argv.includes("--prepare-only");
const measureOnly = process.argv.includes("--measure-only");
assert.ok(!measureOnly || browserName === "chromium" && !prepareOnly, "Integrated measurement requires Chromium without --prepare-only.");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const archivePath = "artifacts/nuget/feed/StTropez.Assets.0.0.0-local.nupkg", archive = await readFile(archivePath);
const packageSha256 = hash(archive), reused = JSON.parse(await readFile(reusePath, "utf8"));
assert.equal(reused.packageSha256, packageSha256, "Staged consumer belongs to a different package.");
const consumer = await realpath(reused.consumer), assetRoot = await realpath(reused.assetRoot);
assert.ok(!within(project, consumer) && within(await realpath(tmpdir()), consumer) && basename(consumer).startsWith("sttropez-consumer-"));
assert.ok(relative(consumer, assetRoot).replaceAll("\\", "/").startsWith("obj/sttropez/"));
const entries = unzipSync(archive), assets = JSON.parse(strFromU8(entries["assets/manifest.json"]));
assert.ok(!/<dependency\b/.test(strFromU8(entries["StTropez.Assets.nuspec"])));
async function checkStage() {
    assert.equal(hash(await readFile(archivePath)), packageSha256, "Package changed during qualification.");
    for (const asset of assets.assets) {
        assert.ok(within(assetRoot, resolve(assetRoot, asset.path)));
        assert.equal(hash(await readFile(join(assetRoot, asset.path))), asset.sha256, `Staged asset changed: ${asset.path}`);
    }
}
await checkStage();

// Reuse the project-owned host, including erased type imports. Only the four public
// library entry points may cross this boundary; the restored library is never compiled.
const publicImports = new Map([
    ["src/index.ts", "sttropez"], ["src/browser/index.ts", "sttropez/browser"],
    ["src/protocol/index.ts", "sttropez/protocol"], ["src/browser/editor.css", "sttropez/editor.css"],
]);
const hostRoot = join(consumer, "demo-host"), sources = [], seen = new Set();
const entryPoints = { app: "examples/demo/main.ts", "demo-syntax-worker": "examples/demo/syntax-worker.ts" };
const pending = [...Object.values(entryPoints)];
while (pending.length) {
    const path = pending.pop(); if (seen.has(path)) continue; seen.add(path);
    assert.ok(path.startsWith("examples/") && within(project, resolve(project, path)) && /\.(ts|css)$/.test(path), `Unexpected host source: ${path}`);
    const original = resolve(project, path), text = await readFile(original, "utf8"), edits = [], imports = [];
    function specifier(value, from, to) {
        if (!value.startsWith(".")) { assert.equal(value, "typescript-demo", `Unexpected host dependency: ${value}`); return; }
        const target = resolve(dirname(original), value), local = relative(project, target).replaceAll("\\", "/");
        assert.ok(within(project, target));
        if (local.startsWith("src/")) {
            const replacement = publicImports.get(local);
            assert.ok(replacement, `Host imported a private library module: ${local}`);
            edits.push({ from, to, text: replacement }); imports.push({ original: value, restored: replacement });
        } else { assert.ok(local.startsWith("examples/")); pending.push(local); }
    }
    if (path.endsWith(".css")) {
        for (const match of text.matchAll(/@import\s+["']([^"']+)["']/g)) {
            const from = match.index + match[0].indexOf(match[1]); specifier(match[1], from, from + match[1].length);
        }
    } else {
        for (const item of moduleSpecifiers(path, text)) specifier(item.value, item.from + 1, item.to - 1);
    }
    let staged = text;
    for (const edit of edits.sort((a, b) => b.from - a.from)) staged = staged.slice(0, edit.from) + edit.text + staged.slice(edit.to);
    const output = join(hostRoot, path); assert.ok(within(hostRoot, output)); await mkdir(dirname(output), { recursive: true }); await writeFile(output, staged);
    sources.push({ path, sourceSha256: hash(text), stagedSha256: hash(staged), publicImports: imports });
}
await writeFile(join(hostRoot, "styles.d.ts"), 'declare module "*.css";\n');
await writeFile(join(hostRoot, "package.json"), '{"type":"module"}\n');
const compilerRoots = await consumerCompilerRoots(project), demoCompiler = await realpath(join(project, "node_modules/typescript-demo"));
const compilerOptions = { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022", "DOM", "DOM.Iterable"],
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noUnusedLocals: true, noUnusedParameters: true,
    verbatimModuleSyntax: true, allowImportingTsExtensions: true, noEmit: true, skipLibCheck: false, types: [], paths: {
        sttropez: [join(assetRoot, "index.d.ts")], "sttropez/browser": [join(assetRoot, "browser/index.d.ts")],
        "sttropez/protocol": [join(assetRoot, "protocol/index.d.ts")], "typescript-demo": [join(demoCompiler, "lib/typescript.d.ts")],
    } };
const compilerFiles = [...Object.values(entryPoints), "styles.d.ts"];
await writeFile(join(hostRoot, "tsconfig.json"), JSON.stringify({ compilerOptions, files: compilerFiles }));
const compilerOutput = execFileSync(process.execPath, [join(project, "node_modules/typescript/bin/tsc"), "-p", join(hostRoot, "tsconfig.json"), "--listFiles", "--pretty", "false"],
    { cwd: hostRoot, encoding: "utf8", stdio: "pipe" });
await writeFile(join(hostRoot, "compiler-inputs.txt"), compilerOutput);
const typeInputs = [];
for (const path of compilerOutput.split(/\r?\n/).filter(Boolean)) {
    const input = await realpath(resolve(hostRoot, path));
    assert.ok(within(hostRoot, input) || /\.d\.[cm]?ts$/.test(input) && [assetRoot, demoCompiler, ...compilerRoots].some(root => within(root, input)), `Unexpected type input: ${path}`);
    typeInputs.push(input);
}
// Keep bundler working-directory resolution in the development host, with explicit staged
// entries and dependencies. Input checks below still reject every checkout library source.
const runtimeEntries = Object.fromEntries(Object.entries(entryPoints).map(([name, path]) => [name, join(hostRoot, path)]));
const site = join(hostRoot, "site"), bundle = await build({ absWorkingDir: project, entryPoints: runtimeEntries, outdir: site,
    bundle: true, platform: "browser", format: "esm", target: "es2022", metafile: true,
    tsconfigRaw: {}, alias: { sttropez: assetRoot }, nodePaths: [join(project, "node_modules")],
    ...(measureOnly ? { plugins: [{ name: "demo-measurement-host", setup(builder) {
        builder.onLoad({ filter: /[\\/]demo[\\/]main\.ts$/ }, async args => {
            assert.equal(args.path, join(hostRoot, "examples/demo/main.ts"));
            return { contents: await readFile(args.path, "utf8") + demoMeasurementHook, loader: "ts" };
        });
    } }] } : {}) });
const inputs = Object.keys(bundle.metafile.inputs).sort();
const compilerMetadata = JSON.parse(await readFile(join(demoCompiler, "package.json"), "utf8"));
const disabledHostModules = new Set(Object.entries(compilerMetadata.browser).filter(([, value]) => value === false).map(([name]) => `(disabled):${name}`));
for (const path of inputs) {
    if (disabledHostModules.has(path)) { assert.equal(bundle.metafile.inputs[path].bytes, 0); assert.deepEqual(bundle.metafile.inputs[path].imports, []); continue; }
    const input = await realpath(resolve(project, path));
    assert.ok(within(hostRoot, input) || within(assetRoot, input) && /\.(js|css)$/.test(input)
        || within(demoCompiler, input) && /\.js$/.test(input), `Unexpected browser input: ${path}`);
}
assert.ok(inputs.some(path => within(assetRoot, resolve(project, path)) && path.endsWith(".js")), "No compiled library assets reached the demo.");
await copyFile(join(project, "examples/demo/index.html"), join(site, "index.html"));
await copyFile(join(assetRoot, assets.entries.regexWorker), join(site, "regex-worker.js"));
await copyFile(join(assetRoot, "UNICODE-LICENSE.txt"), join(site, "UNICODE-LICENSE.txt"));
await copyFile(join(assetRoot, "LICENSE.txt"), join(site, "LICENSE.txt"));
const evidence = { schemaVersion: 1, sourceSha256: source.sha256, packageSha256, consumer, assetRoot: reused.assetRoot, reusedStage: true,
    browser: browserName, scenario: "demo", mode: prepareOnly ? "prepare-only" : measureOnly ? "measurement" : "walkthrough",
    declarations: { strict: true, skipLibCheck: false, passed: true, files: compilerFiles, inputs: typeInputs },
    sources: sources.sort((a, b) => a.path.localeCompare(b.path)), inputs, librarySourceCompilation: false,
    host: { node: process.version, compiler: JSON.parse(await readFile(join(project, "node_modules/typescript/package.json"), "utf8")).version,
        typescript: ts.version, server: "5.1.3", protocol: "3.17 / JSON-RPC 2.0 / WebSocket / UTF-16",
        note: "Only the project-owned demo host is compiled. Compiler/provider/test dependencies belong to the development host; no consumer package installation is performed." },
    native: "IME, OS clipboard and physical display remain UNVERIFIED" };
await mkdir("artifacts/package", { recursive: true });
if (!prepareOnly) {
    const routes = new Map(["index.html", "app.js", "app.css", "demo-syntax-worker.js", "regex-worker.js", "LICENSE.txt", "UNICODE-LICENSE.txt"].map(name => ["/" + name, name]));
    routes.set("/", "index.html");
    const server = createServer((request, response) => { void (async () => {
        if (await provider.handle(request, response)) return;
        const file = routes.get(new URL(request.url, "http://localhost").pathname);
        if (!file || request.method !== "GET") { response.writeHead(404).end(); return; }
        response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".txt") ? "text/plain" : "text/html");
        response.end(await readFile(join(site, file)));
    })().catch(error => { console.error(error); if (!response.headersSent) response.writeHead(500); response.end(); }); });
    const provider = attachDemoProvider(server); let browser, browserServer;
    try {
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
        if (measureOnly) {
            // Keep a public process owner so a blocked renderer cannot delay campaign cancellation.
            browserServer = await chromium.launchServer({ headless: true, host: "127.0.0.1" });
            browser = await chromium.connect(browserServer.wsEndpoint());
        } else browser = await ({ chromium, firefox, webkit })[browserName].launch({ headless: true });
        const url = `http://127.0.0.1:${server.address().port}/`, journeys = {};
        if (measureOnly) evidence.measurement = await measureDemo(browser, url, { sourceSha256: source.sha256, packageSha256 }, () => browserServer.kill());
        for (const [name, run] of measureOnly ? [] : [["walkthrough", runDemoWalkthrough], ["conflict", runDemoConflict], ["completionCatalogue", runDemoCompletionCatalogue], ["snippets", runDemoSnippets], ["projectResults", runDemoProjectResults], ["editingRules", runDemoEditingRules], ["folding", runDemoFolding], ["highlights", runDemoHighlights], ["documentation", runDemoDocumentation], ["unopenedNavigation", runDemoUnopenedNavigation], ["actions", runDemoActions], ["hostIntegrations", runDemoHostIntegrations]]) {
            const context = await browser.newContext({ viewport: { width: 1200, height: 760 } });
            try { journeys[name] = await run(await context.newPage(), url); console.log(`Restored demo ${name} passed (${browserName}).`); }
            finally { await context.close(); }
        }
        evidence.journeys = journeys;
    } finally {
        await browser?.close(); await browserServer?.close(); await provider.close();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        evidence.providerAfterClose = provider.snapshot();
        assert.deepEqual(evidence.providerAfterClose, { projects: 0, connections: 0, processes: 0, removals: 0 });
    }
}
await checkStage(); assert.equal((await sourceIdentity()).sha256, source.sha256, "Source changed during qualification.");
await writeFile(`artifacts/package/demo-${prepareOnly ? "prepared" : measureOnly ? "measurement" : browserName}.json`, JSON.stringify(evidence, null, 2) + "\n");
if (!prepareOnly && !measureOnly) await writeFile("artifacts/package/restored-consumer.json", JSON.stringify(evidence, null, 2) + "\n");
console.log(`Restored demo ${prepareOnly ? "declarations and bundle prepared" : "qualified"}: ${consumer}`);
