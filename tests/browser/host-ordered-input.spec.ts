import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { hostTextEquals } from "../../scripts/host-scene.mjs";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const exact = async (page: Page, text: string) => expect(await hostTextEquals(page, text)).toBe(true);

test("Apple caret chords and native history keep their selection and command order", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "platform", { value: "MacIntel" }));
    await page.goto("/hosts/plain/");
    const prefix = "a".repeat(200001) + ";end\r\n", original = prefix + "last";
    await page.evaluate(text => { const f = window.hostFixture;
        f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]);
        f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: 0 }]);
    }, original); await ready(page);
    const input = page.getByRole("textbox", { name: "Primary source", exact: true }); await input.focus(); const before = await snapshot(page);
    await input.press("Control+ArrowRight");
    await input.press("Meta+ArrowDown");
    await input.press("Shift+Meta+ArrowLeft");
    await page.keyboard.insertText("R");
    const handled = await input.evaluate(node => ["historyUndo", "historyRedo"].map(inputType =>
        !node.dispatchEvent(new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true }))));
    expect(handled).toEqual([true, true]);
    await ready(page, 30000); await exact(page, prefix + "R"); const after = await snapshot(page);
    expect(after.source.revision).toBe(before.source.revision + 3); expect(after.history.undoDepth).toBe(before.history.undoDepth + 1);
    expect(after.bindings.views.find(view => view.id === "primary")!.selection).toMatchObject({ anchor: prefix.length + 1, head: prefix.length + 1 });
    expect(after.inputRecovery).toHaveLength(0);
    await input.pressSequentially("!"); await ready(page); await exact(page, prefix + "R!");
    await page.evaluate(() => window.hostFixture.dispose());
});

test("plain Save and Run capture typing immediately after word navigation", async ({ page }) => {
    await page.goto("/hosts/plain/");
    const word = "a".repeat(200_001), original = word + ";end", expected = word + "typed;end";
    await page.evaluate(original => {
        const f = window.hostFixture, s = f.snapshot().source;
        f.editSource(s.revision, [{ from: 0, to: s.length, insert: original }]);
        f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: 0 }]);
    }, original);
    await ready(page);
    const input = page.getByRole("textbox", { name: "Primary source", exact: true });
    await input.focus();
    await input.press("Control+ArrowRight");
    await page.keyboard.insertText("typed");
    const settled = await snapshot(page);
    await page.getByRole("button", { name: "Save source", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
    expect((await snapshot(page)).pendingSaves[0]).toMatchObject({ revision: settled.source.revision, length: expected.length });
    await page.getByRole("button", { name: "Run captured inputs", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).pendingRuns.length).toBe(1);
    expect((await page.evaluate(() => window.hostFixture.runCapture(0)))!.source).toBe(expected);
    await page.evaluate(() => {
        const f = window.hostFixture, s = f.snapshot().source;
        f.selectSourceSet("primary", s.revision, [{ anchor: s.length, head: s.length }]);
    });
    await input.pressSequentially("Q");
    await ready(page);
    await page.evaluate(() => {
        window.hostFixture.finishSave();
        window.hostFixture.finishRun();
    });
    await expect.poll(async () => (await snapshot(page)).source.saveStatus).toBe("idle");
    expect((await snapshot(page)).source.dirty).toBe(true);
    await exact(page, expected + "Q");
    await input.press("Control+z");
    await ready(page);
    await exact(page, expected);
    expect((await snapshot(page)).source.dirty).toBe(false);
    await page.evaluate(() => window.hostFixture.dispose());
    expect((await snapshot(page)).inputCaptureGuards).toBe(0);
});
