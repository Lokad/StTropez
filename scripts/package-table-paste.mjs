import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { sourceIdentity } from "./measurement.mjs";
import { hostTextEquals } from "./host-scene.mjs";

/** Actual staged host code consumes only restored public assets; no checkout runtime fallback.
 * @param {import('@playwright/test').Browser} browser
 * @param {string} origin
 * @param {{ directory: string; packageSha256: string }} options
 */
export async function runPackagedTablePaste(browser, origin, options) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), /** @type {string[]} */ errors = [], source = await sourceIdentity();
    page.on("pageerror", error => errors.push(error.message));
    /** @param {string} name */
    const click = name => page.getByRole("button", { name, exact: true }).click();
    const ready = () => page.waitForFunction(() => { const s = window.hostFixture.snapshot(), c = s.bindings.comparison;
        return !s.bindings.tablePaste.pending && s.bindings.views.every(v => v.metrics !== null && !v.metrics.pendingCaret && !v.metrics.pendingWord && !v.metrics.pendingGrapheme && !v.metrics.viewport.pending && v.metrics.viewport.revision === s.source.revision)
            && (!c || c.status === "ready" && !c.workingViewport.pending && c.referenceViewport !== undefined && !c.referenceViewport.pending); });
    /** @param {string} text */
    const exact = text => hostTextEquals(page, text);
    /** @param {ReturnType<Window['hostFixture']['snapshot']>} state */
    const primary = state => {
        const view = state.bindings.views.find(v => v.id === "primary");
        assert.ok(view, "Primary source view must be mounted.");
        return view;
    };
    try {
        await page.goto(origin + "/hosts/react/?editor=candidate");
        const original = "AA\r\n" + "const unchanged = 123;\r\n".repeat(100000) + "ZZ", csv = '"city","value"\r\n"東京","A,""B"""', expected = csv + original.slice(2, -2) + csv;
        await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, original);
        await click("Open source review"); await click("Capture review acceptance"); await click("Finish review acceptance"); await ready();
        await page.getByRole("checkbox", { name: "Paste tables as CSV", exact: true }).check();
        const input = page.getByRole("textbox", { name: "Primary source", exact: true }); await input.focus();
        await page.evaluate(length => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 2, head: 0 }, { anchor: length - 2, head: length }], 1); }, original.length);
        const before = await page.evaluate(() => window.hostFixture.snapshot());
        await input.evaluate(node => { const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }), data = event.clipboardData;
            if (!data) throw new Error("No synthetic clipboard data store."); data.setData("text/plain", "unused\tfallback"); data.setData("text/html", '<table><tr><th>city</th><th>value</th></tr><tr><td>東京</td><td>A,&quot;B&quot;</td></tr></table>');
            node.dispatchEvent(event); });
        await ready(); assert.equal(await exact(expected), true);
        const pasted = await page.evaluate(() => window.hostFixture.snapshot()); assert.equal(pasted.bindings.tablePaste.status, "applied"); assert.equal(pasted.history.undoDepth, before.history.undoDepth + 1); assert.equal(pasted.source.exports, 0);
        assert.equal(primary(pasted).selectionSet.ranges.length, 2);
        await page.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+z"); await ready(); assert.equal(await exact(original), true);
        assert.deepEqual(primary(await page.evaluate(() => window.hostFixture.snapshot())).selectionSet, primary(before).selectionSet);
        await input.press("Control+Shift+z"); await ready(); assert.equal(await exact(expected), true);
        await input.press("Control+s"); await page.waitForFunction(() => window.hostFixture.snapshot().pendingSaves.length === 1);
        await input.press("Escape"); await input.press("Control+End"); await input.pressSequentially(" later"); await page.evaluate(() => window.hostFixture.finishSave()); await ready(); assert.equal(await exact(expected + " later"), true);
        await input.press("Control+z"); await ready(); assert.equal(await exact(expected), true); assert.equal((await page.evaluate(() => window.hostFixture.snapshot())).source.dirty, false);
        const viewId = primary(await page.evaluate(() => window.hostFixture.snapshot())).viewId;
        await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await ready();
        assert.equal(primary(await page.evaluate(() => window.hostFixture.snapshot())).viewId, viewId);
        const reference = await page.evaluate(() => window.hostFixture.referenceRange(0, 4)); assert.equal(reference, "AA\r\n");
        await page.evaluate(() => window.hostFixture.dispose());
        const released = await page.evaluate(() => { const s = window.hostFixture.snapshot(); return { views: s.diagnostics.views, leases: s.diagnostics.leases, subscriptions: s.diagnostics.subscriptions, host: s.hostSubscriptions, pasteSessions: s.bindings.tablePaste.sessions }; });
        assert.deepEqual(released, { views: 0, leases: 0, subscriptions: 0, host: 0, pasteSessions: 0 }); assert.deepEqual(errors, []);
        await mkdir(options.directory, { recursive: true });
        await writeFile(options.directory + "/table-paste.json", JSON.stringify({ source, packageSha256: options.packageSha256, originalUnits: original.length,
            restoredReactHost: true, syntheticClipboardEvent: true, nativeDeviceQualified: false, actualLaterKeyboardTyping: true, capturedMultiRangePaste: true, htmlPreferred: true,
            sharedUndoRedo: true, completeSetsRestored: true, capturedSaveAndUndoToSaved: true, immutableReference: true, retainedRemount: true, zeroOrdinaryExports: true, released, errors }, null, 2));
        console.log("Restored React table paste, complete selections, shared history, captured save, later typing and remount passed.");
    } finally { await page.close(); }
}
