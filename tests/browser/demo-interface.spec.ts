import { demoSample } from "../../examples/demo/samples.ts";
import { latch } from "../helpers/latch.ts";
import { moveEditorIntoShadow } from "../helpers/shadow-editor.ts";
import { expect, expectPanelKeyReserved, test, warnsBeforeUnload } from "./fixtures.ts";
import { dragBundleScrollbars, hoverString, selectInsideString } from "./demo-minified.ts";
import { checkDemoLigatures } from "./demo-ligatures.ts";
import { paintedCharacter } from "../helpers/painted-character.ts";
import type { Locator, Page } from "@playwright/test";

function browserDemo(baseURL: string) {
    return new URL("/", baseURL).href;
}

async function openRows(page: Page, url: string) {
    await page.goto(url);
    await page.locator("#sample").selectOption("large");
    return page.getByRole("textbox", { name: "large.ts", exact: true });
}

function copyOutput(reader: Locator) {
    return reader.evaluate(node => {
        const event = new ClipboardEvent("copy", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
        node.dispatchEvent(event);
        return event.defaultPrevented ? event.clipboardData!.getData("text/plain") : null;
    });
}

test("dragging across emitted JavaScript copies both lines and preserves the selection on re-emit", async ({ page, baseURL }) => {
    const url = new URL(browserDemo(baseURL!)); url.searchParams.set("sample", "shipping"); await page.goto(url.href);
    const output = page.getByRole("region", { name: "JavaScript output", exact: true });
    const reader = output.getByRole("textbox"), rows = output.locator(".st-viewport-row");
    const start = await paintedCharacter(rows.filter({ hasText: "// Rates are in cents." }), "Rates", 0);
    const end = await paintedCharacter(rows.filter({ hasText: "const services = [" }), "services", 7);
    await page.mouse.move(start.x - 2, start.y); await page.mouse.down();
    await page.mouse.move(end.x + 2, end.y, { steps: 12 }); await page.mouse.up();
    await expect(reader).toBeFocused(); await expect(reader).toHaveJSProperty("readOnly", true);
    const selected = "Rates are in cents. The base charge covers the first kilogram.\nconst services";
    expect(await copyOutput(reader)).toBe(selected);
    const outputLine = Number(await rows.filter({ hasText: "const services = [" }).getAttribute("data-line")) + 1;
    await expect(page.locator("#cursor")).toHaveText(`Ln ${outputLine}, Col 15`);
    const status = page.locator("#status");
    const source = page.getByRole("textbox", { name: "shipping.ts", exact: true });
    const original = await source.inputValue();
    await page.locator("#code-menu summary").click();
    await expect(page.getByRole("button", { name: "Collapse group", exact: true })).toBeDisabled();
    await expect(page.locator("#fold-group")).toBeDisabled();
    await page.locator("#indentation").selectOption("4");
    await expect(reader).toBeFocused();
    await page.getByRole("button", { name: "Save locally", exact: true }).click();
    await expect(status).toContainText("Saved in this browser");
    await expect(reader).toBeFocused();
    const projectStatus = await status.innerText();
    await page.getByRole("button", { name: "JavaScript", exact: true }).click();
    await page.keyboard.press("Delete");
    await expect(status).toHaveText("Generated JavaScript is read-only. Edit the TypeScript source.");
    await page.keyboard.type("X");
    expect(await copyOutput(reader)).toBe(selected);
    await expect(source).toHaveValue(original);
    await source.press("Control+Home");
    await expect(status).toHaveText(projectStatus);
    await page.keyboard.insertText("const recompiled = true;\n");
    await expect(rows.first()).toHaveText("const recompiled = true;");
    expect(await copyOutput(reader)).toBe(selected); await expect(source).toBeFocused();
    await expect(page.locator("#cursor")).toHaveText("Ln 2, Col 1");
    const oldInput = await reader.elementHandle();
    await page.getByRole("button", { name: "Problems", exact: true }).click(); await expect(reader).toHaveCount(0);
    expect(await oldInput!.evaluate(node => node.dispatchEvent(new ClipboardEvent("copy", { clipboardData: new DataTransfer(), cancelable: true })))).toBe(true);
    await oldInput!.dispose();
});

test("resizing Changes keeps both editors and the selected change preview within the panel", async ({ page, baseURL }) => {
    await page.goto(browserDemo(baseURL!));
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+Home"); await page.keyboard.insertText("// Review this change\n");
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await page.getByRole("button", { name: "Next change", exact: true }).click();
    const panel = page.locator("#panel-content");
    await expect(panel.locator(".st-comparison-preview")).toBeVisible();
    const panes = panel.locator(".st-viewport"), working = page.getByRole("textbox", { name: "Comparison working source" });
    for (const [width, height] of [[1920, 1080], [1280, 360], [680, 900], [375, 600]] as const) {
        await page.setViewportSize({ width, height });
        await expect.poll(() => panel.evaluate(root => {
            const comparison = root.querySelector(".st-comparison")!;
            const preview = comparison.querySelector(".st-comparison-preview")!, box = preview.getBoundingClientRect();
            const panes = [...comparison.querySelectorAll(".st-viewport")];
            const [left, right] = panes.map(pane => pane.getBoundingClientRect());
            const labels = [...root.querySelectorAll(".demo-review-labels > span:not(.demo-review-hint)")];
            const gap = parseFloat(getComputedStyle(comparison).rowGap);
            return {
                outerScroll: root.scrollHeight - root.clientHeight,
                fillsHeight: Math.abs(box.top - right!.bottom - gap) < 1,
                stacked: right!.top >= left!.bottom,
                captions: labels.map((label, i) => {
                    const caption = label.getBoundingClientRect(), pane = panes[i]!.getBoundingClientRect();
                    return right!.top >= left!.bottom ? Math.abs(caption.bottom - pane.top) < 1 && Math.abs(caption.left - pane.left) < 1
                        : caption.bottom <= pane.top && caption.left + caption.width / 2 > pane.left && caption.left + caption.width / 2 < pane.right;
                }),
                twoLinesFit: panes.every(pane => {
                    const row = pane.querySelector(".st-viewport-row")?.getBoundingClientRect();
                    return row && row.height > 0 && pane.clientHeight >= 2 * row.height;
                }),
                previewHit: preview.contains(document.elementFromPoint(box.left + box.width / 4, box.top + box.height / 2)),
                panesHit: panes.map(pane => { const p = pane.getBoundingClientRect();
                    return pane.contains(document.elementFromPoint(p.left + p.width / 2, p.bottom - 2)); })
            };
        }), `Changes at ${width} × ${height}`).toEqual({
            outerScroll: 0, fillsHeight: true, stacked: width <= 700, captions: [true, true], twoLinesFit: true, previewHit: true, panesHit: [true, true]
        });
        const heights = () => panes.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
        const changed = await heights();
        await working.press("Control+Home"); await working.press("ArrowDown"); await working.press("ArrowDown");
        await expect(panel.locator(".st-comparison-preview span")).toBeVisible();
        expect(await heights()).toEqual(changed);
        await page.getByRole("button", { name: "Next change", exact: true }).click();
        await expect(panel.locator(".st-comparison-preview pre").first()).toBeVisible();
        expect(await heights()).toEqual(changed);
    }
});

test("clearing the working review keeps line one aligned through typing and undo", async ({ page, baseURL }) => {
    await page.goto(browserDemo(baseURL!)); await page.locator("#compare").click();
    const panes = page.locator(".st-comparison-panes > section"), working = panes.last();
    const input = working.locator("textarea"), row = working.locator('.st-viewport-row[data-line="0"]');
    const reference = panes.first().locator('.st-viewport-row[data-line="0"]');
    await input.press("Control+a"); await input.press("Delete");
    const aligned = async (expected: string) => {
        await expect(row).toHaveText(expected);
        await expect(working.locator(".st-comparison-padding").first()).toBeAttached();
        await expect.poll(async () => Math.abs((await row.boundingBox())!.y - (await reference.boundingBox())!.y)).toBeLessThan(1);
        await expect(input).toBeFocused();
    };
    await aligned("");
    await page.keyboard.type("x"); await aligned("x");
    await input.press("Control+z"); await aligned("");
});

test("deleting the first working lines leaves the removed lines visible in the saved pane", async ({ page, baseURL }) => {
    const url = new URL(browserDemo(baseURL!)); url.searchParams.set("sample", "shipping"); await page.goto(url.href);
    await page.locator("#compare").click();
    const panes = page.locator(".st-comparison-panes .st-viewport"), saved = panes.first();
    const input = page.getByRole("textbox", { name: "Comparison working source" });
    await input.press("Control+Home"); await input.press("Shift+ArrowDown"); await input.press("Shift+ArrowDown");
    await input.press("Delete");
    const removed = saved.locator('.st-comparison-line-baseline:is([data-line="0"], [data-line="1"])');
    await expect(removed).toHaveCount(2); await expect(panes.last().locator(".st-comparison-padding").first()).toBeAttached();
    const tops = () => panes.evaluateAll(nodes => nodes.map(node => node.scrollTop));
    await expect.poll(tops).toEqual([0, 0]);
    await expect.poll(() => removed.evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().top >= node.closest(".st-viewport")!.getBoundingClientRect().top))).toBe(true);
    await input.press("Control+z"); await expect(page.locator(".st-comparison-controls output")).toHaveText("No changes");
    expect(await tops()).toEqual([0, 0]);
    await input.press("ArrowLeft"); await page.keyboard.type("!");
    await expect(panes.last().locator('.st-viewport-row[data-line="0"]')).toContainText("!");
});

test("hiding Changes keeps the review panes and resumes from edits made while hidden", async ({ page, baseURL }) => {
    const url = new URL(browserDemo(baseURL!)); url.searchParams.set("sample", "shipping"); await page.goto(url.href);
    const source = page.getByRole("region", { name: "Source code" }).getByRole("textbox");
    const original = Array.from({ length: 120 }, (_, i) => `// row ${i} ${"abcdef ".repeat(24)}`).join("\n");
    await source.press("Control+a"); await page.keyboard.insertText(original);
    await page.getByRole("button", { name: "Save locally", exact: true }).click();
    await source.press("Control+a"); await page.keyboard.insertText(original.replace("row 20 ", "row twenty ").replace("row 40 ", "row forty "));
    await source.press("Control+Home"); await page.getByRole("button", { name: "Changes", exact: true }).click();
    const next = page.getByRole("button", { name: "Next change", exact: true });
    const panes = page.locator(".st-comparison-panes .st-viewport"), status = page.locator(".st-comparison-controls output");
    const working = page.getByRole("textbox", { name: "Comparison working source" }), saved = page.getByRole("textbox", { name: "Comparison baseline source" });
    const toggle = page.locator("#panel-collapse");
    await next.click(); await saved.focus(); await expect(status).toHaveText("Change 1 of 2");
    const originalInput = await working.elementHandle();
    await panes.evaluateAll(nodes => { nodes[0]!.scrollLeft = 160; nodes[1]!.scrollLeft = 820; });
    const positions = () => panes.evaluateAll(nodes => nodes.map(node => [node.scrollLeft, node.scrollTop]));
    await expect.poll(positions).toMatchObject([[160, expect.any(Number)], [820, expect.any(Number)]]);
    const before = await positions();
    await toggle.click(); await expect(working).toBeFocused(); await expect(saved).toBeHidden(); await expect(next).toBeHidden();
    await toggle.click(); await expect(saved).toBeFocused(); await expect(status).toHaveText("Change 1 of 2");
    await expect.poll(positions).toEqual(before);
    await next.click(); await expect(status).toHaveText("Change 2 of 2");
    await toggle.click(); await expect(working).toBeFocused();
    await working.press("Control+End"); await page.keyboard.insertText("\n// typed while hidden");
    await toggle.click(); await expect(working).toBeFocused(); await expect(status).toHaveText(/3 of 3|3 changes/);
    await expect(working).toHaveValue(/typed while hidden$/);
    expect(await originalInput!.evaluate(input => input.isConnected)).toBe(true); await originalInput!.dispose();
    await next.click(); await expect(status).toHaveText("Change 1 of 3");
    await toggle.click(); await page.getByRole("button", { name: "Save locally", exact: true }).click();
    await expect(status).toHaveText("No changes");
    await page.locator("#compare").click();
    await expect(status).toBeVisible(); await expect(status).toHaveText("No changes"); await expect(next).toBeDisabled();

    await page.locator("#sample").selectOption("outline");
    await expect(page.getByRole("group", { name: "Changes in workflow.txt" })).toBeVisible();
    await saved.focus();
    await toggle.click();
    await page.getByRole("button", { name: "Collapse lines 16–17", exact: true }).click();
    await toggle.click();
    await expect(working).toBeFocused();
    await page.keyboard.type("X");
    await expect(panes.last().locator('.st-viewport-row[data-line="0"]')).toHaveText("X#region workflow");
    await expect(panes.first().locator('.st-viewport-row[data-line="0"]')).toHaveText("#region workflow");
});

