import { ready, isolatedTest as test, expect, expectPanelKeyReserved } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { coversHost } from "./host-cases.ts";
import { holdLspReplies } from "../helpers/lsp-replies.ts";
import { hostTextEquals } from "../../scripts/host-scene.mjs";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const name = (page: Page) => page.getByLabel("New identifier", { exact: true });
const targets = (page: Page) => page.getByRole("list", { name: "Captured rename targets", exact: true }).locator("li");
const marker = "// fixture rename\r\n", raw = "// 😀\r\nconst catalogue = 1;\r\ncatalogue; // catalogue\r\n'catalogue';";
async function waitForRename(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (!s.bindings.rename.state.pending); });
}
async function select(page: Page, at: number) { await input(page).focus(); await page.evaluate(at => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: at, head: at }]); }, at); await waitForRename(page); }
async function seed(page: Page, text = raw) { await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, text); await select(page, text.indexOf("catalogue") + 2); }
async function preview(page: Page, value = "inventory") { await name(page).fill(value); await button(page, "Prepare rename preview").click(); await waitForRename(page); }
async function exact(page: Page, text: string) { expect(await hostTextEquals(page, text)).toBe(true); }
async function dispose(page: Page) { await page.evaluate(() => window.hostFixture.dispose()); const s = await snapshot(page); expect(s.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(s.hostSubscriptions).toBe(0); expect(s.bindings.rename).toMatchObject({ sessions: 0, subscriptions: 0, disposed: true }); }
for (const host of ["plain", "react"] as const) test.describe(`${host} LSP rename host`, () => {
    test.beforeEach(async ({ page }) => {  await page.goto(`/hosts/${host}/?editor=candidate&language=lsp`); await expect(input(page)).toBeVisible(); await waitForRename(page); });
    if (coversHost("candidate-hosts", host, "candidate")) test("new-name preview applies exact provider edits across captured resources with shared complete-set history", async ({ page }) => {
        const requests: { method: string; params: any }[] = [], responses: any[] = []; let opened = 0, closed = 0;
        page.on("websocket", socket => { opened++; socket.on("close", () => closed++); socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method) requests.push(value); }); socket.on("framereceived", frame => { const value = JSON.parse(frame.payload.toString()); if (value.result?.documentChanges) responses.push(value.result); }); });
        await seed(page, raw + " "); await seed(page, raw + "  "); await seed(page); await button(page, "Add navigation companion").click();
        const ranges = [{ anchor: raw.indexOf("catalogue") + 4, head: raw.indexOf("catalogue") + 2 }, { anchor: raw.length, head: raw.length }];
        await page.evaluate(ranges => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, ranges); }, ranges); const before = await snapshot(page);
        await input(page).press("F2"); await expect(name(page)).toHaveValue("catalogue");
        await expectPanelKeyReserved(name(page), "Escape"); await name(page).press("Escape"); await expect(input(page)).toBeFocused();
        await name(page).evaluate(node => { node.dataset.retained = "rename-name"; });
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(before.bindings.views.find(v => v.id === "primary")!.selectionSet);
        await input(page).press("F2"); await input(page, "Secondary source").focus();
        await name(page).fill("discarded"); await name(page).press("Enter"); await waitForRename(page);
        expect((await snapshot(page)).bindings.rename.capture?.view).toBe("primary");
        await expect(targets(page)).toHaveCount(5); await exact(page, raw);
        const apply = button(page, "Apply captured rename");
        await apply.hover(); await page.mouse.down();
        await name(page).fill("café"); await expect(apply).toBeDisabled(); await expect(targets(page)).toHaveCount(0); await name(page).press("Enter"); await waitForRename(page);
        await expect(apply).toBeEnabled(); await apply.hover(); await page.mouse.up(); await waitForRename(page); await exact(page, raw);
        await expect(targets(page)).toHaveCount(5); await expect(targets(page).filter({ hasText: "// fixture rename" })).toHaveCount(1); expect((await snapshot(page)).history).toEqual(before.history);
        await expect(name(page)).toHaveAttribute("data-retained", "rename-name");
        // Some frame-inspection backends expose raw UTF-8 as Latin-1. Applied model text below
        // and actual preview text establish Unicode correctness independently of that diagnostic.
        await expect(targets(page).filter({ hasText: "café" })).toHaveCount(4);
        const request = requests.filter(r => r.method === "textDocument/rename").at(-1)!; expect(request.params.position).toEqual({ line: 1, character: 8 });
        const initialize = requests.find(r => r.method === "initialize" && r.params.capabilities.textDocument.rename)!; expect(initialize.params.capabilities.workspace.workspaceEdit.documentChanges).toBe(true);
        const remote = await page.evaluate(uri => window.hostFixture.providerCustom("fixture/document", { uri, from: 0, to: 0 }), request.params.textDocument.uri) as { version: number };
        expect(responses.at(-1).documentChanges.find((change: any) => change.textDocument.uri === request.params.textDocument.uri).textDocument.version).toBe(remote.version);
        const expected = marker + raw.replace("const catalogue", "const café").replace("\r\ncatalogue;", "\r\ncafé;");
        await expectPanelKeyReserved(name(page), "Enter"); await exact(page, raw);
        await page.keyboard.press("Enter"); await waitForRename(page); await exact(page, expected); await expect(input(page)).toBeFocused();
        const companion = before.bindings.navigation.companion!; expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe("const café = 1;\r\ncafé;\r\n"); expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
        await button(page, "Open renamed changes in Navigation companion").evaluate(node => { node.dataset.retained = "rename-resource"; });
        await input(page).press("Control+End"); await input(page).pressSequentially("H"); await waitForRename(page); await input(page, "Secondary source").press("Control+z"); await waitForRename(page); await exact(page, expected);
        await input(page, "Secondary source").press("Control+z"); await waitForRename(page); await exact(page, raw); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges.map(r => ({ anchor: r.anchor, head: r.head }))).toEqual(ranges);
        await input(page, "Secondary source").press("Control+Shift+z"); await waitForRename(page); await button(page, "Open renamed changes in Navigation companion").click(); await waitForRename(page); await expect(input(page, "Secondary source")).toBeFocused();
        await expect(button(page, "Open renamed changes in Navigation companion")).toHaveAttribute("data-retained", "rename-resource");
        await input(page, "Secondary source").press("Control+z"); await waitForRename(page); await exact(page, raw);
        expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe("const catalogue = 1;\r\ncatalogue;\r\n");
        await input(page, "Secondary source").press("Control+Shift+z"); await waitForRename(page); await exact(page, expected);
        expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe("const café = 1;\r\ncafé;\r\n");
        expect((await snapshot(page)).source.exports).toBe(0); await dispose(page); await expect.poll(() => closed).toBe(opened);
    });
    if (coversHost("candidate-hosts", host, "candidate")) test("malformed targets, authority changes, cancelled captures and reconnect leave editing available", async ({ page }) => {
        const replies = await holdLspReplies(page, "textDocument/rename"); await page.reload();
        let requests = 0, lastPosition: unknown; page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method === "textDocument/rename") { requests++; lastPosition = value.params.position; } }));
        await seed(page); await button(page, "Add navigation companion").click(); const before = await snapshot(page), companion = before.bindings.navigation.companion!;
        await page.evaluate(() => window.hostFixture.faultRenameNext("malformed")); await preview(page); expect((await snapshot(page)).bindings.rename.state).toMatchObject({ status: "failed", count: 0, canApply: false }); await exact(page, raw); expect((await snapshot(page)).history).toEqual(before.history);
        await preview(page); await page.evaluate(id => window.hostFixture.setProjectTargetReadOnly(id, true), companion); await waitForRename(page); await expect(button(page, "Apply captured rename")).toBeDisabled();
        await preview(page); await expect(button(page, "Apply captured rename")).toBeDisabled();
        await expect(page.getByLabel("Rename status", { exact: true })).toContainText("read-only or locked");
        expect(await page.evaluate(() => window.hostFixture.snapshot().bindings.rename.state.preview!.confirm())).toEqual({ applied: false, reason: "not-writable" });
        // A programmatic click must not bypass the captured permission policy either.
        await button(page, "Apply captured rename").dispatchEvent("click"); await name(page).press("Enter"); await waitForRename(page); await exact(page, raw);
        expect((await snapshot(page)).bindings.rename.state.status).toBe("ready"); expect((await snapshot(page)).history).toEqual(before.history);
        expect(await targets(page).count()).toBeGreaterThan(0);
        expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe("const catalogue = 1;\r\ncatalogue;\r\n"); await page.evaluate(id => window.hostFixture.setProjectTargetReadOnly(id, false), companion);
        await preview(page); await expect(button(page, "Apply captured rename")).toBeEnabled();
        const retired = await page.evaluateHandle(() => window.hostFixture.snapshot().bindings.rename.state.preview!);
        await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
        await select(page, raw.indexOf("catalogue") + 2); await preview(page); await expect(button(page, "Apply captured rename")).toBeEnabled();
        expect(await retired.evaluate(p => [p.confirm(), p.readPage() === undefined])).toEqual([{ applied: false, reason: "expired" }, true]); await retired.dispose();
        await exact(page, raw); expect((await snapshot(page)).history).toEqual(before.history);
        for (const mode of ["selection", "typing", "remount"] as const) {
            await select(page, raw.indexOf("catalogue") + 2); await name(page).fill("inventory"); replies.hold(); await button(page, "Prepare rename preview").click(); await expect.poll(replies.waiting).toBe(true); expect((await snapshot(page)).bindings.rename.state.pending).toBe(true);
            const pendingRequests = requests;
            await name(page).press("Enter"); expect(requests).toBe(pendingRequests);
            if (mode === "selection") await select(page, raw.indexOf("catalogue") + 3);
            else if (mode === "typing") { await input(page).press("Control+End"); await input(page).pressSequentially("x"); await waitForRename(page); await input(page).press("Control+z"); }
            else await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
            await expect.poll(replies.cancelled).toBe(true); await replies.release();
            await waitForRename(page); await expect(button(page, "Apply captured rename")).toBeDisabled(); await exact(page, raw);
        }
        await select(page, raw.indexOf("catalogue") + 2); await preview(page); await page.evaluate(() => window.hostFixture.faultIdleRename()); await waitForRename(page); await expect(button(page, "Apply captured rename")).toBeDisabled();
        await button(page, "Reconnect rename provider").click(); await select(page, raw.indexOf("catalogue") + 2); await preview(page); await button(page, "Disconnect rename provider").click(); await input(page).press("Control+End"); await input(page).pressSequentially("local"); await waitForRename(page); await exact(page, raw + "local"); await button(page, "Reconnect rename provider").click(); await select(page, raw.indexOf("catalogue") + 2); await preview(page); await expect(button(page, "Apply captured rename")).toBeEnabled();
        const count = requests; await select(page, raw.indexOf(";") + 1); await preview(page); expect(requests).toBe(count + 1); expect(lastPosition).toEqual({ line: 1, character: "const catalogue = 1;".length }); expect((await snapshot(page)).bindings.rename.state.count).toBe(0);
        expect(await page.evaluate(() => window.hostFixture.snapshot().bindings.rename.state.preview!.confirm())).toEqual({ applied: false, reason: "no-changes" });
        await exact(page, raw + "local"); await dispose(page);
    });
    if (coversHost("candidate-hosts", host, "candidate")) test("comparison rename preserves its baseline and primary Save/Run through unmounted-target focus", async ({ page }) => {
        await seed(page); await button(page, "Open source review").click(); await button(page, "Add navigation companion").click(); await waitForRename(page); const working = input(page, "Comparison working source"), before = await snapshot(page), baseline = before.bindings.comparison!.baseline;
        await working.focus(); await page.evaluate(at => { const f = window.hostFixture; f.selectSourceSet("comparison", f.snapshot().source.revision, [{ anchor: at, head: at }]); }, raw.indexOf("catalogue") + 2); await working.press("F2"); await name(page).fill("inventory"); await name(page).press("Enter"); await waitForRename(page);
        expect((await snapshot(page)).bindings.rename.capture!.view).toBe("comparison"); await button(page, "Apply captured rename").click(); await waitForRename(page); const expected = marker + raw.replace("const catalogue", "const inventory").replace("\r\ncatalogue;", "\r\ninventory;"); await exact(page, expected); expect((await snapshot(page)).bindings.comparison!.baseline).toEqual(baseline);
        const reference = input(page, "Comparison baseline source"), baselineText = await page.evaluate(length => window.hostFixture.referenceRange(0, length), baseline!.length); await reference.focus(); await reference.press("F2"); await expect(name(page)).not.toBeFocused(); expect(await page.evaluate(length => window.hostFixture.referenceRange(0, length), baseline!.length)).toBe(baselineText);
        await button(page, "Open renamed changes in Navigation companion").click(); await waitForRename(page); await button(page, "Run captured inputs").click(); expect((await snapshot(page)).pendingRuns[0]!.sourceId).toBe(before.source.id); expect(await page.evaluate(() => window.hostFixture.runCapture(0)!.source)).toBe(expected); await page.evaluate(() => window.hostFixture.finishRun());
        await button(page, "Save source").click(); await working.press("Control+End"); await working.pressSequentially(" later"); await waitForRename(page); await page.evaluate(() => window.hostFixture.finishSave()); await waitForRename(page); await exact(page, expected + " later"); expect((await snapshot(page)).source.dirty).toBe(true); expect((await snapshot(page)).bindings.comparison!.baseline).toEqual(baseline); await dispose(page);
    });
    if (coversHost("plain-candidate", host, "candidate")) test("100k-line rename pages its preview, preserves form focus and shares atomic undo with bounded input", async ({ page }) => {
        test.setTimeout(90000);
        const text = "const catalogue = 1;\r\n" + "const unchanged = 123;\r\n".repeat(99_929) + "catalogue;\r\n".repeat(70);
        await seed(page, text); const before = await snapshot(page); await preview(page);
        await expect(targets(page)).toHaveCount(64); await expect(button(page, "Previous rename targets")).toBeDisabled();
        expect((await snapshot(page)).bindings.rename.state).toMatchObject({ status: "ready", count: 72, page: 0 });
        await button(page, "Next rename targets").click(); await expect(targets(page)).toHaveCount(8);
        await expect(targets(page).first().locator("..")).toHaveAttribute("start", "65"); await expect(button(page, "Next rename targets")).toBeDisabled();
        expect((await snapshot(page)).bindings.rename.state.locations.map(item => item.ordinal)).toEqual([64, 65, 66, 67, 68, 69, 70, 71]);
        await button(page, "Previous rename targets").click(); await expect(targets(page)).toHaveCount(64);
        await expect(targets(page).first().locator("..")).toHaveAttribute("start", "1");
        await name(page).focus(); await name(page).press("End"); await name(page).pressSequentially("X");
        await expect(name(page)).toBeFocused(); await expect(name(page)).toHaveValue("inventoryX");
        await expect(button(page, "Apply captured rename")).toBeDisabled(); await expect(targets(page)).toHaveCount(0);
        await exact(page, text); expect((await snapshot(page)).history).toEqual(before.history);
        await name(page).press("Enter"); await waitForRename(page); await expect(name(page)).toBeFocused();
        await expect(targets(page)).toHaveCount(64); await expect(button(page, "Apply captured rename")).toBeEnabled();
        await button(page, "Apply captured rename").click(); await waitForRename(page);
        const expected = marker + text.replaceAll("catalogue", "inventoryX"); await exact(page, expected); await input(page).press("Control+z"); await waitForRename(page); await exact(page, text); await input(page).press("Control+Shift+z"); await waitForRename(page); await exact(page, expected);
        expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1); expect((await snapshot(page)).source.exports).toBe(0); expect((await snapshot(page)).bindings.views.every(view => view.metrics!.inputUnits <= 4096 && view.metrics!.viewport.rows < 100)).toBe(true); await dispose(page);
    });
});
