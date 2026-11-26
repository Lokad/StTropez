import { test, expect, warnsBeforeUnload } from "./fixtures.ts";
import { paintedCharacter } from "../helpers/painted-character.ts";

test("the reference Find replaces the selected word, reports wrapping and returns focus for Undo", async ({ page }) => {
    await page.goto("/reference/");
    const source = page.getByRole("textbox", { name: "quote.ts" });
    await source.press("Control+Home");
    await source.press("Control+Shift+ArrowRight");
    await source.press("Control+h");
    const query = page.getByRole("textbox", { name: "Find text" });
    const replacement = page.getByRole("textbox", { name: "Replacement text" });
    await expect(query).toHaveValue(/^export\s*$/);
    await expect(replacement).toBeFocused();
    await query.fill("quote");
    const status = page.locator(".st-find-status");
    await expect(status).toHaveText("1 of 2");
    await page.getByRole("button", { name: "Previous match" }).click();
    await expect(status).toHaveText("2 of 2 · Wrapped to end");
    await replacement.fill("estimate");
    await page.getByRole("button", { name: "Replace all" }).click();
    await expect(page.locator(".st-viewport-row").filter({ hasText: "estimate" })).toHaveCount(2);
    await query.press("Escape");
    await expect(source).toBeFocused();
    await source.press("Control+z");
    await expect(page.locator(".st-viewport-row").filter({ hasText: "quote" })).toHaveCount(2);
});

test("a late definition leaves typing in the reference Find bar", async ({ page }) => {
    let release: (() => void) | undefined;
    let hold = true;
    await page.routeWebSocket("**/lsp-fixture", client => {
        const server = client.connectToServer();
        server.onMessage(packet => client.send(packet));
        client.onMessage(packet => {
            const request = JSON.parse(packet.toString());
            if (request.method !== "textDocument/definition") return server.send(packet);
            const uri = request.params.textDocument.uri;
            const range = { start: { line: 2, character: 16 }, end: { line: 2, character: 21 } };
            release = () => {
                client.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { uri, range } }));
                // The diagnostic appears after the held reply on the same connection.
                client.send(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics",
                    params: { uri, diagnostics: [{ range, message: "Definition delivered" }] } }));
            };
            if (!hold) release();
        });
    });
    await page.goto("/reference/");
    await page.getByRole("button", { name: "Connect language server" }).click();
    const source = page.getByRole("textbox", { name: "quote.ts" });
    await source.press("Control+End");
    await page.getByRole("button", { name: "Definition", exact: true }).click();
    await expect.poll(() => !!release).toBe(true);
    await page.getByRole("button", { name: "Find", exact: true }).click();
    const query = page.getByRole("textbox", { name: "Find text" });
    await expect(query).toBeFocused();
    release!();
    await expect(page.getByRole("button", { name: "Definition delivered" })).toBeVisible();
    await page.keyboard.type("q");
    await expect(query).toHaveValue("q");
    await expect(page.locator("#pane .st-viewport-row").first()).toContainText("export const accent");
    hold = false;
    await query.press("Escape");
    await source.press("Control+End");
    const call = page.locator("#pane .st-viewport-row").filter({ hasText: "quote(24, 3)" });
    const point = await paintedCharacter(call, "quote", 2);
    await page.mouse.move(point.x, point.y);
    await page.keyboard.down("Control");
    await expect(call.locator(".st-definition-link")).toHaveText("quote");
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up("Control");
    const at = (await source.inputValue()).indexOf("function quote") + "function ".length;
    await expect.poll(() => source.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd]))
        .toEqual([at, at + "quote".length]);
});

test("the reference host highlights the completion that Enter inserts", async ({ page }) => {
    await page.goto("/reference/");
    await page.getByRole("button", { name: "Connect language server" }).click();
    await expect(page.getByRole("button", { name: "Resolve this placeholder." })).toBeVisible();
    const source = page.getByRole("textbox", { name: "quote.ts" });
    await source.press("ControlOrMeta+End");
    await source.press("ControlOrMeta+Space");
    const list = page.getByRole("listbox", { name: "Completions" });
    const current = list.getByRole("option", { selected: true });
    await expect(current).toHaveText("sample");
    await source.press("ArrowDown");
    await expect(current).toHaveText("sampleWithImport");
    const other = list.getByRole("option", { name: "sample", exact: true });
    const background = await other.evaluate(button => getComputedStyle(button).backgroundColor);
    await expect(current).not.toHaveCSS("background-color", background);
    await page.keyboard.press("Enter");
    await expect(page.locator("#pane .st-viewport-row").last()).toHaveText("sampleValue");
});

