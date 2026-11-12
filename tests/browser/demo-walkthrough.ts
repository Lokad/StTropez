import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

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
    await expect(page.locator("#panel-content pre")).toContainText("calculateTotal(cart, 0.2)", { timeout: 30000 });
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
    await expect(page.locator("#panel-content pre")).toContainText("basketTotal(cart, 0.2)", { timeout: 30000 });
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
    await page.reload(); await expect(page.locator("#recovery-offer")).toBeVisible();
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
