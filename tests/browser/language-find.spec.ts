import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.editingFixture.snapshot());
async function ready(page: Page) { await expect.poll(async () => { const s = await snapshot(page); return s.primary.viewport.revision === s.document?.revision && !s.primary.viewport.pending && !s.secondary.viewport.pending; }).toBe(true); }
async function found(page: Page, count: number) { await expect.poll(async () => { const s = (await snapshot(page)).find; return s.status === "ready" ? s.count : -1; }).toBe(count); }
async function offer(page: Page) { await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible(); }
test.beforeEach(async ({ page }) => {
    page.on("pageerror", error => { throw error; });
    page.on("console", message => { if (message.type() === "error") throw new Error(message.text()); });
    await page.goto("/editing/"); await ready(page);
});

test("literal find wraps Unicode ranges and replacement is one shared undoable transaction", async ({ page }) => {
    const text = "😀 const saMORE = 123; // TODO\r\nconst saMORE = 2;";
    await page.evaluate(text => window.editingFixture.setText(text), text); await ready(page);
    await page.getByRole("textbox", { name: "Find", exact: true }).fill("saMORE"); await found(page, 2);
    await expect(page.locator("#primary .st-search-match")).toHaveCount(2);
    await page.getByRole("button", { name: "Next match", exact: true }).click();
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: text.indexOf("saMORE"), head: text.indexOf("saMORE") + 6 });
    await page.getByRole("button", { name: "Previous match", exact: true }).click(); expect((await snapshot(page)).primary.selection.anchor).toBe(text.lastIndexOf("saMORE"));
    await page.getByRole("textbox", { name: "Replace with", exact: true }).fill("$&");
    const depth = (await snapshot(page)).history!.undoDepth;
    await page.getByRole("button", { name: "Replace all", exact: true }).click(); await found(page, 0); await ready(page);
    const expected = text.split("saMORE").join("$&");
    expect(await page.evaluate(length => window.editingFixture.range(0, length), (await snapshot(page)).document!.length)).toBe(expected);
    expect((await snapshot(page)).history!.undoDepth).toBe(depth + 1);
    await page.keyboard.press("ControlOrMeta+z"); await found(page, 2);
    expect(await page.evaluate(length => window.editingFixture.range(0, length), text.length)).toBe(text);
    await page.getByRole("button", { name: "Next match", exact: true }).click();
    await page.getByRole("textbox", { name: "Replace with", exact: true }).fill("sample");
    await page.getByRole("button", { name: "Replace match", exact: true }).click(); await found(page, 1);
    expect((await snapshot(page)).document!.exports).toBe(0);
});

test("keyboard find routing, read-only replacement and a pilot-sized replace-all retain exact history", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.load("lines-10000"); window.editingFixture.focus("primary"); });
    await page.keyboard.press("ControlOrMeta+f"); await expect(page.getByRole("textbox", { name: "Find", exact: true })).toBeFocused();
    await page.keyboard.type("const"); await found(page, 10_000); await page.keyboard.press("Enter");
    await expect(page.getByRole("textbox", { name: "Primary source", exact: true })).toBeFocused();
    await page.keyboard.press("ControlOrMeta+h"); await expect(page.getByRole("textbox", { name: "Replace with", exact: true })).toBeFocused(); await page.keyboard.type("let");
    await page.evaluate(() => window.editingFixture.readOnly(true)); await page.getByRole("button", { name: "Replace all", exact: true }).click();
    await expect(page.locator("#find-status")).toHaveText("read-only"); expect((await snapshot(page)).document!.length).toBe(240_000);
    await page.evaluate(() => window.editingFixture.readOnly(false)); const before = await snapshot(page);
    await page.getByRole("button", { name: "Replace all", exact: true }).click(); await found(page, 0); await ready(page);
    expect((await snapshot(page)).document).toMatchObject({ revision: before.document!.revision + 1, length: 220_000, exports: 0 });
    expect((await snapshot(page)).history!.undoDepth).toBe(before.history!.undoDepth + 1);
    expect(await page.evaluate(() => window.editingFixture.range(0, 22))).toBe("let sample = 1234567;\n");
    await page.keyboard.press("ControlOrMeta+z"); await found(page, 10_000); expect((await snapshot(page)).document!.length).toBe(240_000);
});

