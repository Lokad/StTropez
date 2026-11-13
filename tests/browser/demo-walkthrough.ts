import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/** Shared by source, static and restored-assets demos; all commands use visible controls. */
export async function runDemoDocumentation(page: Page, url = "/") {
    const guide = "https://www.typescriptlang.org/docs/handbook/2/functions.html";
    await page.context().route(guide, route => route.fulfill({ contentType: "text/html", body: "<title>Permitted help destination</title>" }));
    await page.goto(url); await page.locator("#sample").selectOption("documentation");
    const source = page.getByRole("textbox", { name: "documentation.ts", exact: true });
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await select(page, source, "const discounted = applyDiscount"); await source.press("ArrowRight"); await source.press("ArrowLeft");
    await source.press("Control+k"); await source.press("Control+i");
    const hover = page.locator(".demo-language-popups .host-symbol-info:not(.host-signature)");
    await expect(hover.locator("strong").first()).toHaveText("percentage discount");
    await expect(hover.locator("em").first()).toHaveText("ten percent"); await expect(hover.locator("ul li")).toHaveCount(2);
    await expect(hover.locator("pre code").last()).toContainText("applyDiscount(50, 0.1)");
    expect(await hover.evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth; })).toBe(true);
    const opened = page.context().waitForEvent("page"); await hover.getByRole("button", { name: "TypeScript function guide", exact: true }).click();
    const help = await opened; await expect(help).toHaveURL(guide); expect(await help.evaluate(() => window.opener)).toBeNull(); await help.close();
    await source.press("Escape");
    await select(page, source, "const discounted = applyDiscount(50,"); await source.press("ArrowRight"); await source.press("Control+Shift+Space");
    const signature = page.getByRole("tooltip", { name: "Signature help", exact: true });
    await expect(signature.getByLabel("Active signature parameter")).toContainText("rate");
    await expect(signature.locator("strong").first()).toHaveText("percentage discount"); await expect(signature.locator("ul li")).toHaveCount(2);
    await expect(signature.locator(".st-documentation").last().locator("code")).toHaveText(["0", "1"]);
    expect(await signature.evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; })).toBe(true);
    await source.press("Escape"); await expect(signature).toBeHidden(); await expect(page.locator("#files")).not.toContainText("●");
    await page.locator("#sample").selectOption("pricing"); await expect(hover).toBeHidden();
    await page.context().unroute(guide);
}

export async function runDemoHighlights(page: Page, url = "/", distinctWrites = false) {
    await page.goto(url);
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    const replace = async (text: string) => { await source.press("Control+a"); await page.keyboard.insertText(text); };
    await replace("let value = 1;\nvalue = value + 1;\n");
    await source.press("Control+Home"); await source.press("Control+ArrowRight");
    const writes = page.locator("#editor .demo-occurrence-write"), reads = page.locator("#editor .demo-occurrence-read");
    const occurrences = page.locator("#editor .demo-occurrence-write, #editor .demo-occurrence-read");
    await expect(occurrences).toHaveText(["value", "value", "value"], { timeout: 30000 });
    // The pinned Node server reports all these spans as reads; the compiler-backed static
    // provider distinguishes writes. Preserve provider semantics instead of inventing kinds.
    await expect(writes).toHaveCount(distinctWrites ? 2 : 0); await expect(reads).toHaveCount(distinctWrites ? 1 : 3);
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
    await source.press("Control+Home"); await source.press("Control+ArrowRight"); await expect(occurrences.first()).toHaveText("value", { timeout: 30000 });
    const viewport = page.locator("#editor .st-viewport");
    await viewport.evaluate(node => { node.scrollTop = node.scrollHeight / 2; });
    await expect.poll(async () => Number(await page.locator("#editor .st-viewport-row").first().getAttribute("data-line"))).toBeGreaterThan(4000);
    await expect(occurrences.first()).toHaveText("value");
    expect(await page.locator("#editor .st-viewport-row").count()).toBeLessThan(100);
    expect(await occurrences.count()).toBeLessThan(100);
}

