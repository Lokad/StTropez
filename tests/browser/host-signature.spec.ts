import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const snapshot = (p: Page) => p.evaluate(() => window.hostFixture.snapshot());
const input = (p: Page, name = "Primary source") => p.getByRole("textbox", { name, exact: true });
const button = (p: Page, name: string) => p.getByRole("button", { name, exact: true });
const popup = (p: Page) => p.getByRole("tooltip", { name: "Signature help", exact: true });
const parameter = (p: Page) => popup(p).getByLabel("Active signature parameter", { exact: true });
async function waitForSignature(page: Page, service = true): Promise<void> {
    await ready(page);
    if (service) await page.waitForFunction(() => { const s = window.hostFixture.snapshot().bindings.signature; return window.hostFixture.settled && (!s.pending && !s.scheduled); });
}
async function exact(p: Page, text: string): Promise<void> { expect(await p.evaluate(text => { const f = window.hostFixture; if (f.snapshot().source.length !== text.length) return false;
    for (let from = 0; from < text.length; from += 32768) if (f.range(from, Math.min(text.length, from + 32768)) !== text.slice(from, from + 32768)) return false; return true;
}, text)).toBe(true); }
async function setup(p: Page, host: string, text: string): Promise<void> {
     await p.goto(`/hosts/${host}/?editor=candidate`);
    await p.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, text); await waitForSignature(p);
}
async function select(p: Page, at: number, name: "primary" | "secondary" | "comparison" = "primary"): Promise<void> {
    await input(p, name === "primary" ? "Primary source" : name === "secondary" ? "Secondary source" : "Comparison working source").focus();
    await p.evaluate(({name,at}) => { const f = window.hostFixture; f.selectSourceSet(name, f.snapshot().source.revision, [{ anchor: at, head: at }]); }, {name,at}); await waitForSignature(p, false);
}
async function dispose(p: Page): Promise<void> { await p.evaluate(() => window.hostFixture.dispose()); const s = await snapshot(p);
    expect(s.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(s.hostSubscriptions).toBe(0); expect(s.bindings.signature).toMatchObject({ pending: false, scheduled: false, sessions: 0, subscriptions: 0, layoutObserver: false, layoutFramePending: false, capture: null });
    expect(s.bindings.signature.worker.created).toBe(s.bindings.signature.worker.terminated); await expect.poll(() => p.workers().length).toBe(0);
}
for (const host of ["plain", "react"]) {
    for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} actual typing opens signatures, advances parameters and preserves history, review and primary commands`, async ({ page: p }) => {
        test.setTimeout(120000); const prefix = large ? "const unchanged = 123;\r\n".repeat(100000) : "\ufeff", raw = prefix + "lookup";
        await setup(p, host, raw); await button(p, "Open source review").click(); await waitForSignature(p); const baseline = (await snapshot(p)).bindings.comparison!.baseline;
        await select(p, raw.length); await input(p).pressSequentially("("); await waitForSignature(p); await exact(p, raw + "()"); await expect(parameter(p)).toHaveText("key: string"); await expect(input(p)).toBeFocused();
        let s = await snapshot(p); expect(s.bindings.signature.capture!.open).toBe(raw.length); expect(s.bindings.signature.worker).toMatchObject({ created: 1, opened: 1 }); expect(p.workers().some(w => w.url().endsWith("/provider-worker.js"))).toBe(true);
        await input(p).pressSequentially("1,"); await waitForSignature(p); const expected = raw + "(1,)"; await exact(p, expected); await expect(parameter(p)).toHaveText("fallback?: string");
        s = await snapshot(p); expect(s.bindings.signature.presentation).toMatchObject({ argument: 1, activeSignature: 0, signatureCount: 2 });
        expect(s.bindings.signature.worker).toMatchObject({ created: 1, opened: 1 });
        // Shared-edge planning can resend a small coalesced tail; it need not find the minimal character diff.
        expect(s.bindings.signature.worker.deltaUnits).toBeGreaterThanOrEqual(2); expect(s.bindings.signature.worker.deltaUnits).toBeLessThanOrEqual(128);
        expect(s.bindings.signature.worker.maxChunk).toBeLessThanOrEqual(large ? 16384 : expected.length);
        const selections = s.bindings.views.find(v => v.id === "primary")!.selectionSet, history = s.history;
        await button(p, "Next signature").evaluate(node => { node.dataset.retained = "signature-command"; }); await button(p, "Next signature").click(); await expect(popup(p)).toContainText("keys: readonly string[]"); await expect(parameter(p)).toBeHidden(); await expect(input(p)).toBeFocused(); await button(p, "Previous signature").click(); await expect(parameter(p)).toHaveText("fallback?: string"); await expect(button(p, "Next signature")).toHaveAttribute("data-retained", "signature-command");
        expect((await snapshot(p)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(selections); expect((await snapshot(p)).history).toEqual(history);
        await input(p).press("Escape"); await expect(popup(p)).toBeHidden(); expect((await snapshot(p)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(selections);
        await input(p, "Secondary source").press("Control+z"); await waitForSignature(p); await exact(p, raw + "()"); await input(p, "Secondary source").press("Control+Shift+z"); await waitForSignature(p); await exact(p, expected);
        await select(p, raw.length + 3, "comparison"); await input(p, "Comparison working source").press("Control+Shift+Space"); await waitForSignature(p); await expect(parameter(p)).toHaveText("fallback?: string"); expect((await snapshot(p)).bindings.signature.presentation.view).toBe("comparison");
        expect((await snapshot(p)).bindings.comparison!.baseline).toEqual(baseline); expect((await snapshot(p)).source.exports).toBe(0); expect((await snapshot(p)).bindings.views.every(v => v.metrics!.viewport.rows < 100)).toBe(true);
        await button(p, "Run captured inputs").click(); expect(await p.evaluate(text => window.hostFixture.runCapture(0)!.source === text, expected)).toBe(true); await p.evaluate(() => window.hostFixture.finishRun());
        await button(p, "Save source").click(); await p.evaluate(() => window.hostFixture.finishSave()); await waitForSignature(p); expect((await snapshot(p)).source.dirty).toBe(false); await exact(p, expected); await dispose(p);
    });
    test(`${host} read-only manual signature help keeps complete selections, yields to explicit hover and treats provider text safely`, async ({ page: p }, info) => {
        const raw = "lookup('a', )\r\nformat(1, )"; await setup(p, host, raw); await input(p).focus();
        await p.evaluate(at => { const f = window.hostFixture; f.setSourceReadOnly(true); f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 2, head: 2 }, { anchor: at, head: at }], 1); }, raw.indexOf(")")); await waitForSignature(p);
        const before = await snapshot(p); await input(p).press("Control+Shift+Space"); await waitForSignature(p); await expect(parameter(p)).toHaveText("fallback?: string"); expect((await snapshot(p)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(before.bindings.views.find(v => v.id === "primary")!.selectionSet);
        await popup(p).click(); await expect(input(p)).toBeFocused(); await expect(popup(p)).toBeVisible(); await popup(p).dispatchEvent("scroll"); expect((await snapshot(p)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(before.bindings.views.find(v => v.id === "primary")!.selectionSet);
        if (info.project.name === "chromium") await p.screenshot({ path: `artifacts/signature-pointer-images/host-${host}-signature-pointer.png`, fullPage: true });
        const at = await p.locator('.st-editing-candidate:has(> textarea[aria-label="Primary source"]) .st-viewport-row').first().evaluate(row => { const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), node = walker.nextNode()!; const range = document.createRange(); range.setStart(node, 1); range.setEnd(node, 2); const b = range.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
        const hoverBefore = (await snapshot(p)).bindings.hover.sessions.find(s => s.id === "primary")!.counters.posted; await p.mouse.move(at.x, at.y); await p.waitForTimeout(350); await expect(popup(p)).toBeVisible(); expect((await snapshot(p)).bindings.hover.sessions.find(s => s.id === "primary")!.counters.posted).toBe(hoverBefore);
        const complete = before.bindings.views.find(v => v.id === "primary")!.selectionSet;
        await p.evaluate(set => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, set.ranges, 0); }, complete);
        const hoverSelection = (await snapshot(p)).bindings.views.find(v => v.id === "primary")!.selectionSet;
        await input(p).press("Control+k"); await p.waitForTimeout(100); await input(p).press("Control+i"); await expect(popup(p)).toBeHidden(); await expect(p.getByRole("tooltip")).toContainText("Symbol");
        await input(p).press("Escape"); expect((await snapshot(p)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(hoverSelection);
        await p.evaluate(set => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, set.ranges, set.primary); }, complete);
        await p.evaluate(() => window.hostFixture.faultSignatureNext("markup")); await input(p).press("Control+Shift+Space"); await waitForSignature(p); await expect(popup(p)).toContainText("<img"); await expect(popup(p).locator("img,script")).toHaveCount(0); expect(await p.evaluate(() => Reflect.get(window, "signatureExecuted"))).toBeUndefined();
        await input(p).press("Escape"); expect((await snapshot(p)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(before.bindings.views.find(v => v.id === "primary")!.selectionSet); await input(p).press("Escape"); expect((await snapshot(p)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges).toHaveLength(1);
        expect((await snapshot(p)).history).toEqual(before.history); await exact(p, raw); expect((await snapshot(p)).source.exports).toBe(0); await dispose(p);
    });
    test(`${host} stale signature intents, worker faults and reconnect keep text, focus and current resource ownership`, async ({ page: p }) => {
        const raw = "lookup('key', )"; await setup(p, host, raw); await select(p, raw.indexOf(")")); await p.evaluate(() => window.hostFixture.setSignatureDelay(1000)); await input(p).press("Control+Shift+Space"); expect((await snapshot(p)).bindings.signature.pending).toBe(true);
        const form = p.getByRole("textbox", { name: "Configuration path", exact: true }); await form.fill("during-signature.csv"); await waitForSignature(p); await expect(form).toBeFocused(); expect((await snapshot(p)).bindings.signature.applied).toBe(0);
        await p.evaluate(() => window.hostFixture.setSignatureDelay(0)); await select(p, raw.indexOf(")"));
        for (const fault of ["malformed", "failure"] as const) { await p.evaluate(fault => window.hostFixture.faultSignatureNext(fault), fault); await input(p).press("Control+Shift+Space"); await waitForSignature(p); expect((await snapshot(p)).bindings.signature.presentation.status).toBe("failed"); await expect(popup(p)).toBeHidden(); await exact(p, raw); await expect(input(p)).toBeFocused(); await button(p, "Reconnect signature provider").click(); }
        await input(p).press("Control+Shift+Space"); await waitForSignature(p); await expect(parameter(p)).toHaveText("fallback?: string"); expect(await p.evaluate(() => window.hostFixture.faultIdleSignature())).toBe(true); await expect.poll(async () => (await snapshot(p)).bindings.signature.presentation.status).toBe("failed"); await expect(popup(p)).toBeHidden();
        await button(p, "Reconnect signature provider").click(); await input(p).press("Control+Shift+Space"); await waitForSignature(p); await button(p, "Disconnect signature provider").click(); const requested = (await snapshot(p)).bindings.signature.requested;
        await input(p).pressSequentially("X"); await input(p).press("Control+Shift+Space"); expect((await snapshot(p)).bindings.signature.requested).toBe(requested); const corrected = raw.replace(")", "X)"); await exact(p, corrected);
        await button(p, "Reconnect signature provider").click(); await input(p).press("Control+Shift+Space"); await waitForSignature(p); await expect(parameter(p)).toHaveText("fallback?: string");
        await p.evaluate(() => { window.hostFixture.setSignatureDelay(1000); window.hostFixture.requestSignature(); window.hostFixture.unmount(); window.hostFixture.mount(); }); await waitForSignature(p); await expect(popup(p)).toBeHidden(); await exact(p, corrected); expect((await snapshot(p)).source.exports).toBe(0); await dispose(p);
    });
    test(`${host} signature capture respects yielded navigation, table conversion, composition and authority changes`, async ({ page: p }) => {
        test.setTimeout(120000); const raw = "lookup(" + " ".repeat(1000000) + ")"; await setup(p, host, raw); await select(p, 7);
        const blocked = await input(p).evaluate(node => { const f = window.hostFixture, before = f.snapshot().bindings.signature.requested; node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true })); const pending = f.snapshot().bindings.views.find(v => v.id === "primary")!.metrics!.pendingCommand; node.dispatchEvent(new KeyboardEvent("keydown", { key: " ", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); return { pending, requests: f.snapshot().bindings.signature.requested - before }; });
        expect(blocked).toEqual({ pending: true, requests: 0 }); await waitForSignature(p); await select(p, raw.length - 1); await input(p).press("Control+Shift+Space"); await waitForSignature(p); await expect(parameter(p)).toHaveText("key: string");
        await p.evaluate(() => window.hostFixture.setSignatureDelay(1000)); await input(p).press("Control+Shift+Space"); await p.evaluate(() => { window.hostFixture.setSourceReadOnly(true); window.hostFixture.setSourceReadOnly(false); }); await input(p).press("Escape"); await waitForSignature(p); await expect(popup(p)).toBeHidden(); await exact(p, raw);
        await p.evaluate(() => window.hostFixture.setSignatureDelay(0)); await input(p).press("Control+Shift+Space"); await waitForSignature(p); await input(p).dispatchEvent("compositionstart", { data: "" }); const before = (await snapshot(p)).bindings.signature.requested; await p.evaluate(() => window.hostFixture.requestSignature()); expect((await snapshot(p)).bindings.signature.requested).toBe(before); await expect(popup(p)).toBeHidden();
        await p.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await waitForSignature(p);
        const base = "left right", point = 5, cell = "B".repeat(400000), csv = '"A","' + cell + '"'; await p.evaluate(({base,point}) => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: base }]); f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: point, head: point }]); }, {base,point});
        await p.getByRole("checkbox", { name: "Paste tables as CSV", exact: true }).check(); await input(p).focus(); await waitForSignature(p);
        const guard = await input(p).evaluate((node, text) => { const f = window.hostFixture, before = f.snapshot().bindings.signature.requested, e = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }); e.clipboardData!.setData("text/plain", text); node.dispatchEvent(e); const pending = f.snapshot().bindings.tablePaste.pending; f.requestSignature(); return { pending, requests: f.snapshot().bindings.signature.requested - before }; }, "A\t" + cell);
        expect(guard).toEqual({ pending: true, requests: 0 }); await expect.poll(async () => (await snapshot(p)).bindings.tablePaste.pending).toBe(false); await waitForSignature(p); await exact(p, base.slice(0, point) + csv + base.slice(point)); expect((await snapshot(p)).source.exports).toBe(0); await dispose(p);
    });
}