test("narrow layouts keep JavaScript, Problems and review reachable from the keyboard", async ({ page, baseURL }) => {
    await page.goto(browserDemo(baseURL!));
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    const reader = page.getByRole("textbox", { name: "JavaScript output", exact: true });
    const tabs = page.locator("#panels"), js = tabs.locator('[data-panel="javascript"]'), problems = tabs.locator('[data-panel="problems"]');
    const changes = tabs.getByRole("button", { name: "Changes", exact: true }), toggle = tabs.locator("#panel-collapse");
    const cursor = page.locator("#cursor");
    await source.press("Control+Home"); await source.press("ArrowRight"); await expect(cursor).toHaveText("Ln 1, Col 2");
    for (const width of [850, 375]) {
        await page.setViewportSize({ width, height: 820 });
        await expect(source).toBeFocused(); await expect(cursor).toHaveText("Ln 1, Col 2");
        await expect.poll(() => page.evaluate(() => {
            const reachable = (el: Element) => {
                const b = el.getBoundingClientRect();
                return b.height >= 20 && b.width > 0 && el.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2));
            };
            return document.documentElement.scrollWidth <= innerWidth
                && [...document.querySelectorAll("#panels button, #editor .st-viewport, .demo-output")].every(reachable);
        })).toBe(true);
    }
    await reader.press("Control+Home"); await reader.press("ArrowDown"); await expect(cursor).toHaveText("Ln 2, Col 1");
    await page.setViewportSize({ width: 1280, height: 820 }); await expect(reader).toBeFocused();
    await page.setViewportSize({ width: 375, height: 820 }); await expect(cursor).toHaveText("Ln 2, Col 1");
    await toggle.click(); await expect(source).toBeFocused(); await expect(cursor).toHaveText("Ln 1, Col 2");
    await js.focus(); await expectPanelKeyReserved(js, "ArrowRight");
    await js.press("ArrowRight"); await expect(problems).toBeFocused(); await problems.press("Enter");
    await expect(problems).toHaveAttribute("aria-pressed", "true"); await expect(page.locator("#panel-content")).toContainText(/problem|diagnostic/i);
    await problems.focus(); await problems.press("End"); await expect(changes).toBeFocused(); await changes.press("Space");
    const working = page.getByRole("textbox", { name: "Comparison working source" });
    await expect(working).toBeFocused(); await toggle.click(); await page.keyboard.insertText("x"); await expect(working).toHaveValue(/^ixmport/);
    await js.click(); await expect(reader).toBeVisible(); await expect(source).toHaveValue(/^ixmport/);
    const files = page.locator("#files [data-file]");
    await files.first().focus(); await files.first().press("End"); await expect(files.last()).toBeFocused();
    await files.last().press("Enter"); await expect(files.last()).toHaveAttribute("aria-pressed", "true");
});

test("short windows keep the caret and the next edit on screen in wide and stacked layouts", async ({ page, baseURL }) => {
    const url = new URL(browserDemo(baseURL!)); url.searchParams.set("sample", "shipping");
    const source = page.getByRole("textbox", { name: "shipping.ts", exact: true });
    const output = page.getByRole("region", { name: "JavaScript output", exact: true });
    const cursor = page.locator("#cursor");
    const caretOnScreen = (pane: Locator) => pane.locator(".st-input-caret").evaluate(caret => {
        const rect = caret.getBoundingClientRect();
        return rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight && scrollY === 0;
    });
    for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 360 }); await page.goto(url.href);
        await source.press("Control+Home");
        for (let i = 0; i < 30; i++) await source.press("ArrowDown");
        await expect(cursor).toContainText("Ln 31,");
        const editor = page.locator("#editor");
        await expect.poll(() => caretOnScreen(editor)).toBe(true);
        await source.press("Home"); await page.keyboard.insertText("// short ");
        await expect(editor.locator('.st-viewport-row[data-line="30"]')).toContainText("// short ");
        const reader = output.getByRole("textbox");
        await reader.press("Control+Home"); await reader.press("ArrowDown");
        await expect(cursor).toHaveText("Ln 2, Col 1");
        await expect.poll(() => caretOnScreen(output)).toBe(true);
        await expect(output.locator('.st-viewport-row[data-line="1"]')).toContainText(/\S/);
    }
});

function visibleContext(viewport: Locator, line: number) {
    return viewport.evaluate((view, line) => {
        const row = view.querySelector(`.st-viewport-row[data-line="${line}"]`);
        if (!row) return 0;
        const bounds = row.getBoundingClientRect(), top = view.getBoundingClientRect().top;
        return Math.min(bounds.top - top, top + view.clientHeight - bounds.bottom) / view.clientHeight;
    }, line);
}

test("Go to line returns typing to the chosen row and cancels when the source view closes", async ({ page, baseURL }) => {
    await page.goto(browserDemo(baseURL!)); await page.locator("#sample").selectOption("results");
    const source = page.getByRole("textbox", { name: "uses.ts", exact: true });
    await source.press("Control+g");
    const dialog = page.getByRole("dialog", { name: "Go to line" }), line = dialog.getByRole("textbox");
    await line.pressSequentially("12:5");
    await line.press("Enter");
    await expect(line).toHaveValue("12:5");
    await expect(line).toBeFocused();
    expect(await line.evaluate(node => (node as HTMLInputElement).validity.customError)).toBe(true);
    await expect(page.locator("#cursor")).toHaveText("Ln 1, Col 1");
    await line.fill("501"); await line.press("Enter"); await expect(source).toBeFocused();
    const viewport = source.locator("..");
    await expect.poll(() => visibleContext(viewport, 500)).toBeGreaterThan(.35);
    const top = await viewport.evaluate(view => view.scrollTop);
    await source.press("Control+g"); await line.fill("500"); await line.press("Enter"); await expect(source).toBeFocused();
    await page.keyboard.type("// "); await expect(page.locator("#cursor")).toHaveText("Ln 500, Col 4");
    expect(await viewport.evaluate(view => view.scrollTop)).toBe(top);
    await expect(page.locator("#editor .st-viewport-row").filter({ hasText: "// const use498" })).toBeVisible();
    await source.press("Control+g"); await line.fill("123");
    await dialog.getByRole("button", { name: "Go", exact: true }).press("Control+g");
    await expect(line).toBeFocused(); await page.keyboard.type("8"); await expect(line).toHaveValue("8");
    const target = await viewport.boundingBox();
    await page.mouse.click(target!.x + 18, target!.y + 20); await expect(dialog).toHaveCount(0);
    await expect(source).toBeFocused(); await page.keyboard.type("7");
    await expect(page.locator("#editor .st-viewport-row").filter({ hasText: "// 7const use498" })).toBeVisible();
    await page.locator("#compare").click();
    const saved = page.getByRole("textbox", { name: "Comparison baseline source", exact: true });
    await saved.press("Control+g"); await line.fill("20"); await line.press("Enter"); await expect(saved).toBeFocused();
    const cursor = page.locator("#cursor");
    await expect(cursor).toHaveText("Ln 20, Col 1");
    await saved.press("ArrowRight"); await expect(cursor).toHaveText("Ln 20, Col 2");
    await page.getByRole("textbox", { name: "Comparison working source", exact: true }).focus();
    await expect(cursor).toHaveText("Ln 500, Col 5");
    await saved.press("Control+g"); await expect(line).toHaveValue("20");
    // A host can change files while its own prompt is open.
    await page.locator('[data-panel="javascript"]').evaluate(button => (button as HTMLButtonElement).click());
    await expect(dialog).toHaveCount(0); await expect(source).toBeVisible();
    await expect(cursor).toHaveText("Ln 500, Col 5");
});

test("off-screen Undo and Redo reveal surrounding code and retain the typing target in source and review", async ({ page, baseURL }) => {
    const url = new URL(browserDemo(baseURL!)); url.searchParams.set("sample", "results");
    for (const mode of ["source", "review"]) {
        await page.goto(url.href);
        if (mode === "review") {
            await page.locator("#compare").click();
            await expect(page.locator(".st-comparison-controls output")).toHaveText("No changes");
        }
        const pane = mode === "source" ? page.locator("#editor") : page.locator(".st-comparison-panes > section").last();
        const source = pane.getByRole("textbox"), viewport = pane.locator(".st-viewport");
        const row = pane.locator('.st-viewport-row[data-line="499"]'), cursor = page.locator("#cursor");
        await source.press("Control+g"); const line = page.getByRole("dialog", { name: "Go to line" }).getByRole("textbox");
        await line.fill("500"); await line.press("Enter");
        await page.keyboard.insertText("X"); await expect(row).toContainText("Xconst use");
        for (const [jump, history, column] of [["Home", "z", 1], ["End", "y", 2]] as const) {
            await source.press(`Control+${jump}`); await expect(row).toHaveCount(0);
            await source.press(`Control+${history}`); await expect(cursor).toHaveText(`Ln 500, Col ${column}`); await expect(source).toBeFocused();
            await expect.poll(() => visibleContext(viewport, 499)).toBeGreaterThan(.35);
        }
        await page.keyboard.insertText("Z"); await expect(row).toContainText("XZconst use");
        const scroll = await viewport.evaluate(node => { node.scrollTop += 60; return node.scrollTop; });
        await source.press("Control+z"); await expect(row).toContainText("Xconst use");
        expect(await viewport.evaluate(node => node.scrollTop)).toBe(scroll);
    }
});