test("100k-line search yields, caps only its preview and rejects stale replace-all planning", async ({ page }) => {
    const progress = await page.evaluate(() => new Promise<{
        before: ReturnType<typeof window.editingFixture.snapshot>;
        partial: ReturnType<typeof window.editingFixture.snapshot>;
        cancelled: ReturnType<typeof window.editingFixture.snapshot>;
    }>(resolve => {
        const f = window.editingFixture, before = f.snapshot(); f.find("const");
        setTimeout(() => { const partial = f.snapshot(); f.cancelFind(); resolve({ before, partial, cancelled: f.snapshot() }); }, 0);
    }));
    expect(progress.partial.find.status).toBe("searching");
    expect(progress.partial.find.scanned).toBeGreaterThan(0);
    expect(progress.partial.find.scanned).toBeLessThan(progress.partial.document!.length);
    expect(progress.partial.find.count).toBeGreaterThan(0);
    expect(progress.cancelled.find.status).toBe("cancelled");
    expect(progress.cancelled.history).toEqual(progress.before.history);
    expect(progress.cancelled.document).toEqual(progress.before.document);
    await page.evaluate(() => window.editingFixture.find("const")); await found(page, 100_000);
    expect((await snapshot(page)).find.previewCount).toBe(200); expect((await snapshot(page)).document!.exports).toBe(0);
    await page.evaluate(() => { window.editingFixture.replaceAll("let"); window.editingFixture.edit([{ from: 0, to: 0, insert: "later " }]); }); await found(page, 100_000);
    expect(await page.evaluate(() => window.editingFixture.range(0, 11))).toBe("later const");
    await page.evaluate(() => { window.editingFixture.find("sample"); window.editingFixture.cancelFind(); window.editingFixture.edit([{ from: 0, to: 0, insert: "!" }]); });
    expect((await snapshot(page)).find.status).toBe("cancelled");
    await page.evaluate(() => { window.editingFixture.find("const"); window.editingFixture.dispose(); });
    expect((await snapshot(page)).diagnostics).toMatchObject({ resources: 0, documents: 0, subscriptions: 0, views: 0, leases: 0 });
});

test("visible highlighting reuses unchanged lines and native glyph selection survives token spans", async ({ page }) => {
    const before = (await snapshot(page)).presentation;
    await page.evaluate(() => window.editingFixture.focus("primary")); await page.keyboard.type("z"); await ready(page);
    const after = (await snapshot(page)).presentation;
    expect(after.primary.lexedLines - before.primary.lexedLines).toBe(1); expect(after.secondary.lexedLines - before.secondary.lexedLines).toBe(1);
    expect(after.primary.cachedLines).toBeLessThanOrEqual(128);
    await page.evaluate(() => window.editingFixture.setText("😀 const saMORE = 123; // TODO")); await ready(page);
    for (const [className, text] of [["keyword", "const"], ["number", "123"], ["comment", "// TODO"]]) await expect(page.locator(`#primary .st-token-${className}`)).toHaveText(text!);
    const colors = await Promise.all(["keyword", "number", "comment"].map(kind => page.locator(`#primary .st-token-${kind}`).evaluate(node => getComputedStyle(node).color)));
    expect(new Set(colors).size).toBe(3);
    const point = await page.evaluate(() => window.editingFixture.coords(9)!); await page.mouse.click(point.left, point.top + point.height / 2);
    expect((await snapshot(page)).primary.selection.head).toBe(9);
});

test("actual worker completion distinguishes insertion/replacement and maps Unicode diagnostics through shared history", async ({ page }) => {
    const text = "😀 const saMORE = 123; // TODO";
    await page.evaluate(text => { window.editingFixture.setText(text); const head = text.indexOf("MORE"); window.editingFixture.select("primary", { anchor: head, head }); }, text); await ready(page);
    await page.getByRole("button", { name: "Request completion", exact: true }).click(); await offer(page);
    await expect(page.locator("#primary .st-diagnostic")).toHaveText("TODO");
    await page.getByRole("button", { name: "Replace completion", exact: true }).click(); await ready(page);
    expect(await page.evaluate(length => window.editingFixture.range(0, length), text.length)).toBe(text.replace("saMORE", "sample"));
    expect((await snapshot(page)).provider).toMatchObject({ applied: 1, diagnostics: 1, posted: 1, received: 1 });
    await page.keyboard.press("ControlOrMeta+z"); await ready(page);
    expect(await page.evaluate(length => window.editingFixture.range(0, length), text.length)).toBe(text);
    await page.getByRole("button", { name: "Request completion", exact: true }).click(); await offer(page);
    await page.getByRole("button", { name: "Insert completion", exact: true }).click(); await ready(page);
    const inserted = text.replace("sa", "sample");
    expect(await page.evaluate(length => window.editingFixture.range(0, length), inserted.length)).toBe(inserted);
    await expect(page.getByRole("list", { name: "Provider diagnostics", exact: true })).toHaveText(`${inserted.indexOf("TODO")}: Resolve this placeholder.`);
    await page.getByRole("list", { name: "Provider diagnostics", exact: true }).getByRole("button").click();
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: inserted.indexOf("TODO"), head: inserted.indexOf("TODO") + 4 });
    expect((await snapshot(page)).document!.exports).toBe(0);
});

