import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const click = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).click();
const version = (page: Page, id: string) => page.getByRole("combobox", { name: "Review version", exact: true }).selectOption(id);
async function ready(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(() => { const s = window.hostFixture.snapshot(), c = s.bindings.comparison;
        return s.bindings.views.every(v => v.metrics && !v.metrics.pendingCaret && !v.metrics.pendingWord && !v.metrics.pendingGrapheme && !v.metrics.viewport.pending
            && v.metrics.viewport.revision === s.source.revision && v.metrics.viewport.selectionSet === v.selectionSet)
            && (!c || c.status === "ready" && !c.input.pendingCaret && !c.input.pendingWord && !c.input.pendingGrapheme && !c.workingViewport.pending && !c.referenceViewport?.pending);
    })).toBe(true);
}
async function exact(page: Page, value: string, reference = false): Promise<void> {
    expect(await page.evaluate(({ value, reference }) => { const f = window.hostFixture;
        const length = reference ? f.snapshot().bindings.comparison?.baseline?.length : f.snapshot().source.length;
        if (length !== value.length) return false;
        for (let from = 0; from < value.length; from += 32768) {
            const to = Math.min(value.length, from + 32768), actual = reference ? f.referenceRange(from, to) : f.range(from, to);
            if (actual !== value.slice(from, to)) return false;
        }
        return true;
    }, { value, reference })).toBe(true);
}
async function mount(page: Page, host: string, text: string): Promise<void> {
    page.on("pageerror", error => { throw error; }); await page.goto(`/hosts/${host}/?editor=candidate`);
    await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, text);
    await click(page, "Open source review"); await ready(page); await click(page, "Capture review acceptance"); await click(page, "Finish review acceptance"); await ready(page);
}
async function append(page: Page, text: string): Promise<void> { await input(page).press("Control+End"); await ready(page); await input(page).pressSequentially(text); await ready(page); }

