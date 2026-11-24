import { ready, test, expect } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";
import { hostTextEquals } from "../../scripts/host-scene.mjs";
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
async function waitForPaste(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (!s.bindings.tablePaste.pending); });
}
async function exact(page: Page, text: string): Promise<void> { expect(await hostTextEquals(page, text)).toBe(true); }
async function paste(node: Locator, plain: string, html = "") {
    return node.evaluate((node, { plain, html }) => { const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }), data = event.clipboardData!;
        data.setData("text/plain", plain); if (html) data.setData("text/html", html);
        const before = window.hostFixture.snapshot().source.revision; node.dispatchEvent(event);
        return { before, after: window.hostFixture.snapshot().source.revision, prevented: event.defaultPrevented };
    }, { plain, html });
}
async function setup(page: Page, host: string, text: string): Promise<void> {
     await page.goto(`/hosts/${host}/?editor=candidate`);
    await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, text); await waitForPaste(page);
    await page.getByRole("checkbox", { name: "Paste tables as CSV", exact: true }).check();
    await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: 0 }]); });
}
test("paste during a pending word move keeps the literal text at its destination with CSV enabled", async ({ page }) => {
    const word = "a".repeat(1000001), original = word + ";end";
    await setup(page, "plain", original); await input(page).focus();
    const before = await snapshot(page);
    await input(page).evaluate(node => {
        node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true }));
        const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
        event.clipboardData!.setData("text/plain", "X\tY"); node.dispatchEvent(event);
    });
    await waitForPaste(page); await exact(page, word + "X\tY;end");
    const after = await snapshot(page);
    expect(after.history.undoDepth).toBe(before.history.undoDepth + 1);
    expect(after.bindings.tablePaste.status).toBe("idle");
    await input(page).press("Control+z"); await waitForPaste(page); await exact(page, original);
});

