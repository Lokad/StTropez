import { test, expect } from "./fixtures.ts";
import { controlDemoAnalysis, holdDemoAnalysis, releaseDemoAnalysis } from "./demo-presentation.ts";

test("fold discovery keeps an inserted line visible above the closing brace", async ({ page }) => {
    await page.goto("/"); await page.locator("#sample").selectOption("shipping");
    const fold = page.locator("#editor .st-fold-button").first(), source = page.locator("#editor textarea");
    const edited = page.locator('#editor .st-viewport-row[data-line="7"]');
    await fold.click(); await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(edited).toHaveText("}"); await edited.click({ position: { x: 2, y: 8 } });
    await source.press("Home"); await source.press("Control+Shift+Enter");
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(edited).toBeVisible(); await expect(edited).toHaveText(/^\s*$/);
    await page.keyboard.type("visible"); await expect(edited).toHaveText(/^\s*visible$/);
    await source.press("Control+z"); await expect(edited).toHaveText(/^\s*$/);
});

test("Undo restores 150 typed words and the earlier edit in another file", async ({ page }) => {
    await page.goto("/");
    const source = (name: string) => page.getByRole("textbox", { name, exact: true });
    const file = (name: string) => page.locator("#files").getByRole("button", { name, exact: true });
    await source("main.ts").press("Control+Home");
    await page.keyboard.type("first");
    await file("pricing.ts").click();
    await source("pricing.ts").press("Control+End");
    await page.keyboard.type(Array.from({ length: 150 }, () => "word").join(" "));
    await expect(file("pricing.ts ●")).toBeVisible();
    for (let i = 0; i < 150; i++) await page.keyboard.press("Control+z");
    await expect(file("pricing.ts")).toBeVisible();
    await page.keyboard.press("Control+Shift+z");
    await expect(page.locator("#editor .st-viewport-row").last()).toContainText("word");
    await file("main.ts ●").click();
    await source("main.ts").press("Control+z");
    await expect(file("main.ts")).toBeVisible();
    await expect(page.locator("#editor .st-viewport-row").first()).toContainText("import");
});

test("demo edits real files, preserves selection/history, finds text and reviews undoable changes", async ({ page }) => {

    await page.goto("/");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await expect(source).toBeVisible();
    await expect(page.locator("#analysis-status")).toContainText("syntax & emit");
    await expect(page.locator("#editor .demo-token-keyword").first()).toHaveText("import");
    await expect(page.getByRole("region", { name: "JavaScript output", exact: true })).not.toContainText("CartItem");
    await source.press("Control+Home"); await source.pressSequentially("/* Mine */");
    await expect(page.locator("#files")).toContainText("main.ts ●");
    await page.getByRole("button", { name: "pricing.ts", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "pricing.ts", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "main.ts ●", exact: true }).click();
    await expect(page.locator("#cursor")).toHaveText("Ln 1, Col 11");
    for (const prefix of ["/* Mine", "/*", ""]) {
        await source.press("Control+z"); await expect(page.locator("#editor .st-viewport-row").first()).toHaveText(prefix + 'import { calculateTotal } from "./pricing";');
    }
    await expect(page.locator("#files")).not.toContainText("●");
    for (const prefix of ["/*", "/* Mine", "/* Mine */"]) {
        await source.press("Control+y"); await expect(page.locator("#editor .st-viewport-row").first()).toHaveText(prefix + 'import { calculateTotal } from "./pricing";');
    }
    await expect(page.locator("#files")).toContainText("●");
    await source.press("Control+h");
    await page.getByRole("textbox", { name: "Find text", exact: true }).fill("Notebook");
    await expect(page.locator("#find-status")).toHaveText("1 of 1");
    await page.getByRole("textbox", { name: "Replacement text", exact: true }).fill("Sketchbook");
    await page.getByRole("button", { name: "Replace all", exact: true }).click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Comparison working source", exact: true })).toBeFocused();
    await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    const working = page.locator(".st-comparison-panes > section").last(), restore = page.getByRole("button", { name: "Use baseline", exact: true });
    await expect(working).toContainText("Sketchbook");
    await page.getByRole("button", { name: "Next change", exact: true }).click();
    await expect(restore).toHaveAttribute("title", "Restore change 2 of 2 from the baseline"); await restore.click();
    await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    await expect(working).toContainText("Notebook"); await expect(working).toContainText("/* Mine */");
    await page.getByRole("textbox", { name: "Comparison working source", exact: true }).press("Control+z");
    await expect(working).toContainText("Sketchbook"); await expect(working).toContainText("/* Mine */");
    await page.getByRole("button", { name: "JavaScript", exact: true }).click();
    await expect(page.locator("#analysis-status")).toContainText("syntax & emit");

});

