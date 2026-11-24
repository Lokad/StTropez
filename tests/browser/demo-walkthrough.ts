import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { latch } from "../helpers/latch.ts";
import { paintedCharacter } from "../helpers/painted-character.ts";

export async function runDemoActions(page: Page, url = "/") {
    await page.goto(url);
    // This journey qualifies project actions; finish provider setup before switching samples.
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await page.locator("#sample").selectOption("actions");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await expect(page.locator("#editor")).toContainText("Demo project action fixture");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    const actions = page.getByRole("region", { name: "Quick fixes", exact: true });
    const size = page.viewportSize()!, viewport = page.locator("#editor .st-viewport");
    await page.setViewportSize({ width: 1100, height: 520 });
    await source.press("Control+End"); await page.keyboard.insertText("\n".repeat(80));
    await source.press("Control+Home"); await source.press("Control+.");
    await actions.getByRole("button", { name: "Demo refactor: rename exampleRate across files", exact: true }).click();
    const confirm = actions.getByRole("button", { name: "Apply fix", exact: true });
    await confirm.focus(); await viewport.evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
    await expect(actions).toBeHidden(); await expect(source).toBeFocused();
    await viewport.evaluate(el => { el.scrollTop = 0; }); await expect(confirm).toBeEnabled();
    await expect(actions.getByLabel("Quick-fix edits").locator("li")).toHaveCount(3);
    await confirm.press("Escape"); await expect(actions).toBeHidden(); await expect(source).toBeFocused();
    await source.press("Control+z"); await page.setViewportSize(size);
    const command = async (name: string) => {
        await source.press("Control+Home"); await source.press("Control+.");
        await actions.getByRole("button", { name, exact: true }).click();
        await actions.getByRole("button", { name: "Run action", exact: true }).click();
    };
    await command("Demo host: add review note");
    await expect(actions.getByLabel("Quick-fix status")).toContainText("Review note added as one undoable edit");
    await expect(page.locator("#editor")).toContainText("// Reviewed by the demo host command.");
    await actions.getByRole("button", { name: "Cancel fix", exact: true }).click(); await source.press("Control+z");
    await expect(page.locator("#editor")).not.toContainText("// Reviewed by the demo host command.");
    await command("Demo host: refactor, then fail (recovery demo)");
    await expect(actions.getByLabel("Quick-fix status")).toContainText("deliberately failed");
    await expect(actions.getByLabel("Quick-fix status")).toContainText("undoable");
    await expect(page.locator("#editor")).toContainText("import { discountRate }");
    await actions.getByRole("button", { name: "Cancel fix", exact: true }).click(); await source.press("Control+z");
    await expect(page.locator("#editor")).toContainText("import { exampleRate }");
    await command("Demo host: refactor, then check");
    await expect(actions.getByLabel("Quick-fix status")).toContainText("Project check passed after the two-file rename");
    await actions.getByRole("button", { name: "Cancel fix", exact: true }).click(); await source.press("Control+z");
    await expect(page.locator("#editor")).toContainText("import { exampleRate }");
    await source.press("Control+Home"); await source.press("Control+.");
    const choice = actions.getByRole("button", { name: "Demo refactor: rename exampleRate across files", exact: true });
    await choice.click(); await expect(actions.getByLabel("Quick-fix edits").locator("li")).toHaveCount(3);
    await expect(actions.getByLabel("Quick-fix edits")).toContainText("rate.ts");
    const apply = actions.getByRole("button", { name: "Apply fix", exact: true });
    const retiredApply = await apply.evaluateHandle(node => {
        const button = node as HTMLButtonElement, confirm = button.onclick!;
        return () => { confirm.call(button, new PointerEvent("click")); };
    });
    await apply.hover(); await page.mouse.down();
    await actions.getByRole("button", { name: "Demo host: refactor, then check", exact: true }).press("ArrowUp");
    await expect(actions.getByRole("button", { name: "Demo host: add review note", exact: true })).toHaveAttribute("data-chosen", "true");
    await expect(source).toBeFocused();
    const run = actions.getByRole("button", { name: "Run action", exact: true });
    await expect(run).toBeEnabled(); await retiredApply.evaluate(confirm => confirm()); await expect(run).toBeEnabled();
    await choice.evaluate(node => (node as HTMLButtonElement).click()); await expect(apply).toBeEnabled();
    await apply.hover(); await page.mouse.up(); await retiredApply.evaluate(confirm => confirm()); await retiredApply.dispose();
    await expect(apply).toBeEnabled();
    await expect(page.locator("#editor")).toContainText("import { exampleRate }");
    await source.press("Control+End");
    await expect(actions.getByRole("button", { name: "Apply fix", exact: true })).toBeDisabled();
    await expect(actions).toContainText("The code or selection changed");
    await page.keyboard.insertText("// Keep this later edit");
    await expect(actions).toBeHidden(); await expect(source).toBeFocused();
    await source.press("Enter");
    await source.pressSequentially("// Separate line");
    await expect(page.locator("#editor .st-viewport-row").filter({ hasText: "// Separate line" })).toHaveText("// Separate line");
    await source.press("Control+."); await choice.click();
    await actions.getByRole("button", { name: "Apply fix", exact: true }).click(); await expect(actions).toBeHidden();
    await expect(page.locator("#editor")).toContainText("import { discountRate }");
    await expect(page.locator("#editor")).toContainText("// Keep this later edit");
    await page.locator('#files [data-file="rate.ts"]').click();
    const rate = page.getByRole("textbox", { name: "rate.ts", exact: true });
    await expect(page.locator("#editor")).toContainText("export const discountRate"); await rate.press("Control+z");
    await expect(page.locator("#editor")).toContainText("export const exampleRate");
    await page.locator('#files [data-file="main.ts"]').click();
    await expect(page.locator("#editor")).toContainText("import { exampleRate }"); await expect(page.locator("#editor")).toContainText("// Keep this later edit");
    await source.press("Control+y"); await expect(page.locator("#editor")).toContainText("import { discountRate }");
    await page.locator("#save").click(); await expect(page.locator("#status")).toContainText("Saved in this browser");
    await page.reload(); await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await page.locator("#sample").selectOption("actions");
    await expect(page.locator("#editor")).toContainText("import { discountRate }");
    await page.locator('#files [data-file="rate.ts"]').click(); await expect(page.locator("#editor")).toContainText("export const discountRate");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await rate.press("Control+."); await expect(choice).toBeDisabled(); await rate.press("Escape");
}

