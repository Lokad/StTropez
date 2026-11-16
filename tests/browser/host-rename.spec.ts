import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const snapshot = (p: Page) => p.evaluate(() => window.hostFixture.snapshot());
const input = (p: Page, name = "Primary source") => p.getByRole("textbox", { name, exact: true });
const button = (p: Page, name: string) => p.getByRole("button", { name, exact: true });
async function waitForRename(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (!s.bindings.rename.state.pending); });
}
async function exact(p: Page, text: string): Promise<void> {
    expect(await p.evaluate(text => { const f = window.hostFixture; if (f.snapshot().source.length !== text.length) return false;
        for (let at = 0; at < text.length; at += 32768) if (f.range(at, Math.min(at + 32768, text.length)) !== text.slice(at, at + 32768)) return false; return true;
    }, text)).toBe(true);
}
async function setup(p: Page, host: string, text: string): Promise<void> {
     await p.goto(`/hosts/${host}/?editor=candidate`);
    await p.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, text); await waitForRename(p);
}
async function select(p: Page, at = 8): Promise<void> { await input(p).focus(); await p.evaluate(at => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: at, head: at }]); }, at); }
async function preview(p: Page, name = "inventory"): Promise<void> { await button(p, "Prepare rename preview").click(); await waitForRename(p); await p.getByLabel("New identifier", { exact: true }).fill(name); }
async function dispose(p: Page): Promise<void> {
    await p.evaluate(() => window.hostFixture.dispose()); const s = await snapshot(p);
    expect(s.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(s.hostSubscriptions).toBe(0);
    expect(s.bindings.rename).toMatchObject({ sessions: 0, subscriptions: 0, transport: null, disposed: true }); expect(s.bindings.rename.worker.created).toBe(s.bindings.rename.worker.terminated);
}
for (const host of ["plain", "react"]) {
    test(`${host} keyboard rename focuses the selected name, cancels to the exact origin and applies only after explicit confirmation`, async ({ page: p }) => {
        const raw = "const catalogue = 1;\r\ncatalogue;", expected = raw.replaceAll("catalogue", "inventory"); await setup(p, host, raw); await input(p).focus();
        await p.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 11, head: 8 }, { anchor: f.snapshot().source.length, head: f.snapshot().source.length }]); });
        const before = await snapshot(p), name = p.getByLabel("New identifier", { exact: true });
        await input(p).press("F2"); await waitForRename(p); await expect(name).toBeFocused(); await p.keyboard.type("stock");
        await expect(name).toHaveValue("stock"); await exact(p, raw); expect((await snapshot(p)).history).toEqual(before.history);
        await p.keyboard.press("Escape"); await expect(input(p)).toBeFocused(); expect((await snapshot(p)).bindings.rename.capture).toBeNull();
        expect((await snapshot(p)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(before.bindings.views.find(v => v.id === "primary")!.selectionSet);
        await input(p).press("F2"); await waitForRename(p); await expect(name).toBeFocused(); await p.keyboard.type("inventory"); await expect(name).toHaveValue("inventory");
        await p.keyboard.press("Tab"); await expect(button(p, "Prepare rename preview")).toBeFocused(); await p.keyboard.press("Tab"); await expect(button(p, "Apply captured rename")).toBeFocused();
        await exact(p, raw); await p.keyboard.press("Enter"); await waitForRename(p); await exact(p, expected); expect((await snapshot(p)).history.undoDepth).toBe(before.history.undoDepth + 1); await dispose(p);
    });
    for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} rename preview applies atomically with shared history, review and primary Save/Run identity`, async ({ page: p }) => {
        test.setTimeout(120000); const raw = "const catalogue = 1;\r\n" + (large ? "const unchanged = 123;\r\n".repeat(100000) : "") + "catalogue; // catalogue\r\n'catalogue';", expected = raw.replace("const catalogue", "const inventory").replace("\r\ncatalogue;", "\r\ninventory;");
        await setup(p, host, raw); await button(p, "Open source review").click(); await button(p, "Add navigation companion").click(); await waitForRename(p);
        await input(p).focus(); const ranges = [{ anchor: 11, head: 8 }, { anchor: raw.length, head: raw.length }];
        await p.evaluate(ranges => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, ranges, 0); }, ranges);
        const before = await snapshot(p), baseline = before.bindings.comparison!.baseline;
        await preview(p); let s = await snapshot(p); expect(s.bindings.rename.state).toMatchObject({ status: "ready", count: 4, canApply: true });
        expect(s.history.undoDepth).toBe(before.history.undoDepth); expect(s.source.exports).toBe(0); expect(s.bindings.rename.worker).toMatchObject({ created: 1, opened: 2 });
        await expect(p.getByLabel("Captured rename targets", { exact: true }).locator("li")).toHaveCount(4);
        await button(p, "Apply captured rename").click(); await waitForRename(p); await exact(p, expected); s = await snapshot(p);
        expect(s.bindings.rename.applied).toBe(1); expect(s.history.undoDepth).toBe(before.history.undoDepth + 1); expect(s.bindings.comparison!.baseline).toEqual(baseline);
        expect(s.bindings.views.find(v => v.id === "primary")!.selectionSet.ranges.map(r => ({ anchor: r.anchor, head: r.head }))).toEqual(ranges);
        const companion = s.bindings.navigation.companion!; expect(await p.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe("const inventory = 1;\r\ninventory;\r\n");
        await input(p).press("Control+End"); await input(p).pressSequentially("H"); await waitForRename(p); await exact(p, expected + "H");
        await input(p, "Secondary source").press("Control+z"); await waitForRename(p); await exact(p, expected);
        await input(p, "Secondary source").press("Control+z"); await waitForRename(p); await exact(p, raw);
        expect((await snapshot(p)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges.map(r => ({ anchor: r.anchor, head: r.head }))).toEqual(ranges);
        await input(p, "Secondary source").press("Control+Shift+z"); await waitForRename(p); await exact(p, expected);
        if (!large) {
            await input(p, "Comparison working source").focus(); await p.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("comparison", f.snapshot().source.revision, [{ anchor: 11, head: 8 }, { anchor: f.snapshot().source.length, head: f.snapshot().source.length }]); });
            await input(p, "Comparison working source").press("F2"); await waitForRename(p); await p.getByLabel("New identifier", { exact: true }).fill("stock");
            expect((await snapshot(p)).bindings.rename.capture!.view).toBe("comparison"); expect((await snapshot(p)).bindings.rename.state.canApply).toBe(true);
            await button(p, "Dismiss rename preview").click(); await exact(p, expected); expect((await snapshot(p)).bindings.comparison!.baseline).toEqual(baseline);
        }
        await button(p, "Open renamed changes in Navigation companion").click(); await waitForRename(p);
        await expect(input(p, "Secondary source")).toBeFocused(); await input(p, "Secondary source").press("Control+z"); await waitForRename(p); await exact(p, raw);
        await input(p, "Secondary source").press("Control+Shift+z"); await waitForRename(p); await exact(p, expected);
        await button(p, "Run captured inputs").click(); expect(await p.evaluate(text => window.hostFixture.runCapture(0)!.source === text, expected)).toBe(true); await p.evaluate(() => window.hostFixture.finishRun());
        await button(p, "Save source").click(); await p.evaluate(() => window.hostFixture.finishSave()); await waitForRename(p); expect((await snapshot(p)).source.dirty).toBe(false);
        expect((await snapshot(p)).bindings.views.every(v => v.metrics!.viewport.rows < 100)).toBe(true); await dispose(p);
    });
    test(`${host} rename rejects late authority, changed selections, delayed typing, remount and malformed results`, async ({ page: p }) => {
        test.setTimeout(120000); const raw = "const catalogue = 1;\r\ncatalogue;"; await setup(p, host, raw); await button(p, "Add navigation companion").click();
        await select(p); await preview(p); const before = await snapshot(p), companion = before.bindings.navigation.companion!;
        await p.evaluate(id => window.hostFixture.setProjectTargetReadOnly(id, true), companion); await waitForRename(p);
        expect((await snapshot(p)).bindings.rename.state.canApply).toBe(false); await exact(p, raw);
        await select(p); await preview(p); await expect(button(p, "Apply captured rename")).toBeDisabled();
        await expect(p.getByLabel("Rename status", { exact: true })).toContainText("read-only or locked");
        await button(p, "Apply captured rename").dispatchEvent("click"); await waitForRename(p);
        expect((await snapshot(p)).bindings.rename.state.status).toBe("ready"); expect((await snapshot(p)).bindings.rename.state.locations.length).toBeGreaterThan(0);
        await exact(p, raw); expect((await snapshot(p)).history.undoDepth).toBe(before.history.undoDepth); expect(await p.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe("const catalogue = 1;\r\ncatalogue;\r\n");
        await p.evaluate(id => window.hostFixture.setProjectTargetReadOnly(id, false), companion);
        for (const mode of ["selection", "typing", "lease", "remount"] as const) {
            await select(p); await p.evaluate(() => window.hostFixture.setRenameDelay(1000)); await button(p, "Prepare rename preview").click();
            expect((await snapshot(p)).bindings.rename.state.pending).toBe(true);
            if (mode === "selection") await p.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 9, head: 9 }]); });
            else if (mode === "typing") { await input(p).press("Control+End"); await input(p).pressSequentially("X"); }
            else if (mode === "lease") await p.evaluate(() => window.hostFixture.cycleSourceEditLease());
            else await p.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
            await waitForRename(p); expect((await snapshot(p)).bindings.rename.state.canApply).toBe(false); expect((await snapshot(p)).bindings.rename.applied).toBe(0);
        }
        await exact(p, raw + "X"); await p.evaluate(() => window.hostFixture.setRenameDelay(0));
        for (const fault of ["malformed", "failure"] as const) {
            await select(p); await p.evaluate(fault => window.hostFixture.faultRenameNext(fault), fault); await preview(p); expect((await snapshot(p)).bindings.rename.state.status).toBe("failed"); await exact(p, raw + "X");
            await button(p, "Reconnect rename provider").click();
        }
        await select(p); await preview(p); expect(await p.evaluate(() => window.hostFixture.faultIdleRename())).toBe(true);
        await expect.poll(async () => (await snapshot(p)).bindings.rename.state.canApply).toBe(false); expect((await snapshot(p)).bindings.rename.transport).toBeNull();
        await button(p, "Reconnect rename provider").click(); await select(p); await preview(p); expect((await snapshot(p)).bindings.rename.state.canApply).toBe(true); await dispose(p);
    });
    test(`${host} worker rename rejects unsupported names and truncated results`, async ({ page: p }) => {
        test.setTimeout(120000); const raw = "const catalogue = 1;\r\ncatalogue;"; await setup(p, host, raw); await select(p); await input(p).press("F2"); await waitForRename(p);
        await p.getByLabel("New identifier", { exact: true }).fill("<img>"); await expect(button(p, "Apply captured rename")).toBeDisabled();
        await p.getByLabel("New identifier", { exact: true }).fill("café"); await expect(button(p, "Apply captured rename")).toBeEnabled();
        await exact(p, raw);
        await button(p, "Dismiss rename preview").click(); const over = "catalogue;".repeat(1025);
        await p.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, over);
        await waitForRename(p); await select(p, 3); await preview(p); expect((await snapshot(p)).bindings.rename.state.status).toBe("failed"); await expect(p.getByLabel("Rename status", { exact: true })).toContainText("exceeds 1,024");
        await exact(p, over); expect((await snapshot(p)).source.exports).toBe(0); await dispose(p);
    });
}
