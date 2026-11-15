import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

export async function runDemoActions(page: Page, url = "/") {
    await page.goto(url);
    // This journey qualifies project actions; finish provider setup before switching samples.
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await page.locator("#sample").selectOption("actions");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await expect(page.locator("#editor")).toContainText("Demo project action fixture");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    const actions = page.getByRole("region", { name: "Quick fixes", exact: true });
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
    await expect(page.locator("#editor")).toContainText("import { exampleRate }");
    await source.press("Control+End"); await page.keyboard.insertText("// Keep this later edit\n");
    await expect(actions.getByRole("button", { name: "Apply fix", exact: true })).toBeDisabled();
    await expect(actions).toContainText("The code or selection changed");
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
    await select(page, main, "const label = formatLabel"); await main.press("ArrowRight"); await main.press("ArrowLeft");
    const cursor = "Ln 6, Col 25"; await expect(page.locator("#cursor")).toHaveText(cursor);
    await main.press("F12"); await expect(labels).toBeVisible();
    await expect(page.locator("#editor")).toContainText("export function formatLabel");
    await labels.press("Control+End"); await page.keyboard.insertText("// edit the loaded module\n");
    await expect(page.locator("#files")).toContainText("labels.ts ●"); await labels.press("Control+z");
    await labels.press("Alt+ArrowLeft"); await expect(main).toBeFocused(); await expect(page.locator("#cursor")).toHaveText(cursor);
    await select(page, main, "const record: RecordId"); await main.press("ArrowRight"); await main.press("ArrowLeft"); await main.press("F12");
    const declaration = page.getByRole("textbox", { name: "contracts.d.ts", exact: true }); await expect(declaration).toBeVisible();
    await expect(page.locator("#files")).toContainText("contracts.d.ts (read-only)");
    const before = await declaration.inputValue(); await declaration.press("Control+End"); await declaration.press("x"); await expect(declaration).toHaveValue(before);
    await declaration.press("Alt+ArrowLeft"); await expect(main).toBeFocused();
    await page.locator("#save").click(); await expect(page.locator("#status")).toContainText("Saved in this browser");
    await page.reload(); await page.locator("#sample").selectOption("navigation");
    await expect(page.locator("#files button")).toHaveText(["main.ts"]); await expect(page.locator("#recovery-offer")).toBeHidden();
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await select(page, main, "export interface LabelOptions"); await main.press("ArrowRight"); await main.press("ArrowLeft"); await main.press("F2");
    const rename = page.getByRole("dialog", { name: "Rename symbol", exact: true });
    await rename.getByRole("textbox", { name: "New name", exact: true }).fill("DisplayOptions"); await rename.getByRole("button", { name: "Preview rename", exact: true }).click();
    await expect(rename.getByLabel("Rename status")).toContainText("Review 3 changes");
    await rename.getByRole("button", { name: "Apply rename", exact: true }).click(); await expect(rename).toBeHidden();
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
    // The same public metadata decoder feeds Problems. Real compiler errors and an explicit
    // host fixture cover related declarations, tags and help without inventing TS capabilities.
    const diagnosticGuide = "https://www.typescriptlang.org/docs/handbook/2/everyday-types.html";
    await page.context().route(diagnosticGuide, route => route.fulfill({ contentType: "text/html", body: "<title>Diagnostic help</title>" }));
    await page.locator("#sample").selectOption("diagnostics");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await page.locator('[data-panel="problems"]').click();
    const problems = page.locator(".demo-problems"), error = problems.locator(".demo-problem").filter({ hasText: "TS2322:" });
    const warning = problems.locator(".demo-problem").filter({ hasText: "legacy-price:" });
    await expect(error).toContainText("Error · typescript"); await expect(warning).toContainText("Warning · Demo host · Deprecated");
    await error.locator("summary").click(); await error.getByRole("button", { name: /types.ts:2:3/ }).click();
    const types = page.getByRole("textbox", { name: "types.ts", exact: true }); await expect(types).toBeFocused();
    await expect(page.locator("#cursor")).toHaveText("Ln 2, Col 8");
    await warning.locator("summary").click(); await warning.getByRole("button", { name: /Replacement declared here/ }).click();
    const details = page.getByRole("textbox", { name: "details.ts", exact: true }); await expect(details).toBeFocused();
    await expect(page.locator("#cursor")).toHaveText("Ln 4, Col 19");
    const helpOpening = page.context().waitForEvent("page"); await warning.getByRole("button", { name: "Diagnostic help", exact: true }).click();
    const diagnosticHelp = await helpOpening; await expect(diagnosticHelp).toHaveURL(diagnosticGuide);
    expect(await diagnosticHelp.evaluate(() => window.opener)).toBeNull(); await diagnosticHelp.close();
    await warning.getByRole("button", { name: /^details.ts · legacy-price:/ }).click(); await page.keyboard.insertText("currentPrice");
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

    // Both TypeScript snapshots use syntax colors/outlining; review fold choices stay independent.
    await page.locator('[data-panel="javascript"]').click(); await page.locator("#sample").selectOption("navigation");
    const imports = page.getByRole("textbox", { name: "main.ts", exact: true });
    const original = await imports.inputValue(), header = page.locator('#editor .st-viewport-row[data-line="0"]');
    await expect(page.locator("#editor .st-fold-button").first()).toBeVisible({ timeout: 30000 });
    await page.locator("#editor .st-fold-button").first().click();
    await expect(header).toHaveAttribute("data-folded-summary", "… 1 line hidden");
    await expect(imports).toHaveValue(original); await expect(page.locator('#editor .st-viewport-row[data-line="1"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    const coloredImport = (pane: typeof left) => pane.locator('.st-viewport-row[data-line="0"] .demo-token-keyword').first();
    await expect(coloredImport(left)).toHaveText("import"); await expect(coloredImport(right)).toHaveText("import");
    await expect(left.locator(".st-fold-button")).toHaveAttribute("aria-expanded", "true");
    await expect(right.locator(".st-fold-button")).toHaveAttribute("aria-expanded", "false");
    await expect(right.locator('[data-folded-summary]')).toHaveAttribute("data-folded-summary", "… 1 line hidden");
    await right.locator(".st-fold-button").click();
    await expect(right.locator('[data-folded-summary]')).toHaveCount(0);
    await expect.poll(() => right.locator(".st-viewport-row").allTextContents()).toEqual(await left.locator(".st-viewport-row").allTextContents());
    await left.locator(".st-fold-button").click(); await expect(right.locator(".st-fold-button")).toHaveAttribute("aria-expanded", "true");
    await left.locator(".st-fold-button").click();
    const working = page.getByRole("textbox", { name: "Comparison working source", exact: true });
    await working.press("Control+Home"); await working.press("ArrowDown"); await working.press("Home"); await working.press("Shift+End"); await working.press("Delete");
    await expect(right.locator(".st-fold-button")).toHaveCount(0); await expect(left.locator(".st-fold-button")).toHaveCount(1);
    await expect(coloredImport(left)).toHaveText("import"); await expect(left).toContainText('import type { RecordId }');
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
    await expect(page.locator('#editor [data-folded-summary]')).toHaveAttribute("data-folded-summary", "… 1 line hidden");
    await expect(imports).toHaveValue("// working only\n" + original);
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
    await fixes.getByRole("button", { name: "Change spelling to 'basketTotal'", exact: true }).click(); await expect(fixes).toBeHidden();
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

        return Object.freeze({ concurrentProviderPages: true, projectConflict: true, preservedLocalEdits: true, staleReviewRejected: true, reviewedSave: true, reloadBothFiles: true });
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
