import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Selection } from "../../src/index.ts";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const root = (page: Page) => page.locator('.st-editing-candidate:has(> textarea[aria-label="Primary source"])');
const coords = (ranges: readonly Selection[]) => ranges.map(({ anchor, head }) => ({ anchor, head }));
async function ready(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(() => { const s = window.hostFixture.snapshot(), c = s.bindings.comparison;
        return s.bindings.views.every(v => v.metrics && !v.metrics.pendingCaret && !v.metrics.pendingWord && !v.metrics.pendingGrapheme
            && !v.metrics.viewport.pending && v.metrics.viewport.revision === s.source.revision && v.metrics.viewport.selectionSet === v.selectionSet)
            && (!c || c.status === "ready" && !c.input.pendingCaret && !c.workingViewport.pending && !c.referenceViewport?.pending);
    })).toBe(true);
}
async function select(page: Page, ranges: readonly Selection[], primary = 0): Promise<void> {
    expect(await page.evaluate(({ ranges, primary }) => { const f = window.hostFixture; return f.selectSourceSet("primary", f.snapshot().source.revision, ranges, primary); }, { ranges, primary })).toBe(true); await ready(page);
}
async function mount(page: Page, host: string, text: string): Promise<void> {
    page.on("pageerror", error => { throw error; }); await page.goto(`/hosts/${host}/?editor=candidate`);
    await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, text);
    await page.getByRole("button", { name: "Open source review", exact: true }).click(); await ready(page);
    for (const name of ["Capture review acceptance", "Finish review acceptance"]) await page.getByRole("button", { name, exact: true }).click();
    await ready(page); await input(page).evaluate(node => node.focus({ preventScroll: true }));
}