test("Find toggles regex on the existing query and replaces captured groups in one undo", async ({ page, baseURL }) => {
    await page.goto(browserDemo(baseURL!));
    const query = page.getByRole("textbox", { name: "Find text" }), mode = page.getByRole("button", { name: "Use regular expression" });
    const status = page.locator(".st-find-status"), replaceAll = page.getByRole("button", { name: "Replace all" });
    const previous = page.getByRole("button", { name: "Previous match", exact: true }), next = page.getByRole("button", { name: "Next match", exact: true });
    const source = page.getByRole("textbox", { name: "main.ts", exact: true }), pattern = String.raw`quantity:\s*(\d+)`;
    await source.press("Control+f"); await query.fill(pattern);
    await expect(mode).toHaveAttribute("aria-pressed", "false"); await expect(status).toHaveText("No matches");
    await expect(previous).toBeDisabled(); await expect(next).toBeDisabled();
    await mode.press("Enter"); await expect(mode).toHaveAttribute("aria-pressed", "true"); await expect(query).toBeFocused();
    await expect(status).toHaveText("2 matches");
    await expect(previous).toBeEnabled(); await expect(next).toBeEnabled();
    await expect(page.locator("#editor .st-viewport-row").filter({ has: page.locator(".st-search-match") })).toHaveCount(2);
    const selected = () => source.evaluate(node => { const input = node as HTMLTextAreaElement; return input.value.slice(input.selectionStart, input.selectionEnd); });
    await page.keyboard.press("Enter"); await expect.poll(selected).toBe("quantity: 2"); await expect(query).toBeFocused();
    await expect(status).toHaveText("1 of 2");
    await query.dispatchEvent("keydown", { key: "Enter", repeat: true });
    await expect(status).toHaveText("1 of 2");
    await page.keyboard.press("Shift+Enter"); await expect.poll(selected).toBe("quantity: 4"); await expect(query).toBeFocused();
    await expect(status).toHaveText("2 of 2 · Wrapped to end");
    await query.press("Enter"); await expect(status).toHaveText("1 of 2 · Wrapped to start");
    await page.locator(".st-replace-toggle").click();
    const close = page.locator(".st-find-close");
    const closeBefore = await close.boundingBox();
    await query.fill("(");
    await expect(status).toHaveText(/^Invalid regular expression: .*(group|parenthe|missing \))/i);
    await expect(query).toHaveAttribute("aria-invalid", "true");
    expect(await close.boundingBox()).toEqual(closeBefore);
    await status.click();
    await expect(query).toBeFocused();
    await expect(page.locator(".st-replace-current")).toBeDisabled(); await expect(replaceAll).toBeDisabled();
    await expect(replaceAll).toHaveAttribute("title", /Invalid regular expression/);
    await expect(next).toBeDisabled(); await expect(previous).toBeDisabled();
    await query.press("Enter"); expect(await selected()).toBe("quantity: 2"); await expect(query).toBeFocused();
    await query.fill(pattern); await expect(replaceAll).toBeEnabled();
    await expect(query).toHaveAttribute("aria-invalid", "false");
    await page.getByRole("textbox", { name: "Replacement text" }).fill("quantity: $1 + 1"); await replaceAll.click();
    await expect(page.locator("#editor")).toContainText("quantity: 4 + 1");
    await page.locator('[data-panel="changes"]').click();
    const panes = page.locator(".st-comparison-panes > section"), saved = panes.first(), working = panes.last();
    await expect(working).toContainText("quantity: 2 + 1"); await expect(working).toContainText("quantity: 4 + 1");
    await expect(saved).not.toContainText(" + 1"); await expect(mode).toHaveAttribute("aria-pressed", "true");
    await working.getByRole("textbox").press("Control+z");
    await expect(working).not.toContainText(" + 1"); await expect(working).toContainText("quantity: 2"); await expect(working).toContainText("quantity: 4");
    await mode.click(); await expect(status).toHaveText("No matches");
    await query.fill(""); await expect(status).toBeEmpty(); await expect(next).toBeDisabled(); await expect(previous).toBeDisabled();
    await query.press("Escape");
    const input = working.getByRole("textbox");
    await input.press("Control+Home"); await input.press("Shift+End"); await input.press("Control+f");
    const firstLine = 'import { calculateTotal } from "./pricing";';
    await expect(query).toHaveValue(firstLine); await expect(query).toBeFocused();
    await mode.click(); await query.press("Escape"); await input.press("Control+f");
    await expect(query).toHaveValue('import \\{ calculateTotal \\} from "\\./pricing";');
    await expect(status).toHaveText("1 of 1"); await query.press("Escape");
    await input.press("End"); await input.press("Control+f");
    await expect(query).toHaveValue('import \\{ calculateTotal \\} from "\\./pricing";');
});

test("typing with Find open keeps unaffected highlights and the count on screen", async ({ page, baseURL }) => {
    for (const [sample, query, rowText, count] of [["shipping", "number", "weightKg", 10], ["results", "sharedValue", "const use5 =", 1201]] as const) {
        const url = new URL(browserDemo(baseURL!)); url.searchParams.set("sample", sample); await page.goto(url.href);
        await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
        await page.locator("#find-toggle").click(); await page.locator(".st-find-query").fill(query);
        await expect(page.locator(".st-find-status")).toHaveText(new RegExp(`^(1 of ${count}|${count} matches)$`));
        const editor = page.locator("#editor"), row = editor.locator(".st-viewport-row").filter({ hasText: rowText }).first();
        await row.click({ position: { x: 30, y: 8 } });
        await page.keyboard.press("Home");
        const before = await editor.locator(".st-search-match").count(); expect(before).toBeGreaterThan(1);
        for (const key of ["a", "b", "c"]) {
            const paint = await page.evaluateHandle(() => ({ result: new Promise<{ marks: number; status: string }[]>(resolve => {
                document.addEventListener("beforeinput", () => {
                    const snapshot = () => ({ marks: document.querySelectorAll("#editor .st-search-match").length,
                        status: document.querySelector(".st-find-status")!.textContent! });
                    requestAnimationFrame(() => { const first = snapshot(); requestAnimationFrame(() => resolve([first, snapshot()])); });
                }, { once: true, capture: true });
            }) }));
            await page.keyboard.type(key);
            expect(await paint.evaluate(value => value.result)).toEqual(Array(2).fill({ marks: before, status: `${count} matches` }));
            await paint.dispose();
        }
        await expect(editor).toContainText("abc");
    }
});

test("clicking Replace keeps the next keystroke in the Find bar", async ({ page, baseURL }) => {
    await page.goto(browserDemo(baseURL!));
    const source = page.locator("#editor textarea"), query = page.locator(".st-find-query"), replacement = page.locator(".st-replacement");
    const status = page.locator(".st-find-status");
    await source.press("Control+Home"); await source.press("Control+f"); await page.locator(".st-find-regex").click();
    await query.fill(String.raw`quant\w+`); await expect(status).toHaveText("1 of 4");
    await page.locator(".st-find-next").click(); await expect(query).toBeFocused();
    await page.locator(".st-replace-toggle").click(); await expect(replacement).toBeFocused();
    await page.keyboard.type("qty"); await page.locator(".st-replace-current").click();
    await expect(status).toContainText("2 of 3"); await expect(replacement).toBeFocused();
    await page.keyboard.press("F3"); await expect(status).toHaveText("3 of 3");
    await page.locator(".st-find-previous").click(); await expect(replacement).toBeFocused();
    await page.keyboard.type("X"); await expect(replacement).toHaveValue("qtyX");
    await page.keyboard.press("Escape"); await expect(query).toBeHidden(); await expect(source).toBeFocused();
});

test("Find previews a folded match when its header is on screen", async ({ page, baseURL }) => {
    await page.goto(browserDemo(baseURL!));
    await page.locator("#sample").selectOption("shipping");
    const source = page.getByRole("textbox", { name: "shipping.ts", exact: true });
    const viewport = page.locator("#editor .st-viewport").first();
    const query = page.locator(".st-find-query"), status = page.locator(".st-find-status");
    const collapse = viewport.getByRole("button", { name: "Collapse lines 11–15" });
    await expect(collapse).toBeVisible({ timeout: 30000 });
    await collapse.click();
    await source.press("Control+Home");
    await source.press("Control+f");
    await query.fill("days");
    await expect(status).toHaveText("1 of 9");
    await expect(viewport.locator('[data-line="11"] .st-search-match')).toBeInViewport();
    await expect(page.locator("#cursor")).toHaveText("Ln 1, Col 1");
    await expect(query).toBeFocused();
    await query.press("Enter");
    await expect(status).toHaveText("2 of 9");
    await expect(page.locator("#cursor")).toHaveText("Ln 22, Col 13");

    await query.press("Escape");
    await source.press("Control+Home");
    await collapse.click();
    await source.press("Control+f");
    await query.fill("");
    await viewport.evaluate(root => { root.scrollTop = 24 * parseFloat(getComputedStyle(root).lineHeight); });
    await expect(viewport.locator('[data-line="35"]')).toBeInViewport();
    await query.fill("days");
    await expect(status).toHaveText(/[2-9] of 9/);
    await viewport.evaluate(root => { root.scrollTop = 0; });
    await expect(viewport.getByRole("button", { name: "Expand lines 11–15" })).toBeInViewport();
});

test("clearing Find returns to the caret and Escape keeps typing at the previewed match", async ({ page, baseURL }) => {
    await page.goto(browserDemo(baseURL!));
    await page.locator("#sample").selectOption("shipping");
    const source = page.getByRole("textbox", { name: "shipping.ts", exact: true });
    const query = page.locator(".st-find-query"), rows = page.locator("#editor .st-viewport-row");
    const first = rows.filter({ hasText: "type Zone" }), match = rows.filter({ hasText: "console.log" });
    await source.press("Control+Home"); await source.press("Control+f"); await query.fill("console");
    await expect(match).toBeInViewport(); await expect(first).not.toBeInViewport();
    await query.fill(""); await expect(first).toBeInViewport(); await expect(query).toBeFocused();
    await query.fill("console"); await expect(match).toBeInViewport();
    await query.press("Escape"); await expect(source).toBeFocused();
    await page.keyboard.type("logger"); await expect(rows.filter({ hasText: "logger.log" })).toBeInViewport();
    await source.press("Control+z"); await expect(match).toBeInViewport();
    await source.press("Control+f"); await query.fill("conso"); await query.press("Enter");
    await expect.poll(() => copyOutput(source)).toBe("conso");
    await query.press("End"); await query.pressSequentially("le.log");
    await expect.poll(() => copyOutput(source)).toBe("console.log"); await expect(query).toBeFocused();
    await query.press("Escape"); await page.keyboard.type("report");
    await expect(rows.filter({ hasText: "report(quote.name" })).toBeInViewport();
});

test("opening Find and Replace keeps the same code under the pointer", async ({ page, baseURL }) => {
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    const row = page.locator('#editor .st-viewport-row[data-line="0"]'), query = page.locator(".st-find-query");
    for (const [width, height] of [[1280, 700], [375, 700], [375, 360]] as const) {
        await page.setViewportSize({ width, height }); await page.goto(browserDemo(baseURL!));
        await source.press("Control+Home");
        const point = await paintedCharacter(row, "import", 2);
        const lineAtPoint = () => page.evaluate(pt =>
            document.elementFromPoint(pt.x, pt.y)?.closest("#editor .st-viewport-row")?.getAttribute("data-line"), point);
        await expect.poll(lineAtPoint).toBe("0");
        await source.press("Control+h");
        await expect(query).toBeFocused(); await page.keyboard.type("import");
        await expect(query).toHaveValue("import"); await expect(page.locator(".st-replacement")).toHaveValue("");
        await expect.poll(() => paintedCharacter(row, "import", 2)).toEqual(point);
        await expect.poll(lineAtPoint).toBe("0");
        await page.locator(".st-find-close").click(); await expect(query).toBeHidden();
        await page.mouse.click(point.x, point.y); await expect(source).toBeFocused();
        await page.keyboard.insertText("X"); await expect(row).toContainText(/imXp|impX/);
    }
});

