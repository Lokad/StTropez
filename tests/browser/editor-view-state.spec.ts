import { expect } from "./fixtures.ts";
import { presentationTest as test } from "./presentation-fixture.ts";

test("document mounts own Find, fold discovery and pending insertions across a remount", async ({ page }) => {
    const fixture = await page.evaluateHandle(async () => {
        const path = "/presentation-fixture/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor, createFindController, createFoldingController } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace();
        const source = workspace.createTextResource({ scope: "test", resource: "document", variant: "working" }, "Source", { value: "one\n  two\nend" });
        const view = workspace.createDocumentView(source.id);
        const host = document.createElement("main");
        host.style.height = "240px"; document.body.append(host);
        const mount = () => mountTextEditor(host, workspace, source.id, { view });
        const editor = mount(), find = createFindController(editor);
        let reply: (() => void) | undefined, discoverySignal: AbortSignal | undefined;
        const folds = createFoldingController(editor, (_document, signal) => {
            discoverySignal = signal;
            return new Promise(resolve => { reply = () => resolve([{ from: 0, to: 9 }]); });
        }, { delayMs: 0 });
        find.setQuery("two");
        let replacement: typeof editor;
        return {
            ready: () => !!reply && find.getSnapshot().status === "ready",
            replace: () => {
                if (find.next().status !== "done") throw new Error("Could not select the match.");
                const insertion = editor.captureInsertion();
                if (!insertion) throw new Error("Could not capture the selected text.");
                editor.dispose();
                replacement = mount(); replacement.focus(); reply!();
                return { expired: insertion.signal.aborted && !insertion.insert("stale"),
                    cancelled: discoverySignal?.aborted, find: find.getSnapshot().status, folds: folds.getSnapshot().status };
            },
            finish: () => {
                const text = workspace.document(source.id).buffer.text(), ranges = view.folding.getSnapshot().regions.length;
                replacement.dispose(); view.dispose(); workspace.releaseResource(source.id, true);
                return { text, ranges, ...workspace.diagnostics() };
            }
        };
    });
    await expect.poll(() => fixture.evaluate(f => f.ready())).toBe(true);
    expect(await fixture.evaluate(f => f.replace())).toEqual({ expired: true, cancelled: true, find: "disposed", folds: "disposed" });
    await expect(page.getByRole("textbox", { name: "Source" })).toBeFocused();
    await page.keyboard.type("ok");
    await expect(page.locator(".st-viewport")).toContainText("ok");
    expect(await fixture.evaluate(f => f.finish())).toMatchObject({ text: "one\n  ok\nend", ranges: 0, views: 0, leases: 0, subscriptions: 0 });
});

test("cancelling a refresh makes the same selection editable before the stale reply settles", async ({ page }) => {
    const fixture = await page.evaluateHandle(async () => {
        const path = "/presentation-fixture/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace();
        const source = workspace.createTextResource({ scope: "test", resource: "refresh", variant: "working" }, "Source", { value: "left middle right" });
        const host = document.createElement("main"); document.body.append(host);
        const editor = mountTextEditor(host, workspace, source.id);
        editor.view.setSelection(0, { anchor: 11, head: 5 });
        const refresh = workspace.beginLoad(source);
        return { cancel: refresh.dispose, late: () => refresh.accept({ value: "obsolete" }), dispose: editor.dispose };
    });
    const input = page.getByRole("textbox", { name: "Source" });
    await expect(input).toBeDisabled(); await fixture.evaluate(f => f.cancel());
    await expect(input).toBeEnabled();
    await input.focus(); await page.keyboard.type("X"); await expect(input).toHaveValue("left X right");
    expect(await fixture.evaluate(f => f.late())).toBe(false);
    await input.press("Control+z"); await expect(input).toHaveValue("left middle right");
    await fixture.evaluate(f => f.dispose()); await fixture.dispose();
});

