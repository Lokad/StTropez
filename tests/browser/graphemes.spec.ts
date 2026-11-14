import { expect, test } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const state = (page: Page) => page.evaluate(() => window.editingFixture.snapshot());
async function ready(page: Page) {
    await expect.poll(async () => { const s = await state(page); return !s.primary.pendingGrapheme && !s.primary.pendingWord && !s.primary.viewport.pending; }, { timeout: 15000 }).toBe(true);
}
async function setup(page: Page, text: string, head: number) {
    await page.evaluate(({ text, head }) => { window.editingFixture.setText(text); window.editingFixture.select("primary", { anchor: head, head }); window.editingFixture.focus("primary"); }, { text, head }); await ready(page);
}

test("all Unicode 18 grapheme cases agree with gold while native differences remain observable", async ({ page, browser }, info) => {
    await page.goto("/fonts/"); await page.waitForFunction(() => window.nativeFontFixture?.ready);
    const lines = gunzipSync(await readFile("tests/fixtures/graphemes/GraphemeBreakTest.txt.gz")).toString("utf8").trim().split(/\r?\n/);
    const cases = lines.map(line => { let text = ""; const boundaries: number[] = []; for (const token of line.split(/\s+/)) { if (token === "÷") boundaries.push(text.length); else if (token !== "×") text += String.fromCodePoint(parseInt(token, 16)); } return { text, boundaries }; });
    const observed = await page.evaluate(cases => {
        const native = new Intl.Segmenter(undefined, { granularity: "grapheme" });
        const rows = cases.map((c, row) => ({ row, text: c.text, gold: c.boundaries, core: window.nativeFontFixture.graphemes(c.text), native: [...native.segment(c.text)].map(s => s.index).concat(c.text.length) }));
        return { rows: rows.length, markers: cases.reduce((n, c) => n + c.boundaries.length, 0), coreDifferences: rows.filter(r => JSON.stringify(r.gold) !== JSON.stringify(r.core)), nativeDifferences: rows.filter(r => JSON.stringify(r.gold) !== JSON.stringify(r.native)) };
    }, cases);
    const nativeSha256 = createHash("sha256").update(JSON.stringify(observed.nativeDifferences)).digest("hex");
    await mkdir("artifacts/graphemes", { recursive: true }); await writeFile(`artifacts/graphemes/native-${info.project.name}.json`, JSON.stringify({ created: new Date().toISOString(), browser: browser.version(), unicode: "18.0.0", nativeSha256, ...observed }, null, 2));
    expect(observed.rows).toBe(853); expect(observed.markers).toBe(2400); expect(observed.coreDifferences).toEqual([]);
    const profile = info.project.name === "webkit" ? { count: 18, sha: "34dd6eef31872807a036813dabe0a4cb5c0e3a92d9bf56fa9541e154aba1616b" } : { count: 10, sha: "a2f8dae5ab732480bb8f05f6d376d7752c9c769d09569e6218ed9b0437d8e9ee" };
    expect(observed.nativeDifferences.length).toBe(profile.count); expect(nativeSha256).toBe(profile.sha);
    console.log(`Native grapheme profile ${info.project.name}: ${observed.nativeDifferences.length} differences, ${nativeSha256}`);
});

test("editing deletes whole long, emoji, Indic and CRLF clusters and restores their exact source", async ({ page }) => {
    await page.goto("/editing/"); await ready(page);
    for (const cluster of ["x" + "\u0301".repeat(90_000), "👩" + "\u0301".repeat(20_000) + "\u200d💻", "\u094d" + "\u0301".repeat(20_000) + "क", "\r\n"]) {
        const text = "a\n" + cluster + "!";
        await setup(page, text, 2 + cluster.length); const before = await state(page);
        await page.keyboard.press("Backspace"); await ready(page); expect(await page.evaluate(() => window.editingFixture.range(0, 3))).toBe("a\n!");
        expect((await state(page)).document!.revision).toBe(before.document!.revision + 1);
        await page.keyboard.press("ControlOrMeta+z"); await ready(page); expect(await page.evaluate(n => window.editingFixture.range(0, n), text.length)).toBe(text);
        await page.evaluate(() => window.editingFixture.select("primary", { anchor: 2, head: 2 }));
        await page.keyboard.press("Delete"); await ready(page); expect((await state(page)).document!.length).toBe(3);
        expect((await state(page)).document!.exports).toBe(0);
    }
    await setup(page, "a" + "\u0301".repeat(5000) + "!", 2300); await page.keyboard.press("Delete"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 1))).toBe("!");
});