test("multiline Find and Replace preserves line breaks, regex captures and one-step Undo", async ({ page, baseURL }) => {
    await page.goto(browserDemo(baseURL!));
    await page.locator("#sample").selectOption("host");
    await page.locator("#files").getByRole("button", { name: "inventory.csv", exact: true }).click();
    const source = page.getByRole("textbox", { name: "inventory.csv", exact: true });
    const original = "start\nitem 2\nend\nstart\nitem 4\nend";
    const raw = original.replaceAll("\n", "\r\n");
    await source.press("Control+a");
    await source.evaluate((el, text) => {
        const paste = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
        paste.clipboardData!.setData("text/plain", text); el.dispatchEvent(paste);
    }, raw);
    await expect(source).toHaveValue(original);
    await source.press("Control+a"); expect(await copyOutput(source)).toBe(raw); await source.press("Control+Home");
    const query = page.locator(".st-find-query"), status = page.locator(".st-find-status"), replacement = page.locator(".st-replacement");
    await source.press("Shift+End"); await source.press("Control+f");
    await expect(query).toBeFocused(); await expect(query).toHaveValue("start");
    await expect(status).toHaveText(/(of 2|2 matches)$/);
    await expect(page.locator("#editor .st-search-match").first()).toHaveText("start");
    await query.press("Control+a"); await page.keyboard.insertText("item 4\nend");
    await expect(query).toHaveValue("item 4\nend"); await expect(status).toHaveText("1 of 1");
    await query.press("Enter"); await expect(query).toBeFocused();
    await query.press("Control+h"); await expect(replacement).toBeFocused(); await expect(query).toHaveValue("item 4\nend");
    await replacement.fill("lastREMOVE");
    await replacement.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(4, 10));
    await replacement.press("Control+Enter");
    await replacement.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, repeat: true });
    await page.keyboard.insertText("line"); await expect(replacement).toHaveValue("last\nline");
    await expectPanelKeyReserved(replacement, "Enter");
    await replacement.dispatchEvent("keydown", { key: "Enter", repeat: true });
    await expect(source).toHaveValue(original); await expect(replacement).toHaveValue("last\nline");
    await replacement.press("Enter"); await expect(source).toHaveValue("start\nitem 2\nend\nstart\nlast\nline");
    const replace = page.locator(".st-replace-current");
    await expect(replace).toBeDisabled();
    await replace.click({ force: true });
    await expect(replacement).toBeFocused();
    await page.keyboard.type("!");
    await expect(replacement).toHaveValue("last\nline!");
    await page.keyboard.press("Escape"); await source.press("Control+z"); await expect(source).toHaveValue(original);
    await source.press("Control+h"); await page.locator(".st-find-regex").click();
    await query.fill("start\\r?\nitem (\\d)\\r?\nend"); await expect(status).toHaveText(/2 matches|of 2/);
    await replacement.fill("$1\\nnext\\\\n"); await page.locator(".st-replace-all").click();
    await expect(source).toHaveValue("2\nnext\\n\n4\nnext\\n");
    await source.press("Control+z"); await expect(source).toHaveValue(original);
    await source.press("Control+a"); expect(await copyOutput(source)).toBe(raw);
});

test("Find combines case and word boundaries and keeps the options across files", async ({ page, baseURL }) => {
    await page.goto(browserDemo(baseURL!));
    const query = page.getByRole("textbox", { name: "Find text" }), status = page.locator(".st-find-status");
    const caseButton = page.getByRole("button", { name: "Match case", exact: true });
    const word = page.getByRole("button", { name: "Match whole word" }), regex = page.getByRole("button", { name: "Use regular expression" });
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+Home"); await source.press("ArrowRight"); await source.press("Control+f");
    await expect(query).toHaveValue("import");
    await expect(status).toHaveText("1 of 2");
    await query.fill("quantity"); await expect(status).toHaveText("1 of 4");
    await query.press("Enter"); await source.press("Control+Home"); await expect(status).toHaveText("4 matches");
    await page.locator("#editor .st-search-match").last().dblclick(); await expect(status).toHaveText("4 of 4");
    await source.press("Control+Home");
    await query.fill("Cart"); await expect(status).toHaveText("1 of 5");
    await caseButton.press("Space"); await expect(query).toBeFocused(); await expect(status).toHaveText("1 of 2");
    await word.click(); await expect(status).toHaveText("No matches");
    await caseButton.click(); await expect(status).toHaveText("3 matches");
    await regex.click(); await query.fill("car[t]"); await expect(status).toHaveText("1 of 3");
    await query.press("Enter"); await expect(status).toHaveText("2 of 3");
    await page.locator("#files button").filter({ hasText: "pricing.ts" }).click();
    await expect(query).toHaveValue("car[t]"); await expect(status).toHaveText("No matches");
    await expect(word).toHaveAttribute("aria-pressed", "true"); await expect(regex).toHaveAttribute("aria-pressed", "true");
    await page.locator('#files [data-file="main.ts"]').click(); await expect(status).toHaveText("2 of 3");
    await page.locator('#files [data-file="pricing.ts"]').click(); await expect(status).toHaveText("No matches");
    await word.click(); await expect(status).toHaveText("2 matches");
    await caseButton.click(); await expect(status).toHaveText("No matches");
});

test("the Find toolbar follows generated output and both Changes panes", async ({ page, baseURL }) => {
    await page.goto(browserDemo(baseURL!));
    const open = page.locator("#find-toggle"), query = page.locator(".st-find-query"), status = page.locator(".st-find-status");
    const label = page.locator(".st-find-target"), replace = page.locator(".st-replace-current"), replaceAll = page.locator(".st-replace-all");
    const output = page.getByRole("region", { name: "JavaScript output", exact: true });
    const reader = output.getByRole("textbox"), source = page.locator("#editor");
    await reader.focus(); await page.locator(".intro p").first().click();
    await page.keyboard.press("Control+f"); await expect(query).toBeFocused(); await query.fill("const cart =");
    await expect(label).toHaveText("JavaScript output · read-only"); await expect(status).toHaveText("1 of 1");
    const codeSummary = page.locator("#code-menu summary");
    await codeSummary.click();
    const warnings = page.locator("#character-warnings");
    await warnings.focus();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    await expect(warnings).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#indentation")).toBeFocused();
    const comment = page.locator("#line-comment");
    await expect(comment).toBeDisabled();
    await comment.click({ force: true });
    await page.keyboard.press("Escape");
    await codeSummary.dispatchEvent("keydown", { key: "Escape", repeat: true });
    await expect(query).toBeFocused(); await expect(page.locator("#code-menu")).not.toHaveAttribute("open", "");
    await expect(output.locator(".st-search-match").first()).toBeVisible(); await expect(source.locator(".st-search-match")).toHaveCount(0);
    await page.locator(".intro p").first().click(); await page.keyboard.press("Control+h"); await expect(query).toBeFocused(); await expect(replace).toBeVisible();
    await expect(replace).toBeDisabled(); await expect(replaceAll).toBeDisabled();
    await expect(replace).toHaveAttribute("title", "JavaScript output is read-only.");
    await reader.press("Escape"); await expect(reader).toBeFocused(); await expect(query).toBeHidden();
    await reader.press("F3");
    const selected = (input: Locator) => input.evaluate(node => { const el = node as HTMLTextAreaElement; return el.value.slice(el.selectionStart, el.selectionEnd); });
    await expect.poll(() => selected(reader)).toBe("const cart ="); await expect(query).toBeHidden();
    await reader.press("Control+f"); await expect(query).toBeFocused(); await expect(query).toHaveValue("const cart =");
    await query.press("Escape");
    await open.click(); await page.locator("#panel-collapse").click();
    await expect(label).toBeEmpty(); await expect(status).toHaveText("No matches");
    await query.press("Escape"); await expect(source.getByRole("textbox")).toBeFocused();

    await page.locator("#panel-collapse").click();
    await page.locator('[data-panel="changes"]').click();
    const panes = page.locator(".st-comparison-panes > section"), saved = panes.first(), working = panes.last();
    const savedInput = saved.getByRole("textbox");
    await savedInput.press("Control+Home"); await savedInput.press("Shift+End");
    await savedInput.press("Control+f");
    await expect(label).toHaveText("Saved copy · read-only");
    await expect(query).toHaveValue('import { calculateTotal } from "./pricing";');
    await expect(saved.locator(".st-search-match").first()).toBeVisible(); await expect(working.locator(".st-search-match")).toHaveCount(0);
    await page.locator(".st-replace-toggle").click(); await expect(replaceAll).toBeDisabled();
    const readOnlyReplacement = page.locator(".st-replacement");
    await readOnlyReplacement.fill("keep the saved copy"); await readOnlyReplacement.press("Enter");
    await expect(readOnlyReplacement).toHaveValue("keep the saved copy");
    await expect(working.getByRole("textbox")).not.toHaveValue(/keep the saved copy/);
    await query.press("F3"); await expect(query).toBeFocused(); await expect(status).toHaveText("1 of 1 · Wrapped to start");
    await working.getByRole("textbox").focus(); await expect(label).toBeEmpty(); await expect(replaceAll).toBeEnabled();
    await expect(saved.locator(".st-search-match")).toHaveCount(0); await expect(working.locator(".st-search-match").first()).toBeVisible();
    await open.press("Control+h"); await expect(page.locator(".st-replacement")).toBeFocused();
    await page.locator(".st-replacement").press("Control+f"); await expect(query).toBeFocused();
    await query.fill("quantity"); await expect(status).toHaveText(/of 4$/); await query.press("Enter"); await query.press("Escape");
    const workingInput = working.getByRole("textbox"), offset = () => workingInput.evaluate(node => (node as HTMLTextAreaElement).selectionStart);
    const first = await offset();
    await page.locator("#status").click();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await page.keyboard.press("F3");
    await expect.poll(offset).toBeGreaterThan(first);
    await workingInput.press("Shift+F3"); await expect.poll(offset).toBe(first); await expect(query).toBeHidden();
});

async function holdRegexReply(page: Page, operation: "regex-matches" | "regex-edits" = "regex-matches") {
    type Probe = { pending: (() => void)[]; holding: boolean };
    type ProbeWindow = typeof window & { regexProbe: Probe };
    await page.addInitScript(operation => {
        const probe: Probe = { pending: [], holding: true };
        Object.assign(window, { regexProbe: probe });
        window.Worker = class extends Worker {
            constructor(url: string | URL, options?: WorkerOptions) {
                super(url, options);
                if (new URL(url, document.baseURI).pathname.endsWith("/regex-worker.js")) this.addEventListener("message", event => {
                    if (!probe.holding || event.data?.operation !== operation) return;
                    event.stopImmediatePropagation();
                    probe.pending.push(() => this.dispatchEvent(new MessageEvent("message", { data: event.data })));
                }, { capture: true });
            }
        };
    }, operation);
    return {
        waiting: () => page.evaluate(() => (window as ProbeWindow).regexProbe.pending.length),
        setHolding: (hold: boolean) => page.evaluate(hold => { (window as ProbeWindow).regexProbe.holding = hold; }, hold),
        release: () => page.evaluate(() => {
            const probe = (window as ProbeWindow).regexProbe;
            probe.holding = false;
            for (const deliver of probe.pending.splice(0)) deliver();
        }),
    };
}

