import { test, expect } from "./fixtures.ts";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Workspace, ResourceId, TabId } from "../../src/index.ts";
import type { TextEditor, TextComparison } from "../../src/browser/index.ts";
import { fontFixture } from "../fixtures/consumer/font-fixture.ts";

type Fixture = { workspace: Workspace; editor: TextEditor; host: HTMLElement; tab: TabId; resource: ResourceId; comparison?: TextComparison };
declare global { interface Window { presentationFixture: Fixture } }

let modules: Map<string, string>, css: string;
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });
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

test.describe("scrolling beyond the last line", () => {
    test("trailing space follows visible rows and scaled extents while editing keeps the visible caret stable", async ({ page }, info) => {
        const initial = await page.evaluate(async () => {
            const path = "/presentation-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
            const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
            const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "trailing-space", variant: "text" }, "Trailing space", { value: "head\nbody\nend" });
            const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "trailing-space"), host = document.createElement("section");
            host.style.cssText = "height:240.4px;width:600.4px;zoom:1.25"; document.body.append(host);
            try { mountTextEditor(host, workspace, tab, { scrollBeyondLastLine: 1 as unknown as boolean }); throw new Error("Invalid scroll option accepted."); }
            catch (error) { if (!(error instanceof TypeError)) throw error; }
            if (host.childNodes.length || workspace.diagnostics().views) throw new Error("Invalid scroll mount leaked ownership.");
            const editor = mountTextEditor(host, workspace, tab, { ariaLabel: "Trailing source" }), viewport = editor.viewport;
            window.presentationFixture = { workspace, editor, host, tab, resource: resource.id };
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); viewport.flush();
            const defaults = viewport.scrollBeyondLastLine(), ordinary = viewport.snapshot(), selection = editor.view.getSnapshot().selectionSet;
            viewport.configureScrollBeyondLastLine(true); viewport.flush();
            const preserved = viewport.snapshot().scrollTop === ordinary.scrollTop, enabled = viewport.snapshot();
            viewport.scrollTo({ top: 1e12 }); viewport.flush(); const end = viewport.snapshot(), last = host.querySelector('.st-viewport-row[data-line="2"]')!.getBoundingClientRect();
            const layer = host.querySelector(".st-viewport-layer")!.getBoundingClientRect();
            viewport.configureScrollBeyondLastLine(false); viewport.flush();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); viewport.flush(); const restored = viewport.snapshot();
            let invalid = false; try { viewport.configureScrollBeyondLastLine(null as unknown as boolean); } catch (error) { invalid = error instanceof TypeError; }
            const renders = restored.renders; viewport.configureScrollBeyondLastLine(false); viewport.flush();
            return { defaults, ordinary, enabled, end, topError: Math.abs((last.top - layer.top) / 1.25 - 12), preserved, invalid,
                restored, sameSelection: selection === editor.view.getSnapshot().selectionSet, noOpRenders: viewport.snapshot().renders - renders, pending: viewport.activity().pending };
        });
        expect(initial).toMatchObject({ defaults: false, preserved: true, invalid: true, sameSelection: true, noOpRenders: 0, pending: false });
        expect(initial.ordinary.verticalExtent).toBeCloseTo(3 * initial.ordinary.lineHeight + 24, 5);
        expect(initial.enabled.verticalExtent).toBeCloseTo(2 * initial.enabled.lineHeight + initial.enabled.height, 5);
        expect(initial.end.scrollTop).toBeCloseTo(2 * initial.end.lineHeight, 5); expect(initial.topError).toBeLessThan(.05);
        expect(initial.restored.verticalExtent).toBe(initial.ordinary.verticalExtent); expect(initial.restored.scrollTop).toBe(0);

        const scaled = await page.evaluate(async () => {
            const f = window.presentationFixture, viewport = f.editor.viewport, doc = f.workspace.document(f.editor.view.documentId);
            f.workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, origin: "host", edits: [{ from: 0, to: doc.buffer.length, insert: "x\n".repeat(110000) + "end" }] });
            viewport.element.style.fontSize = "20px"; viewport.element.style.lineHeight = "2"; f.host.style.height = "300.4px";
            viewport.configureScrollBeyondLastLine(true); viewport.flush();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); viewport.flush();
            // Drive the native scrollbar to its physical end, then let its scroll event map back.
            viewport.element.scrollTop = viewport.element.scrollHeight;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); viewport.flush();
            const s = viewport.snapshot();
            const current = f.workspace.document(doc.id), end = current.buffer.length;
            f.editor.view.setSelection(current.revision, { anchor: end, head: end }); viewport.flush();
            const caret = viewport.coordsAt(end)!, layer = f.host.querySelector(".st-viewport-layer")!.getBoundingClientRect();
            const below = viewport.hitTest(caret.left, layer.bottom - 20);
            return { s, topError: Math.abs((viewport.rowBounds(110000)!.top - layer.top) / 1.25 - 12), hit: below?.offset, end,
                horizontalOverflow: viewport.element.scrollWidth - viewport.element.clientWidth, exports: current.buffer.readMetrics().textExports };
        });
        expect(scaled.s.verticalExtent).toBeGreaterThan(4_000_000); expect(scaled.s.physicalHeight).toBe(4_000_000);
        expect(scaled.s.rows).toBeLessThan(16); expect(scaled.s.textUnits).toBeLessThan(40); expect(scaled.topError).toBeLessThan(1.01);
        expect(scaled.hit).toBe(scaled.end); expect(scaled.horizontalOverflow).toBe(0); expect(scaled.exports).toBe(0);
        const source = page.getByRole("textbox", { name: "Trailing source", exact: true });
        const before = await page.evaluate(() => window.presentationFixture.editor.viewport.snapshot().scrollTop);
        await source.press("A"); await expect(page.locator('.st-viewport-layer .st-viewport-row[data-line="110000"]')).toHaveText("endA");
        expect(await page.evaluate(() => window.presentationFixture.editor.viewport.snapshot().scrollTop)).toBeCloseTo(before, 4);
        await source.press("Control+z"); await expect(page.locator('.st-viewport-layer .st-viewport-row[data-line="110000"]')).toHaveText("end");
        expect(await page.evaluate(() => window.presentationFixture.editor.viewport.snapshot().scrollTop)).toBeCloseTo(before, 4);
        await info.attach("trailing-space", { body: await page.screenshot(), contentType: "image/png" });
        const folded = await page.evaluate(() => {
            const f = window.presentationFixture, viewport = f.editor.viewport, doc = f.workspace.document(f.editor.view.documentId);
            f.editor.view.folding.setRanges(f.editor.view.folding.getSnapshot(), [{ id: "body", from: 0, to: doc.buffer.offsetAt(110000), collapsed: true }]); viewport.flush();
            viewport.scrollTo({ top: 1e12 }); viewport.flush(); const s = viewport.snapshot();
            viewport.configureScrollBeyondLastLine(false); viewport.flush(); const clamped = viewport.snapshot().scrollTop;
            f.editor.destroy(); return { s, clamped, rejected: !viewport.configureScrollBeyondLastLine(true), reset: !viewport.scrollBeyondLastLine(), nodes: f.host.childNodes.length, views: f.workspace.diagnostics().views };
        });
        expect(folded.s.visibleLines).toBe(2); expect(folded.s.scrollTop).toBeCloseTo(folded.s.lineHeight, 5);
        expect(folded).toMatchObject({ clamped: 0, rejected: true, reset: true, nodes: 0, views: 0 });
        await info.attach("trailing-space-geometry", { body: JSON.stringify({ initial, scaled, folded }), contentType: "application/json" });
    });

    test("aligned review applies trailing space independently against the shared visual grid", async ({ page }) => {
        await page.evaluate(async () => {
            const path = "/presentation-fixture/", { Workspace, TextBuffer } = await import(path + "core.js") as typeof import("../../src/index.ts");
            const { mountTextComparison } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
            const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "aligned-trailing", variant: "text" }, "Working", { value: "a\nb\nc" });
            const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "review"), host = document.createElement("section");
            host.style.cssText = "height:500px;width:800px"; document.body.append(host);
            const comparison = mountTextComparison(host, workspace, tab, { buffer: TextBuffer.from("extra\na\nb\nc"), version: "one" }, { rowsAligned: true });
            window.presentationFixture = { workspace, resource: resource.id, host, tab, comparison, editor: comparison.working };
        });
        await page.waitForFunction(() => { const c = window.presentationFixture.comparison!;
            return c.controller.getSnapshot().status === "ready" && c.snapshot().rowsAligned && !c.working.viewport.activity().pending && !c.referenceViewport()?.activity().pending; });
        const result = await page.evaluate(() => {
            const f = window.presentationFixture, c = f.comparison!, working = c.working.viewport, reference = c.referenceViewport()!;
            working.configureScrollBeyondLastLine(true); working.scrollTo({ top: 1e12 }); working.flush();
            const independent = !reference.scrollBeyondLastLine(), grid = working.snapshot();
            reference.configureScrollBeyondLastLine(true); reference.scrollTo({ top: 1e12 }); reference.flush();
            const top = (viewport: typeof working, line: number) => viewport.rowBounds(line)!.top - viewport.element.querySelector(".st-viewport-layer")!.getBoundingClientRect().top;
            const workingTop = top(working, 2), referenceTop = top(reference, 3), rows = reference.snapshot().visualRows;
            working.configureScrollBeyondLastLine(false); working.flush();
            const clamped = working.snapshot().scrollTop, retained = reference.scrollBeyondLastLine(); c.destroy();
            return { independent, grid, rows, workingTop, referenceTop, clamped, retained, views: f.workspace.diagnostics().views };
        });
        expect(result).toMatchObject({ independent: true, rows: 4, clamped: 0, retained: true, views: 0 });
        expect(result.grid.visualRows).toBe(4); expect(result.grid.scrollTop).toBeCloseTo(3 * result.grid.lineHeight, 5);
        expect(result.workingTop).toBeCloseTo(12, 1); expect(result.referenceTop).toBeCloseTo(12, 1);
    });

    test("empty and single-row documents stay stable in fractional classic-scrollbar viewports", async ({ page }) => {
        const result = await page.evaluate(async () => {
            const path = "/presentation-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
            const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
            const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "empty-trailing", variant: "text" }, "Empty", { value: "" });
            const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "empty"), host = document.createElement("section");
            host.style.cssText = "height:240.6px;width:600.6px;zoom:1.25"; document.body.append(host);
            const editor = mountTextEditor(host, workspace, tab, { scrollBeyondLastLine: true }), viewport = editor.viewport;
            const samples: { width: number; height: number; overflow: boolean; extent: number; lineHeight: number }[] = [];
            for (const value of ["", "single"]) {
                const doc = workspace.document(resource.documentId);
                if (value) workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, origin: "host", edits: [{ from: 0, to: 0, insert: value }] });
                for (let i = 0; i < 12; i++) {
                    await new Promise(resolve => requestAnimationFrame(resolve)); viewport.flush(); const s = viewport.snapshot(), root = viewport.element;
                    samples.push({ width: root.clientWidth, height: root.clientHeight, overflow: root.scrollWidth > root.clientWidth || root.scrollHeight > root.clientHeight, extent: s.verticalExtent, lineHeight: s.lineHeight });
                }
            }
            const enabled = viewport.scrollBeyondLastLine(); editor.destroy(); return { samples, enabled, nodes: host.childNodes.length, views: workspace.diagnostics().views };
        });
        expect(result).toMatchObject({ enabled: true, nodes: 0, views: 0 });
        expect(result.samples.every(sample => !sample.overflow && sample.extent === sample.lineHeight + 24)).toBe(true);
        expect(new Set(result.samples.map(sample => `${sample.width}:${sample.height}`)).size).toBe(1);
    });
});