for (const host of ["plain", "react"]) for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} every range keeps independent columns through navigation and read-only movement`, async ({ page }) => {
    test.setTimeout(60000);
    const gap = large ? 100000 : 0, rows = ["0123456789", "ab", "ABCDEFGHIJKL", "", ...Array<string>(gap).fill("filler"), "abcdefghij", "x", "ZYXWVUTSRQP"];
    const starts: number[] = []; let length = 0; for (const row of rows) { starts.push(length); length += row.length + 2; }
    const original = rows.join("\r\n"), secondLine = gap + 4; await mount(page, host, original);
    const before = await snapshot(page), originalRanges = [{ anchor: 8, head: 8 }, { anchor: starts[secondLine]! + 3, head: starts[secondLine]! + 3 }];
    await select(page, originalRanges);
    const ranges = async () => coords((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges);
    await page.evaluate(() => window.hostFixture.setSourceReadOnly(true));
    await input(page).press("ArrowDown"); await ready(page);
    expect(await ranges()).toEqual([{ anchor: starts[1]! + 2, head: starts[1]! + 2 }, { anchor: starts[secondLine + 1]! + 1, head: starts[secondLine + 1]! + 1 }]);
    await input(page).press("ArrowDown"); await ready(page);
    expect(await ranges()).toEqual([{ anchor: starts[2]! + 8, head: starts[2]! + 8 }, { anchor: starts[secondLine + 2]! + 3, head: starts[secondLine + 2]! + 3 }]);
    if (large) expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.firstLine).toBeLessThan(100);
    await input(page).press("ArrowUp"); await ready(page); await input(page).press("ArrowUp"); await ready(page); expect(await ranges()).toEqual(originalRanges);
    await input(page).press("Shift+ArrowDown"); await ready(page); await input(page).press("Shift+ArrowDown"); await ready(page);
    expect(await ranges()).toEqual([{ anchor: 8, head: starts[2]! + 8 }, { anchor: starts[secondLine]! + 3, head: starts[secondLine + 2]! + 3 }]);
    await input(page).press("Home"); await ready(page);
    expect(await ranges()).toEqual([{ anchor: starts[2]!, head: starts[2]! }, { anchor: starts[secondLine + 2]!, head: starts[secondLine + 2]! }]);
    await input(page).press("End"); await ready(page);
    expect(await ranges()).toEqual([{ anchor: starts[2]! + rows[2]!.length, head: starts[2]! + rows[2]!.length }, { anchor: original.length, head: original.length }]);
    await select(page, originalRanges); await input(page).press("Shift+ArrowRight"); await ready(page);
    expect(await ranges()).toEqual(originalRanges.map(range => ({ anchor: range.anchor, head: range.head + 1 })));
    await input(page).press("ArrowLeft"); await ready(page); expect(await ranges()).toEqual(originalRanges);
    const state = await snapshot(page), primary = state.bindings.views.find(v => v.id === "primary")!, pageLines = Math.max(1, Math.floor(primary.metrics!.viewport.height / primary.metrics!.viewport.lineHeight) - 1);
    await input(page).press("PageDown"); await ready(page);
    const target = (line: number, column: number) => { const at = Math.min(rows.length - 1, line + pageLines), offset = starts[at]! + Math.min(rows[at]!.length, column); return { anchor: offset, head: offset }; };
    expect(await ranges()).toEqual([target(0, 8), target(secondLine, 3)].sort((a, b) => a.head - b.head));
    await input(page).press("Control+Shift+Home"); await ready(page);
    const merged = (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet; expect(merged.ranges).toHaveLength(1); expect(merged.ranges[0]!.head).toBe(0);
    await input(page).press("Control+End"); await ready(page); expect(await ranges()).toEqual([{ anchor: original.length, head: original.length }]);
    const after = await snapshot(page); expect(after.source.revision).toBe(before.source.revision); expect(after.history).toEqual(before.history); expect(after.source.exports).toBe(0);
    expect(await page.evaluate(text => window.hostFixture.range(0, text.length) === text, original)).toBe(true);
    expect(await page.locator(".st-viewport-command-measure").count()).toBe(0);
    await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});

async function point(page: Page, offset: number) {
    return root(page).evaluate((element, offset) => {
        const row = [...element.querySelectorAll<HTMLElement>(".st-viewport-row")].find(row => Number(row.dataset.from) <= offset && Number(row.dataset.to) > offset);
        if (!row) throw new Error("Expected a rendered point.");
        let local = offset - Number(row.dataset.from); const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
            if (local >= node.length) { local -= node.length; continue; }
            const range = document.createRange(); range.setStart(node, local); range.setEnd(node, local + 1); const box = range.getBoundingClientRect();
            return { x: box.left + box.width * .1, y: box.top + box.height * .5 };
        }
        throw new Error("Expected a text point.");
    }, offset);
}
function replace(text: string, ranges: readonly Selection[], insert: string): string {
    let end = 0, output = "";
    for (const range of ranges) { const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head); output += text.slice(end, from) + insert; end = to; }
    return output + text.slice(end);
}

for (const host of ["plain", "react"]) for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} pointer-created selections type, undo, save, review and remount`, async ({ page }) => {
    test.setTimeout(60000);
    const header = "alpha bravo\r\n0123456789\r\ncharlie delta\r\n0123456789\r\necho foxtrot", original = header + (large ? "\r\n" + "row value\r\n".repeat(100000) + "tail" : "");
    await mount(page, host, original); await root(page).scrollIntoViewIfNeeded();
    const click = async (offset: number, modifier?: "Alt" | "Shift") => { const p = await point(page, offset); if (modifier) await page.keyboard.down(modifier); await page.mouse.click(p.x, p.y); if (modifier) await page.keyboard.up(modifier); await ready(page); };
    const second = header.indexOf("charlie"), third = header.indexOf("echo");
    await click(1); await click(second + 2, "Alt"); await click(second + 4, "Shift");
    const start = await point(page, third + 1), end = await point(page, third + 3);
    await page.keyboard.down("Alt"); await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 4 }); await page.mouse.up(); await page.keyboard.up("Alt"); await ready(page);
    const before = await snapshot(page), beforeSet = before.bindings.views.find(v => v.id === "primary")!.selectionSet;
    expect(coords(beforeSet.ranges)).toEqual([{ anchor: 1, head: 1 }, { anchor: second + 2, head: second + 4 }, { anchor: third + 1, head: third + 3 }]); expect(beforeSet.primary).toBe(2);
    await input(page).press("Shift+ArrowRight"); await ready(page);
    const typedSet = (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet;
    await input(page).pressSequentially("xy"); await ready(page); const changed = replace(original, typedSet.ranges, "xy");
    expect(await page.evaluate(n => window.hostFixture.range(0, n), changed.length)).toBe(changed);
    await input(page, "Secondary source").press("Control+z"); await ready(page);
    expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(typedSet);
    expect(await page.evaluate(n => window.hostFixture.range(0, n), original.length)).toBe(original);
    await input(page, "Comparison working source").press("Control+Shift+z"); await ready(page);
    expect((await snapshot(page)).source.exports).toBe(0);
    await input(page).evaluate(node => node.focus({ preventScroll: true })); await input(page).press("Control+s");
    await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
    await input(page).pressSequentially("z"); await ready(page); await page.evaluate(() => window.hostFixture.finishSave());
    await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1"); await ready(page);
    expect((await snapshot(page)).source.dirty).toBe(true);
    await input(page, "Secondary source").press("Control+z"); await ready(page); expect((await snapshot(page)).source.dirty).toBe(false);
    const retained = await snapshot(page); await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await ready(page);
    const remounted = await snapshot(page); expect(remounted.bindings.views.map(v => v.selectionSet)).toEqual(retained.bindings.views.map(v => v.selectionSet)); expect(remounted.history).toEqual(retained.history);
    expect(await page.evaluate(n => window.hostFixture.referenceRange(0, n), original.length)).toBe(original); expect(remounted.bindings.comparison!.status).toBe("ready");
    await input(page).evaluate(node => node.focus({ preventScroll: true })); await input(page).press("Escape"); await ready(page);
    expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges).toEqual([remounted.bindings.views.find(v => v.id === "primary")!.selection]);
    await input(page).press("Tab"); await expect(input(page)).not.toBeFocused();
    // A new ordinary click discards added carets; Alt+double-click adds a complete word.
    await root(page).scrollIntoViewIfNeeded(); await click(1); const word = changed.indexOf("bravo"), p = await point(page, word + 2);
    await page.keyboard.down("Alt"); await page.mouse.dblclick(p.x, p.y); await page.keyboard.up("Alt"); await ready(page);
    expect(coords((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges)).toEqual([{ anchor: 1, head: 1 }, { anchor: word, head: word + 5 }]);
    await click(1); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges).toHaveLength(1);
    expect((await snapshot(page)).source.exports).toBe(remounted.source.exports); await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 });
});

