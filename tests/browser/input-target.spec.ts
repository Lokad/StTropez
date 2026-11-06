import { test, expect } from "@playwright/test";

for (const host of ["plain", "react"]) for (const editor of ["native", "candidate"]) {
    test(`${host} ${editor} continuous typing beside repeated text keeps one undo unit and shared selection mapping`, async ({ page }) => {
        page.on("pageerror", error => { throw error; });
        await page.goto(`/hosts/${host}/?editor=${editor}`);
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

    test(`${host} ${editor} captured typing rejects intervening revision and selection changes`, async ({ page }) => {
        await page.goto(`/hosts/${host}/?editor=${editor}`);
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
            expect(after.inputRecovery.at(-1)?.contextFrom).toBe(changed === "context" && editor === "candidate" ? 1744 : 0);
        }
    });
}
