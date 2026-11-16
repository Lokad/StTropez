import { test, expect } from "./fixtures.ts";
import { runDemoUnopenedNavigation } from "./demo-walkthrough.ts";

test("unopened targets load for navigation and atomic rename with read-only declarations and return", async ({ page }) => {
    await runDemoUnopenedNavigation(page);
});

test("held target contents cannot load a tab or steal focus after source edits or sample disposal", async ({ page }) => {
    let held = false, release: (() => void) | undefined;
    await page.routeWebSocket("**/demo-provider/*", client => {
        const server = client.connectToServer(), pending = new Set<number>();
        client.onMessage(message => { const value = JSON.parse(message.toString()); if (value.method === "sttropez/readDocument") pending.add(value.id); server.send(message); });
        server.onMessage(message => { const value = JSON.parse(message.toString()); if (!held && pending.has(value.id)) { held = true; release = () => client.send(message); } else client.send(message); });
    });
    await page.goto("/"); await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await page.locator("#sample").selectOption("navigation");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    const request = async () => {
        held = false; await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
        await source.press("Control+f"); await page.locator("#find-query").fill("const label = formatLabel");
        await expect(page.locator("#find-status")).toHaveText("1 matches"); await page.locator("#find-next").click(); await page.locator("#find-close").click();
        await source.press("ArrowRight"); await source.press("ArrowLeft"); await source.press("F12"); await expect.poll(() => held).toBe(true);
    };
    await request(); await source.press("Control+End"); await page.keyboard.insertText("// newer source\n"); release!();
    await expect(page.locator(".demo-symbols")).toBeHidden(); await expect(page.locator("#files button")).toHaveText(["main.ts ●"]); await expect(source).toBeFocused();
    await request(); await page.locator("#sample").selectOption("pricing"); release!();
    await expect(page.locator("#files button")).toHaveText(["main.ts", "pricing.ts"]); await expect(page.locator(".demo-symbols")).toBeHidden();
    // This test cancels a captured target reply, not an unrelated connecting transport.
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await page.locator("#sample").selectOption("navigation"); await expect(page.locator("#files button")).toHaveText(["main.ts ●"]);
    await expect(page.locator("#editor")).toContainText("// newer source");
});

test("an action preview includes a newly resolved module and applies one guarded undo unit", async ({ page }) => {

    await page.routeWebSocket("**/demo-provider/*", client => {
        const server = client.connectToServer(), requests = new Map<number, string>();
        client.onMessage(message => { const value = JSON.parse(message.toString()); if (value.method === "textDocument/codeAction") requests.set(value.id, value.params.textDocument.uri); server.send(message); });
        server.onMessage(message => {
            const value = JSON.parse(message.toString()), uri = requests.get(value.id); if (!uri) { client.send(message); return; }
            requests.delete(value.id);
            const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
            client.send(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: [{ title: "Add captured module notes", kind: "quickfix", edit: { changes: {
                [uri]: [{ range, newText: "// main note\n" }], [uri.replace(/main\.ts$/, "labels.ts")]: [{ range, newText: "// module note\n" }],
            } } }] }));
        });
    });
    await page.goto("/"); await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await page.locator("#sample").selectOption("navigation");
    await expect(page.locator("#files button")).toHaveText(["main.ts"]);
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    const main = page.getByRole("textbox", { name: "main.ts", exact: true }); await main.press("Control+Home"); await main.press("Control+.");
    const popup = page.getByRole("region", { name: "Quick fixes", exact: true });
    await expect(popup.getByRole("button", { name: "Add captured module notes", exact: true })).toBeVisible();
    await expect(popup.locator("ins")).toHaveText(["// main note\n", "// module note\n"]);
    await popup.getByRole("button", { name: "Apply fix", exact: true }).click(); await expect(popup).toBeHidden();
    await expect(page.locator("#editor")).toContainText("// main note");
    await page.locator('#files [data-file="labels.ts"]').click(); await expect(page.locator("#editor")).toContainText("// module note");
    await page.getByRole("textbox", { name: "labels.ts", exact: true }).press("Control+z"); await expect(page.locator("#editor")).not.toContainText("// module note");
    await page.locator('#files [data-file="main.ts"]').click(); await expect(page.locator("#editor")).not.toContainText("// main note");
});