export async function runDemoUnopenedNavigation(page: Page, url = "/") {
    await page.goto(url); await page.locator("#sample").selectOption("navigation");
    const main = page.getByRole("textbox", { name: "main.ts", exact: true }), labels = page.getByRole("textbox", { name: "labels.ts", exact: true });
    await expect(page.locator("#files button")).toHaveText(["main.ts"]);
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    // Hold the acknowledgement of one real IndexedDB commit while navigation opens its target.
    type HeldSave = { files?: Record<string, string>; acknowledge?: () => void };
    await page.evaluate(() => {
        const held: HeldSave = {}, put = IDBObjectStore.prototype.put;
        Object.assign(window, { heldNavigationSave: held });
        IDBObjectStore.prototype.put = function (row, key) {
            const tx = this.transaction;
            if (tx.db.name === "sttropez-demo-projects-v1" && key === "navigation") {
                IDBObjectStore.prototype.put = put; held.files = row.value.files;
                const complete = tx.oncomplete!;
                tx.oncomplete = event => { held.acknowledge = () => complete.call(tx, event); };
            }
            return put.call(this, row, key);
        };
    });
    await main.press("Control+s");
    await expect.poll(() => page.evaluate(() => !!(window as unknown as { heldNavigationSave: HeldSave }).heldNavigationSave.acknowledge)).toBe(true);
    await expect(page.locator("#save")).toBeDisabled();
    await expect(page.locator("#files button")).toHaveText(["main.ts"]); await expect(main).toBeFocused();
    await main.press("Control+Home");
    const cursor = "Ln 1, Col 1"; await expect(page.locator("#cursor")).toHaveText(cursor);
    const call = page.locator("#editor .st-viewport-row").filter({ hasText: "const label = formatLabel(record);" });
    const point = await paintedCharacter(call, "formatLabel", 3);
    await page.mouse.move(point.x, point.y); await page.keyboard.down("Control");
    const link = call.locator(".st-definition-link"); await expect(link).toHaveText("formatLabel");
    await expect(link).toHaveCSS("cursor", "pointer"); await expect(main).toBeFocused();
    await expect(page.locator("#cursor")).toHaveText(cursor); await expect(page.locator("#files button")).toHaveText(["main.ts"]);
    await page.keyboard.up("Control"); await expect(link).toHaveCount(0);
    await page.keyboard.down("Control"); await expect(link).toBeVisible();
    await page.mouse.click(point.x, point.y); await page.keyboard.up("Control"); await expect(labels).toBeVisible();
    await expect(page.locator("#editor")).toContainText("export function formatLabel");
    await labels.press("Control+End"); await page.keyboard.insertText("// edit the loaded module\n");
    await expect(page.locator("#files")).toContainText("labels.ts ●");
    const submitted = await page.evaluate(() => {
        const held = (window as unknown as { heldNavigationSave: HeldSave }).heldNavigationSave;
        held.acknowledge!(); return held.files!["labels.ts"];
    });
    await expect(page.locator("#status")).toHaveText("Saved in this browser. Later edits remain unsaved.");
    await expect(labels).toHaveValue(submitted + "// edit the loaded module\n"); await expect(labels).toBeFocused();
    await expect(page.locator("#files")).toContainText("labels.ts ●"); await labels.press("Control+z");
    await expect(labels).toHaveValue(submitted!); await expect(page.locator("#files")).not.toContainText("●");
    await select(page, labels, "options: LabelOptions"); await labels.press("ArrowRight"); await labels.press("ArrowLeft");
    const intermediate = await labels.evaluate(input => (input as HTMLTextAreaElement).selectionStart);
    await labels.press("F12"); await expect(main).toBeFocused();
    const reservedBack = await main.evaluate(node => {
        const event = new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, keyCode: 229, bubbles: true, cancelable: true });
        node.dispatchEvent(event); return event.defaultPrevented;
    });
    expect(reservedBack).toBe(false); await expect(main).toBeFocused();
    await main.press("Alt+ArrowLeft"); await expect(labels).toBeFocused();
    expect(await labels.evaluate(input => (input as HTMLTextAreaElement).selectionStart)).toBe(intermediate);
    await page.locator("#code-menu summary").click(); await page.getByRole("button", { name: "Back to previous location" }).click();
    await expect(main).toBeFocused();
    const sourceText = await main.inputValue(), returnOffset = sourceText.indexOf("formatLabel(record)") + 3;
    expect(await main.evaluate(input => (input as HTMLTextAreaElement).selectionStart)).toBe(returnOffset);
    await page.keyboard.type("!"); await expect(main).toHaveValue(sourceText.slice(0, returnOffset) + "!" + sourceText.slice(returnOffset));
    await main.press("Control+z"); await expect(main).toHaveValue(sourceText);
    await expect(page.locator("#navigate-back")).toBeDisabled();
    await select(page, main, "const record: RecordId"); await main.press("ArrowRight"); await main.press("ArrowLeft"); await main.press("F12");
    const declaration = page.getByRole("textbox", { name: "contracts.d.ts", exact: true }); await expect(declaration).toBeVisible();
    await expect(page.locator("#files")).toContainText("contracts.d.ts (read-only)");
    await declaration.press("Control+Home"); await declaration.press("Shift+End"); await declaration.press("Control+f");
    const declarationQuery = page.getByRole("textbox", { name: "Find text" });
    await expect(declarationQuery).toHaveValue(/An identifier supplied by a host contract/); await declarationQuery.press("Escape");
    const before = await declaration.inputValue(); await declaration.press("Control+End"); await declaration.press("x"); await expect(declaration).toHaveValue(before);
    await declaration.press("Alt+ArrowLeft"); await expect(main).toBeFocused();
    await page.locator("#save").click(); await expect(page.locator("#status")).toContainText("Saved in this browser");
    await page.reload(); await page.locator("#sample").selectOption("navigation");
    await expect(page.locator("#files button")).toHaveText(["main.ts"]); await expect(page.locator("#recovery-offer")).toBeHidden();
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await select(page, main, "export interface LabelOptions"); await main.press("ArrowRight"); await main.press("ArrowLeft"); await main.press("F2");
    const rename = page.getByRole("dialog", { name: "Rename symbol", exact: true });
    const nameField = rename.getByRole("textbox", { name: "New name", exact: true });
    await nameField.fill("DraftOptions"); await nameField.press("Enter");
    const applyRename = rename.getByRole("button", { name: "Apply rename", exact: true });
    await expect(applyRename).toBeEnabled(); await applyRename.hover(); await page.mouse.down();
    await nameField.fill("DisplayOptions"); await nameField.press("Enter");
    await expect(rename.getByLabel("Rename status")).toContainText("Review 3 changes");
    await applyRename.hover(); await page.mouse.up();
    await expect(page.locator("#editor")).toContainText("export interface LabelOptions");
    await expect(nameField).toBeFocused(); await page.keyboard.press("Enter"); await expect(rename).toBeHidden(); await expect(main).toBeFocused();
    await expect(page.locator("#editor")).toContainText("export interface DisplayOptions");
    await page.locator('#files [data-file="labels.ts"]').click(); await expect(page.locator("#editor")).toContainText("options: DisplayOptions");
    await labels.press("Control+z"); await expect(page.locator("#editor")).toContainText("options: LabelOptions");
    await page.locator('#files [data-file="main.ts"]').click(); await expect(page.locator("#editor")).toContainText("export interface LabelOptions");
    await main.press("Control+y"); await page.locator("#save").click(); await expect(page.locator("#status")).toContainText("Saved in this browser");
    await page.reload(); await page.locator("#sample").selectOption("navigation");
    await expect(page.locator("#files button")).toHaveText(["main.ts"]); await expect(page.locator("#recovery-offer")).toBeHidden();
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await expect(page.locator("#editor")).toContainText("export interface DisplayOptions");
    await select(page, main, "const label = formatLabel"); await main.press("ArrowRight"); await main.press("ArrowLeft"); await main.press("F12");
    await expect(labels).toBeVisible(); await expect(page.locator("#editor")).toContainText("options: DisplayOptions");
}

/** Shared by source, static and restored-assets demos; all commands use visible controls. */
export async function runDemoDocumentation(page: Page, url = "/") {
    const guide = "https://www.typescriptlang.org/docs/handbook/2/functions.html";
    await page.context().route(guide, route => route.fulfill({ contentType: "text/html", body: "<title>Permitted help destination</title>" }));
    await page.goto(url + "?sample=documentation");
    const source = page.getByRole("textbox", { name: "documentation.ts", exact: true });
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await select(page, source, "const discounted = applyDiscount"); await source.press("ArrowRight"); await source.press("ArrowLeft");
    await source.press("Control+k"); await source.press("Control+i");
    const hover = page.locator(".demo-language-popups .host-symbol-info:not(.host-signature)");
    const caret = page.locator("#editor .st-input-caret");
    const clearsLine = async (popup: Locator) => {
        const line = await caret.boundingBox(), box = await popup.boundingBox();
        return !!line && !!box && (box.y >= line.y + line.height || box.y + box.height <= line.y);
    };
    await expect(hover.locator("strong").first()).toHaveText("percentage discount");
    await expect(hover.locator("em").first()).toHaveText("ten percent"); await expect(hover.locator("ul li")).toHaveCount(2);
    await expect(hover.locator("ul li").first()).toHaveText("Keeps price unchanged.");
    await expect(hover.locator("pre code").last()).toContainText("applyDiscount(50, 0.1)");
    await expect.poll(() => clearsLine(hover)).toBe(true);
    expect(await hover.evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth; })).toBe(true);
    const position = await page.locator("#cursor").innerText(), phrase = hover.locator("strong").first();
    const firstWord = await paintedCharacter(phrase, "percentage discount", 2);
    await page.mouse.dblclick(firstWord.x, firstWord.y);
    const selection = () => page.evaluate(() => window.getSelection()?.toString().trim());
    await expect.poll(selection).toBe("percentage");
    await page.keyboard.down("Control"); await expect.poll(selection).toBe("percentage"); await page.keyboard.up("Control");
    await page.keyboard.press("Escape"); await expect(hover).toBeHidden(); await expect(source).toBeFocused();
    await expect(page.locator("#cursor")).toHaveText(position);
    await source.press("Control+k"); await source.press("Control+i");
    const opened = page.context().waitForEvent("page"); await hover.getByRole("button", { name: "TypeScript function guide", exact: true }).click();
    const help = await opened; await expect(help).toHaveURL(guide); expect(await help.evaluate(() => window.opener)).toBeNull(); await help.close();
    await source.press("Escape");
    await select(page, source, "const discounted = applyDiscount(50,"); await source.press("ArrowRight"); await source.press("Control+Shift+Space");
    const signature = page.getByRole("tooltip", { name: "Signature help", exact: true });
    await expect(signature.getByLabel("Active signature parameter")).toContainText("rate");
    await expect(signature.locator("strong").first()).toHaveText("percentage discount"); await expect(signature.locator("ul li")).toHaveCount(2);
    await expect(signature.locator("ul li").first()).toHaveText("Keeps price unchanged.");
    await expect(signature.locator(".st-documentation").last().locator("code")).toHaveText(["0", "1"]);
    const overload = signature.getByLabel("Active signature parameter");
    const cursor = page.locator("#cursor"), callPosition = await cursor.innerText();
    await source.press("ArrowDown"); await expect(overload).toContainText("deduction");
    const previous = signature.getByRole("button", { name: "Previous signature" });
    await expect(previous).toHaveAttribute("title", "↑"); await previous.click(); await expect(overload).toContainText("rate");
    await expect(source).toBeFocused(); await expect(cursor).toHaveText(callPosition);
    await expect.poll(() => clearsLine(signature)).toBe(true);
    expect(await signature.evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; })).toBe(true);
    await source.pressSequentially("M");
    const completions = page.getByRole("listbox", { name: "Completions", exact: true });
    await expect(completions.getByRole("option").first()).toBeVisible();
    await expect(signature.getByLabel("Active signature parameter")).toContainText("rate");
    await expect.poll(async () => {
        const list = await completions.boundingBox(), help = await signature.boundingBox();
        return !!list && !!help && list.height > 0 && help.height > 0
            && (list.y + list.height <= help.y || help.y + help.height <= list.y);
    }, { message: "Completion and signature help stay readable while typing an argument" }).toBe(true);
    await expect(source).toBeFocused();
    const chosen = completions.getByRole("option", { selected: true });
    const first = await chosen.textContent();
    await source.press("ArrowDown"); await expect(chosen).not.toHaveText(first!); await expect(overload).toContainText("rate");
    await source.press("Escape"); await expect(completions).toBeHidden();
    await source.press("Control+z");
    await source.press("Escape"); await expect(signature).toBeHidden(); await expect(page.locator("#files")).not.toContainText("●");
    await page.context().unroute(guide);
    // The same public metadata decoder feeds Problems. Real compiler errors and an explicit
    // host fixture cover related declarations, tags and help without inventing TS capabilities.
    const diagnosticGuide = "https://www.typescriptlang.org/docs/handbook/2/everyday-types.html";
    await page.context().route(diagnosticGuide, route => route.fulfill({ contentType: "text/html", body: "<title>Diagnostic help</title>" }));
    await page.locator("#sample").selectOption("diagnostics");
    await expect(hover).toBeHidden();
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await page.locator('[data-panel="problems"]').click();
    const problems = page.locator(".demo-problems"), error = problems.locator(".demo-problem").filter({ hasText: "TS2322:" });
    const warning = problems.locator(".demo-problem").filter({ hasText: "legacy-price:" });
    await expect(error).toContainText("Error · typescript"); await expect(warning).toContainText("Warning · Demo host · Deprecated");
    await error.locator("summary").click(); await error.getByRole("button", { name: /types.ts:2:3/ }).click();
    const types = page.getByRole("textbox", { name: "types.ts", exact: true }); await expect(types).toBeFocused();
    await expect(page.locator("#cursor")).toHaveText("Ln 2, Col 8");
    const mounted = await types.elementHandle(), fold = page.locator("#editor .st-fold-button").first();
    await fold.click(); await expect(fold).toHaveAttribute("aria-expanded", "false");
    const related = error.getByRole("button", { name: /types.ts:2:3/ });
    if (!await related.isVisible()) await error.locator("summary").click();
    await related.click(); await expect(types).toBeFocused();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#editor .st-viewport-selected")).toHaveText("price");
    expect(await mounted!.evaluate(input => input.isConnected)).toBe(true);
    await warning.locator("summary").click(); await warning.getByRole("button", { name: /Replacement declared here/ }).click();
    const details = page.getByRole("textbox", { name: "details.ts", exact: true }); await expect(details).toBeFocused();
    await expect(page.locator("#cursor")).toHaveText("Ln 4, Col 19");
    const helpOpening = page.context().waitForEvent("page"); await warning.getByRole("button", { name: "Diagnostic help", exact: true }).click();
    const diagnosticHelp = await helpOpening; await expect(diagnosticHelp).toHaveURL(diagnosticGuide);
    expect(await diagnosticHelp.evaluate(() => window.opener)).toBeNull(); await diagnosticHelp.close();
    await warning.getByRole("button", { name: /^details\.ts:\d+:\d+ · legacy-price:/ }).click(); await page.keyboard.insertText("currentPrice");
    await expect(warning).toHaveCount(0); await expect(error).toBeVisible();
    await details.press("Control+z"); await expect(warning).toBeVisible();
    await page.locator("#sample").selectOption("pricing"); await expect(problems).toContainText("No problems in this project.");
    await page.context().unroute(diagnosticGuide);
}

