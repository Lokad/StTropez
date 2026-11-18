import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";

/**
 * Package-boundary coverage; protocol permutations and host controls have their own primary tests.
 * @param {import("@playwright/test").Browser} browser
 * @param {string} url
 * @param {{packageSha256: string}} options
 */
export async function runPackagedLsp(browser, url, { packageSha256 }) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    /** @type {string[]} */ const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
        await page.goto(url); const input = page.getByRole("textbox", { name: "Public LSP source", exact: true });
        /** @param {string} name */ const button = name => page.getByRole("button", { name, exact: true });
        const state = () => page.evaluate(() => window.publicLsp.state()), text = () => page.evaluate(() => window.publicLsp.text());
        await input.waitFor(); assert.equal((await state()).provider.created, 0); await button("Connect").click(); await expect.poll(async () => (await state()).editor.connected).toBe(true);
        await input.focus(); await page.evaluate(() => window.publicLsp.select(8)); await input.pressSequentially("x"); const typed = await text();
        await button("Request completion").click(); await expect(button("sampleWithImport")).toBeVisible(); await button("sampleWithImport").click();
        const depth = (await state()).history.undoDepth; await button("Apply completion").click(); assert.equal((await state()).history.undoDepth, depth + 1);
        assert.ok((await text()).startsWith("// fixture import\r\nconst sampleValue")); await input.press("Control+z"); assert.equal(await text(), typed);
        await button("Hover").click(); await expect.poll(async () => (await state()).notes.hover).toContain("Fixture consumer+opaque:");
        await button("Definition").click(); await expect.poll(async () => (await state()).notes.navigation).toBe((await state()).companion);
        await button("Rename preview").click(); await expect.poll(async () => (await state()).notes.renameEdits ?? 0).toBeGreaterThan(1);
        const history = (await state()).history.undoDepth; await button("Apply rename").click(); await expect(page.locator("#result")).toHaveText("Rename applied");
        assert.equal((await state()).history.undoDepth, history + 1); assert.ok((await text()).includes("inventory")); await input.press("Control+z"); assert.equal(await text(), typed);
        await button("Code actions").click(); await expect.poll(async () => (await state()).notes.actions ?? 0).toBeGreaterThan(1); await expect.poll(async () => (await state()).notes.resolved).toBe(true);
        await page.evaluate(() => window.publicLsp.custom("fixture/completionStyle", { style: "interactive" }));
        await input.focus(); await page.evaluate(() => window.publicLsp.select(9)); await input.press("Backspace"); await input.pressSequentially("m");
        await expect(button("sampleWithImport")).toBeVisible(); await expect.poll(async () => (await state()).editor.pending).toBe(false);
        const retained = await button("sampleWithImport").elementHandle(); assert.ok(retained, "Expected the captured completion control");
        await input.pressSequentially("p"); await expect.poll(async () => (await state()).editor.pending).toBe(false);
        await retained.evaluate(node => { if (!(node instanceof HTMLButtonElement)) throw new Error("Expected a completion button"); node.click(); }); assert.equal((await state()).completion.choiceIndex, 0);
        await button("sampleWithImport").click(); await expect.poll(async () => (await state()).editor.pending).toBe(false);
        const beforeCommit = await text(), commitDepth = (await state()).history.undoDepth; await input.pressSequentially(";");
        assert.ok((await text()).startsWith("// resolved import\r\nconst sampleValue;")); assert.equal((await state()).history.undoDepth, commitDepth + 1);
        await input.press("Control+z"); assert.equal(await text(), beforeCommit);
        await button("Signature").click(); await expect.poll(async () => (await state()).notes.signature).toBe("fallback?: string");
        await button("Links").click(); await expect.poll(async () => (await state()).notes.linkUri).toBe(`consumer+opaque:project/${encodeURIComponent((await state()).companionResource)}`);
        await button("Colors").click(); await expect.poll(async () => (await state()).notes.colorPresentations ?? 0).toBeGreaterThan(0);
        const beforeColor = await text(), colorDepth = (await state()).history.undoDepth; await button("Apply color").click(); await expect.poll(async () => (await state()).notes.colorApplied).toBe(true);
        assert.equal((await state()).history.undoDepth, colorDepth + 1); assert.equal(await text(), "// color presentation\r\n" + beforeColor.replace("#abc", "rgba(1, 2, 3, 0.5)")); await input.press("Control+z"); assert.equal(await text(), beforeColor);
        const counts = await page.evaluate(() => window.publicLsp.custom("fixture/synchronization", {}));
        assert.ok(counts && typeof counts === "object" && !Array.isArray(counts)
            && "initialize" in counts && "failures" in counts && "documents" in counts, "Expected synchronization counters");
        assert.equal(counts.initialize, 1); assert.deepEqual(counts.failures, []);
        assert.ok(Array.isArray(counts.documents) && counts.documents.every(document => document && typeof document === "object"
            && !Array.isArray(document) && "open" in document && document.open === 1));
        await page.evaluate(() => window.publicLsp.dispose()); const final = await state(); assert.equal(final.provider.scopes, 0); assert.equal(final.provider.created, final.provider.terminated);
        assert.deepEqual([final.diagnostics.leases, final.diagnostics.views, final.diagnostics.subscriptions], [0, 0, 0]); assert.deepEqual(final.errors, []); assert.deepEqual(errors, []);
        await writeFile(`artifacts/package/lsp-${browser.browserType().name()}.json`, JSON.stringify({ status: "passed", packageSha256, automaticCompletion: true, obsoleteListControlRejected: true, notes: final.notes, synchronization: counts, final, errors }, null, 2));
    } finally { await page.close(); }
}
