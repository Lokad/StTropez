// @ts-check
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";
import { unzipSync, strFromU8 } from "fflate";
import { chromium, firefox, webkit } from "@playwright/test";
import { runPackagedPilot } from "./package-pilot.mjs";
import { runPackagedHunkPilot } from "./package-hunk-pilot.mjs";
import { runPackageTransitions } from "./package-transitions.mjs";
import { consumerCompilerRoots, stageHostFixture, within } from "./package-react-host.mjs";
import { qualifyPackageExports } from "./package-exports.mjs";
import { consumerScenario } from "./package-scenarios.mjs";
import { emptyConsumerDirectory } from "./package-consumer.mjs";
import { createPackageRequestHandler, listenPackageServer, closePackageServer, closePackageResources } from "./package-host.mjs";

/** @typedef {{path: string, bytes: number, sha256: string}} Asset */
/** @typedef {{version: string, assets: Asset[], entries: {regexWorker: string}}} Manifest */

const scenario = consumerScenario(process.argv);
const hunkOnly = scenario === "hunk";
const transitionsOnly = scenario === "transitions";
const skipTransitions = process.argv.includes("--skip-transitions");
const reusePath = process.argv.find(arg => arg.startsWith("--reuse-consumer="))?.slice("--reuse-consumer=".length);
const consumerDirectory = process.argv.find(arg => arg.startsWith("--consumer-directory="))?.slice("--consumer-directory=".length);
assert.ok(!consumerDirectory || !reusePath, "A new consumer directory cannot also be a reused stage.");
const reactOnly = scenario === "react", prepareOnly = process.argv.includes("--prepare-only");
const lspOnly = scenario === "lsp";
const activationOnly = scenario === "activation";
const workspaceOnly = scenario === "workspace", deferredOnly = activationOnly || workspaceOnly;
const pilotOnly = scenario !== "full" && !transitionsOnly, benchmark = process.argv.includes("--bench");
const browserName = process.argv.find(arg => arg.startsWith("--browser="))?.slice("--browser=".length) ?? "chromium";
const corpus = process.argv.find(arg => arg.startsWith("--corpus="))?.slice("--corpus=".length) ?? "all";
assert.ok(browserName === "chromium" || browserName === "firefox" || browserName === "webkit", `Unknown browser: ${browserName}`);
assert.ok((corpus === "all" || corpus === "normal" || corpus === "large") && (corpus === "all" || deferredOnly), "Corpus selection requires an activation/workspace scenario and all, normal or large.");
assert.ok(!benchmark || pilotOnly, "Use --pilot-only, --hunk-only or --react-only with --bench to keep the workload explicit.");
assert.ok(!prepareOnly || ((reactOnly || deferredOnly) && !benchmark), "Preparation-only checks require --react-only, --activation-only or --workspace-only without --bench.");
assert.ok(!transitionsOnly || (!prepareOnly && !benchmark), "Transition-only checks cannot be combined with preparation or benchmark modes.");
assert.ok(!deferredOnly || !benchmark, "Deferred activation checks are an independent correctness scenario.");
assert.ok(!lspOnly || (!prepareOnly && !benchmark), "The minimal LSP consumer is one independent correctness scenario.");

const project = resolve(".");
const archive = await readFile("artifacts/nuget/feed/StTropez.Assets.0.0.0-local.nupkg");
const packageSha256 = createHash("sha256").update(archive).digest("hex");
const reused = reusePath ? JSON.parse(await readFile(reusePath, "utf8")) : undefined;
assert.ok(!transitionsOnly || (!reused && !skipTransitions), "Transition qualification requires its own install sequence.");
if (reused) assert.equal(reused.packageSha256, packageSha256, "Staged consumer belongs to a different package; restore the selected artifact again.");
assert.ok(!reused?.retention?.removed && reused?.retention?.state !== "removing", "Consumer was removed or is being removed; qualify a fresh stage.");
const entries = unzipSync(archive);
/** @param {string} path */
const entry = path => { const bytes = entries[path]; assert.ok(bytes, `Missing package entry: ${path}`); return bytes; };
/** @type {Manifest} */ const assets = JSON.parse(strFromU8(entry("assets/manifest.json")));
assert.equal(strFromU8(entry("assets/UNICODE-LICENSE.txt")), await readFile("licenses/Unicode-3.0.txt", "utf8"));
assert.equal(strFromU8(entry("assets/LICENSE.txt")), await readFile("LICENSE.txt", "utf8"));
const allowlist = new Set(["[Content_Types].xml", "_rels/.rels", "StTropez.Assets.nuspec", "README.md",
    "build/StTropez.Assets.props", "build/StTropez.Assets.targets", "assets/manifest.json",
    ...assets.assets.map(asset => `assets/${asset.path}`)]);
for (const [path, bytes] of Object.entries(entries)) {
    if (path.endsWith("/")) continue;
    assert.ok(allowlist.has(path) || /^package\/services\/metadata\/core-properties\/[^/]+\.psmdcp$/.test(path), `Unexpected package entry: ${path}`);
    assert.ok(!path.includes("..") && !path.startsWith("/"));
    if (path.startsWith("assets/") && path !== "assets/manifest.json") {
        const asset = assets.assets.find(asset => `assets/${asset.path}` === path);
        assert.ok(asset, `Unexpected asset: ${path}`);
        assert.equal(bytes.length, asset.bytes);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
    }
}
for (const path of allowlist) assert.ok(entries[path], `Missing package entry: ${path}`);
const nuspec = strFromU8(entry("StTropez.Assets.nuspec"));
assert.ok(!/<dependency\b/.test(nuspec), "Package must not depend on managed or third-party packages.");
assert.match(nuspec, /<license type="expression">MIT<\/license>/);

// Separate directory, local feed and isolated restore cache; no checkout/source fallback.
const consumer = await realpath(reused?.consumer ?? (consumerDirectory
    ? await emptyConsumerDirectory(consumerDirectory) : await mkdtemp(join(tmpdir(), "sttropez-consumer-"))));