export async function runDemoHighlights(page: Page, url = "/", distinctWrites = false) {
    await page.goto(url);
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    const replace = async (text: string) => { await source.press("Control+a"); await page.keyboard.insertText(text); };
    await replace("let value = 1;\nvalue = value + 1;\n");
    await source.press("Control+Home"); await source.press("Control+ArrowRight"); await source.press("ArrowRight");
    const writes = page.locator("#editor .demo-occurrence-write"), reads = page.locator("#editor .demo-occurrence-read");
    const occurrences = page.locator("#editor .demo-occurrence-write, #editor .demo-occurrence-read");
    await expect(occurrences).toHaveText(["value", "value", "value"], { timeout: 30000 });
    // The pinned Node server reports all these spans as reads; the compiler-backed static
    // provider distinguishes writes. Preserve provider semantics instead of inventing kinds.
    await expect(writes).toHaveCount(distinctWrites ? 2 : 0); await expect(reads).toHaveCount(distinctWrites ? 1 : 3);
    const continuity = await page.locator("#editor").evaluateHandle(root => {
        let minimum = 3;
        const observer = new MutationObserver(() => {
            minimum = Math.min(minimum, root.querySelectorAll(".demo-occurrence-read, .demo-occurrence-write").length);
        });
        observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
        return () => { observer.disconnect(); return minimum; };
    });
    await source.press("ArrowRight");
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await continuity.evaluate(stop => stop())).toBe(3); await continuity.dispose();
    await page.locator("#find-toggle").click(); await page.locator("#find-query").fill("value");
    await expect(page.locator("#find-status")).toHaveText(/^[1-3] of 3$/);
    await page.locator("#find-next").click(); await source.focus();
    await expect(occurrences).toHaveCount(3);
    const matches = page.locator("#editor .st-search-match");
    await expect(matches).toHaveCount(3);
    const outlines = await matches.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).outlineColor));
    expect(outlines.filter(color => color === "rgb(255, 228, 148)")).toHaveLength(1);
    expect(new Set(outlines).size).toBe(2);
    await page.locator("#find-close").click();
    await source.press("Control+Home"); await source.press("Control+ArrowRight"); await source.press("ArrowRight");
    await expect(occurrences).toHaveCount(3);
    await source.dispatchEvent("compositionstart", { data: "" }); await expect(occurrences).toHaveCount(0);
    await source.dispatchEvent("compositionend", { data: "" }); await expect(occurrences).toHaveCount(3);
    await source.press("Control+End"); await expect(occurrences).toHaveCount(0);
    await source.press("ArrowUp"); await source.press("Home");
    await expect(occurrences).toHaveCount(3);
    await source.press("Shift+End"); await source.press("Backspace"); await expect(occurrences).toHaveCount(0);
    await source.press("Control+z"); await source.press("Home"); await expect(occurrences).toHaveCount(3);
    await page.getByRole("button", { name: "pricing.ts", exact: true }).click(); await expect(occurrences).toHaveCount(0);
    await page.locator("#files").getByRole("button", { name: /^main\.ts/ }).click();
    await replace("let value = 1;\n" + "value += 1;\n".repeat(10000));
    await source.press("Control+Home"); await source.press("Control+ArrowRight"); await source.press("ArrowRight"); await expect(occurrences.first()).toHaveText("value", { timeout: 30000 });
    const viewport = page.locator("#editor .st-viewport");
    await viewport.evaluate(node => { node.scrollTop = node.scrollHeight / 2; });
    await expect.poll(async () => Number(await page.locator("#editor .st-viewport-row").first().getAttribute("data-line"))).toBeGreaterThan(4000);
    await expect(occurrences.first()).toHaveText("value");
    expect(await page.locator("#editor .st-viewport-row").count()).toBeLessThan(100);
    expect(await occurrences.count()).toBeLessThan(100);
}

export async function runDemoFolding(page: Page, url = "/") {
    await page.clock.install();
    page.on("dialog", dialog => dialog.accept());
    await page.goto(url);
    await page.getByRole("button", { name: "pricing.ts", exact: true }).click();
    const source = page.getByRole("textbox", { name: "pricing.ts", exact: true });
    await expect(page.locator("#editor .st-fold-button").first()).toBeVisible({ timeout: 30000 });
    const menu = async (id: string) => { await page.locator("#code-menu summary").click(); await page.locator(`#${id}`).click(); };
    await source.press("Control+Home"); await source.press("Control+Shift+[");
    await expect(page.locator('#editor .st-fold-button[aria-expanded="false"]')).toHaveCount(1);
    await expect(page.locator("#editor .st-viewport-row")).not.toContainText(["name: string;"]);
    await source.press("Control+End"); await page.keyboard.insertText("// after\n");
    await expect(page.locator("#folding-status")).toContainText("1 collapsed", { timeout: 30000 });
    await source.press("Control+z"); await expect(page.locator("#folding-status")).toContainText("1 collapsed");
    await source.press("Control+Home"); await source.press("Control+Shift+]");
    await expect(page.locator('#editor .st-fold-button[aria-expanded="false"]')).toHaveCount(0);
    // The plain off-side host remains useful without any language-provider request.
    await page.locator("#sample").selectOption("outline");
    const outline = page.getByRole("textbox", { name: "workflow.txt", exact: true });
    await expect(page.locator("#language-status")).toHaveText("Host outline · no language server");
    await expect(page.locator("#folding-status")).toContainText("7 folds");
    await page.locator("#code-menu summary").click();
    const primary = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Cmd" : "Ctrl");
    await expect(page.locator("#fold")).toHaveAttribute("data-shortcut", `${primary}+Shift+[`);
    await page.locator("#fold-group").selectOption("regions"); await page.locator("#fold-group-collapse").click();
    await expect(page.locator('#editor .st-fold-button[aria-expanded="false"]')).toHaveCount(1);
    await expect(page.locator('#editor .st-viewport-row[data-line="8"]')).toHaveCount(0);
    expect((await page.locator("#editor .st-line-numbers span").allTextContents()).map(Number).sort((a, b) => a - b))
        .toEqual(await page.locator("#editor .st-viewport-row").evaluateAll(rows => rows.map(row => Number((row as HTMLElement).dataset.line) + 1).sort((a, b) => a - b)));
    await page.locator("#find-toggle").click(); await page.locator("#find-query").fill("validate");
    await expect(page.locator("#find-status")).toHaveText("1 of 1"); await page.locator("#find-next").click(); await page.locator("#find-close").click();
    await expect(page.locator('#editor .st-viewport-row[data-line="8"]')).toContainText("validate");
    await page.keyboard.insertText("checked");
    await expect.poll(() => outline.inputValue()).toContain("checked");
    await outline.press("Control+z"); await expect.poll(() => outline.inputValue()).toContain("validate");
    await menu("fold-group-collapse");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    const panes = page.locator(".st-comparison-panes > section"), left = panes.first(), right = panes.last();
    await expect(left.locator(".st-fold-button").first()).toBeVisible();
    await expect(left.locator('.st-fold-button[aria-expanded="false"]')).toHaveCount(0);
    await expect(right.locator('.st-fold-button[aria-expanded="false"]')).toHaveCount(1);
    const saved = left.getByRole("textbox");
    await saved.press("Control+Home"); await saved.press("Control+Shift+BracketLeft");
    await expect(left.locator('.st-fold-button[aria-expanded="false"]')).toHaveCount(1);
    await expect(saved).toBeFocused();
    await expect(page.locator("#folding-status")).toContainText("Saved copy ·");
    await menu("fold-group-expand");
    await expect(left.locator('.st-fold-button[aria-expanded="false"]')).toHaveCount(0);
    await expect(right.locator('.st-fold-button[aria-expanded="false"]')).toHaveCount(1);
    await right.getByRole("textbox").focus();
    await expect(page.locator("#folding-status")).toContainText("Your changes ·");
    await menu("fold-group-expand");
    await expect(right.locator('.st-fold-button[aria-expanded="false"]')).toHaveCount(0);

    // Both TypeScript snapshots use syntax colors/outlining; review fold choices stay independent.
    const bootstrap = latch<void>();
    await page.route(url => url.pathname === "/demo-provider" && url.searchParams.get("sample") === "navigation", async route => {
        await bootstrap.promise;
        await route.continue();
    }, { times: 1 });
    await page.locator('[data-panel="javascript"]').click();
    await page.locator("#sample").selectOption("navigation");
    const imports = page.getByRole("textbox", { name: "main.ts", exact: true });
    const header = page.locator('#editor .st-viewport-row[data-line="0"]');
    try {
        await expect(imports).toHaveValue(/import type \{ RecordId \}/);
        await page.clock.runFor(250); // Start debounced discovery before the language URI is assigned.
    } finally {
        bootstrap.resolve();
    }
    await expect(page.locator("#folding-status")).toHaveText("Source · 0 folds · 0 collapsed", { timeout: 30000 });
    await page.locator("#code-menu summary").click();
    for (const id of ["fold", "unfold", "fold-group-collapse", "fold-group-expand"]) await expect(page.locator(`#${id}`)).toBeDisabled();
    await page.locator("#code-menu summary").click();
    await expect(page.locator("#editor .st-fold-button")).toHaveCount(0);
    await imports.press("Control+Home"); await imports.press("ArrowDown"); await imports.press("ArrowDown"); await imports.press("Home");
    await page.keyboard.insertText('import "./labels";\n');
    const original = await imports.inputValue();
    await page.getByRole("button", { name: "Save locally", exact: true }).click();
    const collapse = page.locator("#editor").getByRole("button", { name: "Collapse imports", exact: true });
    await expect(collapse).toHaveAttribute("title", "Collapse imports", { timeout: 30000 });
    await imports.press("Control+End"); await page.locator("#code-menu summary").click();
    await page.locator("#fold-group").selectOption("imports");
    await expect(page.locator("#fold")).toBeDisabled(); await expect(page.locator("#fold-group-collapse")).toBeEnabled();
    await expect(page.locator("#fold-group-expand")).toBeDisabled(); await page.locator("#code-menu summary").click();
    await collapse.click();
    await expect(header.locator(".st-fold-summary")).toHaveAttribute("data-label", "… 2 lines hidden");
    await expect(imports).toHaveValue(original); await expect(page.locator('#editor .st-viewport-row[data-line="1"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    const expectColoredImport = (pane: typeof left) => expect.poll(async () => {
        const parts = await pane.locator('.st-viewport-row[data-line="0"] .demo-token-keyword').allTextContents();
        return parts.join("");
    }).toMatch(/^import/);
    await expectColoredImport(left); await expectColoredImport(right);
    await expect(left.getByRole("button", { name: "Collapse imports" })).toHaveAttribute("aria-expanded", "true");
    await expect(right.getByRole("button", { name: "Expand imports" })).toHaveAttribute("aria-expanded", "false");
    const rightSummary = right.locator(".st-fold-summary");
    await expect(rightSummary).toHaveAttribute("data-label", "… 2 lines hidden");
    await rightSummary.click(); await expect(rightSummary).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Comparison working source", exact: true })).toBeFocused();
    await expect.poll(() => right.locator(".st-viewport-row").allTextContents()).toEqual(await left.locator(".st-viewport-row").allTextContents());
    await saved.press("Control+Home"); await saved.press("ArrowRight"); await saved.press("Shift+ArrowLeft");
    await left.locator(".st-fold-button").click(); await expect(right.locator(".st-fold-button")).toHaveAttribute("aria-expanded", "true");
    await left.locator(".st-fold-summary").dblclick(); await expect(saved).toBeFocused();
    expect(await saved.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection]))
        .toEqual([0, 1, "backward"]);
    const working = page.getByRole("textbox", { name: "Comparison working source", exact: true });
    await working.press("Control+Home"); await working.press("ArrowDown"); await working.press("Home"); await working.press("Shift+End"); await working.press("Delete");
    await expect(right.locator(".st-fold-button")).toHaveCount(0); await expect(left.locator(".st-fold-button")).toHaveCount(1);
    await expectColoredImport(left); await expect(left).toContainText('import type { RecordId }');
    await page.getByRole("button", { name: "Next change", exact: true }).click();
    await expect(page.locator(".st-comparison-preview")).toContainText('import·type');
    await working.press("Control+z"); await expect(right.locator(".st-fold-button")).toHaveCount(1);
    await working.press("Control+Home"); await page.keyboard.insertText("// working only\n");
    await expect(right.locator(".demo-token-comment")).toHaveText("// working only"); await expect(left).not.toContainText("// working only");
    await page.getByRole("button", { name: "Save locally", exact: true }).click();
    await expect(left.locator(".demo-token-comment")).toHaveText("// working only");
    await expect(page.locator(".st-comparison-controls output")).toHaveText("No changes");
    await expect(left.locator(".st-fold-button")).toHaveCount(1);
    await right.locator(".st-fold-button").click(); await page.locator('[data-panel="javascript"]').click();
    await expect(page.locator("#editor .st-fold-summary")).toHaveAttribute("data-label", "… 2 lines hidden");
    await expect(imports).toHaveValue("// working only\n" + original);
}