test("provider replies reject newer text, moved selection, cancellation and expired tab targets", async ({ page }) => {
    await page.evaluate(() => window.editingFixture.setProviderDelay(0));
    let expectedStale = 0;
    for (const action of ["edit", "selection", "cancel", "replace"]) {
        await page.evaluate(() => { window.editingFixture.setText("const saMORE = 1; // TODO"); window.editingFixture.select("primary", { anchor: 8, head: 8 }); });
        if (action === "edit") {
            await page.evaluate(() => {
                window.editingFixture.focus("primary");
                document.querySelector("#primary textarea")!.addEventListener("beforeinput", () => window.editingFixture.requestProvider(), { once: true });
            });
            await page.keyboard.type("x"); // The request and native commit share one task; the worker reply must be later.
        } else await page.evaluate(action => {
            window.editingFixture.requestProvider();
            if (action === "selection") window.editingFixture.select("primary", { anchor: 0, head: 0 });
            if (action === "cancel") window.editingFixture.cancelProvider();
            if (action === "replace") window.editingFixture.replacePrimary();
        }, action);
        await expect.poll(async () => (await snapshot(page)).provider.stale).toBe(++expectedStale);
        expect((await snapshot(page)).provider.offer).toBe(false); expect((await snapshot(page)).provider.applied).toBe(0);
    }
    expect((await snapshot(page)).provider.cancelled).toBe(1);
});

test("malformed results, worker failure and permissions leave local editing usable; reconnect proves the worker path", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("const saMORE = 1; // TODO"); window.editingFixture.select("primary", { anchor: 8, head: 8 }); window.editingFixture.faultProviderNext("malformed"); });
    await page.getByRole("button", { name: "Request completion", exact: true }).click(); await expect.poll(async () => (await snapshot(page)).provider.invalid).toBe(1);
    expect((await snapshot(page)).provider.offer).toBe(false);
    await page.evaluate(() => window.editingFixture.faultProviderNext("failure"));
    await page.getByRole("button", { name: "Request completion", exact: true }).click(); await expect.poll(async () => (await snapshot(page)).provider.failed).toBe(1);
    expect((await snapshot(page)).provider.connected).toBe(false);
    await page.evaluate(() => window.editingFixture.focus("primary")); await page.keyboard.type("x"); expect((await snapshot(page)).primary.commits).toBe(1);
    await page.getByRole("button", { name: "Reconnect provider", exact: true }).click(); await page.getByRole("button", { name: "Request completion", exact: true }).click(); await offer(page);
    const revision = (await snapshot(page)).document!.revision;
    await page.evaluate(() => window.editingFixture.readOnly(true)); await page.getByRole("button", { name: "Replace completion", exact: true }).click();
    await expect(page.locator("#provider-status")).toContainText("read-only"); expect((await snapshot(page)).document!.revision).toBe(revision);
    await page.evaluate(() => window.editingFixture.readOnly(false));
    await page.getByRole("button", { name: "Request completion", exact: true }).click(); await offer(page); await page.getByRole("button", { name: "Replace completion", exact: true }).click();
    expect((await snapshot(page)).provider.applied).toBe(1);
});

test("a no-op completion preserves revision and diagnostics, and scoped requests remain bounded in a huge document", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("const sample = 1; // TODO"); window.editingFixture.select("primary", { anchor: 12, head: 12 }); });
    const revision = (await snapshot(page)).document!.revision;
    await page.getByRole("button", { name: "Request completion", exact: true }).click(); await offer(page); await page.getByRole("button", { name: "Insert completion", exact: true }).click();
    expect((await snapshot(page)).document!.revision).toBe(revision); expect((await snapshot(page)).provider.diagnostics).toBe(1);
    await page.evaluate(() => { window.editingFixture.load("lines-100000"); window.editingFixture.select("primary", { anchor: 1_200_008, head: 1_200_008 }); });
    const units = (await snapshot(page)).provider.postedUnits;
    await page.getByRole("button", { name: "Request completion", exact: true }).click(); await offer(page);
    expect((await snapshot(page)).provider.postedUnits - units).toBe(4096); expect((await snapshot(page)).document!.exports).toBe(0);
    await page.evaluate(() => window.editingFixture.dispose());
    expect((await snapshot(page)).diagnostics).toMatchObject({ resources: 0, documents: 0, views: 0, leases: 0, subscriptions: 0 });
});

test("request boundaries refuse partial-word replacement and diagnostic truncation is visible", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("a".repeat(6000)); window.editingFixture.select("primary", { anchor: 3000, head: 3000 }); });
    const revision = (await snapshot(page)).document!.revision;
    await page.getByRole("button", { name: "Request completion", exact: true }).click(); await expect.poll(async () => (await snapshot(page)).provider.outOfScope).toBe(1);
    expect((await snapshot(page)).document!.revision).toBe(revision); expect((await snapshot(page)).provider.offer).toBe(false);
    await page.evaluate(() => { window.editingFixture.setText("const sa; " + "TODO ".repeat(300)); window.editingFixture.select("primary", { anchor: 8, head: 8 }); });
    await page.getByRole("button", { name: "Request completion", exact: true }).click(); await offer(page);
    expect((await snapshot(page)).provider.diagnostics).toBe(256); await expect(page.locator("#provider-status")).toContainText("first 256");
});