test("regional-indicator parity uses the whole line and repeated movement reuses its immutable index", async ({ page }) => {
    await page.goto("/editing/"); await ready(page);
    const text = "🇦".repeat(3001); await setup(page, text, 6002);
    await page.keyboard.press("ArrowLeft"); await ready(page); expect((await state(page)).primary.selection.head).toBe(6000);
    expect((await state(page)).primary.graphemeScanSteps).toBeGreaterThan(0);
    await page.keyboard.press("ArrowLeft"); await ready(page); expect((await state(page)).primary.selection.head).toBe(5996);
    expect((await state(page)).primary.graphemeScanSteps).toBe(0);
    await page.keyboard.press("Delete"); await ready(page); expect((await state(page)).document!.length).toBe(5998);
});

test("local ASCII deletion avoids whole-line indexing while nearby Unicode and CRLF retain exact clusters", async ({ page }) => {
    await page.goto("/editing/"); await ready(page);
    const text = "\u0600" + "x".repeat(2400000), offset = 1200000;
    await setup(page, text, offset); const before = await state(page);
    await page.keyboard.press("Delete"); await ready(page);
    const after = await state(page);
    expect(after.document).toMatchObject({ length: text.length - 1, revision: before.document!.revision + 1, exports: 0 });
    expect(after.primary.graphemeScanSteps).toBe(0);
    expect(after.primary.selection).toMatchObject({ anchor: offset, head: offset });
    expect(await page.evaluate(() => window.editingFixture.range(1199998, 1200002))).toBe("xxxx");
    await page.keyboard.press("ControlOrMeta+z"); await ready(page);
    expect(await page.evaluate(n => window.editingFixture.range(0, n), text.length)).toBe(text);
    for (const cluster of ["\u0600a", "a\u0301", "\r\n"]) {
        const original = "x".repeat(5000) + cluster + "b";
        await setup(page, original, 5000 + cluster.length);
        await page.keyboard.press("Backspace"); await ready(page);
        const removed = await state(page);
        expect(removed.primary.graphemeScanSteps).toBeGreaterThan(0);
        expect(await page.evaluate(n => window.editingFixture.range(0, n), 5001)).toBe("x".repeat(5000) + "b");
        await page.keyboard.press("ControlOrMeta+z"); await ready(page);
        expect(await page.evaluate(n => window.editingFixture.range(0, n), original.length)).toBe(original);
    }
});

test("a whole-line deletion yields to animation frames and typing in the other view cancels it", async ({ page }) => {
    await page.goto("/editing/"); await ready(page); await setup(page, "x" + "\u0301".repeat(1_000_000), 1_000_001);
    const observed = await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate(input => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
        return new Promise<{ frames: number; pending: boolean }>(resolve => { let frames = 0; const tick = () => { const pending = window.editingFixture.snapshot().primary.pendingGrapheme; if (++frames === 2 || !pending) resolve({ frames, pending }); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    });
    expect(observed).toEqual({ frames: 2, pending: true });
    await page.evaluate(() => window.editingFixture.focus("secondary")); await page.keyboard.type("!"); await ready(page);
    const after = await state(page); expect(after.primary.commits).toBe(0); expect(after.secondary.commits).toBe(1); expect(after.document!.length).toBe(1_000_002); expect(after.document!.exports).toBe(0);
});

test("pending whole-line scans yield to frames and expire on revision, selection, tab, permission or disposal changes", async ({ page }) => {
    for (const changed of ["revision", "selection", "generation", "permission", "dispose"] as const) {
        await page.goto("/editing/"); await ready(page); await setup(page, "x" + "\u0301".repeat(1_000_000), 1_000_001);
        const before = await state(page);
        const pending = await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate((input, changed) => {
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
            const pending = window.editingFixture.snapshot().primary.pendingGrapheme;
            if (changed === "revision") window.editingFixture.edit([{ from: 0, to: 0, insert: "!" }]);
            if (changed === "selection") window.editingFixture.select("primary", { anchor: 2, head: 2 });
            if (changed === "generation") window.editingFixture.replacePrimary();
            if (changed === "permission") window.editingFixture.readOnly(true);
            if (changed === "dispose") window.editingFixture.dispose();
            return pending;
        }, changed);
        expect(pending).toBe(true);
        const frames = await page.evaluate(() => new Promise<number>(resolve => { let frames = 0; const tick = () => { if (++frames === 3) resolve(frames); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); }));
        expect(frames).toBe(3); await expect.poll(async () => (await state(page)).primary.pendingGrapheme).toBe(false);
        const after = await state(page); expect(after.primary.commits).toBe(before.primary.commits);
        if (changed !== "dispose") { expect(after.document!.length).toBe(1_000_001 + (changed === "revision" ? 1 : 0)); expect(after.document!.exports).toBe(0); }
        else expect(after.diagnostics.resources).toBe(0);
    }
});
