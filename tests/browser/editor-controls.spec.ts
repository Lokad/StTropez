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
        await name.press("Control+Enter");
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
    await page.goto("/controls/?locale=fr");
    const source = page.getByRole("textbox", { name: "colors.ts" });
    await expect(page.locator(".st-color-swatch")).toBeVisible();
    await source.press("Control+Home");
    await source.press("Control+ArrowRight");
    await source.press("ArrowRight");
    await source.press("F2");
    const dialog = page.getByRole("dialog", { name: "Rename symbol" });
    const name = dialog.getByRole("textbox", { name: "Nouveau nom" });
    await name.fill("palette");
    await dialog.getByLabel("Rename status").click();
    await page.keyboard.type("s");
    await expect(name).toHaveValue("palettes");
    const apply = dialog.getByRole("button", { name: "Apply rename" });
    await expect(apply).toBeDisabled();
    await apply.click({ force: true });
    await page.keyboard.press("Control+Enter");
    const edits = dialog.getByLabel("Rename edits");
    await expect(edits).toContainText("palettes");
    const count = await edits.locator("li").count();
    await expect(dialog.getByLabel("Rename status")).toHaveText(String(count) + (count === 1 ? " modification" : " modifications"));
    await name.press("Escape");
    await source.press("Control+f");
    await page.getByRole("textbox", { name: "Find text" }).fill("accent");
    await expect(page.locator(".st-find-status")).toHaveText("2 résultats");
    await expect(source).toHaveValue('const accent = "#5fae99";\nuse(accent);');
});

test("pointer inspection yields to the picker and one Escape closes it", async ({ page }) => {
    await page.goto("/controls/");
    const source = page.getByRole("textbox", { name: "colors.ts" });
    const row = page.locator(".st-viewport-row").first();
    const dwell = () => row.hover({ position: { x: 20, y: 5 } });
    const swatch = page.locator(".st-color-swatch");
    await expect(swatch).toBeVisible();
    await dwell();
    const hover = page.locator(".st-hover");
    await expect(hover).toContainText("Fixture");
    await swatch.click();
    const dialog = page.getByRole("dialog", { name: "Color picker" });
    await expect(dialog.locator("li").first()).toBeVisible();
    await page.clock.install();
    await dwell();
    await page.clock.runFor(1200);
    await expect(hover).toBeHidden();
    await dialog.locator("li").first().click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(source).toBeFocused();
    await expect(source).toHaveValue('const accent = "#5fae99";\nuse(accent);');
});

test("hover actions use the inspected position and expire with the card", async ({ page }) => {
    await page.routeWebSocket("**/lsp-fixture", client => {
        const server = client.connectToServer();
        client.onMessage(packet => {
            const request = JSON.parse(packet.toString());
            if (request.method === "textDocument/hover" && request.params.position.character === 18) {
                client.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: null }));
            } else if (request.method === "textDocument/documentLink") {
                const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } };
                client.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: [{ range, target: "file:///guide" }] }));
            } else server.send(packet);
        });
    });
    await page.goto("/controls/");
    const source = page.getByRole("textbox", { name: "colors.ts" });
    await expect(page.locator(".st-color-swatch")).toBeVisible();
    async function inspect(offset: number) {
        await page.evaluate(async offset => {
            const path = "/controls/app.js";
            const { editor } = await import(path) as typeof import("../fixtures/controls/main.ts");
            editor.reveal({ from: offset, to: offset }, { select: true, focus: true });
            editor.commands.run("hover.inspect");
        }, offset);
    }
    const card = page.locator(".st-hover");
    await inspect(18);
    const custom = card.getByRole("button", { name: "Inspect offset" });
    await custom.click();
    const root = page.locator(".st-editor");
    await expect(root).toHaveAttribute("data-inspected-offset", "18");
    const old = await custom.elementHandle();
    await page.evaluate(async () => {
        const path = "/controls/app.js";
        const { editor } = await import(path) as typeof import("../fixtures/controls/main.ts");
        editor.reveal({ from: 3, to: 3 }, { select: true });
    });
    await expect(card).toBeHidden();
    await inspect(18);
    await card.getByRole("button", { name: "Edit color" }).click();
    await expect(card).toBeHidden();
    await expect(page.getByRole("dialog", { name: "Color picker" })).toBeVisible();
    await page.keyboard.press("Escape");
    await inspect(6);
    await custom.click();
    await old!.evaluate(button => (button as HTMLButtonElement).click());
    await expect(root).toHaveAttribute("data-inspected-offset", "6");
    await old!.dispose();
    await card.getByRole("button", { name: "Open link" }).click();
    await expect(root).toHaveAttribute("data-opened-link", "file:///guide");
    await card.getByRole("button", { name: "Code actions" }).click();
    await expect(page.getByRole("region", { name: "Quick fixes" })).toBeVisible();
    await expect(card).toBeHidden();
    await source.press("Escape");
});

test("several definitions offer a choice and a single reference opens directly", async ({ page }) => {
    await page.routeWebSocket("**/lsp-fixture", client => {
        const server = client.connectToServer();
        client.onMessage(packet => {
            const request = JSON.parse(packet.toString());
            if (!["textDocument/definition", "textDocument/references"].includes(request.method)) return server.send(packet);
            const location = (line: number, character: number) => ({ uri: request.params.textDocument.uri,
                range: { start: { line, character }, end: { line, character: character + 6 } } });
            const result = [location(0, 6)];
            if (request.method === "textDocument/definition") result.push(location(1, 4));
            client.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
        });
    });
    await page.goto("/controls/");
    await expect(page.locator(".st-color-swatch")).toBeVisible();
    const source = page.getByRole("textbox", { name: "colors.ts" });
    await source.press("F12");
    const list = page.getByRole("region", { name: "Symbol locations" });
    await expect(list.getByRole("option")).toHaveCount(2);
    await source.press("ArrowDown");
    await source.press("Enter");
    const last = (await source.inputValue()).lastIndexOf("accent");
    const selection = () => source.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd]);
    await expect.poll(selection).toEqual([last, last]);
    await source.press("Shift+F12");
    await expect.poll(selection).toEqual([6, 12]);
    await expect(list).toBeHidden();
});

test("clicking an allowed command action runs it once", async ({ page }) => {
    const executed: string[] = [];
    page.on("websocket", socket => socket.on("framesent", frame => {
        const request = JSON.parse(frame.payload.toString());
        if (request.method === "workspace/executeCommand") executed.push(request.params.command);
    }));
    await page.goto("/controls/");
    await expect(page.locator(".st-color-swatch")).toBeVisible();
    const source = page.getByRole("textbox", { name: "colors.ts" });
    await source.press("Control+.");
    const panel = page.getByRole("region", { name: "Quick fixes" });
    const action = panel.getByRole("button", { name: "Provider status command", exact: true });
    await expect(action).toBeEnabled();
    expect(executed).toEqual([]);
    await action.click();
    await expect(panel.getByLabel("Quick-fix status")).toHaveText("Command completed.");
    expect(executed).toEqual(["fixture.status"]);
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
