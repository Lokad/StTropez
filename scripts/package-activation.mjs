import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

/** Visible consumer journeys use only the restored package and host-owned activation shell. */
export async function runPackagedActivation(browser, baseUrl, { directory, packageSha256, outputs, assetBytes }) {
    await mkdir(directory, { recursive: true });
    const browserName = browser.browserType().name(), cases = [];
    const bounded = async promise => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Activation test response did not settle within its correctness deadline.")), 30000); })]); } finally { clearTimeout(timer); } };
    const snap = page => page.evaluate(() => window.activationFixture.snapshot());
    const text = page => page.evaluate(() => window.activationFixture.text());
    const button = (page, name) => page.getByRole("button", { name, exact: true });
    const ready = async page => {
        await page.waitForFunction(() => { const s = window.activationFixture.snapshot(), v = s.session?.viewport, i = s.session?.input;
            return s.phase === "editing" && i && !i.pendingInput && !i.pendingCommand && !i.pendingCaret && !i.pendingWord && !i.pendingGrapheme && !i.pendingDragScroll && v && !v.pending && v.revision === s.session.revision && v.selectionSet === s.session.selections; });
    };
    async function scenario(name, run, large = false) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors = [], requests = [], consoleErrors = [];
        page.on("pageerror", error => errors.push(error.message)); page.on("request", request => requests.push(new URL(request.url()).pathname));
        page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
        try {
            await page.goto(baseUrl + (large ? "/?large=1" : "/")); await page.waitForFunction(() => !!window.activationFixture);
            const original = await text(page); assert.equal(await page.locator("#text").textContent(), original); assert.equal((await snap(page)).session, null);
            assert.deepEqual(requests.filter(p => /\.(js|css)$/.test(p)), ["/activation.js"]);
            assert.equal(await page.locator('link[rel="stylesheet"]').count(), 0); assert.ok(outputs["activation.js"].bytes <= 16384);
            if (name === "preview-edit-read-only-history-worker" && !large) await page.screenshot({ path: `${directory}/activation-static-${browserName}.png` });
            const result = await run(page, original, requests); assert.deepEqual(errors, []);
            cases.push({ name, large, ...result, requests, consoleErrors, errors });
        } catch (error) {
            await page.screenshot({ path: `${directory}/activation-${browserName}-failure.png` });
            await writeFile(`${directory}/activation-${browserName}-failure.json`, JSON.stringify({ name, large, error: String(error.stack ?? error), snapshot: await snap(page), status: await page.locator("#status").textContent(), requests, errors, consoleErrors }, null, 2)); throw error;
        } finally { await context.close(); }
    }
    for (const large of [false, true]) await scenario("preview-edit-read-only-history-worker", async (page, original, requests) => {
        await page.locator("#text").evaluate(node => { const t = node.firstChild; window.getSelection().setBaseAndExtent(t, 7, t, 3); });
        await button(page, "Edit").click(); await ready(page); const input = page.getByRole("textbox", { name: "Activated source", exact: true });
        const initial = await snap(page); assert.equal(initial.session.selections.ranges[0].anchor, 7); assert.equal(initial.session.selections.ranges[0].head, 3);
        assert.equal(initial.session.workers, 0); assert.ok(!requests.includes("/regex-worker.js"));
        if (!large) {
            await input.dispatchEvent("compositionstart", { data: "" }); await button(page, "Read only").click(); assert.equal((await snap(page)).phase, "editing");
            assert.match(await page.locator("#status").textContent(), /Finish typing/); await input.dispatchEvent("compositionend", { data: "" }); await ready(page); assert.equal(await text(page), original);
        }
        await input.pressSequentially("Z"); await ready(page); const changed = original.slice(0, 3) + "Z" + original.slice(7); assert.equal(await text(page), changed);
        const handlerMs = (await snap(page)).session.input.lastInputMs;
        await input.press("Control+z"); await ready(page); assert.equal(await text(page), original); await input.press("Control+Shift+z"); await ready(page); assert.equal(await text(page), changed);
        assert.equal(await page.evaluate(() => window.activationFixture.select([{ anchor: 0, head: 0 }, { anchor: 2, head: 1 }], 1)), true); await ready(page);
        const before = await snap(page); await button(page, "Read only").click(); assert.equal((await snap(page)).phase, "preview"); assert.equal(await page.locator("#text").textContent(), changed);
        const dormant = (await snap(page)).session; assert.equal(dormant.diagnostics.subscriptions, 0); assert.equal(dormant.diagnostics.views, 1); assert.equal(dormant.diagnostics.leases, 1);
        await button(page, "Edit").click(); await ready(page); const after = await snap(page); assert.equal(after.session.resourceId, before.session.resourceId); assert.equal(after.session.documentId, before.session.documentId);
        assert.deepEqual(after.session.selections, before.session.selections); assert.deepEqual(after.session.history, before.session.history); assert.equal(after.session.workers, 0);
        await page.getByRole("textbox", { name: "Find", exact: true }).fill("const"); await page.waitForFunction(() => window.activationFixture.snapshot().session.find?.status === "ready"); assert.equal((await snap(page)).session.find.count, 1); assert.equal((await snap(page)).session.workers, 0);
        await page.getByRole("textbox", { name: "Find", exact: true }).fill("c.fé"); await page.getByRole("checkbox", { name: "Regular expression", exact: true }).check();
        await page.waitForFunction(() => window.activationFixture.snapshot().session.find?.status === "ready"); const found = (await snap(page)).session; assert.equal(found.find.count, 1); assert.ok(found.workers > 0);
        assert.ok(found.viewport.rows < 100); assert.equal(found.exports, 0); assert.equal(await text(page), changed);
        await button(page, "Read only").click(); await page.locator("#text").evaluate(node => { const t = node.firstChild; window.getSelection().setBaseAndExtent(t, 2, t, 0); });
        await button(page, "Edit").click(); await ready(page); const selected = (await snap(page)).session.selections; assert.equal(selected.ranges.length, 1); assert.equal(selected.ranges[0].anchor, 2); assert.equal(selected.ranges[0].head, 0);
        if (!large) await page.screenshot({ path: `${directory}/activation-${browserName}.png` });
        const diagnostics = await page.evaluate(() => window.activationFixture.dispose()); assert.equal(diagnostics.resources, 0); assert.equal(diagnostics.views, 0); assert.equal(diagnostics.leases, 0); assert.equal(diagnostics.subscriptions, 0); assert.equal(await text(page), changed);
        return { handlerMs, handlerClock: "own input handler only; no complete-action or latency percentile claim", dormant: dormant.diagnostics, final: diagnostics, boundedRows: found.viewport.rows, workerRequestsAfterOptIn: found.workers, exactUnicodeCrlf: true, completeSelectionsAndHistory: true };
    }, large);
    for (const asset of ["activate.js", "editor.css"]) await scenario("failed-activation-retry-" + asset, async (page, original) => {
        let expected = original, captured = null;
        if (asset === "editor.css") {
            await button(page, "Edit").click(); await ready(page); const input = page.getByRole("textbox", { name: "Activated source", exact: true }); await input.press("Control+Home"); await input.pressSequentially("Q"); await ready(page);
            expected = "Q" + original; captured = (await snap(page)).session; await button(page, "Read only").click();
        }
        let failures = 0; await page.route("**/" + asset + "*", async route => { if (failures++ === 0) await route.fulfill({ status: 503, contentType: asset.endsWith("js") ? "text/javascript" : "text/css", body: "" }); else await route.continue(); });
        await button(page, "Edit").click(); await page.waitForFunction(() => window.activationFixture.snapshot().phase === "preview");
        assert.equal(await text(page), expected); if (!captured) assert.equal((await snap(page)).session, null); assert.equal(await page.locator('link[rel="stylesheet"]').count(), 0); assert.equal(await page.getByRole("textbox", { name: "Activated source", exact: true }).count(), 0);
        await button(page, "Edit").click(); await ready(page); assert.equal(await text(page), expected);
        if (captured) { const s = (await snap(page)).session; assert.equal(s.resourceId, captured.resourceId); assert.deepEqual(s.history, captured.history); assert.deepEqual(s.selections, captured.selections); }
        const d = await page.evaluate(() => window.activationFixture.dispose()); assert.equal(d.resources, 0);
        assert.ok(failures >= 2);
        return { failures: 1, retrySucceeded: true, final: d };
    });
    await scenario("cancel-late-module-response", async (page, original) => {
        let release, arrived; const held = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; }); let first = true, finished;
        const completed = new Promise(resolve => { finished = resolve; });
        await page.route("**/activate.js*", async route => { if (!first) { await route.continue(); return; } first = false; arrived(); await gate;
            try { await route.fulfill({ response: await route.fetch() }); } finally { finished(); } });
        try {
            await button(page, "Edit").click(); await bounded(held); await button(page, "Cancel activation").click(); assert.equal((await snap(page)).phase, "preview"); assert.equal((await snap(page)).session, null);
            assert.equal(await page.locator('link[rel="stylesheet"]').count(), 0); await button(page, "Edit").click(); await ready(page); release(); await bounded(completed);
            assert.equal(await text(page), original); assert.equal((await snap(page)).session.mounts, 1); const d = await page.evaluate(() => window.activationFixture.dispose()); assert.equal(d.resources, 0); return { lateResponseIgnored: true, final: d };
        } finally { release(); await bounded(completed); }
    });
    await scenario("failed-optional-worker-keeps-editing", async (page, original) => {
        await button(page, "Edit").click(); await ready(page); await page.route("**/regex-worker.js", route => route.fulfill({ status: 503, contentType: "text/javascript", body: "" }));
        await page.getByRole("textbox", { name: "Find", exact: true }).fill("const"); await page.getByRole("checkbox", { name: "Regular expression", exact: true }).check();
        await page.waitForFunction(() => window.activationFixture.snapshot().session.find?.status === "failed"); assert.equal(await text(page), original);
        const input = page.getByRole("textbox", { name: "Activated source", exact: true }); await input.press("Control+Home"); await input.pressSequentially("Q"); await ready(page); assert.equal(await text(page), "Q" + original); await input.press("Control+z"); await ready(page); assert.equal(await text(page), original);
        await page.getByRole("checkbox", { name: "Regular expression", exact: true }).uncheck(); await page.waitForFunction(() => window.activationFixture.snapshot().session.find?.status === "ready"); assert.equal((await snap(page)).session.find.count, 1);
        const d = await page.evaluate(() => window.activationFixture.dispose()); assert.equal(d.resources, 0); return { literalFindAndTypingSurvive: true, final: d };
    });
    const report = { packageSha256, browser: browser.version(), cases, assets: { javascript: outputs, ...assetBytes, wasm: [] },
        limits: "Correctness and asset loading evidence, with own input-handler observations only. No activation/interaction p95, retained heap, native IME/OS clipboard/accessibility, service integration or production qualification." };
    await writeFile(`${directory}/activation-${browserName}.json`, JSON.stringify(report, null, 2)); console.log(`Restored explicit activation: ${cases.length} journeys passed in ${browserName}.`);
}
