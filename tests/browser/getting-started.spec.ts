import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { build } from "esbuild";
import { libraryCss, libraryModules } from "../../scripts/library-entries.mjs";
import { parseDocumentation } from "../../scripts/documentation-audit.mjs";
import { expect, test } from "./fixtures.ts";

test("the tutorial keeps a pending split edit through Save and Close", async ({ page }) => {
    const path = "docs/getting-started.md";
    const guide = parseDocumentation(path, await readFile(path, "utf8"));
    const html = guide.tree.children.find(node => node.type === "code" && node.lang === "html");
    if (html?.type !== "code") throw new Error("Missing tutorial HTML.");
    const assets = new Map([["", html.value], ["sttropez/editor.css", await readFile(libraryCss.source, "utf8")]]);
    for (const { file, code } of guide.examples) {
        if (file) assets.set(file, code);
    }
    const outdir = resolve("artifacts/tutorial-test");
    const built = await build({
        entryPoints: Object.fromEntries(libraryModules.map(entry => [entry.output.slice(0, -3), entry.source])),
        outdir, bundle: true, splitting: true, format: "esm", target: "es2022", write: false
    });
    for (const file of built.outputFiles) {
        assets.set("sttropez/" + relative(outdir, file.path).split(sep).join("/"), file.text);
    }
    await page.route("**/checklist/**", route => {
        const name = new URL(route.request().url()).pathname.slice("/checklist/".length);
        const body = assets.get(name);
        if (body === undefined) return route.abort();
        const contentType = name === "" ? "text/html" : name.endsWith(".css") ? "text/css" : "text/javascript";
        return route.fulfill({ contentType, body });
    });
    await page.clock.install();
    await page.goto("/checklist/");
    const split = page.getByRole("textbox", { name: "Checklist split" });
    const save = page.getByRole("button", { name: "Save", exact: true });
    const lines = 40_000;
    await split.press("Control+a");
    await page.keyboard.insertText("0\n".repeat(lines));
    await split.press("Control+a");
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1000)));
    await page.keyboard.press("Control+]");
    await save.click({ force: true });
    expect(await page.evaluate(() => sessionStorage.getItem("tasks.md"))).toBeNull();
    let confirmations = 0;
    page.on("dialog", async dialog => {
        confirmations++;
        await dialog.accept();
    });
    await page.getByRole("button", { name: "Close", exact: true }).click({ force: true });
    expect(confirmations).toBe(0);
    await expect(split).toBeAttached();
    await page.clock.resume();
    await expect(page.locator("main .st-viewport-row").first()).toHaveJSProperty("textContent", "  0");
    await save.click();
    expect(await page.evaluate(() => sessionStorage.getItem("tasks.md"))).toBe("  0\n".repeat(lines));
});