export async function runDemoFoldingBoundaries(page: Page, url = "/") {
    await page.goto(url);
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    const branches = ["if (true) {", "  first(); // draft", "} else {", "  second();", "} const after = 1;", "function empty() {", "}"];
    await source.press("Control+a"); await page.keyboard.insertText(branches.join("\n"));
    await page.getByRole("button", { name: "Save locally", exact: true }).click();
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page.locator(".st-comparison-controls output")).toHaveText("No changes");
    const panes = page.locator(".st-comparison-panes > section"), left = panes.first(), right = panes.last();
    const working = right.getByRole("textbox");
    await working.press("Control+Home"); await working.press("ArrowDown"); await working.press("End");
    await working.press("Control+Shift+ArrowLeft"); await page.keyboard.insertText("reviewed");
    const status = page.locator(".st-comparison-controls output");
    await expect(status).toHaveText(/1 change|Change 1 of 1/);
    for (const pane of [left, right]) {
        // Analysis can replace a token between two Playwright calls. Read the current
        // word and both painted backgrounds together from the mounted pane.
        await expect.poll(() => pane.evaluate((root, word) => {
            const span = root.querySelector(".demo-token-comment:is(.st-comparison-added, .st-comparison-removed)");
            const row = span?.closest(".st-viewport-row");
            if (!span || !row || span.textContent !== word) return 0;
            const luminance = (rgb: string) => {
                const channels = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(rgb);
                if (!channels) return NaN;
                const [r, g, b] = channels.slice(1).map(part => {
                    const v = Number(part) / 255;
                    return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
                });
                return .2126 * r! + .7152 * g! + .0722 * b!;
            };
            const ink = luminance(getComputedStyle(span).color);
            return Math.min(...[span, row].map(el => (ink + .05) / (luminance(getComputedStyle(el).backgroundColor) + .05)));
        }, pane === left ? "draft" : "reviewed")).toBeGreaterThanOrEqual(4.5);
        const toggles = pane.locator(".st-fold-button");
        await expect(toggles).toHaveCount(2);
        await toggles.first().click(); await toggles.last().click();
        await expect(pane.locator(".st-viewport-row")).toHaveText([branches[0]!, branches[2]!, ...branches.slice(4)]);
        const summaries = pane.locator(".st-fold-summary");
        await expect(summaries.first()).toHaveAttribute("data-label", "… 1 line hidden · contains changes");
        await expect(summaries.last()).toHaveAttribute("data-label", "… 1 line hidden");
        await expect.poll(() => pane.evaluate(root => {
            const summary = root.querySelector(".st-fold-summary");
            const layer = summary?.closest(".st-viewport-layer")?.getBoundingClientRect();
            if (!summary || !layer) return false;
            const box = summary.getBoundingClientRect();
            return box.width > 0 && box.left >= layer.left && box.right <= layer.right;
        })).toBe(true);
    }
    await left.locator(".st-fold-button").first().click();
    await expect(left.locator('.st-viewport-row[data-line="1"]')).toHaveText(branches[1]!);
    await expect(right.locator('.st-viewport-row[data-line="1"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Next change", exact: true }).click();
    await expect(right.locator('.st-viewport-row[data-line="1"]')).toContainText("// reviewed");
    await page.getByRole("button", { name: "Use baseline", exact: true }).click();
    await expect(status).toHaveText("No changes");
    for (const pane of [left, right]) {
        await pane.locator(".st-fold-button").first().click();
        await expect(pane.locator(".st-fold-summary").first()).toHaveAttribute("data-label", "… 1 line hidden");
    }
}

export async function runDemoEditingRules(page: Page, url = "/") {
    await page.goto(url);
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await expect(source).toBeVisible();
    const replace = async (text: string) => { await source.press("Control+Home"); await source.press("Control+a"); await page.keyboard.insertText(text); };
    const menu = async (name: string) => { await page.locator("#code-menu summary").click(); await page.getByRole("button", { name, exact: true }).click(); };
    const indentation = async (value: string) => {
        await page.locator("#code-menu summary").click(); await page.locator("#indentation").selectOption(value);
        await expect(page.locator("#code-menu")).toHaveJSProperty("open", false); await expect(source).toBeFocused();
    };
    await source.press("Control+Home");
    for (let i = 0; i < 3; i++) await source.press("ArrowDown");
    await source.press("End"); await source.press("Enter"); await page.keyboard.insertText("probe");
    await expect(source).toHaveValue(/CartItem\[\] = \[\n    probe\n    \{ name: "Notebook"/);
    await indentation("2");
    await replace("function demo() {}"); await source.press("ArrowLeft");
    await expect(page.locator("#editor .st-matching-bracket")).toHaveText(["{", "}"]);
    await source.press("Enter");
    await expect(source).toHaveValue("function demo() {\n  \n}");
    await source.pressSequentially('"'); await expect(source).toHaveValue('function demo() {\n  ""\n}');
    await source.pressSequentially('value";'); await source.press("Escape");
    await expect(source).toHaveValue('function demo() {\n  "value";\n}');
    await source.press("Control+Home"); await source.press("Shift+End");
    const code = page.locator("#code-menu summary"), blockComment = page.getByRole("button", { name: "Toggle block comment", exact: true });
    await code.press("Enter"); await page.locator("#line-comment").press("ArrowDown"); await expect(blockComment).toBeFocused();
    await page.keyboard.press("Enter"); await expect(source).toBeFocused();
    await expect(source).toHaveValue('/* function demo() { */\n  "value";\n}');
    await menu("Toggle block comment"); await expect(source).toHaveValue('function demo() {\n  "value";\n}');
    await source.press("Control+a"); await source.press("Control+/");
    await expect(source).toHaveValue('// function demo() {\n//   "value";\n// }');
    await source.press("Control+k"); await source.press("Control+u");
    await expect(source).toHaveValue('function demo() {\n  "value";\n}');
    await source.press("Control+z"); await expect(source).toHaveValue('// function demo() {\n//   "value";\n// }');
    await source.press("Control+z"); await expect(source).toHaveValue('function demo() {\n  "value";\n}');
    await replace("/*\n[comment]\n*/\n"); await expect(page.locator("#analysis-status")).toContainText("syntax & emit");
    await source.press("Control+Home"); await source.press("ArrowDown"); await source.press("End");
    await expect(page.locator("#editor .st-matching-bracket")).toHaveCount(0);
    await source.pressSequentially('"'); await expect(source).toHaveValue('/*\n[comment]"\n*/\n');
    await replace('const marker = "/*";\n/* value */');
    await source.press("Control+End"); for (let i = 0; i < 5; i++) await source.press("ArrowLeft");
    await source.press("Shift+Alt+a"); await expect(source).toHaveValue('const marker = "/*";\nvalue');
    await page.keyboard.type("!"); await expect(source).toHaveValue('const marker = "/*";\nval!ue');
    await source.press("Control+z"); await source.press("Control+z"); await expect(source).toHaveValue('const marker = "/*";\n/* value */');
    const block = "      a\n\n \t\n\t  b\n";
    await replace(block); await source.press("Control+End"); await source.press("Control+Shift+Home"); await menu("Indent lines");
    await expect(source).toHaveValue("        a\n\n \t\n\t    b\n"); await source.press("Control+z");
    await indentation("4");
    await source.press("Tab"); await expect(source).toHaveValue("        a\n\n \t\n\t    b\n");
    expect(await source.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([0, block.length + 4, "backward"]);
    await source.press("Control+z"); await expect(source).toHaveValue(block);
    await source.press("Shift+Tab"); await expect(source).toHaveValue("    a\n\n \t\n\tb\n"); await source.press("Control+z");
    await indentation("tabs");
    await source.press("Tab"); await expect(source).toHaveValue("      \ta\n\n \t\n\t  \tb\n");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    expect(await page.locator(".st-comparison .st-editor").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).tabSize))).toEqual(["4", "4"]);
    await page.getByRole("textbox", { name: "Comparison working source", exact: true }).press("Control+z");
    await expect(page.getByRole("textbox", { name: "Comparison working source", exact: true })).toHaveValue(block);
    await page.getByRole("textbox", { name: "Comparison baseline source", exact: true }).focus();
    await page.locator("#code-menu summary").click();
    const comment = page.locator("#line-comment");
    await comment.evaluate(node => (node as HTMLButtonElement).click());
    await expect(page.getByRole("textbox", { name: "Comparison working source", exact: true })).toHaveValue(block);
    await expect(comment).toBeDisabled(); await code.press("ArrowDown"); await expect(page.locator("#go-to-line")).toBeFocused();
    await page.keyboard.press("Escape"); await expect(code).toBeFocused();
    await page.getByRole("button", { name: "JavaScript", exact: true }).click();
    const generated = page.getByRole("textbox", { name: "JavaScript output", exact: true });
    await generated.focus(); await menu("Go to line");
    const line = page.getByRole("dialog", { name: "Go to line" }).getByRole("textbox");
    await line.fill("2"); await line.press("Enter");
    await expect(generated).toBeFocused(); await expect(page.locator("#cursor")).toHaveText("Ln 2, Col 1");
    // Reading and removing the outer comment on every row takes several planning turns.
    await replace("// // pending\n".repeat(4096));
    await expect(page.locator("#recovery-status")).toHaveText("Recovery draft captured in this browser.");
    await source.press("Control+a");
    await source.evaluate(input => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true, cancelable: true }));
        document.querySelector<HTMLButtonElement>("#save")!.click();
    });
    await expect(page.locator("#status")).toHaveText("An edit is still in progress. Save again when it finishes.");
    await source.press("Control+Home"); await expect(page.locator("#cursor")).toHaveText("Ln 1, Col 1");
    await expect.poll(async () => (await source.inputValue()).startsWith("// pending")).toBe(true);
    await page.getByRole("button", { name: "Save locally", exact: true }).click();
    await expect(page.locator("#status")).toContainText("Saved in this browser");
    await expect(page.locator("#files")).not.toContainText("●");
    await page.reload(); await expect.poll(async () => (await source.inputValue()).startsWith("// pending")).toBe(true);
    await expect(page.locator("#recovery-status")).not.toHaveText("Checking recovery…");
    await expect(page.locator("#recovery-offer")).toBeHidden();
}

