import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import type { Selection } from "../../src/index.ts";
import { moveEditorIntoShadow } from "../helpers/shadow-editor.ts";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const root = (page: Page, name = "Primary source") => page.locator(`.st-editor:has(> textarea[aria-label="${name}"])`);

async function select(page: Page, ranges: readonly Selection[], primary = 0): Promise<void> {
    expect(await page.evaluate(({ ranges, primary }) => { const f = window.hostFixture; return f.selectSourceSet("primary", f.snapshot().source.revision, ranges, primary); }, { ranges, primary })).toBe(true); await ready(page);
}
async function exact(page: Page, text: string): Promise<void> {
    expect(await page.evaluate(() => window.hostFixture.range(0, Math.min(160, window.hostFixture.snapshot().source.length)))).toBe(text.slice(0, 160));
    expect(await page.evaluate(text => { const f = window.hostFixture; return f.snapshot().source.length === text.length && f.range(0, text.length) === text; }, text)).toBe(true);
}
async function mount(page: Page, host: string, text: string): Promise<void> {
     await page.goto(`/hosts/${host}/?editor=candidate`);
    await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, text);
    await page.getByRole("button", { name: "Open source review", exact: true }).click(); await ready(page);
    for (const name of ["Capture review acceptance", "Finish review acceptance"]) await page.getByRole("button", { name, exact: true }).click();
    await ready(page); await root(page).scrollIntoViewIfNeeded();
}
async function point(page: Page, offset: number, name = "Primary source") {
    return root(page, name).evaluate((element, offset) => {
        const row = [...element.querySelectorAll<HTMLElement>(".st-viewport-row")].find(row => Number(row.dataset.from) <= offset && Number(row.dataset.to) > offset);
        if (!row) throw new Error("Expected a rendered drag point.");
        let local = offset - Number(row.dataset.from); const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
            if (local >= node.length) { local -= node.length; continue; }
            const range = document.createRange(); range.setStart(node, local); range.setEnd(node, local + 1); const box = range.getBoundingClientRect();
            return { x: box.left + box.width * .1, y: box.top + box.height * .5 };
        }
        throw new Error("Expected a drag text point.");
    }, offset);
}
async function edgeScrollAndCancel(page: Page): Promise<void> {
    const before = (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.scrollTop;
    await root(page).evaluate(element => {
        const box = element.getBoundingClientRect(), data = new DataTransfer(); data.setData("text/plain", "not inserted");
        Object.defineProperty(data, "effectAllowed", { value: "copy" });
        element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data,
            clientX: box.left + element.clientWidth / 2, clientY: box.top + element.clientHeight - 10 }));
    });
    await expect.poll(async () => (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.scrollTop).toBeGreaterThan(before);
    await page.keyboard.press("Escape");
    const stopped = (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.scrollTop;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.scrollTop).toBe(stopped);
    expect(await page.locator(".st-text-drop-caret").count()).toBe(0);
    await root(page).evaluate(element => { element.scrollTop = 0; element.scrollLeft = 0; });
    await expect.poll(async () => (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.scrollTop).toBe(0); await ready(page);
}

test("a replacement drop target in a shadow root survives a render callback during edge scrolling", async ({ page }) => {
    const original = "row abcdefghij\n".repeat(1000), payload = "inserted";
    await mount(page, "plain", original); const before = await snapshot(page);
    await moveEditorIntoShadow(input(page)); await root(page).scrollIntoViewIfNeeded();
    await root(page).evaluate((element, payload) => {
        const data = new DataTransfer(); data.setData("text/plain", payload); Object.defineProperty(data, "effectAllowed", { value: "copy" });
        window.textDragStore = data;
        const over = (x: number, y: number) => element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data, clientX: x, clientY: y }));
        const retarget = () => {
            if (!element.scrollTop) return; stop();
            const box = element.getBoundingClientRect();
            const row = [...element.querySelectorAll<HTMLElement>(".st-viewport-row")].find(row => { const r = row.getBoundingClientRect(); return r.top > box.top && r.bottom < box.bottom; })!;
            const node = document.createTreeWalker(row, NodeFilter.SHOW_TEXT).nextNode()!;
            const range = document.createRange(); range.setStart(node, 1); range.setEnd(node, 2); const r = range.getBoundingClientRect();
            element.dataset.retargetAt = String(Number(row.dataset.from) + 1); over(r.left + r.width * .1, r.top + r.height * .5);
        };
        const stop = window.hostFixture.onSourceRender("primary", retarget);
        const box = element.getBoundingClientRect(); over(box.left + element.clientWidth / 2, box.top + element.clientHeight - 10);
    }, payload);
    await expect(root(page)).toHaveAttribute("data-retarget-at", /\d+/);
    await expect(root(page).locator(".st-text-drop-caret")).toHaveCount(1);
    const at = Number(await root(page).getAttribute("data-retarget-at"));
    await root(page).evaluate(element => element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.textDragStore })));
    await ready(page); await exact(page, original.slice(0, at) + payload + original.slice(at));
    expect((await snapshot(page)).source.revision).toBe(before.source.revision + 1);
    await page.evaluate(() => window.hostFixture.dispose());
});