test("closed Find repeats a finished regex and repaints it on reopen without another lookup", async ({ page, baseURL }) => {
    const gate = await holdRegexReply(page);
    await page.goto(browserDemo(baseURL!));
    await gate.setHolding(false);
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    const query = page.locator(".st-find-query"), marks = page.locator("#editor .st-search-match");
    await source.press("Control+a");
    await page.keyboard.insertText("// start red one red");
    await source.press("Control+Home");
    await source.press("Control+f");
    await page.locator(".st-find-regex").click();
    await query.fill("red");
    await expect(marks).toHaveCount(2);
    await expect(page.locator(".st-find-status")).toHaveText("1 of 2");
    await query.press("Escape");
    await gate.setHolding(true);
    await source.press("F3");
    await expect(page.locator(".st-find-status")).toHaveText("2 of 2");
    await expect(query).toBeHidden();
    await expect(marks).toHaveCount(0);
    await source.press("Control+f");
    await expect(marks).toHaveCount(2);
    expect(await gate.waiting()).toBe(0);
    await query.press("Escape");
    await source.press("Control+End");
    await page.keyboard.insertText("\n// red");
    await source.press("F3");
    await expect.poll(gate.waiting).toBe(1);
    await gate.release();
    await expect(page.locator(".st-find-status")).toContainText("of 3");
    await expect(marks).toHaveCount(0);
});

test("Save during Replace all keeps the saved copy until the edit is ready and Save is retried", async ({ page, context, baseURL }) => {
    const gate = await holdRegexReply(page, "regex-edits");
    await page.goto(browserDemo(baseURL!));
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+a"); await page.keyboard.insertText("// Saved copy"); await source.press("Control+s");
    await expect(page.locator("#status")).toHaveText("Saved in this browser.");
    await source.press("Control+a"); await page.keyboard.insertText("// old\n// old");
    await source.press("Control+Home"); await source.press("Control+h");
    await page.locator(".st-find-regex").click(); await page.locator(".st-find-query").fill("old");
    await page.locator(".st-replacement").fill("new"); await page.locator(".st-replace-all").click();
    await expect.poll(gate.waiting).toBe(1);
    await page.getByRole("button", { name: "Save locally", exact: true }).click();
    await expect(page.locator("#status")).toHaveText("Save skipped while an edit was pending. Save again to keep your changes.");
    await gate.release(); await expect(source).toHaveValue("// new\n// new");
    await expect(page.locator("#status")).toHaveText("Unsaved changes.");

    const peer = await context.newPage();
    try {
        await peer.goto(browserDemo(baseURL!));
        const saved = peer.getByRole("textbox", { name: "main.ts", exact: true });
        await expect(saved).toHaveValue("// Saved copy");
        await source.press("Control+s"); await expect(page.locator("#status")).toHaveText("Saved in this browser.");
        await peer.reload(); await expect(saved).toHaveValue("// new\n// new");
    } finally { await peer.close(); }
});

test("opening Changes during Replace all reviews the committed edit and a file switch drops the pending request", async ({ page, baseURL }) => {
    const gate = await holdRegexReply(page, "regex-edits");
    await page.goto(browserDemo(baseURL!));
    const source = page.locator("#editor").getByRole("textbox");
    await source.press("Control+h"); await page.locator(".st-find-regex").click();
    await page.locator(".st-find-query").fill("calculateTotal");
    await page.locator(".st-replacement").fill("reviewTotal");
    const replace = page.locator(".st-replace-all"), compare = page.locator("#compare"), review = page.locator(".st-comparison");
    expect(await warnsBeforeUnload(page)).toBe(false);
    await replace.click(); await expect.poll(gate.waiting).toBe(1);
    await expect(page.locator(".st-find-status")).toHaveText("Replacing…");
    expect(await warnsBeforeUnload(page)).toBe(true);
    await page.locator('[data-panel="problems"]').click(); await compare.click(); await gate.release();
    const panes = review.locator(".st-comparison-panes > section");
    await expect(panes.last().locator('.st-viewport-row[data-line="0"]')).toContainText("reviewTotal");
    await expect(panes.first().locator('.st-viewport-row[data-line="0"]')).toContainText("calculateTotal");
    await expect(page.locator("#replace-result")).toHaveText("main.ts · Replaced 2 matches.");
    await panes.last().getByRole("textbox").press("Control+z");
    await expect(review.locator(".st-comparison-controls output")).toHaveText("No changes");

    await gate.setHolding(true); await replace.click(); await expect.poll(gate.waiting).toBe(1);
    await page.locator('[data-panel="javascript"]').click();
    await page.locator('#files [data-file="pricing.ts"]').click(); await gate.release();
    await expect(page.locator("#replace-result")).toHaveText("main.ts · Replacement cancelled.");
    await expect(page.locator('[data-panel="changes"]')).toHaveAttribute("aria-pressed", "true");
    await expect(review.locator(".st-comparison-controls output")).toHaveText("No changes");
    await page.locator('#files [data-file="main.ts"]').click();
    await expect(review.locator(".st-comparison-controls output")).toHaveText("No changes");
});

test("switching views immediately after a source edit preserves its Undo", async ({ page, baseURL }) => {
    await page.goto(browserDemo(baseURL!));
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    const changes = page.getByRole("button", { name: "Changes", exact: true });
    await source.press("Control+a");
    await page.keyboard.insertText("0\n".repeat(40_000));
    await source.press("Control+a");
    await source.press("Control+/");
    await changes.click();
    const working = page.locator(".st-comparison .st-editor").last();
    await expect(working.locator(".st-viewport-row").first()).toHaveText("// 0");
    await working.getByRole("textbox").press("Control+z");
    await expect(working.locator(".st-viewport-row").first()).toHaveText("0");
});

test("file tabs keep the active review pane and its selection for the same saved version", async ({ page, baseURL }) => {
    await page.goto(browserDemo(baseURL!));
    await page.locator("#compare").click();
    const baseline = page.getByRole("textbox", { name: "Comparison baseline source" });
    const working = page.getByRole("textbox", { name: "Comparison working source" });
    const main = page.locator('#files [data-file="main.ts"]');
    const pricing = page.locator('#files [data-file="pricing.ts"]');
    const draft = await working.inputValue();
    const firstLine = draft.split("\n")[0]!;
    await baseline.press("Control+Home");
    await baseline.press("End");
    await baseline.press("Shift+Home");
    await main.press("Enter");
    await page.keyboard.type("X");
    await expect(working).toHaveValue(draft);
    await expect(baseline).toBeFocused();

    await pricing.click();
    await expect(baseline).toBeFocused();
    await expect(baseline).toHaveJSProperty("selectionEnd", 0);
    await main.click();
    await expect(baseline).toBeFocused();
    await expect(baseline).toHaveJSProperty("selectionStart", 0);
    await expect(baseline).toHaveJSProperty("selectionEnd", firstLine.length);
    await expect(baseline).toHaveJSProperty("selectionDirection", "backward");

    // Saving a sibling publishes a new version even when main.ts still has the same bytes.
    await pricing.click();
    await working.press("Control+Home");
    await page.keyboard.type("// price\n");
    await page.locator("#save").click();
    await expect(page.locator("#status")).toHaveText("Saved in this browser.");
    await main.click();
    await expect(working).toBeFocused();
    await expect(baseline).toHaveJSProperty("selectionEnd", 0);
});

test("refocusing the current file and switching result panels preserve source caret history", async ({ page, baseURL }) => {
    await page.goto(browserDemo(baseURL!));
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    const firstRow = page.locator("#editor .st-viewport-row").first();
    const tabs = ['#files [data-file="main.ts"]', '[data-panel="problems"]', '[data-panel="javascript"]'];
    for (const tab of tabs) {
        await source.press("Control+a");
        await page.keyboard.insertText("value + value;");
        await source.press("Control+Home");
        await source.press("Control+d");
        await source.press("Control+d");
        await page.locator(tab).click();
        await expect(source).toBeFocused();
        await source.press("Control+u");
        await page.keyboard.insertText("X");
        await expect(firstRow).toHaveText("X + value;");
    }
});

test("cancelling a replacement makes a reviewed save conflict actionable again", async ({ page, context, baseURL }) => {
    const gate = await holdRegexReply(page, "regex-edits");
    await page.goto(browserDemo(baseURL!));
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+Home"); await page.keyboard.insertText("// Local edit\n");
    const peer = await context.newPage();
    try {
        await peer.goto(browserDemo(baseURL!));
        const remote = peer.getByRole("textbox", { name: "main.ts", exact: true });
        await remote.press("Control+a"); await peer.keyboard.insertText("// Peer save"); await remote.press("Control+s");
        await expect(peer.locator("#status")).toHaveText("Saved in this browser.");
    } finally { await peer.close(); }
    await source.press("Control+s");
    await source.press("Control+h");
    await page.locator(".st-find-regex").click();
    await page.locator(".st-find-query").fill("Local");
    await page.locator(".st-replacement").fill("Cancelled");
    await page.locator(".st-replace-all").click();
    await expect.poll(gate.waiting).toBe(1);
    await page.locator("#conflict-review").click();
    await page.locator(".st-replacement").press("Escape");
    await gate.release();
    await expect(page.getByRole("textbox", { name: "main.ts", exact: true })).toBeVisible();
    await expect(page.locator("#conflict-take")).toBeDisabled();
    await page.locator("#conflict-review").click();
    const take = page.locator("#conflict-take"), save = page.locator("#conflict-save");
    const working = page.getByRole("textbox", { name: "Comparison working source", exact: true });
    await expect(take).toBeEnabled(); await working.press("Control+h");
    await gate.setHolding(true);
    await page.locator(".st-find-query").fill("Local");
    await page.locator(".st-replacement").fill("Cancelled"); await page.locator(".st-replace-all").click();
    await expect.poll(gate.waiting).toBe(1); await expect(take).toBeDisabled(); await expect(save).toBeDisabled();
    await page.locator(".st-replacement").press("Escape"); await gate.release();
    await expect(page.locator("#replace-result")).toHaveText("main.ts · Replacement cancelled.");
    await expect(page.locator("#replace-result")).toBeVisible();
    await expect(save).toBeEnabled(); await expect(working).toHaveValue(/^\/\/ Local edit/);
    await take.click(); await expect(working).toHaveValue("// Peer save");
});