test("ligature policy changes native shaping while preserving caret, selection, input and ownership", async ({ page }, info) => {
    const initial = await page.evaluate(async bytes => {
        const path = "/presentation-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const face = new FontFace("StLigatureFixture", new Uint8Array(bytes)); await face.load(); document.fonts.add(face);
        const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "ligatures", variant: "text" }, "Ligatures", { value: "fi AB\nfi" });
        const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "ligatures"), host = document.createElement("section");
        host.style.cssText = "height:240px;width:600px;--st-font:StLigatureFixture;--st-font-size:40px"; document.body.append(host);
        try { mountTextEditor(host, workspace, tab, { fontLigatures: "normal" as unknown as boolean }); throw new Error("Invalid ligatures accepted."); }
        catch (error) { if (!(error instanceof TypeError)) throw error; }
        if (host.childNodes.length || workspace.diagnostics().views) throw new Error("Invalid ligature mount leaked ownership.");
        const editor = mountTextEditor(host, workspace, tab, { ariaLabel: "Ligature source" }), viewport = editor.viewport;
        window.presentationFixture = { workspace, editor, host, tab, resource: resource.id };
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); viewport.flush();
        const selection = editor.view.getSnapshot().selectionSet, child = host.querySelector('.st-viewport-row[data-line="0"]')!.firstChild!;
        const sample = () => {
            viewport.flush(); const row = host.querySelector('.st-viewport-row[data-line="0"]')!, range = document.createRange();
            range.setStart(row.firstChild!, 0); range.setEnd(row.firstChild!, 2); const width = range.getBoundingClientRect().width;
            const points = [0, 1, 2].map(offset => {
                range.setStart(row.firstChild!, offset); range.collapse(true); const native = range.getClientRects()[0]!, point = viewport.coordsAt(offset)!;
                return { offset, left: point.left, error: Math.abs(point.left - native.left), hit: viewport.hitTest(point.left, point.top + point.height / 2)?.offset };
            });
            return { enabled: viewport.fontLigatures(), css: getComputedStyle(row).fontVariantLigatures, width, points };
        };
        const off = sample(); viewport.configureFontLigatures(true); const on = sample();
        viewport.configureFontLigatures(false); const restored = sample(); viewport.configureFontLigatures(true); const again = sample();
        const observer = new MutationObserver(() => {}); observer.observe(viewport.element, { subtree: true, childList: true, attributes: true });
        const renders = viewport.snapshot().renders; viewport.configureFontLigatures(true); viewport.flush();
        const noOp = { mutations: observer.takeRecords().length, renders: viewport.snapshot().renders - renders, pending: viewport.activity().pending }; observer.disconnect();
        let invalid = false; try { viewport.configureFontLigatures(null as unknown as boolean); } catch (error) { invalid = error instanceof TypeError; }
        return { off, on, restored, again, noOp, invalid, enabled: viewport.fontLigatures(), sameChild: child === host.querySelector('.st-viewport-row[data-line="0"]')!.firstChild,
            sameSelection: selection === editor.view.getSnapshot().selectionSet, revision: workspace.document(resource.documentId).revision };
    }, Array.from(fontFixture({ ligatures: true })));
    expect(initial).toMatchObject({ invalid: true, enabled: true, sameChild: true, sameSelection: true, revision: 0,
        noOp: { mutations: 0, renders: 0, pending: false }, off: { enabled: false, css: "none" }, on: { enabled: true, css: "normal" } });
    expect(initial.off.width).toBeCloseTo(24, 1); expect(initial.on.width).toBeCloseTo(20, 1);
    expect(initial.restored).toEqual(initial.off); expect(initial.again).toEqual(initial.on);
    for (const sample of [initial.off, initial.on]) {
        expect(sample.points.map(point => point.hit)).toEqual([0, 1, 2]);
        expect(sample.points[1]!.left).toBeGreaterThan(sample.points[0]!.left);
        expect(sample.points[1]!.left).toBeLessThan(sample.points[2]!.left);
        for (const point of sample.points) expect(point.error).toBeLessThan(1.01);
    }
    expect(initial.on.points[1]!.left).not.toBe(initial.off.points[1]!.left);
    const source = page.getByRole("textbox", { name: "Ligature source", exact: true });
    await source.press("Control+Home"); await source.press("ArrowRight");
    expect(await page.evaluate(() => window.presentationFixture.editor.view.getSnapshot().selection.head)).toBe(1);
    await source.press("A"); await expect(page.locator('.st-viewport-layer .st-viewport-row[data-line="0"]')).toHaveText("fAi AB");
    await source.press("Control+z"); await expect(page.locator('.st-viewport-layer .st-viewport-row[data-line="0"]')).toHaveText("fi AB");
    await source.press("Shift+ArrowRight");
    expect(await page.evaluate(() => window.presentationFixture.editor.view.getSnapshot().selection)).toMatchObject({ anchor: 1, head: 2 });
    await source.press("Backspace"); await expect(page.locator('.st-viewport-layer .st-viewport-row[data-line="0"]')).toHaveText("f AB");
    await source.press("Control+z"); await expect(page.locator('.st-viewport-layer .st-viewport-row[data-line="0"]')).toHaveText("fi AB");
    const selected = await page.evaluate(() => {
        const { editor, workspace, host } = window.presentationFixture, viewport = editor.viewport;
        editor.view.setSelection(workspace.document(editor.view.documentId).revision, { anchor: 0, head: 2 }); viewport.flush();
        const row = host.querySelector('.st-viewport-row[data-line="0"]')!, range = document.createRange(); range.selectNodeContents(row.firstChild!);
        const width = range.getBoundingClientRect().width, points = [0, 1, 2].map(offset => viewport.coordsAt(offset)!);
        return { width, text: row.firstChild!.textContent, hits: points.map(point => viewport.hitTest(point.left, point.top + point.height / 2)?.offset) };
    });
    expect(selected).toMatchObject({ text: "fi", hits: [0, 1, 2] }); expect(selected.width).toBeCloseTo(20, 1);
    await info.attach("ligature-selection", { body: await page.screenshot(), contentType: "image/png" });
    const disposed = await page.evaluate(async () => {
        const f = window.presentationFixture, viewport = f.editor.viewport;
        f.editor.destroy(); const disabled = !viewport.fontLigatures(), rejected = !viewport.configureFontLigatures(true);
        const path = "/presentation-fixture/", { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const second = mountTextEditor(f.host, f.workspace, f.tab, { fontLigatures: true }); second.viewport.flush();
        const mounted = second.viewport.fontLigatures(), css = getComputedStyle(second.element).fontVariantLigatures; second.destroy();
        return { disabled, rejected, mounted, css, nodes: f.host.childNodes.length, views: f.workspace.diagnostics().views };
    });
    expect(disposed).toEqual({ disabled: true, rejected: true, mounted: true, css: "normal", nodes: 0, views: 0 });
});