test("a narrower pane keeps a previously visible caret in view and preserves deliberate scrolling away", async ({ page }) => {
    const result = await page.evaluate(async () => {
        const path = "/presentation-fixture/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace();
        const id = workspace.createDocument({ scope: "test", resource: "wide", variant: "working" }, "line", "a".repeat(800));
        const host = document.createElement("div");
        host.style.cssText = "width:800px;height:180px";
        document.body.append(host);
        const editor = mountTextEditor(host, workspace, id);
        try {
            const viewport = editor.viewport;
            editor.view.setSelection(0, { anchor: 310, head: 300 });
            viewport.revealOffset(300, { horizontal: "nearest", vertical: "nearest" });
            viewport.flush();
            viewport.flush();
            const visible = editor.captureView();
            viewport.scrollTo({ left: 300 });
            viewport.flush();
            const away = editor.captureView();
            host.style.width = "350px";
            editor.restoreView(visible);
            viewport.flush();
            const edge = viewport.element.getBoundingClientRect().right;
            const caret = viewport.coordsAt(300)!.left;
            const fitted = editor.captureView();
            editor.restoreView(away);
            viewport.flush();
            return {
                inside: caret < edge && caret > viewport.element.querySelector(".st-viewport-gutter")!.getBoundingClientRect().right,
                moved: fitted.scrollLeft > visible.scrollLeft,
                stable: fitted.scrollTop === visible.scrollTop && fitted.head === visible.head && fitted.anchor === visible.anchor,
                browse: editor.captureView().scrollLeft === away.scrollLeft,
            };
        } finally {
            editor.dispose();
            host.remove();
        }
    });
    expect(result).toEqual({ inside: true, moved: true, stable: true, browse: true });
});

test("remounting after edits uses the retained selection, maps a fresh view or clamps older captures", async ({ page }) => {
    const result = await page.evaluate(async () => {
        const path = "/presentation-fixture/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace();
        const file = workspace.createTextResource({ scope: "test", resource: "restore", variant: "working" }, "Source", { value: "left\nmiddle\nright" });
        const id = file.id, view = workspace.createDocumentView(id);
        const host = document.createElement("main"); host.style.height = "160px"; document.body.append(host);
        let editor = mountTextEditor(host, workspace, id, { view });
        try {
            view.setSelections(0, [{ anchor: 1, head: 1 }, { anchor: 16, head: 13 }], 1);
            editor.viewport.flush();
            const capture = editor.captureView();
            const saved = { ...capture, horizontalAnchor: { revision: 0, offset: 13, affinity: "before" as const, left: 15 } };
            editor.dispose();
            workspace.edit({ documentId: id, expectedRevision: 0, origin: "host", edits: [{ from: 0, to: 5, insert: "" }] });
            editor = mountTextEditor(host, workspace, id);
            let observedTop: number | undefined;
            const stop = editor.view.subscribe(() => { observedTop = editor.viewport.captureView().scrollTop; });
            const mapped = editor.restoreView({ ...saved, scrollTop: 17 }), first = editor.view.getSnapshot().selectionSet;
            stop();
            editor.dispose();
            workspace.edit({ documentId: id, expectedRevision: 1, origin: "host", edits: [{ from: 2, to: 12, insert: "" }] });
            editor = mountTextEditor(host, workspace, id);
            const clamped = editor.restoreView(saved), second = editor.view.getSnapshot().selectionSet;
            const wrong = { ...saved, folding: { ...saved.folding!, documentId: workspace.createTextResource(
                { scope: "test", resource: "other", variant: "working" }, "Other", { value: "" }).id } };
            const foreign = editor.restoreView(wrong);
            editor.dispose();
            editor = mountTextEditor(host, workspace, id, { view });
            const live = view.getSnapshot().selectionSet, kept = editor.restoreView(saved);
            const retained = live === view.getSnapshot().selectionSet;
            const here = editor.captureView(); view.setSelection(2, { anchor: 1, head: 1 });
            const exact = editor.restoreView(here, { selection: "current" });
            const beforeRewrite = editor.captureView();
            editor.dispose();
            workspace.replaceText(id, "ABCDE", { expectedRevision: 2, origin: "host", history: "record" });
            editor = mountTextEditor(host, workspace, id);
            const rewritten = editor.restoreView(beforeRewrite);
            return { observedTop, mapped: mapped?.selection, mappedAnchors: [mapped?.verticalAnchorRestored, mapped?.horizontalAnchorRestored],
                droppedAnchors: [clamped?.verticalAnchorRestored, clamped?.horizontalAnchorRestored], first: first.ranges.map(r => [r.anchor, r.head]), primary: first.primary,
                clamped: clamped?.selection, second: second.ranges.map(r => [r.anchor, r.head]), foreign, kept: kept?.selection,
                retained, sameRevision: exact?.selection, caret: beforeRewrite.head,
                rewritten: rewritten?.selection, restoredCaret: editor.view.getSnapshot().selection.head };
        } finally { editor.dispose(); view.dispose(); host.remove(); }
    });
    expect(result).toEqual({ observedTop: 17, mapped: "mapped", mappedAnchors: [true, true], droppedAnchors: [false, false], first: [[0, 0], [11, 8]], primary: 1, clamped: "clamped", second: [[1, 1], [2, 2]],
        foreign: null, kept: "current", retained: true, sameRevision: "current", caret: 1, rewritten: "mapped", restoredCaret: 1 });
});

