import { test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import type { Selection } from "../../src/index.ts";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
async function clipboard(page: Page, type: "copy" | "cut" | "paste", text = ""): Promise<string> {
    return input(page).evaluate((node, { type, text }) => {
        const event = new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
        if (!event.clipboardData) throw new Error("Synthetic clipboard fixture requires an event data store.");
        if (type === "paste") event.clipboardData.setData("text/plain", text);
        node.dispatchEvent(event); return event.clipboardData.getData("text/plain");
    }, { type, text });
}
async function ready(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(() => { const s = window.hostFixture.snapshot(), c = s.bindings.comparison;
        return s.bindings.views.every(v => v.metrics && !v.metrics.pendingCaret && !v.metrics.pendingWord && !v.metrics.pendingGrapheme
            && !v.metrics.viewport.pending && v.metrics.viewport.revision === s.source.revision && v.metrics.viewport.selectionSet === v.selectionSet)
            && (!c || c.status === "ready" && !c.input.pendingCaret && !c.input.pendingWord && !c.input.pendingGrapheme && !c.workingViewport.pending && !c.referenceViewport?.pending);
    })).toBe(true);
}
async function exact(page: Page, text: string): Promise<void> {
    expect(await page.evaluate(text => { const f = window.hostFixture; return f.snapshot().source.length === text.length && f.range(0, text.length) === text; }, text)).toBe(true);
}
async function select(page: Page, ranges: readonly Selection[], primary = 0, id: "primary" | "secondary" | "comparison" = "primary"): Promise<void> {
    expect(await page.evaluate(({ id, ranges, primary }) => { const f = window.hostFixture; return f.selectSourceSet(id, f.snapshot().source.revision, ranges, primary); }, { id, ranges, primary })).toBe(true); await ready(page);
}
async function mount(page: Page, host: string, text: string): Promise<void> {
     await page.goto(`/hosts/${host}/?editor=candidate`);
    await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, text);
    await page.getByRole("button", { name: "Open source review", exact: true }).click(); await ready(page);
    for (const name of ["Capture review acceptance", "Finish review acceptance"]) await page.getByRole("button", { name, exact: true }).click();
    await ready(page); await input(page).evaluate(n => n.focus({ preventScroll: true }));
}
function replace(text: string, ranges: readonly Selection[], insert: string): { text: string; ranges: Selection[] } {
    let end = 0, output = ""; const carets: Selection[] = [];
    for (const range of ranges) { const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head);
        output += text.slice(end, from) + insert; carets.push({ anchor: output.length, head: output.length }); end = to; }
    return { text: output + text.slice(end), ranges: carets };
}
const coords = (ranges: readonly Selection[]) => ranges.map(({ anchor, head }) => ({ anchor, head }));