for (const host of ["plain", "react"]) test(`${host} 1024-range navigation yields atomically and expires captured work`, async ({ page }) => {
    test.setTimeout(90000);
    const row = "0123456789", text = Array(100000).fill(row).join("\r\n"), ranges = Array.from({ length: 1024 }, (_, index) => ({ anchor: index * 80 * 12 + 4, head: index * 80 * 12 + 4 }));
    await mount(page, host, text); await select(page, ranges);
    const before = await snapshot(page), began = before.bindings.views.find(v => v.id === "primary")!.metrics!.viewport;
    const pending = await input(page).evaluate(node => { node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); const s = window.hostFixture.snapshot(); return { pending: s.bindings.views.find(v => v.id === "primary")!.metrics!.pendingGrapheme, ranges: s.bindings.views.find(v => v.id === "primary")!.selectionSet.ranges }; });
    expect(pending.pending).toBe(true); expect(coords(pending.ranges)).toEqual(ranges); await ready(page);
    const after = await snapshot(page), state = after.bindings.views.find(v => v.id === "primary")!;
    expect(coords(state.selectionSet.ranges)).toEqual(ranges.map(range => ({ anchor: range.anchor + 12, head: range.head + 12 })));
    expect(state.metrics!.viewport.navigationReadUnits - began.navigationReadUnits).toBeLessThan(60000); expect(state.metrics!.viewport.firstLine).toBeLessThan(100);
    for (const change of ["selection", "revision", "layout", "remount"] as const) {
        await select(page, ranges);
        const capture = await input(page).evaluate((node, change) => {
            const f = window.hostFixture; node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true }));
            const pending = f.snapshot().bindings.views.find(v => v.id === "primary")!.metrics!.pendingGrapheme;
            if (change === "selection") f.selectSourceSet("primary", f.snapshot().source.revision, [rangesAt(4), rangesAt(24)], 0);
            else if (change === "revision") f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: "!" }]);
            else if (change === "layout") (node.parentElement as HTMLElement).style.letterSpacing = "1px";
            else { f.unmount(); f.mount(); }
            return { pending, set: f.snapshot().bindings.views.find(v => v.id === "primary")!.selectionSet };
            function rangesAt(head: number) { return { anchor: head, head }; }
        }, change);
        expect(capture.pending).toBe(true); await ready(page);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(capture.set);
    }
    expect((await snapshot(page)).source.exports).toBe(0); await page.evaluate(() => window.hostFixture.dispose());
    expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});

for (const host of ["plain", "react"]) test(`${host} offscreen short rows retain proportional, tab and bidi geometry for every range`, async ({ page }) => {
    const line = "abc אבג xyz\tWWii", gap = "filler\r\n".repeat(1000), text = line + "\r\n" + line + "\r\n" + gap + line + "\r\n" + line;
    await mount(page, host, text);
    await root(page).evaluate(element => { element.style.fontFamily = '"Times New Roman", serif'; element.style.fontSize = "21px"; element.style.lineHeight = "2"; element.style.tabSize = "6"; });
    await expect.poll(async () => (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.lineHeight).toBe(42); await ready(page);
    const second = 2 * (line.length + 2) + gap.length;
    for (const direction of ["ltr", "rtl"]) {
        await root(page).evaluate((element, direction) => element.style.setProperty("--st-text-direction", direction), direction);
        await select(page, [0, second].map(at => ({ anchor: at + 4, head: at + 7 })));
        await input(page).press("ArrowRight"); await ready(page);
        expect(coords((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges)).toEqual([0, second].map(at => ({ anchor: at + 4, head: at + 4 })));
        await input(page).press("Shift+ArrowLeft"); await ready(page);
        const extended = (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet;
        expect(coords(extended.ranges)).toEqual([0, second].map(at => ({ anchor: at + 4, head: at + 5 }))); expect(extended.ranges.every(range => range.anchorAffinity === "after")).toBe(true);
        await select(page, [{ anchor: 13, head: 13 }, { anchor: second + 14, head: second + 14 }]);
        await input(page).press("ArrowDown"); await ready(page);
        expect(coords((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges)).toEqual([{ anchor: line.length + 2 + 13, head: line.length + 2 + 13 }, { anchor: second + line.length + 2 + 14, head: second + line.length + 2 + 14 }]);
        await input(page).press("ArrowUp"); await ready(page);
        expect(coords((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges)).toEqual([{ anchor: 13, head: 13 }, { anchor: second + 14, head: second + 14 }]);
    }
    expect((await snapshot(page)).source.exports).toBe(0); expect(await page.locator(".st-viewport-command-measure").count()).toBe(0);
});
