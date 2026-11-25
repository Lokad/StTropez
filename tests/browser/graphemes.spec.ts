import { ready, expect, test } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const state = (page: Page) => page.evaluate(() => window.editingFixture.snapshot());

async function setup(page: Page, text: string, head: number) {
    await page.evaluate(({ text, head }) => { window.editingFixture.setText(text); window.editingFixture.select("primary", { anchor: head, head }); window.editingFixture.focus("primary"); }, { text, head }); await ready(page);
}

test("compare the browser's grapheme boundaries with the Unicode 18 corpus", async ({ page, browser }, info) => {
    await page.goto("/editing/");
    await ready(page);
    const lines = gunzipSync(await readFile("tests/fixtures/graphemes/GraphemeBreakTest.txt.gz")).toString("utf8").trim().split(/\r?\n/);
    const cases = lines.map(line => { let text = ""; const boundaries: number[] = []; for (const token of line.split(/\s+/)) { if (token === "÷") boundaries.push(text.length); else if (token !== "×") text += String.fromCodePoint(parseInt(token, 16)); } return { text, boundaries }; });
    const observed = await page.evaluate(cases => {
        const native = new Intl.Segmenter(undefined, { granularity: "grapheme" });
        const rows = cases.map((c, row) => ({
            row, text: c.text, gold: c.boundaries,
            actual: window.editingFixture.graphemeBoundaries(c.text),
            native: [...native.segment(c.text)].map(segment => segment.index).concat(c.text.length)
        }));
        return {
            mismatches: rows.filter(r => JSON.stringify(r.actual) !== JSON.stringify(r.native)),
            rows: rows.length, markers: cases.reduce((n, c) => n + c.boundaries.length, 0),
            nativeDifferences: rows.filter(r => JSON.stringify(r.gold) !== JSON.stringify(r.native))
                .map(({ row, text, gold, native }) => ({ row, text, gold, native }))
        };
    }, cases);
    const nativeSha256 = createHash("sha256").update(JSON.stringify(observed.nativeDifferences)).digest("hex");
    await mkdir("artifacts/graphemes", { recursive: true }); await writeFile(`artifacts/graphemes/native-${info.project.name}.json`, JSON.stringify({ created: new Date().toISOString(), browser: browser.version(), unicode: "18.0.0", nativeSha256, ...observed }, null, 2));
    expect(observed.mismatches).toEqual([]);
    expect(observed.rows).toBe(853);
    expect(observed.markers).toBe(2400);
    // Preserve versioned observations as browsers update their own Unicode data.
    console.log(`Native grapheme profile ${info.project.name}: ${observed.nativeDifferences.length} differences, ${nativeSha256}`);
});

test("editing deletes whole long, emoji, Indic and CRLF clusters and restores their exact source", async ({ page }) => {
    await page.goto("/editing/"); await ready(page);
    for (const cluster of ["x" + "\u0301".repeat(90_000), "👩" + "\u0301".repeat(20_000) + "\u200d💻", "\u094d" + "\u0301".repeat(20_000) + "क", "\r\n"]) {
        const text = "a\n" + cluster + "!";
        const expected = await page.evaluate(cluster => {
            const parts = [...new Intl.Segmenter().segment(cluster)];
            return { back: "a\n" + cluster.slice(0, parts.at(-1)!.index) + "!",
                forward: "a\n" + cluster.slice(parts[0]!.segment.length) + "!" };
        }, cluster);
        await setup(page, text, 2 + cluster.length); const before = await state(page);
        await page.keyboard.press("Backspace"); await ready(page); expect(await page.evaluate(n => window.editingFixture.range(0, n), expected.back.length)).toBe(expected.back);
        expect((await state(page)).document!.revision).toBe(before.document!.revision + 1);
        await page.keyboard.press("ControlOrMeta+z"); await ready(page); expect(await page.evaluate(n => window.editingFixture.range(0, n), text.length)).toBe(text);
        await page.evaluate(() => window.editingFixture.select("primary", { anchor: 2, head: 2 }));
        await page.keyboard.press("Delete"); await ready(page); expect(await page.evaluate(n => window.editingFixture.range(0, n), expected.forward.length)).toBe(expected.forward);
    }
    await setup(page, "a" + "\u0301".repeat(5000) + "!", 2300); await page.keyboard.press("Delete"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 1))).toBe("!");
});

