import { test, expect } from "./fixtures.ts";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Workspace, ResourceId, TabId } from "../../src/index.ts";
import type { EditingCandidate, TextComparison } from "../../src/browser/index.ts";

type Fixture = { workspace: Workspace; editor: EditingCandidate; host: HTMLElement; tab: TabId; resource: ResourceId; comparison?: TextComparison };
declare global { interface Window { presentationFixture: Fixture } }

let modules: Map<string, string>, css: string;
test.beforeAll(async () => {
    const built = await build({ entryPoints: { core: "src/index.ts", browser: "src/browser/index.ts" }, outdir: "artifacts/presentation-fixture",
        bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", write: false });
    modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text])); css = await readFile("src/browser/editor.css", "utf8");
});
test.beforeEach(async ({ page }) => {
    await page.route("**/presentation-fixture/**", route => {
        const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
        return route.fulfill({ contentType: name === "" ? "text/html" : "text/javascript", body: name === "" ? "<!doctype html>" : modules.get(name)! });
    });
    await page.goto("/presentation-fixture/");
    await page.addStyleTag({ content: css });
});

test("column rulers follow measured scroll/font/zoom without changing source geometry, extent or ownership", async ({ page }, info) => {
    const initial = await page.evaluate(async () => {
        const path = "/presentation-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountEditingCandidate } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "rulers", variant: "text" }, "Rulers", { value: ("x".repeat(200) + "\n").repeat(1000) });
        const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "rulers"), host = document.createElement("section");
        host.style.cssText = "height:240px;width:600px"; document.body.append(host);
        for (const columns of [[0], [-1], [1.5], [Infinity], [NaN], [Number.MAX_SAFE_INTEGER + 1], Array(1), Array(129).fill(80)]) {
            const before = workspace.diagnostics().views;
            try { mountEditingCandidate(host, workspace, tab, { columnRulers: columns }); throw new Error("Invalid rulers accepted."); }
            catch (error) { if (!(error instanceof RangeError)) throw error; }
            if (workspace.diagnostics().views !== before || host.childNodes.length) throw new Error("Invalid mount leaked ownership.");
        }
        const editor = mountEditingCandidate(host, workspace, tab, { ariaLabel: "Ruler source" }), viewport = editor.viewport;
        window.presentationFixture = { workspace, editor, host, tab, resource: resource.id };
        const settle = () => { for (let i = 0; i < 8; i++) { viewport.flush(); if (!viewport.activity().pending) return; } throw new Error("Viewport did not settle."); };
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        settle(); const plain = viewport.snapshot(), point = viewport.coordsAt(20)!, row = host.querySelector('.st-viewport-row[data-line="0"]')!, child = row.firstChild;
        const plainExtent = [plain.horizontalExtent, plain.verticalExtent, viewport.element.scrollWidth, viewport.element.scrollHeight];
        const defaults = viewport.columnRulers(), buffer = workspace.document(resource.documentId).buffer, beforeReads = buffer.readMetrics().sliceUnits;
        const configured = [40, 20, 40, 1_000_000]; viewport.configureColumnRulers(configured); configured[0] = 1; viewport.flush();
        const after = viewport.snapshot(), captured = viewport.columnRulers(), guide = host.querySelector<HTMLElement>('.st-column-ruler[data-column="20"]')!;
        const range = document.createRange(); range.setStart(child!, 20); range.collapse(true); const native = range.getClientRects()[0]!;
        const noRowReads = buffer.readMetrics().sliceUnits - beforeReads;
        const observer = new MutationObserver(() => {}); observer.observe(viewport.element, { subtree: true, childList: true, attributes: true });
        viewport.configureColumnRulers([1_000_000, 40, 20, 20]); viewport.flush();
        const noOp = { same: captured === viewport.columnRulers(), mutations: observer.takeRecords().length, pending: viewport.activity().pending }; observer.disconnect();
        let invalid = false; try { viewport.configureColumnRulers([20, 0]); } catch { invalid = true; }
        return { defaults, columns: captured, frozen: Object.isFrozen(captured), invalid, preservedPolicy: captured === viewport.columnRulers(), noRowReads, noOp,
            point, afterPoint: viewport.coordsAt(20), sameChild: child === row.firstChild, text: row.textContent,
            guideError: Math.abs(guide.getBoundingClientRect().left - native.left), nativeLeft: native.left, guideLeft: guide.getBoundingClientRect().left,
            placementError: Math.abs(guide.getBoundingClientRect().left - viewport.element.getBoundingClientRect().left - 12 - 20 * after.columnWidth), plain, after,
            pointer: getComputedStyle(guide).pointerEvents,
            visible: host.querySelectorAll(".st-column-ruler").length, plainExtent,
            afterExtent: [after.horizontalExtent, after.verticalExtent, viewport.element.scrollWidth, viewport.element.scrollHeight],
            click: { x: guide.getBoundingClientRect().left, y: point.top + point.height / 2 } };
    });
    await info.attach("initial-ruler-geometry", { body: JSON.stringify(initial), contentType: "application/json" });
    expect(initial).toMatchObject({ defaults: [], columns: [20, 40, 1_000_000], frozen: true, invalid: true, preservedPolicy: true,
        noRowReads: 0, noOp: { same: true, mutations: 0, pending: false }, sameChild: true, text: "x".repeat(200), pointer: "none", visible: 2 });
    expect(initial.afterExtent).toEqual(initial.plainExtent); expect(initial.afterPoint).toEqual(initial.point);
    // Some native collapsed ranges round to whole CSS pixels; the measured ruler remains fractional.
    expect(initial.guideError).toBeLessThan(1.01); expect(initial.placementError).toBeLessThan(.02);
    await info.attach("column-rulers", { body: await page.screenshot(), contentType: "image/png" });
    await page.mouse.click(initial.click.x, initial.click.y);
    expect(await page.evaluate(() => window.presentationFixture.editor.view.getSnapshot().selection.head)).toBe(20);
    await page.getByRole("textbox", { name: "Ruler source", exact: true }).press("ArrowRight");
    expect(await page.evaluate(() => window.presentationFixture.editor.view.getSnapshot().selection.head)).toBe(21);

    const changes = await page.evaluate(async () => {
        const f = window.presentationFixture, viewport = f.editor.viewport;
        const rows: { name: string; error: number; columnWidth: number; inside: boolean; physicalWidth: number; textUnits: number; rows: number }[] = [];
        const settle = () => { for (let i = 0; i < 8; i++) { viewport.flush(); if (!viewport.activity().pending) return; } throw new Error("Viewport did not settle."); };
        const measure = (name: string) => {
            settle(); const s = viewport.snapshot(), guide = f.host.querySelector<HTMLElement>('.st-column-ruler[data-column="40"]')!;
            const row = f.host.querySelector<HTMLElement>(`.st-viewport-row[data-line="${Math.max(0, s.firstLine)}"]`)!;
            const range = document.createRange(); range.setStart(row.firstChild!, 40); range.collapse(true); const rect = range.getClientRects()[0]!;
            rows.push({ name, error: Math.abs(guide.getBoundingClientRect().left - rect.left) / Number(f.host.style.zoom || 1), columnWidth: s.columnWidth,
                inside: guide.getBoundingClientRect().top >= viewport.element.getBoundingClientRect().top - .1, physicalWidth: viewport.element.scrollWidth,
                textUnits: s.textUnits, rows: s.rows });
        };
        viewport.scrollTo({ left: 150, top: 300 }); measure("scroll");
        f.host.style.zoom = "1.25"; measure("zoom");
        viewport.element.style.fontSize = "18px"; measure("font");
        f.host.style.width = "480px"; measure("resize");
        const retained = f.host.querySelector('.st-column-ruler[data-column="40"]'); viewport.scrollTo({ top: 500 }); settle();
        const retainedNode = retained === f.host.querySelector('.st-column-ruler[data-column="40"]');
        // The physical scrollbar is capped; rulers continue to use logical source columns.
        const doc = f.workspace.document(f.editor.view.documentId);
        f.workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, origin: "host", edits: [{ from: 0, to: doc.buffer.length, insert: "x".repeat(1_000_000) }] });
        viewport.configureColumnRulers([500000]); settle(); viewport.scrollTo({ left: 500000 * viewport.snapshot().columnWidth }); settle();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); settle();
        const s = viewport.snapshot(), guide = f.host.querySelector<HTMLElement>(".st-column-ruler")!, rectangle = f.host.querySelector(".st-viewport-layer")!.getBoundingClientRect();
        const scaledError = Math.abs(guide.getBoundingClientRect().left - rectangle.left - (12 + 500000 * s.columnWidth - s.scrollLeft) * 1.25);
        const markedPoint = viewport.coordsAt(500000), selected = f.editor.view.getSnapshot().selectionSet, extent = [viewport.element.scrollWidth, viewport.element.scrollHeight];
        viewport.configureColumnRulers([]); settle();
        return { rows, retainedNode, scaledError, scaled: s.horizontalExtent > s.physicalWidth, scaledUnits: s.textUnits, noGuides: !f.host.querySelector(".st-column-rulers"),
            samePoint: JSON.stringify(markedPoint) === JSON.stringify(viewport.coordsAt(500000)), sameSelections: selected === f.editor.view.getSnapshot().selectionSet,
            extent, emptyExtent: [viewport.element.scrollWidth, viewport.element.scrollHeight], exports: f.workspace.document(f.editor.view.documentId).buffer.readMetrics().textExports };
    });
    await info.attach("changed-ruler-geometry", { body: JSON.stringify(changes), contentType: "application/json" });
    expect(changes.rows.every(row => row.error < 1.01 && row.inside && row.textUnits <= row.rows * 512)).toBe(true);
    expect(changes.rows[2]!.columnWidth).toBeGreaterThan(changes.rows[1]!.columnWidth);
    expect(changes).toMatchObject({ retainedNode: true, scaled: true, noGuides: true, samePoint: true, sameSelections: true, exports: 0 });
    expect(changes.scaledError).toBeLessThan(.5); expect(changes.scaledUnits).toBeLessThan(1000); expect(changes.emptyExtent).toEqual(changes.extent);
    const end = await page.evaluate(() => { const f = window.presentationFixture, viewport = f.editor.viewport;
        viewport.configureColumnRulers([20]); f.workspace.close(f.tab); viewport.flush(); const closed = !f.host.querySelector(".st-column-rulers");
        f.editor.destroy(); f.workspace.releaseResource(f.resource, true);
        return { closed, configured: viewport.configureColumnRulers([20]), columns: viewport.columnRulers(), children: f.host.childNodes.length,
            views: f.workspace.diagnostics().views, subscriptions: f.workspace.diagnostics().subscriptions }; });
    expect(end).toEqual({ closed: true, configured: false, columns: [], children: 0, views: 0, subscriptions: 0 });
    await info.attach("ruler-geometry", { body: JSON.stringify({ initial, changes, end }), contentType: "application/json" });
});

