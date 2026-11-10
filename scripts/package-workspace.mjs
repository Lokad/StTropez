import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

export async function runPackagedWorkspace(browser, baseUrl, { directory, packageSha256, outputs }) {
    await mkdir(directory, { recursive: true }); const engine = browser.browserType().name(), cases = [];
    for (const large of [false, true]) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), p = await context.newPage(), errors = [], requests = [];
        p.on("pageerror", e => errors.push(e.message)); p.on("request", r => requests.push(new URL(r.url()).pathname));
        const snap = () => p.evaluate(() => window.activationFixture.snapshot().session), text = () => p.evaluate(() => window.activationFixture.text());
        const button = name => p.getByRole("button", { name, exact: true }), primary = p.getByRole("textbox", { name: "Activated source", exact: true }), peer = p.getByRole("textbox", { name: "Peer source", exact: true });
        const select = p.getByRole("combobox", { name: "Primary document", exact: true }), closed = p.getByRole("combobox", { name: "Closed document", exact: true });
        const ready = () => p.waitForFunction(() => { const s = window.activationFixture.snapshot().session, panes = document.querySelector(".workspace-panes"); if (!s || !panes) return false;
            const box = panes.getBoundingClientRect(), cells = [...panes.children].map(n => n.getBoundingClientRect());
            return cells.length === 2 && cells[0].right <= cells[1].left + 1 && cells.every(r => r.width > 0 && r.height > 0 && r.bottom <= box.bottom + 1 && r.right <= box.right + 1)
                && [s, s.peer].every(v => v?.input && !v.input.pendingInput && !v.input.pendingCommand && !v.input.pendingCaret && !v.input.pendingWord && !v.input.pendingGrapheme && !v.input.pendingDragScroll && v.viewport && !v.viewport.pending && v.viewport.revision === v.revision && v.viewport.selectionSet === v.selections); });
        const apiText = id => p.evaluate(id => window.activationFixture.workspace().text(id), id);
        try {
            await p.goto(baseUrl + (large ? "/?large=1" : "/")); await p.waitForFunction(() => !!window.activationFixture); const original = await text();
            assert.deepEqual(requests.filter(s => /\.(js|css)$/.test(s)), ["/activation.js"]); assert.equal(await p.locator(".st-editing-candidate").count(), 0);
            await button("Edit").click(); await ready(); const initial = await snap(), doc = key => initial.workspace.documents.find(d => d.key === key);
            assert.equal(initial.workspace.documents.length, 102); assert.equal(initial.diagnostics.resources, 102); assert.equal(initial.diagnostics.tabs, 103); assert.equal(initial.diagnostics.views, 2);
            assert.equal(initial.workspace.documents.filter(d => !d.cachedView && d.key !== "peer").length, 100); assert.equal(await p.locator(".st-editing-candidate").count(), 2);
            const baselineSubscriptions = initial.diagnostics.subscriptions, baselineNodes = await p.locator("body *").count(), peerOriginal = await apiText(doc("peer").resourceId);
            await primary.press("Control+Home"); await primary.pressSequentially("A"); await ready(); assert.equal(await text(), "A" + original); const primaryHandlerMs = (await snap()).input.lastInputMs;
            assert.equal(await p.evaluate(() => window.activationFixture.select([{ anchor: 0, head: 0 }, { anchor: 3, head: 1 }], 1)), true); await ready(); const sourceState = await snap();
            await peer.press("Control+Home"); await peer.pressSequentially("P"); await ready(); const peerHandlerMs = (await snap()).peer.input.lastInputMs; assert.equal(await text(), "A" + original); assert.equal(await apiText(doc("peer").resourceId), "P" + peerOriginal);
            assert.ok((await snap()).workspace.documents.filter(d => d.key.startsWith("document-")).every(d => d.revision === 0));
            const one = doc("document-1"), two = doc("document-2"); await select.selectOption(one.resourceId); await ready(); const oneOriginal = await text(); await primary.pressSequentially("one "); await ready(); const oneText = await text();
            await button("Capture job").click(); const capture = (await snap()).workspace.pendingJob; await select.selectOption(two.resourceId); await ready(); const twoOriginal = await text(); await primary.pressSequentially("two "); await ready(); assert.equal(await text(), "two " + twoOriginal);
            await p.waitForFunction(ticks => window.activationFixture.snapshot().session.workspace.ticks >= ticks + 3, initial.workspace.ticks);
            await button("Finish job").click(); assert.deepEqual((await snap()).workspace.lastJob, { resourceId: one.resourceId, revision: capture.revision, prefix: oneText.slice(0, 128) }); assert.equal(await text(), "two " + twoOriginal);
            let maxNodes = baselineNodes;
            for (let i = 0; i < 10; i++) {
                await select.selectOption(i % 2 ? two.resourceId : one.resourceId); await ready(); const s = await snap();
                assert.equal(s.diagnostics.resources, 102); assert.equal(s.diagnostics.subscriptions, baselineSubscriptions); assert.equal(s.diagnostics.views, 4); assert.ok(s.viewport.rows < 100 && s.peer.viewport.rows < 100);
                assert.equal(await p.locator(".st-editing-candidate").count(), 2); maxNodes = Math.max(maxNodes, await p.locator("body *").count());
            }
            assert.ok(maxNodes <= baselineNodes + 20); await select.selectOption(doc("source").resourceId); await ready(); assert.deepEqual((await snap()).selections, sourceState.selections); assert.deepEqual((await snap()).history, sourceState.history);
            await select.selectOption(doc("peer").resourceId); await ready(); await primary.press("Control+End"); await primary.pressSequentially("Q"); await ready(); await select.selectOption(doc("source").resourceId); await ready(); await peer.press("Control+z"); await ready(); assert.equal(await apiText(doc("peer").resourceId), "P" + peerOriginal);
            await peer.press("Control+Shift+z"); await ready(); assert.equal(await apiText(doc("peer").resourceId), "P" + peerOriginal + "Q");
            await p.getByRole("textbox", { name: "Find", exact: true }).fill("const"); await p.waitForFunction(() => window.activationFixture.snapshot().session.find?.status === "ready"); assert.equal((await snap()).find.count, 1);
            await select.selectOption(two.resourceId); await ready(); await p.waitForFunction(() => window.activationFixture.snapshot().session.find?.status === "ready"); assert.equal((await snap()).find.query, "const"); assert.equal((await snap()).find.count, 0); await p.getByRole("textbox", { name: "Find", exact: true }).fill("");
            await select.selectOption(one.resourceId); await ready(); await p.evaluate(() => window.activationFixture.select([{ anchor: 0, head: 0 }, { anchor: 4, head: 1 }], 1)); await ready(); const beforeClose = await snap(), oldTab = beforeClose.workspace.documents.find(d => d.resourceId === one.resourceId).tab;
            await button("Close primary tab").click(); await ready(); await closed.selectOption(one.resourceId); await button("Reopen closed tab").click(); await ready(); const reopened = await snap();
            assert.equal(reopened.resourceId, beforeClose.resourceId); assert.equal(reopened.viewId, beforeClose.viewId); assert.deepEqual(reopened.selections, beforeClose.selections); assert.deepEqual(reopened.history, beforeClose.history); assert.notEqual(reopened.workspace.documents.find(d => d.resourceId === one.resourceId).tab, oldTab);
            await button("Close primary tab").click(); await ready(); await closed.selectOption(one.resourceId); await button("Discard closed document").click(); await button("Reopen closed tab").click(); await ready(); await button("Close primary tab").click(); await ready(); await button("Confirm discard").click(); assert.match(await p.getByLabel("Workspace status", { exact: true }).textContent(), /expired/); assert.equal(await apiText(one.resourceId), oneText);
            await closed.selectOption(one.resourceId); await button("Reopen closed tab").click(); await ready(); await button("Capture job").click(); await button("Close primary tab").click(); await ready(); await closed.selectOption(one.resourceId); await button("Discard closed document").click(); await button("Confirm discard").click();
            assert.match(await p.getByLabel("Workspace status", { exact: true }).textContent(), /waits/); const revision = (await snap()).workspace.documents.find(d => d.resourceId === one.resourceId).revision;
            assert.equal(await p.evaluate(({ id, revision }) => window.activationFixture.workspace().edit(id, revision, [{ from: 0, to: 0, insert: "later " }]), { id: one.resourceId, revision }), true);
            await button("Finish job").click(); assert.match(await p.getByLabel("Workspace status", { exact: true }).textContent(), /expired/); assert.equal(await apiText(one.resourceId), "later " + oneText);
            assert.deepEqual((await snap()).workspace.lastJob, { resourceId: one.resourceId, revision, prefix: oneText.slice(0, 128) });
            await closed.selectOption(one.resourceId); await button("Reopen closed tab").click(); await ready(); assert.equal((await snap()).viewId, beforeClose.viewId); assert.equal((await snap()).selections.ranges.length, 2);
            await button("Close primary tab").click(); await ready();
            await closed.selectOption(one.resourceId); await button("Discard closed document").click(); await button("Confirm discard").click(); assert.ok(!(await snap()).workspace.documents.some(d => d.resourceId === one.resourceId)); assert.equal((await snap()).diagnostics.resources, 101);
            if (!large) { await peer.dispatchEvent("compositionstart", { data: "" }); await button("Read only").click(); assert.equal(await p.evaluate(() => window.activationFixture.snapshot().phase), "editing"); await peer.dispatchEvent("compositionend", { data: "" }); await ready(); }
            const beforePreview = await snap(), retained = await text(); await button("Read only").click(); assert.equal(await p.evaluate(() => window.activationFixture.snapshot().phase), "preview"); const dormant = await snap(); assert.equal(dormant.diagnostics.subscriptions, 0); assert.equal(await p.locator(".st-editing-candidate").count(), 0); assert.equal(await p.locator(".activation-workspace").count(), 0);
            const reader = p.locator("#text"), savedRange = await reader.evaluateHandle(() => { const s = window.getSelection(); return { anchor: s.anchorNode, anchorOffset: s.anchorOffset, head: s.focusNode, headOffset: s.focusOffset }; });
            try {
                await reader.press("Control+Home"); await reader.press("Shift+ArrowRight"); await reader.press("Escape");
                assert.equal(await button("Edit").evaluate(node => node === document.activeElement), true);
                const afterKeys = await snap();
                for (const [after, before] of [[afterKeys, dormant], [afterKeys.peer, dormant.peer]]) { assert.equal(after.resourceId, before.resourceId); assert.equal(after.revision, before.revision); assert.deepEqual(after.history, before.history); assert.deepEqual(after.selections, before.selections); }
                assert.equal(await text(), retained);
            } finally { await p.evaluate(at => window.getSelection().setBaseAndExtent(at.anchor, at.anchorOffset, at.head, at.headOffset), savedRange); await savedRange.dispose(); }
            await button("Edit").click(); await ready(); assert.equal(await text(), retained); assert.equal((await snap()).resourceId, beforePreview.resourceId); assert.deepEqual((await snap()).selections, beforePreview.selections); assert.equal((await snap()).diagnostics.resources, 101);
            const live = await snap(); assert.equal(live.exports, 0); assert.equal(live.peer.exports, 0); if (!large) await p.screenshot({ path: `${directory}/workspace-${engine}.png` });
            const final = await p.evaluate(() => window.activationFixture.dispose()); assert.equal(final.resources, 0); assert.equal(final.documents, 0); assert.equal(final.views, 0); assert.equal(final.leases, 0); assert.equal(final.subscriptions, 0);
            assert.equal(await reader.evaluate(node => { const e = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }); node.dispatchEvent(e); return e.defaultPrevented; }), false);
            const stopped = (await snap()).workspace.ticks; await p.waitForTimeout(120); assert.equal((await snap()).workspace.ticks, stopped); assert.equal(await text(), retained); assert.deepEqual(errors, []);
            cases.push({ large, initiallyInactive: 100, activeViews: 2, progressHz: 20, baselineNodes, maxNodes, baselineSubscriptions, dormant: dormant.diagnostics, final, primaryHandlerMs, peerHandlerMs, requests, errors, oneOriginalLength: oneOriginal.length });
        } catch (error) { await p.screenshot({ path: `${directory}/workspace-${engine}-failure.png` }); const layout = await p.evaluate(() => [...document.querySelectorAll('#editor,.workspace-panes,.workspace-panes > div,.st-editing-candidate')].map(node => { const s = getComputedStyle(node), r = node.getBoundingClientRect(); return { name: node.id || node.className, display: s.display, height: s.height, width: r.width, minHeight: s.minHeight, columns: s.gridTemplateColumns, rows: s.gridTemplateRows }; }));
            await writeFile(`${directory}/workspace-${engine}-failure.json`, JSON.stringify({ large, error: String(error.stack ?? error), snapshot: await snap(), layout, errors, requests }, null, 2)); throw error; }
        finally { await context.close(); }
    }
    await writeFile(`${directory}/workspace-${engine}.json`, JSON.stringify({ packageSha256, browser: browser.version(), cases, outputs, limits: "Bounded correctness/resource/DOM and individual input-handler observations. Retained heap, complete interaction/cold activation latency, native IME/OS clipboard/accessibility and production adoption remain unverified." }, null, 2));
    console.log(`Restored workspace: ${cases.length} normal/100k journeys passed in ${engine}.`);
}
