import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
const snapshot = (p: Page) => p.evaluate(() => window.hostFixture.snapshot());
const button = (p: Page, name: string) => p.getByRole("button", { name, exact: true });
const input = (p: Page) => p.getByRole("textbox", { name: "Comparison working source", exact: true });
const align = (p: Page) => p.getByRole("checkbox", { name: "Align review rows", exact: true });
const panes = (p: Page) => p.locator(".st-comparison-panes .st-viewport");
async function ready(p: Page): Promise<void> { await p.waitForFunction(() => { const s = window.hostFixture.snapshot(), c = s.bindings.comparison;
    if (c?.work.alignment.status === "failed") throw new Error(c.work.alignment.failure);
    return c?.status === "ready" && !c.work.alignment.pending && !c.work.pendingScroll && !c.input.pendingCommand && !c.input.pendingInput && !c.input.pendingCaret
        && !c.workingViewport.pending && !c.referenceViewport?.pending && c.workingViewport.revision === s.source.revision
        && (!c.work.rowsAligned || c.workingViewport.aligned && c.referenceViewport?.aligned && c.workingViewport.alignmentId === c.referenceViewport.alignmentId)
        && s.bindings.views.every(v => !v.metrics!.pendingCommand && !v.metrics!.pendingInput && !v.metrics!.pendingCaret && !v.metrics!.viewport.pending);
}, undefined, { timeout: 30000 }); }
async function exact(p: Page, text: string): Promise<void> { expect(await p.evaluate(text => { const f = window.hostFixture; if (f.snapshot().source.length !== text.length) return false; for (let i = 0; i < text.length; i += 32768) if (f.range(i, Math.min(i + 32768, text.length)) !== text.slice(i, i + 32768)) return false; return true; }, text)).toBe(true); }
async function setup(p: Page, host: string, raw: string): Promise<void> { p.on("pageerror", e => { throw e; }); await p.goto(`/hosts/${host}/?editor=candidate`); await p.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, raw); for (const name of ["Open source review", "Capture review acceptance", "Finish review acceptance"]) { await button(p, name).click(); await ready(p); } }
async function sourceSet(p: Page, ranges: readonly { anchor: number; head: number }[], primary = 0): Promise<void> { await input(p).focus(); await p.evaluate(({ ranges, primary }) => { const f = window.hostFixture; f.selectSourceSet("comparison", f.snapshot().source.revision, ranges, primary); }, { ranges, primary }); await ready(p); }
async function scroll(p: Page, row: number): Promise<void> { await panes(p).last().evaluate((node, row) => { const c = window.hostFixture.snapshot().bindings.comparison!; node.scrollTop = 12 + row * c.workingViewport.lineHeight; node.dispatchEvent(new Event("scroll")); }, row); await ready(p); }
async function dispose(p: Page): Promise<void> { await p.evaluate(() => window.hostFixture.dispose()); const s = await snapshot(p); expect(s.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(s.hostSubscriptions).toBe(0); expect(s.bindings.comparison).toBeNull(); }
async function paddingPoint(p: Page): Promise<{ x: number; y: number }> { await panes(p).last().scrollIntoViewIfNeeded(); return panes(p).last().evaluate(node => { const root = node.getBoundingClientRect(); const row = [...node.querySelectorAll<HTMLElement>(".st-comparison-padding")].find(n => { const r = n.getBoundingClientRect(); return r.top >= root.top + 12 && r.bottom <= root.bottom - 12; }); if (!row) throw new Error("Missing visible padding target."); const r = row.getBoundingClientRect(); return { x: root.left + 50, y: r.top + r.height / 2 }; }); }
for (const host of ["plain", "react"]) for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} aligned rows preserve painted correspondence, complete sets, navigation, history, save and remount`, async ({ page: p }) => {
    test.setTimeout(120000); const rows = Array.from({ length: large ? 100000 : 900 }, (_, i) => `row ${i.toString().padStart(6, "0")}: café😀;ok;\r\n`), raw = rows.join(""), offset = (line: number) => rows.slice(0, line).join("").length;
    await setup(p, host, raw); const edits = [{ from: offset(20) + 4, to: offset(20) + 4, insert: "XYZ" }, { from: offset(30), to: offset(30), insert: "inserted\r\n".repeat(5) }, { from: offset(80), to: offset(87), insert: "" }];
    let working = raw; for (const edit of edits.slice().reverse()) working = working.slice(0, edit.from) + edit.insert + working.slice(edit.to);
    await p.evaluate(edits => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, edits); }, edits); await ready(p);
    const at = working.indexOf("row 000400"); await sourceSet(p, [{ anchor: at + 8, head: at + 4 }, { anchor: at + 14, head: at + 14 }], 1); const before = await snapshot(p);
    await align(p).press("Space"); await ready(p); let s = await snapshot(p), c = s.bindings.comparison!;
    expect(c.work.rowsAligned).toBe(true); expect(c.work.scrollLinked).toBe(true); expect(c.workingViewport.aligned).toBe(true); expect(c.referenceViewport!.alignmentId).toBe(c.workingViewport.alignmentId);
    expect(s.history).toEqual(before.history); expect(c.selectionSet).toEqual(before.bindings.comparison!.selectionSet); expect(c.baseline).toEqual(before.bindings.comparison!.baseline); expect(c.workingViewport.visualRows).toBe(raw.split("\n").length + 5);
    await scroll(p, 405); await expect.poll(() => p.locator('.st-comparison-panes .st-viewport-row').filter({ hasText: "row 000400:" }).count()).toBe(2);
    const tops = await p.locator('.st-comparison-panes .st-viewport-row').filter({ hasText: "row 000400:" }).evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top)); expect(Math.abs(tops[0]! - tops[1]!)).toBeLessThan(1);
    await scroll(p, 31); expect(await panes(p).first().locator(".st-comparison-padding").count()).toBeGreaterThan(0);
    expect(await panes(p).first().locator(".st-comparison-padding").evaluateAll(nodes => nodes.every(n => n.getAttribute("aria-hidden") === "true" && n.textContent === ""))).toBe(true);
    // Arrows cross a working-side padding block without creating a phantom caret.
    const from = working.indexOf("row 000079") + 4, next = working.indexOf("row 000087") + 4; await sourceSet(p, [{ anchor: from, head: from }]);
    await input(p).press("ArrowDown"); await ready(p); expect((await snapshot(p)).bindings.comparison!.selection.head).toBe(next);
    await input(p).press("ArrowUp"); await ready(p); expect((await snapshot(p)).bindings.comparison!.selection.head).toBe(from);
    const metrics = (await snapshot(p)).bindings.comparison!.workingViewport, pageRows = Math.max(1, Math.floor(metrics.height / metrics.lineHeight) - 1), targetLine = Math.max(87, 79 + pageRows), target = working.indexOf(`row ${targetLine.toString().padStart(6, "0")}`) + 4;
    await input(p).press("PageDown"); await ready(p); expect((await snapshot(p)).bindings.comparison!.selection.head).toBe(target);
    const navigation = await snapshot(p); await input(p).pressSequentially("H"); await ready(p); const typed = working.slice(0, target) + "H" + working.slice(target); await exact(p, typed);
    expect((await snapshot(p)).history.undoDepth).toBe(navigation.history.undoDepth + 1); expect((await snapshot(p)).bindings.comparison!.baseline).toEqual(before.bindings.comparison!.baseline);
    await p.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+z"); await ready(p); await exact(p, working); expect((await snapshot(p)).bindings.comparison!.selectionSet).toEqual(navigation.bindings.comparison!.selectionSet);
    await input(p).press("Control+Shift+z"); await ready(p); await exact(p, typed); expect((await snapshot(p)).source.exports).toBe(0);
    await p.getByRole("checkbox", { name: "Link review scrolling", exact: true }).uncheck(); await ready(p);
    await scroll(p, 87.25); // Pin the top inside deleted-block padding, independent of native scroll-event timing.
    expect(await panes(p).last().evaluate(node => { const top = node.getBoundingClientRect().top + 20; return [...node.querySelectorAll(".st-comparison-padding")].some(row => { const r = row.getBoundingClientRect(); return r.top <= top && r.bottom > top; }); })).toBe(true);
    const mounted = (await snapshot(p)).bindings.comparison!; await p.evaluate(() => { const f = window.hostFixture; f.unmount(); f.mount(); f.unmount(); f.mount(); }); await ready(p); c = (await snapshot(p)).bindings.comparison!;
    expect(c.work.rowsAligned).toBe(true); expect(c.work.scrollLinked).toBe(false); expect(c.viewId).toBe(mounted.viewId); expect(c.selectionSet).toEqual(mounted.selectionSet);
    expect(c.baseline).toMatchObject({ version: mounted.baseline!.version, length: mounted.baseline!.length }); expect(Math.abs(c.workingViewport.scrollTop - mounted.workingViewport.scrollTop)).toBeLessThan(1);
    expect(Math.abs(c.referenceViewport!.scrollTop - mounted.referenceViewport!.scrollTop)).toBeLessThan(1);
    await p.getByRole("checkbox", { name: "Link review scrolling", exact: true }).check(); await ready(p);
    await input(p).press("Control+s"); await button(p, "Finish save").click(); await ready(p); expect((await snapshot(p)).source.dirty).toBe(false); const canonical = typed.trimEnd(); await exact(p, canonical);
    const saved = await snapshot(p); await align(p).uncheck(); await ready(p); c = (await snapshot(p)).bindings.comparison!; expect(c.workingViewport.aligned).toBe(false); expect(c.referenceViewport!.aligned).toBe(false); expect(c.workingViewport.paddingRows).toBe(0); expect(c.selectionSet).toEqual(saved.bindings.comparison!.selectionSet); expect((await snapshot(p)).history).toEqual(saved.history); await exact(p, canonical);
    if (!large) {
        await align(p).check(); await ready(p); const baseline = (await snapshot(p)).bindings.comparison!.baseline;
        await p.evaluate(() => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: "" }]); }); await ready(p); await scroll(p, 400);
        c = (await snapshot(p)).bindings.comparison!; expect(c.workingViewport.rows).toBe(0); expect(c.workingViewport.paddingRows).toBeGreaterThan(0); expect(c.work.alignment.runs).toBeLessThan(10);
        const point = await paddingPoint(p); await p.mouse.click(point.x, point.y); await ready(p); await input(p).pressSequentially("E"); await ready(p); await exact(p, "E");
        expect((await snapshot(p)).bindings.comparison!.baseline).toEqual(baseline); expect((await snapshot(p)).source.exports).toBe(0); await input(p).press("Control+z"); await ready(p); await exact(p, "");
    }
    await dispose(p);
});
for (const host of ["plain", "react"]) test(`${host} aligned folds, padding pointers, shared pitch and stale preparation retain source ownership`, async ({ page: p }) => {
    test.setTimeout(120000); const raw = Array.from({ length: 900 }, (_, i) => `row ${i.toString().padStart(6, "0")}: café😀;ok;\r\n`).join(""); await setup(p, host, raw);
    await align(p).check(); await ready(p); const from = raw.indexOf("row 000100"), to = raw.indexOf("row 000130"); await sourceSet(p, [{ anchor: from, head: to }]); await input(p).press("Control+Shift+["); await ready(p); await scroll(p, 110);
    let c = (await snapshot(p)).bindings.comparison!; expect(c.workingViewport.collapsedFolds).toBe(1); expect(c.referenceViewport!.collapsedFolds).toBe(0); expect(c.workingViewport.paddingRows).toBeGreaterThan(0);
    const point = await paddingPoint(p);
    await p.mouse.click(point.x, point.y); await ready(p); c = (await snapshot(p)).bindings.comparison!; expect(c.selection.head).toBe(from); expect(c.workingViewport.collapsedFolds).toBe(1); await input(p).pressSequentially("H"); await ready(p); await exact(p, raw.slice(0, from) + "H" + raw.slice(from));
    await input(p).press("Control+z"); await ready(p); await exact(p, raw);
    // Existing native DOM geometry supplies a common pitch; no new font/shaping path.
    await panes(p).first().evaluate(node => { (node as HTMLElement).style.lineHeight = "32px"; }); await ready(p);
    await expect.poll(async () => (await snapshot(p)).bindings.comparison!.workingViewport.lineHeight).toBe(32); await ready(p); c = (await snapshot(p)).bindings.comparison!; expect(c.referenceViewport!.lineHeight).toBe(32);
    const pending = await input(p).evaluate(node => { node.dispatchEvent(new KeyboardEvent("keydown", { key: "]", code: "BracketRight", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); return window.hostFixture.snapshot().bindings.comparison!.work.alignment.pending; }); expect(pending).toBe(true);
    await ready(p); await scroll(p, 400);
    const tops = await p.locator('.st-comparison-panes .st-viewport-row').filter({ hasText: "row 000400:" }).evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top)); expect(tops).toHaveLength(2); expect(Math.abs(tops[0]! - tops[1]!)).toBeLessThan(1);
    await button(p, "Capture review acceptance").click(); await button(p, "Finish review acceptance").click(); await ready(p); expect((await snapshot(p)).bindings.comparison!.referenceIsWorkingBuffer).toBe(true);
    const before = await snapshot(p); await input(p).dispatchEvent("compositionstart", { data: "" }); await align(p).uncheck(); await align(p).check(); expect((await snapshot(p)).bindings.comparison!.work.alignment.pending).toBe(true);
    await p.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await ready(p); await exact(p, raw); expect((await snapshot(p)).history).toEqual(before.history); await dispose(p);
});
for (const host of ["plain", "react"]) test(`${host} cooperative row preparation cancels without partial publication and expires while input remains usable`, async ({ page: p }) => {
    test.setTimeout(120000); const rows = Array.from({ length: 2000 }, (_, i) => `base${i.toString().padStart(6, "0")}\r\n`), raw = rows.join(""); await setup(p, host, raw);
    const edits = rows.flatMap((row, i) => i % 2 ? [] : [{ from: i * row.length, to: i * row.length + 4, insert: "edit" }]), working = rows.map((row, i) => i % 2 ? row : row.replace("base", "edit")).join("");
    await p.evaluate(edits => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, edits); }, edits); await ready(p); await sourceSet(p, [{ anchor: 0, head: 0 }]); const before = await snapshot(p); expect(before.bindings.comparison!.hunks).toBe(1000);
    const toggle = await align(p).elementHandle(); if (!toggle) throw new Error("Missing alignment control.");
    await toggle.evaluate(node => { const input = node as HTMLInputElement; input.checked = true; input.dispatchEvent(new Event("change")); });
    const cancelled = await p.waitForFunction(node => { const c = window.hostFixture.snapshot().bindings.comparison!;
        if (!c.work.alignment.pending || !c.work.alignment.work) return false;
        const partial = c.workingViewport.aligned || c.referenceViewport!.aligned, input = node as HTMLInputElement;
        input.checked = false; input.dispatchEvent(new Event("change")); return { partial };
    }, toggle, { polling: 1 }); expect(await cancelled.jsonValue()).toEqual({ partial: false });
    await ready(p); await p.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const c = (await snapshot(p)).bindings.comparison!; expect(c.work.alignment.pending).toBe(false); expect(c.workingViewport.aligned).toBe(false); expect((await snapshot(p)).history).toEqual(before.history);
    const target = await input(p).elementHandle(); if (!target) throw new Error("Missing working input.");
    await toggle.evaluate(node => { const input = node as HTMLInputElement; input.checked = true; input.dispatchEvent(new Event("change")); });
    const pending = await p.waitForFunction(node => { const input = node as HTMLTextAreaElement, f = window.hostFixture, a = f.snapshot().bindings.comparison!.work.alignment;
        if (!a.pending || !a.work) return false;
        const event = new InputEvent("beforeinput", { inputType: "insertText", data: "H", bubbles: true, cancelable: true }); if (input.dispatchEvent(event)) { input.setRangeText("H", input.selectionStart, input.selectionEnd, "end"); input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "H", bubbles: true })); }
        return { pending: a.pending, current: f.snapshot().bindings.comparison!.work.alignment.pending };
    }, target, { polling: 1 }); expect(await pending.jsonValue()).toEqual({ pending: true, current: true }); await ready(p); await exact(p, "H" + working); expect((await snapshot(p)).bindings.comparison!.baseline).toEqual(before.bindings.comparison!.baseline);
    await input(p).press("Control+End"); await input(p).pressSequentially("K"); await ready(p); await exact(p, "H" + working + "K"); expect((await snapshot(p)).source.exports).toBe(0);
    await input(p).press("Control+z"); await ready(p); await exact(p, "H" + working); await input(p).press("Control+z"); await ready(p); await exact(p, working);
    expect((await snapshot(p)).bindings.comparison!.work.alignment.runs).toBeLessThan(10000); await dispose(p);
});
