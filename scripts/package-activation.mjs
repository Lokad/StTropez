import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { retainPackagedPage, closePackagedPage } from "./package-page-lifecycle.mjs";
import { latch } from "../tests/helpers/latch.ts";

/** @typedef {Window & {stopFirstReadingProbe?: () => {frames: number, editableFrames: number, editableFocus: number}}} ReadingProbeWindow */

/** @template T @param {T} value @returns {NonNullable<T>} */
function required(value) {
    assert.ok(value !== null && value !== undefined, "Expected captured fixture state");
    return value;
}

/**
 * Visible consumer journeys use only the restored package and host-owned activation shell.
 * @param {import("@playwright/test").Browser} browser
 * @param {string} baseUrl
 * @param {{directory: string, packageSha256: string, outputs: Record<string, {bytes: number}>,
 *   assetBytes: {css: readonly unknown[], workers: readonly unknown[]}, corpus?: "all" | "normal" | "large"}} options
 */
export async function runPackagedActivation(browser, baseUrl, { directory, packageSha256, outputs, assetBytes, corpus = "all" }) {
    await mkdir(directory, { recursive: true });
    const browserName = browser.browserType().name();
    /** @type {object[]} */ const cases = [];
    /** @template T @param {Promise<T>} promise */
    const bounded = async promise => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Activation test response did not settle within its correctness deadline.")), 30000); })]); } finally { clearTimeout(timer); } };
    /** @param {import("@playwright/test").Page} page */
    const snap = page => page.evaluate(() => window.activationFixture.snapshot());
    /** @param {import("@playwright/test").Page} page */
    const text = page => page.evaluate(() => window.activationFixture.text());
    /** @param {import("@playwright/test").Page} page @param {string} name */
    const button = (page, name) => page.getByRole("button", { name, exact: true });
    /** @param {import("@playwright/test").Page} page @param {number} anchor @param {number} head */
    const previewSelect = (page, anchor, head) => page.locator("#text").evaluate((node, [anchor, head]) => {
        /** @param {number} at @returns {[Text, number]} */
        const point = at => { const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let text, end = 0;
            while (text = walk.nextNode()) { if (!(text instanceof Text)) throw new Error("Expected a preview text node"); end += text.length; if (at <= end) return [text, at - end + text.length]; } throw new Error("Preview offset outside text"); };
        const selection = window.getSelection(); if (!selection) throw new Error("Missing preview selection");
        selection.setBaseAndExtent(...point(anchor), ...point(head)); return selection.getRangeAt(0).toString();
    }, [anchor, head]);
    /** @param {import("@playwright/test").Page} page */
    const previewRange = page => page.locator("#text").evaluate(node => {
        const s = window.getSelection(); if (!s) throw new Error("Missing preview selection");
        /** @param {Node | null} text @param {number} at */
        const offset = (text, at) => {
            if (!text || text !== node && !node.contains(text)) return null;
            const range = document.createRange(); range.selectNodeContents(node); range.setEnd(text, at); return range.toString().length;
        };
        return { anchor: offset(s.anchorNode, s.anchorOffset), head: offset(s.focusNode, s.focusOffset) };
    });
    /** @param {import("@playwright/test").Page} page @param {string} value @param {boolean} large */
    async function readerKeyboard(page, value, large) {
        const reader = page.locator("#text"); await reader.focus(); await previewSelect(page, 0, 0);
        await reader.press("Shift+ArrowRight"); assert.deepEqual(await previewRange(page), { anchor: 0, head: 1 });
        await reader.press("Control+End"); assert.deepEqual(await previewRange(page), { anchor: value.length, head: value.length });
        await reader.evaluate(async node => {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const s = window.getSelection(); if (!s?.focusNode) throw new Error("Missing preview focus node");
            const tail = document.createRange(); tail.setStart(s.focusNode, s.focusOffset - 3); tail.setEnd(s.focusNode, s.focusOffset - 2);
            const rect = tail.getBoundingClientRect(), box = node.getBoundingClientRect();
            if (rect.height <= 0 || rect.top < box.top || rect.bottom > box.bottom) throw new Error("Keyboard End did not reveal the source tail");
        });
        if (large) await page.screenshot({ path: `${directory}/activation-keyboard-end-${browserName}.png` });
        await reader.press("Control+Shift+Home"); assert.deepEqual(await previewRange(page), { anchor: value.length, head: 0 });
        await reader.press("Control+a"); assert.deepEqual(await previewRange(page), { anchor: 0, head: value.length });
        assert.equal(await page.evaluate(() => window.getSelection()?.getRangeAt(0).toString()), value);
        if (!large) await page.screenshot({ path: `${directory}/activation-keyboard-selection-${browserName}.png` });
        await reader.press("ArrowLeft"); assert.deepEqual(await previewRange(page), { anchor: 0, head: 0 });
        await reader.press("Control+a"); await reader.press("ArrowRight"); assert.deepEqual(await previewRange(page), { anchor: value.length, head: value.length });
        await reader.press("Backspace"); await reader.press("Delete"); await reader.pressSequentially("Q"); assert.equal(await reader.textContent(), value);
        for (const [at, key, head] of /** @type {const} */ ([[7, "Shift+ArrowRight", 9], [10, "Shift+ArrowRight", 12], [12, "Shift+ArrowRight", 14], [14, "Shift+ArrowLeft", 12]])) {
            await previewSelect(page, at, at); await reader.press(key); assert.deepEqual(await previewRange(page), { anchor: at, head });
        }
        await previewSelect(page, 6, 6); await reader.press("Home"); assert.deepEqual(await previewRange(page), { anchor: 0, head: 0 });
        await reader.press("End"); assert.deepEqual(await previewRange(page), { anchor: 12, head: 12 });
        await previewSelect(page, 3, 3); await reader.press("Control+Shift+ArrowRight"); const word = await previewRange(page);
        assert.equal(word.anchor, 3); assert.ok(required(word.head) > 3 && required(word.head) <= 14, JSON.stringify(word)); // Native word rules may include the line ending.
        const starts = [0, ...[...value.matchAll(/\r\n|\r|\n/g)].map(m => m.index + m[0].length)];
        await reader.press("Control+Home"); await reader.press("ArrowDown"); assert.deepEqual(await previewRange(page), { anchor: starts[1], head: starts[1] });
        await reader.press("Shift+ArrowDown"); assert.deepEqual(await previewRange(page), { anchor: starts[1], head: starts[2] });
        await reader.press("ArrowUp"); assert.deepEqual(await previewRange(page), { anchor: starts[1], head: starts[1] });
        const column = starts[2] - 3; await previewSelect(page, column, column);
        await reader.press("ArrowDown"); assert.deepEqual(await previewRange(page), { anchor: starts[3] - 1, head: starts[3] - 1 });
        await reader.press("ArrowUp"); assert.deepEqual(await previewRange(page), { anchor: column, head: column });
        if (large) {
            const boundary = required([...value.matchAll(/\r\n|\r|\n/g)].slice(0, 500).at(-1)), at = boundary.index + boundary[0].length;
            await previewSelect(page, at, at); await reader.press("Shift+ArrowRight"); assert.deepEqual(await previewRange(page), { anchor: at, head: at + 1 });
            await reader.press("Shift+ArrowLeft"); assert.deepEqual(await previewRange(page), { anchor: at, head: at });
            await reader.press("Shift+ArrowLeft"); assert.deepEqual(await previewRange(page), { anchor: at, head: at - 2 });
            await reader.press("Shift+ArrowRight"); assert.deepEqual(await previewRange(page), { anchor: at, head: at });
            await previewSelect(page, at - 2, at - 2); await reader.press("Control+Shift+ArrowRight"); const across = await previewRange(page);
            assert.equal(across.anchor, at - 2); assert.ok(required(across.head) >= at && required(across.head) <= starts[501], JSON.stringify(across));
            const pageLines = await reader.evaluate(n => Math.max(1, Math.floor(n.clientHeight / parseFloat(getComputedStyle(n).lineHeight)) - 1));
            await previewSelect(page, starts[490], starts[490]); await reader.press("Home"); await reader.press("Shift+PageDown");
            assert.deepEqual(await previewRange(page), { anchor: starts[490], head: starts[490 + pageLines] });
            await reader.press("PageUp"); assert.deepEqual(await previewRange(page), { anchor: starts[490], head: starts[490] });
        }
        await reader.press("Control+Home"); await reader.press("ArrowLeft"); assert.deepEqual(await previewRange(page), { anchor: 0, head: 0 });
        await reader.press("Control+End"); await reader.press("ArrowRight"); assert.deepEqual(await previewRange(page), { anchor: value.length, head: value.length });
        await reader.press("Escape"); assert.equal(await button(page, "Edit").evaluate(node => node === document.activeElement), true);
        assert.equal(await reader.textContent(), value); assert.equal(await text(page), value);
        assert.equal(await reader.evaluate(node => [...node.children].every(child => getComputedStyle(child).contentVisibility === "auto")), true);
    }
    /** @param {import("@playwright/test").Page} page @param {ReturnType<Window["activationFixture"]["snapshot"]>["phase"]} phase */
    const ready = async (page, phase = "editing") => {
        await page.waitForFunction(phase => { const s = window.activationFixture.snapshot(), v = s.session?.viewport, i = s.session?.input;
            return s.phase === phase && s.session && i && !i.pendingInput && !i.pendingCommand && !i.pendingCaret && !i.pendingWord && !i.pendingGrapheme && !i.pendingDragScroll && v && !v.pending && v.revision === s.session.revision && v.selectionSet === s.session.selections; }, phase);
    };
    /** @param {string} name @param {(page: import("@playwright/test").Page, original: string, requests: string[]) => Promise<object>} run @param {boolean} large */
    async function scenario(name, run, large = false) {
        if (corpus !== "all" && large !== (corpus === "large")) return;
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await context.newPage();
        /** @type {string[]} */ const errors = [];
        /** @type {string[]} */ const requests = [];
        /** @type {string[]} */ const consoleErrors = [];
        page.on("pageerror", error => errors.push(error.message)); page.on("request", request => requests.push(new URL(request.url()).pathname));
        page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
        try {
            await page.goto(baseUrl + (large ? "/?large=1" : "/")); await page.waitForFunction(() => !!window.activationFixture);
            const original = await text(page); assert.equal(await page.locator("#text").textContent(), original); assert.equal((await snap(page)).session, null);
            assert.equal(original.length, large ? 240_044 : 116, "Restored pilot corpus size changed");
            assert.deepEqual(requests.filter(p => /\.(js|css)$/.test(p)), ["/activation.js"]);
            assert.equal(await page.locator('link[rel="stylesheet"]').count(), 0); assert.ok(outputs["activation.js"].bytes <= 16384);
            if (name === "preview-edit-read-only-history-worker" && !large) await page.screenshot({ path: `${directory}/activation-static-${browserName}.png` });
            const result = await run(page, original, requests); assert.deepEqual(errors, []);
            cases.push({ name, large, ...result, requests, consoleErrors, errors });
        } catch (error) {
            await page.screenshot({ path: `${directory}/activation-${browserName}-failure.png` });
            await writeFile(`${directory}/activation-${browserName}-failure.json`, JSON.stringify({ name, large, error: String(error instanceof Error ? error.stack ?? error.message : error), snapshot: await snap(page), status: await page.locator("#status").textContent(), requests, errors, consoleErrors }, null, 2)); throw error;
        } finally { await context.close(); }
    }
    for (const large of [false, true]) await scenario("preview-edit-read-only-history-worker", async (page, original, requests) => {
        await retainPackagedPage(page, "preview");
        await readerKeyboard(page, original, large); assert.equal((await snap(page)).session, null);
        const boundary = large ? [...original.matchAll(/\r\n|\r|\n/g)].slice(0, 500).at(-1) : null;
        const anchor = boundary ? boundary.index + boundary[0].length + 21 : 7, head = boundary ? boundary.index - 20 : 3;
        assert.equal(await previewSelect(page, anchor, head), original.slice(head, anchor));
        await page.evaluate(() => {
            const probeWindow = /** @type {ReadingProbeWindow} */ (window);
            const stats = { frames: 0, editableFrames: 0, editableFocus: 0 }; let frame = 0;
            const inspect = () => { stats.frames++; if ([...document.querySelectorAll("#editor textarea")].some(n => n instanceof HTMLTextAreaElement && !n.readOnly)) stats.editableFrames++; frame = requestAnimationFrame(inspect); };
            /** @param {FocusEvent} event */
            const focus = event => { if (event.target instanceof HTMLTextAreaElement && event.target.matches("#editor textarea") && !event.target.readOnly) stats.editableFocus++; };
            document.addEventListener("focusin", focus); frame = requestAnimationFrame(inspect);
            probeWindow.stopFirstReadingProbe = () => { cancelAnimationFrame(frame); document.removeEventListener("focusin", focus); delete probeWindow.stopFirstReadingProbe; return stats; };
        });
        await button(page, "Edit").focus(); await page.keyboard.press("Tab"); assert.equal(await button(page, "Read only").evaluate(node => node === document.activeElement), true);
        await page.keyboard.press("Enter"); await ready(page, "reading"); const input = page.getByRole("textbox", { name: "Activated source", exact: true });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const firstReading = await page.evaluate(() => { const stop = (/** @type {ReadingProbeWindow} */ (window)).stopFirstReadingProbe; if (!stop) throw new Error("Missing reading probe"); return stop(); }); assert.ok(firstReading.frames >= 2); assert.equal(firstReading.editableFrames, 0); assert.equal(firstReading.editableFocus, 0);
        await retainPackagedPage(page, "reading");
        assert.equal(required((await snap(page)).session).readOnly, true); assert.equal(required((await snap(page)).session).revision, 0); assert.equal(required((await snap(page)).session).history.undoDepth, 0);
        await input.pressSequentially("blocked"); await input.press("Control+z"); assert.equal(await text(page), original);
        await page.screenshot({ path: `${directory}/activation-first-reading-${large ? "10k-" : ""}${browserName}.png` });
        const firstAssets = [...requests]; await button(page, "Edit").click(); await ready(page); assert.deepEqual(requests, firstAssets); assert.equal(required((await snap(page)).session).readOnly, false);
        const initial = await snap(page); assert.equal(required(initial.session).selections.ranges[0].anchor, anchor); assert.equal(required(initial.session).selections.ranges[0].head, head);
        assert.equal(required(initial.session).workers, 0); assert.ok(!requests.includes("/regex-worker.js"));
        if (large) {
            const middle = original.lastIndexOf("\n", Math.floor(original.length / 2) - 1) + 1;
            for (const [at, mark] of /** @type {const} */ ([[middle, "M"], [original.length, "E"]])) {
                await page.evaluate(at => window.activationFixture.select([{ anchor: at, head: at }]), at);
                await input.press(at === middle ? "Home" : "Control+End"); await ready(page); await input.pressSequentially(mark); await ready(page);
                const edited = original.slice(0, at) + mark + original.slice(at); assert.equal(await text(page), edited); assert.equal(required((await snap(page)).session).selections.ranges[0].head, at + 1);
                assert.ok(required(required((await snap(page)).session).viewport).rows < 100); assert.ok(required(required((await snap(page)).session).input).inputUnits < 2600); assert.equal(required((await snap(page)).session).exports, 0);
                await input.press("Control+z"); await ready(page); assert.equal(await text(page), original);
                await input.press("Control+Shift+z"); await ready(page); assert.equal(await text(page), edited);
                await input.press("Control+z"); await ready(page); assert.equal(await text(page), original);
            }
            await page.evaluate(s => window.activationFixture.select(s.ranges, s.primary), required(initial.session).selections); await ready(page);
        }
        if (!large) {
            await input.dispatchEvent("compositionstart", { data: "" }); await button(page, "Read only").click(); assert.equal((await snap(page)).phase, "editing");
            assert.match(required(await page.locator("#status").textContent()), /Finish typing/); await input.dispatchEvent("compositionend", { data: "" }); await ready(page); assert.equal(await text(page), original);
        }
        await input.pressSequentially("Z"); await ready(page); const changed = original.slice(0, head) + "Z" + original.slice(anchor); assert.equal(await text(page), changed);
        const handlerMs = required(required((await snap(page)).session).input).lastInputMs;
        await input.press("Control+z"); await ready(page); assert.equal(await text(page), original); await input.press("Control+Shift+z"); await ready(page); assert.equal(await text(page), changed);
        await retainPackagedPage(page, "editing");
        const range = large ? { anchor: changed.length - 2, head: changed.length - 42 } : { anchor: 2, head: 1 };
        assert.equal(await page.evaluate(range => window.activationFixture.select([{ anchor: 0, head: 0 }, range], 1), range), true); await ready(page);
        const before = await snap(page), assetsBefore = requests.filter(path => /\.(js|css)(\?|$)/.test(path));
        await button(page, "Read only").click(); await ready(page, "reading"); const reading = required((await snap(page)).session);
        assert.equal(reading.readOnly, true); assert.deepEqual(reading.selections, required(before.session).selections); assert.deepEqual(reading.history, required(before.session).history);
        for (const key of ["Backspace", "Delete", "Control+z", "Control+Shift+z"]) await input.press(key);
        await input.pressSequentially("blocked"); await ready(page, "reading"); assert.equal(await text(page), changed); assert.deepEqual(required((await snap(page)).session).history, required(before.session).history);
        await input.press("Control+End"); await input.press("Shift+PageUp"); await input.press("Control+a"); await ready(page, "reading");
        assert.deepEqual(required((await snap(page)).session).selections.ranges.map(r => [r.anchor, r.head]), [[0, changed.length]]);
        if (large) assert.equal(required(required((await snap(page)).session).input).inputUnits, 1); assert.ok(required(required((await snap(page)).session).viewport).rows < 100);
        await input.press("Escape"); await input.press("Tab"); assert.equal(await page.getByRole("textbox", { name: "Find", exact: true }).evaluate(node => node === document.activeElement), true);
        await page.getByRole("textbox", { name: "Find", exact: true }).fill("const"); await page.waitForFunction(() => window.activationFixture.snapshot().session?.find?.status === "ready");
        await button(page, "Next match").click(); assert.equal(required((await snap(page)).session).selections.ranges[0].anchor, changed.indexOf("const"));
        await page.getByRole("textbox", { name: "Find", exact: true }).fill("");
        await page.evaluate(s => window.activationFixture.select(s.ranges, s.primary), required(before.session).selections); await ready(page, "reading");
        await page.screenshot({ path: `${directory}/activation-reading-${large ? "10k-" : ""}${browserName}.png` });
        await button(page, "Edit").click(); await ready(page);
        assert.equal(required((await snap(page)).session).readOnly, false); assert.deepEqual(required((await snap(page)).session).selections, required(before.session).selections);
        assert.deepEqual(requests.filter(path => /\.(js|css)(\?|$)/.test(path)), assetsBefore); assert.equal(required((await snap(page)).session).workers, 0);
        await button(page, "Show snapshot").click(); assert.equal((await snap(page)).phase, "preview"); assert.equal(await page.locator("#text").textContent(), changed);
        // Range text is the raw source oracle; native Selection serialization varies by engine.
        assert.equal(await page.evaluate(() => window.getSelection()?.getRangeAt(0).toString()), changed.slice(range.head, range.anchor));
        if (large) {
            await page.locator("#text").evaluate(async node => {
                if (!node.lastElementChild) throw new Error("Missing preview tail");
                node.lastElementChild.scrollIntoView({ block: "end" });
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const tail = node.lastElementChild.getBoundingClientRect(), box = node.getBoundingClientRect();
                if (tail.height <= 0 || tail.bottom > box.bottom + 1 || tail.bottom < box.top) throw new Error("Reader tail was not revealed");
            });
            await page.screenshot({ path: `${directory}/activation-reader-tail-${browserName}.png` });
        }
        const dormant = required((await snap(page)).session); assert.equal(dormant.diagnostics.subscriptions, 0); assert.equal(dormant.diagnostics.views, 1); assert.equal(dormant.diagnostics.leases, 1);
        await button(page, "Edit").click(); await ready(page); const after = await snap(page); assert.equal(required(after.session).resourceId, required(before.session).resourceId); assert.equal(required(after.session).documentId, required(before.session).documentId);
        assert.deepEqual(required(after.session).selections, required(before.session).selections); assert.deepEqual(required(after.session).history, required(before.session).history); assert.equal(required(after.session).workers, 0);
        await page.getByRole("textbox", { name: "Find", exact: true }).fill("const"); await page.waitForFunction(() => window.activationFixture.snapshot().session?.find?.status === "ready"); assert.equal(required(required((await snap(page)).session).find).count, 1); assert.equal(required((await snap(page)).session).workers, 0);
        await page.getByRole("textbox", { name: "Find", exact: true }).fill("c.fé"); await page.getByRole("checkbox", { name: "Regular expression", exact: true }).check();
        await page.waitForFunction(() => window.activationFixture.snapshot().session?.find?.status === "ready"); const found = required((await snap(page)).session); assert.equal(required(found.find).count, large ? 2 : 1); assert.ok(found.workers > 0);
        assert.ok(required(found.viewport).rows < 100); assert.equal(found.exports, 0); assert.equal(await text(page), changed);
        await button(page, "Show snapshot").click();
        const keyboardDormant = required((await snap(page)).session);
        await page.locator("#text").press("Control+Home"); await page.locator("#text").press("Shift+ArrowRight"); await page.locator("#text").press("Escape");
        const keyboardAfter = required((await snap(page)).session);
        assert.equal(keyboardAfter.revision, keyboardDormant.revision); assert.deepEqual(keyboardAfter.history, keyboardDormant.history); assert.deepEqual(keyboardAfter.selections, keyboardDormant.selections);
        // Element boundary endpoints arise from native Select All as well as text-node ranges.
        await page.locator("#text").evaluate(node => { const selection = window.getSelection(); if (!selection) throw new Error("Missing preview selection"); selection.setBaseAndExtent(node, node.childNodes.length, node, 0); });
        await button(page, "Edit").click(); await ready(page); const selected = required((await snap(page)).session).selections; assert.equal(selected.ranges.length, 1); assert.equal(selected.ranges[0].anchor, changed.length); assert.equal(selected.ranges[0].head, 0);
        if (!large) {
            await input.press("Delete"); await ready(page); assert.equal(await text(page), "");
            await button(page, "Read only").click(); await ready(page, "reading");
            for (const key of ["Control+a", "Home", "End", "Shift+ArrowRight", "PageDown"]) await input.press(key);
            await ready(page, "reading"); assert.deepEqual(required((await snap(page)).session).selections.ranges.map(r => [r.anchor, r.head]), [[0, 0]]);
            await button(page, "Edit").click(); await ready(page); await button(page, "Show snapshot").click();
            for (const key of ["Control+a", "Home", "End", "Shift+ArrowRight", "Shift+ArrowLeft", "PageDown"]) await page.locator("#text").press(key);
            assert.deepEqual(await previewRange(page), { anchor: 0, head: 0 }); assert.equal(await page.locator("#text").textContent(), "");
            await page.locator("#text").press("Escape"); await page.keyboard.press("Enter"); await ready(page); await input.press("Control+z"); await ready(page); assert.equal(await text(page), changed);
        }
        if (!large) await page.screenshot({ path: `${directory}/activation-${browserName}.png` });
        const diagnostics = await closePackagedPage(page); assert.equal(await text(page), changed);
        assert.equal(await page.locator("#text").evaluate(node => { const e = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }); node.dispatchEvent(e); return e.defaultPrevented; }), false);
        return { firstReading, handlerMs, handlerClock: "own input handler only; no complete-action or latency percentile claim", dormant: dormant.diagnostics, final: diagnostics, boundedRows: required(found.viewport).rows, workerRequestsAfterOptIn: found.workers, exactUnicodeCrlf: true, completeSelectionsAndHistory: true };
    }, large);
    for (const asset of ["activate.js", "editor.css"]) await scenario("failed-activation-retry-" + asset, async (page, original) => {
        let expected = original, captured = null;
        if (asset === "editor.css") {
            await button(page, "Edit").click(); await ready(page); const input = page.getByRole("textbox", { name: "Activated source", exact: true }); await input.press("Control+Home"); await input.pressSequentially("Q"); await ready(page);
            expected = "Q" + original; captured = (await snap(page)).session; await button(page, "Show snapshot").click();
        }
        let failures = 0; await page.route("**/" + asset + "*", async route => { if (failures++ === 0) await route.fulfill({ status: 503, contentType: asset.endsWith("js") ? "text/javascript" : "text/css", body: "" }); else await route.continue(); });
        await button(page, "Read only").click(); await page.waitForFunction(() => window.activationFixture.snapshot().phase === "preview");
        assert.equal(await text(page), expected); if (!captured) assert.equal((await snap(page)).session, null); assert.equal(await page.locator('link[rel="stylesheet"]').count(), 0); assert.equal(await page.getByRole("textbox", { name: "Activated source", exact: true }).count(), 0);
        await button(page, "Read only").click(); await ready(page, "reading"); assert.equal(required((await snap(page)).session).readOnly, true); assert.equal(await text(page), expected);
        if (captured) { const s = required((await snap(page)).session); assert.equal(s.resourceId, captured.resourceId); assert.deepEqual(s.history, captured.history); assert.deepEqual(s.selections, captured.selections); }
        const d = await page.evaluate(() => window.activationFixture.dispose()); assert.equal(required(d).resources, 0);
        assert.ok(failures >= 2);
        return { failures: 1, retrySucceeded: true, final: d };
    });
    for (const asset of ["activate.js", "editor.css"]) await scenario("cancel-late-response-" + asset, async (page, original) => {
        const held = latch(), gate = latch(), completed = latch(); let first = true;
        await page.route("**/" + asset + "*", async route => { if (!first) { await route.continue(); return; } first = false; held.resolve(undefined); await gate.promise;
            try { await route.fulfill({ response: await route.fetch() }); } finally { completed.resolve(undefined); } });
        try {
            await button(page, "Read only").click(); await bounded(held.promise); await retainPackagedPage(page, "loading"); await button(page, "Cancel activation").click(); assert.equal((await snap(page)).phase, "preview"); assert.equal((await snap(page)).session, null);
            assert.equal(await page.locator('link[rel="stylesheet"]').count(), 0); await button(page, "Edit").click(); await ready(page); gate.resolve(undefined); await bounded(completed.promise);
            assert.equal(await text(page), original); assert.equal((await snap(page)).phase, "editing"); assert.equal(required((await snap(page)).session).readOnly, false); assert.equal(required((await snap(page)).session).mounts, 1); const d = await page.evaluate(() => window.activationFixture.dispose()); assert.equal(required(d).resources, 0); return { cancelledMode: "reading", replacementMode: "editing", lateResponseIgnored: true, final: d };
        } finally { gate.resolve(undefined); await bounded(completed.promise); }
    });
    await scenario("failed-optional-worker-keeps-editing", async (page, original) => {
        await button(page, "Edit").click(); await ready(page); await page.route("**/regex-worker.js", route => route.fulfill({ status: 503, contentType: "text/javascript", body: "" }));
        await page.getByRole("textbox", { name: "Find", exact: true }).fill("const"); await page.getByRole("checkbox", { name: "Regular expression", exact: true }).check();
        await page.waitForFunction(() => window.activationFixture.snapshot().session?.find?.status === "failed"); assert.equal(await text(page), original);
        const input = page.getByRole("textbox", { name: "Activated source", exact: true }); await input.press("Control+Home"); await input.pressSequentially("Q"); await ready(page); assert.equal(await text(page), "Q" + original); await input.press("Control+z"); await ready(page); assert.equal(await text(page), original);
        await page.getByRole("checkbox", { name: "Regular expression", exact: true }).uncheck(); await page.waitForFunction(() => window.activationFixture.snapshot().session?.find?.status === "ready"); assert.equal(required(required((await snap(page)).session).find).count, 1);
        const d = await page.evaluate(() => window.activationFixture.dispose()); assert.equal(required(d).resources, 0); return { literalFindAndTypingSurvive: true, final: d };
    });
    const report = { packageSha256, browser: browser.version(), corpus, cases, assets: { javascript: outputs, ...assetBytes, wasm: [] },
        limits: "Correctness and asset loading evidence, with own input-handler observations only. Synthetic page transitions do not qualify actual BFCache eligibility/restoration. No activation/interaction p95, retained heap, native IME/OS clipboard, service integration or production qualification." };
    await writeFile(`${directory}/activation-${browserName}.json`, JSON.stringify(report, null, 2)); console.log(`Restored explicit activation: ${cases.length} journeys passed in ${browserName}.`);
}
