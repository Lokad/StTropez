import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function ready(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(() => { const s = window.editingFixture?.snapshot(); return s && s.primary.viewport.revision === s.document?.revision && !s.primary.viewport.pending; })).toBe(true);
}
const state = (page: Page) => page.evaluate(() => window.editingFixture.snapshot());
test.beforeEach(async ({ page }) => {
    page.on("pageerror", error => { throw error; });
    page.on("console", message => { if (message.type() === "error") throw new Error(message.text()); });
    await page.goto("/editing/"); await ready(page);
});

test("real typing in 100k lines uses bounded native context and shared grouped undo", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.select("primary", { anchor: 1_200_000, head: 1_200_000 }); window.editingFixture.focus("primary"); }); await ready(page);
    await page.keyboard.type("xyz"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(1_200_000, 1_200_003))).toBe("xyz");
    expect((await state(page))).toMatchObject({ document: { revision: 3, length: 2_400_003, exports: 0 }, primary: { commits: 3, selection: { anchor: 1_200_003, head: 1_200_003 } }, secondary: { selection: { anchor: 0, head: 0 } }, history: { undoDepth: 1 } });
    expect((await state(page)).primary.inputUnits).toBeLessThan(2600);
    await page.keyboard.press("ControlOrMeta+z"); await ready(page);
    expect((await state(page))).toMatchObject({ document: { length: 2_400_000, exports: 0 }, primary: { selection: { head: 1_200_000 } } });
    await page.keyboard.press("ControlOrMeta+Shift+z"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(1_200_000, 1_200_003))).toBe("xyz");
    await page.keyboard.press("ControlOrMeta+a"); expect((await state(page)).primary.inputUnits).toBe(1);
    await page.keyboard.type("replacement"); await ready(page);
    expect((await state(page)).document).toMatchObject({ length: 11, exports: 0 });
    expect(await page.evaluate(() => window.editingFixture.range(0, 11))).toBe("replacement");
    await page.keyboard.press("ControlOrMeta+z"); await ready(page);
    expect((await state(page)).document!.length).toBe(2_400_003);
});

test("measured tab/CJK/cluster coordinates drive pointer selection and whole-grapheme deletion", async ({ page }) => {
    await page.evaluate(() => window.editingFixture.setText("a\t界é👩‍💻z\r\nsecond")); await ready(page);
    const points = await page.evaluate(() => [1, 2, 3, 4, 5, 10, 11].map(offset => window.editingFixture.coords(offset)!));
    expect(points[1]!.left - points[0]!.left).toBeGreaterThan(points[2]!.left - points[1]!.left);
    expect(points[3]!.offset).toBe(5); // A caret inside a combining sequence snaps to its boundary.
    for (const point of points) expect(await page.evaluate(p => window.editingFixture.hit(p.left, p.top + p.height / 2)?.offset, point)).toBe(point.offset);
    const point = points[4]!; await page.mouse.click(point.left, point.top + point.height / 2);
    expect((await state(page)).primary.selection.head).toBe(5);
    await page.keyboard.press("Backspace"); expect(await page.evaluate(() => window.editingFixture.range(0, 17))).toBe("a\t界👩‍💻z\r\nsecond");
    await page.keyboard.press("Delete"); expect(await page.evaluate(() => window.editingFixture.range(0, 12))).toBe("a\t界z\r\nsecond");
    await page.keyboard.press("End"); await page.keyboard.press("ArrowRight");
    expect((await state(page)).primary.selection.head).toBe(6); // CRLF moves as one grapheme.
    await page.keyboard.press("Backspace"); expect(await page.evaluate(() => window.editingFixture.range(0, 10))).toBe("a\t界zsecond");
});

