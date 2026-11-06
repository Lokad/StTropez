import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => { page.on("pageerror", error => { throw error; }); await page.goto("/shaping/"); await page.waitForFunction(() => window.shapingFixture?.ready); await page.evaluate(() => window.shapingFixture.fontsReady()); });

test("full-context ranges differ from independent fragments and prefix canvas origins", async ({ page }) => {
    const cases = await page.evaluate(() => {
        const f = window.shapingFixture;
        const kerningInitial = f.mount("AVATAR office affinity"), kerning = f.query(1, 2, 1, 6);
        f.mount("ب".repeat(80)); const joining = f.query(40, 41, 40, 41);
        const tabs = f.mount("ab\tcd\te"), tab = f.query(3, 4, 3, 7);
        return { kerningInitial, kerning, joining, tabs, tab };
    });
    const originError = Math.abs(cases.kerning.wholeBoxes[0]!.left - cases.kerning.prefixWidth - cases.kerning.fragmentBoxes[0]!.left);
    expect(originError).toBeGreaterThan(.2);
    expect(Math.abs(cases.kerningInitial.nativeWidth - cases.kerningInitial.canvasWidth)).toBeLessThan(1.1);
    expect(Math.abs(cases.joining.wholeBoxes[0]!.width - cases.joining.fragmentBoxes[0]!.width)).toBeGreaterThan(1);
    expect(Math.abs(cases.tabs.nativeWidth - cases.tabs.canvasWidth)).toBeGreaterThan(1);
    expect(cases.tabs.style.canvasFont).toContain(cases.tabs.style.fontSize);
    expect(Math.abs(cases.tab.wholeBoxes[0]!.left - cases.tab.prefixWidth - cases.tab.fragmentBoxes[0]!.left)).toBeGreaterThan(1);
});

test("complete context reproduces distant isolates, ligatures, emoji and proportional range geometry", async ({ page }) => {
    const queries = await page.evaluate(() => {
        const f = window.shapingFixture, text = "AV office 👩‍💻 á \u2067" + "א".repeat(600) + " 123\u2069 end";
        f.mount(text, { font: "italic 24px Times New Roman" });
        return [1, 4, 10, text.indexOf("123"), text.length - 1].map(from => {
            const to = from === 10 ? from + "👩‍💻".length : from + 1;
            return f.query(from, to, 0, text.length);
        });
    });
    for (const query of queries) {
        expect(query.wholeBoxes.length).toBeGreaterThan(0); expect(query.wholeBoxes.length).toBe(query.fragmentBoxes.length);
        query.wholeBoxes.forEach((whole, i) => { for (const key of ["left", "right", "width", "height"] as const) expect(Math.abs(whole[key] - query.fragmentBoxes[i]![key])).toBeLessThan(.1); });
    }
});

test("512 units of context do not preserve shaping across a long transparent-mark sequence", async ({ page }) => {
    const query = await page.evaluate(() => {
        const f = window.shapingFixture, text = "ل" + "\u064e".repeat(2048) + "ا", from = text.length - 1;
        f.mount(text); return f.query(from, from + 1, from - 512, text.length);
    });
    expect(query.wholeBoxes.length).toBeGreaterThan(0); expect(query.fragmentBoxes.length).toBeGreaterThan(0);
    expect(Math.abs(query.wholeBoxes[0]!.width - query.fragmentBoxes[0]!.width)).toBeGreaterThan(1);
});

test("a distant override reverses native visual order beyond a fragment's context", async ({ page }) => {
    const queries = await page.evaluate(() => {
        const f = window.shapingFixture, text = "\u202e" + "a".repeat(600) + "123\u202c", from = text.indexOf("123"); f.mount(text);
        return [0, 1, 2].map(i => f.query(from + i, from + i + 1, from - 128, text.length));
    });
    for (let i = 0; i < 2; i++) {
        expect(queries[i]!.wholeBoxes[0]!.left).toBeGreaterThan(queries[i + 1]!.wholeBoxes[0]!.left);
        expect(queries[i]!.fragmentBoxes[0]!.left).toBeLessThan(queries[i + 1]!.fragmentBoxes[0]!.left);
    }
});

test("million-unit native paragraphs expose proportional DOM text and release all probe-owned text", async ({ page }) => {
    await page.locator("#typing").fill("host input");
    const state = await page.evaluate(() => {
        const f = window.shapingFixture, initial = f.mount("x".repeat(1_000_000)), query = f.query(999_999, 1_000_000, 999_488, 1_000_000), mounted = f.snapshot();
        const selected = document.getSelection()?.toString(); f.dispose(); f.dispose();
        return { initial, query, mounted, released: f.snapshot(), nodes: f.hostNodes(), selected, selectedAfter: document.getSelection()?.toString() };
    });
    expect(state.initial.domTextUnits).toBe(1_000_000); expect(state.mounted!.domTextUnits).toBe(1_000_512);
    expect(state.query.wholeBoxes[0]!.left).toBeGreaterThan(1_000_000); expect(state.initial.nativeWidth).toBeGreaterThan(1_000_000);
    expect(state.released).toMatchObject({ disposed: true, domTextUnits: 0, nativeTextNodes: 0 }); expect(state.nodes).toBe(0);
    expect(state.selectedAfter).toBe(state.selected); await expect(page.locator("#typing")).toHaveValue("host input");
});

test("raw native replacements preserve revisions and reject stale jobs without touching host UI", async ({ page }) => {
    const state = await page.evaluate(() => {
        const f = window.shapingFixture, initial = f.mount("AVATAR"), before = f.query(2, 3, 0, 6), rejected = f.replace(1, 0, 1, "x"), unchanged = f.snapshot();
        const accepted = f.replace(0, 0, 1, "WW"), after = f.query(3, 4, 0, 7); f.dispose();
        let throws = false; try { f.query(0, 0, 0, 0); } catch { throws = true; }
        return { initial, before, rejected, unchanged, accepted, after, throws };
    });
    expect(state.rejected).toBeNull(); expect(state.unchanged!.revision).toBe(0); expect(state.initial.revision).toBe(0); expect(state.before.revision).toBe(0);
    expect(state.accepted).toMatchObject({ revision: 1, units: 7, readbackUnits: 7 }); expect(state.after.revision).toBe(1); expect(state.throws).toBe(true);
});
