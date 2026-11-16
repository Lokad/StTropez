import { ready, isolatedTest as test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const source = "// TODO\r\nconst catalogue = 1;\r\ncatalogue;", caret = source.lastIndexOf("catalogue") + 2;
const methods = ["textDocument/definition", "textDocument/rename", "textDocument/codeAction"];

async function settled(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => {
        const s = window.hostFixture.snapshot();
        return window.hostFixture.settled && !s.bindings.navigation.pending && !s.bindings.rename.state.pending && !s.bindings.actions.state.pending;
    });
}
async function select(page: Page, at: number): Promise<void> {
    await input(page).focus();
    await page.evaluate(at => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: at, head: at }]); }, at);
    await settled(page);
}
async function seed(page: Page, text: string, at: number): Promise<void> {
    await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, text);
    await select(page, at);
}
async function exact(page: Page, text: string): Promise<void> {
    expect(await page.evaluate(text => {
        const f = window.hostFixture;
        if (f.snapshot().source.length !== text.length) return false;
        for (let at = 0; at < text.length; at += 32768) if (f.range(at, Math.min(text.length, at + 32768)) !== text.slice(at, at + 32768)) return false;
        return true;
    }, text)).toBe(true);
}
async function composition(page: Page, offered: "rename" | "actions"): Promise<void> {
    expect((await snapshot(page)).bindings[offered].state.canApply).toBe(true);
    await blocked(page, "composition");
    await expect(button(page, "Apply captured rename")).toBeDisabled();
    await expect(button(page, "Apply captured action")).toBeDisabled();
    // Synthetic composition exercises arbitration, not native IME. Remount explicitly ends it.
    await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
    await settled(page);
}
async function previews(page: Page, checkComposition = false): Promise<void> {
    await select(page, caret);
    const before = await snapshot(page);
    await input(page).press("F12"); await settled(page);
    await expect(page.getByRole("list", { name: "Navigation results", exact: true }).getByRole("button")).toHaveCount(1);
    await select(page, caret);
    await page.getByLabel("New identifier", { exact: true }).fill("inventory");
    await button(page, "Prepare rename preview").click();
    await expect.poll(async () => (await snapshot(page)).bindings.rename.state.canApply).toBe(true);
    // The first action request registers a command capability, expiring earlier protocol
    // captures. Check composition against each live offer before starting another feature.
    if (checkComposition) { await composition(page, "rename"); await select(page, caret); }
    await button(page, "Preview module action").click();
    await expect(button(page, "Apply captured action")).toBeEnabled();
    await settled(page);
    const after = await snapshot(page);
    expect(after.bindings.navigation.requested).toBe(before.bindings.navigation.requested + 1);
    expect(after.bindings.rename.requested).toBe(before.bindings.rename.requested + 1);
    expect(after.bindings.actions.requested).toBe(before.bindings.actions.requested + 1);
    expect(after.history).toEqual(before.history); expect(after.source.revision).toBe(before.source.revision);
    if (checkComposition) await composition(page, "actions");
}

// All requests run in the same turn as the input event, before cooperative work can finish.
// This tests each binding's capture guard without repeating the large paste per feature.
async function blocked(page: Page, kind: "movement" | "composition" | "paste", text = ""): Promise<void> {
    const result = await input(page).evaluate((node, { kind, text }) => {
        const f = window.hostFixture, before = f.snapshot();
        if (kind === "movement") node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true }));
        else if (kind === "composition") node.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
        else {
            const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            event.clipboardData!.setData("text/plain", text); node.dispatchEvent(event);
        }
        const pending = f.snapshot(), click = (label: string) => [...document.querySelectorAll("button")].find(button => button.textContent === label)!.click();
        node.dispatchEvent(new KeyboardEvent("keydown", { key: "F12", bubbles: true, cancelable: true }));
        node.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true }));
        click("Prepare rename preview"); f.requestAction();
        if (kind === "paste") for (const label of ["Insert catalogue import", "Save source", "Run captured inputs"]) click(label);
        const after = f.snapshot();
        return {
            movement: pending.bindings.views.find(v => v.id === "primary")!.metrics!.pendingCommand,
            paste: pending.bindings.tablePaste.pending, pasteStillPending: after.bindings.tablePaste.pending,
            navigation: after.bindings.navigation.requested - before.bindings.navigation.requested,
            rename: after.bindings.rename.requested - before.bindings.rename.requested,
            actions: after.bindings.actions.requested - before.bindings.actions.requested,
            domain: after.bindings.domain.requested - before.bindings.domain.requested,
            saves: after.pendingSaves.length, runs: after.pendingRuns.length,
            renameApplicable: after.bindings.rename.state.canApply, actionApplicable: after.bindings.actions.state.canApply,
            revision: after.source.revision - before.source.revision, historyUnchanged: JSON.stringify(after.history) === JSON.stringify(before.history),
        };
    }, { kind, text });
    expect(result).toMatchObject({ navigation: 0, rename: 0, actions: 0, domain: 0, saves: 0, runs: 0, revision: 0, historyUnchanged: true });
    if (kind === "movement") expect(result.movement).toBe(true);
    if (kind === "composition") expect(result).toMatchObject({ renameApplicable: false, actionApplicable: false });
    if (kind === "paste") expect(result).toMatchObject({ paste: true, pasteStillPending: true });
}