test("synthetic clipboard events replace a large backward selection and preserve raw newlines", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.select("primary", { anchor: 2_300_000, head: 100_000 }); window.editingFixture.focus("primary"); });
    expect((await state(page)).primary.inputUnits).toBe(513);
    await page.getByRole("textbox", { name: "Primary source" }).evaluate(input => {
        const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
        event.clipboardData!.setData("text/plain", "A\r\nB");
        if (event.clipboardData!.getData("text/plain") !== "A\r\nB") throw new Error("Synthetic clipboard fixture lost its data.");
        input.dispatchEvent(event);
    }); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(100_000, 100_004))).toBe("A\r\nB");
    expect((await state(page))).toMatchObject({ document: { length: 200_004, exports: 0 }, primary: { selection: { anchor: 100_004, head: 100_004 } } });
    await page.keyboard.press("ControlOrMeta+z"); await ready(page); expect((await state(page)).document!.length).toBe(2_400_000);
});

test("synthetic composition commits once and rejects stale, readonly and expired captured targets", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("alpha omega"); window.editingFixture.select("primary", { anchor: 6, head: 11 }); window.editingFixture.focus("primary"); }); await ready(page);
    const input = page.getByRole("textbox", { name: "Primary source" });
    const start = async () => input.evaluate(node => {
        const input = node as HTMLTextAreaElement; input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        input.setRangeText("東京", input.selectionStart, input.selectionEnd, "end"); input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true }));
    });
    const end = async () => input.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "東京" })));
    await start(); expect((await state(page)).primary.commits).toBe(0); await end(); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 8))).toBe("alpha 東京"); expect((await state(page)).primary.commits).toBe(1);
    for (const reason of ["stale-revision", "read-only", "expired-view"]) {
        await start();
        await page.evaluate(reason => {
            if (reason === "stale-revision") window.editingFixture.edit([{ from: 0, to: 0, insert: "host " }]);
            if (reason === "read-only") window.editingFixture.readOnly(true);
            if (reason === "expired-view") window.editingFixture.replacePrimary();
        }, reason);
        await end();
        expect((await state(page)).conflicts.at(-1)).toMatchObject({ reason });
        expect(await page.evaluate(() => window.editingFixture.conflictText())).toContain("東京");
        if (reason === "read-only") await page.evaluate(() => window.editingFixture.readOnly(false));
    }
    expect((await state(page)).primary.commits).toBe(1);
    expect((await state(page)).secondary.viewport.revision).toBe((await state(page)).document!.revision);
});

test("two views share text while selection, focus escape and disposal stay independent", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("first\nsecond"); window.editingFixture.select("secondary", { anchor: 6, head: 12 }); window.editingFixture.focus("primary"); }); await ready(page);
    await page.keyboard.type("!"); await ready(page);
    expect((await state(page)).secondary.selection).toMatchObject({ anchor: 7, head: 13 });
    await page.keyboard.press("Tab"); expect(await page.evaluate(() => window.editingFixture.range(0, 6))).toBe("!    f");
    await page.keyboard.press("Escape"); await page.keyboard.press("Tab"); await expect(page.getByRole("textbox", { name: "Secondary source" })).toBeFocused();
    await page.evaluate(() => window.editingFixture.dispose());
    expect((await state(page)).diagnostics).toMatchObject({ resources: 0, documents: 0, views: 0, subscriptions: 0, leases: 0 });
    expect((await state(page)).primary).toMatchObject({ disposed: true, inputUnits: 0, viewport: { disposed: true, pending: false } });
    expect(await page.locator("textarea, .st-viewport").count()).toBe(0);
});