test("Back restores the origin selections across edits at a same-file destination", async ({ page }) => {
    const result = await page.evaluate(async () => {
        const path = "/presentation-fixture/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor, createNavigationHistory } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace();
        const padding = "abc\n".repeat(60);
        const resource = workspace.createTextResource({ scope: "test", resource: "jump", variant: "source" }, "Jump",
            { value: padding + "abc\norigin line\n" + padding });
        const { id: documentId } = resource;
        const host = document.body.appendChild(document.createElement("section"));
        host.style.height = "160px";
        const editor = mountTextEditor(host, workspace, documentId), history = createNavigationHistory(workspace);
        try {
            const { view, viewport } = editor, revision = workspace.document(documentId).revision;
            const at = padding.length;
            view.setSelections(revision, [{ anchor: at + 10, head: at + 4 }, { anchor: at + 13, head: at + 13 }], 1);
            editor.reveal({ line: 60, column: 0 }, { align: "start" });
            viewport.flush();
            const top = viewport.getSnapshot().scrollTop;
            const origin = history.capture(editor)!;
            origin.visit(() => editor.reveal({ from: 1, to: 1 }, { select: true, align: "start" }).status === "done");
            viewport.flush();
            for (const insert of ["xx", "y"]) workspace.edit({ documentId, expectedRevision: workspace.document(documentId).revision,
                edits: [{ from: 1, to: 1, insert }], origin: "human" });
            const save = workspace.captureSave(resource);
            save.start();
            save.accept({ serverVersion: "formatted", canonical: workspace.document(documentId).text().toUpperCase() });
            save.finish();
            workspace.undo({ documentId, expectedRevision: workspace.document(documentId).revision });
            workspace.redo({ documentId, expectedRevision: workspace.document(documentId).revision });
            const restored = history.back(editor, () => editor);
            viewport.flush();
            const { ranges, primary } = view.getSnapshot().selectionSet;
            return { restored, primary, ranges: ranges.map(({ anchor, head }) => [anchor - at, head - at]),
                depth: history.getSnapshot().back, top, restoredTop: viewport.getSnapshot().scrollTop,
                visible: !!viewport.coordsAt(ranges[primary]!.head) };
        } finally { history.dispose(); editor.dispose(); host.remove(); }
    });
    expect(result.top).toBeGreaterThan(160);
    expect(result).toEqual({ restored: "restored", primary: 1, ranges: [[13, 7], [16, 16]], depth: 0,
        top: result.top, restoredTop: result.top, visible: true });
});