/** The labeled template provider shares the public completion/input/history paths. */
export async function runDemoSnippets(page: Page, url = "/") {
    page.on("dialog", dialog => dialog.accept());
    await page.setViewportSize({ width: 1100, height: 520 });
    await page.goto(`${url}${url.includes("?") ? "&" : "?"}sample=templates`);
    const source = page.getByRole("textbox", { name: "templates.ts", exact: true }), editor = page.locator("#editor");
    const markers = editor.locator(".st-snippet-field");
    const controls = page.getByRole("region", { name: "Snippet controls", exact: true });
    const expectFieldsUncovered = async (pane: Locator) => {
        await expect.poll(async () => {
            const bar = await controls.boundingBox(), workspace = await page.locator("#workspace").boundingBox();
            if (!bar || !workspace || bar.y < 0 || bar.y + bar.height > workspace.y + 1) return false;
            return pane.locator(".st-viewport").evaluate(viewport => {
                const bounds = viewport.getBoundingClientRect();
                return Array.from(viewport.querySelectorAll(".st-viewport-selected")).some(selection => {
                    const field = selection.getBoundingClientRect();
                    return field.top >= bounds.top - 1 && field.bottom <= bounds.bottom + 1;
                });
            });
        }, { message: "A selected snippet field and its controls remain visible in separate areas" }).toBe(true);
    };
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    const request = async (input = source) => { await input.press("Control+End"); await input.press("Control+Space");
        await expect(page.getByRole("option", { name: "Template · linked placeholders", exact: true })).toBeVisible(); };
    await request(); await expect(page.locator(".demo-completion-count")).toContainText("1 unsupported");
    await source.press("Tab"); await expect(controls).toContainText("Field 1 of 3");
    await expectFieldsUncovered(editor);
    await expect(markers).toHaveText(["draft", "0"]); await expect(markers.first()).toHaveCSS("outline-style", "dotted");
    await expect(editor).toContainText("console.log(record)");
    await source.press("Control+z"); await expect(controls).toBeHidden(); await expect(editor).not.toContainText("console.log");
    await expect(markers).toHaveCount(0);
    await source.press("Control+y"); await expect(editor).toContainText("console.log(record)"); await expect(controls).toBeHidden();
    await page.getByRole("button", { name: "Reset sample", exact: true }).click(); await request(); await source.press("Tab");
    await expect(controls).toContainText("Field 1 of 3"); await source.press("Control+Space");
    await expect(controls).toContainText("Field 1 of 3"); await source.pressSequentially("entry");
    await expect(editor).toContainText("const entry"); await expect(editor).toContainText("console.log(entry)");
    const previousField = await controls.getByRole("button", { name: "Finish snippet" }).elementHandle();
    await source.press("Tab"); await expect(controls).toContainText("Field 2 of 3");
    await expect(markers).toHaveText(["entry", "0", "entry"]);
    await previousField!.evaluate(button => button.dispatchEvent(new MouseEvent("click", { bubbles: true }))); await previousField!.dispose();
    await expect(controls).toContainText("Field 2 of 3");
    await source.press("Alt+ArrowDown"); await expect(controls.getByRole("button", { name: "ready", exact: true })).toHaveAttribute("aria-pressed", "true");
    await source.press("Shift+Tab"); await expect(controls).toContainText("Field 1 of 3");
    await source.evaluate(node => {
        const input = node as HTMLTextAreaElement;
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        input.setRangeText("項目", input.selectionStart, input.selectionEnd, "end");
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true }));
        input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "項目" }));
    });
    await expect(editor).toContainText("const 項目"); await expect(editor).toContainText("console.log(項目)");
    await source.press("Tab"); await controls.getByRole("button", { name: "archived", exact: true }).click();
    await expect(source).toBeFocused(); await expect(editor).toContainText('state: "archived"');
    await source.press("Tab"); await expect(controls).toContainText("Field 3 of 3");
    await source.press("Backspace"); await source.press("Shift+Tab");
    await expect(editor.locator('.st-snippet-field[data-ornament="point"]')).toHaveCount(1);
    await source.press("Tab");
    await source.evaluate(node => {
        const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
        event.clipboardData!.setData("text/plain", "42");
        if (event.clipboardData!.getData("text/plain") !== "42") throw new Error("Synthetic clipboard fixture lost its data.");
        node.dispatchEvent(event);
    });
    await expect(editor).toContainText("value: 42"); await source.press("Tab"); await expect(controls).toBeHidden();
    await expect(markers).toHaveCount(0);
    await source.pressSequentially("// Finished"); await expect(editor).toContainText("console.log(項目);// Finished");
    await source.press("Control+z"); await expect(editor).not.toContainText("// Finished");
    await page.getByRole("button", { name: "Reset sample", exact: true }).click(); await request(); await source.press("ArrowDown"); await source.press("Tab");
    await expect(controls).toContainText("Field 1 of 2");
    await expect(editor).toContainText('import type { TemplateRecord } from "./types";');
    await expect(editor).toContainText("console.log(result)");
    await source.press("Control+z"); await expect(editor).not.toContainText("TemplateRecord"); await expect(controls).toBeHidden();
    await request(); await source.press("ArrowDown"); await source.press("Enter"); await expect(controls).toContainText("Field 1 of 2");
    await source.press("Escape"); await expect(controls).toBeHidden(); await source.pressSequentially("other");
    await expect(markers).toHaveCount(0);
    await expect(editor).toContainText("const other:"); await expect(editor).toContainText("console.log(result)");
    await page.getByRole("button", { name: "Reset sample", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 700 });
    await page.locator('[data-panel="changes"]').click();
    const panes = page.locator(".st-comparison-panes > section"), working = panes.last().getByRole("textbox");
    await request(working); await working.press("Tab"); await expect(controls).toBeVisible();
    await expectFieldsUncovered(panes.last());
    await expect(panes.last().locator(".st-snippet-field")).toHaveText(["draft", "0"]);
    await expect(panes.first().locator(".st-snippet-field")).toHaveCount(0);
    await page.locator('[data-file="types.ts"]').click(); await expect(controls).toBeHidden();
    await page.locator('[data-file="templates.ts"]').click(); await expect(panes.last()).toContainText("console.log(record)"); await expect(controls).toBeHidden();
    await expect(panes.locator(".st-snippet-field")).toHaveCount(0);
    return Object.freeze({ linkedEdits: true, tabTraversal: true, choices: true, finalCaret: true, syntheticComposition: true, syntheticPaste: true,
        lazyPrimaryAndAdditionalEdits: true, history: true, escapeAndViewLifetime: true, native: "IME and OS clipboard UNVERIFIED" });
}