test("current-line presentation follows the primary caret through input, folding and independent aligned review", async ({ page }, info) => {
    const initial = await page.evaluate(async () => {
        const path = "/presentation-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountEditingCandidate } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "current-line", variant: "text" }, "Current line", { value: "head\nbody\nmore\nend\n" });
        const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "current-line"), host = document.createElement("section"), style = document.createElement("style");
        host.style.cssText = "height:400px;width:800px;--st-current-line:#ffffff18";
        style.textContent = ".host-row { background: rgb(30, 45, 65) } .host-color { color: rgb(180, 60, 160) }"; document.body.append(style, host);
        try { mountEditingCandidate(host, workspace, tab, { highlightCurrentLine: "yes" as unknown as boolean }); throw new Error("Invalid current-line option accepted."); }
        catch (error) { if (!(error instanceof TypeError)) throw error; }
        if (host.childNodes.length || workspace.diagnostics().views) throw new Error("Invalid highlight mount leaked ownership.");
        const editor = mountEditingCandidate(host, workspace, tab, { ariaLabel: "Line source", lineClass: () => "host-row",
            decorate: line => [{ from: line.from, to: line.to, className: "host-color" }] }), viewport = editor.viewport;
        window.presentationFixture = { workspace, editor, tab, resource: resource.id, host };
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); viewport.flush();
        const defaults = viewport.currentLineHighlight(), point = viewport.coordsAt(1), row = host.querySelector('.st-viewport-row[data-line="0"]')!, child = row.firstChild;
        const extent = [viewport.element.scrollWidth, viewport.element.scrollHeight]; viewport.configureCurrentLineHighlight(true); viewport.flush();
        const enabled = viewport.currentLineHighlight(), background = host.querySelector<HTMLElement>(".st-current-line-background")!;
        let invalid = false; try { viewport.configureCurrentLineHighlight("yes" as unknown as boolean); } catch { invalid = true; }
        viewport.configureCurrentLineHighlight(true);
        return { defaults, enabled, invalid, noOpPending: viewport.activity().pending, samePoint: JSON.stringify(point) === JSON.stringify(viewport.coordsAt(1)),
            sameChild: row.firstChild === child, className: row.className, background: getComputedStyle(row).backgroundColor, color: getComputedStyle(child as HTMLElement).color,
            width: background.getBoundingClientRect().width, viewportWidth: viewport.element.clientWidth, extent,
            nextExtent: [viewport.element.scrollWidth, viewport.element.scrollHeight] };
    });
    expect(initial).toMatchObject({ defaults: false, enabled: true, invalid: true, noOpPending: false, samePoint: true, sameChild: true,
        className: "st-viewport-row host-row st-current-line", background: "rgb(30, 45, 65)", color: "rgb(180, 60, 160)" });
    expect(initial.extent).toEqual(initial.nextExtent); expect(initial.width).toBe(initial.viewportWidth);
    const source = page.getByRole("textbox", { name: "Line source", exact: true }), current = page.locator(".st-viewport-layer .st-current-line");
    await source.press("Control+Home"); await source.press("ArrowDown"); await expect(current).toHaveAttribute("data-line", "1");
    await source.press("Enter"); await expect(current).toHaveAttribute("data-line", "2");
    await source.press("Control+z"); await expect(current).toHaveAttribute("data-line", "1");
    const projected = await page.evaluate(() => {
        const f = window.presentationFixture, viewport = f.editor.viewport, doc = f.workspace.document(f.editor.view.documentId);
        f.editor.view.setSelections(doc.revision, [{ anchor: 0, head: 2 }, { anchor: 10, head: 10 }], 1); viewport.flush();
        const primary = f.host.querySelector(".st-viewport-layer .st-current-line")?.getAttribute("data-line");
        f.editor.view.setSelections(doc.revision, [{ anchor: 0, head: 2 }, { anchor: 10, head: 10 }], 0); viewport.flush();
        const rangeHidden = !f.host.querySelector(".st-current-line-background"), selected = f.host.querySelector<HTMLElement>(".st-viewport-selected")!;
        const selectedColor = getComputedStyle(selected).backgroundColor;
        f.editor.view.setSelection(doc.revision, { anchor: 6, head: 6 });
        f.editor.view.folding.setRanges(f.editor.view.folding.getSnapshot(), [{ id: "block", from: 0, to: doc.buffer.offsetAt(3), collapsed: true }]); viewport.flush();
        const header = f.host.querySelector(".st-viewport-layer .st-current-line")?.getAttribute("data-line"), head = f.editor.view.getSnapshot().selection.head;
        const rect = f.host.querySelector(".st-current-line-background")!.getBoundingClientRect(), row = f.host.querySelector('.st-viewport-row[data-line="0"]')!.getBoundingClientRect();
        return { primary, rangeHidden, selectedColor, header, head, foldedTop: rect.top, rowTop: row.top };
    });
    expect(projected).toMatchObject({ primary: "2", rangeHidden: true, selectedColor: "rgb(36, 73, 107)", header: "0", head: 6 });
    expect(projected.foldedTop).toBe(projected.rowTop);

    await page.evaluate(async () => {
        const f = window.presentationFixture, path = "/presentation-fixture/";
        const { TextBuffer } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextComparison } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        f.editor.destroy(); f.host.style.height = "500px";
        f.comparison = mountTextComparison(f.host, f.workspace, f.tab, { buffer: TextBuffer.from("extra\nHEAD\nbody\nmore\nend\n"), version: "one" }, { rowsAligned: true });
    });
    await page.waitForFunction(() => { const c = window.presentationFixture.comparison!;
        return c.controller.getSnapshot().status === "ready" && c.snapshot().rowsAligned && !c.working.viewport.activity().pending && !c.referenceViewport()?.activity().pending; });
    const aligned = await page.evaluate(() => {
        const f = window.presentationFixture, c = f.comparison!, working = c.working, reference = c.referenceEditor()!;
        const current = (editor: EditingCandidate) => editor.element.querySelector(".st-viewport-layer .st-current-line");
        working.viewport.configureCurrentLineHighlight(true); working.viewport.flush();
        const workingClass = current(working)!.className, referenceDefault = reference.viewport.currentLineHighlight();
        reference.viewport.configureCurrentLineHighlight(true); reference.view.setSelection(f.workspace.document(reference.view.documentId).revision, { anchor: 7, head: 7 }); reference.viewport.flush();
        const referenceClass = current(reference)!.className;
        working.view.setSelection(f.workspace.document(working.view.documentId).revision, { anchor: 6, head: 6 }); working.viewport.flush();
        const row = current(working)!, backdrop = working.element.querySelector(".st-current-line-background")!, background = backdrop.getBoundingClientRect();
        const result = { workingClass, referenceDefault, referenceClass, referenceReadOnly: reference.input.readOnly, padding: working.viewport.snapshot().paddingRows,
            line: row.getAttribute("data-line"), visual: working.viewport.visualRowAt(1), topError: Math.abs(background.top - row.getBoundingClientRect().top),
            height: background.height, lineHeight: working.viewport.snapshot().lineHeight,
            edges: getComputedStyle(backdrop).boxShadow, fill: getComputedStyle(backdrop, "::before").backgroundColor };
        working.viewport.configureCurrentLineHighlight(false); working.viewport.flush();
        return { ...result, disabled: !current(working), referenceRetained: current(reference)?.getAttribute("data-line") };
    });
    expect(aligned.workingClass).toContain("st-comparison-line-working"); expect(aligned.workingClass).toContain("st-current-line");
    expect(aligned.referenceClass).toContain("st-comparison-line-baseline"); expect(aligned.referenceClass).toContain("st-current-line");
    expect(aligned).toMatchObject({ referenceDefault: false, referenceReadOnly: true, line: "1", disabled: true, referenceRetained: "1" });
    expect(aligned.padding).toBeGreaterThan(0); expect(aligned.visual).toBeGreaterThan(1); expect(aligned.topError).toBeLessThan(.1);
    expect(Math.abs(aligned.height - aligned.lineHeight)).toBeLessThan(.1);
    expect(aligned.edges).toContain("inset"); expect(aligned.fill).not.toBe("rgba(0, 0, 0, 0)");
    await info.attach("current-line-review", { body: await page.screenshot(), contentType: "image/png" });
    const end = await page.evaluate(() => { const f = window.presentationFixture, c = f.comparison!, reference = c.referenceViewport()!;
        c.destroy(); f.workspace.close(f.tab); f.workspace.releaseResource(f.resource, true);
        return { configured: reference.configureCurrentLineHighlight(true), enabled: reference.currentLineHighlight(), children: f.host.childNodes.length,
            views: f.workspace.diagnostics().views, subscriptions: f.workspace.diagnostics().subscriptions }; });
    expect(end).toEqual({ configured: false, enabled: false, children: 0, views: 0, subscriptions: 0 });
    await info.attach("current-line-geometry", { body: JSON.stringify({ initial, projected, aligned, end }), contentType: "application/json" });
});