test("revealing a source range in a read-only editor aligns the painted rows and preserves the caller's focus", async ({ page }) => {
    const result = await page.evaluate(async () => {
        const path = "/presentation-fixture/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace();
        const resource = workspace.createTextResource({ scope: "test", resource: "reveal", variant: "working" }, "Source",
            { value: Array.from({ length: 200 }, (_, i) => "row " + i + " 😀").join("\r\n") });
        const host = document.createElement("main"), other = document.createElement("button");
        host.style.height = "200px"; document.body.append(other, host);
        const editor = mountTextEditor(host, workspace, resource.id, { readOnly: true });
        try {
            const { view, viewport } = editor, { buffer, revision } = workspace.document(resource.id);
            view.setSelections(revision, [{ anchor: 5, head: 1 }, { anchor: 7, head: 7 }], 0);
            const selection = view.getSnapshot().selectionSet, folding = view.folding;
            folding.setRanges(folding.getSnapshot(), [{ id: "section", from: buffer.offsetAt(12), to: buffer.offsetAt(160), collapsed: true }]);
            viewport.flush(); other.focus();
            const origin = editor.captureView(), row = buffer.line(80);
            const positions = { start: { line: 80, column: 999 }, end: { line: 80, column: -3 } };
            const stale = editor.reveal(positions, { expectedRevision: revision + 1, select: true, focus: true });
            let rejected = false;
            try { editor.reveal({ from: row.to, to: row.from }, { select: true, focus: true }); } catch (error) { rejected = error instanceof RangeError; }
            const untouched = view.getSnapshot().selectionSet === selection && folding.getSnapshot().index.collapsedCount === 1 && document.activeElement === other;
            const point = editor.reveal({ line: 80, column: 999 }, { align: "start" });
            viewport.flush(); const start = viewport.getSnapshot().scrollTop;
            const preview = point.status === "done" && point.value.from === row.to && point.value.to === row.to && !!viewport.coordsAt(row.to)
                && view.getSnapshot().selectionSet === selection && document.activeElement === other && folding.getSnapshot().index.collapsedCount === 0;
            editor.reveal(row); viewport.flush(); const kept = viewport.getSnapshot().scrollTop === start;
            const selected = editor.reveal(positions, { align: "center", select: true, focus: true, expectedRevision: revision });
            viewport.flush(); const centered = viewport.getDiagnostics();
            const centerDelta = start - centered.scrollTop;
            const center = Math.abs(centerDelta - (centered.height - centered.lineHeight) / 2) < centered.lineHeight;
            const chosen = selected.status === "done" && selected.value.from === row.from && selected.value.to === row.to && view.getSnapshot().selection.head === row.to
                && view.getSnapshot().selection.anchor === row.from && editor.getSnapshot().focused;
            const full = editor.reveal({ start: { line: 999, column: 999 }, end: { line: -9, column: 0 } });
            editor.restoreView(origin); viewport.flush();
            const returned = viewport.getSnapshot().scrollTop === origin.scrollTop && view.getSnapshot().selection.anchor === 5 && view.getSnapshot().selection.head === 1
                && view.getSnapshot().selectionSet.ranges.length === 2;
            const refresh = workspace.beginLoad(resource);
            const unavailable = editor.reveal(row, { select: true });
            refresh.dispose();
            editor.dispose();
            const released = editor.reveal(row);
            return { stale, unavailable, released, rejected, untouched, preview, kept, center, chosen, full: full.status === "done" && full.value.from === 0 && full.value.to === buffer.length, returned };
        } finally { editor.dispose(); other.remove(); host.remove(); }
    });
    expect(result).toEqual({ stale: { status: "stale" }, unavailable: { status: "refused", reason: "unavailable-view" },
        released: { status: "stale" }, rejected: true, untouched: true, preview: true, kept: true, center: true, chosen: true, full: true, returned: true });
});
