import { test, expect } from "./fixtures.ts";
import { build } from "esbuild";
import { basename } from "node:path";

test("viewport skips unchanged row work while consuming scheduled notifications and painting changed captures", async ({ page }, testInfo) => {
    const built = await build({ entryPoints: { core: "src/index.ts", viewport: "src/browser/viewport.ts", rows: "src/core/comparison-rows.ts" }, outdir: "artifacts/viewport-paint",
        bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", write: false });
    const modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text]));
    await page.route("**/viewport-paint/**", route => {
        const body = modules.get(new URL(route.request().url()).pathname.split("/").at(-1)!);
        return body === undefined ? route.abort() : route.fulfill({ contentType: "text/javascript", body });
    });
    await page.goto("/viewport/");
    const result = await page.evaluate(async () => {
        const path = "/viewport-paint/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountViewport } = await import(path + "viewport.js") as typeof import("../../src/browser/viewport.ts");
        const { ComparisonRowsCursor } = await import(path + "rows.js") as typeof import("../../src/core/comparison-rows.ts");
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "test", resource: "paint-captures", variant: "text" }, "Paint", { value: "const sample = 123;\r\n".repeat(100000) });
        const tab = workspace.tabs.open({ kind: "text", documentId: source.documentId }, "paint"), host = document.createElement("section");
        host.style.cssText = "height:220px;width:800px;position:fixed;top:0;left:0"; document.body.append(host);
        let calls = 0, notices = 0, shade = "paint-a";
        const { viewport, setComparisonRows } = mountViewport(host, workspace, tab);
        let lastGeometry = viewport.getSnapshot(), geometryChanges = 0;
        const stopGeometry = viewport.subscribe(() => { lastGeometry = viewport.getSnapshot(); geometryChanges++; });
        viewport.decorations.addProvider({ name: "syntax", order: 0, provide: line => { calls++; return [{ from: line.from, to: line.to, className: shade }]; } });
        viewport.onRender(() => notices++);
        const input = viewport.bindInput(() => {});
        const observer = new MutationObserver(() => {}); observer.observe(viewport.element, { subtree: true, childList: true, attributes: true, characterData: true });
        const documentState = () => workspace.document(source.documentId);
        const settle = () => { for (let i = 0; i < 8; i++) { viewport.flush(); if (!viewport.activity().pending) return; } throw new Error("Viewport did not settle."); };
        const work = (name: string, change: () => void = () => {}, count = 1) => {
            change(); observer.takeRecords();
            const before = viewport.getDiagnostics(), buffer = documentState().buffer, read = buffer.readMetrics().sliceUnits, decorated = calls, notified = notices;
            for (let i = 0; i < count; i++) viewport.flush();
            return { name, renders: viewport.getDiagnostics().renders - before.renders, read: buffer.readMetrics().sliceUnits - read,
                decorated: calls - decorated, mutations: observer.takeRecords().length, notices: notices - notified, pending: viewport.activity().pending };
        };
        try {
            viewport.revealOffset(documentState().buffer.offsetAt(50000)); settle();
            const middle = viewport.getDiagnostics(), row = host.querySelector<HTMLElement>('.st-viewport-row[data-line="50000"]')!, child = row.firstChild;
            const geometry = lastGeometry, middleChanges = geometryChanges;
            const topEdge = viewport.element.getBoundingClientRect().top + viewport.element.clientTop;
            const onScreen = [...host.querySelectorAll<HTMLElement>(".st-viewport-row[data-line]")].filter(node => {
                const rect = node.getBoundingClientRect(); return rect.bottom > topEdge && rect.top < topEdge + viewport.element.clientHeight;
            }).map(node => Number(node.dataset.line));
            const exactBounds = geometry.lineFrom === Math.min(...onScreen) && geometry.lineTo === Math.max(...onScreen) + 1;
            const idle = work("20 idle flushes", undefined, 20);
            const queued = work("scheduled unchanged scroll", () => viewport.scrollTo({ top: middle.scrollTop, left: middle.scrollLeft }));
            const preserved = row.firstChild === child;
            const changes = [];
            const from = documentState().buffer.offsetAt(50000);
            changes.push(work("selection", () => viewport.view.setSelection(0, { anchor: from, head: from + 5 })));
            const selected = row.querySelector(".st-viewport-selected")?.textContent;
            const stableGeometry = lastGeometry === geometry && geometryChanges === middleChanges && Object.isFrozen(geometry);
            const afterSelection = work("idle after selection");
            changes.push(work("revision", () => workspace.edit({ documentId: source.documentId, expectedRevision: 0, edits: [{ from, to: from, insert: "//" }], origin: "host" })));
            const revision = viewport.activity().revision, text = row.textContent;
            changes.push(work("decorations", () => { shade = "paint-b"; viewport.invalidate(); }));
            const decorated = row.querySelector(".paint-b") !== null;
            changes.push(work("folds", () => { const buffer = documentState().buffer;
                viewport.view.folding.setRanges(viewport.view.folding.getSnapshot(), [{ id: "fold", from: buffer.offsetAt(50000), to: buffer.offsetAt(50004), collapsed: true }]); }));
            const folded = viewport.getDiagnostics().collapsedFolds, folds = viewport.view.folding.getSnapshot(), buffer = documentState().buffer;
            const cursor = new ComparisonRowsCursor(buffer, buffer, Object.freeze([]), folds.index, folds.index); let aligned = cursor.next(4096);
            while (!aligned.result) aligned = cursor.next(4096); cursor.dispose();
            changes.push(work("comparison rows", () => { setComparisonRows({ documentId: source.documentId, revision: 1, foldGeneration: folds.generation,
                id: 1, lineHeight: middle.lineHeight + 4, index: aligned.result!.working }); }));
            const alignment = viewport.activity().alignmentId;
            changes.push(work("clear comparison", () => { setComparisonRows(undefined); }));
            changes.push(work("synchronous font", () => { viewport.element.style.fontSize = "18px"; }));
            const wider = viewport.getSnapshot().columnWidth > middle.columnWidth;
            changes.push(work("synchronous resize", () => { host.style.width = "450px"; host.style.height = "150px"; }));
            const size = viewport.getSnapshot();
            const resized = size.width + size.gutterWidth === viewport.element.clientWidth && size.height === viewport.element.clientHeight;
            const resizePublished = lastGeometry === size && geometryChanges > middleChanges;
            changes.push(work("zoom", () => { host.style.zoom = "1.25"; }));
            changes.push(work("font completion", () => document.fonts.dispatchEvent(new Event("loadingdone"))));
            viewport.revealOffset(buffer.offsetAt(50000)); settle();
            changes.push(work("composition controls", () => { input.setComposing(true); }));
            const disabledFold = host.querySelector<HTMLButtonElement>(".st-fold-button")!.disabled;
            changes.push(work("scroll", () => viewport.scrollTo({ top: viewport.getSnapshot().scrollTop + 100 })));
            const initialExports = buffer.readMetrics().textExports;
            workspace.edit({ documentId: source.documentId, expectedRevision: 1, edits: [{ from: 0, to: buffer.length, insert: "\t".repeat(100) }], origin: "host" });
            viewport.scrollTo({ top: 0, left: 0 }); viewport.flush();
            const correcting = viewport.activity().pending, beforeCorrection = viewport.getDiagnostics().renders;
            settle(); const corrected = viewport.getDiagnostics(), measured = host.querySelector<HTMLElement>(".st-viewport-row")!.getBoundingClientRect().width / 1.25;
            const idleAfterCorrection = work("idle after width correction");
            workspace.edit({ documentId: source.documentId, expectedRevision: 2, edits: [{ from: 0, to: 100, insert: "\t".repeat(4096) }], origin: "host" });
            viewport.revealOffset(2048); settle(); const capture = viewport.captureView(), point = viewport.coordsAt(2048)!;
            const partialIdle = work("idle after partial reveal");
            changes.push(work("clear partial placement", () => viewport.scrollTo({ top: capture.scrollTop, left: capture.scrollLeft })));
            changes.push(work("restore partial anchor", () => viewport.restoreView(capture))); settle();
            const restored = viewport.coordsAt(2048)!;
            stopGeometry(); const stopped = geometryChanges; viewport.scrollTo({ left: 0 }); viewport.flush(); viewport.dispose();
            const released = viewport.getSnapshot().lineTo === 0 && geometryChanges === stopped;
            return { idle, queued, afterSelection, preserved, selected, changes, revision, text, decorated, folded, alignment, wider, resized, disabledFold,
                exactBounds, stableGeometry, resizePublished, released,
                correcting, correctionPaints: corrected.renders - beforeCorrection, extentError: Math.abs(corrected.horizontalExtent - measured - 24),
                idleAfterCorrection, partialIdle, partialAnchor: capture.horizontalAnchor !== undefined, restoredError: Math.abs(point.left - restored.left),
                initialExports, exports: documentState().buffer.readMetrics().textExports };
        } finally { observer.disconnect(); viewport.dispose(); workspace.tabs.close(tab); workspace.releaseResource(source.id, true); host.remove(); }
    });
    await testInfo.attach("paint-work", { body: JSON.stringify(result), contentType: "application/json" });
    for (const work of [result.idle, result.afterSelection, result.idleAfterCorrection, result.partialIdle])
        expect(work, work.name).toMatchObject({ renders: 0, read: 0, decorated: 0, mutations: 0, notices: 0, pending: false });
    expect(result.queued).toMatchObject({ renders: 0, read: 0, decorated: 0, mutations: 0, notices: 1, pending: false });
    for (const work of result.changes) { expect(work.renders, work.name).toBeGreaterThan(0); expect(work.decorated, work.name).toBeGreaterThan(0); }
    expect(result).toMatchObject({ preserved: true, selected: "const", revision: 1, text: "//const sample = 123;", decorated: true,
        folded: 1, alignment: 1, wider: true, resized: true, disabledFold: true, correcting: true, partialAnchor: true, initialExports: 0, exports: 0,
        exactBounds: true, stableGeometry: true, resizePublished: true, released: true });
    expect(result.correctionPaints).toBeGreaterThan(0); expect(result.extentError).toBeLessThan(.1); expect(result.restoredError).toBeLessThan(1.5);
});