test(`plain native text drag preserves captured identity through history and lifecycle`, async ({ page }, info) => {
    test.setTimeout(60000);
    const header = "alpha bravo\r\ncharlie delta\r\ntarget here", original = header + "\r\n" + "row value\r\n".repeat(90) + "tail";
    await mount(page, "plain", original);
    const second = header.indexOf("charlie"), destination = header.indexOf("target") + 2, ranges = [{ anchor: 5, head: 0 }, { anchor: second, head: second + 7 }];
    await select(page, ranges, 1); const before = await snapshot(page), beforeSet = before.bindings.views.find(v => v.id === "primary")!.selectionSet;
    await edgeScrollAndCancel(page);
    await root(page).evaluate(element => { const events: unknown[] = [];
        for (const type of ["dragstart", "dragover", "drop"]) element.addEventListener(type, event => {
            const drag = event as DragEvent; events.push({ type, types: drag.dataTransfer?.types, alt: drag.altKey, ctrl: drag.ctrlKey, effect: drag.dataTransfer?.effectAllowed });
            element.setAttribute("data-drag-events", JSON.stringify(events.slice(-16))); if (type !== "dragover") element.setAttribute(`data-trusted-${type}`, String(event.isTrusted));
        }); });
    const from = await point(page, 1), to = await point(page, destination);
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x + 8, from.y, { steps: 3 }); await page.mouse.move(to.x, to.y, { steps: 10 });
    await expect(page.locator(".st-text-drag-preview")).toHaveCount(0);
    await page.mouse.up(); await ready(page);
    await expect(root(page)).toHaveAttribute("data-trusted-dragstart", "true");
    if (info.project.name === "webkit") {
        // This runner strips custom data after trusted dragstart. Refusal is qualified;
        // a native token-preserving move remains unverified, independently of synthetic guards.
        const events = JSON.parse((await root(page).getAttribute("data-drag-events"))!) as { type: string; types: string[] }[];
        expect(events.find(event => event.type === "dragstart")!.types).toContain("application/x-sttropez-text");
        expect(events.filter(event => event.type === "dragover").length).toBeGreaterThan(0);
        expect(events.filter(event => event.type === "dragover").every(event => !event.types.includes("application/x-sttropez-text"))).toBe(true);
        await expect(root(page)).not.toHaveAttribute("data-trusted-drop", "true"); await exact(page, original); expect((await snapshot(page)).history).toEqual(before.history);
        expect(await page.locator(".st-text-drop-caret,.st-text-drag-preview").count()).toBe(0);
        info.annotations.push({ type: "qualification-limit", description: "Trusted automated transport strips the internal token. Safe refusal passes; native token-preserving movement remains unverified." });
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); return;
    }
    await expect(root(page)).toHaveAttribute("data-trusted-drop", "true");
    const remaining = original.slice(5, second) + original.slice(second + 7), insertion = destination - 12, text = remaining.slice(0, insertion) + "alpha\ncharlie" + remaining.slice(insertion);
    await exact(page, text); const moved = await snapshot(page); expect(moved.source.revision).toBe(before.source.revision + 1); expect(moved.history.undoDepth).toBe(before.history.undoDepth + 1); expect(moved.source.exports).toBe(0);
    expect(moved.bindings.views.every(v => v.metrics!.inputUnits <= 2600 && v.metrics!.viewport.rows < 100 && v.metrics!.viewport.readUnits < 20000)).toBe(true);
    expect(moved.bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: insertion, head: insertion + 13 });
    await input(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, original); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(beforeSet);
    await input(page, "Comparison working source").press("Control+Shift+z"); await ready(page); await exact(page, text); expect((await snapshot(page)).source.exports).toBe(0);
    await input(page).evaluate(node => node.focus({ preventScroll: true })); await input(page).press("Control+s");
    await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1); await input(page).pressSequentially("z"); await ready(page);
    await exact(page, remaining.slice(0, insertion) + "z" + remaining.slice(insertion));
    await page.evaluate(() => window.hostFixture.finishSave()); await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1");
    expect((await snapshot(page)).source.dirty).toBe(true); await input(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, text); expect((await snapshot(page)).source.dirty).toBe(false);
    const retained = await snapshot(page); await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await ready(page);
    expect((await snapshot(page)).history).toEqual(retained.history); expect((await snapshot(page)).bindings.views.map(v => v.selectionSet)).toEqual(retained.bindings.views.map(v => v.selectionSet));
    expect(await page.evaluate(n => window.hostFixture.referenceRange(0, n), original.length)).toBe(original); expect((await snapshot(page)).source.exports).toBe(retained.source.exports);
    expect(await page.locator(".st-text-drop-caret,.st-text-drag-preview").count()).toBe(0);
    await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});