export async function runDemoFolding(page: Page, url = "/") {
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
    await page.locator("#code-menu summary").click(); await page.locator("#fold-group").selectOption("regions"); await page.locator("#fold-group-collapse").click();
    await expect(page.locator('#editor .st-fold-button[aria-expanded="false"]')).toHaveCount(1);
    await expect(page.locator('#editor .st-viewport-row[data-line="8"]')).toHaveCount(0);
    expect(await page.locator("#gutter span").allTextContents()).toEqual(await page.locator("#editor .st-viewport-row").evaluateAll(rows => rows.map(row => String(Number((row as HTMLElement).dataset.line) + 1))));
    await page.locator("#find-toggle").click(); await page.locator("#find-query").fill("validate");
    await expect(page.locator("#find-status")).toHaveText("1 matches"); await page.locator("#find-next").click(); await page.locator("#find-close").click();
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
    await left.locator(".st-fold-button").first().click();
    await menu("fold-group-expand");
    await expect(left.locator('.st-fold-button[aria-expanded="false"]')).toHaveCount(1);
    await expect(right.locator('.st-fold-button[aria-expanded="false"]')).toHaveCount(0);
}

export async function runDemoEditingRules(page: Page, url = "/") {
    await page.goto(url);
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await expect(source).toBeVisible();
    const replace = async (text: string) => { await source.press("Control+Home"); await source.press("Control+a"); await page.keyboard.insertText(text); };
    const menu = async (name: string) => { await page.locator("#code-menu summary").click(); await page.getByRole("button", { name, exact: true }).click(); };
    await replace("function demo() {}"); await source.press("ArrowLeft"); await source.press("Enter");
    await expect(source).toHaveValue("function demo() {\n  \n}");
    await source.pressSequentially('"'); await expect(source).toHaveValue('function demo() {\n  ""\n}');
    await source.pressSequentially('value";'); await source.press("Escape");
    await expect(source).toHaveValue('function demo() {\n  "value";\n}');
    await source.press("Control+Home"); await source.press("Shift+End");
    await menu("Toggle block comment"); await expect(source).toHaveValue('/*function demo() {*/\n  "value";\n}');
    await menu("Toggle block comment"); await expect(source).toHaveValue('function demo() {\n  "value";\n}');
    await source.press("Control+a"); await source.press("Control+/");
    await expect(source).toHaveValue('// function demo() {\n  // "value";\n// }');
    await source.press("Control+z"); await expect(source).toHaveValue('function demo() {\n  "value";\n}');
    await replace("/*\ncomment\n*/\n"); await expect(page.locator("#analysis-status")).toContainText("syntax & emit");
    await source.press("Control+Home"); await source.press("ArrowDown"); await source.press("End"); await source.pressSequentially('"');
    await expect(source).toHaveValue('/*\ncomment"\n*/\n');
    await replace("a\nb\n"); await source.press("Control+a"); await menu("Indent selection");
    await expect(source).toHaveValue("  a\n  b\n"); await source.press("Control+z");
    await page.locator("#code-menu summary").click(); await page.locator("#indentation").selectOption("4"); await page.locator("#code-menu summary").click();
    await source.press("Tab"); await expect(source).toHaveValue("    a\n    b\n"); await source.press("Control+z");
    await page.locator("#code-menu summary").click(); await page.locator("#indentation").selectOption("tabs"); await page.locator("#code-menu summary").click();
    await source.press("Tab"); await expect(source).toHaveValue("\ta\n\tb\n");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    expect(await page.locator(".st-comparison .st-editing-candidate").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).tabSize))).toEqual(["4", "4"]);
    await page.getByRole("textbox", { name: "Comparison working source", exact: true }).press("Control+z");
    await expect(page.getByRole("textbox", { name: "Comparison working source", exact: true })).toHaveValue("a\nb\n");
    await page.getByRole("button", { name: "JavaScript", exact: true }).click();
    await replace("// pending\n".repeat(4096));
    await expect(page.locator("#recovery-status")).toHaveText("Recovery draft captured in this browser.");
    await source.press("Control+a");
    await source.evaluate(input => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
        document.querySelector<HTMLButtonElement>("#save")!.click();
    });
    await expect(page.locator("#status")).toHaveText("An edit is still in progress. Save again when it finishes.");
    await source.press("Control+Home"); await expect(page.locator("#cursor")).toHaveText("Ln 1, Col 1");
    await expect.poll(async () => (await source.inputValue()).startsWith("\t// pending")).toBe(true);
    await page.getByRole("button", { name: "Save locally", exact: true }).click();
    await expect(page.locator("#status")).toContainText("Saved in this browser");
    await expect(page.locator("#files")).not.toContainText("●");
    await page.reload(); await expect.poll(async () => (await source.inputValue()).startsWith("\t// pending")).toBe(true);
    await expect(page.locator("#recovery-status")).not.toHaveText("Checking recovery…");
    await expect(page.locator("#recovery-offer")).toBeHidden();
}