test("moving or typing during Replace all cancels it and leaves the source ready for a retry", async ({ page, baseURL }) => {
    const gate = await holdRegexReply(page, "regex-edits");
    await page.goto(browserDemo(baseURL!));
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    const outcome = page.locator("#replace-result"), replace = page.locator(".st-replace-all");
    await source.press("Control+a");
    await page.keyboard.insertText("old old");
    await source.press("Control+Home");
    await source.press("Control+h");
    await page.locator(".st-find-regex").click();
    await page.locator(".st-find-query").fill("old");
    await page.locator(".st-replacement").fill("new");
    for (const interruption of ["selection", "typing"]) {
        await replace.click();
        await expect.poll(gate.waiting).toBe(1);
        await page.locator("#compare").click();
        if (interruption === "selection") await source.press("End");
        else {
            await source.focus();
            await page.keyboard.type("x");
        }
        await expect(outcome).toHaveText("main.ts · Replacement cancelled.");
        await expect(outcome).toBeVisible();
        await expect(source).toBeFocused();
        await expect(replace).toBeEnabled();
        await gate.release();
        await expect(source).toHaveValue(interruption === "selection" ? "old old" : "old oldx");
        await gate.setHolding(true);
    }
    await gate.setHolding(false);
    await replace.click();
    await expect(source).toHaveValue("new newx");
    await expect(outcome).toHaveText("main.ts · Replaced 2 matches.");
});

for (const interrupt of ["folding", "a focus round trip in a shadow root"] as const) {
    test(`${interrupt} while F3 waits for regex results requires a fresh F3`, async ({ page, baseURL }) => {
        const gate = await holdRegexReply(page);
        await page.goto(browserDemo(baseURL!)); await page.getByRole("button", { name: "pricing.ts", exact: true }).click();
        const source = page.getByRole("textbox", { name: "pricing.ts", exact: true }), fold = page.locator("#editor .st-fold-button").first();
        await expect(fold).toBeVisible({ timeout: 30000 });
        if (interrupt !== "folding") {
            await moveEditorIntoShadow(source);
            await source.evaluate(node => {
                const button = document.createElement("button");
                button.textContent = "Host control"; (node.getRootNode() as ShadowRoot).append(button);
            });
        }
        await source.press("Control+Home"); await source.press("Control+f"); await page.locator(".st-find-regex").click();
        await page.locator(".st-find-query").fill("name: string"); await expect.poll(gate.waiting).toBe(1);
        await source.press("F3");
        if (interrupt === "folding") {
            await source.press("Control+Shift+BracketLeft"); await expect(fold).toHaveAttribute("aria-expanded", "false");
        } else {
            await page.getByRole("button", { name: "Host control", exact: true }).focus(); await source.focus();
        }
        await gate.release(); await expect(page.locator(".st-find-status")).toHaveText("1 match");
        await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        await expect(fold).toHaveAttribute("aria-expanded", interrupt === "folding" ? "false" : "true");
        await expect(page.locator("#cursor")).toHaveText("Ln 1, Col 1");
        await source.press("F3"); await expect(fold).toHaveAttribute("aria-expanded", "true");
        await expect(page.locator("#cursor")).toHaveText("Ln 2, Col 17"); await expect(source).toBeFocused();
        expect(await source.evaluate(node => { const field = node as HTMLTextAreaElement; return field.value.slice(field.selectionStart, field.selectionEnd); })).toBe("name: string");
    });
}

test("a pending regex search allows large-file scrolling and typing and expires on file change", async ({ page, baseURL }) => {
    const gate = await holdRegexReply(page);
    const source = await openRows(page, browserDemo(baseURL!)), viewport = page.locator("#editor .st-viewport");
    await source.press("Control+f"); await page.locator(".st-find-regex").click();
    const query = page.locator(".st-find-query");
    await query.fill("Row 7500:");
    await expect.poll(gate.waiting, { timeout: 15000 }).toBe(1);
    await viewport.evaluate(root => { root.scrollTop = root.scrollHeight / 3; });
    const chosenScroll = await viewport.evaluate(root => root.scrollTop);
    await gate.release();
    await expect(page.locator(".st-find-status")).toHaveText("1 match");
    await expect(query).toBeFocused(); expect(await viewport.evaluate(root => root.scrollTop)).toBe(chosenScroll);
    await viewport.evaluate(root => { root.scrollTop = root.scrollHeight / 2; });
    await expect(viewport.locator('.st-viewport-row[data-line="5003"]')).toContainText("Row 5004:");
    await gate.setHolding(true);
    await query.fill("Row (?:5|5004):"); await expect.poll(gate.waiting, { timeout: 15000 }).toBe(1);
    await page.getByRole("button", { name: "Next match", exact: true }).click();
    await gate.release();
    await expect(page.locator("#cursor")).toContainText("Ln 5004,"); await expect(query).toBeFocused();
    await gate.setHolding(true);
    await query.fill(String.raw`\brow(?= \d| ")`);
    await expect.poll(gate.waiting, { timeout: 15000 }).toBe(1);
    await viewport.evaluate(root => { root.scrollTop = root.scrollHeight / 2; });
    const middle = viewport.locator('.st-viewport-row[data-line="5000"]');
    await expect(middle).toHaveText("// Row 5001: try editing or searching here.");
    await middle.click(); await source.press("End"); await source.press("!");
    await expect(middle).toHaveText("// Row 5001: try editing or searching here.!");
    await expect.poll(gate.waiting, { timeout: 15000 }).toBe(2);
    await source.press("F3");
    await gate.setHolding(false);
    await page.locator("#sample").selectOption("host");
    await expect(page.getByRole("textbox", { name: "workflow.rules", exact: true })).toBeVisible();
    await expect(page.locator(".st-find-status")).toHaveText("2 matches");
    await gate.release();
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await expect(page.locator(".st-find-status")).toHaveText("2 matches");
    await expect(page.locator("#editor .st-search-match")).toHaveText(["row", "row"]);
    await expect(page.locator("#cursor")).toHaveText("Ln 1, Col 1");
});

test("minimap shows compact colored code and previews the destination before a jump", async ({ page, baseURL }, info) => {
    await page.goto(browserDemo(baseURL!));
    const root = page.locator("#editor .st-viewport"), track = root.locator(".st-minimap");
    await page.locator("#view-menu summary").click(); await page.locator("#view-minimap").check();
    await page.locator("#view-menu summary").press("Escape");
    const short = (await track.boundingBox())!;
    expect(short.height).toBeLessThan((await root.boundingBox())!.height / 4);
    await page.locator("#sample").selectOption("shipping");
    await expect(page.locator("#analysis-status")).toContainText("syntax & emit", { timeout: 30000 });
    // Count the actual syntax foregrounds in the thumbnail, independently of the source DOM.
    await expect.poll(() => track.locator("canvas").evaluate(element => {
        const c = element as HTMLCanvasElement;
        if (!c.width) return false;
        const pixels = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let keyword = false, string = false;
        for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i + 3]! < 100) continue;
            const r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
            if (b > g + 45 && r > g + 15) keyword = true;
            if (g > r + 25 && g > b + 35) string = true;
        }
        return keyword && string;
    })).toBe(true);
    const lines = demoSample("shipping").files["shipping.ts"]!.split("\n");
    const row = lines.findIndex(line => line.startsWith("function shippingQuotes"));
    const map = (await track.boundingBox())!, pointer = { x: 12, y: Math.round((row + 1) * map.height / (lines.length + 1)) };
    await track.hover({ position: pointer });
    const preview = root.locator(".st-minimap-preview");
    await expect(preview.locator("strong")).toHaveText("Line " + (row + 1));
    await expect(preview.locator(".st-minimap-preview-line")).toHaveText(lines[row]!);
    await info.attach("minimap-destination", { body: await page.screenshot(), contentType: "image/png" });
    await track.click({ position: pointer });
    await expect(preview).toBeHidden();
    await expect.poll(() => root.evaluate((el, line) => {
        const target = el.querySelector(`.st-viewport-row[data-line="${line}"]`);
        if (!target) return Infinity;
        const source = el.getBoundingClientRect(), row = target.getBoundingClientRect();
        return Math.abs(row.top + row.height / 2 - source.top - el.clientHeight / 2) / row.height;
    }, row)).toBeLessThan(1.5);
});

test("the demo renders editable Fira Code ligatures on first open", async ({ page, baseURL }) => {
    await checkDemoLigatures(page, browserDemo(baseURL!));
});

test("view controls survive file switches and saved-reference replacement in both review panes", async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width: 2000, height: 1000 }); await page.goto(browserDemo(baseURL!));
    const source = page.locator("#editor .st-viewport"), input = source.getByRole("textbox");
    await expect(source.locator(".st-current-line")).toHaveCount(1);
    const mounted = await source.elementHandle(), initialHeight = await source.evaluate(element => element.scrollHeight);
    const code = page.locator("#code-menu");
    await code.locator("summary").press("Enter");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Tab");
    await expect(page.locator("#view-menu summary")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(code).not.toHaveAttribute("open", "");
    for (const id of ["view-rulers", "view-ligatures", "view-trailing-space", "view-minimap"]) await page.locator(`#${id}`).check();
    await expect(source.locator(".st-column-ruler").first()).toBeVisible();
    await expect(source.locator(".st-minimap-marker")).toBeVisible();
    await expect(page.locator(".demo-output .st-minimap-marker")).toBeVisible();
    for (const pane of [source, page.locator(".demo-output")]) {
        const rows = pane.locator(".st-viewport-row");
        const first = await rows.nth(0).boundingBox(), second = await rows.nth(1).boundingBox();
        expect(second!.y - first!.y).toBe(24);
    }
    const outputNumber = page.locator(".demo-output .st-line-numbers [data-current]");
    await expect(outputNumber).toHaveText("1");
    await page.locator("#view-current-line").uncheck();
    await expect(outputNumber).toHaveCount(0);
    await page.locator("#view-current-line").check();
    await expect(source).toHaveCSS("font-variant-ligatures", "normal");
    await expect.poll(() => source.evaluate(element => element.scrollHeight)).toBeGreaterThan(initialHeight);
    expect(await mounted!.evaluate(element => element.isConnected)).toBe(true);
    const viewOption = page.locator("#view-minimap"); await viewOption.focus();
    await expectPanelKeyReserved(viewOption, "Escape"); await expect(page.locator("#view-menu")).toHaveAttribute("open", "");
    await viewOption.press("Escape"); await expect(page.locator("#view-menu")).not.toHaveAttribute("open", "");
    await expect(input).toBeFocused();
    await page.keyboard.press("Control+Home"); await page.keyboard.type("// View controls\n");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const panes = page.locator(".st-comparison-panes > section"), left = panes.first(), right = panes.last();
    await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    for (const pane of [left, right]) {
        await expect(pane.locator(".st-column-ruler").first()).toBeVisible();
        await expect(pane.locator(".st-minimap-marker")).toBeVisible();
        await expect(pane.locator(".st-current-line")).toHaveCount(1);
        await expect(pane.locator(".st-viewport")).toHaveCSS("font-variant-ligatures", "normal");
    }
    await page.locator("#save").click();
    await expect(left.locator('.st-viewport-row[data-line="0"]')).toHaveText("// View controls");
    await expect(left.locator(".st-column-ruler").first()).toBeVisible();
    await expect(left.locator(".st-viewport")).toHaveCSS("font-variant-ligatures", "normal");
    await page.locator("#files button").filter({ hasText: "pricing.ts" }).click();
    await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    for (const pane of [left, right]) await expect(pane.locator(".st-column-ruler").first()).toBeVisible();
    await page.locator("#sample").selectOption("unicode");
    await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    for (const pane of [left, right]) await expect(pane.locator(".demo-token-string").first()).toBeVisible();
    await page.locator("#view-menu summary").click();
    for (const id of ["view-rulers", "view-current-line", "view-ligatures", "view-trailing-space", "view-minimap"]) await expect(page.locator(`#${id}`)).toBeChecked();
    await info.attach("presentation-controls", { body: await page.screenshot(), contentType: "image/png" });
    for (const id of ["view-rulers", "view-current-line", "view-ligatures", "view-trailing-space", "view-minimap"]) await page.locator(`#${id}`).uncheck();
    for (const pane of [left, right]) {
        await expect(pane.locator(".st-column-ruler, .st-current-line-background, .st-minimap")).toHaveCount(0);
        await expect(pane.locator(".st-viewport")).toHaveCSS("font-variant-ligatures", "none");
    }
    await page.locator("#view-menu summary").press("Escape");
    await expect(right.getByRole("textbox")).toBeFocused();
});

