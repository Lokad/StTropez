import { expect } from "./fixtures.ts";
import { presentationTest as test } from "./presentation-fixture.ts";

test("minimap gestures preserve focus and multiple selections as the document projection changes", async ({ page }) => {
    const selection = await page.evaluate(async () => {
        const path = "/presentation-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace(), lines = Array.from({ length: 200 }, (_, i) => i < 75 || i > 150 ? "    section " + i : "");
        lines[0] = "x".repeat(200);
        const resource = workspace.createTextResource({ scope: "test", resource: "map", variant: "text" }, "Map", { value: lines.join("\n") });
        const host = document.createElement("section");
        host.style.cssText = "width:410.5px;height:240.5px;zoom:1.25"; document.body.append(host);
        const editor = mountTextEditor(host, workspace, resource.id), viewport = editor.viewport;
        window.presentationFixture = { workspace, resource: resource.id, host, editor };
        if (viewport.settings().minimap || host.querySelector("canvas")) throw new Error("Expected an opt-in overview.");
        viewport.configure({ minimap: true });
        editor.view.setSelections(workspace.document(resource.id).revision, [{ anchor: 6, head: 2 }, { anchor: 9, head: 9 }], 0);
        editor.focus(); viewport.flush();
        return editor.view.getSnapshot().selectionSet;
    });
    const track = page.locator(".st-minimap"), marker = track.locator(".st-minimap-marker"), canvas = track.locator("canvas");
    const bitmap = () => canvas.evaluate(c => (c as HTMLCanvasElement).toDataURL());
    await expect.poll(() => canvas.evaluate(c => (c as HTMLCanvasElement).width)).toBeGreaterThan(0);
    const original = await bitmap(), trackBox = (await track.boundingBox())!;
    await page.evaluate(() => window.presentationFixture.host.style.setProperty("--st-foreground", "#e02222"));
    await expect.poll(bitmap).not.toBe(original);
    await page.evaluate(() => window.presentationFixture.host.style.removeProperty("--st-foreground"));
    await expect.poll(bitmap).toBe(original);
    expect(await page.evaluate(({ x, y }) => window.presentationFixture.editor.viewport.hitTest(x + 5, y + 5), trackBox)).toBeUndefined();
    const snapshot = () => page.evaluate(() => window.presentationFixture.editor.viewport.getDiagnostics());
    await page.mouse.click(trackBox.x + 8, trackBox.y + trackBox.height / 2);
    await expect.poll(async () => (await snapshot()).firstLine).toBeGreaterThan(80);
    expect((await snapshot()).lastLine).toBeLessThan(120);
    const grabbed = (await marker.boundingBox())!;
    await page.mouse.move(grabbed.x + 6, grabbed.y + 3); await page.mouse.down();
    await page.mouse.move(grabbed.x - 80, trackBox.y + trackBox.height + 5, { steps: 5 }); await page.mouse.up();
    await expect.poll(async () => (await snapshot()).lastLine).toBe(200);
    expect(await page.evaluate(() => window.presentationFixture.editor.view.getSnapshot().selectionSet)).toEqual(selection);
    await expect(page.getByRole("textbox")).toBeFocused();
    expect(await bitmap()).toBe(original);
    await page.evaluate(() => {
        const { editor, workspace } = window.presentationFixture, doc = workspace.document(editor.view.documentId);
        editor.view.setSelection(doc.revision, { anchor: doc.buffer.offsetAt(80), head: doc.buffer.offsetAt(80) });
        editor.viewport.revealOffset(doc.buffer.offsetAt(80));
    });
    await page.keyboard.insertText("new section\nsecond line");
    await expect.poll(bitmap).not.toBe(original);
    await page.getByRole("textbox").press("Control+z");
    await expect.poll(bitmap).toBe(original);
    await page.evaluate(() => {
        const { editor, workspace, host } = window.presentationFixture, doc = workspace.document(editor.view.documentId);
        editor.view.folding.setRanges(editor.view.folding.getSnapshot(), [{ id: "block", from: 0, to: doc.buffer.offsetAt(195), collapsed: true }]);
        host.style.height = "300px"; editor.viewport.flush();
    });
    await expect.poll(async () => (await snapshot()).visibleLines).toBe(6);
    await expect.poll(async () => (await marker.boundingBox())!.height).toBeCloseTo((await track.boundingBox())!.height, 0);
    await expect.poll(bitmap).not.toBe(original);
    await page.evaluate(() => {
        const { editor } = window.presentationFixture, folds = editor.view.folding;
        folds.setCollapsed(folds.getSnapshot(), "block", false); editor.viewport.scrollTo({ left: 10000 }); editor.viewport.flush();
    });
    // Expanding the fold restores the native scrollbar. Its resize observation updates the map width.
    await expect.poll(async () => (await track.boundingBox())!.width).toBeCloseTo(trackBox.width, 0);
    const resized = (await track.boundingBox())!;
    expect(Math.abs(resized.x + resized.width - trackBox.x - trackBox.width)).toBeLessThanOrEqual(1.5);
    await page.mouse.click(resized.x + 3, resized.y + resized.height - 1);
    await expect.poll(async () => (await snapshot()).lastLine).toBe(200);
    expect((await snapshot()).scrollLeft).toBeGreaterThan(0);
    const released = await page.evaluate(() => {
        const { editor, host } = window.presentationFixture, view = editor.viewport;
        view.configure({ minimap: false }); view.flush(); editor.dispose();
        return { nodes: host.childNodes.length, enabled: view.settings().minimap, accepted: view.configure({ minimap: true }) };
    });
    expect(released).toEqual({ nodes: 0, enabled: false, accepted: false });
});

