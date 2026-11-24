import { test, expect } from "./fixtures.ts";

test("bounded input remains bounded during a bulk insertion with one edit and undo unit", async ({ page }, info) => {
    await page.goto("/hosts/plain/");
    const input = page.getByRole("textbox", { name: "Primary source", exact: true });
    await input.fill("original"); await input.press("Control+a");
    const before = await page.evaluate(() => window.hostFixture.snapshot());
    const text = Array.from({ length: 600 }, (_, i) => `export function item${i}(value: number): string { return "Item ${i}: " + value; }\n`).join("");
    await input.evaluate(node => {
        const input = node as HTMLTextAreaElement, sizes: number[] = [];
        for (const type of ["beforeinput", "input"]) input.addEventListener(type, () => sizes.push(input.value.length), { capture: true });
        Object.assign(window, { bulkInputSizes: sizes });
    });
    const start = performance.now(); await page.keyboard.insertText(text);
    await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().source.length)).toBe(text.length);
    const elapsed = performance.now() - start;
    expect(await page.evaluate(length => window.hostFixture.range(0, length), text.length)).toBe(text);
    const after = await page.evaluate(() => window.hostFixture.snapshot());
    expect(after.source.revision).toBe(before.source.revision + 1);
    expect(after.history.undoDepth).toBe(before.history.undoDepth + 1);
    expect(after.bindings.views.find(view => view.id === "primary")!.selection).toMatchObject({ anchor: text.length, head: text.length });
    expect(await page.evaluate(() => Math.max(...(window as unknown as { bulkInputSizes: number[] }).bulkInputSizes))).toBeLessThanOrEqual(2560);
    expect(after.inputRecovery).toEqual(before.inputRecovery);
    await input.press("Control+z"); expect(await page.evaluate(() => window.hostFixture.range(0, 8))).toBe("original");
    await input.press("Control+y"); expect(await page.evaluate(length => window.hostFixture.range(0, length), text.length)).toBe(text);
    await info.attach("bulk-input", { body: JSON.stringify({ units: text.length, automationProxyMs: elapsed }), contentType: "application/json" });
});

test("bulk beforeinput honors host veto and native fallback, and maps every captured UTF-16 range", async ({ page }) => {
    await page.goto("/hosts/plain/");
    const input = page.getByRole("textbox", { name: "Primary source", exact: true }), original = "a\r\nb|c", data = "😀\r\n".repeat(700), normalized = data.replaceAll("\r\n", "\n");
    await page.evaluate(original => {
        const f = window.hostFixture, state = f.snapshot();
        f.editSource(state.source.revision, [{ from: 0, to: state.source.length, insert: original }]);
        f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 2, head: 1 }, { anchor: 6, head: 5 }], 0);
    }, original);
    const before = await page.evaluate(() => window.hostFixture.snapshot());
    const dispatch = (cancelable: boolean, veto = false) => input.evaluate((node, { data, cancelable, veto }) => {
        if (veto) node.addEventListener("beforeinput", event => event.preventDefault(), { capture: true, once: true });
        const event = new InputEvent("beforeinput", { inputType: "insertText", data, cancelable, bubbles: true });
        node.dispatchEvent(event); return event.defaultPrevented;
    }, { data, cancelable, veto });
    expect(await dispatch(true, true)).toBe(true);
    expect((await page.evaluate(() => window.hostFixture.snapshot())).source.revision).toBe(before.source.revision);
    expect(await dispatch(false)).toBe(false);
    // No native mutation follows this probe; the next beforeinput supplies its own capture.
    expect((await page.evaluate(() => window.hostFixture.snapshot())).source.revision).toBe(before.source.revision);
    expect(await dispatch(true)).toBe(true);
    const expected = "a" + normalized + "\nb|" + normalized;
    expect(await page.evaluate(length => window.hostFixture.range(0, length), expected.length)).toBe(expected);
    expect((await page.evaluate(() => window.hostFixture.snapshot())).history.undoDepth).toBe(before.history.undoDepth + 1);
    await input.press("Control+z"); expect(await page.evaluate(() => window.hostFixture.range(0, 6))).toBe(original);
    expect((await page.evaluate(() => window.hostFixture.snapshot())).bindings.views.find(view => view.id === "primary")!.selectionSet)
        .toEqual(before.bindings.views.find(view => view.id === "primary")!.selectionSet);
});

