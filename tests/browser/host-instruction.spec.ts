import { ready, test, expect, expectPanelKeyReserved, expectUnmountedSourceHost } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { hostTextEquals } from "../../scripts/host-scene.mjs";
const snap = (p: Page) => p.evaluate(() => window.hostFixture.snapshot());
const button = (p: Page, name: string) => p.getByRole("button", { name, exact: true });
const source = (p: Page) => p.getByRole("textbox", { name: "Primary source", exact: true });
const sets = (s: Awaited<ReturnType<typeof snap>>) => ({ views: s.bindings.views.map(v => ({ id: v.id, set: v.selectionSet })), working: s.bindings.comparison?.selectionSet });
async function waitForInstruction(page: Page, review = true): Promise<void> {
    await ready(page);
    await page.waitForFunction(review => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (!s.bindings.instruction?.pending && (!review || s.bindings.comparison !== null)); }, review);
}
async function exact(p: Page, text: string) { expect(await hostTextEquals(p, text)).toBe(true); }
test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus && !page.isClosed()) await info.attach("instruction-failure-state", { contentType: "application/json", body: JSON.stringify(await snap(page), null, 2) }); });
test(`plain anchored instruction preserves source, history, copy and virtualized ownership`, async ({ page: p }, info) => {
      await p.goto(`/hosts/plain/?editor=candidate`); await expect(source(p)).toBeVisible();
    const prefix = "before\r\n".repeat(90), line = '  // @transfer { "destination":"a\\u0041.csv", "batchSize":"1000", "unknown":{"n":-0,"s":"😀,}"} }', tail = "\r\nafter".repeat(8), original = prefix + line + tail;
    await p.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, original);
    await button(p, "Open source review").click(); await button(p, "Capture review acceptance").click(); await button(p, "Finish review acceptance").click(); await waitForInstruction(p);
    await p.evaluate(offset => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: offset, head: offset }); }, prefix.length);
    await source(p).press("ArrowRight"); await source(p).press("ArrowLeft"); await waitForInstruction(p); await button(p, "Anchor instruction at caret").click();
    const field = p.getByRole("textbox", { name: "Instruction destination", exact: true }), batch = p.getByRole("textbox", { name: "Instruction batch size", exact: true });
    await waitForInstruction(p); await expect.poll(async () => (await snap(p)).bindings.views.find(v => v.id === "primary")?.metrics?.viewport.height).toBe(320);
    await expect(field).toBeVisible(); await waitForInstruction(p); const before = await snap(p); expect(before.bindings.views.every(v => !v.metrics || v.metrics.viewport.rows < 100)).toBe(true);
    expect(await p.evaluate(() => { const field = document.querySelector('textarea[aria-label="Primary source"]')!, form = document.querySelector('[aria-label="Anchored transfer instruction"]')!; return !field.closest('.st-editor')!.contains(form) && form.closest('.editor-host')?.contains(field); })).toBe(true);
    await field.press("End"); await field.pressSequentially("X"); await waitForInstruction(p); const changed = original.replace('\\u0041.csv"', '\\u0041.csvX"'); await exact(p, changed);
    expect((await snap(p)).bindings.mounts).toBe(before.bindings.mounts); await field.press("Control+z"); await waitForInstruction(p); await exact(p, original); expect(sets(await snap(p))).toEqual(sets(before));
    await field.press("Control+y"); await waitForInstruction(p); await exact(p, changed); await batch.fill("1e"); await expect(button(p, "Capture instruction copy")).toBeDisabled();
    await exact(p, changed.replace('"1000"', '"1e"')); await batch.fill("2000"); await button(p, "Capture instruction copy").click();
    await p.getByRole("textbox", { name: "Transfer destination", exact: true }).fill("independent.csv"); await button(p, "Finish instruction copy").click(); await expect(p.getByLabel("Instruction status", { exact: true })).toContainText("expired");
    await button(p, "Capture instruction copy").click(); await field.press("End"); await field.pressSequentially("Y"); await expect(p.getByLabel("Instruction status", { exact: true })).toContainText('"aA.csvX"'); await button(p, "Finish instruction copy").click();
    await expect(p.getByRole("textbox", { name: "Transfer destination", exact: true })).toHaveValue("aA.csvX"); expect((await snap(p)).activity.pendingRuns).toBe(0); expect((await snap(p)).pendingSaves).toHaveLength(0);
    await field.press("Escape"); await expect(source(p)).toBeFocused(); await waitForInstruction(p);
    // Source edits outside the instruction map its anchor; invalid JSON stays authoritative.
    await p.evaluate(() => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: 0, insert: "mapped\r\n" }]); }); await waitForInstruction(p); expect((await snap(p)).instruction.from).toBe(prefix.length + 8);
    await p.evaluate(() => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: s.instruction.to! - 1, to: s.instruction.to!, insert: "" }]); }); await waitForInstruction(p); await expect(field).toHaveAttribute("readonly", "");
    await source(p).press("Control+z"); await waitForInstruction(p); await expect(field).not.toHaveAttribute("readonly", "");
    await source(p).press("End"); await waitForInstruction(p); expect((await snap(p)).bindings.views.find(v => v.id === "primary")?.metrics?.viewport.scrollLeft).toBeGreaterThan(0); await expect(field).toBeVisible();
    await source(p).focus(); await p.evaluate(() => { const f = window.hostFixture, s = f.snapshot(); f.selectSource("primary", s.source.revision, { anchor: s.instruction.from! - 8, head: s.instruction.to! + 2 }); });
    await button(p, "Fold selected lines").click(); await waitForInstruction(p); await expect(field).toHaveCount(0); expect((await snap(p)).bindings.instruction?.laneState).toBe("folded");
    await button(p, "Expand all folds").click(); await waitForInstruction(p); await expect(field).toBeVisible();
    await source(p).press("Control+Home"); await waitForInstruction(p); await expect(field).toHaveCount(0); expect((await snap(p)).bindings.instruction?.fieldNodes).toBe(0);
    await p.evaluate(() => { const f = window.hostFixture, s = f.snapshot(), at = s.instruction.from!; f.selectSource("primary", s.source.revision, { anchor: at, head: at }); }); await source(p).press("ArrowRight"); await source(p).press("ArrowLeft"); await waitForInstruction(p); await expect(field).toBeVisible();
    await p.setViewportSize({ width: 1100, height: 900 }); await waitForInstruction(p); await p.setViewportSize({ width: 1600, height: 1000 }); await waitForInstruction(p); await expect(field).toBeVisible();
    const geometry = await snap(p); await field.evaluate(node => { (node as HTMLTextAreaElement).style.height = "70px"; }); await waitForInstruction(p);
    expect((await snap(p)).source.revision).toBe(geometry.source.revision); expect((await snap(p)).history).toEqual(geometry.history);
    await expect.poll(() => p.evaluate(() => { const panel = document.querySelector('[aria-label="Anchored transfer instruction"]')!.getBoundingClientRect(), lane = document.querySelector('.host-instruction-lane')!.getBoundingClientRect(), source = document.querySelector('.host-instruction-source')!.getBoundingClientRect();
        return panel.top >= lane.top - 1 && panel.bottom <= lane.bottom + 1 && source.right <= lane.left + 1; })).toBe(true);
    await p.evaluate(() => window.hostFixture.unmount()); expectUnmountedSourceHost(await snap(p), 2); await p.evaluate(() => window.hostFixture.mount()); await waitForInstruction(p); await expect(field).toHaveValue("aA.csvXY");
    const committed = await p.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); });
    const oldToken = '"a\\u0041.csvXY"', crlfToken = '"line\\r\\nname.csv"', at = committed.indexOf(oldToken); expect(at).toBeGreaterThanOrEqual(0);
    await p.evaluate(({ at, length, value }) => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: at, to: at + length, insert: value }]); }, { at, length: oldToken.length, value: crlfToken });
    await waitForInstruction(p); await expect(field).toHaveValue("line\nname.csv"); await field.press("Control+End"); await field.pressSequentially("Z"); await waitForInstruction(p); await exact(p, committed.replace(oldToken, '"line\\r\\nname.csvZ"'));
    await field.press("Control+z"); await field.press("Control+z"); await waitForInstruction(p); await exact(p, committed); await expect(field).toHaveValue("aA.csvXY");
    await field.focus(); await field.dispatchEvent("compositionstart", { data: "" }); await field.evaluate(node => { (node as HTMLTextAreaElement).value = "uncommitted café😀"; }); await field.dispatchEvent("input", { inputType: "insertCompositionText", isComposing: true });
    await button(p, "Save source").click(); expect((await snap(p)).pendingSaves).toHaveLength(0); await button(p, "Dismiss message").click();
    await p.evaluate(() => window.hostFixture.setSourceReadOnly(true)); expect(await p.evaluate(() => window.hostFixture.recoveryText())).toBe("uncommitted café😀"); await exact(p, committed);
    await field.dispatchEvent("compositionend", { data: "uncommitted café😀" }); await p.evaluate(() => window.hostFixture.setSourceReadOnly(false)); await waitForInstruction(p); await expect(field).toHaveValue("aA.csvXY"); await exact(p, committed);
    const consumed = await field.evaluate(node => [{ keyCode: 229 }, { modifierAltGraph: true }].map(detail => {
        const key = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true, ...detail });
        node.dispatchEvent(key); return key.defaultPrevented;
    }));
    expect(consumed).toEqual([false, false]);
    expect((await snap(p)).pendingSaves).toEqual([]);
    await field.press("Control+s"); await expect.poll(async () => (await snap(p)).pendingSaves.length).toBe(1); await button(p, "Fail save").click(); await button(p, "Dismiss message").click();
    await info.attach("anchored-instruction", { body: await p.screenshot(), contentType: "image/png" });
    await p.evaluate(() => window.hostFixture.dispose()); const stopped = await snap(p); expect(stopped.diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 }); expect(stopped.hostSubscriptions).toBe(0);
});