test("minimap projects comparison gaps and follows linked and independent scroll in the read-only reference", async ({ page }) => {
    await page.evaluate(async () => {
        const path = "/presentation-fixture/", { Workspace, TextBuffer } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextComparison } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const lines = Array.from({ length: 160 }, (_, i) => "section " + i);
        const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "map-review", variant: "text" }, "Working", { value: lines.join("\n") });
        const host = document.createElement("section");
        host.style.width = "900px"; document.body.append(host); lines.splice(40, 0, ...Array<string>(80).fill("baseline section"));
        const comparison = mountTextComparison(host, workspace, resource.id, { buffer: TextBuffer.from(lines.join("\n")), version: "one" }, { rowsAligned: true, settings: {
            minimap: true, minimapLabel: line => line === null ? "Espace" : "Ligne " + line,
        } });
        window.presentationFixture = { workspace, host, resource: resource.id, editor: comparison.panes.working, comparison };
    });
    await page.waitForFunction(() => window.presentationFixture.editor.viewport.activity().aligned);
    const maps = page.locator(".st-minimap"), saved = maps.first(), working = maps.last();
    const bandHasInk = (map: typeof saved) => map.locator("canvas").evaluate(element => {
        const c = element as HTMLCanvasElement;
        return c.width ? c.getContext("2d")!.getImageData(0, Math.round(c.height / 3), c.width, 10).data.some((v, i) => i % 4 === 3 && v > 0) : undefined;
    });
    await expect.poll(() => bandHasInk(saved)).toBe(true); await expect.poll(() => bandHasInk(working)).toBe(false);
    const preview = page.locator(".st-minimap-preview:visible strong");
    const hoverBand = async (map: typeof saved) => {
        const box = (await map.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    };
    await hoverBand(saved);
    await expect(preview).toHaveText(/^Ligne \d+$/);
    await hoverBand(working);
    await expect(preview).toHaveText("Espace");
    await page.evaluate(() => window.presentationFixture.editor.configure({
        minimapLabel: line => line === null ? "Comparison gap" : String(line),
    }));
    await expect(preview).toHaveText("Comparison gap");
    await page.evaluate(() => {
        const pane = window.presentationFixture.editor.viewport;
        pane.scrollTo({ top: 70 * pane.getSnapshot().lineHeight }); pane.flush();
    });
    await page.waitForFunction(() => {
        const panes = window.presentationFixture.comparison!.panes;
        const a = panes.working.viewport.getSnapshot(), b = panes.reference.viewport.getSnapshot();
        return a.lineFrom === a.lineTo && b.lineFrom > 40 && b.lineTo < 120 && Math.abs(a.scrollTop - b.scrollTop) < 2;
    });
    const box = (await saved.boundingBox())!;
    await page.mouse.click(box.x + 5, box.y + box.height * .8);
    await page.waitForFunction(() => { const c = window.presentationFixture.comparison!, ref = c.panes.reference.viewport.getDiagnostics(), work = c.panes.working.viewport.getDiagnostics();
        return ref.firstLine > 140 && Math.abs(ref.scrollTop - work.scrollTop) < 2; });
    const independent = await page.evaluate(() => {
        const c = window.presentationFixture.comparison!; c.setRowsAligned(false); c.setScrollLinked(false);
        const reference = c.panes.reference, doc = window.presentationFixture.workspace.document(reference.view.documentId);
        reference.view.folding.setRanges(reference.view.folding.getSnapshot(), [{ id: "saved", from: 0, to: doc.buffer.offsetAt(39), collapsed: true }]);
        reference.viewport.flush(); c.panes.working.viewport.flush();
        return { workingTop: c.panes.working.viewport.getSnapshot().scrollTop, readOnly: reference.getSnapshot().readOnlyReason === "read-only", selection: reference.view.getSnapshot().selectionSet };
    });
    expect(independent.readOnly).toBe(true);
    await saved.click({ position: { x: 5, y: 1 } });
    await page.waitForFunction(() => window.presentationFixture.comparison!.panes.reference.viewport.getSnapshot().scrollTop === 0);
    const result = await page.evaluate(() => { const c = window.presentationFixture.comparison!;
        return { work: c.panes.working.viewport.getDiagnostics(), ref: c.panes.reference.viewport.getDiagnostics(), selection: c.panes.reference.view.getSnapshot().selectionSet }; });
    expect(result.work.scrollTop).toBeCloseTo(independent.workingTop, 0); expect(result.work.visibleLines).toBe(160);
    expect(result.ref.visibleLines).toBe(202); expect(result.selection).toEqual(independent.selection);
});