/** Complete provider lists stay navigable while the host bounds rendered rows. */
export async function runDemoCompletionCatalogue(page: Page, url = "/") {
    await page.goto(`${url}${url.includes("?") ? "&" : "?"}sample=catalogue`);
    const source = page.getByRole("textbox", { name: "catalogue.ts", exact: true });
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await source.press("Control+End"); await source.pressSequentially("catalogue.");
    await source.press("Escape"); await source.press("Control+Space");
    await expect(page.getByRole("option", { name: "item0000", exact: true })).toBeVisible();
    const popup = page.getByRole("listbox", { name: "Completions", exact: true });
    expect(await popup.getByRole("option").count()).toBeLessThanOrEqual(16);
    await expect(popup.locator(".demo-completion-count")).toHaveText("1 of 1200 · type to filter");
    const caret = page.locator("#editor .st-input-caret");
    await expect.poll(async () => {
        const line = await caret.boundingBox(), list = await popup.boundingBox();
        return !!line && !!list && list.y + list.height <= line.y;
    }, { message: "The catalogue list opens above the last line" }).toBe(true);
    const viewport = page.locator("#editor .st-viewport").first();
    const scroll = await viewport.evaluate(node => { const before = node.scrollTop; node.scrollTop = 0; return before; });
    await expect(popup).toBeHidden();
    await viewport.evaluate((node, top) => { node.scrollTop = top; }, scroll);
    await expect(popup).toBeVisible();
    await expect(popup.locator("pre")).toContainText("item0000:");
    const cursor = page.locator("#cursor"), originalCursor = await cursor.innerText();
    const rows = await popup.getByRole("option").evaluateAll(options => {
        const box = options[0]!.parentElement!.getBoundingClientRect();
        return options.filter(row => { const r = row.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom; }).length;
    });
    expect(rows).toBeGreaterThan(1); expect(rows).toBeLessThan(16);
    await source.press("PageDown");
    const paged = popup.getByRole("option", { name: "item" + String(rows).padStart(4, "0"), exact: true });
    await expect(paged).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => paged.evaluate(row => {
        const r = row.getBoundingClientRect(), list = row.parentElement!.getBoundingClientRect();
        return r.top >= list.top - 1 && r.bottom <= list.bottom + 1;
    })).toBe(true);
    await expect(cursor).toHaveText(originalCursor); await expect(source).toBeFocused();
    await source.press("PageUp"); await source.press("PageUp");
    await expect(popup.getByRole("option", { name: "item0000", exact: true })).toHaveAttribute("aria-selected", "true");
    const list = popup.locator(".demo-completion-choices"), hovered = popup.getByRole("option", { name: "item0002", exact: true });
    await page.mouse.move(0, 0);
    const background = () => hovered.evaluate(row => getComputedStyle(row).backgroundColor), normal = await background();
    await hovered.hover(); await expect.poll(background).not.toBe(normal);
    await page.mouse.wheel(0, 1600);
    await expect.poll(async () => Number((await popup.getByRole("option").last().textContent())!.slice(4))).toBeGreaterThan(15);
    await expect(popup.locator(".demo-completion-count")).toContainText("1 of 1200");
    await source.press("ArrowDown");
    const second = popup.getByRole("option", { name: "item0001", exact: true });
    await expect(second).toHaveAttribute("aria-selected", "true"); await expect(popup.locator("pre")).toContainText("item0001:");
    await expect.poll(() => second.evaluate(row => {
        const box = row.getBoundingClientRect(), list = row.parentElement!.getBoundingClientRect();
        return box.top >= list.top - 1 && box.bottom <= list.bottom + 1;
    })).toBe(true);
    await source.press("Enter"); await expect(source).toHaveValue(/catalogue\.item0001$/);
    await source.press("Control+z"); await source.press("Control+Space");
    await expect(popup.getByRole("option", { name: "item0000", exact: true })).toBeVisible();
    await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await popup.getByRole("option", { name: "item1199", exact: true }).click();
    await expect(source).toBeFocused(); await expect(source).toHaveValue(/catalogue\.item1199$/);
    await source.press("Control+z"); await source.press("Control+Space");
    await expect(popup.getByRole("option", { name: "item0000", exact: true })).toBeVisible();
    await source.press("ArrowUp");
    await expect(page.getByRole("option", { name: "item1199", exact: true })).toHaveAttribute("aria-selected", "true");
    await source.press("PageDown");
    expect(await popup.getByRole("option").count()).toBeLessThanOrEqual(16);
    await expect(popup.locator(".demo-completion-count")).toHaveText("1200 of 1200 · type to filter");
    await expect(page.locator(".demo-completion pre")).toContainText("item1199:");
    await source.press("Tab"); await expect(page.locator("#editor")).toContainText("catalogue.item1199");
    await source.press("Control+z"); await expect(page.locator("#editor")).not.toContainText("catalogue.item1199");
    await source.press("Control+Space"); await expect(popup).toBeVisible();
    await source.press("End"); await expect(popup).toBeHidden(); await expect(cursor).toHaveText(originalCursor);
    await source.press("Control+Space"); await expect(popup).toBeVisible();
    await source.press("Home"); await expect(popup).toBeHidden(); await expect(cursor).toContainText("Col 1", { useInnerText: true });
    await source.press("End");
    await source.press("Control+Space"); await expect(page.getByRole("option", { name: "item0000", exact: true })).toBeVisible();
    await source.pressSequentially("item119");
    await expect(popup.getByRole("option")).toHaveCount(10);
    await source.press("ArrowUp");
    await expect(page.locator(".demo-completion pre")).toContainText("item1199:");
    await source.press("Enter"); await expect(page.locator("#editor")).toContainText("catalogue.item1199");
    return Object.freeze({ candidates: 1200, renderedRowLimit: 16, lastCandidateReachable: true, prefixFiltering: true, keyboardAcceptance: true, undo: true });
}

async function select(page: Page, source: Locator, text: string) {
    await source.press("Control+f"); await page.getByRole("textbox", { name: "Find text", exact: true }).fill(text);
    await expect(page.locator("#find-status")).toHaveText("1 of 1"); await page.locator("#find-next").click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
}

/** F2 uses the provider range, including quoted property names. */
export async function runDemoRenameTargets(page: Page, url = "/") {
    await page.goto(url); await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    const source = page.getByRole("textbox", { name: "main.ts", exact: true }), dialog = page.getByRole("dialog", { name: "Rename symbol" });
    const message = page.getByLabel("Language command", { exact: true }), name = dialog.getByLabel("New name");
    const text = 'const model = { "unitPrice": 9 };\nconsole.log("Receipt", model.unitPrice);';
    await source.press("Control+a"); await page.keyboard.insertText(text); await source.press("Control+Home"); await source.press("ArrowRight");
    await source.press("F2"); await expect(message).toContainText("Place the caret on a name"); await expect(dialog).toBeHidden();
    await expect(source).toBeFocused(); await source.press("Escape"); await expect(message).toBeHidden();
    await select(page, source, "Receipt"); await source.press("ArrowLeft"); await source.press("ArrowRight"); await source.press("F2");
    await expect(message).toHaveText(/could not prepare|Place the caret/); await expect(dialog).toBeHidden(); await expect(source).toBeFocused();
    await select(page, source, '"unitPrice"'); await source.press("ArrowLeft"); await source.press("ArrowRight"); await source.press("ArrowRight");
    await source.press("F2"); await expect(name).toBeFocused(); await expect(name).toHaveValue("unitPrice");
    await name.fill("unitCost"); await name.press("Enter"); await expect(dialog.getByLabel("Rename edits").locator("li")).toHaveCount(2);
    await name.press("Enter"); await expect(dialog).toBeHidden(); await expect(source).toBeFocused(); await expect(source).toHaveValue(text.replaceAll("unitPrice", "unitCost"));
    await source.press("Control+z"); await expect(source).toHaveValue(text);
}

