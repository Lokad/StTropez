import { isolatedTest as test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const name = (page: Page) => page.getByLabel("New identifier", { exact: true });
const targets = (page: Page) => page.getByRole("list", { name: "Captured rename targets", exact: true }).locator("li");
const marker = "// fixture rename\r\n", raw = "// 😀\r\nconst catalogue = 1;\r\ncatalogue; // catalogue\r\n'catalogue';";
async function ready(page: Page) {
    await expect.poll(async () => { const s = await snapshot(page), c = s.bindings.comparison;
        return !s.bindings.rename.state.pending && s.bindings.views.every(v => !v.metrics?.pendingInput && !v.metrics?.pendingCommand && !v.metrics?.pendingCaret && !v.metrics?.viewport.pending)
            && (!c || c.status === "ready" && !c.workingViewport.pending && !c.referenceViewport?.pending); }, { timeout: 30000 }).toBe(true);
}
async function select(page: Page, at: number) { await input(page).focus(); await page.evaluate(at => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: at, head: at }]); }, at); await ready(page); }
async function seed(page: Page, text = raw) { await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, text); await select(page, text.indexOf("catalogue") + 2); }
async function preview(page: Page, value = "inventory") { await name(page).fill(value); await button(page, "Prepare rename preview").click(); await ready(page); }
async function exact(page: Page, text: string) { expect(await page.evaluate(text => { const f = window.hostFixture; if (f.snapshot().source.length !== text.length) return false; for (let at = 0; at < text.length; at += 32768) if (f.range(at, Math.min(text.length, at + 32768)) !== text.slice(at, at + 32768)) return false; return true; }, text)).toBe(true); }
async function dispose(page: Page) { await page.evaluate(() => window.hostFixture.dispose()); const s = await snapshot(page); expect(s.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(s.hostSubscriptions).toBe(0); expect(s.bindings.rename).toMatchObject({ transport: null, sessions: 0, subscriptions: 0, disposed: true }); }
for (const host of ["plain", "react"]) test.describe(`${host} LSP rename host`, () => {
    test.beforeEach(async ({ page }) => {  await page.goto(`/hosts/${host}/?editor=candidate&language=lsp`); await expect(input(page)).toBeVisible(); await ready(page); });
    test("new-name preview applies exact provider edits across captured resources with shared complete-set history", async ({ page }) => {
        const requests: { method: string; params: any }[] = [], responses: any[] = []; let opened = 0, closed = 0;
        page.on("websocket", socket => { opened++; socket.on("close", () => closed++); socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method) requests.push(value); }); socket.on("framereceived", frame => { const value = JSON.parse(frame.payload.toString()); if (value.result?.documentChanges) responses.push(value.result); }); });
        await seed(page, raw + " "); await seed(page, raw + "  "); await seed(page); await button(page, "Add navigation companion").click();
        const ranges = [{ anchor: raw.indexOf("catalogue") + 4, head: raw.indexOf("catalogue") + 2 }, { anchor: raw.length, head: raw.length }];
        await page.evaluate(ranges => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, ranges); }, ranges); const before = await snapshot(page);
        await input(page).press("F2"); await expect(name(page)).toBeFocused(); await expect(name(page)).toHaveValue("catalogue"); await name(page).press("Escape"); await expect(input(page)).toBeFocused();
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(before.bindings.views.find(v => v.id === "primary")!.selectionSet);
        await input(page).press("F2"); await name(page).fill("discarded"); await name(page).press("Enter"); await ready(page); await expect(targets(page)).toHaveCount(5); await exact(page, raw);
        await name(page).fill("café"); await expect(button(page, "Apply captured rename")).toBeDisabled(); await expect(targets(page)).toHaveCount(0); await name(page).press("Enter"); await ready(page);
        await expect(targets(page)).toHaveCount(5); await expect(targets(page).filter({ hasText: "// fixture rename" })).toHaveCount(1); expect((await snapshot(page)).history).toEqual(before.history);
        // Some frame-inspection backends expose raw UTF-8 as Latin-1. Applied model text below
        // and actual preview text establish Unicode correctness independently of that diagnostic.
        await expect(targets(page).filter({ hasText: "café" })).toHaveCount(4);
        const request = requests.filter(r => r.method === "textDocument/rename").at(-1)!; expect(request.params.position).toEqual({ line: 1, character: 8 });
        const initialize = requests.find(r => r.method === "initialize" && r.params.capabilities.textDocument.rename)!; expect(initialize.params.capabilities.workspace.workspaceEdit.documentChanges).toBe(true);
        const remote = await page.evaluate(uri => window.hostFixture.providerCustom("fixture/document", { uri, from: 0, to: 0 }), request.params.textDocument.uri) as { version: number };
        expect(responses.at(-1).documentChanges.find((change: any) => change.textDocument.uri === request.params.textDocument.uri).textDocument.version).toBe(remote.version);
        const expected = marker + raw.replace("const catalogue", "const café").replace("\r\ncatalogue;", "\r\ncafé;"); await button(page, "Apply captured rename").click(); await ready(page); await exact(page, expected);
        const companion = before.bindings.navigation.companion!; expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe("const café = 1;\r\ncafé;\r\n"); expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
        await input(page).press("Control+End"); await input(page).pressSequentially("H"); await ready(page); await input(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, expected);
        await input(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, raw); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges.map(r => ({ anchor: r.anchor, head: r.head }))).toEqual(ranges);
        await input(page, "Secondary source").press("Control+Shift+z"); await ready(page); await button(page, "Open renamed changes in Navigation companion").click(); await ready(page); await expect(input(page, "Secondary source")).toBeFocused();
        await input(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, raw); await input(page, "Secondary source").press("Control+Shift+z"); await ready(page); await exact(page, expected); expect((await snapshot(page)).source.exports).toBe(0); await dispose(page); await expect.poll(() => closed).toBe(opened);
    });
    test("malformed targets, authority changes, cancelled captures and reconnect leave editing available", async ({ page }) => {
        let requests = 0, lastPosition: unknown; page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method === "textDocument/rename") { requests++; lastPosition = value.params.position; } }));
        await seed(page); await button(page, "Add navigation companion").click(); const before = await snapshot(page), companion = before.bindings.navigation.companion!;
        await page.evaluate(() => window.hostFixture.faultRenameNext("malformed")); await preview(page); expect((await snapshot(page)).bindings.rename.state).toMatchObject({ status: "failed", count: 0, canApply: false }); await exact(page, raw); expect((await snapshot(page)).history).toEqual(before.history);
        await preview(page); await page.evaluate(id => window.hostFixture.setProjectTargetReadOnly(id, true), companion); await ready(page); await expect(button(page, "Apply captured rename")).toBeDisabled();
        await preview(page); await button(page, "Apply captured rename").click(); await ready(page); await exact(page, raw); expect((await snapshot(page)).bindings.rename.state.status).toBe("failed"); expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe("const catalogue = 1;\r\ncatalogue;\r\n"); await page.evaluate(id => window.hostFixture.setProjectTargetReadOnly(id, false), companion);
        for (const mode of ["selection", "typing", "remount"] as const) {
            await select(page, raw.indexOf("catalogue") + 2); await name(page).fill("inventory"); await page.evaluate(() => window.hostFixture.setRenameDelay(1000)); await button(page, "Prepare rename preview").click(); expect((await snapshot(page)).bindings.rename.state.pending).toBe(true);
            if (mode === "selection") await select(page, raw.indexOf("catalogue") + 3);
            else if (mode === "typing") { await input(page).press("Control+End"); await input(page).pressSequentially("x"); await ready(page); await input(page).press("Control+z"); }
            else await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
            await ready(page); await expect(button(page, "Apply captured rename")).toBeDisabled(); await exact(page, raw);
        }
        await page.evaluate(() => window.hostFixture.setRenameDelay(0)); await select(page, raw.indexOf("catalogue") + 2); await preview(page); await page.evaluate(() => window.hostFixture.faultIdleRename()); await ready(page); await expect(button(page, "Apply captured rename")).toBeDisabled();
        await button(page, "Reconnect rename provider").click(); await select(page, raw.indexOf("catalogue") + 2); await preview(page); await button(page, "Disconnect rename provider").click(); await input(page).press("Control+End"); await input(page).pressSequentially("local"); await ready(page); await exact(page, raw + "local"); await button(page, "Reconnect rename provider").click(); await select(page, raw.indexOf("catalogue") + 2); await preview(page); await expect(button(page, "Apply captured rename")).toBeEnabled();
        const count = requests; await select(page, raw.indexOf(";") + 1); await preview(page); expect(requests).toBe(count + 1); expect(lastPosition).toEqual({ line: 1, character: "const catalogue = 1;".length }); expect((await snapshot(page)).bindings.rename.state.count).toBe(0); await exact(page, raw + "local"); await dispose(page);
    });
    test("comparison rename preserves its baseline and primary Save/Run through unmounted-target focus", async ({ page }) => {
        await seed(page); await button(page, "Open source review").click(); await button(page, "Add navigation companion").click(); await ready(page); const working = input(page, "Comparison working source"), before = await snapshot(page), baseline = before.bindings.comparison!.baseline;
        await working.focus(); await page.evaluate(at => { const f = window.hostFixture; f.selectSourceSet("comparison", f.snapshot().source.revision, [{ anchor: at, head: at }]); }, raw.indexOf("catalogue") + 2); await working.press("F2"); await name(page).fill("inventory"); await name(page).press("Enter"); await ready(page);
        expect((await snapshot(page)).bindings.rename.capture!.view).toBe("comparison"); await button(page, "Apply captured rename").click(); await ready(page); const expected = marker + raw.replace("const catalogue", "const inventory").replace("\r\ncatalogue;", "\r\ninventory;"); await exact(page, expected); expect((await snapshot(page)).bindings.comparison!.baseline).toEqual(baseline);
        const reference = input(page, "Comparison baseline source"), baselineText = await page.evaluate(length => window.hostFixture.referenceRange(0, length), baseline!.length); await reference.focus(); await reference.press("F2"); await expect(name(page)).not.toBeFocused(); expect(await page.evaluate(length => window.hostFixture.referenceRange(0, length), baseline!.length)).toBe(baselineText);
        await button(page, "Open renamed changes in Navigation companion").click(); await ready(page); await button(page, "Run captured inputs").click(); expect((await snapshot(page)).pendingRuns[0]!.sourceId).toBe(before.source.id); expect(await page.evaluate(() => window.hostFixture.runCapture(0)!.source)).toBe(expected); await page.evaluate(() => window.hostFixture.finishRun());
        await button(page, "Save source").click(); await working.press("Control+End"); await working.pressSequentially(" later"); await ready(page); await page.evaluate(() => window.hostFixture.finishSave()); await ready(page); await exact(page, expected + " later"); expect((await snapshot(page)).source.dirty).toBe(true); expect((await snapshot(page)).bindings.comparison!.baseline).toEqual(baseline); await dispose(page);
    });
    test("100k-line rename keeps input bounded and shares atomic undo without ordinary full exports", async ({ page }) => {
        test.setTimeout(90000); const text = "const catalogue = 1;\r\n" + "const unchanged = 123;\r\n".repeat(99_999) + "catalogue;"; await seed(page, text); const before = await snapshot(page); await preview(page); await expect(targets(page)).toHaveCount(3); await button(page, "Apply captured rename").click(); await ready(page);
        const expected = marker + text.replace("const catalogue", "const inventory").replace(/catalogue;$/, "inventory;"); await exact(page, expected); await input(page).press("Control+z"); await ready(page); await exact(page, text); await input(page).press("Control+Shift+z"); await ready(page); await exact(page, expected);
        expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1); expect((await snapshot(page)).source.exports).toBe(0); expect((await snapshot(page)).bindings.views.every(view => view.metrics!.inputUnits <= 4096 && view.metrics!.viewport.rows < 100)).toBe(true); await dispose(page);
    });
});