/** The labeled template provider shares the public completion/input/history paths. */
export async function runDemoSnippets(page: Page, url = "/") {
    page.on("dialog", dialog => dialog.accept());
    await page.goto(url); await page.locator("#sample").selectOption("templates");
    const source = page.getByRole("textbox", { name: "templates.ts", exact: true }), editor = page.locator("#editor");
    const controls = page.getByRole("region", { name: "Snippet controls", exact: true });
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    const request = async () => { await source.press("Control+End"); await source.press("Control+Space");
        await expect(page.getByRole("option", { name: "Template · linked placeholders", exact: true })).toBeVisible(); };
    await request(); await expect(page.locator(".demo-completion-count")).toContainText("1 unsupported");
    await source.press("Tab"); await expect(controls).toContainText("Field 1 of 3");
    await expect(editor).toContainText("console.log(record)");
    await source.press("Control+z"); await expect(controls).toBeHidden(); await expect(editor).not.toContainText("console.log");
    await source.press("Control+y"); await expect(editor).toContainText("console.log(record)"); await expect(controls).toBeHidden();
    await page.getByRole("button", { name: "Reset sample", exact: true }).click(); await request(); await source.press("Tab");
    await expect(controls).toContainText("Field 1 of 3"); await source.pressSequentially("entry");
    await expect(editor).toContainText("const entry"); await expect(editor).toContainText("console.log(entry)");
    await source.press("Tab"); await expect(controls).toContainText("Field 2 of 3");
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
    await source.evaluate(node => {
        const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
        event.clipboardData!.setData("text/plain", "42");
        if (event.clipboardData!.getData("text/plain") !== "42") throw new Error("Synthetic clipboard fixture lost its data.");
        node.dispatchEvent(event);
    });
    await expect(editor).toContainText("value: 42"); await source.press("Tab"); await expect(controls).toBeHidden();
    await source.pressSequentially("// Finished"); await expect(editor).toContainText("console.log(項目);// Finished");
    await source.press("Control+z"); await expect(editor).not.toContainText("// Finished");
    await page.getByRole("button", { name: "Reset sample", exact: true }).click(); await request(); await source.press("ArrowDown"); await source.press("Tab");
    await expect(controls).toContainText("Field 1 of 2");
    await expect(editor).toContainText('import type { TemplateRecord } from "./types";');
    await expect(editor).toContainText("console.log(result)");
    await source.press("Control+z"); await expect(editor).not.toContainText("TemplateRecord"); await expect(controls).toBeHidden();
    await request(); await source.press("ArrowDown"); await source.press("Enter"); await expect(controls).toContainText("Field 1 of 2");
    await source.press("Escape"); await expect(controls).toBeHidden(); await source.pressSequentially("other");
    await expect(editor).toContainText("const other:"); await expect(editor).toContainText("console.log(result)");
    await page.getByRole("button", { name: "Reset sample", exact: true }).click(); await request(); await source.press("Tab"); await expect(controls).toBeVisible();
    await page.locator('[data-file="types.ts"]').click(); await expect(controls).toBeHidden();
    await page.locator('[data-file="templates.ts"]').click(); await expect(editor).toContainText("console.log(record)"); await expect(controls).toBeHidden();
    return Object.freeze({ linkedEdits: true, tabTraversal: true, choices: true, finalCaret: true, syntheticComposition: true, syntheticPaste: true,
        lazyPrimaryAndAdditionalEdits: true, history: true, escapeAndViewLifetime: true, native: "IME and OS clipboard UNVERIFIED" });
}