/** The same user workflow is reusable by the source demo and a restored-assets consumer. */
export async function runDemoWalkthrough(page: Page, url = "/") {
      page.on("dialog", dialog => dialog.accept());
    await page.goto(url);
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await expect(page.locator("#analysis-status")).toContainText("syntax & emit", { timeout: 30000 });
    await expect(page.locator("#editor .demo-token-keyword").first()).toHaveText("import");
    const main = page.getByRole("textbox", { name: "main.ts", exact: true }), pricing = page.getByRole("textbox", { name: "pricing.ts", exact: true });
    await select(page, main, "0.1"); await main.pressSequentially("0.2");
    await expect(page.getByRole("region", { name: "JavaScript output", exact: true })).toContainText("calculateTotal(cart, 0.2)", { timeout: 30000 });
    await select(page, main, "calculateTotal(cart"); await main.press("ArrowLeft"); await main.press("ArrowRight");
    await main.press("Control+k"); await main.press("Control+i");
    await expect(page.locator(".demo-language-popups .host-symbol-info:not(.host-signature)")).toContainText("calculateTotal(items: readonly CartItem[]");
    await main.press("Escape");
    await select(page, main, "calculateTotal(cart, "); await main.press("ArrowRight"); await main.press("Control+Shift+Space");
    await expect(page.getByRole("tooltip", { name: "Signature help", exact: true }).getByLabel("Active signature parameter")).toContainText("discount");
    await main.press("Escape");
    await select(page, main, "calculateTotal(cart"); await main.press("ArrowLeft"); await main.press("ArrowRight"); await main.press("F12");
    await expect(pricing).toBeFocused(); await pricing.press("F2");
    const rename = page.getByRole("dialog", { name: "Rename symbol", exact: true });
    const newName = rename.getByRole("textbox", { name: "New name", exact: true });
    await expect(newName).toHaveValue("calculateTotal"); await newName.press("Enter");
    await expect(rename.getByLabel("Rename status")).toHaveText("No edits for this name.");
    await expect(rename.getByLabel("Rename edits").locator("li")).toHaveCount(0);
    await expect(rename.getByRole("button", { name: "Apply rename", exact: true })).toBeDisabled();
    await newName.fill("basketTotal");
    await rename.getByRole("button", { name: "Preview rename", exact: true }).click();
    await expect(rename.getByLabel("Rename edits")).toContainText("main.ts"); await expect(rename.getByLabel("Rename edits")).toContainText("pricing.ts");
    await rename.getByRole("button", { name: "Apply rename", exact: true }).click(); await expect(rename).toBeHidden();
    await pricing.press("Control+z"); await expect(page.locator("#editor")).toContainText("export function calculateTotal(");
    await pricing.press("Control+y"); await expect(page.locator("#editor")).toContainText("export function basketTotal(");
    await page.locator('[data-file="main.ts"]').click(); await expect(page.locator("#editor")).toContainText("basketTotal(cart, 0.2)");
    await expect(page.getByRole("region", { name: "JavaScript output", exact: true })).toContainText("basketTotal(cart, 0.2)", { timeout: 30000 });
    await select(page, main, "basketTotal(cart"); await main.pressSequentially("basketTotl(cart");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await page.locator('[data-panel="problems"]').click(); await page.getByRole("button", { name: /main\.ts:\d+:\d+ · TS2552:/ }).click(); await main.press("Control+.");
    const fixes = page.getByRole("region", { name: "Quick fixes", exact: true });
    await expect(fixes.getByRole("button", { name: "Change spelling to 'basketTotal'", exact: true })).toBeVisible();
    await fixes.getByRole("button", { name: "Change spelling to 'basketTotal'", exact: true }).click(); await expect(fixes).toBeHidden();
    await expect(page.locator("#panel-content")).toHaveText("No problems in this project.");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const working = page.getByRole("textbox", { name: "Comparison working source", exact: true });
    await expect(working).toBeFocused(); await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    await expect(page.locator(".st-comparison-controls output")).toHaveText("Change 2 of 2");
    await page.getByRole("button", { name: "Next change", exact: true }).click();
    await expect(page.locator(".st-comparison-controls output")).toHaveText("Change 1 of 2");
    await page.getByRole("button", { name: "Use baseline", exact: true }).click();
    await working.press("Control+z"); await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    await expect(page.locator(".st-comparison-panes > section").last()).toContainText("basketTotal(cart, 0.2)");
    await working.press("Control+s"); await expect(page.locator("#status")).toHaveText("Saved in this browser.");
    await expect(page.locator("#files")).not.toContainText("●"); await expect(page.locator(".st-comparison-controls output")).toHaveText("No changes");
    await page.locator('[data-panel="javascript"]').click();
    await main.press("Control+Home"); await main.pressSequentially("// Recover this cart\n");
    await expect(page.locator("#status")).toHaveText("Unsaved changes.");
    await page.locator('[data-file="pricing.ts"]').click(); await pricing.press("Control+Home"); await pricing.pressSequentially("// Recover this helper\n");
    await expect(page.locator("#recovery-status")).toHaveText("Recovery draft captured in this browser.", { timeout: 30000 });
    await page.reload();
    // Module load does not await the example's asynchronous saved-project initialization.
    await expect(main).toBeVisible({ timeout: 30000 });
    await expect(page.locator("#recovery-offer")).toBeVisible();
    await expect(page.locator("#editor")).not.toContainText("// Recover this cart");
    await page.getByRole("button", { name: "Restore draft", exact: true }).click(); await expect(page.locator("#editor")).toContainText("// Recover this cart");
    await page.locator('[data-file="pricing.ts"]').click(); await expect(page.locator("#editor")).toContainText("// Recover this helper");
    await pricing.press("Control+z"); await expect(page.locator("#files")).not.toContainText("●");
    await expect(page.locator("#editor")).not.toContainText("// Recover this helper");
    await pricing.press("Control+y"); await pricing.press("Control+s"); await expect(page.locator("#status")).toContainText("Saved in this browser");
    await expect(page.locator("#recovery-status")).toHaveText("All changes are saved.");
    await page.reload(); await expect(page.locator("#editor")).toContainText("// Recover this cart");
    await expect(page.locator("#editor")).toContainText("basketTotal(cart, 0.2)"); await expect(page.locator("#recovery-offer")).toBeHidden();
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await expect(page.locator("#analysis-status")).toContainText("syntax & emit", { timeout: 30000 });

    await main.press("Control+End"); await main.pressSequentially("cart."); await main.press("Escape");
    const point = page.locator('#editor .st-diagnostic[data-ornament="point"]');
    await expect(point).toHaveCount(1);
    await expect(point.locator("..")).toHaveText("cart.");
    await main.pressSequentially("length"); await expect(point).toHaveCount(0);
    await expect(page.locator("#editor .st-viewport-row").last()).toHaveText("cart.length");

    return Object.freeze({ provider: true, syntaxAndEmission: true, hover: true, signature: true, definition: true, crossFileRenameAndUndo: true,
        quickFix: true, comparisonRevertUndo: true, projectSave: true, explicitRecoveryAndUndo: true, reload: true });
}