for (const host of ["plain", "react"]) {
    for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} actual multiple-range typing shares history, saved captures and remount`, async ({ page }) => {
        test.setTimeout(60000);
        const header = "same same\r\nleft 👩‍💻 right\r\nsame", line = "const sample = 123;\r\n", original = header + (large ? "\r\n" + line.repeat(100000) + "tail" : "");
        await mount(page, host, original);
        const ranges = [{ anchor: 4, head: 0 }, { anchor: header.indexOf("right"), head: header.indexOf("right") }, { anchor: header.length - 4, head: header.length },
            ...(large ? [{ anchor: 500000, head: 1000 }, ...Array.from({ length: 32 }, (_, index) => ({ anchor: header.length + 7 + line.length * (50000 + index), head: header.length + 7 + line.length * (50000 + index) }))] : [])];
        await select(page, ranges, large ? 3 : 0); const before = await snapshot(page), beforeSet = before.bindings.views.find(v => v.id === "primary")!.selectionSet;
        await input(page).pressSequentially("xy"); await ready(page);
        const expected = replace(original, ranges, "xy"), after = await snapshot(page);
        await exact(page, expected.text); expect(after.source.revision).toBe(before.source.revision + 2);
        expect(after.history.undoDepth).toBe(before.history.undoDepth + 1);
        expect(coords(after.bindings.views.find(v => v.id === "primary")!.selectionSet.ranges)).toEqual(expected.ranges);
        expect(after.bindings.views.find(v => v.id === "primary")!.metrics!.commits).toBe(before.bindings.views.find(v => v.id === "primary")!.metrics!.commits + 2);
        await input(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, original);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(beforeSet);
        await input(page, "Comparison working source").press("Control+Shift+z"); await ready(page); await exact(page, expected.text);
        const primary = input(page); await primary.evaluate(n => n.focus({ preventScroll: true })); await primary.press("Control+s");
        await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await primary.pressSequentially("z"); await ready(page); const late = replace(expected.text, expected.ranges, "z");
        await page.evaluate(() => window.hostFixture.finishSave()); await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1"); await ready(page);
        await exact(page, late.text); expect((await snapshot(page)).source.dirty).toBe(true);
        await input(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, expected.text); expect((await snapshot(page)).source.dirty).toBe(false);
        await input(page, "Secondary source").press("Control+Shift+z"); await ready(page); await exact(page, late.text);
        const retained = await snapshot(page); await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await ready(page);
        const remounted = await snapshot(page); expect(remounted.history).toEqual(retained.history);
        expect(remounted.bindings.views.map(v => v.selectionSet)).toEqual(retained.bindings.views.map(v => v.selectionSet));
        // The remounted controller has its own epoch; the immutable reference identity/content remain.
        expect(retained.bindings.comparison!.baseline).toEqual(before.bindings.comparison!.baseline);
        expect(remounted.bindings.comparison!.baseline).toMatchObject({ version: before.bindings.comparison!.baseline!.version, length: original.length });
        expect(await page.evaluate(n => window.hostFixture.referenceRange(0, n), original.length)).toBe(original);
        expect(remounted.source.exports).toBe(0); expect(remounted.bindings.views.every(v => v.metrics!.inputUnits <= 2600 && v.metrics!.viewport.rows < 100 && v.metrics!.viewport.readUnits < 20000)).toBe(true);
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 });
    });

    test(`${host} repeated replacements and plain clipboard apply one original-coordinate plan`, async ({ page }) => {
        const original = "aaaa|aaaa"; await mount(page, host, original);
        await select(page, [{ anchor: 2, head: 1 }, { anchor: 7, head: 6 }], 1);
        const before = await snapshot(page); await input(page).pressSequentially("a"); await ready(page); await exact(page, original);
        let state = await snapshot(page); expect(state.source.revision).toBe(before.source.revision); expect(state.history).toEqual(before.history);
        expect(coords(state.bindings.views.find(v => v.id === "primary")!.selectionSet.ranges)).toEqual([{ anchor: 2, head: 2 }, { anchor: 7, head: 7 }]);
        const ranges = [{ anchor: 0, head: 2 }, { anchor: 9, head: 7 }]; await select(page, ranges, 1);
        const copied = await clipboard(page, "copy");
        expect(copied).toBe("aa\naa");
        await clipboard(page, "cut");
        await ready(page); await exact(page, replace(original, ranges, "").text);
        await input(page).press("Control+z"); await ready(page); await exact(page, original);
        const pasted = "$&\r\n😀";
        await clipboard(page, "paste", pasted);
        await ready(page); await exact(page, replace(original, ranges, pasted).text);
        await input(page).press("Control+z"); await ready(page); await exact(page, original);
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(true)); const locked = await snapshot(page);
        await clipboard(page, "cut"); await clipboard(page, "paste", "blocked");
        await ready(page); await exact(page, original); state = await snapshot(page); expect(state.history).toEqual(locked.history); expect(state.source.exports).toBe(0);
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(false));
        await select(page, ranges, 1); const captured = await snapshot(page);
        await input(page).evaluate(node => { const input = node as HTMLTextAreaElement, f = window.hostFixture;
            input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "x" }));
            f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 1, head: 1 }, { anchor: 9, head: 7 }], 1);
            input.setRangeText("x", input.selectionStart, input.selectionEnd, "end"); input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "x" })); });
        await ready(page); await exact(page, original); state = await snapshot(page);
        expect(state.history).toEqual(captured.history); expect(state.inputRecovery.at(-1)?.reason).toBe("stale-text-input");
        await page.evaluate(() => window.hostFixture.dispose());
    });

    test(`${host} synthetic multiple-range composition captures complete sets and rejects stale or locked targets`, async ({ page }) => {
        const original = "same middle same"; await mount(page, host, original); const ranges = [{ anchor: 4, head: 0 }, { anchor: 12, head: 16 }];
        await select(page, ranges, 1); const before = await snapshot(page);
        const stage = () => input(page).evaluate(node => { const input = node as HTMLTextAreaElement; input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
            input.setRangeText("東京", input.selectionStart, input.selectionEnd, "end"); input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true })); });
        const end = () => input(page).evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "東京" })));
        await stage(); await exact(page, original); await end(); await ready(page); await exact(page, "東京 middle 東京");
        expect((await snapshot(page)).source.revision).toBe(before.source.revision + 1);
        await input(page).press("Control+z"); await ready(page); await exact(page, original);
        for (const failure of ["secondary", "revision", "readonly"] as const) {
            await select(page, ranges, 1); await stage();
            await page.evaluate(failure => { const f = window.hostFixture;
                if (failure === "secondary") f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 1, head: 1 }, { anchor: 12, head: 16 }], 1);
                if (failure === "revision") f.editSource(f.snapshot().source.revision, [{ from: 6, to: 7, insert: "M" }]);
                if (failure === "readonly") f.setSourceReadOnly(true);
            }, failure);
            const staged = await snapshot(page); await end(); await ready(page); const rejected = await snapshot(page);
            expect(rejected.source.revision).toBe(staged.source.revision); expect(rejected.history).toEqual(staged.history);
            expect(rejected.inputRecovery.at(-1)?.reason).toBe(failure === "secondary" ? "stale-text-input" : failure === "revision" ? "stale-revision" : "read-only");
            expect(await page.evaluate(() => window.hostFixture.recoveryText())).toContain("東京");
            if (failure === "readonly") await page.evaluate(() => window.hostFixture.setSourceReadOnly(false));
        }
        await select(page, ranges, 1); const cancelled = await snapshot(page);
        await input(page).evaluate(node => { node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" })); });
        await ready(page); expect((await snapshot(page)).history).toEqual(cancelled.history); expect((await snapshot(page)).source.revision).toBe(cancelled.source.revision);
        expect((await snapshot(page)).source.exports).toBe(0); await page.evaluate(() => window.hostFixture.dispose());
    });

    test(`${host} Unicode and word deletion merge overlapping targets into one undo transaction`, async ({ page }) => {
        const original = "a😀b e\u0301c\r\nword word"; await mount(page, host, original);
        const ranges = [2, 3, 7, 10].map(offset => ({ anchor: offset, head: offset })); ranges.push({ anchor: 19, head: 15 });
        await select(page, ranges, 3); const before = await snapshot(page);
        await input(page).press("Backspace"); await ready(page); await exact(page, "ab cword ");
        const after = await snapshot(page); expect(after.history.undoDepth).toBe(before.history.undoDepth + 1); expect(after.source.revision).toBe(before.source.revision + 1);
        await input(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, original);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(before.bindings.views.find(v => v.id === "primary")!.selectionSet);
        await input(page).evaluate(n => n.focus({ preventScroll: true })); await select(page, [{ anchor: 14, head: 14 }, { anchor: 19, head: 19 }], 1);
        await input(page).press("Control+Backspace"); await ready(page); await exact(page, "a😀b e\u0301c\r\n ");
        await input(page).press("Control+z"); await ready(page); await exact(page, original);
        await select(page, [{ anchor: 0, head: 1 }, { anchor: 19, head: 15 }]);
        await input(page).evaluate(node => { const input = node as HTMLTextAreaElement;
            input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "deleteContentForward", cancelable: false }));
            input.setRangeText("", input.selectionStart, input.selectionEnd, "end"); input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentForward" })); });
        await ready(page); await exact(page, "😀b e\u0301c\r\nword "); expect((await snapshot(page)).source.exports).toBe(0);
        const many = "ab ".repeat(1024);
        await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, many);
        await select(page, Array.from({ length: 1024 }, (_, index) => ({ anchor: index * 3 + 2, head: index * 3 + 2 })), 1023);
        const manyBefore = await snapshot(page); await input(page).press("Backspace"); await ready(page); await exact(page, "a ".repeat(1024));
        expect((await snapshot(page)).source.revision).toBe(manyBefore.source.revision + 1); expect((await snapshot(page)).history.undoDepth).toBe(manyBefore.history.undoDepth + 1);
        const long = "start\r\n" + "e\u0301".repeat(40000);
        await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, long);
        await select(page, [{ anchor: 0, head: 0 }, { anchor: long.length, head: long.length }], 1); const pendingBefore = await snapshot(page);
        const yielded = await input(page).evaluate(node => { node.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", ctrlKey: true, bubbles: true, cancelable: true }));
            const f = window.hostFixture, s = f.snapshot(), m = s.bindings.views.find(v => v.id === "primary")!.metrics!;
            f.selectSourceSet("primary", s.source.revision, [{ anchor: 1, head: 1 }, { anchor: s.source.length, head: s.source.length }], 1);
            return m.pendingWord || m.pendingGrapheme; });
        expect(yielded).toBe(true); await ready(page);
        await page.evaluate(() => new Promise<void>(resolve => { let turns = 16; const tick = () => { if (--turns) setTimeout(tick, 0); else resolve(); }; setTimeout(tick, 0); }));
        await exact(page, long); expect((await snapshot(page)).history).toEqual(pendingBefore.history);
        await page.evaluate(() => window.hostFixture.dispose());
    });

    test(`${host} multiple carets pair brackets and selected lines indent once`, async ({ page }) => {
        const original = "a b\r\n    c d\r\n"; await mount(page, host, original);
        await select(page, [{ anchor: 1, head: 1 }, { anchor: 3, head: 3 }], 1);
        await input(page).press("("); await ready(page); await exact(page, "a() b()\r\n    c d\r\n");
        expect(coords((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges)).toEqual([{ anchor: 2, head: 2 }, { anchor: 6, head: 6 }]);
        await input(page).press(")"); await ready(page); await exact(page, "a() b()\r\n    c d\r\n");
        expect(coords((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges)).toEqual([{ anchor: 3, head: 3 }, { anchor: 7, head: 7 }]);
        await input(page).press("Control+z"); await ready(page); await exact(page, original);
        await select(page, [{ anchor: 0, head: 1 }, { anchor: 3, head: 2 }, { anchor: 10, head: 10 }], 1);
        const before = await snapshot(page); await input(page).press("Tab"); await ready(page); await exact(page, "    a b\r\n        c d\r\n");
        expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
        await input(page).press("Shift+Tab"); await ready(page); await exact(page, original);
        expect((await snapshot(page)).source.exports).toBe(0); await page.evaluate(() => window.hostFixture.dispose());
    });
}