for (const host of ["plain", "react"]) {
    for (const format of ["TSV", "HTML"]) test(`${host} ${format} table paste keeps all selections, shared undo, reference, Save/Run and remount`, async ({ page }) => {
        test.setTimeout(120000); const original = "AA\r\nmiddle\r\nZZ";
        await setup(page, host, original); await button(page, "Open source review").click(); await button(page, "Capture review acceptance").click(); await button(page, "Finish review acceptance").click(); await waitForPaste(page);
        await page.getByRole("checkbox", { name: "Paste tables as CSV", exact: true }).evaluate(node => { node.dataset.retained = "table-option"; });
        const requests: string[] = []; await page.route("**/table-paste-probe/**", route => { requests.push(route.request().url()); return route.fulfill({ status: 200, body: "" }); });
        await input(page).focus(); await page.evaluate(length => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 2, head: 0 }, { anchor: length - 2, head: length }], 1);
            Object.assign(globalThis, { tablePasteUnsafe: 0 }); }, original.length);
        const before = await snapshot(page), selections = before.bindings.views.find(v => v.id === "primary")!.selectionSet, newline = format === "TSV" ? "\r\n" : "\n";
        const csv = '"name","東京,' + newline + 'A ""quote""",""\r\n"","1","😀"';
        const html = '<table><tbody><tr><th rowspan="2">name<script>globalThis.tablePasteUnsafe=1</script><img src="/table-paste-probe/image" onerror="globalThis.tablePasteUnsafe=2"></th><th colspan="2">東京,<br>A "quote"</th></tr><tr><td>1</td><td>😀</td></tr></tbody></table>';
        const dispatched = await paste(input(page), 'name\t"東京,\r\nA ""quote"""\t\r\n\t1\t😀', format === "TSV" ? "" : html);
        expect(dispatched).toMatchObject({ before: before.source.revision, after: before.source.revision, prevented: true }); await waitForPaste(page);
        await expect(page.getByRole("checkbox", { name: "Paste tables as CSV", exact: true })).toHaveAttribute("data-retained", "table-option");
        const expected = csv + original.slice(2, -2) + csv; await exact(page, expected);
        let s = await snapshot(page); expect(s.bindings.tablePaste.status).toBe("applied"); expect(s.bindings.tablePaste).toMatchObject({ rows: 2, columns: 3, pending: false });
        expect(s.history.undoDepth).toBe(before.history.undoDepth + 1); expect(s.bindings.views.find(v => v.id === "primary")!.selectionSet.ranges.length).toBe(2); expect(s.source.exports).toBe(0);
        expect(s.bindings.views.every(v => v.metrics!.inputUnits <= 2600 && v.metrics!.viewport.rows < 100)).toBe(true);
        expect(await page.evaluate(() => (globalThis as unknown as { tablePasteUnsafe: number }).tablePasteUnsafe)).toBe(0); expect(requests).toEqual([]);
        await input(page, "Secondary source").press("Control+z"); await waitForPaste(page); await exact(page, original);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(selections);
        await input(page).press("Control+Shift+z"); await waitForPaste(page); await exact(page, expected);
        const reference = (await snapshot(page)).bindings.comparison!.baseline!.version;
        await input(page, "Comparison working source").focus(); await page.evaluate(to => { const f = window.hostFixture; f.selectSourceSet("comparison", f.snapshot().source.revision, [{ anchor: to, head: 0 }]); }, csv.length);
        await paste(input(page, "Comparison working source"), "review\tvalue"); await waitForPaste(page); await exact(page, '"review","value"' + expected.slice(csv.length));
        await input(page, "Secondary source").press("Control+z"); await waitForPaste(page); await exact(page, expected);
        expect((await snapshot(page)).bindings.comparison!.baseline!.version).toBe(reference); expect(await page.evaluate(() => window.hostFixture.referenceRange(0, 4))).toBe("AA\r\n");
        const viewId = (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.viewId;
        await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await waitForPaste(page);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.viewId).toBe(viewId); await expect(page.getByRole("checkbox", { name: "Paste tables as CSV", exact: true })).toBeChecked();
        await input(page).press("Control+s"); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await input(page).press("Escape"); await input(page).press("Control+End"); await input(page).pressSequentially(" later"); await page.evaluate(() => window.hostFixture.finishSave()); await waitForPaste(page); await exact(page, expected + " later");
        expect((await snapshot(page)).source.dirty).toBe(true); await input(page).press("Control+z"); await waitForPaste(page); await exact(page, expected); expect((await snapshot(page)).source.dirty).toBe(false);
        await button(page, "Run captured inputs").click(); expect(await page.evaluate(text => window.hostFixture.runCapture(0)!.source === text, expected)).toBe(true); await button(page, "Finish run").click();
        await page.evaluate(() => window.hostFixture.dispose()); s = await snapshot(page); expect(s.diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 }); expect(s.hostSubscriptions).toBe(0); expect(s.bindings.tablePaste.sessions).toBe(0);
    });
    test(`${host} captured table paste survives focus elsewhere and cancels on authority, staged input and remount`, async ({ page }) => {
        await setup(page, host, "source"); const table = "a\tb\r\n".repeat(5000); await input(page).focus();
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(true));
        const refused = await input(page).evaluate(node => {
            let reason: string | undefined;
            node.closest(".st-editor")!.addEventListener("sttropez-edit-refused", event => {
                reason = (event as CustomEvent<{ reason: string }>).detail.reason;
            }, { once: true });
            const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            event.clipboardData!.setData("text/plain", "locked\tpaste"); node.dispatchEvent(event);
            return reason;
        });
        expect(refused).toBe("read-only"); await exact(page, "source");
        expect((await snapshot(page)).bindings.tablePaste.status).toBe("idle");
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(false));
        await input(page).evaluate((node, table) => { const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }); event.clipboardData!.setData("text/plain", table); node.dispatchEvent(event);
            window.hostFixture.setSourceReadOnly(true); window.hostFixture.setSourceReadOnly(false); }, table);
        await waitForPaste(page); await exact(page, "source"); expect((await snapshot(page)).bindings.tablePaste.status).toBe("cancelled");
        await input(page).evaluate((node, table) => { const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }); event.clipboardData!.setData("text/plain", table); node.dispatchEvent(event);
            node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); }, table);
        await waitForPaste(page); await exact(page, "source"); expect((await snapshot(page)).bindings.tablePaste.status).toBe("cancelled");
        await input(page).evaluate((node, table) => { const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }); event.clipboardData!.setData("text/plain", table); node.dispatchEvent(event);
            window.hostFixture.unmount(); window.hostFixture.mount(); }, table);
        await waitForPaste(page); await exact(page, "source"); expect((await snapshot(page)).bindings.tablePaste.status).toBe("cancelled");
        await input(page).focus(); await input(page).evaluate((node, table) => { const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }); event.clipboardData!.setData("text/plain", table); node.dispatchEvent(event);
            const field = [...document.querySelectorAll("label")].find(label => label.textContent === "Configuration path")?.querySelector("input");
            if (!field) throw new Error("Missing labelled configuration input."); field.focus(); }, table);
        await waitForPaste(page); await exact(page, '"a","b"\r\n'.repeat(5000) + "source"); await expect(page.getByRole("textbox", { name: "Configuration path", exact: true })).toBeFocused();
        expect((await snapshot(page)).source.exports).toBe(0); await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 }); expect((await snapshot(page)).hostSubscriptions).toBe(0);
    });
    test(`${host} malformed HTML tables fail visibly and valid row groups and plain fallback remain usable`, async ({ page }) => {
        await setup(page, host, "source"); await input(page).focus(); const before = await snapshot(page);
        for (const html of ['<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>', '<table><tr><td><table><tr><td>nested</td></tr></table></td></tr></table>', '<table><tr><td>x</td></tr></table><table><tr><td>y</td></tr></table>']) {
            await paste(input(page), "fallback\tdata", html); await waitForPaste(page); await exact(page, "source"); expect((await snapshot(page)).bindings.tablePaste.status).toBe("failed");
        }
        expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth);
        await paste(input(page), "fallback\tdata", "<b>no table</b>"); await waitForPaste(page); await exact(page, '"fallback","data"source');
        await input(page).press("Control+z"); await waitForPaste(page);
        await paste(input(page), "", '<table><thead><tr><th rowspan="0">before<div>middle</div>after</th><th>b</th></tr><tr><th>c</th></tr></thead><tbody><tr><td>d</td><td>e</td></tr></tbody></table>');
        await waitForPaste(page); await exact(page, '"before\nmiddle\nafter","b"\r\n"","c"\r\n"d","e"source');
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 }); expect((await snapshot(page)).hostSubscriptions).toBe(0);
    });
}
