import { test, expect } from "./fixtures.ts";

test("editing with an unanswered draft keeps both versions available after reload", async ({ page }) => {
    page.on("dialog", dialog => dialog.accept()); await page.goto("/");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true }), status = page.locator("#recovery-status");
    const version = page.getByRole("combobox", { name: "Recovery version" });
    const restore = page.getByRole("button", { name: "Restore draft", exact: true });
    await source.press("Control+Home"); await page.keyboard.insertText("// Earlier work\n");
    await expect(status).toHaveText("Recovery draft captured in this browser.");
    await page.reload(); await expect(restore).toBeEnabled();
    await source.press("Control+Home"); await page.keyboard.insertText("// Later work\n");
    await expect(page.locator("#recovery-message")).toContainText("Your current edits have a recovery copy.");
    await page.reload(); await expect(version).toBeVisible();
    await expect(version.locator("option")).toHaveCount(2);
    await version.selectOption("1"); await restore.focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#editor")).toContainText("Earlier work");
    await expect(source).toBeFocused();
    await expect(page.locator("#editor")).not.toContainText("Later work");
    await expect(restore).toBeEnabled(); await restore.click();
    await expect(page.locator("#editor")).toContainText("Later work");
    await expect(page.locator("#editor")).not.toContainText("Earlier work");
    await page.getByRole("button", { name: "Discard offered drafts", exact: true }).click();
    await expect(status).toHaveText("Recovery draft captured in this browser."); await expect(source).toBeFocused();
    await page.reload();
    await expect(restore).toBeEnabled(); await expect(version).toBeHidden(); await restore.click();
    await expect(page.locator("#editor")).toContainText("Later work");
});

test("demo captures both files and explicitly restores a draft after real reload with linked undo", async ({ page }) => {
      page.on("dialog", dialog => dialog.accept());
    await page.goto("/");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+Home"); await source.pressSequentially("// Recover my cart\n");
    await page.getByRole("button", { name: "pricing.ts", exact: true }).click();
    const helper = page.getByRole("textbox", { name: "pricing.ts", exact: true });
    await helper.press("Control+Home"); await helper.pressSequentially("// Recover my helper\n");
    await expect(page.locator("#recovery-status")).toHaveText("Recovery draft captured in this browser.");
    await page.reload();
    await expect(page.locator("#recovery-offer")).toBeVisible();
    await expect(page.locator("#editor")).not.toContainText("Recover my cart");
    await page.getByRole("button", { name: "Restore draft", exact: true }).click();
    await expect(page.locator("#editor")).toContainText("// Recover my cart");
    await page.getByRole("button", { name: "pricing.ts ●", exact: true }).click();
    await expect(page.locator("#editor")).toContainText("// Recover my helper");
    await helper.press("Control+z");
    await expect(page.locator("#editor")).not.toContainText("Recover my helper");
    await expect(page.locator("#files")).not.toContainText("●");
    await helper.press("Control+y"); await helper.press("Control+s");
    await expect(page.locator("#status")).toContainText("Saved in this browser");
    await expect(page.locator("#recovery-status")).toHaveText("All changes are saved.");
    await page.reload();
    await expect(page.locator("#editor")).toContainText("// Recover my cart");
    await expect(page.locator("#recovery-offer")).toBeHidden();

});

test("typing while a committed restore awaits completion preserves current text and its recoverable draft", async ({ page }) => {
    page.on("dialog", dialog => dialog.accept());
    await page.goto("/");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+Home"); await source.pressSequentially("// Older draft\n");
    await expect(page.locator("#recovery-status")).toHaveText("Recovery draft captured in this browser.");
    await page.reload(); await expect(page.locator("#recovery-offer")).toBeVisible();
    await page.evaluate(() => {
        const transaction = IDBDatabase.prototype.transaction; let held: IDBTransaction | undefined;
        IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>) {
            const tx = transaction.apply(this, args);
            if (this.name === "sttropez-demo-recovery-v1" && args[1] === "readwrite" && !held) tx.addEventListener("complete", event => {
                event.stopImmediatePropagation(); held = tx;
            }, { capture: true, once: true });
            return tx;
        };
        Object.assign(window, { releaseDemoRestore: () => { IDBDatabase.prototype.transaction = transaction; held!.dispatchEvent(new Event("complete")); }, demoRestoreHeld: () => held !== undefined });
    });
    await page.getByRole("button", { name: "Restore draft", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { demoRestoreHeld(): boolean }).demoRestoreHeld())).toBe(true);
    await source.press("Control+Home"); await source.pressSequentially("// Typed while restoring\n");
    await page.evaluate(() => (window as unknown as { releaseDemoRestore(): void }).releaseDemoRestore());
    await expect(page.locator("#recovery-message")).toContainText("Your files changed while restoring");
    await expect(page.locator("#editor")).toContainText("// Typed while restoring");
    await expect(page.locator("#editor")).not.toContainText("// Older draft");
    await expect(page.locator("#recovery-message")).toContainText("Your edits have a recovery copy");
    await expect(page.getByRole("button", { name: "Restore draft", exact: true })).toBeEnabled();
    const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Download draft", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("pricing-recovery.json");
    await page.getByRole("button", { name: "Discard offered drafts", exact: true }).click();
    await expect(page.locator("#recovery-status")).toHaveText("Recovery draft captured in this browser.");
    await page.reload(); await page.getByRole("button", { name: "Restore draft", exact: true }).click();
    await expect(page.locator("#editor")).toContainText("// Typed while restoring");
    await expect(page.locator("#editor")).not.toContainText("// Older draft");
});

test("stale draft discard preserves a newer stored copy even without peer notices", async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(window, "BroadcastChannel", { value: class { constructor() { throw new Error("Peer notices unavailable"); } } }); });
    page.on("dialog", dialog => dialog.accept());
    await page.goto("/"); const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+Home"); await source.pressSequentially("// Initial draft\n");
    await expect(page.locator("#recovery-status")).toHaveText("Recovery draft captured in this browser.");
    await page.reload(); await expect(page.locator("#recovery-offer")).toBeVisible();
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("sttropez-demo-recovery-v1"); open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result, tx = db.transaction("drafts", "readwrite"), store = tx.objectStore("drafts"), get = store.get("pricing");
            get.onsuccess = () => { const row = get.result; row.token = "newer-draft"; row.value.files["main.ts"] = "// Newer peer draft\n"; store.put(row, "pricing"); };
            tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
        };
    }));
    await page.getByRole("button", { name: "Discard offered drafts", exact: true }).click();
    await expect(page.locator("#recovery-retry")).toBeVisible();
    await page.getByRole("button", { name: "Check recovery", exact: true }).click();
    await page.getByRole("button", { name: "Restore draft", exact: true }).click();
    await expect(page.locator("#editor")).toContainText("// Newer peer draft");
});

test("recovery storage failure leaves editing available and supports a fresh check", async ({ page }) => {
    await page.addInitScript(() => {
        const put = IDBObjectStore.prototype.put; let failed = false;
        IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
            if (!failed && this.transaction.db.name === "sttropez-demo-recovery-v1") { failed = true; throw new DOMException("Recovery quota exceeded", "QuotaExceededError"); }
            return put.apply(this, args);
        };
    });
    await page.goto("/"); const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+Home"); await source.pressSequentially("// Keep my edits\n");
    await expect(page.locator("#recovery-status")).toContainText("Recovery quota exceeded");
    await expect(page.locator("#editor")).toContainText("// Keep my edits");
    await page.getByRole("button", { name: "Check recovery", exact: true }).click();
    await expect(page.locator("#recovery-status")).toHaveText("Recovery draft captured in this browser.");
});
