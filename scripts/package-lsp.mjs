import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { paintedCharacter } from "../tests/helpers/painted-character.ts";

/**
 * Package-boundary coverage; protocol permutations and host controls have their own primary tests.
 * @param {import("@playwright/test").Browser} browser
 * @param {string} url
 * @param {{packageSha256: string}} options
 */
export async function runPackagedLsp(browser, url, { packageSha256 }) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    /** @type {string[]} */ const errors = [];
    /** @type {{textDocument?: Record<string, unknown>, workspace?: {executeCommand?: unknown}}[]} */ const negotiations = [];
    page.on("websocket", socket => socket.on("framesent", ({ payload }) => {
        if (typeof payload !== "string") return;
        const message = JSON.parse(payload);
        if (message.method === "initialize") negotiations.push(message.params.capabilities);
    }));
    page.on("pageerror", error => errors.push(error.message));
    try {
        await page.goto(url); const input = page.getByRole("textbox", { name: "Public LSP source", exact: true });
        /** @param {string} name */ const button = name => page.getByRole("button", { name, exact: true });
        const state = () => page.evaluate(() => window.publicLsp.state()), text = () => page.evaluate(() => window.publicLsp.text());
        await input.waitFor(); assert.equal((await state()).provider.created, 0); await button("Connect").click(); await expect.poll(async () => (await state()).editor.connected).toBe(true);
        assert.equal(negotiations.length, 1);
        const advertised = negotiations[0];
        assert.deepEqual(Object.keys(advertised?.textDocument ?? {}).sort(), ["codeAction", "colorProvider", "completion", "definition", "documentHighlight",
            "documentLink", "foldingRange", "hover", "publishDiagnostics", "references", "rename", "signatureHelp", "synchronization"]);
        assert.deepEqual(advertised?.workspace?.executeCommand, { dynamicRegistration: true });
        const marker = page.locator("#editor .st-diagnostic");
        await expect(marker).toHaveText("TODO");
        const firstDiagnostic = await page.evaluateHandle(() => {
            const diagnostics = window.publicLsp.diagnostics, state = diagnostics.getSnapshot(), first = state.diagnostics[0];
            if (!first || ![state, state.diagnostics, state.unversionedDiagnostics, first].every(Object.isFrozen)) throw new Error("Expected immutable diagnostics");
            diagnostics.cancel(); return first;
        });
        await expect(marker).toHaveCount(0);
        await input.focus(); await page.evaluate(() => window.publicLsp.select(8)); await input.pressSequentially("x"); const typed = await text();
        await button("Request completion").click(); await expect(button("sampleWithImport")).toBeVisible(); await button("sampleWithImport").click();
        const depth = (await state()).history.undoDepth; await button("Apply completion").click(); assert.equal((await state()).history.undoDepth, depth + 1);
        assert.ok((await text()).startsWith("// fixture import\r\nconst sampleValue")); await input.press("Control+z"); assert.equal(await text(), typed);
        await button("Hover").click(); await expect.poll(async () => (await state()).notes.hover).toContain("Fixture consumer+opaque:");
        const offset = typed.indexOf("TODO") + 1;
        assert.equal(await page.evaluate(at => window.publicLsp.pointerHover(at), offset), 0);
        // This provider returns no symbol range. Another position inside the diagnostic needs its own reply.
        assert.equal(await page.evaluate(at => window.publicLsp.pointerHover(at), offset + 1), 1);
        const lines = typed.slice(0, offset + 1).split(/\r\n|\r|\n/);
        await expect.poll(async () => (await state()).notes.hover).toContain(`Fixture consumer+opaque:project/source:${lines.length - 1}:${lines.at(-1)?.length ?? 0}`);
        assert.equal(await page.evaluate(() => window.publicLsp.probeTypedHover()), "Fixture consumer+opaque:project/source:5:6");
        const beforeNavigation = (await state()).diagnostics.leases;
        await button("Definition").click(); await button("Open definition").click();
        await expect.poll(async () => (await state()).notes.navigation).toBe((await state()).companion);
        const priorChoice = await button("Opened definition").elementHandle(); assert.ok(priorChoice);
        await button("Edit companion").click();
        await priorChoice.evaluate(node => /** @type {HTMLButtonElement} */ (node).click()); assert.equal(await priorChoice.textContent(), "Expired definition");
        await priorChoice.dispose(); assert.equal(await text(), typed);
        await expect.poll(async () => (await state()).diagnostics.leases).toBeLessThanOrEqual(beforeNavigation);
        await button("Rename preview").click(); await expect.poll(async () => (await state()).notes.renameEdits ?? 0).toBeGreaterThan(1);
        const retiredRename = await button("Apply rename").evaluateHandle(node => /** @type {HTMLButtonElement} */ (node).onclick?.bind(node));
        await button("Edit companion").click(); await expect(button("Apply rename")).toBeDisabled();
        await button("Rename preview").click(); await expect(button("Apply rename")).toBeEnabled();
        assert.deepEqual(await retiredRename.evaluate(confirm => confirm?.(new PointerEvent("click"))), { applied: false, reason: "expired" }); await retiredRename.dispose();
        assert.equal(await text(), typed); await expect(button("Apply rename")).toBeEnabled();
        const history = (await state()).history.undoDepth;
        assert.deepEqual(await page.evaluate(() => window.publicLsp.confirmWithWriteFailure("rename")),
            { applied: false, reason: "failed", message: "Fixture write failure" });
        await expect(page.locator("#result")).toHaveText("Fixture write failure");
        assert.equal(await text(), typed); assert.equal((await state()).history.undoDepth, history);
        await button("Rename preview").click(); await button("Apply rename").click(); await expect(page.locator("#result")).toHaveText("Rename applied");
        assert.deepEqual((await state()).notes.lastReview, { applied: true });
        assert.equal((await state()).history.undoDepth, history + 1); assert.ok((await text()).includes("inventory")); await input.press("Control+z"); assert.equal(await text(), typed);
        await button("Code actions").click(); await expect.poll(async () => (await state()).notes.actions ?? 0).toBeGreaterThan(1);
        await button("Review lazy action").click(); await expect(button("Apply reviewed action")).toBeEnabled();
        assert.deepEqual(await page.evaluate(() => window.publicLsp.confirmWithWriteFailure("action")),
            { status: "failed", message: "Fixture write failure" });
        await expect(page.locator("#result")).toHaveText("Fixture write failure");
        assert.equal(await text(), typed); assert.equal((await state()).history.undoDepth, history);
        await button("Code actions").click();
        await button("Review lazy action").click(); await expect.poll(async () => (await state()).notes.resolved).toBe(true);
        await expect(page.locator("#result")).toContainText("TODO → DONE"); assert.equal(await text(), typed);
        const actionDepth = (await state()).history.undoDepth; await button("Apply reviewed action").click();
        await expect.poll(text).toBe(typed.replace("TODO", "DONE")); assert.equal((await state()).history.undoDepth, actionDepth + 1);
        assert.deepEqual((await state()).notes.lastAction, { status: "applied" });
        await input.press("Control+z"); assert.equal(await text(), typed);
        await page.evaluate(() => window.publicLsp.custom("fixture/completionStyle", { style: "interactive" }));
        await input.focus(); await page.evaluate(() => window.publicLsp.select(9)); await input.press("Backspace"); await input.pressSequentially("m");
        await expect(button("sampleWithImport")).toBeVisible(); await expect.poll(async () => (await state()).editor.pending).toBe(false);
        const retained = await button("sampleWithImport").elementHandle(); assert.ok(retained, "Expected the captured completion control");
        await input.pressSequentially("p"); await expect.poll(async () => (await state()).editor.pending).toBe(false);
        const filtered = await state(), requests = filtered.editor.posted;
        assert.ok(filtered.completion.anchor);
        assert.equal(filtered.completion.anchor.to, filtered.completion.anchor.from + 4, "The restored list anchors to the typed prefix");
        await input.press("Backspace"); await expect(button("sampleWithImport")).toBeVisible();
        await expect.poll(async () => (await state()).editor.pending).toBe(false);
        const narrowed = await state();
        assert.equal(narrowed.editor.posted, requests, "Backspace inside a complete prefix reuses the restored list");
        assert.deepEqual(narrowed.completion.anchor, { revision: filtered.completion.anchor.revision + 1,
            from: filtered.completion.anchor.from, to: filtered.completion.anchor.to - 1 });
        await input.press("PageDown");
        const paged = (await state()).completion;
        assert.ok(paged.choices.length > 1);
        assert.equal(paged.choiceIndex, paged.choices.length - 1);
        await input.press("PageUp"); assert.equal((await state()).completion.choiceIndex, 0);
        await retained.evaluate(node => { if (!(node instanceof HTMLButtonElement)) throw new Error("Expected a completion button"); node.click(); }); assert.equal((await state()).completion.choiceIndex, 0);
        await button("sampleWithImport").click(); await expect.poll(async () => (await state()).editor.pending).toBe(false);
        const beforeCommit = await text(), commitDepth = (await state()).history.undoDepth; await input.pressSequentially(";");
        assert.ok((await text()).startsWith("// resolved import\r\nconst sampleValue;")); assert.equal((await state()).history.undoDepth, commitDepth + 1);
        await input.press("Control+z"); assert.equal(await text(), beforeCommit);
        await button("Signature").click(); await expect.poll(async () => (await state()).notes.signature).toBe("fallback?: string");
        await button("Links").click(); await expect(button("Open link")).toBeEnabled();
        const oldLink = await button("Open link").evaluateHandle(node => /** @type {HTMLButtonElement} */ (node).onclick?.bind(node));
        await button("Edit companion").click(); await expect(button("Open link")).toBeDisabled();
        await button("Links").click(); await expect(button("Open link")).toBeEnabled();
        assert.deepEqual(await oldLink.evaluate(open => open?.(new PointerEvent("click"))), { status: "expired" }); await oldLink.dispose();
        assert.equal((await state()).notes.linkUri, undefined);
        const moduleRow = page.locator("#editor .st-viewport-row").filter({ hasText: 'import "sample-utils";' });
        await moduleRow.scrollIntoViewIfNeeded();
        await page.keyboard.down("Control");
        try {
            // The row is wider than its text. Target the actual module glyph before its underline exists.
            const point = await paintedCharacter(moduleRow, "sample-utils", 6);
            await page.mouse.move(point.x, point.y);
            const marked = moduleRow.locator(".st-definition-link"); await expect(marked).toHaveText("sample-utils");
            await page.mouse.click(point.x, point.y);
        } finally { await page.keyboard.up("Control"); }
        await expect.poll(async () => (await state()).notes.linkUri).toBe("consumer+opaque:project/companion%2Fpart");
        await button("Links").click(); await expect(button("Open link")).toBeEnabled();
        const duplicate = await button("Open link").evaluate(node => {
            const control = /** @type {HTMLButtonElement} */ (node), open = control.onclick?.bind(control);
            control.click();
            return open?.(new PointerEvent("click"));
        });
        assert.deepEqual(duplicate, { status: "resolving" });
        await expect.poll(async () => (await state()).notes.linkUri).toBe("consumer+opaque:project/companion%2Fpart");
        assert.deepEqual((await state()).notes.lastLink, { status: "presented" });
        await button("Colors").click(); await expect.poll(async () => (await state()).notes.colorPresentations ?? 0).toBeGreaterThan(0);
        const beforeColor = await text(), colorDepth = (await state()).history.undoDepth;
        const oldColor = await button("Apply color").evaluateHandle(node => /** @type {HTMLButtonElement} */ (node).onclick?.bind(node));
        await button("Preview translucent color").click(); await expect(page.locator("#result")).toContainText("rgba(1, 2, 3, 0.5)");
        assert.deepEqual(await oldColor.evaluate(apply => apply?.(new PointerEvent("click"))), { applied: false, reason: "expired" }); await oldColor.dispose();
        assert.equal(await text(), beforeColor); assert.equal((await state()).history.undoDepth, colorDepth);
        await button("Apply color").click(); await expect.poll(async () => (await state()).notes.colorApplied).toBe(true);
        assert.deepEqual((await state()).notes.lastReview, { applied: true });
        assert.equal((await state()).history.undoDepth, colorDepth + 1); assert.equal(await text(), "// color presentation\r\n" + beforeColor.replace("#abc", "rgba(1, 2, 3, 0.5)")); await input.press("Control+z"); assert.equal(await text(), beforeColor);
        const counts = await page.evaluate(() => window.publicLsp.custom("fixture/synchronization", {}));
        assert.ok(counts && typeof counts === "object" && !Array.isArray(counts)
            && "initialize" in counts && "failures" in counts && "documents" in counts, "Expected synchronization counters");
        assert.equal(counts.initialize, 1); assert.deepEqual(counts.failures, []);
        assert.ok(Array.isArray(counts.documents)); assert.equal(counts.documents.length, 2);
        const companionUri = "consumer+opaque:project/companion%2Fpart";
        const lifetimes = Object.fromEntries(counts.documents.map(document => {
            assert.ok(document && typeof document === "object" && !Array.isArray(document));
            return [document.uri === companionUri ? "companion" : "source", { open: document.open, close: document.close }];
        }));
        // Navigation and the expired, failed and applied renames each release the unopened companion.
        assert.deepEqual(lifetimes, { source: { open: 1, close: 0 }, companion: { open: 5, close: 4 } });
        await page.evaluate(() => { window.publicLsp.stopCompletion(); window.publicLsp.diagnostics.request(); });
        await expect(marker).toHaveText("TODO");
        await button("Hover").click(); await expect.poll(async () => (await state()).notes.hover).toContain("Resolve this placeholder.");
        assert.equal(await firstDiagnostic.evaluate(item => item.select()), false); await firstDiagnostic.dispose();
        assert.equal(await page.evaluate(() => window.publicLsp.diagnostics.getSnapshot().diagnostics[0]?.select()), true);
        await page.evaluate(() => window.publicLsp.showDiagnostic());
        const hint = page.locator("#diagnostic-hint"); await expect(hint).toBeVisible();
        const marked = await marker.boundingBox(), popup = await hint.boundingBox();
        assert.ok(marked && popup && popup.y >= marked.y + marked.height, "A first-line diagnostic opens below its source");
        await expect(input).toBeFocused();
        await page.locator("#result").dispatchEvent("pointerdown"); await expect(hint).toBeHidden(); await expect(input).toBeFocused();
        await page.evaluate(() => window.publicLsp.showDiagnostic()); await expect(hint).toBeVisible();
        await input.pressSequentially("ok"); await expect(hint).toBeHidden();
        await page.evaluate(() => window.publicLsp.dispose()); const final = await state(); assert.equal(final.provider.scopes, 0); assert.equal(final.provider.created, final.provider.terminated);
        assert.deepEqual([final.diagnostics.leases, final.diagnostics.views, final.diagnostics.subscriptions], [0, 0, 0]); assert.deepEqual(final.errors, []); assert.deepEqual(errors, []);
        const readOnly = new URL(url); readOnly.searchParams.set("readOnly", "");
        await page.goto(readOnly.href); await input.waitFor(); const original = await text(), readOnlyDepth = (await state()).history.undoDepth;
        await button("Connect").click(); await expect.poll(async () => (await state()).editor.connected).toBe(true);
        await button("Code actions").click(); await button("Review lazy action").click();
        await expect.poll(async () => (await state()).notes.resolved).toBe(true);
        const refusal = await button("Apply reviewed action").evaluate(node => {
            const button = /** @type {HTMLButtonElement} */ (node);
            return { disabled: button.disabled, outcome: button.onclick?.(new PointerEvent("click")) };
        });
        assert.deepEqual({ ...refusal, text: await text(), depth: (await state()).history.undoDepth },
            { disabled: true, outcome: { status: "not-writable" }, text: original, depth: readOnlyDepth });
        await page.evaluate(() => window.publicLsp.dispose()); assert.deepEqual(errors, []);
        await writeFile(`artifacts/package/lsp-${browser.browserType().name()}.json`, JSON.stringify({ status: "passed", packageSha256, automaticCompletion: true, obsoleteListControlRejected: true, readOnlyAction: refusal, notes: final.notes, synchronization: counts, final, errors }, null, 2));
    } finally { await page.close(); }
}
