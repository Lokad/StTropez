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

const hunkOnly = process.argv.includes("--hunk-only");
const reactOnly = process.argv.includes("--react-only"), prepareOnly = process.argv.includes("--prepare-only");
const pilotOnly = reactOnly || hunkOnly || process.argv.includes("--pilot-only"), benchmark = process.argv.includes("--bench");
const browserName = process.argv.find(arg => arg.startsWith("--browser="))?.slice("--browser=".length) ?? "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(browserName), `Unknown browser: ${browserName}`);
assert.ok(!benchmark || pilotOnly, "Use --pilot-only, --hunk-only or --react-only with --bench to keep the workload explicit.");
assert.ok(!reactOnly || (!hunkOnly && !process.argv.includes("--pilot-only")), "Select one restored pilot scenario.");
assert.ok(!prepareOnly || (reactOnly && !benchmark), "Preparation-only checks require --react-only without --bench.");

const project = resolve(".");
const archive = await readFile("artifacts/nuget/feed/StTropez.Assets.0.0.0-local.nupkg");
const entries = unzipSync(archive);
const assets = JSON.parse(strFromU8(entries["assets/manifest.json"]));
assert.equal(strFromU8(entries["assets/UNICODE-LICENSE.txt"]), await readFile("licenses/Unicode-3.0.txt", "utf8"));
const allowlist = new Set(["[Content_Types].xml", "_rels/.rels", "StTropez.Assets.nuspec", "README.md",
    "build/StTropez.Assets.props", "build/StTropez.Assets.targets", "assets/manifest.json",
    ...assets.assets.map(asset => `assets/${asset.path}`)]);
for (const [path, bytes] of Object.entries(entries)) {
    if (path.endsWith("/")) continue;
    assert.ok(allowlist.has(path) || /^package\/services\/metadata\/core-properties\/[^/]+\.psmdcp$/.test(path), `Unexpected package entry: ${path}`);
    assert.ok(!path.includes("..") && !path.startsWith("/"));
    if (path.startsWith("assets/") && path !== "assets/manifest.json") {
        const asset = assets.assets.find(asset => `assets/${asset.path}` === path);
        assert.equal(bytes.length, asset.bytes);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
    }
}
for (const path of allowlist) assert.ok(entries[path], `Missing package entry: ${path}`);
const nuspec = strFromU8(entries["StTropez.Assets.nuspec"]);
assert.ok(!/<dependency\b/.test(nuspec), "Package must not depend on managed or third-party packages.");