test("the reference shortcut and toolbar review a captured code action at the source", async ({ page }) => {
    let disabledOnly = true;
    await page.routeWebSocket("**/lsp-fixture", client => {
        const server = client.connectToServer();
        client.onMessage(message => {
            const request = JSON.parse(message.toString());
            if (disabledOnly && request.method === "textDocument/codeAction") {
                client.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: [
                    { title: "Unavailable context example", disabled: { reason: "The fixture requires another context." } },
                ] }));
            } else server.send(message);
        });
    });
    await page.setViewportSize({ width: 760, height: 240 });
    await page.goto("/reference/");
    await page.getByRole("button", { name: "Connect language server" }).click();
    await page.getByRole("button", { name: "Resolve this placeholder." }).click();
    const source = page.getByRole("textbox", { name: "quote.ts" });
    const panel = page.locator("#pane").getByRole("region", { name: "Quick fixes" });
    const caret = source.locator("..").locator(".st-input-caret");
    await caret.evaluate(node => window.scrollBy(0, node.getBoundingClientRect().bottom + 30));
    expect(await caret.evaluate(node => node.getBoundingClientRect().bottom)).toBeLessThan(0);
    await page.keyboard.press("ControlOrMeta+.");
    const unavailable = panel.getByRole("button", { name: "Unavailable context example" });
    await expect(unavailable).toBeDisabled();
    await expect(panel).toBeInViewport();
    await expect(panel.getByLabel("Quick-fix status")).toHaveText("No available actions for this range.");
    await expect(unavailable).toHaveAttribute("title", "The fixture requires another context.");
    await source.press("ArrowDown");
    await expect(panel).toBeHidden();
    await source.press("ControlOrMeta+Home");
    disabledOnly = false;
    await page.getByRole("button", { name: "Code actions", exact: true }).click();
    const edit = panel.getByRole("button", { name: 'Insert module "sample-utils"' });
    await edit.click();
    const code = page.locator("#pane .st-viewport-row").filter({ hasText: "sample-utils" });
    await expect(panel).toBeHidden();
    await expect(code).toBeVisible();
    await expect(source).toBeFocused();
    await source.press("ControlOrMeta+z");
    await expect(code).toHaveCount(0);
});

test("the reference swatch reviews provider formats and preserves the source selection through Undo", async ({ page }) => {
    await page.goto("/reference/");
    await page.getByRole("button", { name: "Connect language server" }).click();
    const source = page.getByRole("textbox", { name: "quote.ts" });
    await source.press("ControlOrMeta+End");
    await source.press("Shift+ArrowUp");
    const selection = () => source.evaluate(node => {
        const input = node as HTMLTextAreaElement;
        return input.value.slice(input.selectionStart, input.selectionEnd);
    });
    const selected = await selection();
    expect(selected.length).toBeGreaterThan(0);
    const swatch = page.locator(".st-color-swatch").first();
    const dialog = page.getByRole("dialog", { name: "Color picker" });
    await swatch.click();
    const format = dialog.getByRole("combobox", { name: "Format" });
    await expect(format).toBeEnabled();
    await expect(dialog.getByLabel("Color", { exact: true })).toHaveValue("#5fae99");
    expect(await selection()).toBe(selected);
    const alpha = dialog.getByRole("spinbutton", { name: "Opacity (%)" });
    await alpha.fill("50");
    await expect(dialog.locator("ins").filter({ hasText: /0\.5|80$/ })).toBeVisible();
    await format.selectOption({ label: "rgba(95, 174, 153, 0.5)" });
    await expect(dialog.locator("ins")).toContainText(["// color presentation", "rgba(95, 174, 153, 0.5)"]);
    const apply = dialog.getByRole("button", { name: "Apply color" });
    const previous = await apply.elementHandle();
    await alpha.fill("101");
    await expect(apply).toBeDisabled();
    await expect(dialog).toContainText("Enter an opacity between 0 and 100.");
    await previous!.evaluate(node => (node as HTMLButtonElement).click());
    await expect(page.locator(".st-viewport-row").filter({ hasText: "#5fae99" })).toHaveCount(1);
    await alpha.fill("25");
    await format.selectOption({ label: "rgba(95, 174, 153, 0.25)" });
    await apply.click();
    await expect(dialog).toBeHidden();
    await expect(source).toBeFocused();
    expect(await selection()).toBe(selected);
    const rows = page.locator("#pane .st-viewport-row");
    await expect(rows.filter({ hasText: "rgba(95, 174, 153, 0.25)" })).toHaveCount(1);
    await source.press("ControlOrMeta+z");
    await expect(rows.filter({ hasText: "#5fae99" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "// color presentation" })).toHaveCount(0);
    expect(await selection()).toBe(selected);
});

