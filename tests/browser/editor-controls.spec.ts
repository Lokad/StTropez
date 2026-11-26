import { expect, test } from "./fixtures.ts";
import type { Locator } from "@playwright/test";

test("host shortcuts override Find and restore its bindings on disposal", async ({ page }) => {
    await page.goto("/controls/");
    const bindings = await page.evaluateHandle(async () => {
        const path = "/controls/app.js";
        const { editor } = await import(path) as typeof import("../fixtures/controls/main.ts");
        const calls: string[] = [];
        function bind(id: string, keys: string[], run: () => void) {
            return editor.commands.register({ id, label: id, run }, { keys, shared: true });
        }
        const host = bind("host.search", ["Mod+f", "Escape", "F3"], () => { calls.push("host"); });
        const newest = bind("host.temporary", ["Mod+f"], () => { calls.push("temporary"); });
        return { calls, host, newest };
    });
    const source = page.getByRole("textbox", { name: "colors.ts" });
    for (const key of ["Control+f", "Escape", "F3"]) await source.press(key);
    await bindings.evaluate(b => b.newest.dispose());
    await source.press("Control+f");
    expect(await bindings.evaluate(b => b.calls)).toEqual(["temporary", "host", "host", "host"]);
    await bindings.evaluate(b => b.host.dispose());
    await source.press("Control+f");
    await expect(page.getByRole("textbox", { name: "Find text" })).toBeFocused();
    await bindings.dispose();
});

async function contrast(element: Locator) {
    return element.evaluate(node => {
        const ctx = document.createElement("canvas").getContext("2d")!;
        const layers = [];
        for (let el: Element | null = node; el; el = el.parentElement) layers.push(getComputedStyle(el).backgroundColor);
        function paint(color: string) {
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
        }
        function luminance() {
            const rgb = ctx.getImageData(0, 0, 1, 1).data.slice(0, 3);
            const [r, g, b] = Array.from(rgb, byte => {
                const v = byte / 255;
                return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
            });
            return .2126 * r! + .7152 * g! + .0722 * b!;
        }
        paint("white");
        layers.reverse().forEach(paint);
        const background = luminance();
        paint(getComputedStyle(node).color);
        const text = luminance();
        return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
    });
}

test("a host palette keeps Find, completion and review text legible", async ({ page }) => {
    await page.goto("/controls/");
    const source = page.getByRole("textbox", { name: "colors.ts" });
    for (const [background, foreground, selection] of [
        ["#f4f4f4", "#383a42", "#b7d7fa"], ["#131b27", "#e1e7ef", "#24496b"]
    ]) {
        const style = await page.addStyleTag({ content: `:root {
            --st-background: ${background}; --st-foreground: ${foreground}; --st-selection: ${selection};
        }` });
        await source.press("Control+f");
        const query = page.getByRole("textbox", { name: "Find text" });
        await query.fill("accent");
        await expect(page.locator(".st-find-status")).toContainText("2");
        expect(await contrast(page.locator(".st-find-status"))).toBeGreaterThanOrEqual(4.5);
        await query.press("Escape");
        await source.press("Control+Space");
        const options = page.getByRole("option");
        await expect(options.first()).toBeVisible();
        for (const row of [options.first(), options.nth(1)]) expect(await contrast(row)).toBeGreaterThanOrEqual(4.5);
        await source.press("Escape");
        await source.press("Control+Home");
        await source.press("Control+ArrowRight");
        await source.press("ArrowRight");
        await source.press("F2");
        const name = page.getByRole("textbox", { name: "New name" });
        await name.fill("palette");
        await name.press("Enter");
        const edits = page.getByLabel("Rename edits");
        for (const tag of ["del", "ins"]) {
            const excerpt = edits.locator(tag).filter({ hasText: /\S/ }).first();
            await expect(excerpt).toBeVisible();
            expect(await contrast(excerpt)).toBeGreaterThanOrEqual(4.5);
        }
        await name.press("Escape");
        await style.evaluate(node => node.parentNode?.removeChild(node));
    }
});

test("forced colors distinguish a chosen completion, quick fix and pressed Find flag", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Chromium emulates the forced-colors system palette.");
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto("/controls/");
    const source = page.getByRole("textbox", { name: "colors.ts" });
    async function marked(chosen: Locator, other: Locator) {
        await expect(chosen).toBeVisible();
        await expect(chosen).toHaveCSS("outline-style", "solid");
        const background = await other.evaluate(el => getComputedStyle(el).backgroundColor);
        await expect(chosen).not.toHaveCSS("background-color", background);
    }
    await source.press("Control+Space");
    await marked(page.getByRole("option", { selected: true }), page.getByRole("option", { selected: false }).first());
    await source.press("Escape");
    await source.press("Control+.");
    await expect(page.locator(".st-code-actions [data-choice]").first()).toBeVisible();
    await source.press("ArrowDown");
    await marked(page.locator('.st-code-actions [data-chosen="true"]'), page.locator('.st-code-actions [data-chosen="false"]').first());
    await source.press("Escape");
    await source.press("Control+f");
    const flag = page.getByRole("button", { name: "Match case" });
    await flag.click();
    await marked(flag, page.getByRole("button", { name: "Match whole word" }));
});

