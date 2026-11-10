import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
// Explicit background process ownership also avoids the known Firefox context-deletion issue.
const test = base.extend({ page: async ({ playwright, browserName, baseURL }, use) => {
    const browser = await playwright[browserName].launch({ headless: true });
    try { await use(await browser.newPage({ ...(baseURL ? { baseURL } : {}), viewport: { width: 1440, height: 900 } })); } finally { await browser.close(); }
} });
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const source = (page: Page) => page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length));
const field = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const provider = async (page: Page, id = "primary") => (await snapshot(page)).bindings.language.sessions.find(session => session.id === id)!.provider;
async function ready(page: Page) {
    await expect.poll(async () => { const s = await snapshot(page); return s.bindings.views.every(view => !view.metrics?.pendingInput && !view.metrics?.pendingCommand && !view.metrics?.pendingCaret && !view.metrics?.viewport.pending)
        && (!s.bindings.comparison || s.bindings.comparison.status === "ready" && !s.bindings.comparison.workingViewport.pending && !s.bindings.comparison.referenceViewport?.pending); }).toBe(true);
}
async function seed(page: Page, text: string, offset = text.indexOf("saMORE") + 2) {
    await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, text);
    await field(page).focus(); await page.evaluate(offset => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: offset, head: offset }); }, offset); await ready(page);
}
async function offer(page: Page) { await field(page).press("Control+Space"); await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible(); }