test("a rename reports success after changing the reference document and Undo clears the result", async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 350 });
    await page.goto("/reference/");
    await page.getByRole("button", { name: "Connect language server" }).click();
    await expect(page.getByRole("button", { name: "Resolve this placeholder." })).toBeVisible();
    const source = page.getByRole("textbox", { name: "quote.ts" });
    await source.press("ControlOrMeta+Home");
    await source.press("Control+ArrowRight");
    await source.press("Control+ArrowRight");
    await source.press("ArrowRight");
    const pane = page.locator("#pane .st-editor");
    await pane.evaluate(element => window.scrollBy(0, element.getBoundingClientRect().top + 85));
    expect(await pane.evaluate(element => element.getBoundingClientRect().top)).toBeLessThan(-80);
    await page.keyboard.press("F2");
    const rename = page.getByRole("dialog", { name: "Rename symbol" });
    const field = rename.getByRole("textbox", { name: "New name" });
    await expect(field).toHaveValue("accent");
    await expect(field).toBeFocused();
    await expect(field).toBeInViewport({ ratio: .99 });
    await field.press("Escape");
    await expect(source).toBeFocused();
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(field).toBeFocused();
    await field.fill("highlight");
    await field.press("Enter");
    await expect(rename).toBeHidden();
    await expect(source).toBeFocused();
    const code = page.locator("#pane .st-viewport-row");
    await expect(code.filter({ hasText: "export const highlight" })).toBeVisible();
    await expect(page.locator("#result")).toHaveText("Renamed");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(code.filter({ hasText: "export const accent" })).toBeVisible();
    await expect(page.locator("#result")).toBeEmpty();
});