test("Replace all keeps typing in the replacement field after a click or shortcut", async ({ page }) => {
    await page.goto("/controls/");
    const source = page.getByRole("textbox", { name: "colors.ts" });
    await source.press("Control+h");
    const query = page.getByRole("textbox", { name: "Find text" });
    const replacement = page.getByRole("textbox", { name: "Replacement text" });
    const all = page.getByRole("button", { name: "Replace all", exact: true });
    await query.fill("accent");
    await replacement.fill("tone");
    await all.click();
    await expect(source).toHaveValue('const tone = "#5fae99";\nuse(tone);');
    await page.keyboard.type("s");
    await expect(replacement).toHaveValue("tones");
    await query.fill("tone");
    await expect(all).toBeEnabled();
    await query.press("Control+Alt+Enter");
    await expect(source).toHaveValue('const tones = "#5fae99";\nuse(tones);');
    await expect(replacement).toBeFocused();
});

test("accepting a completion keeps its visible line at the same scroll position", async ({ page }) => {
    await page.goto("/controls/");
    const source = page.getByRole("textbox", { name: "colors.ts" });
    await source.press("Control+a");
    await page.keyboard.insertText("sa\n".repeat(120));
    await source.press("Control+Home");
    const viewport = page.locator(".st-viewport");
    await viewport.evaluate(el => { el.scrollTop = 700; });
    const row = viewport.locator('.st-viewport-row[data-line="36"]');
    await row.click({ position: { x: 5, y: 5 } });
    await source.press("End");
    await source.press("Control+Space");
    await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible();
    const top = await viewport.evaluate(el => el.scrollTop);
    expect(top).toBeGreaterThan(0);
    await source.press("Enter");
    await expect(row).toContainText("sample");
    expect(await viewport.evaluate(el => el.scrollTop)).toBe(top);
});

test("clicking the rename status or disabled Apply keeps the next keystroke in the name field", async ({ page }) => {
    await page.goto("/controls/");
    const source = page.getByRole("textbox", { name: "colors.ts" });
    await expect(page.locator(".st-color-swatch")).toBeVisible();
    await source.press("Control+Home");
    await source.press("Control+ArrowRight");
    await source.press("ArrowRight");
    await source.press("F2");
    const dialog = page.getByRole("dialog", { name: "Rename symbol" });
    const name = dialog.getByRole("textbox", { name: "New name" });
    await name.fill("palette");
    await dialog.getByLabel("Rename status").click();
    await page.keyboard.type("s");
    await expect(name).toHaveValue("palettes");
    const apply = dialog.getByRole("button", { name: "Apply rename" });
    await expect(apply).toBeDisabled();
    await apply.click({ force: true });
    await page.keyboard.press("Enter");
    await expect(dialog.getByLabel("Rename edits")).toContainText("palettes");
    await expect(source).toHaveValue('const accent = "#5fae99";\nuse(accent);');
});

test("Escape dismisses the picker after clicking its edit preview", async ({ page }) => {
    await page.goto("/controls/");
    const source = page.getByRole("textbox", { name: "colors.ts" });
    await page.locator(".st-color-swatch").click();
    const dialog = page.getByRole("dialog", { name: "Color picker" });
    await dialog.locator("li").first().click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(source).toBeFocused();
    await expect(source).toHaveValue('const accent = "#5fae99";\nuse(accent);');
});

test("Enter in a quick-fix list with no available action leaves the source intact", async ({ page }) => {
    await page.routeWebSocket("**/lsp-fixture", client => {
        const server = client.connectToServer();
        client.onMessage(packet => {
            const request = JSON.parse(packet.toString());
            if (request.method === "textDocument/codeAction") {
                client.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: [] }));
            } else server.send(packet);
        });
    });
    await page.goto("/controls/");
    await expect(page.locator(".st-color-swatch")).toBeVisible();
    const source = page.getByRole("textbox", { name: "colors.ts" });
    await source.press("Control+.");
    const panel = page.getByRole("region", { name: "Quick fixes" });
    await expect(panel.getByLabel("Quick-fix status")).toHaveText(/no .*actions/i);
    await page.keyboard.press("Enter");
    await expect(panel).toBeVisible();
    await expect(source).toHaveValue('const accent = "#5fae99";\nuse(accent);');
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
});