for (const mode of ["plain", "react"] as const) test.describe(`${mode} LSP editor host`, () => {
    test.beforeEach(async ({ page }) => {
        page.on("pageerror", error => { throw error; }); await page.goto(`/hosts/${mode}/?editor=candidate&language=lsp`); await expect(field(page)).toBeVisible(); await ready(page);
    });
    test("actual typing, insert/replace choices and additional edits share history across views", async ({ page }) => {
        const packets: string[] = []; page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()) as { method?: string }; if (value.method) packets.push(value.method); }));
        const original = "// 😀\r\nconst saMORE = 1; // TODO\r\n"; await seed(page, original);
        await field(page).pressSequentially("x"); const typed = original.replace("saMORE", "saxMORE"); expect(await source(page)).toBe(typed);
        await expect.poll(async () => (await provider(page)).connected).toBe(true); await page.evaluate(() => window.hostFixture.providerCustom("fixture/completionStyle", { style: "defaults" }));
        await offer(page); expect((await provider(page)).transport).toBe("lsp3.17"); await button(page, "Insert completion").click(); await ready(page);
        expect(await source(page)).toBe(typed.replace("saxMORE", "sampleMORE"));
        await field(page, "Secondary source").press("Control+z"); expect(await source(page)).toBe(typed);
        await seed(page, typed, typed.indexOf("saxMORE") + 3); await offer(page); const depth = (await snapshot(page)).history.undoDepth;
        await page.getByRole("option", { name: "sampleWithImport", exact: true }).getByRole("button").click(); await button(page, "Replace completion").click(); await ready(page);
        const replaced = "// fixture import\r\n" + typed.replace("saxMORE", "sampleValue"); expect(await source(page)).toBe(replaced); expect((await snapshot(page)).history.undoDepth).toBe(depth + 1);
        await field(page, "Secondary source").press("Control+z"); expect(await source(page)).toBe(typed); await field(page, "Secondary source").press("Control+Shift+z"); expect(await source(page)).toBe(replaced);
        expect(packets).toContain("initialize"); expect(packets).toContain("textDocument/completion"); expect(packets).toContain("textDocument/didChange");
        await expect(page.getByLabel("Source diagnostics", { exact: true }).getByRole("button")).toHaveCount(1); expect((await snapshot(page)).source.exports).toBe(0);
    });
    test("diagnostic pushes refuse stale/malformed batches, expose unversioned messages and render plain text", async ({ page }) => {
        await seed(page, "const saMORE = 1; // TODO\r\n"); await offer(page); await button(page, "Cancel request").click();
        const diagnostics = page.getByLabel("Source diagnostics", { exact: true }); await expect(diagnostics.getByRole("button")).toHaveCount(1);
        const before = await provider(page); await page.evaluate(() => window.hostFixture.providerCustom("fixture/diagnostics", { mode: "malformed" }));
        await expect.poll(async () => (await provider(page)).invalid).toBe(before.invalid + 1); await expect(diagnostics.getByRole("button")).toHaveCount(1);
        await page.evaluate(() => window.hostFixture.providerCustom("fixture/diagnostics", { mode: "stale" })); await expect.poll(async () => (await provider(page)).stale).toBe(before.stale + 1);
        await page.evaluate(() => window.hostFixture.providerCustom("fixture/diagnostics", { mode: "unversioned" })); await expect(diagnostics.getByRole("button")).toHaveCount(0);
        await expect(page.getByLabel("Unversioned diagnostics", { exact: true })).toContainText("Resolve this placeholder.");
        await page.evaluate(() => window.hostFixture.providerCustom("fixture/diagnostics", { mode: "html" })); await expect(diagnostics).toContainText("<img src=x onerror=unsafe()>"); expect(await page.locator('img[src="x"]').count()).toBe(0);
        await page.evaluate(() => window.hostFixture.providerCustom("fixture/diagnostics", { mode: "clear" })); await expect(diagnostics.getByRole("button")).toHaveCount(0);
        await page.evaluate(() => window.hostFixture.faultProviderNext("malformed")); await field(page).press("Control+Space"); await expect(page.getByLabel("Language status", { exact: true })).toContainText("Malformed"); await expect(page.getByRole("option")).toHaveCount(0);
        await page.evaluate(() => window.hostFixture.providerCustom("fixture/completionStyle", { style: "plain" })); await offer(page); await field(page).press("Alt+Enter"); expect(await source(page)).toBe("const sample = 1; // TODO\r\n");
    });
    test("pending results expire on navigation, authority changes and remount; outage preserves typing", async ({ page }) => {
        const original = "const saMORE = 1; // TODO"; await seed(page, original); await offer(page); await button(page, "Cancel request").click();
        await page.evaluate(() => window.hostFixture.setProviderDelay(1000)); await field(page).press("Control+Space"); await expect.poll(async () => (await provider(page)).pending).toBe(true);
        await field(page).press("ArrowRight"); await expect.poll(async () => (await provider(page)).pending).toBe(false); await expect(page.getByRole("option")).toHaveCount(0);
        await page.evaluate(() => window.hostFixture.setProviderDelay(0)); await offer(page); await page.evaluate(() => window.hostFixture.setSourceReadOnly(true));
        await expect(page.getByRole("option")).toHaveCount(0); expect(await source(page)).toBe(original); await page.evaluate(() => window.hostFixture.setSourceReadOnly(false));
        await button(page, "Disconnect provider").click(); await field(page).pressSequentially("x"); expect(await source(page)).toBe(original.replace("saMORE", "saMxORE"));
        await button(page, "Reconnect provider").click(); await expect.poll(async () => (await provider(page)).connected).toBe(true); await offer(page);
        await page.evaluate(() => window.hostFixture.setProviderDelay(1000)); await field(page).press("Control+Space"); await page.evaluate(() => window.hostFixture.unmount()); await page.evaluate(() => window.hostFixture.mount()); await ready(page);
        await expect(page.getByRole("option")).toHaveCount(0); expect((await snapshot(page)).bindings.language.sessions.every(session => !session.provider.pending)).toBe(true);
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 }); expect((await snapshot(page)).hostSubscriptions).toBe(0);
    });
    test("LSP completion in conflict review preserves its reference and captured Save/Run identities", async ({ page }) => {
        const original = "const local = 1; // TODO", remote = "const remote = 9;\r\n"; await seed(page, original, original.length);
        await page.evaluate(text => window.hostFixture.externalWrite(text), remote); await button(page, "Save source").click(); await button(page, "Finish save").click();
        await button(page, "Review remote source").click(); await button(page, "Finish remote review").click(); await ready(page);
        const working = field(page, "Comparison working source"); await working.press("Control+End"); await working.pressSequentially("\nconst saMORE"); for (let i = 0; i < 4; i++) await working.press("ArrowLeft");
        await working.press("Control+Space"); await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible(); await working.press("Alt+Enter"); await ready(page);
        const corrected = original + "\nconst sample"; expect(await source(page)).toBe(corrected); expect(await page.evaluate(text => window.hostFixture.referenceRange(0, text.length), remote)).toBe(remote);
        await field(page, "Comparison baseline source").focus(); await expect(button(page, "Request completion")).toBeDisabled(); await expect(field(page, "Comparison baseline source")).toHaveAttribute("readonly", "");
        await working.focus(); const identity = (await snapshot(page)).source.id; await button(page, "Save reviewed source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await working.press("Control+End"); await working.pressSequentially(" later"); await button(page, "Finish save").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(0); expect((await snapshot(page)).source.dirty).toBe(true);
        await button(page, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(page)).pendingRuns.length).toBe(1);
        expect((await snapshot(page)).pendingRuns[0]!.sourceId).toBe(identity); expect(await page.evaluate(() => window.hostFixture.runCapture(0))).toMatchObject({ source: corrected + " later" });
    });
    test("100k-line beginning/middle/end typing and completion retain bounded input without text exports", async ({ page }, info) => {
        const row = "const saMORE = 123; // row\r\n", text = row.repeat(100_000); await seed(page, text, 8); const diagnostics = [];
        const wire: unknown[] = []; let currentLine = 0;
        page.on("websocket", socket => socket.on("framesent", frame => {
            const value = JSON.parse(frame.payload.toString()) as { method?: string; params?: { textDocument?: { version?: number; text?: string }; contentChanges?: { range?: unknown; text: string }[] } };
            if (value.method) wire.push({ line: currentLine, method: value.method, version: value.params?.textDocument?.version, openUnits: value.params?.textDocument?.text?.length, changes: value.params?.contentChanges?.map(change => ({ range: change.range, units: change.text.length })) });
        }));
        try {
        for (const line of [0, 50_000, 99_999]) {
            currentLine = line;
            await field(page).focus(); await page.evaluate(offset => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: offset, head: offset }); }, line * row.length + 8); await ready(page);
            const started = performance.now(); await field(page).pressSequentially("x"); await ready(page); const completeAutomationMs = performance.now() - started;
            const metrics = (await snapshot(page)).bindings.views.find(view => view.id === "primary")!.metrics!; const completionStart = performance.now(); await offer(page); await field(page).press("Alt+Enter"); await ready(page);
            expect(await page.evaluate(({ from, to }) => window.hostFixture.range(from, to), { from: line * row.length, to: (line + 1) * row.length })).toBe(row.replace("saMORE", "sample"));
            expect(metrics.inputUnits).toBeLessThanOrEqual(4096); expect((await snapshot(page)).source.exports).toBe(0);
            diagnostics.push({ line, beforeinputHandlerMs: metrics.lastBeforeInputMs, inputHandlerMs: metrics.lastInputMs, beforeinputEvents: metrics.beforeInputEvents, inputEvents: metrics.inputEvents, completeAutomationMs, completionAutomationMs: performance.now() - completionStart });
        }
        await info.attach("large-lsp-correctness-clocks", { contentType: "application/json", body: JSON.stringify({ scope: "Three correctness samples: own beforeinput handler vs complete automation action including IPC/assertion polling. No latency-tail, native or physical-display qualification.", diagnostics }) });
        } finally { await info.attach("large-lsp-sync-state", { contentType: "application/json", body: JSON.stringify({ line: currentLine, diagnostics, wire, provider: await provider(page), message: await page.getByLabel("Language status", { exact: true }).textContent() }) }); }
    });
});