test("a resolved reference link stays usable from its focused row", async ({ page }) => {
    let resolves = 0;
    const target = "file:///reference/prices.ts", other = "file:///reference/tax.ts";
    await page.routeWebSocket("**/lsp-fixture", client => {
        const server = client.connectToServer();
        server.onMessage(packet => client.send(packet));
        client.onMessage(packet => {
            const message = JSON.parse(packet.toString());
            if (message.method === "documentLink/resolve") resolves++;
            if (message.method !== "initialize") return server.send(packet);
            message.params.initializationOptions = {
                ...message.params.initializationOptions,
                fixtureModuleUris: [{ module: "prices", uri: target }, { module: "tax", uri: other }],
            };
            server.send(JSON.stringify(message));
        });
    });
    await page.goto("/reference/");
    const source = page.getByRole("textbox", { name: "quote.ts" });
    await source.press("Control+Home");
    await page.keyboard.insertText('import "prices";\nimport "tax";\n');
    await page.getByRole("button", { name: "Connect language server" }).click();
    await page.getByRole("button", { name: "Document links" }).click();
    await page.getByRole("button", { name: "Resolve prices", exact: true }).press("Enter");
    const result = page.locator("#result");
    await expect(result).toHaveText(target);
    await expect(page.getByRole("button", { name: "Resolved prices", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(result).toHaveText(other);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(result).toHaveText(target);
    expect(resolves).toBe(2);
});

test("reconnecting the reference host requires a fresh server command choice", async ({ page }) => {
    let session = 0;
    let disconnect: () => void;
    let lateReply: (() => void) | undefined;
    const executions: number[] = [];
    await page.routeWebSocket("**/lsp-fixture", client => {
        const connection = ++session;
        const server = client.connectToServer();
        disconnect = () => client.close({ code: 1011, reason: "Provider restart" });
        let heldId: number | undefined;
        server.onMessage(packet => {
            if (heldId !== undefined && JSON.parse(packet.toString()).id === heldId) {
                lateReply = () => client.send(packet);
            } else client.send(packet);
        });
        client.onMessage(packet => {
            const request = JSON.parse(packet.toString());
            if (request.method === "workspace/executeCommand") {
                executions.push(connection);
                if (connection === 2 && executions.length <= 2) heldId = request.id;
            }
            server.send(packet);
        });
    });
    await page.goto("/reference/");
    const connect = page.getByRole("button", { name: "Connect language server" });
    const run = page.getByRole("button", { name: "Run server command" });
    const command = page.getByRole("button", { name: "fixture.status" });
    await connect.click();
    await run.click();
    const previous = await command.elementHandle();
    disconnect!();
    await connect.click();
    await expect(run).toBeVisible();
    await expect(command).toHaveCount(0);
    await previous!.evaluate(node => (node as HTMLButtonElement).click());
    await previous!.dispose();
    await run.click();
    await command.click();
    await expect.poll(() => !!lateReply).toBe(true);
    const source = page.getByRole("textbox", { name: "quote.ts" });
    await source.press("ArrowRight");
    await expect(page.getByText("Server command running…")).toBeVisible();
    lateReply!();
    await expect(page.locator("#result")).toHaveText("Command completed");
    lateReply = undefined;
    await run.click();
    await command.click();
    await expect.poll(() => !!lateReply).toBe(true);
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    const working = page.getByRole("textbox", { name: "Comparison working source" });
    const reconnect = page.getByRole("button", { name: "Reconnect language server", exact: true });
    await expect(reconnect).toBeEnabled();
    await expect(run).toBeDisabled();
    await working.press("Control+End");
    const original = await working.inputValue();
    await page.keyboard.type("X");
    await expect(working).toHaveValue(original + "X");
    lateReply!();
    await expect(run).toBeEnabled();
    await expect(command).toHaveCount(0);
    expect(executions).toEqual([2, 2]);
    await run.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(command).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#result")).toHaveText("Command completed");
    await page.keyboard.press("Enter");
    await page.keyboard.type("X");
    await expect(working).toHaveValue(original + "X\nX");
    await expect(page.getByRole("textbox", { name: "Comparison baseline source" })).toHaveValue(original);
    expect(executions).toEqual([2, 2, 2]);
});

test("two reference hosts review a competing save before replacing it", async ({ page }) => {
    await page.goto("/reference/");
    await page.evaluate(() => {
        const other = document.createElement("iframe");
        other.title = "Second host";
        other.src = "/reference/";
        document.body.append(other);
    });
    const other = page.frameLocator('iframe[title="Second host"]');
    const firstSource = page.getByRole("textbox", { name: "quote.ts" });
    const secondSource = other.getByRole("textbox", { name: "quote.ts" });
    const secondSave = other.getByRole("button", { name: "Save for this tab" });
    const stored = () => page.evaluate(() => sessionStorage.getItem("sttropez.reference.quote"));
    await firstSource.press("Control+Home");
    await page.keyboard.insertText("// My draft\n");
    const draft = await firstSource.inputValue();
    const caret = await firstSource.evaluate(node => (node as HTMLTextAreaElement).selectionStart);
    await secondSource.press("Control+Home");
    await page.keyboard.insertText("// Saved elsewhere\n");
    await secondSave.click();
    const competing = await stored();
    expect(competing).toMatch(/^\/\/ Saved elsewhere/);
    await page.keyboard.type("x");
    await expect(secondSource).toHaveValue(/^\/\/ Saved elsewhere\nx/);

    await firstSource.press("ControlOrMeta+s");
    const baseline = page.getByRole("textbox", { name: "Comparison baseline source" });
    const working = page.getByRole("textbox", { name: "Comparison working source" });
    const overwrite = page.getByRole("button", { name: "Save reviewed working copy" });
    await expect(baseline).toHaveValue(competing!);
    await expect(working).toHaveValue(draft);
    await baseline.press("ControlOrMeta+s");
    expect(await stored()).toBe(competing);

    await secondSource.press("Control+a");
    await secondSource.press("Backspace");
    await other.getByRole("button", { name: "Changes", exact: true }).click();
    const secondBaseline = other.getByRole("textbox", { name: "Comparison baseline source" });
    await secondBaseline.focus();
    await secondSave.press("Enter");
    await expect(secondBaseline).toBeFocused();
    await page.keyboard.type("x");
    await expect(other.getByRole("textbox", { name: "Comparison working source" })).toHaveValue("");
    await overwrite.click();
    await expect(baseline).toHaveValue("");
    expect(await stored()).toBe("");
    await expect(working).toHaveValue(draft);
    await expect(working).toBeFocused();
    await expect(overwrite).toBeEnabled();
    await overwrite.focus();
    await page.keyboard.press("Enter");
    await expect(overwrite).toBeHidden();
    await expect(page.locator("#saved")).toHaveText("Saved");
    await expect(working).toBeFocused();
    await page.keyboard.type("x");
    await expect(working).toHaveValue(draft.slice(0, caret) + "x" + draft.slice(caret));
    expect(await stored()).toBe(draft);
    await page.reload();
    await expect(firstSource).toHaveValue(draft);
});

test("Save captures the completed edit and Changes can undo it in the reference host", async ({ page }) => {
    await page.goto("/reference/");
    const source = page.getByRole("textbox", { name: "quote.ts" });
    const save = page.getByRole("button", { name: "Save for this tab" });
    const changes = page.getByRole("button", { name: "Changes", exact: true });
    const lines = 40_000;
    const text = "0\n".repeat(lines);
    await source.press("Control+a");
    await page.keyboard.insertText(text);
    await save.click();
    expect(await warnsBeforeUnload(page)).toBe(false);
    await source.press("Control+a");
    await page.keyboard.press("Control+/");
    expect(await warnsBeforeUnload(page)).toBe(true);
    await page.keyboard.press("ControlOrMeta+s");
    expect(await warnsBeforeUnload(page)).toBe(false);
    const commented = "// 0\n".repeat(lines);
    expect(await page.evaluate(() => sessionStorage.getItem("sttropez.reference.quote"))).toBe(commented);
    await changes.click();
    const working = page.getByRole("textbox", { name: "Comparison working source" });
    await expect(working).toBeFocused();
    await working.press("Control+z");
    await page.getByRole("textbox", { name: "Comparison baseline source" }).press("ControlOrMeta+s");
    expect(await page.evaluate(() => sessionStorage.getItem("sttropez.reference.quote"))).toBe(text);
});

test("returning to Changes restores the saved view and layout across working edits", async ({ page }) => {
    await page.goto("/reference/");
    const changes = page.getByRole("button", { name: "Changes", exact: true });
    const source = page.getByRole("button", { name: "Source", exact: true });
    const save = page.getByRole("button", { name: "Save for this tab" });
    await save.click();
    await changes.click();
    const panes = page.locator(".st-comparison-panes > section");
    const baseline = panes.first().getByRole("textbox");
    const working = panes.last().getByRole("textbox");
    const link = page.getByLabel("Link review scrolling");
    const align = page.getByLabel("Align review rows");
    await link.check();
    await align.check();
    await panes.first().getByRole("button", { name: /Collapse lines/ }).first().click();
    await baseline.press("Control+Home");
    await baseline.press("End");
    await baseline.press("Shift+Home");
    const selection = () => baseline.evaluate((field: HTMLTextAreaElement) =>
        [field.value.slice(field.selectionStart, field.selectionEnd), field.selectionDirection]);
    const original = await selection();
    expect(original).toEqual(['export const accent = "#5fae99";', "backward"]);

    await source.click();
    const input = page.getByRole("textbox", { name: "quote.ts" });
    await input.press("Control+End");
    await page.keyboard.insertText("// later edit");
    await input.press("Control+z");
    await save.click();
    await input.press("Control+y");
    await changes.click();
    await expect(working).toBeFocused();
    await expect.poll(selection).toEqual(original);
    await expect(panes.first().locator(".st-fold-summary")).toBeVisible();
    await expect(panes.last().locator(".st-fold-summary")).toHaveCount(0);
    await expect(link).toBeChecked();
    await expect(align).toBeChecked();

    await link.uncheck();
    await source.click();
    await save.click();
    await changes.click();
    await expect(baseline).toHaveValue(/later edit$/);
    await expect(baseline).toHaveJSProperty("selectionEnd", 0);
    await expect(panes.first().locator(".st-fold-summary")).toHaveCount(0);
    await expect(link).not.toBeChecked();
    await expect(align).toBeChecked();
});

test("the reference app edits, reviews and saves the document while its language tools follow the working view", async ({ page }) => {
    await page.goto("/reference/");
    const source = page.getByRole("textbox", { name: "quote.ts" });
    await expect(page.locator("#pane .st-minimap")).toBeVisible();
    const fold = page.getByRole("button", { name: /Collapse lines/ }).first();
    await fold.click();
    await expect(page.locator(".st-fold-summary")).toBeVisible();
    await page.getByRole("button", { name: /Expand lines/ }).first().click();
    await page.getByRole("button", { name: "Connect language server" }).click();
    await expect(page.getByRole("button", { name: "Resolve this placeholder." })).toBeVisible();
    await source.press("Control+Home");
    await page.keyboard.type("// Review this quote");
    await source.press("Enter");
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    const working = page.getByRole("textbox", { name: "Comparison working source" });
    await expect(working).toBeFocused();
    await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    await expect(page.locator(".st-comparison-controls output")).toHaveText(/1 change|Change 1 of 1/);
    await expect(page.locator(".st-comparison-added").first()).toContainText("Review this quote");
    const baseline = page.getByRole("textbox", { name: "Comparison baseline source" });
    const quickFix = page.getByRole("button", { name: "Code actions", exact: true });
    const draft = await working.inputValue();
    await baseline.press("Control+Home");
    await baseline.press("Shift+ArrowRight");
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await page.keyboard.type("X");
    await expect(working).toHaveValue(draft);
    await expect(baseline).toHaveJSProperty("selectionStart", 0);
    await expect(baseline).toHaveJSProperty("selectionEnd", 1);
    await expect(quickFix).toBeDisabled();
    await quickFix.click({ force: true });
    await expect(page.getByRole("region", { name: "Quick fixes" })).toBeHidden();
    await expect(baseline).toBeFocused();
    await working.focus();
    await expect(quickFix).toBeEnabled();
    await page.getByRole("button", { name: "Hover", exact: true }).click();
    const hover = page.locator("#pane .st-hover:visible");
    await expect(hover).toContainText("file:///reference/quote.ts");
    await expect(working).toBeFocused();
    await working.press("Escape");
    await expect(hover).toHaveCount(0);
    await working.press("Control+k");
    await working.press("Control+i");
    await expect(hover).toContainText("file:///reference/quote.ts");
    await working.press("Control+End");
    await page.keyboard.insertText("\nlookup(");
    await page.getByRole("button", { name: "Signature", exact: true }).click();
    const signature = page.getByRole("tooltip", { name: "Signature help" });
    const parameter = signature.getByLabel("Active signature parameter");
    await expect(parameter).toHaveText("key: string");
    await signature.getByRole("button", { name: "Next signature" }).click();
    await expect(parameter).toHaveText("keys: readonly string[]");
    await expect(working).toBeFocused();
    await working.press("Escape");
    await expect(signature).toBeHidden();
    await working.press("Control+z");
    await working.press("Control+Home");
    await page.keyboard.type("// Approved ");
    await working.press("ControlOrMeta+s");
    await expect(page.locator("#saved")).toHaveText("Saved");
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await expect(source).toBeFocused();
    await page.reload();
    await expect(page.locator("#pane .st-viewport-row").first()).toHaveText("// Approved // Review this quote");
});