test("line indentation/outdent, paired brackets and vertical navigation use model selections", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("one\n\ttwo\nthree"); window.editingFixture.select("primary", { anchor: 0, head: 9 }); window.editingFixture.focus("primary"); }); await ready(page);
    await page.keyboard.press("Tab"); expect(await page.evaluate(() => window.editingFixture.range(0, 22))).toBe("    one\n    \ttwo\nthree");
    await page.keyboard.press("Shift+Tab"); expect(await page.evaluate(() => window.editingFixture.range(0, 14))).toBe("one\n\ttwo\nthree");
    await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.press("End"); await page.keyboard.type("(");
    expect(await page.evaluate(() => window.editingFixture.range(14, 16))).toBe("()");
    await page.keyboard.type(")"); expect((await state(page)).document!.length).toBe(16); expect((await state(page)).primary.selection.head).toBe(16);
    await page.keyboard.press("ControlOrMeta+Home"); await ready(page); await page.keyboard.press("ArrowDown");
    expect((await state(page)).primary.selection.head).toBe(4);
    await page.keyboard.press("ArrowUp"); expect((await state(page)).primary.selection.head).toBe(0);
});

test("very long graphemes delete whole and stale yielding indentation cannot retarget later input", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("x" + "\u0301".repeat(5000)); window.editingFixture.select("primary", { anchor: 5001, head: 5001 }); window.editingFixture.focus("primary"); });
    await page.keyboard.press("Backspace"); await expect.poll(async () => (await state(page)).document!.length).toBe(0);
    await page.keyboard.press("ControlOrMeta+z"); expect((await state(page)).document!.length).toBe(5001);
    await page.evaluate(() => {
        window.editingFixture.load("lines-100000"); window.editingFixture.select("primary", { anchor: 0, head: 2_400_000 });
        const input = document.querySelector("#primary textarea")!;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
        window.editingFixture.edit([{ from: 0, to: 0, insert: "later " }]);
    });
    await expect.poll(async () => (await state(page)).conflicts.at(-1)?.reason).toBe("stale-indent-command");
    expect((await state(page)).document!.length).toBe(2_400_006);
    expect(await page.evaluate(() => window.editingFixture.range(0, 6))).toBe("later ");
});

test("yielding multiline indentation publishes one reversible transaction", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("x\n".repeat(1024)); window.editingFixture.select("primary", { anchor: 0, head: 2048 }); window.editingFixture.focus("primary"); });
    const before = await state(page); await page.keyboard.press("Tab");
    await expect.poll(async () => (await state(page)).document!.length).toBe(6144);
    expect((await state(page)).document!.revision).toBe(before.document!.revision + 1);
    expect(await page.evaluate(() => window.editingFixture.range(0, 12))).toBe("    x\n    x\n");
    await page.keyboard.press("ControlOrMeta+z"); await ready(page);
    expect((await state(page)).document!.length).toBe(2048); expect((await state(page)).primary.selection).toMatchObject({ anchor: 0, head: 2048 });
});

test("short shaped rows grow horizontal extent and a later revision discards obsolete measurements", async ({ page }) => {
    await page.evaluate(() => window.editingFixture.setText("界".repeat(512))); await ready(page);
    const large = (await state(page)).primary.viewport;
    expect(large.horizontalExtent).toBeGreaterThan(512 * large.columnWidth + 24);
    await page.evaluate(() => window.editingFixture.setText("x")); await ready(page);
    const small = (await state(page)).primary.viewport;
    expect(small.horizontalExtent).toBeLessThan(small.width); expect(small.physicalWidth).toBe(small.width);
});

test("browser-protocol composition commits one bounded edit without qualifying native IME", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Chromium CDP composition; native-device IME remains a separate gate on every engine.");
    await page.evaluate(() => { window.editingFixture.setText("alpha omega"); window.editingFixture.select("primary", { anchor: 6, head: 11 }); window.editingFixture.focus("primary"); }); await ready(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
    expect((await state(page)).primary).toMatchObject({ composing: true, commits: 0 });
    await cdp.send("Input.insertText", { text: "日本語" }); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 9))).toBe("alpha 日本語");
    expect((await state(page)).primary).toMatchObject({ composing: false, commits: 1, selection: { head: 9 } });
    await page.keyboard.press("ControlOrMeta+z"); expect(await page.evaluate(() => window.editingFixture.range(0, 11))).toBe("alpha omega");
    await cdp.detach();
});
