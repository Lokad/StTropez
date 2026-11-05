import { test, expect } from "@playwright/test";

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

test("host form and text surface update independent documents", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/");
    await expect.poll(() => page.evaluate(() => window.sttropez?.ready)).toBe(true);
    const before = await page.evaluate(() => window.sttropez.snapshot());
    await page.getByRole("textbox", { name: "Source path" }).fill("incoming/other.csv");
    const after = await page.evaluate(() => window.sttropez.snapshot());
    expect(after.documents[0]).toEqual(before.documents[0]);
    expect(after.documents[1]?.revision).toBeGreaterThan(before.documents[1]?.revision ?? -1);
    expect(errors).toEqual([]);
});