test("regional-indicator parity uses the whole line and repeated movement reuses its immutable index", async ({ page }) => {
    await page.goto("/editing/"); await ready(page);
    const text = "🇦".repeat(30_001);
    await setup(page, text, text.length);
    await page.keyboard.press("ArrowLeft");
    await ready(page);
    expect((await state(page)).primary.selection.head).toBe(text.length - 2);
    // The second move can publish its selection before the command returns.
    expect(await page.evaluate(() => {
        window.editingFixture.command("move-left");
        return window.editingFixture.snapshot().primary.selection.head;
    })).toBe(text.length - 6);
    await page.keyboard.press("Delete"); await ready(page); expect((await state(page)).document!.length).toBe(text.length - 4);
});

test("local ASCII deletion avoids whole-line indexing while nearby Unicode and CRLF retain exact clusters", async ({ page }) => {
    await page.goto("/editing/"); await ready(page);
    const text = "\u0600" + "x".repeat(240_000), offset = 120_000;
    await setup(page, text, offset); const before = await state(page);
    expect(await page.evaluate(() => {
        window.editingFixture.command("delete-forward");
        return window.editingFixture.snapshot().document!.length;
    })).toBe(text.length - 1);
    await ready(page);
    const after = await state(page);
    expect(after.document).toMatchObject({ length: text.length - 1, revision: before.document!.revision + 1 });
    expect(after.primary.selection).toMatchObject({ anchor: offset, head: offset });
    expect(await page.evaluate(() => window.editingFixture.range(119_998, 120_002))).toBe("xxxx");
    await page.keyboard.press("ControlOrMeta+z"); await ready(page);
    expect(await page.evaluate(n => window.editingFixture.range(0, n), text.length)).toBe(text);
    for (const cluster of ["\u0600a", "a\u0301", "\r\n"]) {
        const original = "x".repeat(5000) + cluster + "b";
        await setup(page, original, 5000 + cluster.length);
        await page.keyboard.press("Backspace"); await ready(page);
        expect(await page.evaluate(n => window.editingFixture.range(0, n), 5001)).toBe("x".repeat(5000) + "b");
        await page.keyboard.press("ControlOrMeta+z"); await ready(page);
        expect(await page.evaluate(n => window.editingFixture.range(0, n), original.length)).toBe(original);
    }
});

test("a pending whole-line deletion expires when its captured input changes", async ({ page }) => {
    for (const changed of ["revision", "secondary", "selection", "generation", "permission", "dispose"] as const) {
        await page.goto("/editing/"); await ready(page); await setup(page, "x" + "\u0301".repeat(100_000), 100_001);
        const before = await state(page);
        const pending = await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate((input, changed) => {
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
            const pending = window.editingFixture.snapshot().primary.pendingGrapheme;
            if (changed === "revision") window.editingFixture.edit([{ from: 0, to: 0, insert: "!" }]);
            if (changed === "secondary") {
                window.editingFixture.focus("secondary");
                const other = document.activeElement as HTMLTextAreaElement;
                const event = { inputType: "insertText", data: "!", bubbles: true };
                if (other.dispatchEvent(new InputEvent("beforeinput", { ...event, cancelable: true }))) {
                    other.setRangeText("!", other.selectionStart, other.selectionEnd, "end");
                    other.dispatchEvent(new InputEvent("input", event));
                }
            }
            if (changed === "selection") window.editingFixture.select("primary", { anchor: 2, head: 2 });
            if (changed === "generation") window.editingFixture.replacePrimary();
            if (changed === "permission") window.editingFixture.readOnly(true);
            if (changed === "dispose") window.editingFixture.dispose();
            return pending;
        }, changed);
        expect(pending).toBe(true);
        await expect.poll(async () => (await state(page)).primary.pendingGrapheme).toBe(false);
        const after = await state(page);
        if (changed === "dispose") expect(after.diagnostics.resources).toBe(0);
        else {
            const inserted = changed === "revision" || changed === "secondary" ? 1 : 0;
            expect(after.document).toMatchObject({ revision: before.document!.revision + inserted, length: 100_001 + inserted });
        }
    }
});
