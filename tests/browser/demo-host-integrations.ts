import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

async function paste(source: Locator, plain: string) {
    await source.evaluate((node, text) => {
        const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
        event.clipboardData!.setData("text/plain", text); node.dispatchEvent(event);
    }, plain);
}

/** One visible workflow shared by source, static and restored-assets hosts. No OS clipboard access. */
export async function runDemoHostIntegrations(page: Page, url = "/") {

    await page.goto(url); await page.locator("#sample").selectOption("host");
    const source = page.getByRole("textbox", { name: "workflow.rules", exact: true });
    const notes = page.locator(".demo-source-notes span"), inventory = notes.filter({ hasText: "Inventory source" });
    await expect(page.locator("#language-status")).toHaveText("Host language · no language server");
    await expect(page.locator("#editor .demo-token-keyword").first()).toHaveText("dataset");
    await expect(notes).toHaveCount(2); await expect(inventory).toHaveAttribute("data-line", "3");
    const original = await source.inputValue();
    await source.press("Control+Home"); await page.keyboard.insertText("# Prefix\n");
    await expect(inventory).toHaveAttribute("data-line", "4");
    await source.press("Control+z"); await expect(inventory).toHaveAttribute("data-line", "3");
    await page.locator("#editor .st-fold-button").first().click(); await expect(inventory).toContainText("folded");
    await page.locator('#files [data-file="inventory.csv"]').click(); await expect(notes).toHaveCount(0);
    await page.locator('#files [data-file="workflow.rules"]').click(); await expect(inventory).toContainText("folded");
    await page.locator("#editor .st-fold-button").first().click(); await expect(inventory).not.toContainText("folded");

    await source.press("Control+f"); await page.locator("#find-query").fill("quantity < 10");
    await expect(page.locator("#find-status")).toHaveText("1 matches"); await page.locator("#find-next").click(); await page.locator("#find-close").click();
    await source.press("Control+Alt+m"); await expect(notes).toHaveCount(3);
    await source.press("Delete"); await expect(notes).toHaveCount(2);
    await source.press("Control+z"); await expect(source).toHaveValue(original);

    await source.press("Control+End"); await page.locator("#code-menu summary").click();
    await page.locator("#host-paste-mode").selectOption("csv"); await page.locator("#code-menu summary").click();
    await paste(source, "a\tb\nc\td"); await expect(page.locator("#host-status")).toHaveText("Pasted 2 × 2 table as CSV.");
    // Textarea values normalize line endings; model paste tests own exact CRLF preservation.
    await expect(source).toHaveValue(original + '"a","b"\n"c","d"');
    await source.press("Control+z"); await expect(source).toHaveValue(original);
    expect(await source.evaluate(node => {
        const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
        event.clipboardData!.setData("text/plain", "pending\tvalue\n".repeat(5000)); node.dispatchEvent(event);
        document.querySelector<HTMLButtonElement>("#save")!.click();
        const message = document.querySelector("#status")!.textContent;
        node.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        return message;
    })).toContain("An edit is still in progress");
    await expect(page.locator("#host-status")).toContainText("cancelled"); await source.press("?"); await expect(source).toHaveValue(original + "?");
    await source.press("Control+z"); await expect(source).toHaveValue(original);
    await page.locator("#code-menu summary").click(); await page.locator("#host-insert-table").click();
    await expect(page.locator("#host-status")).toHaveText("Pasted 3 × 2 table as CSV.");
    await expect(source).toHaveValue(original + '"sku","quantity"\n"A-100","12"\n"B-200","8"\n');
    await source.press("Control+z"); await expect(source).toHaveValue(original);
    await source.press("Control+Alt+v"); await expect(page.locator("#host-status")).toHaveText("Literal paste is active.");
    await paste(source, "a\tb\nc\td"); await expect(source).toHaveValue(original + "a\tb\nc\td");
    await source.press("Control+z"); await expect(source).toHaveValue(original);

    // The host's colon rule and comment syntax use the ordinary editor command/history path.
    await source.press("Control+End"); await page.keyboard.insertText("rule New:"); await source.press("Enter");
    await expect(source).toHaveValue(original + "rule New:\n  "); await source.press("Control+/");
    await expect(source).toHaveValue(original + "rule New:\n  # ");
    await page.locator("#save").click(); await expect(page.locator("#status")).toContainText("Saved in this browser");
    await page.locator("#compare").click(); await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    const panes = page.locator(".st-comparison-panes > section");
    await expect(panes.first().locator(".demo-token-keyword").first()).toHaveText("dataset");
    await expect(panes.last().locator(".demo-token-keyword").first()).toHaveText("dataset");
    await expect(notes).toHaveCount(2); await page.locator('[data-panel="javascript"]').click();

    // Offscreen notes disappear and reappear at mapped positions without entering source text.
    await source.press("Control+Home"); await paste(source, "# padding\n".repeat(200));
    await source.press("Control+Home"); await expect(notes).toHaveCount(0);
    await source.press("Control+End"); await expect(inventory).toHaveAttribute("data-line", "203");
    await source.press("Control+z"); await expect(inventory).toHaveAttribute("data-line", "3");
    await page.locator("#sample").selectOption("pricing"); await expect(page.locator(".demo-source-notes")).toHaveCount(0);
    await expect(page.locator("#host-status")).toBeHidden();
}
