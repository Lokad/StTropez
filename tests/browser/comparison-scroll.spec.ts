import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const snapshot = (p: Page) => p.evaluate(() => window.hostFixture.snapshot());
const check = (p: Page) => p.getByRole("checkbox", { name: "Link review scrolling", exact: true });
const button = (p: Page, name: string) => p.getByRole("button", { name, exact: true });
async function waitForReview(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (s.bindings.comparison !== null); });
}
async function exact(p: Page, text: string): Promise<void> { expect(await p.evaluate(text => { const f = window.hostFixture; if (f.snapshot().source.length !== text.length) return false; for (let i = 0; i < text.length; i += 32768) if (f.range(i, Math.min(i + 32768, text.length)) !== text.slice(i, i + 32768)) return false; return true; }, text)).toBe(true); }
async function scroll(p: Page, side: "baseline" | "working", row: number, left?: number): Promise<void> {
    await p.locator(".st-comparison-panes .st-viewport").nth(side === "baseline" ? 0 : 1).evaluate((node, { row, left }) => {
        const c = window.hostFixture.snapshot().bindings.comparison!, h = node === node.parentElement!.parentElement!.parentElement!.querySelector(".st-viewport") ? c.referenceViewport!.lineHeight : c.workingViewport.lineHeight;
        node.scrollTop = 12 + row * h; if (left !== undefined) node.scrollLeft = left;
    }, { row, left });
    await expect.poll(async () => { const c = (await snapshot(p)).bindings.comparison!, v = side === "baseline" ? c.referenceViewport! : c.workingViewport; return Math.abs(v.scrollTop - (12 + row * v.lineHeight)); }).toBeLessThan(1);
    await waitForReview(p);
}
for (const host of ["plain", "react"]) for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} linked review scroll preserves captured rows, selections, history, reference and lifecycle`, async ({ page: p }) => {
    test.setTimeout(120000);  await p.goto(`/hosts/${host}/?editor=candidate`);
    const rows = Array.from({ length: large ? 100000 : 900 }, (_, i) => `row ${i.toString().padStart(6, "0")}: café😀;ok;\r\n`); rows[9] = "long " + "x".repeat(1000) + "\r\n";
    const raw = rows.join(""), offset = (line: number) => rows.slice(0, line).join("").length;
    await p.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, raw);
    for (const name of ["Open source review", "Capture review acceptance", "Finish review acceptance"]) { await button(p, name).click(); await waitForReview(p); }
    const edits = [{ from: offset(20) + 4, to: offset(20) + 4, insert: "XYZ" }, { from: offset(80), to: offset(80), insert: "inserted\r\n".repeat(5) }, { from: offset(140), to: offset(147), insert: "" }];
    let working = raw; for (const edit of edits.slice().reverse()) working = working.slice(0, edit.from) + edit.insert + working.slice(edit.to);
    await p.evaluate(edits => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, edits); }, edits); await waitForReview(p);
    const input = p.getByRole("textbox", { name: "Comparison working source", exact: true }); await input.focus();
    const anchor = working.indexOf("row 000250"); await p.evaluate(anchor => { const f = window.hostFixture; f.selectSourceSet("comparison", f.snapshot().source.revision, [{ anchor: anchor + 5, head: anchor + 2 }, { anchor: anchor + 14, head: anchor + 14 }], 1); }, anchor); await waitForReview(p);
    await scroll(p, "working", 248.25, 60); const before = await snapshot(p); await expect(check(p)).not.toBeChecked(); expect(before.bindings.comparison!.referenceViewport!.scrollTop).toBe(0);
    await check(p).press("Space"); await expect(check(p)).toBeChecked(); await waitForReview(p); let c = (await snapshot(p)).bindings.comparison!;
    // Native scrollTop may quantize the request. Project the actual source position,
    // keeping the subpixel follower assertion independent of that browser rounding.
    const source = before.bindings.comparison!.workingViewport;
    expect(c.referenceViewport!.scrollTop).toBeCloseTo(12 + ((source.scrollTop - 12) / source.lineHeight + 2) * c.referenceViewport!.lineHeight, 0); expect(c.referenceViewport!.scrollLeft).toBe(0);
    expect(c.selectionSet).toEqual(before.bindings.comparison!.selectionSet); expect(c.baseline).toEqual(before.bindings.comparison!.baseline); expect((await snapshot(p)).history).toEqual(before.history);
    await scroll(p, "baseline", 350.5, 120); c = (await snapshot(p)).bindings.comparison!;
    expect(c.workingViewport.scrollTop).toBeCloseTo(12 + ((c.referenceViewport!.scrollTop - 12) / c.referenceViewport!.lineHeight - 2) * c.workingViewport.lineHeight, 0); expect(c.workingViewport.scrollLeft).toBeCloseTo(before.bindings.comparison!.workingViewport.scrollLeft, 0);
    const reference = p.locator(".st-comparison-panes .st-viewport").first(); await reference.scrollIntoViewIfNeeded();
    const box = await reference.boundingBox(); expect(box).not.toBeNull(); const wheelTop = c.referenceViewport!.scrollTop;
    expect(await reference.evaluate(node => { const box = node.getBoundingClientRect(); return node.ownerDocument.elementFromPoint(box.x + 100, box.y + 100)?.closest(".st-viewport") === node; })).toBe(true);
    await p.mouse.move(box!.x + 100, box!.y + 100); await p.mouse.wheel(0, 250);
    await expect.poll(async () => (await snapshot(p)).bindings.comparison!.referenceViewport!.scrollTop).toBeGreaterThan(wheelTop + 50); await waitForReview(p); c = (await snapshot(p)).bindings.comparison!;
    await expect.poll(async () => { const c = (await snapshot(p)).bindings.comparison!; return Math.abs(c.referenceViewport!.scrollTop - c.workingViewport.scrollTop - 2 * c.workingViewport.lineHeight); }).toBeLessThan(.5);
    c = (await snapshot(p)).bindings.comparison!;
    await exact(p, working); expect((await snapshot(p)).history).toEqual(before.history); expect(c.selectionSet).toEqual(before.bindings.comparison!.selectionSet);
    // Disable in the same task as a queued source scroll; a later frame cannot move the other pane.
    const disabled = await p.locator(".st-comparison-panes .st-viewport").last().evaluate(node => {
        const f = window.hostFixture, old = f.snapshot().bindings.comparison!.referenceViewport!.scrollTop; node.scrollTop += 400; node.dispatchEvent(new Event("scroll"));
        const pending = f.snapshot().bindings.comparison!.work.pendingScroll, toggle = node.ownerDocument.querySelector<HTMLInputElement>('.st-comparison-controls input[type="checkbox"]')!;
        toggle.checked = false; toggle.dispatchEvent(new Event("change")); return { pending, after: f.snapshot().bindings.comparison!.work.pendingScroll, old };
    }); expect(disabled).toMatchObject({ pending: true, after: false }); await waitForReview(p); expect((await snapshot(p)).bindings.comparison!.referenceViewport!.scrollTop).toBe(disabled.old);
    await check(p).check(); await waitForReview(p);
    if (!large) {
        // Folding projects to a visible header without expanding either view or changing its set.
        await p.evaluate(({ from, to }) => { const f = window.hostFixture; f.selectSourceSet("comparison", f.snapshot().source.revision, [{ anchor: from, head: to }]); }, { from: working.indexOf("row 000400"), to: working.indexOf("row 000420") });
        await input.press("Control+Shift+["); await waitForReview(p); expect((await snapshot(p)).bindings.comparison!.workingViewport.collapsedFolds).toBeGreaterThan(0);
        await scroll(p, "baseline", 410); c = (await snapshot(p)).bindings.comparison!; expect(c.workingViewport.collapsedFolds).toBeGreaterThan(0);
        expect(c.workingViewport.scrollTop).toBeCloseTo(12 + 398 * c.workingViewport.lineHeight, 0);
        await input.press("Control+Shift+]"); await waitForReview(p);
    }
    const mounted = (await snapshot(p)).bindings.comparison!; await p.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await waitForReview(p); await expect(check(p)).toBeChecked();
    const retained = (await snapshot(p)).bindings.comparison!;
    expect(retained.viewId).toBe(mounted.viewId); expect(retained.baseline).toMatchObject({ version: before.bindings.comparison!.baseline!.version, length: before.bindings.comparison!.baseline!.length });
    await input.press("Control+End"); await input.pressSequentially("H"); await waitForReview(p); await exact(p, working + "H");
    expect((await snapshot(p)).bindings.comparison!.baseline).toEqual(retained.baseline);
    await p.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+z"); await waitForReview(p); await exact(p, working);
    await input.press("Control+Shift+z"); await waitForReview(p); await exact(p, working + "H"); expect((await snapshot(p)).source.exports).toBe(0);
    await input.press("Control+s"); await button(p, "Finish save").click(); await waitForReview(p); const saved = await snapshot(p); expect(saved.source.dirty).toBe(false);
    await button(p, "Capture review acceptance").click();
    await p.locator(".st-comparison-panes .st-viewport").first().evaluate(node => { node.scrollTop = 3000; node.dispatchEvent(new Event("scroll")); const buttons = [...node.ownerDocument.querySelectorAll<HTMLButtonElement>("button")]; buttons.find(b => b.textContent === "Finish review acceptance")!.click(); });
    await waitForReview(p); c = (await snapshot(p)).bindings.comparison!; expect(c.referenceIsWorkingBuffer).toBe(true); expect(c.workingViewport.scrollTop).toBeCloseTo(c.referenceViewport!.scrollTop, 0);
    expect((await snapshot(p)).source.exports).toBe(saved.source.exports); expect(c.workingViewport.rows).toBeLessThan(100); expect(c.referenceViewport!.rows).toBeLessThan(100);
    const disposed = await p.locator(".st-comparison-panes .st-viewport").last().evaluate(async node => { node.scrollTop = 5000; node.dispatchEvent(new Event("scroll")); const pending = window.hostFixture.snapshot().bindings.comparison!.work.pendingScroll; await window.hostFixture.dispose(); return { pending, state: window.hostFixture.snapshot() }; });
    expect(disposed.pending).toBe(true); expect(disposed.state.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(disposed.state.hostSubscriptions).toBe(0); expect(disposed.state.bindings.comparison).toBeNull();
});
