import { test, expect } from "./fixtures.ts";
import { viewportModules } from "../helpers/fixture-modules.ts";

test("viewport retains valid native geometry and expires changed captures without stale caret positions", async ({ page }, testInfo) => {
    await viewportModules(page, "/viewport-geometry/");
    await page.goto("/viewport/");
    const result = await page.evaluate(async () => {
        const path = "/viewport-geometry/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextViewport } = await import(path + "viewport.js") as typeof import("../../src/browser/viewport.ts");
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "test", resource: "geometry", variant: "text" }, "Geometry", { value: ("x".repeat(500) + "\r\n").repeat(60) });
        const host = document.createElement("section"), style = document.createElement("style");
        host.style.cssText = "height:220px;width:800px;position:fixed;top:0;left:0"; document.body.append(host, style);
        const viewport = mountTextViewport(host, workspace, source.id);
        viewport.decorations.addProvider({ order: 0, provide: line => [{ from: line.from, to: line.from + 250, className: "geometry-a" }, { from: line.from + 250, to: line.to, className: "geometry-b" }] });
        let allocations = 0, queries = 0;
        const createRange = document.createRange, getClientRects = Range.prototype.getClientRects;
        document.createRange = function () { allocations++; return createRange.call(this); };
        Range.prototype.getClientRects = function () { queries++; return getClientRects.call(this); };
        const buffer = () => workspace.document(source.id).buffer;
        const row = () => host.querySelector<HTMLElement>('.st-viewport-row[data-line="2"]')!;
        const steps: { name: string; allocations: number; queries: number; revision: number; error: number }[] = [];
        const measure = (name: string) => {
            allocations = queries = 0;
            const offset = buffer().offsetAt(2) + 50, point = viewport.coordsAt(offset)!;
            // Independent collapsed native range; bypass only the work counters.
            let local = 50; const walker = document.createTreeWalker(row(), NodeFilter.SHOW_TEXT);
            let text = walker.nextNode() as Text; while (local > text.length) { local -= text.length; text = walker.nextNode() as Text; }
            const range = createRange.call(document); range.setStart(text, local); range.setEnd(text, local);
            const native = [...getClientRects.call(range)][0]!;
            steps.push({ name, allocations, queries, revision: point.revision, error: Math.max(Math.abs(point.left - native.left), Math.abs(point.top - native.top)) });
            return point;
        };
        try {
            viewport.flush(); const initial = measure("initial"), originalRow = row(), child = originalRow.firstChild;
            viewport.flush(); measure("unchanged flush");
            viewport.view.setSelection(0, { anchor: 1, head: 3 }); viewport.flush(); measure("other row selection");
            const from = buffer().offsetAt(2);
            viewport.view.setSelection(0, { anchor: from + 20, head: from + 30 }); viewport.flush(); measure("changed children");
            viewport.view.setSelection(0, { anchor: 1, head: 1 }); viewport.flush(); measure("restored children");
            const unchangedChild = row().firstChild;
            workspace.edit({ documentId: source.id, expectedRevision: 0, edits: [{ from: 0, to: 0, insert: "q" }], origin: "host" });
            const stale = viewport.coordsAt(from + 50) === undefined;
            viewport.flush(); measure("new revision and source offset");
            const retainedNodes = row() === originalRow && row().firstChild === unchangedChild && child !== unchangedChild;
            viewport.scrollTo({ top: 12 }); viewport.flush(); const moved = measure("moved row");
            const width = row().getBoundingClientRect().width;
            style.textContent = ".geometry-a { letter-spacing: 2px } .geometry-b { letter-spacing: -2px }";
            viewport.flush(); measure("inline typography with unchanged row width");
            const sameWidth = Math.abs(row().getBoundingClientRect().width - width) < .1;
            viewport.element.style.zoom = "1.25"; viewport.flush(); measure("zoom");
            viewport.element.style.lineHeight = "40px"; viewport.flush(); measure("line height");
            viewport.invalidate(); viewport.flush(); measure("explicit invalidation");
            document.fonts.dispatchEvent(new Event("loadingdone")); viewport.flush(); measure("font completion");
            viewport.scrollTo({ top: 2000 }); viewport.flush(); const removed = !originalRow.isConnected;
            viewport.scrollTo({ top: 12 }); viewport.flush(); measure("remounted row");
            workspace.edit({ documentId: source.id, expectedRevision: 1, edits: [{ from: 0, to: buffer().length, insert: "ab\r\ncd\n" }], origin: "host" });
            viewport.scrollTo({ top: 0, left: 0 }); viewport.flush();
            const boundaries = [0, 2, 3, 4, 6, 7].map(offset => viewport.coordsAt(offset)!);
            viewport.view.folding.setRanges(viewport.view.folding.getSnapshot(), [{ id: "fold", from: 0, to: 7, collapsed: true }]);
            const staleFold = viewport.coordsAt(4) === undefined; viewport.flush();
            const folded = viewport.coordsAt(4)!, header = viewport.coordsAt(2)!;
            viewport.dispose(); const disposed = viewport.coordsAt(0) === undefined && !originalRow.isConnected && !host.firstChild;
            return { steps, stale, retainedNodes, movedBy: initial.top - moved.top, sameWidth, removed, boundaries,
                staleFold, folded: folded.offset === 4 && folded.left === header.left && folded.top === header.top, disposed };
        } finally {
            document.createRange = createRange; Range.prototype.getClientRects = getClientRects;
            viewport.dispose(); workspace.releaseResource(source.id, true); host.remove(); style.remove();
        }
    });
    expect(result).toMatchObject({ stale: true, retainedNodes: true, movedBy: 12, sameWidth: true, removed: true, staleFold: true, folded: true, disposed: true });
    await testInfo.attach("geometry-work", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.steps.map(({ name, allocations }) => ({ name, allocations }))).toEqual([
        { name: "initial", allocations: 1 },
        { name: "unchanged flush", allocations: 0 },
        { name: "other row selection", allocations: 0 },
        ...["changed children", "restored children", "new revision and source offset"].map(name => ({ name, allocations: 1 })),
        ...["moved row", "inline typography with unchanged row width"].map(name => ({ name, allocations: 0 })),
        ...["zoom", "line height", "explicit invalidation", "font completion", "remounted row"].map(name => ({ name, allocations: 1 })),
    ]);
    for (const [index, step] of result.steps.entries()) {
        expect(step.error, step.name).toBeLessThanOrEqual(1.5); expect(step.revision).toBe(index < 5 ? 0 : 1);
        if (index === 1 || index === 2) expect(step.queries, step.name).toBe(0);
        else { expect(step.queries, step.name).toBeGreaterThan(0); expect(step.queries, step.name).toBeLessThanOrEqual(7); }
    }
    expect(result.boundaries.map(point => point.offset)).toEqual([0, 2, 3, 4, 6, 7]);
    expect(result.boundaries[1]!.left).toBe(result.boundaries[2]!.left);
    expect(result.boundaries[1]!.top).toBe(result.boundaries[2]!.top);
    expect(result.boundaries[3]!.top).toBeGreaterThan(result.boundaries[2]!.top);
    expect(result.boundaries[5]!.top).toBeGreaterThan(result.boundaries[4]!.top);
});
