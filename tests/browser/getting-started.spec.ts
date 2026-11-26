import { readFile } from "node:fs/promises";
import { fixtureModules } from "../helpers/fixture-modules.ts";
import { libraryCss, libraryModules } from "../../scripts/library-entries.mjs";
import { parseDocumentation } from "../../scripts/documentation-audit.mjs";
import { expect, pauseBetweenCommandTurns, test } from "./fixtures.ts";

const serveModules = fixtureModules(
    Object.fromEntries(libraryModules.map(entry => [entry.output.slice(0, -3), entry.source])),
);

test("the tutorial keeps a pending split edit through Save and Close", async ({ page }) => {
    const path = "docs/getting-started.md";
    const guide = parseDocumentation(path, await readFile(path, "utf8"));
    const html = guide.tree.children.find(node => node.type === "code" && node.lang === "html");
    if (html?.type !== "code") throw new Error("Missing tutorial HTML.");
    const assets = new Map([["", html.value], ["sttropez/editor.css", await readFile(libraryCss.source, "utf8")]]);
    for (const { file, code } of guide.examples) {
        if (file) assets.set(file, code);
    }
    await page.route("**/checklist/**", route => {
        const name = new URL(route.request().url()).pathname.slice("/checklist/".length);
        const body = assets.get(name);
        if (body === undefined) return route.abort();
        const contentType = name === "" ? "text/html" : name.endsWith(".css") ? "text/css" : "text/javascript";
        return route.fulfill({ contentType, body });
    });
    await serveModules(page, "/checklist/sttropez/");
    await page.clock.install();
    await page.goto("/checklist/");
    const split = page.getByRole("textbox", { name: "Checklist split" });
    const save = page.getByRole("button", { name: "Save", exact: true });
    const lines = 40_000;
    await split.press("Control+a");
    await page.keyboard.insertText("0\n".repeat(lines));
    await split.press("Control+a");
    const resume = await pauseBetweenCommandTurns(page);
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
    await resume();
    await expect(page.locator("main .st-viewport-row").first()).toHaveJSProperty("textContent", "  0");
    await save.click();
    expect(await page.evaluate(() => sessionStorage.getItem("tasks.md"))).toBe("  0\n".repeat(lines));
    await page.evaluate(() => sessionStorage.setItem("tasks.md", "Another saved checklist"));
    await save.click();
    await expect(page.locator("body > output")).toHaveText("Another view saved first. See Compare saved.");
    const compare = page.getByRole("button", { name: "Compare saved" });
    await compare.click();
    const baseline = page.getByRole("textbox", { name: "Comparison baseline source" });
    const working = page.getByRole("textbox", { name: "Comparison working source" });
    await expect(baseline).toHaveValue("Another saved checklist");
    await working.press("Control+Home");
    await working.press("Shift+ArrowRight");
    await compare.click();
    await expect(working).toHaveJSProperty("selectionEnd", 1);
    await expect(working).toBeFocused();
    expect(await page.evaluate(() => sessionStorage.getItem("tasks.md"))).toBe("Another saved checklist");
    await page.evaluate(() => sessionStorage.setItem("tasks.md", "A newer saved checklist"));
    await save.click();
    await expect(baseline).toHaveValue("A newer saved checklist");
    await expect(working).toHaveJSProperty("selectionEnd", 1);
});
