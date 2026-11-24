import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { chromium, expect } from "@playwright/test";
import { assetManifestEntries, assetPackageExports } from "./library-entries.mjs";
import { serveStatic } from "./serve-demo.mjs";

const version = "0.0.0-local";
const archive = `StTropez.Assets.${version}.nupkg`;
const temp = await realpath(tmpdir());
const consumer = await mkdtemp(join(temp, "sttropez-smoke-"));

async function smoke() {
    await cp("tests/fixtures/consumer", consumer, { recursive: true });
    await mkdir(join(consumer, "feed"));
    await cp(join("artifacts/nuget/feed", archive), join(consumer, "feed", archive));
    await writeFile(join(consumer, "NuGet.Config"),
        '<configuration><packageSources><clear/><add key="local" value="feed"/></packageSources></configuration>');
    const options = { cwd: consumer, stdio: /** @type {const} */ ("inherit"), windowsHide: true };
    execFileSync("dotnet", ["restore", "Consumer.csproj", "--packages", "packages", "--configfile", "NuGet.Config"], options);
    execFileSync("dotnet", ["msbuild", "Consumer.csproj", "-t:PrepareFrontend", "-verbosity:minimal"], options);
    const restore = JSON.parse(await readFile(join(consumer, "obj/project.assets.json"), "utf8"));
    const id = `StTropez.Assets/${version}`;
    assert.deepEqual(Object.keys(restore.libraries), [id]);
    const library = Object.values(restore.targets)[0][id];
    assert.equal(library.compile, undefined);
    assert.equal(library.runtime, undefined);

    const staged = await realpath((await readFile(join(consumer, "assets-root.txt"), "utf8")).trim());
    assert.equal(dirname(staged), join(consumer, "obj", "sttropez"));
    const manifestBytes = await readFile(join(staged, "manifest.json"));
    assert.deepEqual(manifestBytes, await readFile("dist/manifest.json"));
    /** @type {{version: string, entries: Record<string, string>, assets: {path: string, bytes: number, sha256: string}[]}} */
    const manifest = JSON.parse(manifestBytes.toString());
    assert.equal(manifest.version, version);
    assert.deepEqual(manifest.entries, assetManifestEntries);
    const packed = unzipSync(await readFile(join(consumer, "feed", archive)));
    const expected = ["[Content_Types].xml", "_rels/.rels", "StTropez.Assets.nuspec", "README.md",
        "build/StTropez.Assets.props", "build/StTropez.Assets.targets", "assets/manifest.json",
        ...manifest.assets.map(asset => "assets/" + asset.path)];
    const paths = Object.keys(packed).filter(name => !name.endsWith("/") && !/^package\/services\/metadata\/core-properties\/[^/]+\.psmdcp$/.test(name));
    assert.deepEqual(paths.sort(), expected.sort());
    const served = new Set(["index.html", "main.js", "font-fixture.js"]);
    const prefix = "node_modules/sttropez/";
    for (const asset of manifest.assets) {
        const data = await readFile(join(staged, asset.path));
        assert.equal(data.length, asset.bytes, asset.path);
        assert.equal(createHash("sha256").update(data).digest("hex"), asset.sha256, asset.path);
        served.add(prefix + asset.path);
    }
    const metadata = JSON.parse(await readFile(join(staged, "package.json"), "utf8"));
    assert.deepEqual(metadata.exports, assetPackageExports);
    assert.equal(metadata.dependencies, undefined);

    // Let NodeNext resolve the staged public exports exactly as it would in a host application.
    await cp(staged, join(consumer, prefix), { recursive: true });
    await writeFile(join(consumer, "package.json"), '{"type":"module"}');
    execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], options);
    const imports = Object.fromEntries(Object.entries(assetPackageExports).map(([key, target]) => {
        const entry = typeof target === "string" ? target : target.import;
        assert.ok(entry, `Missing browser export: ${key}`);
        return [metadata.name + key.slice(1), "./" + prefix + entry.slice(2)];
    }));
    const html = await readFile(join(consumer, "index.html"), "utf8");
    await writeFile(join(consumer, "index.html"), html.replace("IMPORT_MAP", JSON.stringify({ imports })));
    const site = await serveStatic(consumer, served);
    try {
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage();
            /** @type {string[]} */
            const errors = [];
            page.on("pageerror", error => errors.push(error.message));
            await page.goto(site.url);
            await expect(page.locator(".st-viewport")).toHaveCSS("font-family", "ConsumerFixture");
            await expect(page.locator("#matches")).toHaveText("1");
            await expect(page.locator(".st-viewport")).toHaveCSS("background-color", "rgb(19, 27, 39)");
            await page.getByRole("textbox", { name: "Sample" }).press("Home");
            await page.keyboard.type("!");
            await expect(page.locator(".st-viewport-row")).toHaveText("!smoke");
            assert.deepEqual(errors, []);
        } finally {
            await browser.close();
        }
    } finally {
        await site.close();
    }
}

try {
    await smoke();
    console.log("Restored package passed manifest, exports, strict declarations, CSS, font, regex worker and editing checks.");
} finally {
    assert.equal(dirname(await realpath(consumer)), temp);
    await rm(consumer, { recursive: true });
}