/** Concurrent saves use the same real provider/editor/review composition as the walkthrough. */
export async function runDemoConflict(page: Page, url = "/") {

    await page.goto(url); await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    const peer = await page.context().newPage();
    try {
        await peer.goto(page.url()); await expect(peer.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
        const main = page.getByRole("textbox", { name: "main.ts", exact: true });
        await main.press("Control+Home"); await main.pressSequentially("// Main page saved\n"); await expect(page.locator("#save")).toBeEnabled();
        const shortcuts = await main.evaluate(node => [
            { keyCode: 229 }, { modifierAltGraph: true }, { shiftKey: true }, { repeat: true }, { handled: true },
        ].map(detail => {
            const key = new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true, ...detail });
            if ("handled" in detail) key.preventDefault();
            node.dispatchEvent(key);
            return { consumed: key.defaultPrevented, saving: node.ownerDocument.querySelector<HTMLButtonElement>("#save")!.disabled };
        }));
        expect(shortcuts.map(s => s.consumed)).toEqual([false, false, false, true, true]);
        expect(shortcuts.every(s => !s.saving)).toBe(true);
        await main.press("Control+s");
        await expect(page.locator("#status")).toContainText("Saved in this browser");
        const peerMain = peer.getByRole("textbox", { name: "main.ts", exact: true });
        await peerMain.press("Control+Home"); await peerMain.pressSequentially("// Peer local work\n");
        await peer.locator('[data-file="pricing.ts"]').click(); await peer.getByRole("textbox", { name: "pricing.ts", exact: true }).press("Control+Home");
        await peer.getByRole("textbox", { name: "pricing.ts", exact: true }).pressSequentially("// Peer helper work\n");
        await peer.locator('[data-file="main.ts"]').click();
        await peer.setViewportSize({ width: 375, height: 820 });
        await peerMain.press("Control+Home");
        const row = peer.locator("#editor .st-viewport-row").filter({ hasText: 'import type { CartItem }' });
        const point = await paintedCharacter(row, "import", 2);
        await peerMain.press("Control+s");
        await expect(peer.locator("#save-conflict")).toBeVisible(); await expect(peer.locator("#editor")).toContainText("// Peer local work");
        await peer.mouse.click(point.x, point.y); await expect(peerMain).toBeFocused(); await expect(peer.locator("#cursor")).toContainText("Ln 3,");
        const review = peer.getByRole("button", { name: "Review saved copy", exact: true });
        await review.focus(); await review.press("Enter");
        await expect(peer.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
        await expect(peer.locator(".st-comparison-panes > section").first()).toContainText("// Main page saved");
        await expect(peer.locator(".st-comparison-panes > section").last()).toContainText("// Peer local work");
        const working = peer.getByRole("textbox", { name: "Comparison working source", exact: true });
        await working.press("Control+End"); await working.pressSequentially("\n// Later peer edit");
        const save = peer.getByRole("button", { name: "Save my reviewed version", exact: true }); await expect(save).toBeDisabled();
        await expect(peer.getByRole("button", { name: "Use reviewed saved files" })).toBeDisabled();
        await review.click(); await expect(save).toBeEnabled();
        // Hold the choice while the recovery notice settles and the narrow footer wraps.
        const saveBox = (await save.boundingBox())!;
        await peer.mouse.move(saveBox.x + saveBox.width / 2, saveBox.y + saveBox.height / 2);
        await peer.mouse.down();
        await expect(peer.locator("#recovery-status")).toContainText("Recovery draft captured");
        await peer.mouse.up();
        await expect(peer.locator("#status")).toContainText("Saved in this browser"); await expect(peer.locator("#files")).not.toContainText("●");
        const original = await main.inputValue();
        await main.press("Control+s"); await page.getByRole("button", { name: "Review saved copy" }).click();
        const take = page.getByRole("button", { name: "Use reviewed saved files" });
        const local = page.getByRole("textbox", { name: "Comparison working source", exact: true });
        await expect(take).toBeEnabled();
        await working.press("Control+Home"); await peer.keyboard.insertText("type NewerPeerSave = true;\n");
        await expect(peer.locator("#files")).toContainText("●"); await working.press("Control+s");
        await expect(peer.locator("#files")).not.toContainText("●");
        await take.click(); await expect(page.locator("#status")).toHaveText("The other page saved again. Review the new saved copy.");
        await expect(local).toHaveValue(original); await expect(take).toBeDisabled();
        await page.getByRole("button", { name: "Review saved copy" }).click();
        await expect(page.getByRole("textbox", { name: "Comparison baseline source" })).toHaveValue(/^type NewerPeerSave/);
        await local.press("Control+End"); await local.press("Control+Shift+Home");
        await take.click(); await expect(page.locator("#save-conflict")).toBeHidden();
        await expect(local).toBeFocused();
        const allSelectedBackwards = () => local.evaluate(node => {
            const field = node as HTMLTextAreaElement;
            return field.value.length > 0 && field.selectionStart === 0 && field.selectionEnd === field.value.length && field.selectionDirection === "backward";
        });
        await expect.poll(allSelectedBackwards).toBe(true);
        await local.press("Control+Home");
        const workingRows = page.locator(".st-comparison-panes > section").last().locator(".st-viewport-row");
        await expect(workingRows.first()).toHaveText("type NewerPeerSave = true;");
        await expect(page.locator("#files")).not.toContainText("●");
        await local.press("Control+z"); await local.press("Control+Home"); await expect(workingRows.first()).toHaveText("// Main page saved");
        await expect(page.locator("#files button")).toHaveText(["main.ts ●", "pricing.ts ●"]);
        await page.locator('[data-file="pricing.ts"]').click(); await local.press("Control+Home"); await expect(workingRows.first()).toHaveText("export interface CartItem {");
        await local.press("Control+y"); await local.press("Control+Home"); await expect(workingRows.first()).toHaveText("// Peer helper work");
        await expect(page.locator("#files")).not.toContainText("●");
        await page.reload(); await expect(page.locator("#editor")).toContainText("// Peer local work"); await expect(page.locator("#editor")).toContainText("// Later peer edit");
        await expect(page.locator("#editor")).not.toContainText("// Main page saved");
        await page.locator('[data-file="pricing.ts"]').click(); await expect(page.locator("#editor")).toContainText("// Peer helper work");
        await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });

        return Object.freeze({ concurrentProviderPages: true, projectConflict: true, preservedLocalEdits: true, staleReviewRejected: true,
            reviewedSave: true, reviewedAdoptionAndUndo: true, reloadBothFiles: true });
    } finally { await peer.close(); }
}
/** One real-provider journey shared by source, static and restored-package demos. */
export async function runDemoProjectResults(page: Page, url = "/") {
    await page.goto(url); await page.locator("#sample").selectOption("results");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await expect(page.locator('[data-panel="problems"]')).toHaveText("Problems (300)");
    await page.locator('[data-panel="problems"]').click();
    const problems = page.locator(".demo-problems"), rows = problems.locator(".problem-location");
    await expect(rows).toHaveCount(64);
    await expect(rows.first()).toContainText("problems.ts:1:7 · TS2322:");
    await problems.getByRole("button", { name: "Next problems", exact: true }).focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press("Space");
    await expect(problems.getByRole("button", { name: "Previous problems" })).toBeFocused();
    await expect(rows).toHaveCount(44); await expect(problems).toContainText("257–300 of 300");
    await expect(rows.last()).toContainText("problems.ts:300:7 · TS2322:"); await rows.last().click();
    const problemSource = page.getByRole("textbox", { name: "problems.ts", exact: true });
    await expect(problemSource).toBeFocused(); await expect(page.locator("#cursor")).toContainText("Ln 300,");
    await expect(page.locator("#editor")).toContainText("problem299");
    await expect(page.locator("#editor .st-diagnostic").last()).toBeVisible();

    await page.locator('[data-file="uses.ts"]').click();
    const source = page.getByRole("textbox", { name: "uses.ts", exact: true });
    await source.press("Control+Home"); await source.press("Control+ArrowRight"); await source.press("ArrowRight");
    await source.press("Shift+F12");
    const locations = page.getByRole("region", { name: "Symbol locations", exact: true });
    await expect(locations).toContainText("1–64 of 1201"); await expect(locations.locator("[data-location]")).toHaveCount(64);
    const firstResult = locations.locator('[data-location="0"]');
    await expect(firstResult.locator("code")).toHaveText("const sharedValue = 1;");
    await expect(firstResult.locator("mark")).toHaveText("sharedValue");
    const originCursor = await page.locator("#cursor").innerText();
    await page.keyboard.press("PageDown"); await expect(locations.locator('[data-chosen="true"]')).toHaveAttribute("data-location", "64");
    await locations.locator('[data-location="64"]').press("PageUp"); await expect(firstResult).toHaveAttribute("data-chosen", "true");
    await expect(page.locator("#cursor")).toHaveText(originCursor);
    // Up wraps to the last result and must reveal its page without creating 1,201 buttons.
    await locations.locator('[data-location="0"]').press("ArrowUp"); await expect(locations).toContainText("1153–1201 of 1201");
    await expect(locations.locator('[data-location="1200"] code')).toHaveText("const use1199 = sharedValue;");
    const backPage = locations.getByRole("button", { name: "Previous locations" });
    await expect.poll(() => backPage.evaluate(button => {
        const box = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    })).toBe(true);
    await locations.getByRole("button", { name: "Previous locations" }).click();
    await expect(locations.locator('[data-chosen="true"]')).toHaveAttribute("data-location", "1136");
    await locations.locator('[data-location="1150"]').press("ArrowDown");
    await locations.getByRole("button", { name: "Next locations" }).click();
    await expect(locations.locator('[data-chosen="true"]')).toHaveAttribute("data-location", "1200");
    await locations.getByRole("button", { name: "Previous locations" }).click();
    await expect(locations.locator('[data-chosen="true"]')).toHaveAttribute("data-location", "1151");
    await locations.getByRole("button", { name: "Next locations" }).click();
    const viewport = page.locator("#editor .st-viewport");
    async function scrollAwayAndBack(popup: Locator, lineNumber: number) {
        const initial = await viewport.evaluate(node => node.scrollTop);
        await viewport.evaluate((node, line) => { node.scrollTop = line === 0 ? node.scrollHeight : 0; }, lineNumber);
        await expect(popup).toBeHidden(); await expect(source).toBeFocused();
        await viewport.evaluate((node, top) => { node.scrollTop = top; }, initial);
        await expect(popup).toBeVisible();
        await expect.poll(async () => {
            const line = await page.locator(`#editor .st-viewport-row[data-line="${lineNumber}"]`).evaluate(row => {
                const text = document.createRange(); text.selectNodeContents(row);
                const rect = text.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom };
            }), box = await popup.boundingBox();
            return !!box && (Math.abs(box.y - line.bottom) <= 6 || Math.abs(box.y + box.height - line.top) <= 6);
        }).toBe(true);
    }
    await scrollAwayAndBack(locations, 0);
    await expect(locations.locator('[data-chosen="true"]')).toHaveAttribute("data-location", "1200");
    await expect(locations.locator("[data-location]")).toHaveCount(49); await source.press("Enter");
    await expect(locations).toBeHidden(); await expect(page.locator("#cursor")).toContainText("Ln 1201,");
    await expect(page.locator("#editor")).toContainText("const use1199 = sharedValue;");
    await source.press("Alt+ArrowLeft"); await expect(source).toBeFocused(); await expect(page.locator("#cursor")).toHaveText(originCursor);
    await source.press("Shift+F12"); await expect(locations).toContainText("1–64 of 1201");
    await source.press("ArrowUp"); await source.press("Enter"); await expect(page.locator("#cursor")).toContainText("Ln 1201,");
    await source.press("F2");
    const rename = page.getByRole("dialog", { name: "Rename symbol", exact: true });
    const name = rename.getByRole("textbox", { name: "New name", exact: true });
    const sourceTop = await viewport.evaluate(el => el.scrollTop), targetRow = viewport.locator('.st-viewport-row[data-line="1200"]');
    await viewport.evaluate(el => { el.scrollTop = 0; }); await expect(targetRow).toHaveCount(0);
    await expect(name).toBeFocused(); await page.keyboard.type("renamedValueFromTheSharedModule");
    await expect(name).toHaveValue("renamedValueFromTheSharedModule"); await page.keyboard.press("Enter");
    await expect(rename.getByLabel("Rename status", { exact: true })).toContainText("Review 1201 changes.");
    await viewport.evaluate((el, top) => { el.scrollTop = top; }, sourceTop);
    await expect(targetRow.first()).toContainText("const use1199 = sharedValue;");
    await expect(name).toBeFocused();
    const edits = rename.getByLabel("Rename edits", { exact: true }).locator("li"); await expect(edits).toHaveCount(64);
    const nextEdits = rename.getByRole("button", { name: "Next edits", exact: true });
    const retainedNext = await nextEdits.elementHandle();
    if (!retainedNext) throw new Error("The rename preview has no Next edits button.");
    await rename.getByRole("button", { name: "Preview rename", exact: true }).click();
    await expect(rename.getByLabel("Rename status", { exact: true })).toContainText("Review 1201 changes.");
    await retainedNext.evaluate(node => (node as HTMLButtonElement).click()); await retainedNext.dispose();
    await expect(edits.first()).toContainText("uses.ts · 1:");
    await nextEdits.focus(); await nextEdits.hover(); await page.mouse.down();
    await nextEdits.press("Enter"); await expect(edits.first()).toContainText("uses.ts · 65:");
    await page.mouse.up(); await expect(edits.first()).toContainText("uses.ts · 65:");
    const list = rename.getByRole("list", { name: "Rename edits" });
    await expect(list).toHaveJSProperty("start", 65);
    await expect(edits.first()).toBeInViewport({ ratio: 1 }); await expect(nextEdits).toBeInViewport({ ratio: 1 });
    await list.focus(); await list.press("End"); await expect(edits.last().locator("code")).toBeInViewport({ ratio: 1 });
    await rename.getByRole("button", { name: "Previous edits", exact: true }).click();
    await expect(list).toHaveJSProperty("start", 1); await expect(edits.first()).toBeInViewport({ ratio: 1 });
    for (let i = 0; i < 18; i++) await nextEdits.click();
    await expect(edits).toHaveCount(49); await expect(edits.last()).toContainText("uses.ts · 1201:");
    await expect(list).toHaveJSProperty("start", 1153);
    await rename.getByRole("button", { name: "Apply rename", exact: true }).click(); await expect(rename).toBeHidden();
    await expect(page.locator("#editor")).toContainText("const use1199 = renamedValueFromTheSharedModule;");
    await source.press("Control+Home"); await expect(page.locator("#editor")).toContainText("const renamedValueFromTheSharedModule = 1;");
    await source.press("Control+ArrowRight"); await source.press("ArrowRight");
    await source.press("Control+k"); await source.press("Control+i");
    const info = page.locator(".demo-language-popups .host-symbol-info:not(.host-signature)");
    await expect(info).toContainText("renamedValueFromTheSharedModule"); await source.press("Escape");
    await source.press("Control+z"); await expect(page.locator("#files")).not.toContainText("●");
    await expect(page.locator("#editor")).toContainText("sharedValue");
    await source.press("Control+y"); await source.press("Control+End");
    await expect(page.locator("#editor")).toContainText("const use1199 = renamedValueFromTheSharedModule;");
    await source.press("Control+s"); await expect(page.locator("#status")).toContainText("Saved in this browser");
    await page.locator("#sample").selectOption("pricing"); await page.locator('[data-panel="problems"]').click();
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await expect(page.locator("#panel-content")).toHaveText("No problems in this project.");
    return Object.freeze({ diagnostics: 300, references: 1201, renameEdits: 1201, visibleRows: 64,
        lateProblemNavigation: true, referenceKeyboardPaging: true, synchronizedRename: true, atomicHistory: true, save: true, sampleSwitch: true });
}