test("column rulers follow measured scroll/font/zoom without changing source geometry, extent or ownership", async ({ page }, info) => {
    const initial = await page.evaluate(async () => {
        const path = "/presentation-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "rulers", variant: "text" }, "Rulers", { value: ("x".repeat(200) + "\n").repeat(1000) });
        const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "rulers"), host = document.createElement("section");
        host.style.cssText = "height:240px;width:600px"; document.body.append(host);
        for (const columns of [[0], [-1], [1.5], [Infinity], [NaN], [Number.MAX_SAFE_INTEGER + 1], Array(1), Array(129).fill(80)]) {
            const before = workspace.diagnostics().views;
            try { mountTextEditor(host, workspace, tab, { columnRulers: columns }); throw new Error("Invalid rulers accepted."); }
            catch (error) { if (!(error instanceof RangeError)) throw error; }
            if (workspace.diagnostics().views !== before || host.childNodes.length) throw new Error("Invalid mount leaked ownership.");
        }
        const editor = mountTextEditor(host, workspace, tab, { ariaLabel: "Ruler source" }), viewport = editor.viewport;
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
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "current-line", variant: "text" }, "Current line", { value: "head\nbody\nmore\nend\n" });
        const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "current-line"), host = document.createElement("section"), style = document.createElement("style");
        host.style.cssText = "height:400px;width:800px;--st-current-line:#ffffff18";
        style.textContent = ".host-row { background: rgb(30, 45, 65) } .host-color { color: rgb(180, 60, 160) }"; document.body.append(style, host);
        try { mountTextEditor(host, workspace, tab, { highlightCurrentLine: "yes" as unknown as boolean }); throw new Error("Invalid current-line option accepted."); }
        catch (error) { if (!(error instanceof TypeError)) throw error; }
        if (host.childNodes.length || workspace.diagnostics().views) throw new Error("Invalid highlight mount leaked ownership.");
        const editor = mountTextEditor(host, workspace, tab, { ariaLabel: "Line source", lineClass: () => "host-row",
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
        const current = (editor: TextEditor) => editor.element.querySelector(".st-viewport-layer .st-current-line");
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
