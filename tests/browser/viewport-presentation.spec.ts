import { test, expect } from "./fixtures.ts";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Workspace, ResourceId, TabId } from "../../src/index.ts";
import type { EditingCandidate } from "../../src/browser/index.ts";

type Fixture = { workspace: Workspace; editor: EditingCandidate; host: HTMLElement; tab: TabId; resource: ResourceId };
declare global { interface Window { presentationFixture: Fixture } }

test("column rulers follow measured scroll/font/zoom without changing source geometry, extent or ownership", async ({ page }, info) => {
    const built = await build({ entryPoints: { core: "src/index.ts", browser: "src/browser/index.ts" }, outdir: "artifacts/presentation-fixture",
        bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", write: false });
    const modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text])), css = await readFile("src/browser/editor.css", "utf8");
    await page.route("**/presentation-fixture/**", route => {
        const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
        return route.fulfill({ contentType: name === "" ? "text/html" : "text/javascript", body: name === "" ? "<!doctype html>" : modules.get(name)! });
    });
    await page.goto("/presentation-fixture/");
    const initial = await page.evaluate(async css => {
        const path = "/presentation-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountEditingCandidate } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const style = document.createElement("style"); style.textContent = css; document.head.append(style);
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
    }, css);
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