for (const host of ["plain", "react"]) test(`${host} LSP captures wait for movement, composition and table input before fresh previews and Save/Run`, async ({ page }) => {
    test.setTimeout(120000);
    const wire: string[] = [];
    page.on("websocket", socket => socket.on("framesent", frame => {
        const message = JSON.parse(frame.payload.toString()); if (methods.includes(message.method)) wire.push(message.method);
    }));
    await page.goto(`/hosts/${host}/?editor=candidate&language=lsp`);
    await expect(input(page)).toBeVisible(); await settled(page);
    await page.getByLabel("New identifier", { exact: true }).fill("inventory");
    await seed(page, "catalogue " + " ".repeat(1000000) + "end", 10);
    await blocked(page, "movement"); await settled(page);
    expect(wire).toEqual([]);

    await seed(page, source, caret); await previews(page, true);
    expect(wire).toEqual(methods);

    const cell = "B".repeat(400000), csv = '"A","' + cell + '"', expected = source.slice(0, caret) + csv + source.slice(caret);
    await select(page, caret); await page.getByLabel("New identifier", { exact: true }).fill("inventory");
    await page.getByRole("checkbox", { name: "Paste tables as CSV", exact: true }).check();
    await input(page).focus(); await settled(page);
    const before = await snapshot(page);
    await blocked(page, "paste", "A\t" + cell);
    await expect.poll(async () => (await snapshot(page)).bindings.tablePaste.pending, { timeout: 30000 }).toBe(false);
    await settled(page); await exact(page, expected); expect(wire).toEqual(methods);
    const pasted = await snapshot(page);
    expect(pasted.bindings.tablePaste.status).toBe("applied"); expect(pasted.history.undoDepth).toBe(before.history.undoDepth + 1);
    expect(pasted.source.exports).toBe(0); expect(pasted.inputRecovery).toEqual([]);
    await button(page, "Dismiss message").click(); await button(page, "Save source").click();
    await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
    expect((await snapshot(page)).pendingSaves[0]).toMatchObject({ revision: pasted.source.revision, length: expected.length });
    await page.evaluate(() => window.hostFixture.finishSave()); await settled(page);
    await button(page, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(page)).pendingRuns.length).toBe(1);
    expect(await page.evaluate(() => window.hostFixture.runCapture(0)!.source)).toBe(expected);
    await page.evaluate(() => window.hostFixture.finishRun());
    await input(page, "Secondary source").press("Control+z"); await settled(page); await exact(page, source);
    expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth);
    await previews(page); expect(wire).toEqual([...methods, ...methods]);
    await page.evaluate(() => window.hostFixture.dispose());
    const final = await snapshot(page);
    expect(final.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(final.hostSubscriptions).toBe(0);
    expect(final.bindings.navigation).toMatchObject({ sessions: [], subscriptions: 0, pending: false, results: 0 });
    expect(final.bindings.rename).toMatchObject({ sessions: 0, subscriptions: 0, disposed: true });
    expect(final.bindings.actions).toMatchObject({ sessions: 0, subscriptions: 0, disposed: true });
    expect(final.bindings.lsp).toMatchObject({ scopes: 0, documents: 0, created: 1, terminated: 1 });
    await expect.poll(() => page.workers().length).toBe(0);
});