test(`plain anchored instruction stays with its source across primary document replacement`, async ({ page: p }) => {
      await p.goto(`/hosts/plain/?editor=candidate`);
    const original = '// @transfer {"destination":"café😀.csv","batchSize":"1000"}\r\nsource tail';
    await expect(source(p)).toBeVisible(); await p.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, original);
    await button(p, "Open source review").click(); await waitForInstruction(p); await source(p).press("Control+Home"); await button(p, "Anchor instruction at caret").click();
    const field = p.getByRole("textbox", { name: "Instruction destination", exact: true }); await expect(field).toBeVisible(); await waitForInstruction(p);
    await field.focus(); await field.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(1, 4, "backward")); const before = await snap(p);
    // Host lifecycle commands may run without moving focus; the detached field must retain its private view state.
    const invoke = (name: string) => p.evaluate(name => { const b = [...document.querySelectorAll("button")].find(b => b.textContent === name); if (!b) throw new Error("Missing host command."); b.click(); }, name);
    await invoke("Begin delayed load"); await expect(source(p)).toHaveCount(0); await invoke("Finish delayed load"); await expect(source(p)).toBeVisible(); await waitForInstruction(p, false);
    await expect(field).toHaveCount(0); expect((await snap(p)).instruction.active).toBe(true);
    await expect.poll(() => p.evaluate(() => { const input = document.querySelector('textarea[aria-label="Primary source"]')!, host = input.closest(".editor-host")!, surface = host.querySelector(".host-instruction-source")!, lane = host.querySelector(".host-instruction-lane") as HTMLElement;
        return lane.hidden && !host.classList.contains("host-instruction-enabled") && Math.abs(surface.getBoundingClientRect().width - host.clientWidth) <= 1; })).toBe(true);
    await source(p).press("Control+End"); await source(p).pressSequentially(" loaded edit"); await waitForInstruction(p, false); await exact(p, original); expect((await snap(p)).source.revision).toBe(before.source.revision);
    expect(await p.evaluate(() => { const f = window.hostFixture, id = f.snapshot().bindings.views.find(v => v.id === "primary")!.documentId; return f.navigationDocument(id).text; })).toBe("loaded resource loaded edit");
    await button(p, "Anchor instruction at caret").click(); await button(p, "Insert transfer instruction").click(); await expect(field).toHaveCount(0); await exact(p, original);
    await source(p).focus(); await invoke("Reopen primary source"); await waitForInstruction(p); await expect(field).toHaveValue("café😀.csv"); await expect(field).toBeFocused();
    expect(await field.evaluate(node => { const f = node as HTMLTextAreaElement; return [f.selectionStart, f.selectionEnd, f.selectionDirection]; })).toEqual([1, 4, "backward"]);
    expect((await snap(p)).bindings.views.find(v => v.id === "primary")?.selectionSet).toEqual(before.bindings.views.find(v => v.id === "primary")?.selectionSet);
    await field.focus(); await expectPanelKeyReserved(field, "Escape");
    await field.press("Escape"); await expect(source(p)).toBeFocused(); await source(p).press("Control+End"); await source(p).pressSequentially(" source edit"); await waitForInstruction(p); await exact(p, original + " source edit");
    await source(p).press("Control+z"); await waitForInstruction(p); await exact(p, original + " source");
    await source(p).press("Control+z"); await waitForInstruction(p); await exact(p, original); expect((await snap(p)).history).toEqual({ undoDepth: before.history.undoDepth, redoDepth: 2 });
    await p.evaluate(() => window.hostFixture.dispose()); expect((await snap(p)).diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 });
});