test("demo retains independent samples and resets both project files through shared history", async ({ page }) => {
    page.on("dialog", dialog => dialog.accept());
    await page.goto("/");
    const main = page.getByRole("textbox", { name: "main.ts", exact: true });
    await main.press("Control+Home"); await main.pressSequentially("/* Cart edit */");
    await page.getByRole("button", { name: "pricing.ts", exact: true }).click();
    const helper = page.getByRole("textbox", { name: "pricing.ts", exact: true });
    await helper.press("Control+Home"); await helper.pressSequentially("/* Helper edit */");
    await page.locator("#sample").selectOption("unicode");
    const unicode = page.getByRole("textbox", { name: "greetings.ts", exact: true });
    await expect(unicode).toBeVisible(); await expect(page.locator("#cursor")).toHaveText("Ln 1, Col 1");
    await unicode.press("Control+Home"); await unicode.pressSequentially("/* Unicode edit */");
    await page.locator("#sample").selectOption("pricing");
    await expect(helper).toBeVisible(); await expect(page.locator("#editor")).toContainText("/* Helper edit */");
    await page.getByRole("button", { name: "Reset sample", exact: true }).click();
    await expect(helper).toBeFocused(); await expect(page.locator("#files")).not.toContainText("●");
    await expect(page.locator("#editor")).not.toContainText("/* Helper edit */");
    await helper.press("Control+z");
    await expect(page.locator("#editor")).toContainText("/* Helper edit */");
    await page.getByRole("button", { name: "main.ts ●", exact: true }).click();
    await expect(page.locator("#editor")).toContainText("/* Cart edit */");
    await page.locator("#sample").selectOption("unicode");
    await expect(page.locator("#editor")).toContainText("/* Unicode edit */");
});

test("demo colors clipped template text with whole-file context and refreshes it after edits", async ({ page }) => {
    await page.goto("/");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+a");
    await page.keyboard.insertText('const longText = `' + "x".repeat(12_000) + ' visible tail`;');
    await source.press("Control+End");
    await expect(page.locator("#analysis-status")).toContainText("syntax & emit");
    await expect(page.locator("#editor .demo-token-string").filter({ hasText: "visible tail" })).toBeVisible();
    await source.press("Control+Home"); await page.keyboard.insertText("/* open comment\n");
    await source.press("Control+End");
    await expect(page.locator("#analysis-status")).toContainText("syntax & emit");
    await expect(page.locator("#editor .demo-token-comment").filter({ hasText: "visible tail" })).toBeVisible();
    await source.press("Control+z"); await source.press("Control+End");
    await expect(page.locator("#editor .demo-token-string").filter({ hasText: "visible tail" })).toBeVisible();
});

test("demo save receipts retain their captured files and leave later typing dirty", async ({ page }) => {
    await page.addInitScript(() => {
        const transaction = IDBDatabase.prototype.transaction;
        Object.assign(window, { heldDemoTransactions: [] as IDBTransaction[] });
        IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>) {
            const tx = transaction.apply(this, args);
            if (this.name === "sttropez-demo-projects-v1" && args[1] === "readwrite") tx.addEventListener("complete", event => {
                event.stopImmediatePropagation(); (window as unknown as { heldDemoTransactions: IDBTransaction[] }).heldDemoTransactions.push(tx);
            }, { capture: true, once: true });
            return tx;
        };
    });
    await page.goto("/");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+Home"); await source.pressSequentially("// Captured\n");
    await page.getByRole("button", { name: "Save locally", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { heldDemoTransactions: IDBTransaction[] }).heldDemoTransactions.length)).toBe(1);
    await expect(source).toBeFocused();
    await page.keyboard.insertText("// Later main\n");
    await page.getByRole("button", { name: "pricing.ts", exact: true }).click();
    const helper = page.getByRole("textbox", { name: "pricing.ts", exact: true });
    await helper.press("Control+Home"); await helper.pressSequentially("// Later helper\n");
    await page.evaluate(() => {
        const tx = (window as unknown as { heldDemoTransactions: IDBTransaction[] }).heldDemoTransactions.shift()!;
        tx.oncomplete?.call(tx, new Event("complete"));
    });
    await expect(page.locator("#status")).toContainText("Saved in this browser");
    await expect(helper).toBeFocused();
    await expect(page.getByRole("button", { name: "main.ts ●", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "pricing.ts ●", exact: true })).toBeVisible();
    const saved = await page.evaluate(() => new Promise<Record<string, string>>((resolve, reject) => {
        const open = indexedDB.open("sttropez-demo-projects-v1"); open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result, get = db.transaction("drafts").objectStore("drafts").get("pricing");
            get.onsuccess = () => { resolve(get.result.value.files); db.close(); }; get.onerror = () => { db.close(); reject(get.error); };
        };
    }));
    expect(saved["main.ts"]).toContain("// Captured"); expect(saved["main.ts"]).not.toContain("Later");
    expect(saved["pricing.ts"]).not.toContain("Later");
});