/** Complete provider lists stay navigable while the host bounds rendered rows. */
export async function runDemoCompletionCatalogue(page: Page, url = "/") {
    await page.goto(url); await page.locator("#sample").selectOption("catalogue");
    const source = page.getByRole("textbox", { name: "catalogue.ts", exact: true });
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await source.press("Control+End"); await source.pressSequentially("catalogue.");
    await source.press("Escape"); await source.press("Control+Space");
    await expect(page.getByRole("option", { name: "item0000", exact: true })).toBeVisible();
    const popup = page.getByRole("listbox", { name: "Completions", exact: true });
    expect(await popup.getByRole("option").count()).toBeLessThanOrEqual(16);
    await expect(popup.locator(".demo-completion-count")).toHaveText("1 of 1200 · type to filter");
    await source.press("ArrowUp");
    await expect(page.getByRole("option", { name: "item1199", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(await popup.getByRole("option").count()).toBeLessThanOrEqual(16);
    await expect(popup.locator(".demo-completion-count")).toHaveText("1200 of 1200 · type to filter");
    await expect(page.locator(".demo-completion pre")).toContainText("item1199:");
    await source.press("Tab"); await expect(page.locator("#editor")).toContainText("catalogue.item1199");
    await source.press("Control+z"); await expect(page.locator("#editor")).not.toContainText("catalogue.item1199");
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
    await expect(page.locator("#find-status")).toHaveText("1 matches"); await page.locator("#find-next").click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
}

/** The same user workflow is reusable by the source demo and a restored-assets consumer. */
export async function runDemoWalkthrough(page: Page, url = "/") {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); page.on("dialog", dialog => dialog.accept());
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
    await rename.getByRole("textbox", { name: "New name", exact: true }).fill("basketTotal");
    await rename.getByRole("button", { name: "Preview rename", exact: true }).click();
    await expect(rename.getByLabel("Rename edits")).toContainText("main.ts"); await expect(rename.getByLabel("Rename edits")).toContainText("pricing.ts");
    await rename.getByRole("button", { name: "Apply rename", exact: true }).click(); await expect(rename).toBeHidden();
    await pricing.press("Control+z"); await expect(page.locator("#editor")).toContainText("export function calculateTotal(");
    await pricing.press("Control+y"); await expect(page.locator("#editor")).toContainText("export function basketTotal(");
    await page.locator('[data-file="main.ts"]').click(); await expect(page.locator("#editor")).toContainText("basketTotal(cart, 0.2)");
    await expect(page.getByRole("region", { name: "JavaScript output", exact: true })).toContainText("basketTotal(cart, 0.2)", { timeout: 30000 });
    await select(page, main, "basketTotal(cart"); await main.pressSequentially("basketTotl(cart");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await page.locator('[data-panel="problems"]').click(); await page.getByRole("button", { name: /main.ts · TS2552:/ }).click(); await main.press("Control+.");
    const fixes = page.getByRole("region", { name: "Quick fixes", exact: true });
    await expect(fixes.getByRole("button", { name: "Change spelling to 'basketTotal'", exact: true })).toBeVisible();
    await fixes.getByRole("button", { name: "Apply fix", exact: true }).click(); await expect(fixes).toBeHidden();
    await expect(page.locator("#panel-content")).toHaveText("No problems in this project.");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const working = page.getByRole("textbox", { name: "Comparison working source", exact: true });
    await expect(working).toBeFocused(); await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    await expect(page.locator(".st-comparison-controls output")).toContainText(/[1-9]\d* changes?/);
    await page.getByRole("button", { name: "Next change", exact: true }).click(); await page.getByRole("button", { name: "Use baseline", exact: true }).click();
    await working.press("Control+z"); await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    await expect(page.locator(".st-comparison-panes > section").last()).toContainText("basketTotal(cart, 0.2)");
    await working.press("Control+s"); await expect(page.locator("#status")).toContainText("Saved in this browser");
    await expect(page.locator("#files")).not.toContainText("●"); await expect(page.locator(".st-comparison-controls output")).toHaveText("No changes");
    await page.locator('[data-panel="javascript"]').click();
    await main.press("Control+Home"); await main.pressSequentially("// Recover this cart\n");
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
    expect(errors).toEqual([]);
    return Object.freeze({ provider: true, syntaxAndEmission: true, hover: true, signature: true, definition: true, crossFileRenameAndUndo: true,
        quickFix: true, comparisonRevertUndo: true, projectSave: true, explicitRecoveryAndUndo: true, reload: true, pageErrors: errors });
}

/** Concurrent saves use the same real provider/editor/review composition as the walkthrough. */
export async function runDemoConflict(page: Page, url = "/") {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(url); await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    const peer = await page.context().newPage(); peer.on("pageerror", error => errors.push(error.message));
    try {
        await peer.goto(page.url()); await expect(peer.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
        const main = page.getByRole("textbox", { name: "main.ts", exact: true });
        await main.press("Control+Home"); await main.pressSequentially("// Main page saved\n"); await main.press("Control+s");
        await expect(page.locator("#status")).toContainText("Saved in this browser");
        const peerMain = peer.getByRole("textbox", { name: "main.ts", exact: true });
        await peerMain.press("Control+Home"); await peerMain.pressSequentially("// Peer local work\n");
        await peer.locator('[data-file="pricing.ts"]').click(); await peer.getByRole("textbox", { name: "pricing.ts", exact: true }).press("Control+Home");
        await peer.getByRole("textbox", { name: "pricing.ts", exact: true }).pressSequentially("// Peer helper work\n");
        await peer.locator('[data-file="main.ts"]').click(); await peerMain.press("Control+s");
        await expect(peer.locator("#save-conflict")).toBeVisible(); await expect(peer.locator("#editor")).toContainText("// Peer local work");
        await peer.getByRole("button", { name: "Review saved copy", exact: true }).click();
        await expect(peer.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
        await expect(peer.locator(".st-comparison-panes > section").first()).toContainText("// Main page saved");
        await expect(peer.locator(".st-comparison-panes > section").last()).toContainText("// Peer local work");
        const working = peer.getByRole("textbox", { name: "Comparison working source", exact: true });
        await working.press("Control+End"); await working.pressSequentially("\n// Later peer edit");
        const save = peer.getByRole("button", { name: "Save my reviewed version", exact: true }); await expect(save).toBeDisabled();
        await peer.getByRole("button", { name: "Review saved copy", exact: true }).click(); await expect(save).toBeEnabled(); await save.click();
        await expect(peer.locator("#status")).toContainText("Saved in this browser"); await expect(peer.locator("#files")).not.toContainText("●");
        await page.reload(); await expect(page.locator("#editor")).toContainText("// Peer local work"); await expect(page.locator("#editor")).toContainText("// Later peer edit");
        await expect(page.locator("#editor")).not.toContainText("// Main page saved");
        await page.locator('[data-file="pricing.ts"]').click(); await expect(page.locator("#editor")).toContainText("// Peer helper work");
        await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
        expect(errors).toEqual([]);
        return Object.freeze({ concurrentProviderPages: true, projectConflict: true, preservedLocalEdits: true, staleReviewRejected: true, reviewedSave: true, reloadBothFiles: true, pageErrors: errors });
    } finally { await peer.close(); }
}
/** One real-provider journey shared by source, static and restored-package demos. */
export async function runDemoProjectResults(page: Page, url = "/") {
    await page.goto(url); await page.locator("#sample").selectOption("results");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await expect(page.locator('[data-panel="problems"]')).toHaveText("Problems (300)");
    await page.locator('[data-panel="problems"]').click();
    const problems = page.locator(".demo-problems"), rows = problems.getByRole("button", { name: /^problems.ts · TS2322:/ });
    await expect(rows).toHaveCount(64);
    for (let i = 0; i < 4; i++) await problems.getByRole("button", { name: "Next problems", exact: true }).click();
    await expect(rows).toHaveCount(44); await expect(problems).toContainText("257–300 of 300"); await rows.last().click();
    const problemSource = page.getByRole("textbox", { name: "problems.ts", exact: true });
    await expect(problemSource).toBeFocused(); await expect(page.locator("#cursor")).toContainText("Ln 300,");
    await expect(page.locator("#editor")).toContainText("problem299");
    await expect(page.locator("#editor .demo-diagnostic").last()).toBeVisible();

    await page.locator('[data-file="uses.ts"]').click();
    const source = page.getByRole("textbox", { name: "uses.ts", exact: true });
    await source.press("Control+Home"); await source.press("Control+ArrowRight"); await source.press("ArrowRight");
    await source.press("Shift+F12");
    const locations = page.getByRole("region", { name: "Symbol locations", exact: true });
    await expect(locations).toContainText("1–64 of 1201"); await expect(locations.locator("[data-location]")).toHaveCount(64);
    // Up wraps to the last result and must reveal its page without creating 1,201 buttons.
    await source.press("ArrowUp"); await expect(locations).toContainText("1153–1201 of 1201");
    await expect(locations.locator("[data-location]")).toHaveCount(49); await source.press("Enter");
    await expect(locations).toBeHidden(); await expect(page.locator("#cursor")).toContainText("Ln 1201,");
    await expect(page.locator("#editor")).toContainText("const use1199 = sharedValue;");
    await source.press("F2");
    const rename = page.getByRole("dialog", { name: "Rename symbol", exact: true });
    await rename.getByRole("textbox", { name: "New name", exact: true }).fill("renamedValue");
    await rename.getByRole("button", { name: "Preview rename", exact: true }).click();
    await expect(rename.getByLabel("Rename status", { exact: true })).toHaveText("Review 1201 changes before applying.");
    const edits = rename.getByLabel("Rename edits", { exact: true }).locator("li"); await expect(edits).toHaveCount(64);
    for (let i = 0; i < 18; i++) await rename.getByRole("button", { name: "Next edits", exact: true }).click();
    await expect(edits).toHaveCount(49); await expect(edits.last()).toContainText("uses.ts · 1201:");
    await rename.getByRole("button", { name: "Apply rename", exact: true }).click(); await expect(rename).toBeHidden();
    await expect(page.locator("#editor")).toContainText("const use1199 = renamedValue;");
    await source.press("Control+Home"); await expect(page.locator("#editor")).toContainText("const renamedValue = 1;");
    await source.press("Control+ArrowRight"); await source.press("ArrowRight");
    await source.press("Control+k"); await source.press("Control+i");
    const info = page.locator(".demo-language-popups .host-symbol-info:not(.host-signature)");
    await expect(info).toContainText("renamedValue"); await source.press("Escape");
    await source.press("Control+z"); await expect(page.locator("#files")).not.toContainText("●");
    await expect(page.locator("#editor")).toContainText("sharedValue");
    await source.press("Control+y"); await source.press("Control+End");
    await expect(page.locator("#editor")).toContainText("const use1199 = renamedValue;");
    await source.press("Control+s"); await expect(page.locator("#status")).toContainText("Saved in this browser");
    await page.locator("#sample").selectOption("pricing"); await page.locator('[data-panel="problems"]').click();
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await expect(page.locator("#panel-content")).toHaveText("No problems in this project.");
    return Object.freeze({ diagnostics: 300, references: 1201, renameEdits: 1201, visibleRows: 64,
        lateProblemNavigation: true, referenceKeyboardPaging: true, synchronizedRename: true, atomicHistory: true, save: true, sampleSwitch: true });
}