for (const host of ["plain", "react"]) for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} selected versions, discard and saved history stay independent of working Save and Run`, async ({ page }) => {
    test.setTimeout(120000);
    const original = "base alpha\r\nstable beta\r\nlast 😀" + (large ? "\r\n" + "const stable = 1;\r\n".repeat(100000) + "tail" : "");
    await mount(page, host, original); const initial = await snapshot(page), sourceId = initial.source.id;
    await click(page, "Keep draft version"); await append(page, " human"); await version(page, "draft"); expect((await snapshot(page)).variants.status).toBe("loading");
    await append(page, " later"); await click(page, "Finish version load"); await ready(page); const changed = original + " human later";
    await exact(page, changed); await exact(page, original, true); expect((await snapshot(page)).source.serverVersion).toBe("v0");
    const beforeDiscard = await snapshot(page); await click(page, "Discard reviewed changes"); expect((await snapshot(page)).bindings.comparison!.discards).toHaveLength(1);
    await click(page, "Confirm reviewed discard"); await ready(page); await exact(page, original);
    expect((await snapshot(page)).history.undoDepth).toBe(beforeDiscard.history.undoDepth + 1); expect((await snapshot(page)).source.dirty).toBe(true);
    await input(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, changed);
    expect((await snapshot(page)).bindings.comparison!.selectionSet).toEqual(beforeDiscard.bindings.comparison!.selectionSet);
    await input(page, "Comparison working source").press("Control+Shift+z"); await ready(page); await exact(page, original); expect((await snapshot(page)).source.exports).toBe(0);
    await input(page).press("Control+s"); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
    await append(page, " after save"); await click(page, "Finish save"); await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1"); await ready(page);
    expect((await snapshot(page)).source.dirty).toBe(true); await input(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, original); expect((await snapshot(page)).source.dirty).toBe(false);
    await version(page, "saved"); await click(page, "Finish version load"); await ready(page); await exact(page, original, true);
    expect((await snapshot(page)).variants.selected!.version).toBe("reference:saved-v1");
    await page.evaluate(() => window.hostFixture.externalWrite("remote\r\ncaptured")); await version(page, "server");
    await page.evaluate(() => window.hostFixture.externalWrite("newer remote")); await append(page, " live"); await click(page, "Finish version load"); await ready(page);
    await exact(page, "remote\r\ncaptured", true); await exact(page, original + " live"); expect((await snapshot(page)).source.serverVersion).toBe("v1");
    await expect(page.getByRole("combobox", { name: "Review version", exact: true })).toHaveValue("__captured");
    const historical = (await snapshot(page)).variants.choices.find(choice => choice.kind === "history")!;
    await version(page, historical.id); await click(page, "Finish version load"); await ready(page); await exact(page, "start", true); await exact(page, original + " live");
    await click(page, "Run captured inputs"); await expect.poll(async () => (await snapshot(page)).pendingRuns.length).toBe(1);
    const running = await snapshot(page); expect(running.pendingRuns[0]).toMatchObject({ sourceId, sourceRevision: running.source.revision, sourceLength: original.length + 5 });
    expect(await page.evaluate(() => window.hostFixture.runCapture(0)!.source.slice(-5))).toBe(" live"); await click(page, "Finish run");
    await expect.poll(async () => (await snapshot(page)).activity.pendingRuns).toBe(0);
    const retained = await snapshot(page); await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await ready(page);
    const remounted = await snapshot(page); expect(remounted.source.id).toBe(sourceId); expect(remounted.history).toEqual(retained.history);
    expect(remounted.bindings.views.map(v => v.selectionSet)).toEqual(retained.bindings.views.map(v => v.selectionSet)); await exact(page, "start", true); await exact(page, original + " live");
    expect(remounted.bindings.views.every(v => v.metrics!.inputUnits <= 2600 && v.metrics!.viewport.rows < 100 && v.metrics!.viewport.readUnits < 20000)).toBe(true);
    await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect((await snapshot(page)).hostSubscriptions).toBe(0);
});

for (const host of ["plain", "react"]) test(`${host} stale version loads and discard confirmations preserve later typing, takeover and composition`, async ({ page }) => {
    test.setTimeout(90000); const original = "human source\r\nkept"; await mount(page, host, original); await click(page, "Keep draft version");
    await page.evaluate(() => window.hostFixture.externalWrite("remote")); await version(page, "server");
    await click(page, "Replace primary panel"); await click(page, "Reopen primary source"); await ready(page); const baseline = (await snapshot(page)).bindings.comparison!.baseline;
    await click(page, "Finish version load"); await ready(page); expect((await snapshot(page)).variants.status).toBe("expired"); expect((await snapshot(page)).bindings.comparison!.baseline).toEqual(baseline); await exact(page, original);
    await version(page, "draft"); await version(page, "server"); await click(page, "Finish version load"); expect((await snapshot(page)).variants.status).toBe("loading");
    await click(page, "Finish version load"); await ready(page); await exact(page, "remote", true);
    await click(page, "Discard reviewed changes"); await append(page, " later"); const later = original + " later", before = await snapshot(page);
    await click(page, "Confirm reviewed discard"); await ready(page); await exact(page, later); expect((await snapshot(page)).history).toEqual(before.history);
    await click(page, "Discard reviewed changes"); await version(page, "saved"); await click(page, "Cancel version load"); await click(page, "Confirm reviewed discard"); await ready(page); await exact(page, later);
    await click(page, "Discard reviewed changes"); await version(page, "server"); await click(page, "Associate agent"); await click(page, "Request proposal"); await click(page, "Interrupt agent");
    await append(page, " human"); const corrected = later + " human"; await click(page, "Deliver proposal"); await click(page, "Finish version load"); await click(page, "Confirm reviewed discard"); await ready(page); await exact(page, corrected);
    await click(page, "Detach agent"); await click(page, "Associate agent"); await click(page, "Request proposal"); await click(page, "Deliver proposal"); await ready(page);
    await exact(page, "agent proposal"); await input(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, corrected);
    await input(page).press("Control+End"); await ready(page);
    await input(page).evaluate(node => {
        if (!(node instanceof HTMLTextAreaElement)) throw new Error("Expected the bounded native input.");
        node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        node.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertCompositionText", data: "é", isComposing: true }));
        node.setRangeText("é", node.selectionStart, node.selectionEnd, "end"); node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "é", isComposing: true }));
    });
    await click(page, "Discard reviewed changes"); expect((await snapshot(page)).bindings.comparison!.discards).toHaveLength(0); await exact(page, corrected);
    await input(page).evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "é" }))); await ready(page); await exact(page, corrected + "é");
    await click(page, "Discard reviewed changes"); await page.evaluate(() => { window.hostFixture.setSourceReadOnly(true); window.hostFixture.setSourceReadOnly(false); });
    await click(page, "Confirm reviewed discard"); await ready(page); await exact(page, corrected + "é");
    await click(page, "Discard reviewed changes"); await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await ready(page);
    await click(page, "Confirm reviewed discard"); await ready(page); await exact(page, corrected + "é");
    await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect((await snapshot(page)).hostSubscriptions).toBe(0);
});