test("character warnings explain source characters and stay consistent across review panes", async ({ page, baseURL }, info) => {
    const url = new URL(browserDemo(baseURL!));
    url.searchParams.set("sample", "unicode");
    await page.goto(url.href);
    const source = page.getByRole("textbox", { name: "greetings.ts", exact: true });
    const warnings = page.locator("#editor .st-viewport-layer .st-character-warning");
    await expect(warnings.first()).toHaveText("\u200b"); await expect(page.locator("#analysis-status")).toContainText("syntax & emit");
    await source.press("Control+Home"); await page.locator("#code-menu summary").click();
    await page.getByRole("button", { name: "Inspect source characters", exact: true }).click();
    const details = page.locator("#character-warning-details"), invisible = details.getByRole("button", { name: /U\+200B/ });
    await expect(invisible).toHaveText("Ln 1, Col 16: Invisible character (U+200B)");
    await expect(details).toContainText("Non-breaking space (U+00A0)");
    await info.attach("warning-inspector", { body: await page.screenshot(), contentType: "image/png" });
    await invisible.click(); await source.press("Backspace"); await expect(warnings.first()).toHaveText("\u00a0");
    await invisible.click(); await expect(details).toHaveText("The source or warning settings changed. Inspect again.");
    await source.press("Control+z"); await expect(warnings.first()).toHaveText("\u200b");
    await page.locator("#character-warnings").uncheck(); await expect(warnings).toHaveCount(0);
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    const panes = page.locator(".st-comparison-panes > section"), left = panes.first(), right = panes.last();
    const marks = ".st-viewport-layer .st-character-warning";
    await expect(left.locator(marks)).toHaveCount(0); await expect(right.locator(marks)).toHaveCount(0);
    await page.locator("#code-menu summary").click(); await page.locator("#character-warnings").check();
    await expect(left.locator(marks).first()).toHaveText("\u200b"); await expect(right.locator(marks).first()).toHaveText("\u200b");
    expect(await left.locator(marks).allTextContents()).toEqual(await right.locator(marks).allTextContents());
    await page.locator("#code-menu summary").click();
    await info.attach("warning-review", { body: await page.screenshot(), contentType: "image/png" });
});

test("language commands pressed during startup follow the original caret and report empty results", async ({ page, baseURL }) => {
    type Gate = { release?: () => void; completions: number; holdCompletion?: boolean; deliverCompletion?: () => void };
    type HeldWorker = Window & { languageGate?: Gate };
    await page.addInitScript(() => {
        const gate: Gate = { completions: 0 }; (window as HeldWorker).languageGate = gate;
        window.Worker = class extends Worker {
            constructor(url: string | URL, options?: WorkerOptions) {
                super(url, options);
                if (!new URL(url, document.baseURI).pathname.endsWith("/demo-language-worker.js")) return;
                let heldId: number | undefined;
                this.addEventListener("message", event => {
                    if (heldId === undefined || typeof event.data !== "string") return;
                    const reply = JSON.parse(event.data);
                    if (reply.id !== heldId || !("result" in reply)) return;
                    event.stopImmediatePropagation(); heldId = undefined;
                    gate.deliverCompletion = () => {
                        const items = Array.isArray(reply.result) ? reply.result : reply.result?.items;
                        if (!items?.some((item: { label: string }) => item.label === "calculateTotal")) throw new Error("Expected the original source's completion.");
                        this.dispatchEvent(new MessageEvent("message", { data: event.data }));
                    };
                }, { capture: true });
                this.postMessage = new Proxy(this.postMessage, { apply(send, worker, args) {
                    if (args[0]?.start === true && Array.isArray(args[0].names)) {
                        gate.release = () => Reflect.apply(send, worker, args); return;
                    }
                    const request = typeof args[0] === "string" && JSON.parse(args[0]);
                    if (request?.method === "textDocument/completion") {
                        gate.completions++;
                        if (gate.holdCompletion) { gate.holdCompletion = false; heldId = request.id; }
                    }
                    return Reflect.apply(send, worker, args);
                } });
            }
        };
    });
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    const message = page.getByLabel("Language command", { exact: true });
    const completions = page.getByRole("listbox", { name: "Completions" });
    const rename = page.getByRole("dialog", { name: "Rename symbol" });
    const open = async () => {
        await page.goto(browserDemo(baseURL!));
        await page.waitForFunction(() => !!(window as HeldWorker).languageGate?.release);
        const row = page.locator("#editor .st-viewport-row").filter({ hasText: "import { calculateTotal }" });
        const point = await paintedCharacter(row, "calculateTotal", 2); await page.mouse.click(point.x, point.y);
    };
    const release = async () => {
        await page.evaluate(() => (window as HeldWorker).languageGate!.release!());
        await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    };
    await open();
    await source.press("Control+Space"); await expect(message).toBeVisible();
    await expect(message).toContainText("completions");
    await release(); await expect(completions.getByRole("option", { name: "calculateTotal", exact: true })).toBeVisible();
    const requests = () => page.evaluate(() => (window as HeldWorker).languageGate!.completions);
    expect(await requests()).toBe(1);
    await source.press("Escape"); await source.press("Control+Home"); await source.press("Control+Shift+Space");
    await expect(message).toHaveText("No signature at this position.");
    await source.press("End"); await page.keyboard.insertText(" // comment");
    await source.press("Control+Space"); await expect(message).toHaveText("No suggestions here. Try a different prefix.");
    await source.press("ArrowLeft"); await expect(message).toBeHidden();

    await open();
    await source.press("Control+Space"); await source.press("F2"); await expect(message).toContainText("Rename");
    await release(); await expect(rename.getByRole("textbox", { name: "New name" })).toBeFocused();
    expect(await requests()).toBe(0);
    await page.keyboard.press("Escape"); await expect(source).toBeFocused();

    await open();
    await source.press("F2"); await source.press("ArrowRight"); await expect(message).toBeHidden();
    await source.press("Control+Space"); await source.press("Escape"); await expect(message).toBeHidden();
    await source.press("F2"); await page.keyboard.insertText("x"); await expect(message).toBeHidden();
    await source.press("F2"); await expect(message).toContainText("Rename");
    const output = page.getByRole("region", { name: "JavaScript output", exact: true }).getByRole("textbox");
    await output.focus(); await expect(message).toBeHidden();
    await release(); await expect(output).toBeFocused(); await expect(rename).toBeHidden(); await expect(completions).toBeHidden();
    expect(await requests()).toBe(0);

    await open();
    await page.locator("#code-menu summary").click(); await page.getByRole("button", { name: "Rename symbol", exact: true }).click();
    await expect(message).toContainText("Rename");
    await page.locator('[data-file="pricing.ts"]').click();
    const pricing = page.getByRole("textbox", { name: "pricing.ts", exact: true });
    await expect(pricing).toBeFocused(); await release();
    await expect(message).toBeHidden(); await expect(rename).toBeHidden(); await expect(pricing).toBeFocused();

    await open();
    await page.evaluate(() => { (window as HeldWorker).languageGate!.holdCompletion = true; });
    await source.press("Control+Space"); await release();
    await page.waitForFunction(() => !!(window as HeldWorker).languageGate!.deliverCompletion);
    await expect(completions).toBeHidden();
    await page.locator('[data-file="pricing.ts"]').click();
    await pricing.press("Control+Home"); await pricing.press("Control+Shift+Space");
    await expect(message).toHaveText("No signature at this position.");
    await page.evaluate(() => {
        (window as HeldWorker).languageGate!.deliverCompletion!();
        return new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    });
    await expect(pricing).toBeFocused(); await expect(completions).toBeHidden();
    await expect(message).toHaveText("No signature at this position.");
});

import { runDemoPresentationContinuity, runDemoSyntaxDemand, runDemoMetadataBatching } from "./demo-presentation.ts";

test("metadata batches frame writes while typing, switching files and disposing", async ({ page, baseURL }, info) => {
    const counts = await runDemoMetadataBatching(page, browserDemo(baseURL!));
    await info.attach("metadata-work", { body: JSON.stringify(counts, null, 2), contentType: "application/json" });
});

test("syntax worker retains large documents and emits only for the visible JavaScript panel", async ({ page, baseURL }, info) => {
    const traffic = await runDemoSyntaxDemand(page, browserDemo(baseURL!));
    await info.attach("syntax-traffic", { body: JSON.stringify(traffic, null, 2), contentType: "application/json" });
});

// Native scrollbar drags are part of the demo's user journey, including headless Chromium.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("minified paste keeps its selection during native scrollbar drags on both axes", async ({ page, baseURL }) => {
    await dragBundleScrollbars(page, browserDemo(baseURL!));
});
test("minified paste shows keyboard and pointer selections over a highlighted string", async ({ page, baseURL }) => {
    await selectInsideString(page, browserDemo(baseURL!));
});
test("minified paste keeps a string hover open until its target changes", async ({ page, baseURL }) => {
    await hoverString(page, browserDemo(baseURL!));
});

test("visible presentation survives edits, history and scrolling while compiler replies wait", async ({ page, baseURL }, info) => {
    const observation = await runDemoPresentationContinuity(page, browserDemo(baseURL!));
    await info.attach("presentation-continuity", { body: JSON.stringify(observation, null, 2), contentType: "application/json" });
});