test("demo opens a generated project and edits its final line", async ({ page }) => {
    await page.goto("/");
    await page.locator("#sample").selectOption("results");
    const source = page.getByRole("textbox", { name: "uses.ts", exact: true });
    await source.press("Control+End");
    await page.keyboard.insertText("// edited");
    const lastRow = page.locator("#editor .st-viewport-row").last();
    await expect(lastRow).toHaveText("// edited");
    await expect(page.locator("#cursor")).toHaveText("Ln 1202, Col 10");
    await source.press("Control+z");
    await expect(lastRow).toHaveText("");
});

test("demo local save persists both files and prevents a stale page from replacing them", async ({ page, context }) => {
    await page.goto("/");
    const peer = await context.newPage(); await peer.goto("/");
    await expect(peer.getByRole("textbox", { name: "main.ts", exact: true })).toBeVisible();
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+Home"); await source.pressSequentially("// First page\n");
    await page.getByRole("button", { name: "pricing.ts", exact: true }).click();
    const pricing = page.getByRole("textbox", { name: "pricing.ts", exact: true });
    await pricing.press("Control+Home"); await pricing.pressSequentially("// Saved helper\n");
    await pricing.press("Control+s");
    await expect(page.locator("#status")).toContainText("Saved in this browser");
    await expect(page.locator("#files")).not.toContainText("●");
    const peerSource = peer.getByRole("textbox", { name: "main.ts", exact: true });
    await peerSource.press("Control+Home"); await peerSource.pressSequentially("// Peer changes\n");
    await peer.getByRole("button", { name: "Save locally", exact: true }).click();
    await expect(peer.locator("#status")).toContainText("Another page saved this sample");
    await expect(peer.locator("#editor")).toContainText("// Peer changes");
    await page.reload();
    await expect(page.locator("#editor")).toContainText("// First page");
    await page.getByRole("button", { name: "pricing.ts", exact: true }).click();
    await expect(page.locator("#editor")).toContainText("// Saved helper");
    const download = peer.waitForEvent("download");
    await peer.getByRole("button", { name: "Download my changes", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("pricing-changes.json");
    await peer.setViewportSize({ width: 680, height: 900 });
    await peer.getByRole("button", { name: "Review saved copy", exact: true }).click();
    await expect(peer.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    await expect(peer.locator(".demo-review-labels > span:not(.demo-review-hint)")).toHaveText(["Other page's saved copy", "Your changes"]);
    await expect.poll(() => peer.locator(".demo-review-labels > span").first().evaluate(caption => {
        const pane = document.querySelector(".st-comparison-panes .st-viewport")!.getBoundingClientRect();
        return Math.abs(caption.getBoundingClientRect().bottom - pane.top);
    })).toBeLessThan(1);
    await expect(peer.locator(".st-comparison-panes > section").first()).toContainText("// First page");
    await expect(peer.locator(".st-comparison-panes > section").last()).toContainText("// Peer changes");
    const saveReviewed = peer.getByRole("button", { name: "Save my reviewed version", exact: true });
    await expect(saveReviewed).toBeEnabled();
    const working = peer.getByRole("textbox", { name: "Comparison working source", exact: true });
    await working.press("Control+Home"); await working.pressSequentially("// Revised locally\n");
    await expect(saveReviewed).toBeDisabled();
    await peer.getByRole("button", { name: "Review saved copy", exact: true }).click();
    const reference = peer.getByRole("textbox", { name: "Comparison baseline source", exact: true });
    await reference.press("Control+Home");
    await saveReviewed.click();
    await expect(peer.locator("#status")).toContainText("Saved in this browser");
    await expect(reference).toBeFocused();
    await expect(peer.locator("#save-conflict")).toBeHidden();
    await expect(peer.locator(".demo-review-labels > span:not(.demo-review-hint)")).toHaveText(["Saved copy", "Your changes"]);
    await page.reload();
    await expect(page.locator("#editor")).toContainText("// Peer changes");
    await expect(page.locator("#editor")).toContainText("// Revised locally");
    await expect(page.locator("#editor")).not.toContainText("// First page");
});

test("demo storage failure preserves edits and a retry saves the captured project", async ({ page }) => {
    await page.addInitScript(() => {
        const put = IDBObjectStore.prototype.put;
        let failed = false;
        IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
            if (!failed && this.transaction.db.name === "sttropez-demo-projects-v1") {
                failed = true; throw new DOMException("No space", "QuotaExceededError");
            }
            return put.apply(this, args);
        };
    });
    await page.goto("/");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+Home"); await source.pressSequentially("// Keep these changes\n");
    await source.press("Control+s");
    await expect(page.locator("#status")).toContainText("Could not save");
    await expect(page.locator("#editor")).toContainText("// Keep these changes");
    await expect(page.getByRole("button", { name: "main.ts ●", exact: true })).toBeVisible();
    await source.press("Control+s");
    await expect(page.locator("#status")).toContainText("Saved in this browser");
});

test("demo rejects obsolete analysis, supports multiline colors and keeps editing after worker failure", async ({ page }) => {
    await controlDemoAnalysis(page);
    await page.goto("/");
    await page.locator("#sample").selectOption("unicode");
    await expect(page.locator("#analysis-status")).toContainText("syntax & emit");
    await expect(page.locator("#editor .demo-token-string").filter({ hasText: "Welcome!" })).toBeVisible();
    await page.locator("#sample").selectOption("pricing");
    await holdDemoAnalysis(page);
    await page.getByRole("textbox", { name: "main.ts", exact: true }).press("Control+Home"); await page.keyboard.insertText("// pending analysis\n");
    await expect.poll(() => page.evaluate(() => (window as unknown as { demoAnalysisControl: { held: number } }).demoAnalysisControl.held)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "pricing.ts", exact: true }).hover(); await page.mouse.down();
    await releaseDemoAnalysis(page); await expect(page.locator("#analysis-status")).toContainText("syntax & emit");
    await page.mouse.up(); await expect(page.getByRole("textbox", { name: "pricing.ts", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "JavaScript output", exact: true })).toContainText("export function calculateTotal");
    await expect(page.getByRole("region", { name: "JavaScript output", exact: true })).not.toContainText("const cart");
    await page.route("**/demo-syntax-worker.js", route => route.abort());
    await page.reload();
    await expect(page.locator("#analysis-status")).toHaveText("Analysis unavailable");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+Home"); await source.pressSequentially("// Still editable\n");
    await expect(page.locator("#editor")).toContainText("// Still editable");
    await page.unroute("**/demo-syntax-worker.js");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator("#analysis-status")).toContainText("syntax & emit");
    await expect(page.getByRole("region", { name: "JavaScript output", exact: true })).toContainText("// Still editable");
    // A new saved-copy worker can fail independently; retry and replacement keep exact snapshot ownership.
    await page.route("**/demo-syntax-worker.js", route => route.abort());
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page.locator("#analysis-status")).toHaveText("Saved-copy analysis unavailable");
    const left = page.locator(".st-comparison-panes > section").first(), right = page.locator(".st-comparison-panes > section").last();
    await expect(right.locator(".demo-token-comment").first()).toHaveText("// Still editable");
    await page.unroute("**/demo-syntax-worker.js"); await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(left.locator(".demo-token-keyword").first()).toHaveText("import");
    await expect(left.locator(".st-fold-button").first()).toBeVisible();
    await holdDemoAnalysis(page); await page.getByRole("button", { name: "Save locally", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { demoAnalysisControl: { held: number } }).demoAnalysisControl.held)).toBeGreaterThan(0);
    await page.locator("#sample").selectOption("unicode"); await releaseDemoAnalysis(page);
    await expect(left.locator(".demo-token-string").filter({ hasText: "Welcome!" })).toBeVisible();
    await expect(left).not.toContainText("Still editable"); await expect(left).not.toContainText("calculateTotal");
    await page.locator('[data-panel="javascript"]').click(); await expect(page.locator(".st-comparison")).toHaveCount(0);
});
