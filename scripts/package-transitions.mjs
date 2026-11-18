import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir, realpath } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { build } from "esbuild";
import { zipSync, strFromU8, strToU8 } from "fflate";
import { chromium, firefox, webkit } from "@playwright/test";
import { sourceIdentity, environment } from "./measurement.mjs";
import { within, consumerCompilerRoots } from "./package-react-host.mjs";
import { createPackageRequestHandler, listenPackageServer, closePackageServer, closePackageResources } from "./package-host.mjs";

/** @typedef {{version: string, assets: readonly {path: string, bytes: number, sha256: string}[]}} Manifest */

/** @param {Uint8Array} bytes */
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
/** @param {string} root @param {string} [prefix] @returns {Promise<string[]>} */
async function files(root, prefix = "") {
    const paths = [];
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
        const path = prefix + entry.name;
        if (entry.isDirectory()) paths.push(...await files(root, path + "/"));
        else { assert.ok(entry.isFile(), "Stage must contain ordinary files."); paths.push(path); }
    }
    return paths.sort();
}

/** Qualification-only versions of this producer's payload, restored by real NuGet/MSBuild.
 * @param {{project: string, consumer: string, entries: import('fflate').Unzipped,
 * assets: Manifest, browserName: 'chromium' | 'firefox' | 'webkit', dotnet: (args: string[]) => string}} options
 */
