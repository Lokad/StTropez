import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { hostTextEquals } from "../../scripts/host-scene.mjs";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
async function waitForReview(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (s.bindings.comparison !== null); });
}
async function exact(page: Page, text: string): Promise<void> { expect(await hostTextEquals(page, text)).toBe(true); }

for (const journey of ["primary", "comparison", "resize and queued input"] as const)
test(`plain ${journey} boundaries finish before immediate typing`, async ({ page }) => {
    test.setTimeout(120000);  await page.goto(`/hosts/plain/?editor=candidate`);
    const bodyRows = 128, rowUnits = "const unchanged = 123;\r\n".length;
    const original = "first é😀\r\n" + "const unchanged = 123;\r\n".repeat(bodyRows) + "last\r", bodyStart = original.indexOf("\n") + 1;
    await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, original);
    for (const name of ["Open source review", "Capture review acceptance", "Finish review acceptance"]) await page.getByRole("button", { name, exact: true }).click();
    await waitForReview(page);
    // Each editor journey owns its deadline; repeating all review/history waits in one body
    // exhausted the whole-test budget even while every individual operation kept progressing.
    if (journey !== "resize and queued input") {
    const view = journey;
    for (const mode of ["document", "line", "arrow", "vertical", "page"]) for (const key of ["Home", "End"] as const) for (const extend of [false, true]) {
        const documentBoundary = mode === "document", arrow = mode === "arrow", vertical = mode === "vertical" || mode === "page";
        const commandKey = arrow ? key === "Home" ? "ArrowLeft" : "ArrowRight" : vertical ? mode === "page" ? key === "Home" ? "PageUp" : "PageDown" : key === "Home" ? "ArrowUp" : "ArrowDown" : key;
        const input = page.getByRole("textbox", { name: view === "primary" ? "Primary source" : "Comparison working source", exact: true }); await input.focus();
        const starts = [bodyStart + 31 * rowUnits, bodyStart + (bodyRows - 33) * rowUnits];
        const ranges = vertical ? starts.map((start, i) => ({ anchor: start + (i ? 4 : 9), head: start + 6 }))
            : [{ anchor: 3, head: 2 }, arrow ? { anchor: original.length - 4, head: original.length - 3 } : { anchor: original.length - 3, head: original.length - 1 }];
        expect(await page.evaluate(({ view, ranges }) => { const f = window.hostFixture; return f.selectSourceSet(view, f.snapshot().source.revision, ranges, 1); }, { view, ranges })).toBe(true); await waitForReview(page);
        const before = await snapshot(page), endpoint = key === "Home" ? 0 : original.length;
        // One browser task, with no timer/automation round trip between navigation and input.
        // The synthetic edit sequence is deliberate; later keyboard typing uses the trusted path.
        const result = await input.evaluate((node, { key, extend, documentBoundary }) => {
            const input = node as HTMLTextAreaElement, f = window.hostFixture;
            input.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: documentBoundary, shiftKey: extend, bubbles: true, cancelable: true }));
            const s = f.snapshot(), v = input.getAttribute("aria-label") === "Primary source" ? s.bindings.views.find(v => v.id === "primary")! : s.bindings.comparison!;
            const selectionSet = v.selectionSet!, pending = "metrics" in v ? v.metrics!.pendingGrapheme : v.input.pendingGrapheme;
            input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "!", bubbles: true, cancelable: true }));
            input.setRangeText("!", input.selectionStart, input.selectionEnd, "end"); input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "!", bubbles: true }));
            return { selectionSet, pending };
        }, { key: commandKey, extend, documentBoundary });
        expect(result.pending, `${view} ${commandKey} shift=${extend}`).toBe(false);
        const owner = ranges[1]!;
        // Document extensions overlap/coalesce; line extensions stay independent.
        const lineHeads = key === "Home" ? [0, original.length - 5] : [original.indexOf("\r\n"), original.length];
        const arrowHeads = ranges.map(range => extend ? range.head + (key === "Home" ? -1 : 1) : (key === "Home" ? Math.min : Math.max)(range.anchor, range.head));
        const viewport = view === "primary" ? before.bindings.views.find(v => v.id === view)!.metrics!.viewport : before.bindings.comparison!.workingViewport;
        const pageLines = Math.max(1, Math.floor(viewport.height / viewport.lineHeight) - 1); expect(pageLines).toBeLessThan(32);
        const heads = vertical ? ranges.map(range => range.head + (key === "Home" ? -1 : 1) * rowUnits * (mode === "page" ? pageLines : 1)) : arrow ? arrowHeads : lineHeads;
        const destinations = documentBoundary ? [{ anchor: extend ? key === "Home" ? owner.anchor : ranges[0]!.anchor : endpoint, head: endpoint }]
            : ranges.map((range, i) => ({ anchor: extend ? range.anchor : heads[i]!, head: heads[i]! }));
        expect(result.selectionSet.primary).toBe(documentBoundary ? 0 : 1);
        expect(result.selectionSet.ranges.map(({ anchor, head }) => ({ anchor, head }))).toEqual(destinations);
        let expected = original;
        for (const range of destinations.slice().reverse()) { const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head); expected = expected.slice(0, from) + "!" + expected.slice(to); }
        await waitForReview(page); await exact(page, expected);
        const after = await snapshot(page); expect(after.source.revision).toBe(before.source.revision + 1); expect(after.history.undoDepth).toBe(before.history.undoDepth + 1);
        expect(after.source.exports).toBe(0); expect(after.bindings.comparison!.baseline).toEqual(before.bindings.comparison!.baseline);
        expect(after.bindings.views.every(v => v.metrics!.inputUnits <= 2600 && v.metrics!.viewport.rows < 100)).toBe(true);
        await page.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+z"); await waitForReview(page); await exact(page, original);
        const undone = await snapshot(page), set = view === "primary" ? undone.bindings.views.find(v => v.id === view)!.selectionSet : undone.bindings.comparison!.selectionSet!;
        expect(set).toEqual(result.selectionSet);
        await input.press("Control+Shift+z"); await waitForReview(page); await exact(page, expected); await input.press("Control+z"); await waitForReview(page);
    }
    }
    else {
    // Resize and PageDown occur in one task, before ResizeObserver/RAF can refresh metrics.
    const sourceInput = page.getByRole("textbox", { name: "Primary source", exact: true }), resizeHeads = [31, bodyRows - 33].map(line => bodyStart + line * rowUnits + 6);
    await sourceInput.focus();
    await page.evaluate(heads => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, heads.map(head => ({ anchor: head, head })), 1); }, resizeHeads); await waitForReview(page);
    const resized = await sourceInput.evaluate(node => {
        const input = node as HTMLTextAreaElement, root = input.parentElement!; root.style.height = "180px";
        const pageLines = Math.max(1, Math.floor(root.clientHeight / parseFloat(getComputedStyle(root).lineHeight)) - 1);
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }));
        const state = window.hostFixture.snapshot().bindings.views.find(v => v.id === "primary")!;
        input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "!", bubbles: true, cancelable: true }));
        input.setRangeText("!", input.selectionStart, input.selectionEnd, "end"); input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "!", bubbles: true }));
        return { pageLines, pending: state.metrics!.pendingGrapheme, heads: state.selectionSet.ranges.map(r => r.head) };
    });
    expect(resized.pending).toBe(false); expect(resized.heads).toEqual(resizeHeads.map(head => head + resized.pageLines * rowUnits));
    let resizedText = original; for (const head of resizeHeads.slice().reverse()) { const at = head + resized.pageLines * rowUnits; resizedText = resizedText.slice(0, at) + "!" + resizedText.slice(at); }
    await waitForReview(page); await exact(page, resizedText); await page.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+z"); await waitForReview(page); await exact(page, original);
    // The bounded fast path also handles 32 independent anchors in read-only sources.
    await page.getByRole("textbox", { name: "Primary source", exact: true }).focus();
    await page.evaluate(() => { const f = window.hostFixture, n = f.snapshot().source.length;
        f.selectSourceSet("primary", f.snapshot().source.revision, Array.from({ length: 32 }, (_, i) => ({ anchor: Math.floor(i * (n - 1) / 32), head: Math.floor(i * (n - 1) / 32) })), 17); f.setSourceReadOnly(true);
    }); await waitForReview(page); const readonly = await snapshot(page);
    for (const documentBoundary of [false, true]) {
        const movement = await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate((node, ctrlKey) => {
            node.dispatchEvent(new KeyboardEvent("keydown", { key: "End", ctrlKey, bubbles: true, cancelable: true }));
            return window.hostFixture.snapshot().bindings.views.find(v => v.id === "primary")!;
        }, documentBoundary);
        const ends = readonly.bindings.views.find(v => v.id === "primary")!.selectionSet.ranges.map(({ head }) => {
            if (documentBoundary) return original.length;
            const lf = original.indexOf("\n", head); return lf < 0 ? original.length : original[lf - 1] === "\r" ? lf - 1 : lf;
        });
        expect(movement.metrics!.pendingGrapheme).toBe(false);
        expect(movement.selectionSet.ranges.map(r => r.head)).toEqual([...new Set(ends)].sort((a, b) => a - b));
        await page.getByRole("textbox", { name: "Primary source", exact: true }).pressSequentially("x"); await exact(page, original); expect((await snapshot(page)).history).toEqual(readonly.history);
    }
    // Cooperative vertical/page commands preserve immediate typing for thirty-two carets.
    const heads = Array.from({ length: 32 }, (_, i) => bodyStart + (31 + i * 2) * rowUnits + 6);
    for (const key of ["ArrowRight", "ArrowDown", "PageDown"]) {
    await page.evaluate(heads => { const f = window.hostFixture; f.setSourceReadOnly(false); f.selectSourceSet("primary", f.snapshot().source.revision, heads.map(head => ({ anchor: head, head })), 17); }, heads); await waitForReview(page);
    const viewport = (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport;
    const delta = key === "ArrowRight" ? 1 : rowUnits * (key === "PageDown" ? Math.max(1, Math.floor(viewport.height / viewport.lineHeight) - 1) : 1);
    const moved = await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate((node, key) => {
        const input = node as HTMLTextAreaElement;
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        const state = window.hostFixture.snapshot().bindings.views.find(v => v.id === "primary")!;
        const accepted = input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "!", bubbles: true, cancelable: true }));
        if (accepted) { input.setRangeText("!", input.selectionStart, input.selectionEnd, "end"); input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "!", bubbles: true })); }
        return { pending: state.metrics!.pendingGrapheme, accepted, heads: state.selectionSet.ranges.map(r => r.head) };
    }, key);
    if (moved.pending) expect(moved.accepted).toBe(false);
    else expect(moved.heads).toEqual(heads.map(head => head + delta));
    let expected = original; for (const head of heads.slice().reverse()) expected = expected.slice(0, head + delta) + "!" + expected.slice(head + delta);
    await waitForReview(page); await exact(page, expected); await page.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+z"); await waitForReview(page); await exact(page, original);
    }
    const primary = page.getByRole("textbox", { name: "Primary source", exact: true }); await primary.press("Control+End"); await primary.pressSequentially("x"); await waitForReview(page); await exact(page, original + "x");
    }
    await page.evaluate(() => window.hostFixture.dispose()); const end = await snapshot(page); expect(end.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(end.hostSubscriptions).toBe(0);
});