// Synthetic stores exercise protected-mode and stale guards. Native gestures above are separate.
declare global { interface Window { textDragStore: DataTransfer; textDragProtectedReads: number; } }
async function syntheticStart(page: Page, unrelatedCancellation = false): Promise<void> {
    const p = await point(page, 1);
    await root(page).evaluate((element, { p, unrelatedCancellation }) => {
        const selected = element.querySelector(".st-viewport-selected")!;
        selected.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 77, clientX: p.x, clientY: p.y }));
        if (unrelatedCancellation) selected.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 177 }));
        const start = new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }); element.dispatchEvent(start);
        if (start.defaultPrevented || !start.dataTransfer) throw new Error("Synthetic drag did not start."); window.textDragStore = start.dataTransfer;
        // A constructed store need not permit effectAllowed mutation in every engine.
        Object.defineProperty(window.textDragStore, "effectAllowed", { value: "copyMove", writable: true });
    }, { p, unrelatedCancellation });
}
async function over(page: Page, offset: number, name = "Primary source", copy = false): Promise<void> {
    const p = await point(page, offset, name);
    await root(page, name).evaluate((element, { p, copy }) => {
        const data = window.textDragStore, get = data.getData.bind(data); window.textDragProtectedReads = 0;
        Object.defineProperty(data, "getData", { configurable: true, value: () => { window.textDragProtectedReads++; throw new Error("Protected data read."); } });
        try { element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data, clientX: p.x, clientY: p.y, ctrlKey: copy })); }
        finally { Object.defineProperty(data, "getData", { configurable: true, value: get }); }
    }, { p, copy });
    expect(await page.evaluate(() => window.textDragProtectedReads)).toBe(0);
}
async function drop(page: Page, name = "Primary source"): Promise<void> {
    await root(page, name).evaluate(element => element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.textDragStore }))); await ready(page);
}
test("a native drag cannot insert into a remounted editor when the transport strips its token", async ({ page, browserName }) => {
    test.skip(browserName !== "webkit", "This transport strips the internal type on dragover.");
    const original = "alpha bravo\r\ncharlie delta\r\ntarget here";
    await mount(page, "plain", original); await select(page, [{ anchor: 0, head: 5 }]);
    const before = await snapshot(page), from = await point(page, 1), to = await point(page, original.indexOf("target") + 3);
    await root(page).evaluate(node => node.addEventListener("dragstart", event => { node.dataset.started = String(event.isTrusted); }, { once: true }));
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x + 12, from.y, { steps: 4 });
    await expect(root(page)).toHaveAttribute("data-started", "true");
    await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await ready(page);
    await root(page).evaluate(node => node.addEventListener("dragover", event => { node.dataset.dragOver = String(event.isTrusted); }, { once: true }));
    await page.mouse.move(to.x, to.y, { steps: 10 }); await page.mouse.move(to.x + 1, to.y); await page.mouse.up(); await ready(page);
    await expect(root(page)).toHaveAttribute("data-drag-over", "true");
    await exact(page, original); expect((await snapshot(page)).history).toEqual(before.history);

    await page.evaluate(() => {
        window.textDragStore = new DataTransfer(); window.textDragStore.setData("text/plain", "next");
        Object.defineProperty(window.textDragStore, "effectAllowed", { value: "copy" });
    });
    await over(page, 15); await drop(page);
    await exact(page, original.slice(0, 15) + "next" + original.slice(15));
});
test(`plain cross-document native move, copy and expired target preserve linked history`, async ({ page }, info) => {
    test.setTimeout(60000); const original = "alpha bravo\r\ncharlie delta\r\nsource tail", target = "target here";
    await mount(page, "plain", original); await page.evaluate(text => window.hostFixture.openTransferTarget(text), target); await ready(page);
    const second = original.indexOf("charlie"), ranges = [{ anchor: 5, head: 0 }, { anchor: second, head: second + 7 }];
    await page.evaluate(ranges => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, ranges, 1);
        f.selectSourceSet("secondary", f.transferSnapshot().revision, [{ anchor: 1, head: 0 }, { anchor: 5, head: 5 }], 1); }, ranges); await ready(page);
    const before = await snapshot(page), targetBefore = await page.evaluate(() => window.hostFixture.transferSnapshot()), sets = before.bindings.views.map(v => v.selectionSet);
    const drag = async (copy = false, release = true) => {
        const a = await point(page, 1), b = await point(page, 2, "Secondary source");
        await page.mouse.move(a.x, a.y); if (copy) await page.keyboard.down("Control"); await page.mouse.down();
        await page.mouse.move(a.x + 8, a.y, { steps: 3 }); await page.mouse.move(b.x, b.y, { steps: 10 });
        // Entering the last point can produce only dragenter; a second move delivers dragover.
        await page.mouse.move(b.x, b.y);
        if (release) { await page.mouse.up(); if (copy) await page.keyboard.up("Control"); await ready(page); }
    };
    await drag();
    if (info.project.name === "webkit") {
        await exact(page, original); expect(await page.evaluate(() => window.hostFixture.transferSnapshot())).toEqual(targetBefore); expect((await snapshot(page)).history).toEqual(before.history);
        info.annotations.push({ type: "qualification-limit", description: "Trusted automated transport strips the internal token. Cross-document refusal passes; token-preserving native movement remains unverified." });
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); return;
    }
    const removed = original.slice(5, second) + original.slice(second + 7), inserted = "taalpha\ncharlierget here";
    await exact(page, removed); expect((await page.evaluate(() => window.hostFixture.transferSnapshot())).text).toBe(inserted);
    expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1); expect((await page.evaluate(() => window.hostFixture.transferSnapshot())).history.undoDepth).toBe(targetBefore.history.undoDepth + 1);
    await input(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, original);
    expect((await page.evaluate(() => window.hostFixture.transferSnapshot())).text).toBe(target); expect((await snapshot(page)).bindings.views.map(v => v.selectionSet)).toEqual(sets);
    await input(page).press("Control+Shift+z"); await ready(page); await exact(page, removed); expect((await page.evaluate(() => window.hostFixture.transferSnapshot())).text).toBe(inserted);
    await input(page).press("Control+z"); await ready(page); await exact(page, original);
    await drag(true); await exact(page, original); expect((await page.evaluate(() => window.hostFixture.transferSnapshot())).text).toBe(inserted);
    expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth);
    await input(page, "Secondary source").press("Control+z"); await ready(page); expect((await page.evaluate(() => window.hostFixture.transferSnapshot())).text).toBe(target);
    await drag(false, false); await expect(root(page, "Secondary source").locator(".st-text-drop-caret")).toHaveCount(1);
    await page.evaluate(() => { const f = window.hostFixture; f.editTransferTarget(f.transferSnapshot().revision, [{ from: 0, to: 0, insert: "x" }]); });
    await page.mouse.up(); await ready(page); await exact(page, original); expect((await page.evaluate(() => window.hostFixture.transferSnapshot())).text).toBe("x" + target);
    await page.evaluate(() => window.hostFixture.setTransferReadOnly(true)); await drag(); await exact(page, original);
    expect((await page.evaluate(() => window.hostFixture.transferSnapshot())).text).toBe("x" + target);
    expect((await snapshot(page)).source.exports).toBe(0); expect((await page.evaluate(() => window.hostFixture.transferSnapshot())).exports).toBe(0);
    expect(await page.locator(".st-text-drop-caret,.st-text-drag-preview").count()).toBe(0);
    await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});