// Separate directory, local feed and isolated restore cache; no checkout/source fallback.
const consumer = await realpath(await mkdtemp(join(tmpdir(), "sttropez-consumer-")));
await cp("tests/fixtures/consumer", consumer, { recursive: true });
await mkdir(join(consumer, "feed"));
await writeFile(join(consumer, "feed/StTropez.Assets.0.0.0-local.nupkg"), archive);
await writeFile(join(consumer, "NuGet.Config"), '<configuration><packageSources><clear/><add key="local" value="feed"/></packageSources></configuration>');
const dotnet = args => execFileSync("dotnet", args, { cwd: consumer, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
dotnet(["restore", "Consumer.csproj", "--packages", join(consumer, "packages"), "--configfile", "NuGet.Config"]);
dotnet(["msbuild", "Consumer.csproj", "-target:PrepareFrontend", "-verbosity:minimal"]);
const assetRoot = (await readFile(join(consumer, "assets-root.txt"), "utf8")).trim();
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
const reactHost = reactOnly ? await (await import("./package-react-host.mjs")).stagePackagedReactHost(project, consumer) : undefined;
const compilerOptions = { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
    skipLibCheck: false, noEmit: true, types: [], paths: {
        sttropez: [join(assetRoot, "index.d.ts")], "sttropez/browser": [join(assetRoot, "browser/index.d.ts")],
    } };
if (reactHost) Object.assign(compilerOptions, reactHost.compilerOptions, { paths: { ...compilerOptions.paths, ...reactHost.compilerOptions.paths } });
const compilerFiles = ["main.ts", "pilot.ts", ...(reactHost?.compilerFiles ?? [])];
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
const bundle = await build({ absWorkingDir: consumer, entryPoints: { app: "main.ts", pilot: "pilot.ts", ...reactHost?.entryPoints }, bundle: true, format: "esm", platform: "browser",
    outdir: join(consumer, "site"), alias: { sttropez: assetRoot }, metafile: true,
    ...(reactHost ? { nodePaths: reactHost.nodePaths, define: { "process.env.NODE_ENV": '"development"' } } : {}),
    plugins: [{ name: "consumer-isolation", setup(builder) { builder.onEnd(result => {
        for (const path of Object.keys(result.metafile.inputs)) {
            const input = resolve(consumer, path);
            assert.ok(reactHost ? reactHost.allowInput(input) : !input.startsWith(project), reactHost
                ? `Unexpected host input leaked into consumer: ${path}` : `Checkout input leaked into consumer: ${path}`);
        }
    }); } }] });
await cp(join(assetRoot, "editor.css"), join(consumer, "site/editor.css"));
await cp(join(assetRoot, assets.entries.regexWorker), join(consumer, "site/regex-worker.js"));
await cp(join(assetRoot, "UNICODE-LICENSE.txt"), join(consumer, "site/UNICODE-LICENSE.txt"));
await cp(join(consumer, "index.html"), join(consumer, "site/index.html"));
await cp(join(consumer, "pilot.html"), join(consumer, "site/pilot.html"));
if (reactHost) await writeFile(join(consumer, "site/react.html"), reactHost.html);
await mkdir("artifacts/package", { recursive: true });
await writeFile("artifacts/package/restored-consumer.json", JSON.stringify({ schemaVersion: 1,
    packageSha256: createHash("sha256").update(archive).digest("hex"), consumer, assetRoot,
    browser: browserName, mode: prepareOnly ? "prepare-only" : benchmark ? "benchmark" : pilotOnly ? "pilot" : "full", scenario: reactOnly ? "react" : hunkOnly ? "hunk" : pilotOnly ? "recovery" : "all",
    declarations: { files: compilerFiles, strict: true, skipLibCheck: false, passed: true, ...(reactHost ? { inputs: typeInputs } : {}) },
    inputs: Object.keys(bundle.metafile.inputs).sort(), assets,
    ...(reactHost ? { reactHost: { sources: reactHost.sources, hostPackages: reactHost.hostPackages,
        strictMode: true, nodeEnvironment: "development", librarySourceCompilation: false,
        note: "Only project-owned development host fixtures and precompiled restored editor assets enter the consumer. React packages belong to this host; no package installation is performed." } } : {}),
    node: process.version, dotnet: dotnet(["--version"]).trim(),
    typescript: JSON.parse(await readFile("node_modules/typescript/package.json", "utf8")).version,
    esbuild: JSON.parse(await readFile("node_modules/esbuild/package.json", "utf8")).version,
}, null, 2));
if (prepareOnly) {
    console.log(`Restored React consumer declarations and isolated bundle prepared without a browser: ${consumer}`);
} else {
const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    const file = { "/": "index.html", "/app.js": "app.js", "/pilot": "pilot.html", "/pilot.js": "pilot.js", "/editor.css": "editor.css", "/regex-worker.js": "regex-worker.js", "/UNICODE-LICENSE.txt": "UNICODE-LICENSE.txt",
        ...(reactHost ? { "/hosts/react/": "react.html", "/host-react.js": "host-react.js", "/host-react.css": "host-react.css", "/provider-worker.js": "provider-worker.js" } : {}) }[path];
    if (!file) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : file.endsWith("txt") ? "text/plain" : "text/html");
    response.end(await readFile(join(consumer, "site", file)));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
    browser = await ({ chromium, firefox, webkit })[browserName].launch();
    if (!pilotOnly) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const notice = await page.request.get(`http://127.0.0.1:${server.address().port}/UNICODE-LICENSE.txt`);
    assert.equal(notice.status(), 200); assert.equal(await notice.text(), await readFile("licenses/Unicode-3.0.txt", "utf8"));
    const editor = page.getByRole("textbox", { name: "Consumer source" });
    await editor.fill("edited restored package");
    assert.equal(await page.evaluate(() => window.consumer.text()), "edited restored package");
    await editor.press("Control+z"); assert.equal(await page.evaluate(() => window.consumer.text()), "restored assets");
    await editor.press("Control+Shift+z"); assert.equal(await page.evaluate(() => window.consumer.text()), "edited restored package");
    const history = await page.evaluate(() => window.consumer.history()); assert.deepEqual(history, { undoDepth: 1, redoDepth: 0 });
    await page.waitForFunction(() => { const state = window.consumer.viewport(); return state.revision === 3 && !state.pending; });
    const viewport = await page.evaluate(() => window.consumer.viewport()); assert.equal(viewport.rows, 1);
    assert.equal(await page.getByRole("region", { name: "Restored viewport" }).locator(".st-viewport-row").textContent(), "edited restored package");
    const storage = await page.evaluate(() => window.consumer.storage());
    assert.deepEqual(storage, { original: "a😀\nb", exported: "aX\r\nb", readMetrics: { textExports: 1, sliceUnits: 0 }, batch: { text: "X\r\nYb", mappedEnd: 5, lineOffset: 3 }, lineCount: 2, lineOffset: 3, mappedEnd: 4,
        anchor: { from: 2, to: 4, fromAffinity: "after", toAffinity: "before", onDelete: "collapse" } });
    const style = await editor.evaluate(element => { const style = getComputedStyle(element); return { color: style.color, background: style.backgroundColor, padding: style.paddingTop }; });
    assert.deepEqual(style, { color: "rgb(225, 231, 239)", background: "rgb(19, 27, 39)", padding: "20px" });
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
    const capturedSelection = await candidateInput.evaluate(input => { input.setSelectionRange(2, 5, "backward"); return window.consumer.captureCandidate(); });
    assert.equal(capturedSelection.anchor, 5); assert.equal(capturedSelection.head, 2);
    const navigation = await page.evaluate(() => window.consumer.navigation());
    assert.equal(navigation.offset, 100_002); assert.ok(navigation.advances > 1); assert.equal(navigation.exports, 0);
    assert.equal(navigation.runOffset, 100_000); assert.ok(navigation.runAdvances > 1);
    await candidateInput.press("Control+Home"); await candidateInput.press("Control+ArrowRight");
    assert.equal((await page.evaluate(() => window.consumer.captureCandidate())).head, 7);
    await candidateInput.press("Control+Shift+ArrowRight");
    assert.deepEqual(await page.evaluate(() => { const s = window.consumer.captureCandidate(); return { anchor: s.anchor, head: s.head }; }), { anchor: 7, head: 16 });
    await page.waitForFunction(() => document.querySelector("#candidate .consumer-token")?.textContent === "restored");
    const wordPoint = await page.locator("#candidate .st-editing-candidate").evaluate(element => {
        const row = element.querySelector(".st-viewport-row"), walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), nodes = []; let node;
        while (node = walker.nextNode()) nodes.push(node);
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
    const regex = await page.evaluate(() => window.consumer.regexPilot());
    assert.equal(regex.actualWorker, true); assert.equal(regex.zeroCompleteExports, true); assert.deepEqual(regex.released, { views: 0, leases: 0, subscriptions: 0 });
    const selectionSets = await page.evaluate(() => window.consumer.selectionSets());
    assert.equal(selectionSets.changed, "XbcX"); assert.equal(selectionSets.restored, "abcd");
    assert.deepEqual(selectionSets.restoredSet, selectionSets.before); assert.equal(selectionSets.after.ranges.length, 2); assert.equal(selectionSets.after.primary, 1);
    assert.equal(selectionSets.alias, true); assert.equal(selectionSets.views, 0); assert.equal(selectionSets.leases, 0);
    assert.equal(selectionSets.browserSelections.length, 3);
    for (const state of selectionSets.browserSelections) {
        assert.deepEqual(state.captured, selectionSets.before); assert.deepEqual(state.fullSet, selectionSets.before);
        assert.equal(state.legacy.ranges.length, 1); assert.equal(state.legacy.ranges[0].anchor, 2); assert.equal(state.legacy.ranges[0].head, 2);
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
    const multipleColumn = await page.evaluate(() => window.consumer.multipleColumn(1)); assert.equal(multipleColumn.caret.offset, 1); assert.ok(multipleColumn.column > 0);
    await multipleEditor.press("Escape"); await page.waitForFunction(() => !window.consumer.multipleInput().pending);
    assert.deepEqual((await page.evaluate(() => window.consumer.multipleInput())).selectionSet.ranges, [multipleNavigation.selectionSet.ranges[multipleNavigation.selectionSet.primary]]);
    await page.evaluate(() => window.consumer.prepareMultipleEnd()); await page.waitForFunction(() => !window.consumer.multipleInput().pending);
    await multipleEditor.press("End"); await page.waitForFunction(() => !window.consumer.multipleInput().pending);
    const multipleLiteralEnd = await page.evaluate(() => window.consumer.multipleInput());
    assert.equal(multipleLiteralEnd.text, "a\r\nb\r"); assert.equal(multipleLiteralEnd.exports, 0);
    assert.deepEqual(multipleLiteralEnd.selectionSet.ranges.map(({ anchor, head }) => ({ anchor, head })), [{ anchor: 1, head: 1 }, { anchor: 5, head: 5 }]);
    const multipleReleased = await page.evaluate(() => window.consumer.finishMultipleInput()); assert.deepEqual(multipleReleased, { views: 0, leases: 0 });
    const multipleInput = { before: multipleBefore, after: multipleAfter, undone: multipleUndone, navigation: multipleNavigation, column: multipleColumn, literalEnd: multipleLiteralEnd, released: multipleReleased };
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
        assert.equal(result.lockedAtHandler, true); assert.equal(result.revision, 0); assert.equal(result.sameText, true);
        assert.equal(result.undoAfter, result.undoBefore); assert.equal(result.exports, 0); readonlyIndent.push(result);
    }
    const comparison = await page.evaluate(() => window.consumer.comparison()); assert.equal(comparison.count, 1);
    assert.equal(await page.locator("#comparison .consumer-review-token.st-comparison-added").textContent(), "working");
    assert.equal(await page.locator("#comparison .consumer-review-token.st-comparison-removed").textContent(), "baseline");
    assert.deepEqual(await page.evaluate(() => window.consumer.diff()), { status: "ready", whitespaceOnly: true });
    await page.getByRole("button", { name: "Next change", exact: true }).click();
    await page.getByRole("button", { name: "Use baseline", exact: true }).click();
    await page.waitForFunction(() => window.consumer.comparison().status === "ready" && window.consumer.comparison().count === 0);
    assert.equal(await page.evaluate(() => window.consumer.acceptComparison()), true);
    await page.waitForFunction(() => window.consumer.comparison().version === "accepted-2");
    const retainedComparison = await page.evaluate(() => window.consumer.comparison());
    assert.equal(await page.evaluate(() => window.consumer.remountComparison()), true);
    await page.waitForFunction(() => { const s = window.consumer.comparison(); return s.status === "ready" && !s.working.pending
        && JSON.stringify(s.working.selection) === JSON.stringify(s.selection); });
    const remountedComparison = await page.evaluate(() => window.consumer.comparison());
    assert.equal(remountedComparison.viewId, retainedComparison.viewId); assert.deepEqual(remountedComparison.selection, retainedComparison.selection);
    const saveReview = await page.evaluate(() => window.consumer.saveReview());
    assert.deepEqual(saveReview, { baselineBefore: "v0", precondition: "v1", saved: "saved", textAfter: "merged later", dirtyAfter: true,
        cleanAfterUndo: true, serverVersion: "v2", leases: 0 });
    const bidi = await page.evaluate(() => window.consumer.bidi());
    assert.deepEqual(bidi.levels, [0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0]);
    assert.deepEqual(bidi.order, [0, 1, 2, 3, 6, 5, 4, 7, 8, 9, 10]);
    await page.evaluate(() => window.consumer.bidiSample());
    await page.waitForFunction(() => !window.consumer.candidate().viewport.pending);
    await candidateInput.press("ArrowLeft");
    assert.equal((await page.evaluate(() => window.consumer.captureCandidate())).head, 5);
    await candidateInput.press("ArrowRight");
    assert.equal((await page.evaluate(() => window.consumer.captureCandidate())).head, 4);
    assert.ok((await page.evaluate(() => window.consumer.candidate())).visualMoves >= 2);
    const paragraph = await page.evaluate(() => window.consumer.paragraph());
    assert.ok(paragraph.advances > 1); assert.equal(paragraph.level, 1); assert.equal(paragraph.retainedLevel, 1); assert.equal(paragraph.exports, 0);
    assert.equal(paragraph.current, true); assert.equal(paragraph.mainLevel, 1); assert.equal(paragraph.rejected, true); assert.equal(paragraph.releasedLease, true); assert.equal(paragraph.sourceRevision, true);
    const advances = await page.evaluate(() => window.consumer.advances());
    assert.equal(advances.total, 77_400_000); assert.equal(advances.changedTotal, 77_399_969); assert.equal(advances.origin, 2_399_980 * 32.25);
    assert.equal(advances.cells, 10); assert.equal(advances.first, 2_399_980); assert.ok(advances.readValues <= 512); assert.equal(advances.truncated, false);
    assert.ok(advances.retained.values < 2_401_024); assert.equal(advances.disposed, "disposed"); assert.deepEqual(advances.signed, [{ index: 1, from: 4, to: 4, advance: 0 }]);
    const graphemes = await page.evaluate(() => window.consumer.graphemes());
    const fontNormalization = await page.evaluate(() => window.consumer.fontNormalization());
    const glyphVisibility = await page.evaluate(() => window.consumer.glyphVisibility());
    assert.deepEqual(glyphVisibility, { glyphs: [2, 0, 3], hidden: [false, true, false], widths: [600, 0, 700], total: 1300, preserved: 1800, source: [{ from: 1, to: 2 }],
        properties: { defaultIgnorable: true, zeroWidthJoiner: true, zeroWidthNonJoiner: false, variationSelector: false, substituted: false, ligated: false }, released: true, exports: 0 });
    assert.deepEqual(fontNormalization, { form: "font", text: "A\u0301α", clusters: 2, runs: 2, fonts: [0, 1], origin: [{ from: 0, to: 1 }], rows: [{ from: 0, to: 2, fontIndex: 0, glyphs: [2, 9], units: 600 }, { from: 2, to: 3, fontIndex: 1, glyphs: [7], units: 1000 }], released: true, nativeReleased: true, exports: 0 });
    assert.deepEqual(graphemes, { version: "18.0.0", raw: [0, 4, 9, 11], normalized: [0, 2, 5], coordinates: ["buffer", "normalized"], scripts: 2, origin: [{ from: 0, to: 1 }], released: true, exports: 0 });
    const font = await page.evaluate(() => window.consumer.font());
    assert.deepEqual(font, { result: "ready", current: true, ownedFaces: 1, unitsPerEm: 1000, glyphCount: 10,
        nominalUnits: 1550, variation: 8, native: [155, 120, 50], copiedNominalA: 600, released: true, retainedA: 600, retainedPositioned: 1200,
        positioning: { pairUnits: 1200, pairPrefix: 500, ligatureUnits: 500, source: [[{ from: 0, to: 1 }], [{ from: 1, to: 2 }]] },
        cursor: { units: 500, disposed: "disposed", resultReleased: true },
        scripts: { runs: 2, clusters: 5, rows: [{ script: "Latn", from: 0, to: 4, glyphs: [6, 2, 3], units: 1700 }, { script: "Grek", from: 4, to: 5, glyphs: [0], units: 500 }], missing: 1, repeatedOrigin: [{ from: 0, to: 1 }], released: true },
        glyphPipeline: { inputGlyphs: 2, glyphs: [6], units: 500, source: [[{ from: 0, to: 1 }], [{ from: 1, to: 2 }]], released: true },
        unicode: { version: "18.0.0", text: "fiAB", points: 4, glyphs: [6, 2, 3], units: 1700, components: [[{ from: 0, to: 1 }], [{ from: 0, to: 1 }]], script: "Latn", extensions: ["Hira", "Kana"], mappingReleased: true },
        substitution: { glyphs: [6], components: [[{ from: 0, to: 1 }], [{ from: 1, to: 2 }]], units: 500 } });
    assert.deepEqual(errors, []);
    await mkdir("artifacts/package", { recursive: true });
    await page.screenshot({ path: "artifacts/package/consumer.png" });
    await writeFile("artifacts/package/report.json", JSON.stringify({ schemaVersion: 1,
        packageSha256: createHash("sha256").update(archive).digest("hex"), entries: Object.keys(entries).sort(),
        consumer, browser: browser.version(), node: process.version, dotnet: dotnet(["--version"]).trim(),
        typescript: JSON.parse(await readFile("node_modules/typescript/package.json", "utf8")).version,
        esbuild: JSON.parse(await readFile("node_modules/esbuild/package.json", "utf8")).version,
        actualText: await editor.inputValue(), storage, history, viewport, candidate, capturedSelection, navigation, wordSelection, bidi, paragraph, advances, font, graphemes, fontNormalization, glyphVisibility, find, caseFind, regex, selectionSets, multipleInput, comparison, readonlyIndent, findAuthority, saveReview, style, errors }, null, 2));
    console.log("Restored package: declarations, storage/mappings, modules, visible CSS and actual edit passed. Evidence: artifacts/package/");
    console.log(`Isolated consumer retained for inspection: ${consumer}`);
    await page.close();
    }
    if (reactOnly) {
        const { runPackagedReactPilot } = await import("./package-react-pilot.mjs");
        await runPackagedReactPilot(browser, `http://127.0.0.1:${server.address().port}`, {
            directory: "artifacts/package", packageSha256: createHash("sha256").update(archive).digest("hex"), benchmark,
        });
    }
    if (!reactOnly && !hunkOnly) await runPackagedPilot(browser, `http://127.0.0.1:${server.address().port}`, {
        directory: "artifacts/package", packageSha256: createHash("sha256").update(archive).digest("hex"), benchmark,
    });
    if (!reactOnly && (hunkOnly || !pilotOnly)) await runPackagedHunkPilot(browser, `http://127.0.0.1:${server.address().port}`, {
        directory: "artifacts/package", packageSha256: createHash("sha256").update(archive).digest("hex"), benchmark,
    });
    console.log(`Restored integrated pilot passed in ${browserName}. Consumer retained: ${consumer}`);
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
}