test(`plain continuous typing beside repeated text keeps one undo unit and shared selection mapping`, async ({ page }) => {

    await page.goto(`/hosts/plain/`);
    const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
    await primary.fill("const"); await primary.press("Home");
    await page.evaluate(() => { const f = window.hostFixture; f.selectSource("secondary", f.snapshot().source.revision, { anchor: 1, head: 1, anchorAffinity: "before", headAffinity: "before" }); });
    const before = await page.evaluate(() => window.hostFixture.snapshot());
    await primary.evaluate(node => node.addEventListener("input", () => {
        document.querySelector('textarea[aria-label="Secondary source"]')!.dispatchEvent(new Event("select"));
    }, { once: true }));
    await primary.pressSequentially("abc");
    expect(await page.evaluate(() => window.hostFixture.range(0, 8))).toBe("abcconst");
    expect((await page.evaluate(() => window.hostFixture.snapshot())).history.undoDepth).toBe(before.history.undoDepth + 1);
    expect((await page.evaluate(() => window.hostFixture.snapshot())).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: 3, head: 3 });
    expect((await page.evaluate(() => window.hostFixture.snapshot())).bindings.views.find(v => v.id === "secondary")!.selection).toMatchObject({ anchor: 4, head: 4 });
    expect((await page.evaluate(() => window.hostFixture.snapshot())).bindings.views.find(v => v.id === "secondary")!.selection).toMatchObject({ anchorAffinity: "before", headAffinity: "before" });
    await primary.press("Control+z"); expect(await page.evaluate(() => window.hostFixture.range(0, 5))).toBe("const");
    await primary.press("Control+Shift+z"); expect(await page.evaluate(() => window.hostFixture.range(0, 8))).toBe("abcconst");
    await primary.press("Home"); await primary.press("Shift+ArrowRight");
    const unchanged = await page.evaluate(() => window.hostFixture.snapshot());
    await primary.pressSequentially("a");
    const after = await page.evaluate(() => window.hostFixture.snapshot());
    expect(after.source.revision).toBe(unchanged.source.revision); expect(after.history.undoDepth).toBe(unchanged.history.undoDepth);
    expect(after.bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: 1, head: 1 });
});

test(`plain captured typing rejects intervening revision and selection changes`, async ({ page }) => {
    await page.goto(`/hosts/plain/`);
    const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
    for (const changed of ["revision", "selection", "context"] as const) {
        if (changed === "context") await page.evaluate(() => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: "x".repeat(3000) }]);
            f.selectSource("primary", f.snapshot().source.revision, { anchor: 2000, head: 2000 }); });
        else { await primary.fill("const"); await primary.press("Home"); }
        const before = await page.evaluate(() => window.hostFixture.snapshot());
        await primary.evaluate((node, changed) => {
            const input = node as HTMLTextAreaElement, f = window.hostFixture;
            input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "a", bubbles: true }));
            if (changed !== "selection") f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: "!" }]);
            else f.selectSource("primary", f.snapshot().source.revision, { anchor: 2, head: 2 });
            input.setRangeText("a", input.selectionStart, input.selectionEnd, "end");
            input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "a", bubbles: true }));
        }, changed);
        const after = await page.evaluate(() => window.hostFixture.snapshot());
        expect(await page.evaluate(n => window.hostFixture.range(0, n), after.source.length)).toBe(changed === "context" ? "!" + "x".repeat(3000) : changed === "revision" ? "!const" : "const");
        expect(after.source.revision).toBe(before.source.revision + (changed !== "selection" ? 1 : 0));
        expect(after.inputRecovery.at(-1)?.reason).toBe("stale-text-input");
        expect(after.inputRecovery.at(-1)?.expectedRevision).toBe(before.source.revision);
        expect(after.inputRecovery.at(-1)?.documentId).toBe(before.bindings.views.find(v => v.id === "primary")!.documentId);
        expect(after.inputRecovery.at(-1)?.contextFrom).toBe(changed === "context" ? 1744 : 0);
    }
});