test(`plain protected dragover, captured copy target and literal external drop ignore focus and selection`, async ({ page }) => {
    const original = "alpha bravo\r\ntarget here"; await mount(page, "plain", original); await select(page, [{ anchor: 0, head: 5 }]);
    await syntheticStart(page); await over(page, 15, "Secondary source", true);
    await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("secondary", f.snapshot().source.revision, [{ anchor: 0, head: 0 }]); });
    await input(page, "Primary source").evaluate(node => node.focus({ preventScroll: true })); await drop(page, "Secondary source");
    await exact(page, original.slice(0, 15) + "alpha" + original.slice(15));
    await input(page).press("Control+z"); await ready(page); await exact(page, original);
    await page.evaluate(() => { window.textDragStore = new DataTransfer(); window.textDragStore.setData("text/plain", "<b>\r\n😀"); Object.defineProperty(window.textDragStore, "effectAllowed", { value: "copy" }); });
    await over(page, 15); await drop(page); await exact(page, original.slice(0, 15) + "<b>\r\n😀" + original.slice(15));
    expect(await root(page).locator("b").count()).toBe(0); await input(page).press("Control+z"); await ready(page); await exact(page, original);
    await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});
test(`plain changed source, target permissions, cancellation and remount reject captured drops`, async ({ page }) => {
    const original = "alpha bravo\r\ntarget here"; await mount(page, "plain", original);
    await select(page, [{ anchor: 0, head: 5 }]); const p = await point(page, 1);
    expect(await root(page).evaluate((element, p) => {
        const selected = element.querySelector(".st-viewport-selected")!;
        selected.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 77, clientX: p.x, clientY: p.y }));
        selected.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 77 }));
        const start = new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }); element.dispatchEvent(start); return start.defaultPrevented;
    }, p)).toBe(true);
    for (const change of ["selection", "revision", "readonly", "cancel", "remount", "no-over", "missing-token", "foreign-token"] as const) {
        await select(page, [{ anchor: 0, head: 5 }]); await syntheticStart(page, change === "selection"); if (change !== "no-over") await over(page, 15);
        await page.evaluate(change => { const f = window.hostFixture;
            if (change === "selection") f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 1, head: 4 }]);
            if (change === "revision") f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: "x" }]);
            if (change === "readonly") f.setSourceReadOnly(true);
            if (change === "cancel") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
            if (change === "remount") { f.unmount(); f.mount(); }
            if (change === "missing-token") window.textDragStore.clearData("application/x-sttropez-text");
            if (change === "foreign-token") window.textDragStore.setData("application/x-sttropez-text", "wrong-token");
        }, change); await ready(page);
        if (change === "missing-token") await over(page, 15);
        const before = await snapshot(page); await drop(page); expect((await snapshot(page)).source.revision).toBe(before.source.revision); expect((await snapshot(page)).history).toEqual(before.history);
        expect(await page.locator(".st-text-drop-caret,.st-text-drag-preview").count()).toBe(0);
        if (change === "readonly") await page.evaluate(() => window.hostFixture.setSourceReadOnly(false));
        if (change === "revision") { await input(page).press("Control+z"); await ready(page); } await exact(page, original);
    }
    await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});
