import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const snapshot = (p: Page) => p.evaluate(() => window.hostFixture.snapshot());
const button = (p: Page, name: string) => p.getByRole("button", { name, exact: true });
const reference = (p: Page) => p.getByRole("textbox", { name: "Comparison baseline source", exact: true });
const working = (p: Page) => p.getByRole("textbox", { name: "Comparison working source", exact: true });
const pane = (p: Page) => p.locator(".st-comparison-panes .st-viewport").first();
async function waitForReview(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (s.bindings.comparison !== null); });
}
async function setup(p: Page, host: string, raw: string): Promise<void> {  await p.goto(`/hosts/${host}/?editor=candidate`); await p.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, raw); for (const name of ["Open source review", "Capture review acceptance", "Finish review acceptance"]) { await button(p, name).click(); await waitForReview(p); } }
async function exactWorking(p: Page, text: string): Promise<void> { expect(await p.evaluate(text => { const f = window.hostFixture; if (f.snapshot().source.length !== text.length) return false; for (let i = 0; i < text.length; i += 32768) if (f.range(i, Math.min(i + 32768, text.length)) !== text.slice(i, i + 32768)) return false; return true; }, text)).toBe(true); }
async function copy(p: Page, expected: string): Promise<void> { expect(await reference(p).evaluate((node, text) => { const data = new DataTransfer(), event = new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }); node.dispatchEvent(event); return event.defaultPrevented && event.clipboardData!.getData("text/plain") === text; }, expected)).toBe(true); }
async function dispose(p: Page): Promise<void> { await p.evaluate(() => window.hostFixture.dispose()); const s = await snapshot(p); expect(s.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(s.hostSubscriptions).toBe(0); expect(s.bindings.comparison).toBeNull(); }
for (const host of ["plain", "react"]) for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} immutable reference supports source selection, copy, pointer navigation and captured working Save/Run`, async ({ page: p }) => {
    test.setTimeout(120000); const rows = Array.from({ length: large ? 100000 : 900 }, (_, i) => `row ${i.toString().padStart(6, "0")}: café😀 é;\r\n`), raw = rows.join(""), prefix = "inserted\r\ninserted\r\n";
    await setup(p, host, raw); await p.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: text }]); }, prefix); await waitForReview(p);
    await p.locator(".st-comparison-panes .st-viewport").last().evaluate((node, row) => { node.scrollTop = 12 + row * window.hostFixture.snapshot().bindings.comparison!.workingViewport.lineHeight; node.dispatchEvent(new Event("scroll")); }, large ? 50002 : 402); await waitForReview(p);
    const independentTop = (await snapshot(p)).bindings.comparison!.workingViewport.scrollTop;
    await p.getByRole("checkbox", { name: "Align review rows", exact: true }).check(); await waitForReview(p); const before = await snapshot(p), c = before.bindings.comparison!;
    expect(Math.abs(c.workingViewport.scrollTop - independentTop)).toBeLessThan(1); expect(Math.abs(c.referenceViewport!.scrollTop - c.workingViewport.scrollTop)).toBeLessThan(1);
    await expect(reference(p)).toHaveJSProperty("readOnly", true); await expect(reference(p)).toBeEnabled();
    // Retain the former viewport focus entry point; actual Tab targets the read-only textarea.
    await pane(p).focus(); await reference(p).press("Control+Home"); await reference(p).press("Control+Shift+End"); await waitForReview(p);
    let state = (await snapshot(p)).bindings.comparison!; expect(state.referenceViewport!.selection).toMatchObject({ anchor: 0, head: raw.length }); expect(state.selectionSet).toEqual(c.selectionSet);
    expect(Math.abs(state.referenceViewport!.scrollTop - state.workingViewport.scrollTop)).toBeLessThan(1);
    expect(state.referenceInput!.inputUnits).toBeLessThanOrEqual(257); await copy(p, raw);
    for (const key of ["H", "Backspace", "Delete", "Enter", "Control+z", "Control+Shift+z"]) { await reference(p).press(key); await waitForReview(p); }
    await reference(p).evaluate(node => { for (const type of ["cut", "paste"] as const) { const data = new DataTransfer(); data.setData("text/plain", "attempt"); node.dispatchEvent(new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true })); } }); await waitForReview(p);
    await reference(p).evaluate(node => { const input = node as HTMLTextAreaElement; input.value = "attempt"; input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "attempt", bubbles: true })); }); await waitForReview(p);
    expect((await snapshot(p)).history).toEqual(before.history); expect((await snapshot(p)).bindings.comparison!.baseline).toEqual(c.baseline); await exactWorking(p, prefix + raw);
    await reference(p).press("Control+Home"); await reference(p).press("ArrowDown"); await reference(p).press("Home"); await reference(p).press("Shift+End"); await waitForReview(p); await copy(p, rows[1]!.slice(0, -2));
    await reference(p).press("Control+Home"); await waitForReview(p); await pane(p).scrollIntoViewIfNeeded();
    const points = await pane(p).evaluate(node => { const row = node.querySelector<HTMLElement>('.st-viewport-row[data-line="0"]')!; const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), nodes: Text[] = []; let item; while (item = walker.nextNode()) nodes.push(item as Text); const point = (at: number) => { for (const text of nodes) { if (at < text.length) { const r = document.createRange(); r.setStart(text, at); r.setEnd(text, at + 1); const box = r.getBoundingClientRect(); return { x: box.left + box.width * .2, y: box.top + box.height / 2 }; } at -= text.length; } throw new Error("Missing visible source character."); }; return [point(4), point(8)] as const; });
    await p.mouse.move(points[0].x, points[0].y); await p.mouse.down(); await p.mouse.move(points[1].x, points[1].y); await p.mouse.up(); await waitForReview(p);
    state = (await snapshot(p)).bindings.comparison!; expect(state.referenceViewport!.selection).toMatchObject({ anchor: 4, head: 8 }); await copy(p, raw.slice(4, 8));
    await reference(p).press("Control+Home"); await reference(p).press("Shift+PageDown"); await waitForReview(p); expect((await snapshot(p)).bindings.comparison!.referenceViewport!.selection!.head).toBeGreaterThan(rows[0]!.length);
    await reference(p).press("Control+Home"); await reference(p).press("Control+Shift+End"); await waitForReview(p); const mounted = (await snapshot(p)).bindings.comparison!;
    await p.evaluate(() => { const f = window.hostFixture; f.unmount(); f.mount(); f.unmount(); f.mount(); }); await waitForReview(p); state = (await snapshot(p)).bindings.comparison!;
    expect(state.referenceViewport!.selectionSet).toEqual(mounted.referenceViewport!.selectionSet); expect(state.selectionSet).toEqual(mounted.selectionSet); expect(state.baseline).toMatchObject({ version: mounted.baseline!.version, length: mounted.baseline!.length, exports: 0 }); await copy(p, raw);
    await button(p, "Next change").click(); await waitForReview(p); expect((await snapshot(p)).bindings.comparison!.referenceViewport!.selection).toMatchObject({ anchor: 0, head: 0 });
    await working(p).press("Control+End"); await working(p).pressSequentially("K"); await waitForReview(p); await exactWorking(p, prefix + raw + "K"); await p.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+z"); await waitForReview(p); await exactWorking(p, prefix + raw); await working(p).press("Control+Shift+z"); await waitForReview(p); await exactWorking(p, prefix + raw + "K");
    expect((await snapshot(p)).source.exports).toBe(0); expect((await snapshot(p)).bindings.comparison!.baseline!.exports).toBe(0);
    await reference(p).press("Control+s"); let saved = await snapshot(p); expect(saved.pendingSaves).toHaveLength(1); expect(saved.pendingSaves[0]!.revision).toBe(saved.source.revision); expect(saved.pendingSaves[0]!.length).toBe(prefix.length + raw.length + 1);
    await button(p, "Run captured inputs").click(); expect((await snapshot(p)).activity.lastRun!.sourceRevision).toBe(saved.source.revision); await button(p, "Finish run").click(); await button(p, "Finish save").click(); await waitForReview(p); saved = await snapshot(p); expect(saved.source.dirty).toBe(false); expect(saved.bindings.comparison!.baseline!.version).toBe(c.baseline!.version); await exactWorking(p, prefix + raw + "K"); await dispose(p);
});
for (const host of ["plain", "react"]) test(`${host} reference composition delays shared layout and replaced reference jobs cannot retarget working text`, async ({ page: p }) => {
    test.setTimeout(120000); const raw = "a".repeat(2400000) + "\r\ntail\r\n"; await setup(p, host, raw); await reference(p).press("Control+Home"); await waitForReview(p); const before = await snapshot(p);
    await reference(p).evaluate(node => node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await p.getByRole("checkbox", { name: "Align review rows", exact: true }).check(); await p.waitForFunction(() => window.hostFixture.snapshot().bindings.comparison!.work.alignment.status === "waiting"); expect((await snapshot(p)).bindings.comparison!.referenceInput!.composing).toBe(true);
    await reference(p).evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }))); await waitForReview(p); expect((await snapshot(p)).bindings.comparison!.baseline).toEqual(before.bindings.comparison!.baseline);
    const old = await reference(p).elementHandle(); if (!old) throw new Error("Missing reference input.");
    expect(await old.evaluate(node => { node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); return window.hostFixture.snapshot().bindings.comparison!.referenceInput!.pendingCommand; })).toBe(true);
    for (const name of ["Capture reference refresh", "Finish reference refresh"]) await button(p, name).click(); await waitForReview(p);
    const after = await snapshot(p); expect(after.bindings.comparison!.baseline!.version).not.toBe(before.bindings.comparison!.baseline!.version); expect(after.history).toEqual(before.history);
    await old.evaluate(node => { (node as HTMLTextAreaElement).value = "late attempt"; for (const event of [new InputEvent("input", { inputType: "insertText", data: "late attempt", bubbles: true }), new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })]) node.dispatchEvent(event); }); await waitForReview(p); await exactWorking(p, raw); expect((await snapshot(p)).pendingSaves).toHaveLength(0); expect((await snapshot(p)).history).toEqual(before.history);
    await reference(p).press("Control+a"); await waitForReview(p); expect((await snapshot(p)).bindings.comparison!.referenceViewport!.selection!.head).toBe(after.bindings.comparison!.baseline!.length); expect((await snapshot(p)).bindings.comparison!.referenceInput!.inputUnits).toBeLessThanOrEqual(257); await dispose(p);
});