assert.ok(!within(project, consumer), "Consumer must remain outside the checkout.");
if (!reused) {
await cp("tests/fixtures/consumer", consumer, { recursive: true });
await mkdir(join(consumer, "feed"));
await writeFile(join(consumer, "feed/StTropez.Assets.0.0.0-local.nupkg"), archive);
await writeFile(join(consumer, "NuGet.Config"), '<configuration><packageSources><clear/><add key="local" value="feed"/></packageSources></configuration>');
}
/** @param {string[]} args */
const dotnet = args => execFileSync("dotnet", args, { cwd: consumer, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
const transitions = transitionsOnly || !reused && !skipTransitions && !pilotOnly && !prepareOnly && !benchmark
    ? await runPackageTransitions({ project, consumer, entries, assets, browserName, dotnet }) : undefined;
if (!transitionsOnly) {
if (!transitions && !reused) {
dotnet(["restore", "Consumer.csproj", "--packages", join(consumer, "packages"), "--configfile", "NuGet.Config"]);
dotnet(["msbuild", "Consumer.csproj", "-target:PrepareFrontend", "-verbosity:minimal"]);
}
const assetRoot = (await readFile(join(consumer, "assets-root.txt"), "utf8")).trim();
if (reused) assert.equal(await realpath(assetRoot), await realpath(reused.assetRoot), "Restored asset root changed between consumers.");
assert.ok(relative(consumer, await realpath(assetRoot)).replaceAll("\\", "/").startsWith("obj/sttropez/"), `Stage escaped generated directory: ${assetRoot}`);
const restored = JSON.parse(await readFile(join(consumer, "obj/project.assets.json"), "utf8"));
assert.deepEqual(Object.keys(restored.libraries), ["StTropez.Assets/0.0.0-local"]);
const restoreLibrary = Object.values(restored.targets)[0]["StTropez.Assets/0.0.0-local"];
assert.equal(restoreLibrary.compile, undefined);
assert.equal(restoreLibrary.runtime, undefined);
for (const asset of assets.assets) {
    const bytes = await readFile(join(assetRoot, asset.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
}
// The host already owns TypeScript/esbuild. Paths are an explicit frontend bridge.
const exportsResolution = reused?.exportsResolution ?? await qualifyPackageExports(project, consumer, assetRoot);
const reactHost = reactOnly ? await (await import("./package-react-host.mjs")).stagePackagedReactHost(project, consumer) : undefined;
const readinessFixture = !lspOnly && !deferredOnly ? await stageHostFixture(project, consumer, "examples/shared/readiness.ts", "readiness.ts") : undefined;
const compilerOptions = { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
    skipLibCheck: false, noEmit: true, types: [], paths: {
        sttropez: [join(assetRoot, "index.d.ts")], "sttropez/browser": [join(assetRoot, "browser/index.d.ts")],
        "sttropez/protocol": [join(assetRoot, "protocol/index.d.ts")],
    } };
if (reactHost) Object.assign(compilerOptions, reactHost.compilerOptions, { paths: { ...compilerOptions.paths, ...reactHost.compilerOptions.paths } });
const compilerFiles = lspOnly ? ["lsp.ts"] : deferredOnly ? ["activation-main.ts", workspaceOnly ? "workspace.ts" : "activate.ts"] : ["main.ts", "pilot.ts", ...(reactHost?.compilerFiles ?? [])];
await writeFile(join(consumer, "package.json"), '{"type":"module"}');
await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions, files: compilerFiles }));
const compilerOutput = execFileSync(process.execPath, [join(project, "node_modules/typescript/bin/tsc"), "-p", join(consumer, "tsconfig.json"),
    ...(reactHost ? ["--listFiles", "--pretty", "false"] : [])], { cwd: consumer, encoding: "utf8", stdio: "pipe" });
const typeInputs = [];
if (reactHost) {
    await writeFile(join(consumer, "compiler-inputs.txt"), compilerOutput);
    for (const path of compilerOutput.split(/\r?\n/).filter(Boolean)) {
        const input = await realpath(resolve(consumer, path));
        assert.ok(reactHost.allowTypeInput(input), `Unexpected declaration input leaked into consumer: ${path}`);
        typeInputs.push(input);
    }
    assert.ok(typeInputs.length >= compilerFiles.length, "Compiler input evidence is missing.");
}
// The dispatcher has its own copied consumer bridge. Its @ts-check directive checks this
// entry; imported JS callers keep their fixture-specific programs below and in other routes.
// Tool declarations use the development skipLibCheck policy. The independent consumer
// declaration compilation above always keeps skipLibCheck:false.
let dispatcherHarness;
if (scenario === "full") {
    const script = await realpath(join(project, "scripts/test-package.mjs")), fixture = join(consumer, "main.ts");
    const configuration = join(consumer, "tsconfig.dispatcher.json");
    await writeFile(configuration, JSON.stringify({ compilerOptions: { ...compilerOptions, allowJs: true, checkJs: false,
        allowImportingTsExtensions: true, skipLibCheck: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
        noUnusedLocals: true, noUnusedParameters: true, types: ["node"], typeRoots: [join(project, "node_modules/@types")] }, files: [fixture, script] }));
    const output = execFileSync(process.execPath, [join(project, "node_modules/typescript/bin/tsc"), "-p", configuration, "--listFiles", "--pretty", "false"],
        { cwd: consumer, encoding: "utf8", stdio: "pipe", windowsHide: true });
    await writeFile(join(consumer, "dispatcher-compiler-inputs.txt"), output);
    const inputs = await Promise.all(output.split(/\r?\n/).filter(Boolean).map(path => realpath(resolve(consumer, path))));
    // This tooling program also sees the Node protocol fixture's source imports. They never
    // enter the independently compiled/bundled browser consumer or the distributed assets.
    const roots = await Promise.all(["scripts", "fixtures/protocol", "fixtures/language", "src", "tests/helpers", "node_modules"].map(path => realpath(join(project, path))));
    const metadata = await realpath(join(project, "package.json"));
    for (const input of inputs) assert.ok(within(consumer, input) || input === metadata || roots.some(root => within(root, input)), `Unexpected dispatcher tooling input: ${input}`);
    assert.ok(inputs.includes(script) && inputs.includes(await realpath(fixture)), "Dispatcher checking requires its actual entry and copied consumer bridge.");
    for (const entry of ["index.d.ts", "browser/index.d.ts", "protocol/index.d.ts"]) assert.ok(inputs.includes(await realpath(join(assetRoot, entry))), `Dispatcher checking requires restored declaration: ${entry}`);
    dispatcherHarness = { checkedJavaScript: true, checkDirective: true, checkedScripts: [script], strict: true, skipLibCheck: true, inputs,
        consumerDeclarationsCheckedSeparately: true };
}
// Development harness types use the actual copied fixture, after the independent consumer
// compile above. Node/Playwright declarations belong only to this separate tooling program.
let pageLifecycleHarness, lspHarness, editingHarness;
const plainEditing = !deferredOnly && !lspOnly && !reactOnly;
const checkTransitions = scenario === "full";
if (deferredOnly || lspOnly || plainEditing) {
    const harnessName = lspOnly ? "lsp-harness" : plainEditing ? "editing-harness" : "page-lifecycle";
    const scripts = await Promise.all((lspOnly ? ["scripts/package-lsp.mjs"]
        : plainEditing ? ["scripts/package-pilot.mjs", "scripts/package-hunk-pilot.mjs", "scripts/host-typing.mjs", "scripts/host-reference-probe.mjs", "scripts/measurement.mjs",
            ...(checkTransitions ? ["scripts/package-transitions.mjs", "scripts/package-react-host.mjs", "scripts/package-host.mjs", "scripts/library-entries.mjs", "scripts/module-specifiers.mjs"] : [])]
        : ["scripts/package-page-lifecycle.mjs", workspaceOnly ? "scripts/package-workspace.mjs" : "scripts/package-activation.mjs", "tests/helpers/latch.ts"])
        .map(path => realpath(join(project, path))));
    const fixture = join(consumer, lspOnly ? "lsp.ts" : plainEditing ? "pilot.ts" : "activation-main.ts"), declarations = [];
    const fixtures = [fixture, ...(checkTransitions ? [join(consumer, "transition.ts")] : [])];
    if (plainEditing) {
        const path = join(consumer, "editing-harness.d.ts");
        await writeFile(path, `import type { mountPackagedPilot } from "./pilot.js";
import type { HostReferenceProbe } from ${JSON.stringify(join(project, "scripts/host-reference-probe.mjs").replaceAll("\\", "/"))};
type Fixture = ReturnType<typeof mountPackagedPilot>;
declare global { interface Window {
    hostFixture: Fixture;
    mountPackagedPilot(text: Parameters<typeof mountPackagedPilot>[1]): ReturnType<Fixture["snapshot"]>;
    hostReferenceProbe: HostReferenceProbe;
} }
`);
        declarations.push(path);
    }
    const configuration = join(consumer, `tsconfig.${harnessName}.json`);
    await writeFile(configuration, JSON.stringify({ compilerOptions: { ...compilerOptions, allowJs: true, checkJs: true,
        allowImportingTsExtensions: true, types: ["node"], typeRoots: [join(project, "node_modules/@types")] }, files: [...fixtures, ...declarations, ...scripts] }));
    const output = execFileSync(process.execPath, [join(project, "node_modules/typescript/bin/tsc"), "-p", configuration, "--listFiles", "--pretty", "false"],
        { cwd: consumer, encoding: "utf8", stdio: "pipe", windowsHide: true });
    await writeFile(join(consumer, `${harnessName}-compiler-inputs.txt`), output);
    const toolRoots = [...await consumerCompilerRoots(project), ...await Promise.all([
        "@types/node", "@playwright/test", "playwright", "playwright-core", "undici-types",
        ...(checkTransitions ? ["esbuild", "fflate"] : []),
    ].map(name => realpath(join(project, "node_modules", name))))];
    // The transition harness stages host imports with the development TypeScript parser.
    const toolingFiles = checkTransitions ? await Promise.all(["package.json", "node_modules/typescript-demo/lib/typescript.d.ts"].map(path => realpath(join(project, path)))) : [];
    /** @type {string[]} */ const inputs = [];
    for (const path of output.split(/\r?\n/).filter(Boolean)) {
        const input = await realpath(resolve(consumer, path));
        assert.ok(within(consumer, input) || scripts.includes(input) || toolingFiles.includes(input) || toolRoots.some(root => within(root, input)),
            `Unexpected input in the restored ${harnessName} harness: ${input}`);
        inputs.push(input);
    }
    assert.ok(scripts.every(script => inputs.includes(script)) && inputs.includes(await realpath(join(assetRoot, "browser/index.d.ts"))), "Harness inputs must include its scripts and restored declarations.");
    for (const path of fixtures) assert.ok(inputs.includes(await realpath(path)), "Harness must check the actual copied consumer fixture.");
    const harness = { checkedJavaScript: true, strict: true, skipLibCheck: false, inputs, ...(checkTransitions ? { transitionCaller: true } : {}) };
    if (lspOnly) {
        assert.ok(inputs.includes(await realpath(join(assetRoot, "protocol/index.d.ts"))), "LSP harness must use restored protocol declarations.");
        lspHarness = harness;
    } else if (plainEditing) editingHarness = harness;
    else pageLifecycleHarness = harness;
}
const bundle = await build({ absWorkingDir: consumer, entryPoints: lspOnly ? { lsp: "lsp.ts" } : deferredOnly ? { activation: "activation-main.ts", ...(workspaceOnly ? { workspace: "workspace.ts" } : { activate: "activate.ts" }) } : { app: "main.ts", pilot: "pilot.ts", ...reactHost?.entryPoints }, bundle: true, format: "esm", platform: "browser",
    ...(deferredOnly ? { splitting: true, minify: true } : {}),
    outdir: join(consumer, "site"), alias: { sttropez: assetRoot }, metafile: true,
    ...(reactHost ? { nodePaths: reactHost.nodePaths, define: { "process.env.NODE_ENV": '"development"' } } : {}),
    plugins: [{ name: "consumer-isolation", setup(builder) { builder.onEnd(result => {
        assert.ok(result.metafile, "Consumer isolation requires the completed build manifest.");
        for (const path of Object.keys(result.metafile.inputs)) {
            const input = resolve(consumer, path);
            assert.ok(reactHost ? reactHost.allowInput(input) : !within(project, input), reactHost
                ? `Unexpected host input leaked into consumer: ${path}` : `Checkout input leaked into consumer: ${path}`);
        }
    }); } }] });
await cp(join(assetRoot, "editor.css"), join(consumer, "site/editor.css"));
await cp(join(assetRoot, assets.entries.regexWorker), join(consumer, "site/regex-worker.js"));
await cp(join(assetRoot, "UNICODE-LICENSE.txt"), join(consumer, "site/UNICODE-LICENSE.txt"));
await cp(join(assetRoot, "LICENSE.txt"), join(consumer, "site/LICENSE.txt"));
await cp(join(consumer, "index.html"), join(consumer, "site/index.html"));
await cp(join(consumer, "pilot.html"), join(consumer, "site/pilot.html"));
if (reactHost) await writeFile(join(consumer, "site/react.html"), reactHost.html);
if (lspOnly) await cp(join(consumer, "lsp.html"), join(consumer, "site/lsp.html"));
if (deferredOnly) { const html = await readFile(join(consumer, "activation.html"), "utf8"); await writeFile(join(consumer, "site/activation.html"), workspaceOnly ? html.replace("<body>", "<body data-workspace>") : html); }
const activationOutputs = deferredOnly ? Object.fromEntries(Object.entries(bundle.metafile.outputs).map(([path, value]) => {
    const name = relative(join(consumer, "site"), resolve(consumer, path)).replaceAll("\\", "/"); assert.ok(!name.startsWith("..")); return [name, { bytes: value.bytes, imports: value.imports, entryPoint: value.entryPoint ?? null }];
})) : {};
await mkdir("artifacts/package", { recursive: true });
await writeFile("artifacts/package/restored-consumer.json", JSON.stringify({ schemaVersion: 1,
    packageSha256, consumer, assetRoot, reusedStage: !!reused, exportsResolution, ...(dispatcherHarness ? { dispatcherHarness } : {}), ...(pageLifecycleHarness ? { pageLifecycleHarness } : {}), ...(lspHarness ? { lspHarness } : {}), ...(editingHarness ? { editingHarness } : {}),
    browser: browserName, mode: prepareOnly ? "prepare-only" : benchmark ? "benchmark" : pilotOnly ? "pilot" : "full", scenario: lspOnly ? "lsp" : workspaceOnly ? "workspace" : activationOnly ? "activation" : reactOnly ? "react" : hunkOnly ? "hunk" : pilotOnly ? "recovery" : "all", corpus,
    declarations: { files: compilerFiles, strict: true, skipLibCheck: false, passed: true, ...(reactHost ? { inputs: typeInputs } : {}) },
    inputs: Object.keys(bundle.metafile.inputs).sort(), assets, readinessFixture,
    ...(deferredOnly ? { activationOutputs } : {}),
    ...(reactHost ? { reactHost: { sources: reactHost.sources, hostPackages: reactHost.hostPackages,
        strictMode: true, nodeEnvironment: "development", librarySourceCompilation: false,
        note: "Only project-owned development host fixtures and precompiled restored editor assets enter the consumer. React packages belong to this host; no package installation is performed." } } : {}),
    node: process.version, dotnet: dotnet(["--version"]).trim(),
    typescript: JSON.parse(await readFile("node_modules/typescript/package.json", "utf8")).version,
    esbuild: JSON.parse(await readFile("node_modules/esbuild/package.json", "utf8")).version,
}, null, 2));
if (prepareOnly) {
    console.log(`Restored ${workspaceOnly ? "workspace" : activationOnly ? "activation" : "React"} consumer declarations and isolated bundle prepared without a browser: ${consumer}`);
} else {
/** @type {unknown[]} */ const failures = [];
const requests = createPackageRequestHandler(async (request, response) => {
    assert.ok(request.url, "Consumer request requires its URL.");
    const path = new URL(request.url, "http://localhost").pathname;
    const file = { "/": lspOnly ? "lsp.html" : deferredOnly ? "activation.html" : "index.html", "/lsp.js": "lsp.js", "/app.js": "app.js", "/pilot": "pilot.html", "/pilot.js": "pilot.js", "/editor.css": "editor.css", "/regex-worker.js": "regex-worker.js", "/LICENSE.txt": "LICENSE.txt", "/UNICODE-LICENSE.txt": "UNICODE-LICENSE.txt",
        ...(deferredOnly ? Object.fromEntries(Object.keys(activationOutputs).map(name => ["/" + name, name])) : {}),
        ...(reactHost ? { "/hosts/react/": "react.html", "/host-react.js": "host-react.js", "/host-react.css": "host-react.css" } : {}) }[path];
    if (!file) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : file.endsWith("txt") ? "text/plain" : "text/html");
    response.end(await readFile(join(consumer, "site", file)));
}, failures);
const server = createServer(requests.listener);
const stopFixture = lspOnly || reactHost ? (await import("../fixtures/protocol/fixture-server.ts")).attachProtocolFixture(server) : () => {};
/** @type {import('@playwright/test').Browser | undefined} */ let browser;
try {
    await listenPackageServer(server);
    const address = server.address(); assert.ok(address && typeof address !== "string", "Consumer requires its listening TCP address.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await ({ chromium, firefox, webkit })[browserName].launch();
    if (!pilotOnly) {
    const page = await browser.newPage();
    /** @type {string[]} */ const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(baseUrl);
    assert.deepEqual(await page.evaluate(() => window.consumer.protocolExports()), { connection: "function", websocket: "function" });
    assert.deepEqual(await page.evaluate(() => window.consumer.editorExports()), { mount: "function", root: "DIV", input: "TEXTAREA", removed: [], privateNavigation: [] });
    const notice = await page.request.get(`${baseUrl}/UNICODE-LICENSE.txt`);
    assert.equal(notice.status(), 200); assert.equal(await notice.text(), await readFile("licenses/Unicode-3.0.txt", "utf8"));
    const license = await page.request.get(`${baseUrl}/LICENSE.txt`);
    assert.equal(license.status(), 200); assert.equal(await license.text(), await readFile("LICENSE.txt", "utf8"));
    const editor = page.getByRole("textbox", { name: "Consumer source" });
    await editor.fill("edited restored package");
    assert.equal(await page.evaluate(() => window.consumer.text()), "edited restored package");
    await editor.press("Control+z"); assert.equal(await page.evaluate(() => window.consumer.text()), "restored assets");
    await editor.press("Control+Shift+z"); assert.equal(await page.evaluate(() => window.consumer.text()), "edited restored package");
    const history = await page.evaluate(() => window.consumer.history()); assert.deepEqual(history, { undoDepth: 1, redoDepth: 0 });
    await page.waitForFunction(() => { const state = window.consumer.viewport(); return state.revision === 3 && !state.pending; });
    const viewport = await page.evaluate(() => window.consumer.viewport()); assert.equal(viewport.rows, 1);
    assert.equal(await page.getByRole("region", { name: "Restored viewport" }).locator(".st-viewport-row").textContent(), "edited restored package");
    const minimap = page.getByRole("region", { name: "Restored viewport" }).locator(".st-minimap");
    const track = await minimap.boundingBox(), marker = await minimap.locator(".st-minimap-marker").boundingBox();
    assert.ok(track && marker && track.height > 0 && marker.height === track.height, "Restored single-line viewport needs a full-height minimap marker.");
    const storage = await page.evaluate(() => window.consumer.storage());
    assert.deepEqual(storage, { original: "a😀\nb", exported: "aX\r\nb", readMetrics: { textExports: 1, sliceUnits: 0 }, batch: { text: "X\r\nYb", mappedEnd: 5, lineOffset: 3 }, lineCount: 2, lineOffset: 3, mappedEnd: 4,
        anchor: { from: 2, to: 4, fromAffinity: "after", toAffinity: "before", onDelete: "collapse" } });
    const style = await page.locator("#editor .st-viewport").evaluate(element => { const style = getComputedStyle(element); return { color: style.color, background: style.backgroundColor, padding: style.paddingTop }; });
    assert.deepEqual(style, { color: "rgb(225, 231, 239)", background: "rgb(19, 27, 39)", padding: "0px" });
    const candidateInput = page.getByRole("textbox", { name: "Restored candidate" });
    await candidateInput.focus(); await candidateInput.press("Control+Home"); await candidateInput.press("!");
    assert.equal(await page.evaluate(() => window.consumer.text()), "!edited restored package");
    await page.waitForFunction(() => { const state = window.consumer.candidate(); return state.viewport.revision === 4 && !state.viewport.pending; });
    const candidate = await page.evaluate(() => window.consumer.candidate());
    assert.equal(candidate.commits, 1); assert.ok(candidate.inputUnits <= 2600);
    assert.equal(await candidateInput.evaluate(element => getComputedStyle(element).width), "1px");
    await candidateInput.press("Control+z"); assert.equal(await page.evaluate(() => window.consumer.text()), "edited restored package");
    for (const target of [candidateInput, editor]) {
        await target.press("Control+Home"); const depth = (await page.evaluate(() => window.consumer.history())).undoDepth;
        await target.pressSequentially("abedited");
        assert.equal(await page.evaluate(() => window.consumer.text()), "abeditededited restored package");
        assert.equal((await page.evaluate(() => window.consumer.history())).undoDepth, depth + 1);
        await target.press("Control+z"); assert.equal(await page.evaluate(() => window.consumer.text()), "edited restored package");
        await target.press("Control+Shift+z"); assert.equal(await page.evaluate(() => window.consumer.text()), "abeditededited restored package");
        await target.press("Control+z"); assert.equal(await page.evaluate(() => window.consumer.text()), "edited restored package");
    }
    await candidateInput.press("Control+Home"); await candidateInput.press("Space"); await candidateInput.press("Tab");
    assert.equal(await page.evaluate(() => window.consumer.text()), "    edited restored package");
    await candidateInput.press("Backspace");
    assert.equal(await page.evaluate(() => window.consumer.text()), "edited restored package");
    const capturedSelection = await candidateInput.evaluate(input => { if (!(input instanceof HTMLTextAreaElement)) throw new Error("Restored input requires its native textarea."); input.setSelectionRange(2, 5, "backward"); return window.consumer.captureCandidate(); });
    assert.equal(capturedSelection.anchor, 5); assert.equal(capturedSelection.head, 2);
    const navigation = await page.evaluate(() => window.consumer.navigation());
    assert.equal(navigation.offset, 100_002); assert.ok(navigation.advances > 1); assert.equal(navigation.exports, 0);
    assert.equal(navigation.runOffset, 100_000); assert.ok(navigation.runAdvances > 1);
    await candidateInput.press("Control+Home"); await candidateInput.press("Control+ArrowRight");
    assert.equal((await page.evaluate(() => window.consumer.captureCandidate())).head, 6);
    await candidateInput.press("Control+Shift+ArrowRight");
    assert.deepEqual(await page.evaluate(() => { const s = window.consumer.captureCandidate(); return { anchor: s.anchor, head: s.head }; }), { anchor: 6, head: 15 });
    await page.waitForFunction(() => document.querySelector("#candidate .consumer-token")?.textContent === "restored");
    const wordPoint = await page.locator("#candidate .st-editor").evaluate(element => {
        const row = element.querySelector(".st-viewport-row"); if (!row) throw new Error("Missing restored word row.");
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        /** @type {Text[]} */ const nodes = []; let node;
        while (node = walker.nextNode()) nodes.push(/** @type {Text} */ (node));
        /** @param {number} offset */
        const locate = offset => { for (const node of nodes) { if (offset <= node.length) return { node, offset }; offset -= node.length; } throw new Error("Missing restored word."); };
        const a = locate(9), b = locate(10), range = document.createRange(); range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset); const r = range.getBoundingClientRect(); return { x: r.left + r.width * .25, y: r.top + r.height * .5 };
    });
    await page.mouse.dblclick(wordPoint.x, wordPoint.y);
    await page.waitForFunction(() => { const s = window.consumer.candidate(); return !s.pendingWord && !s.pendingGrapheme && !s.pendingCaret && !s.viewport.pending; });
    const wordSelection = await page.evaluate(() => ({ selection: window.consumer.captureCandidate(), events: window.consumer.candidate().wordSelectionEvents, handlerMs: window.consumer.candidate().lastWordSelectionMs, callbackMaximumMs: window.consumer.candidate().maxWordSelectionTurnMs }));
    assert.equal(wordSelection.selection.anchor, 7); assert.equal(wordSelection.selection.head, 15); assert.equal(wordSelection.events, 1);
    const wordUndoDepth = (await page.evaluate(() => window.consumer.history())).undoDepth;
    await candidateInput.pressSequentially("q"); assert.equal(await page.evaluate(() => window.consumer.text()), "edited q package"); assert.equal((await page.evaluate(() => window.consumer.history())).undoDepth, wordUndoDepth + 1);
    await candidateInput.press("Control+z"); assert.equal(await page.evaluate(() => window.consumer.text()), "edited restored package");
    await page.waitForFunction(() => document.querySelector("#candidate .consumer-token")?.textContent === "restored");
    await page.evaluate(() => { window.consumer.findOptions({ wholeWord: true }); window.consumer.find("stored"); });
    await page.waitForFunction(() => window.consumer.findState().status === "ready");
    assert.equal((await page.evaluate(() => window.consumer.findState())).count, 0);
    await page.evaluate(() => window.consumer.find("restored"));
    await page.waitForFunction(() => window.consumer.findState().status === "ready");
    const find = await page.evaluate(() => window.consumer.findState()); assert.equal(find.count, 1); assert.equal(find.wholeWord, true);
    await page.evaluate(() => { window.consumer.findOptions({ wholeWord: true, matchCase: false }); window.consumer.find("RESTORED"); });
    await page.waitForFunction(() => window.consumer.findState().status === "ready");
    const caseFind = await page.evaluate(() => window.consumer.findState()); assert.equal(caseFind.count, 1); assert.equal(caseFind.matchCase, false); assert.equal(caseFind.wholeWord, true);
    assert.deepEqual(await page.evaluate(() => window.consumer.findMatches(8, 10, window.consumer.findState())), [{ from: 7, to: 15 }]);
    const regex = await page.evaluate(() => window.consumer.regexPilot());
    for (const measurements of [regex.measurements, regex.terminalMeasurements]) {
        assert.ok(Number.isFinite(measurements.maxScanStepMs) && measurements.maxScanStepMs >= 0);
        assert.ok(Number.isFinite(measurements.replaceTransactionMs) && measurements.replaceTransactionMs >= 0);
    }
    assert.equal(regex.actualWorker, true); assert.equal(regex.zeroCompleteExports, true); assert.deepEqual(regex.released, { views: 0, leases: 0, subscriptions: 0 });
    const folding = await page.evaluate(() => window.consumer.foldingPilot());
    assert.equal(folding.visibleRows, 2); assert.equal(folding.newerStatePreserved, true); assert.deepEqual(folding.released, { views: 0, leases: 0, subscriptions: 0 });
    const clipboardBoundary = await page.evaluate(() => window.consumer.clipboardBoundary());
    assert.equal(clipboardBoundary.cancelledOwnership, true); assert.equal(clipboardBoundary.emptyPayloadNoDeletion, true); assert.equal(clipboardBoundary.completeSets, true); assert.deepEqual(clipboardBoundary.released, { views: 0, leases: 0, subscriptions: 0 });
    const selectionSets = await page.evaluate(() => window.consumer.selectionSets());
    assert.equal(selectionSets.changed, "XbcX"); assert.equal(selectionSets.restored, "abcd");
    assert.deepEqual(selectionSets.restoredSet, selectionSets.before); assert.equal(selectionSets.after.ranges.length, 2); assert.equal(selectionSets.after.primary, 1);
    assert.equal(selectionSets.alias, true); assert.equal(selectionSets.views, 0); assert.equal(selectionSets.leases, 0);
    assert.equal(selectionSets.browserSelections.length, 2);
    for (const state of selectionSets.browserSelections) {
        assert.deepEqual(state.captured, selectionSets.before); assert.deepEqual(state.fullSet, selectionSets.before);
        assert.equal(state.legacy.ranges.length, 1); const range = state.legacy.ranges[0]; assert.ok(range); assert.equal(range.anchor, 2); assert.equal(range.head, 2);
    }
    await page.evaluate(() => window.consumer.beginMultipleInput()); await page.waitForFunction(() => !window.consumer.multipleInput().pending);
    const multipleBefore = await page.evaluate(() => window.consumer.multipleInput()), multipleEditor = page.getByRole("textbox", { name: "Restored multiple input", exact: true });
    await multipleEditor.pressSequentially("xy"); await page.waitForFunction(() => !window.consumer.multipleInput().pending);
    const multipleAfter = await page.evaluate(() => window.consumer.multipleInput()); assert.equal(multipleAfter.text, "xybcxy"); assert.equal(multipleAfter.revision, 2); assert.equal(multipleAfter.commits, 2); assert.equal(multipleAfter.exports, 0);
    await multipleEditor.press("Control+z"); await page.waitForFunction(() => !window.consumer.multipleInput().pending);
    const multipleUndone = await page.evaluate(() => window.consumer.multipleInput()); assert.equal(multipleUndone.text, "abcd"); assert.deepEqual(multipleUndone.selectionSet, multipleBefore.selectionSet);
    await multipleEditor.press("Control+Shift+z"); assert.equal((await page.evaluate(() => window.consumer.multipleInput())).text, "xybcxy");
    await multipleEditor.press("Shift+ArrowLeft"); await page.waitForFunction(() => !window.consumer.multipleInput().pending);
    const multipleNavigation = await page.evaluate(() => window.consumer.multipleInput());
    assert.deepEqual(multipleNavigation.selectionSet.ranges.map(({ anchor, head }) => ({ anchor, head })), [{ anchor: 2, head: 1 }, { anchor: 6, head: 5 }]);
    await multipleEditor.press("Escape"); await page.waitForFunction(() => !window.consumer.multipleInput().pending);
    assert.deepEqual((await page.evaluate(() => window.consumer.multipleInput())).selectionSet.ranges, [multipleNavigation.selectionSet.ranges[multipleNavigation.selectionSet.primary]]);
    await page.evaluate(() => window.consumer.prepareMultipleEnd()); await page.waitForFunction(() => !window.consumer.multipleInput().pending);
    await multipleEditor.press("End"); await page.waitForFunction(() => !window.consumer.multipleInput().pending);
    const multipleLiteralEnd = await page.evaluate(() => window.consumer.multipleInput());
    assert.equal(multipleLiteralEnd.text, "a\r\nb\r"); assert.equal(multipleLiteralEnd.exports, 0);
    assert.deepEqual(multipleLiteralEnd.selectionSet.ranges.map(({ anchor, head }) => ({ anchor, head })), [{ anchor: 1, head: 1 }, { anchor: 5, head: 5 }]);
    await multipleEditor.press("ArrowUp"); await page.waitForFunction(() => !window.consumer.multipleInput().pending);
    const multipleVertical = await page.evaluate(() => window.consumer.multipleInput());
    assert.deepEqual(multipleVertical.selectionSet.ranges.map(({ anchor, head }) => ({ anchor, head })), [{ anchor: 0, head: 0 }, { anchor: 1, head: 1 }]);
    const multipleReleased = await page.evaluate(() => window.consumer.finishMultipleInput()); assert.deepEqual(multipleReleased, { views: 0, leases: 0 });
    const multipleInput = { before: multipleBefore, after: multipleAfter, undone: multipleUndone, navigation: multipleNavigation, vertical: multipleVertical, literalEnd: multipleLiteralEnd, released: multipleReleased };
    await page.evaluate(() => window.consumer.replaceAll("packed"));
    await page.waitForFunction(() => window.consumer.findState().status === "ready" && window.consumer.findState().count === 0);
    assert.equal(await page.evaluate(() => window.consumer.text()), "edited packed package");
    await candidateInput.press("Control+z"); assert.equal(await page.evaluate(() => window.consumer.text()), "edited restored package");
    await page.waitForFunction(() => { const s = window.consumer.comparison(); return s.status === "ready" && !s.working.pending && s.reference && !s.reference.pending; });
    const findAuthority = await page.evaluate(() => window.consumer.findAuthority());
    assert.equal(findAuthority.cases.length, 2); assert.ok(findAuthority.cases.every(c => c.cancelled && c.explicitRetry && c.sharedUndoSets && c.noOpReleased && c.zeroCompleteExports));
    const readonlyIndent = [];
    for (const outdent of [false, true]) {
        const result = await page.evaluate(outdent => window.consumer.readonlyIndent(outdent), outdent);
        assert.deepEqual(result.refusals, ["read-only", "edit-locked"]);
        assert.equal(result.lockedAtHandler, true); assert.equal(result.revision, 0); assert.equal(result.sameText, true);
        assert.equal(result.undoAfter, result.undoBefore); assert.equal(result.exports, 0); readonlyIndent.push(result);
    }
    await page.getByRole("checkbox", { name: "Align review rows", exact: true }).check();
    await page.waitForFunction(() => { const s = window.consumer.comparison(); return s.status === "ready" && !s.working.pending && s.reference && !s.reference.pending
        && s.working.aligned && s.reference.aligned && s.working.alignmentId === s.reference.alignmentId; });
    const comparison = await page.evaluate(() => window.consumer.comparison()); assert.equal(comparison.count, 1);
    const { generation, steps, maxStepMs, totalStepMs } = comparison.measurements;
    assert.equal(generation, comparison.generation); assert.ok(steps > 0);
    assert.ok(Number.isFinite(totalStepMs) && totalStepMs >= maxStepMs && maxStepMs >= 0);
    assert.equal(comparison.internalBaseline, true);
    assert.equal(await page.locator("#comparison .consumer-review-token.st-comparison-added").textContent(), "working");
    assert.equal(await page.locator("#comparison .consumer-review-token.st-comparison-removed").textContent(), "baseline");
    assert.deepEqual(await page.evaluate(() => window.consumer.diff()), { status: "ready", whitespaceOnly: true });
    const oldHunk = await page.evaluateHandle(() => {
        const hunk = window.consumer.hunkAt(0);
        if (!hunk) throw new Error("Expected an exact comparison hunk.");
        return hunk;
    });
    assert.equal(await oldHunk.evaluate(hunk => hunk.select()), true);
    const selectedComparison = await page.evaluate(() => window.consumer.comparison());
    assert.equal(selectedComparison.selectedHunk, 0); assert.equal(selectedComparison.canNavigate, true); assert.equal(selectedComparison.canRevert, true);
    await page.getByRole("button", { name: "Use baseline", exact: true }).click();
    await page.waitForFunction(() => window.consumer.comparison().status === "ready" && window.consumer.comparison().count === 0);
    assert.equal(await page.evaluate(() => window.consumer.acceptComparison()), true);
    await page.waitForFunction(() => window.consumer.comparison().version === "accepted-2");
    const retainedComparison = await page.evaluate(() => window.consumer.comparison());
    assert.equal(await page.evaluate(() => window.consumer.remountComparison()), true);
    await page.waitForFunction(() => { const s = window.consumer.comparison(); return s.status === "ready" && !s.working.pending
        && JSON.stringify(s.working.selection) === JSON.stringify(s.selection); });
    const remountedComparison = await page.evaluate(() => window.consumer.comparison());
    assert.deepEqual(await oldHunk.evaluate(hunk => [hunk.select(), hunk.revert()]), [false, false]);
    await oldHunk.dispose();
    assert.equal(remountedComparison.internalBaseline, true);
    assert.equal(remountedComparison.viewId, retainedComparison.viewId); assert.deepEqual(remountedComparison.selection, retainedComparison.selection);
    const saveReview = await page.evaluate(() => window.consumer.saveReview());
    assert.deepEqual(saveReview, { baselineBefore: "v0", precondition: "v1", saved: "saved", textAfter: "merged later", dirtyAfter: true,
        cleanAfterUndo: true, serverVersion: "v2", leases: 0 });
    const graphemes = await page.evaluate(() => window.consumer.graphemes());
    assert.deepEqual(graphemes, { version: "18.0.0", boundaries: [0, 4, 9, 11], coordinate: "buffer", released: true, exports: 0 });
    const font = await page.evaluate(() => window.consumer.font());
    assert.equal(font.status, "ready"); assert.equal(font.current, true); assert.equal(font.released, true); assert.ok(Math.abs(font.width - 60) < .05);
    assert.deepEqual(errors, []);
    await mkdir("artifacts/package", { recursive: true });
    await page.screenshot({ path: "artifacts/package/consumer.png" });
    await writeFile("artifacts/package/report.json", JSON.stringify({ schemaVersion: 1,
        packageSha256: createHash("sha256").update(archive).digest("hex"), entries: Object.keys(entries).sort(),
        consumer, browser: browser.version(), node: process.version, dotnet: dotnet(["--version"]).trim(),
        typescript: JSON.parse(await readFile("node_modules/typescript/package.json", "utf8")).version,
        esbuild: JSON.parse(await readFile("node_modules/esbuild/package.json", "utf8")).version,
        actualText: await editor.inputValue(), storage, history, viewport, candidate, capturedSelection, navigation, wordSelection, font, graphemes, find, caseFind, regex, folding, clipboardBoundary, selectionSets, multipleInput, comparison, readonlyIndent, findAuthority, saveReview, style, errors }, null, 2));
    console.log("Restored package: declarations, storage/mappings, modules, visible CSS and actual edit passed. Evidence: artifacts/package/");
    console.log(`Isolated consumer: ${consumer}`);
    await page.close();
    }
    if (reactOnly) {
        const { runPackagedReactPilot } = await import("./package-react-pilot.mjs");
        await runPackagedReactPilot(browser, baseUrl, {
            directory: "artifacts/package", packageSha256: createHash("sha256").update(archive).digest("hex"), benchmark,
        });
        if (!benchmark) {
            const { runPackagedTablePaste } = await import("./package-table-paste.mjs");
            await runPackagedTablePaste(browser, baseUrl, { directory: "artifacts/package", packageSha256: createHash("sha256").update(archive).digest("hex") });
        }
    }
    if (activationOnly) {
        const { runPackagedActivation } = await import("./package-activation.mjs");
        await runPackagedActivation(browser, baseUrl, { directory: "artifacts/package", packageSha256: createHash("sha256").update(archive).digest("hex"), outputs: activationOutputs, corpus,
            assetBytes: { css: assets.assets.filter(a => a.path.endsWith(".css")), workers: assets.assets.filter(a => a.path === assets.entries.regexWorker) } });
    }
    if (workspaceOnly) {
        const { runPackagedWorkspace } = await import("./package-workspace.mjs");
        await runPackagedWorkspace(browser, baseUrl, { directory: "artifacts/package", packageSha256: createHash("sha256").update(archive).digest("hex"), outputs: activationOutputs, corpus });
    }
    if (lspOnly) {
        const { runPackagedLsp } = await import("./package-lsp.mjs");
        await runPackagedLsp(browser, baseUrl, { packageSha256: createHash("sha256").update(archive).digest("hex") });
    }
    if (!deferredOnly && !reactOnly && !lspOnly && !hunkOnly) await runPackagedPilot(browser, baseUrl, {
        directory: "artifacts/package", packageSha256: createHash("sha256").update(archive).digest("hex"), benchmark,
    });
    if (!reactOnly && (hunkOnly || !pilotOnly)) await runPackagedHunkPilot(browser, baseUrl, {
        directory: "artifacts/package", packageSha256: createHash("sha256").update(archive).digest("hex"), benchmark,
    });
    console.log(`Restored integrated pilot passed in ${browserName}. Consumer: ${consumer}`);
} catch (error) { failures.push(error); }
finally {
    await closePackageResources([() => browser?.close(), stopFixture, () => closePackageServer(server), () => requests.settled()], failures);
}
}
}