test("peer recovery reads only the changed sample while unrelated samples stay cached", async ({ page, baseURL }, info) => {
    type Probe = { reads: string[]; notices: number };
    await page.addInitScript(() => {
        const probe: Probe = { reads: [], notices: 0 }, name = "sttropez-demo-recovery-v1";
        Object.assign(window, { demoRecoveryProbe: probe });
        const get = IDBObjectStore.prototype.get, Native = BroadcastChannel;
        IDBObjectStore.prototype.get = function (key) {
            if (this.transaction.db.name === name) probe.reads.push(String(key));
            return get.call(this, key);
        };
        window.BroadcastChannel = class extends Native {
            constructor(channel: string) { super(channel); if (channel === name) this.addEventListener("message", () => { probe.notices++; }); }
        };
    });
    await page.goto(browserDemo(baseURL!)); await expect(page.locator("#recovery-status")).toHaveText("Recovery is ready.");
    await page.locator("#sample").selectOption("host");
    await expect(page.locator("#recovery-status")).toHaveText("Recovery is ready.");
    const peer = await page.context().newPage();
    try {
        await peer.goto(browserDemo(baseURL!)); await expect(peer.locator("#recovery-status")).toHaveText("Recovery is ready.");
        await page.evaluate(() => { const probe = (window as unknown as { demoRecoveryProbe: Probe }).demoRecoveryProbe; probe.reads = []; probe.notices = 0; });
        const source = peer.getByRole("textbox", { name: "main.ts", exact: true });
        await source.press("Control+Home"); await peer.keyboard.insertText("// Peer recovery\n");
        await expect(peer.locator("#recovery-status")).toHaveText("Recovery draft captured in this browser.");
        // Both cached stores receive the native broadcast. Only its owning slot may read.
        await page.waitForFunction(() => {
            const probe = (window as unknown as { demoRecoveryProbe: Probe }).demoRecoveryProbe;
            return probe.notices === 2 && probe.reads.includes("pricing");
        });
        const work = await page.evaluate(() => (window as unknown as { demoRecoveryProbe: Probe }).demoRecoveryProbe);
        await info.attach("recovery-work", { body: JSON.stringify(work, null, 2), contentType: "application/json" });
        expect(work.reads).toEqual(["pricing"]);
        await expect(page.locator("#recovery-offer")).toBeHidden();
        await expect(page.locator("#recovery-status")).toHaveText("Recovery is ready.");
        await page.locator("#sample").selectOption("pricing");
        const offer = page.locator("#recovery-offer");
        const review = page.getByRole("button", { name: "Review draft", exact: true });
        await expect(review).toBeVisible(); await expect(offer).toBeHidden();
        await review.click();
        await expect(page.locator("#recovery-message")).toHaveText("This browser has an unsaved draft for main.ts.");
        await page.getByRole("button", { name: "Keep current files", exact: true }).click();
        await expect(review).toBeVisible(); await expect(offer).toBeHidden();
        const priorReads = await page.evaluate(() => (window as unknown as { demoRecoveryProbe: Probe }).demoRecoveryProbe.reads.length);
        await source.press("Control+Home"); await peer.keyboard.insertText("// Latest from peer\n");
        await expect.poll(() => page.evaluate(() => (window as unknown as { demoRecoveryProbe: Probe }).demoRecoveryProbe.reads.length)).toBeGreaterThan(priorReads);
        await page.reload(); await expect(review).toBeVisible(); await expect(offer).toBeHidden();
        await expect(page.locator("#editor")).not.toContainText("// Peer recovery");
        await peer.reload(); await expect(peer.locator("#recovery-restore")).toBeEnabled();
        await peer.locator("#recovery-restore").click();
        await expect(peer.locator("#editor")).toContainText("// Latest from peer");
        await expect(peer.locator("#editor")).toContainText("// Peer recovery");
        await review.click();
        await expect(page.getByRole("button", { name: "Keep current files", exact: true })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(page.getByRole("button", { name: "Discard offered drafts", exact: true })).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(review).toBeVisible(); await expect(offer).toBeHidden();
        const local = page.getByRole("textbox", { name: "main.ts", exact: true });
        await expect(local).toBeFocused();
        const before = await local.inputValue();
        await page.keyboard.type("x");
        await expect(local).not.toHaveValue(before);
        await page.keyboard.press("Control+z");
        await expect(local).toHaveValue(before);
    } finally { if (!peer.isClosed()) await peer.close(); }
});

test("reset names its sample and recovery follows the stored draft across sample switches and reload", async ({ page, baseURL }) => {
    const prompts: string[] = []; page.on("dialog", dialog => { prompts.push(dialog.message()); void dialog.accept(); });
    const startup = latch<void>();
    await page.route("**/app.js", async route => { await startup.promise; await route.continue(); }, { times: 1 });
    const opening = page.goto(browserDemo(baseURL!));
    try {
        await expect(page.getByRole("button", { name: "Reset sample", exact: true })).toBeDisabled();
        await expect(page.getByLabel("Example", { exact: true })).toBeDisabled();
    } finally { startup.resolve(); await opening; }
    await page.getByRole("button", { name: "Reset sample", exact: true }).click();
    expect(prompts.at(-1)).toContain("Shopping cart");
    await page.locator("#sample").selectOption("large");
    const source = page.getByRole("textbox", { name: "large.ts", exact: true }); await expect(source).toBeVisible();
    await expect(page.locator("#recovery-status")).toHaveText("Recovery is ready.");
    await expect(page.locator("#recovery-offer")).toBeHidden();
    await source.press("Control+Home"); await source.pressSequentially("// My previous large-file edits\n");
    await expect(page.locator("#recovery-status")).toHaveText("Recovery draft captured in this browser.");
    await page.reload(); await page.getByRole("button", { name: "Reset sample", exact: true }).click();
    await expect(page.locator("#recovery-offer")).toBeHidden();
    await page.locator("#sample").selectOption("large");
    await expect(page.locator("#recovery-offer")).toBeVisible();
    await expect(page.locator("#recovery-message")).toContainText("unsaved draft for large.ts");
    await page.getByRole("button", { name: "Restore draft", exact: true }).click();
    await expect(page.locator("#editor")).toContainText("// My previous large-file edits");
    await page.getByRole("button", { name: "Reset sample", exact: true }).click();
    expect(prompts.at(-1)).toContain("Large file");
    await expect(page.locator("#status")).toContainText("Sample restored.");
    await source.press("Control+z"); await expect(page.locator("#status")).toHaveText("Unsaved changes.");
    await source.press("Control+y"); await expect(page.locator("#status")).toHaveText("Files match the original sample.");
    await expect(page.locator("#recovery-status")).toHaveText("No local recovery draft.");
    await page.reload(); await page.locator("#sample").selectOption("large");
    await expect(page.locator("#recovery-status")).toHaveText("Recovery is ready.");
    await expect(page.locator("#recovery-offer")).toBeHidden();
    await expect(page.locator("#editor")).not.toContainText("My previous large-file edits");
});

test("completion holds its prefix and side while filtering", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 800 }); await page.goto(browserDemo(baseURL!));
    const source = page.locator("#editor textarea"), list = page.locator(".st-completion");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await source.press("Control+End"); await source.pressSequentially("c");
    const placement = () => list.evaluate(el => {
        const box = el.getBoundingClientRect(), caret = document.querySelector("#editor .st-input-caret")!.getBoundingClientRect();
        return { above: box.bottom <= caret.top + 1, left: Math.round(box.left) };
    });
    await expect(list).toBeVisible(); await expect.poll(placement).toMatchObject({ above: true });
    const opening = await placement();
    await source.pressSequentially("al"); await expect(list.locator(".st-completion-count")).toContainText("1 of 1 ·");
    await expect.poll(placement).toEqual(opening);
    await source.press("Backspace"); await expect(list.locator(".st-completion-count")).not.toContainText("1 of 1 ·");
    await expect.poll(placement).toEqual(opening);
    await page.setViewportSize({ width: 1280, height: 1400 });
    await expect.poll(placement).toMatchObject({ above: false });
    await source.press("Escape"); await expect(list).toBeHidden(); await expect(source).toBeFocused();
});

test("browser global completion filters its catalogue after a typed prefix", async ({ page, baseURL }) => {
    await page.goto(browserDemo(baseURL!)); await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+End"); await source.pressSequentially("\ncalculateTotal(cart, ");
    const list = page.getByRole("listbox", { name: "Completions", exact: true });
    await source.press("Control+Space"); await expect(list).toBeVisible();
    await page.locator("#panel-content .st-viewport-row").first().click(); await expect(source).not.toBeFocused(); await expect(list).toBeHidden();
    await source.press("Control+Space"); await expect(list).toBeVisible();
    await source.press("Control+f"); await expect(page.locator(".st-find-query")).toBeFocused(); await expect(list).toBeHidden();
    await page.locator(".st-find-query").press("Escape"); await expect(source).toBeFocused();
    await source.press("Control+Space"); await expect(list).toBeVisible();
    await source.pressSequentially("Mat"); await expect(page.getByRole("option", { name: "Math", exact: true })).toBeVisible();
    await page.getByRole("option", { name: "Math", exact: true }).click(); await expect(list).toBeHidden();
    await expect(source).toBeFocused(); await expect(page.locator("#editor")).toContainText("calculateTotal(cart, Math");
});

test("dragging the scrollbar paints source rows with their line numbers during analysis", async ({ page, baseURL }, info) => {
    const source = await openRows(page, browserDemo(baseURL!));
    await expect(source).toBeVisible();
    const viewport = page.locator("#editor .st-viewport");
    if (info.project.name === "chromium") {
        // Exercise the reported native thumb drag during analysis, rather than wheel scrolling.
        const track = await viewport.evaluate(element => {
            const root = element as HTMLElement;
            const box = root.getBoundingClientRect();
            const text = root.querySelector(".st-viewport-layer")!.getBoundingClientRect();
            return { textX: Math.ceil(text.left) + 8, textY: Math.ceil(text.top) + 8,
                x: box.left + root.clientLeft + root.clientWidth + (root.offsetWidth - root.clientWidth) / 2,
                y: box.top + 25, middle: box.top + root.clientHeight / 2, width: root.offsetWidth - root.clientWidth };
        });
        expect(track.width).toBeGreaterThan(0);
        await expect(viewport.locator(".st-viewport-row").first()).toBeVisible();
        const cdp = await page.context().newCDPSession(page);
        const frames: string[] = [];
        cdp.on("Page.screencastFrame", frame => {
            frames.push(frame.data);
            void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
        });
        try {
            await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
            await page.mouse.move(track.x, track.y);
            await page.mouse.down();
            await page.mouse.move(track.x, track.middle, { steps: 20 });
            await page.mouse.up();
            await cdp.send("Page.stopScreencast");
        } finally {
            await cdp.detach();
        }
        expect(frames.length).toBeGreaterThan(1);
        const blank = await page.evaluate(async ({ frames, x, y }) => {
            const canvas = document.createElement("canvas");
            canvas.width = 192;
            canvas.height = 96;
            const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
            for (const [index, data] of frames.entries()) {
                const image = new Image();
                image.src = "data:image/png;base64," + data;
                await image.decode();
                ctx.drawImage(image, -x, -y);
                const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                // A glyph changes color within a scan line. Solid row backdrops and gutters do not count.
                let ink = 0;
                for (let p = 4; p < rgba.length; p += 4) {
                    if (p % (canvas.width * 4) && Math.abs(rgba[p]! - rgba[p - 4]!) > 24) ink++;
                }
                if (ink < 10) return index;
            }
            return null;
        }, { frames, x: track.textX, y: track.textY });
        expect(blank, "Composited frame without source text").toBeNull();
    } else await viewport.evaluate(root => { root.scrollTop = root.scrollHeight / 2; });
    await expect.poll(() => viewport.evaluate(root => {
        const box = root.getBoundingClientRect();
        const row = [...root.querySelectorAll<HTMLElement>(".st-viewport-row")].find(row => {
            const at = row.getBoundingClientRect(); return at.top >= box.top && at.bottom <= box.bottom;
        });
        const line = Number(row?.dataset.line), gutter = [...document.querySelectorAll("#editor .st-line-numbers span")];
        return line > 4000 && line < 6000 && row?.textContent === `// Row ${line + 1}: try editing or searching here.`
            && gutter.some(number => number.textContent === String(line + 1) && Math.abs(number.getBoundingClientRect().top - row!.getBoundingClientRect().top) < 1);
    })).toBe(true);
});
