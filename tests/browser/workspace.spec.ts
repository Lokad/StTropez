import { test, expect } from "@playwright/test";
import { corpus } from "../fixtures/workloads.ts";

test("real typing reaches the document and moving the surface preserves identity and selection", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/");
    await expect.poll(() => page.evaluate(() => window.sttropez?.ready)).toBe(true);
    const editor = page.getByRole("textbox", { name: "Transform source" });
    const before = await page.evaluate(() => window.sttropez.snapshot());
    await editor.fill("hello");
    await editor.press("End");
    await editor.pressSequentially(" world");
    await expect(editor).toHaveValue("hello world");
    const selection = await editor.evaluate((node: HTMLTextAreaElement) => node.selectionStart);
    await page.getByRole("button", { name: "Move source to other pane" }).click();
    await expect(page.locator("#right textarea")).toHaveValue("hello world");
    expect(await editor.evaluate((node: HTMLTextAreaElement) => node.selectionStart)).toBe(selection);
    const after = await page.evaluate(() => window.sttropez.snapshot());
    expect(after.tabs[0]?.id).toBe(before.tabs[0]?.id);
    expect(after.documents[0]?.revision).toBeGreaterThan(before.documents[0]?.revision ?? -1);
    expect(after.documents[0]?.length).toBe(11);
    expect(errors).toEqual([]);
});

test("deferred Save and explicit Run preserve their source/configuration targets while views move and typing continues", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "Transform source", exact: true });
    const secondary = page.getByRole("textbox", { name: "Secondary source view", exact: true });
    await input.fill("submitted  ");
    await page.getByRole("button", { name: "Save source", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.sttropez.snapshot().commands.pendingSaves.length)).toBe(1);
    const submitted = await page.evaluate(() => window.sttropez.snapshot());
    await page.getByRole("button", { name: "Move source to other pane" }).click();
    await input.press("End"); await input.pressSequentially("human correction");
    await expect(secondary).toHaveValue("submitted  human correction");
    await page.getByRole("button", { name: "Finish deferred save" }).click();
    await expect.poll(() => page.evaluate(() => window.sttropez.snapshot().commands.lastSavedRevision)).toBe(submitted.documents[0]!.revision);
    await expect(input).toHaveValue("submitted  human correction");
    expect((await page.evaluate(() => window.sttropez.snapshot())).commands.dirty).toBe(true);
    await page.getByRole("textbox", { name: "Source path" }).fill("next.csv");
    const beforeRun = await page.evaluate(() => window.sttropez.snapshot());
    await page.getByRole("button", { name: "Run preview" }).click();
    await input.pressSequentially(" later");
    const after = await page.evaluate(() => window.sttropez.snapshot());
    expect(after.commands.lastRun).toMatchObject({ sourceRevision: beforeRun.documents[0]!.revision,
        configurationRevision: beforeRun.connection.revision, sourceLength: beforeRun.documents[0]!.length, pathLength: 8 });
    expect(after.commands.savedWrites).toBe(1);
    expect(after.commands.errors).toEqual([]); expect(errors).toEqual([]);
});

test("host typed form has no dummy document and updates independently of source text", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/");
    await expect.poll(() => page.evaluate(() => window.sttropez?.ready)).toBe(true);
    const before = await page.evaluate(() => window.sttropez.snapshot());
    await page.getByRole("textbox", { name: "Source path" }).fill("incoming/other.csv");
    const after = await page.evaluate(() => window.sttropez.snapshot());
    expect(after.documents[0]).toEqual(before.documents[0]);
    expect(after.documents).toHaveLength(1);
    expect(after.connection.revision).toBeGreaterThan(before.connection.revision);
    expect(after.resources.find(resource => resource.kind === "panel")?.dirty).toBe(true);
    expect(errors).toEqual([]);
});

test("read-only transitions reach both views and reject an in-flight composition attempt", async ({ page }) => {
    page.on("pageerror", error => { throw error; });
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "Transform source", exact: true });
    await input.fill("retained");
    // Synthetic composition covers the adapter's refusal/recovery path only.
    await input.dispatchEvent("compositionstart");
    await input.evaluate((input: HTMLTextAreaElement) => { input.value = "attempted composition"; });
    await input.dispatchEvent("input");
    await page.evaluate(() => window.sttropez.setReadOnly(true));
    await expect(input).toHaveAttribute("readonly", "");
    await expect(page.getByRole("textbox", { name: "Secondary source view", exact: true })).toHaveAttribute("readonly", "");
    await input.dispatchEvent("compositionend");
    await expect(input).toHaveValue("retained");
    expect((await page.evaluate(() => window.sttropez.snapshot())).conflicts).toEqual([{ reason: "read-only", attemptedLength: 21 }]);
    await page.evaluate(() => window.sttropez.setReadOnly(false));
    await input.press("End"); await input.pressSequentially(" again");
    await expect(input).toHaveValue("retained again");
});

test("native LF selection and deletion map to exact CRLF model ranges and history restores original text", async ({ page }) => {
    page.on("pageerror", error => { throw error; });
    await page.goto("/"); await page.evaluate(() => window.sttropez.loadCorpus("unicode"));
    const input = page.getByRole("textbox", { name: "Transform source", exact: true }), original = corpus("unicode");
    await expect(input).toHaveValue(original.replaceAll("\r\n", "\n"));
    await input.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0)); await input.pressSequentially("Q");
    expect(await page.evaluate(() => window.sttropez.readText())).toBe(`Q${original}`);
    await input.evaluate((node: HTMLTextAreaElement) => { const offset = node.value.indexOf("\n"); node.setSelectionRange(offset, offset + 1); });
    await input.press("Backspace");
    expect(await page.evaluate(() => window.sttropez.readText())).toBe(`Q${original.replace("\r\n", "")}`);
    await input.press("Control+z"); expect(await page.evaluate(() => window.sttropez.readText())).toBe(`Q${original}`);
    await input.press("Control+Shift+z"); expect(await page.evaluate(() => window.sttropez.readText())).toBe(`Q${original.replace("\r\n", "")}`);
});

test("pointer focus places the caret at the clicked character and undo preserves that selection", async ({ page }) => {
    page.on("pageerror", error => { throw error; }); await page.goto("/");
    const input = page.getByRole("textbox", { name: "Transform source", exact: true });
    await input.fill("abcde"); await page.getByRole("button", { name: "Save source", exact: true }).focus();
    const point = await input.evaluate((node: HTMLTextAreaElement) => {
        const box = node.getBoundingClientRect(), style = getComputedStyle(node), canvas = document.createElement("canvas"), context = canvas.getContext("2d")!;
        context.font = style.font;
        return { x: box.left + parseFloat(style.paddingLeft) + context.measureText("ab").width + .1,
            y: box.top + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2 };
    });
    await page.mouse.click(point.x, point.y); await input.pressSequentially("X"); await expect(input).toHaveValue("abXcde");
    await input.press("Control+z"); await expect(input).toHaveValue("abcde");
    expect(await input.evaluate((node: HTMLTextAreaElement) => node.selectionStart)).toBe(2);
});