export async function runPackageTransitions({ project, consumer, entries, assets, browserName, dotnet }) {
    const source = await sourceIdentity(), probe = "browser/package-transition-worker.js", optional = strToU8('postMessage("transition-a");\n');
    assert.ok(!entries["assets/" + probe]);
    const manifestA = { ...assets, assets: [...assets.assets, { path: probe, bytes: optional.length, sha256: sha(optional) }].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
    const payloads = { a: { ...entries, ["assets/" + probe]: optional, "assets/manifest.json": strToU8(JSON.stringify(manifestA, null, 2) + "\n") }, b: entries };
    const versions = { a: "0.0.0-transition.1", b: "0.0.0-transition.2", base: "0.0.0-local" }, manifests = { a: manifestA, b: assets, base: assets };
    const fixturePackages = [];
    for (const kind of /** @type {const} */ (["a", "b"])) {
        const payload = { ...payloads[kind] };
        for (const path of Object.keys(payload).filter(path => path.endsWith(".nuspec") || path.endsWith(".psmdcp"))) {
            const xml = strFromU8(payload[path]); assert.equal((xml.match(/<version>[^<]*<\/version>/g) ?? []).length, 1);
            payload[path] = strToU8(xml.replace(/<version>[^<]*<\/version>/, `<version>${versions[kind]}</version>`));
        }
        const archive = zipSync(payload);
        await writeFile(join(consumer, `feed/StTropez.Assets.${versions[kind]}.nupkg`), archive);
        fixturePackages.push({ version: versions[kind], sha256: sha(archive), manifestSha256: sha(payload["assets/manifest.json"]), optionalWorker: kind === "a" });
    }
    await writeFile(join(consumer, "package.json"), '{"type":"module"}');
    const stageParent = join(consumer, "obj/sttropez"), sentinel = join(stageParent, "host-owned.txt"), sentinelText = "Host owns cleanup outside each content-addressed generation.\n";
    await mkdir(stageParent, { recursive: true }); await writeFile(sentinel, sentinelText);
    const compilerRoots = await consumerCompilerRoots(project);
    /** @type {Map<string, {manifest: Manifest, bytes: Uint8Array}>} */ const roots = new Map();
    /** @type {Map<string, {manifest: Manifest, bytes: Uint8Array}>} */ const caches = new Map();
    /** @type {Map<string, Uint8Array>} */ const routes = new Map();
    /** @type {{root: string}[]} */ const steps = [];
    /** @type {string[]} */ const errors = [];
    /** @type {unknown[]} */ const failures = [];
    const requests = createPackageRequestHandler((request, response) => {
        assert.ok(request.url, "HTTP request must have a URL.");
        const path = new URL(request.url, "http://localhost").pathname, file = routes.get(path);
        if (!file) { response.writeHead(404).end(); return; }
        response.writeHead(200, { "Content-Type": path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html", "Cache-Control": "no-store" }); response.end(file);
    }, failures);
    const server = createServer(requests.listener);
    /** @type {import('@playwright/test').Browser | undefined} */ let browser;
    /** @type {import('@playwright/test').Page | undefined} */ let retainedPage;
    /** @param {string} root @param {Manifest} manifest @param {Uint8Array} bytes */
    const verifyPayload = async (root, manifest, bytes) => {
        assert.equal(sha(await readFile(join(root, "manifest.json"))), sha(bytes));
        for (const asset of manifest.assets) { const actual = await readFile(join(root, asset.path)); assert.equal(actual.length, asset.bytes, asset.path); assert.equal(sha(actual), asset.sha256, asset.path); }
    };
    /** @param {string} root @param {Manifest} manifest @param {Uint8Array} bytes */
    const verifyStage = async (root, manifest, bytes) => {
        assert.equal(basename(root).toLowerCase(), sha(bytes)); assert.ok(within(stageParent, root));
        assert.deepEqual(await files(root), ["manifest.json", ...manifest.assets.map(asset => asset.path)].sort()); await verifyPayload(root, manifest, bytes);
    };
    /** @param {import('@playwright/test').Page} page */
    const ready = page => page.waitForFunction(() => window.transitionFixture?.ready());
    /** @param {import('@playwright/test').Page} page */
    const snapshot = page => page.evaluate(() => window.transitionFixture.snapshot());
    /** @param {import('@playwright/test').Page} page */
    const release = async page => { const diagnostics = await page.evaluate(() => window.transitionFixture.dispose()); assert.deepEqual(diagnostics, { ...diagnostics, views: 0, leases: 0, subscriptions: 0 }); await page.close(); };
    try {
        await listenPackageServer(server);
        const address = server.address(); assert.ok(address && typeof address !== "string");
        const url = `http://127.0.0.1:${address.port}`;
        browser = await ({ chromium, firefox, webkit })[browserName].launch();
        for (const [index, kind] of /** @type {const} */ (["a", "b", "a", "base"]).entries()) {
            const version = versions[kind], property = `-p:StTropezTestVersion=${version}`, manifest = manifests[kind], payload = kind === "a" ? payloads.a : entries, manifestBytes = payload["assets/manifest.json"];
            dotnet(["restore", "Consumer.csproj", "--packages", join(consumer, "packages"), "--configfile", "NuGet.Config", property]);
            dotnet(["msbuild", "Consumer.csproj", "-target:PrepareFrontend", "-verbosity:minimal", property]);
            const root = await realpath((await readFile(join(consumer, "assets-root.txt"), "utf8")).trim()), packageRoot = await realpath((await readFile(join(consumer, "package-assets-root.txt"), "utf8")).trim());
            assert.ok(within(join(consumer, "packages"), packageRoot));
            /** @type {{libraries: Record<string, unknown>, targets: Record<string, Record<string, {compile?: unknown, runtime?: unknown}>>}} */
            const restored = JSON.parse(await readFile(join(consumer, "obj/project.assets.json"), "utf8")); assert.deepEqual(Object.keys(restored.libraries), [`StTropez.Assets/${version}`]);
            const library = Object.values(restored.targets)[0][`StTropez.Assets/${version}`]; assert.equal(library.compile, undefined); assert.equal(library.runtime, undefined);
            await verifyStage(root, manifest, manifestBytes); await verifyPayload(packageRoot, manifest, manifestBytes);
            for (const [previous, value] of roots) await verifyStage(previous, value.manifest, value.bytes);
            for (const [previous, value] of caches) await verifyPayload(previous, value.manifest, value.bytes);
            assert.equal(await readFile(sentinel, "utf8"), sentinelText);
            if (index === 1) assert.notEqual(root, steps[0].root);
            if (index === 2) assert.equal(root, steps[0].root);
            if (kind === "base") assert.equal(root, steps[1].root);
            if (index === 0) { dotnet(["msbuild", "Consumer.csproj", "-target:PrepareFrontend", "-verbosity:minimal", property]); assert.equal(await realpath((await readFile(join(consumer, "assets-root.txt"), "utf8")).trim()), root); await verifyStage(root, manifest, manifestBytes); }
            roots.set(root, { manifest, bytes: manifestBytes }); caches.set(packageRoot, { manifest, bytes: manifestBytes });
            const options = { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: false, noEmit: true, types: [], paths: { sttropez: [join(root, "index.d.ts")], "sttropez/browser": [join(root, "browser/index.d.ts")] } };
            const config = join(consumer, "transition-tsconfig.json"); await writeFile(config, JSON.stringify({ compilerOptions: options, files: ["transition.ts"] }));
            const compiler = execFileSync(process.execPath, [join(project, "node_modules/typescript/bin/tsc"), "-p", config, "--listFiles", "--pretty", "false"], { cwd: consumer, encoding: "utf8", stdio: "pipe" });
            const typeInputs = compiler.trim().split(/\r?\n/).filter(Boolean).map(path => resolve(consumer, path));
            assert.ok(typeInputs.length > 1); for (const path of typeInputs) assert.ok(within(consumer, path) || /\.d\.[cm]?ts$/.test(path) && compilerRoots.some(root => within(root, path)), `Unexpected compiler input: ${path}`);
            const bundled = await build({ absWorkingDir: consumer, entryPoints: ["transition.ts"], outfile: "site/transition.js", bundle: true, platform: "browser", format: "esm", target: "es2022", alias: { sttropez: root }, write: false, metafile: true });
            for (const path of Object.keys(bundled.metafile.inputs)) assert.ok(within(consumer, resolve(consumer, path)), `Checkout input leaked into staged consumer: ${path}`);
            const prefix = `/stages/${sha(manifestBytes)}/`;
            routes.set(prefix, strToU8('<!doctype html><html lang="en"><meta charset="utf-8"><title>Staged package</title><link rel="stylesheet" href="editor.css"><h1>Staged package</h1><div id="editor" style="height:180px"></div><script type="module" src="transition.js"></script></html>'));
            routes.set(prefix + "transition.js", bundled.outputFiles[0].contents); routes.set(prefix + "editor.css", await readFile(join(root, "editor.css")));
            if (kind === "a") routes.set(prefix + "optional-worker.js", await readFile(join(root, probe)));
            const page = await browser.newPage(); page.on("pageerror", e => errors.push(e.message)); await page.goto(url + prefix); await ready(page);
            const input = page.getByRole("textbox", { name: "Staged source", exact: true }); await input.press("Control+End"); await ready(page); const before = await snapshot(page);
            await input.press("q"); await ready(page); const after = await snapshot(page); assert.equal(after.text, before.text + "q"); assert.equal(after.history.undoDepth, before.history.undoDepth + 1);
            await input.press("Control+z"); await ready(page); assert.equal((await snapshot(page)).text, before.text); assert.deepEqual((await snapshot(page)).selections, before.selections);
            await input.press("Control+Shift+z"); await ready(page); assert.equal((await snapshot(page)).text, after.text); assert.deepEqual((await snapshot(page)).selections, after.selections); const alive = await snapshot(page);
            const style = await page.locator("#editor .st-viewport").evaluate(node => ({ height: node.getBoundingClientRect().height, background: getComputedStyle(node).backgroundColor, font: getComputedStyle(node).fontFamily }));
            assert.equal(style.height, 180); assert.equal(style.background, "rgb(19, 27, 39)"); assert.match(style.font, /monospace/); assert.equal(await input.evaluate(node => getComputedStyle(node).width), "1px");
            if (kind === "a") assert.equal(await page.evaluate(url => new Promise((resolve, reject) => { const worker = new Worker(url), timer = setTimeout(() => { worker.terminate(); reject(new Error("Optional fixture worker did not answer.")); }, 5000); worker.onmessage = e => { clearTimeout(timer); worker.terminate(); resolve(e.data); }; worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(new Error("Optional fixture worker failed.")); }; }), url + prefix + "optional-worker.js"), "transition-a");
            else { assert.ok(!(await files(root)).includes(probe)); assert.equal((await page.request.get(url + prefix + "optional-worker.js")).status(), 404); }
            if (retainedPage) { const prior = await snapshot(retainedPage); await retainedPage.getByRole("textbox", { name: "Staged source", exact: true }).press("z"); await ready(retainedPage); assert.equal((await snapshot(retainedPage)).text, prior.text + "z"); assert.deepEqual(await snapshot(page), alive); }
            if (index === 0) retainedPage = page; else await release(page);
            for (const [cache, value] of caches) await verifyPayload(cache, value.manifest, value.bytes);
            const step = { kind, version, root, manifestSha256: sha(manifestBytes), optionalWorker: kind === "a", repeatPrepare: index === 0, sourceIsolation: true, strictDeclarations: true, typeInputs, bundleInputs: Object.keys(bundled.metafile.inputs).sort(), actualKeyboardEdit: true, sharedUndoRedo: true, completeSelections: true, priorPageStillEditable: index > 0, style }; steps.push(step);
            console.log(`Package transition ${index + 1}/4: ${version}; staged hashes, isolated declarations, keyboard edit and history passed.`);
        }
        assert.ok(retainedPage); await release(retainedPage); retainedPage = undefined; assert.deepEqual(errors, []); assert.equal((await sourceIdentity()).sha256, source.sha256);
        const last = steps.at(-1); assert.ok(last);
        const report = { schemaVersion: 1, source, environment: environment(), browser: browser.version(), consumer, fixturePackages, steps, originalPayloadVersion: assets.version, originalStage: last.root, retainedGenerations: roots.size, sentinelUnchanged: true, packagePayloadsUnchanged: true, timingsMeasured: false,
            limits: "Controlled local evaluation versions of this payload; fixture-only optional worker. Qualifies NuGet restore/stage transitions and isolated frontend usability, not arbitrary released-version compatibility, publishing, native input or display latency." };
        await mkdir("artifacts/package", { recursive: true }); await writeFile(`artifacts/package/transitions-${browserName}.json`, JSON.stringify(report, null, 2));
        console.log("Local package transitions A→B→A and identical-payload root reuse passed; old stages and live source remain intact."); return report;
    } catch (error) { failures.push(error); }
    finally {
        await closePackageResources([() => retainedPage?.close(), () => browser?.close(), () => closePackageServer(server), () => requests.settled()], failures);
    }
}
