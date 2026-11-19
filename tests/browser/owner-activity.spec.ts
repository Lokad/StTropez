import { test, expect } from "./fixtures.ts";
import { build } from "esbuild";
import { basename } from "node:path";

test("owner activity retains immutable captures without collecting metrics and follows pending work", async ({ page }, testInfo) => {
    const built = await build({ entryPoints: { core: "src/index.ts", browser: "src/browser/text-editor.ts", readiness: "examples/shared/readiness.ts",
        rows: "src/core/comparison-rows.ts" }, outdir: "artifacts/owner-activity", bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", write: false });
    const modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text]));
    await page.route("**/owner-activity/**", route => {
        const body = modules.get(new URL(route.request().url()).pathname.split("/").at(-1)!);
        return body === undefined ? route.abort() : route.fulfill({ contentType: "text/javascript", body });
    });
    await page.goto("/viewport/");
    const result = await page.evaluate(async () => {
        const path = "/owner-activity/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountEditor } = await import(path + "browser.js") as typeof import("../../src/browser/text-editor.ts");
        const { editorSettled, viewportSettled } = await import(path + "readiness.js") as typeof import("../../examples/shared/readiness.ts");
        const { ComparisonRowsCursor } = await import(path + "rows.js") as typeof import("../../src/core/comparison-rows.ts");
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "test", resource: "activity", variant: "text" }, "Activity", { value: "const sample = 123;\n".repeat(100) });
        const tab = workspace.open({ kind: "text", documentId: source.documentId }, "activity"), host = document.createElement("section");
        host.style.cssText = "height:220px;width:800px;position:fixed;top:0;left:0"; document.body.append(host);
        const { editor, setComparisonRows } = mountEditor(host, workspace, tab), viewport = editor.viewport;
        const forbidden = () => { throw new Error("Readiness collected metrics"); };
        const readyViewport = { ...viewport, snapshot: forbidden }, readyEditor = { ...editor, viewport: readyViewport, snapshot: forbidden };
        const ready = () => editorSettled(readyEditor), frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const settle = async () => { for (let i = 0; i < 60; i++) { await frame(); if (ready()) return; } throw new Error("Editor did not settle"); };
        const states: Record<string, unknown> = {};
        const state = (name: string) => { states[name] = { input: editor.activity(), painted: viewport.activity(), ready: ready() }; };
        try {
            state("mount"); await settle(); editor.focus(); await settle();
            const idleInput = editor.activity(), idleViewport = viewport.activity();
            const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!;
            const rectangle = Element.prototype.getBoundingClientRect, computed = window.getComputedStyle;
            let valueReads = 0, layoutReads = 0;
            Object.defineProperty(editor.input, "value", { configurable: true, get() { valueReads++; return descriptor.get!.call(this); }, set(value: string) { descriptor.set!.call(this, value); } });
            Element.prototype.getBoundingClientRect = function () { layoutReads++; return rectangle.call(this); };
            window.getComputedStyle = (...args) => { layoutReads++; return computed(...args); };
            const metricCaptures = new Set<object>(), activityCaptures = new Set<object>();
            let metricValueReads = 0;
            try {
                for (let i = 0; i < 1000; i++) { metricCaptures.add(editor.snapshot()); metricCaptures.add(viewport.snapshot()); }
                metricValueReads = valueReads; valueReads = 0; layoutReads = 0;
                for (let i = 0; i < 1000; i++) {
                    activityCaptures.add(editor.activity()); activityCaptures.add(viewport.activity());
                    if (!ready() || !viewportSettled(readyViewport)) throw new Error("Unchanged owner became unsettled");
                }
            } finally {
                Reflect.deleteProperty(editor.input, "value"); Element.prototype.getBoundingClientRect = rectangle; window.getComputedStyle = computed;
            }
            const polling = { metricCaptures: metricCaptures.size, metricValueReads, activityCaptures: activityCaptures.size, valueReads, layoutReads,
                inputStable: editor.activity() === idleInput, viewportStable: viewport.activity() === idleViewport,
                frozen: Object.isFrozen(idleInput) && Object.isFrozen(idleViewport) && Object.isFrozen(idleViewport.selectionSet) };
            editor.view.setSelection(0, { anchor: 6, head: 6 }); state("selection queued");
            const selectionStale = viewport.activity().selectionSet !== editor.view.getSnapshot().selectionSet;
            await settle(); state("selection painted");
            workspace.edit({ documentId: source.documentId, expectedRevision: 0, edits: [{ from: 0, to: 0, insert: "//" }], origin: "host" }); state("revision queued");
            await settle(); state("revision painted");
            const buffer = workspace.document(source.documentId).buffer;
            editor.view.folding.setRanges(editor.view.folding.getSnapshot(), [{ id: "fold", from: buffer.offsetAt(3), to: buffer.offsetAt(8), collapsed: true }]); state("fold queued");
            const foldStale = viewport.activity().foldGeneration !== editor.view.folding.getSnapshot().generation;
            await settle(); state("fold painted");
            const folds = editor.view.folding.getSnapshot(), cursor = new ComparisonRowsCursor(buffer, buffer, Object.freeze([]), folds.index, folds.index);
            let alignment = cursor.next(4096); while (!alignment.result) alignment = cursor.next(4096); cursor.dispose();
            setComparisonRows({ documentId: source.documentId, revision: 1, foldGeneration: folds.generation, id: 42,
                lineHeight: viewport.snapshot().lineHeight, index: alignment.result.working }); state("alignment queued");
            await settle(); state("alignment painted");
            setComparisonRows(undefined); await settle(); state("alignment cleared");
            const insertion = editor.captureInsertion()!; state("insertion captured"); insertion.cancel(); state("insertion cancelled");
            editor.input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); state("composition queued");
            await settle(); state("composition painted");
            editor.input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); await settle(); state("composition ended");
            const held = editor.captureInsertion()!;
            editor.dispose(); state("disposed");
            return { comparisonSetterExposed: "setComparisonRows" in viewport, polling, states, selectionStale, foldStale, insertionAborted: held.signal.aborted,
                oldCapturesUnchanged: !idleInput.disposed && !idleViewport.disposed && idleViewport.revision === 0 && idleViewport.alignmentId === null,
                disposedStable: editor.activity() === editor.activity() && viewport.activity() === viewport.activity() };
        } finally { editor.dispose(); workspace.close(tab); workspace.releaseResource(source.id, true); host.remove(); }
    });
    await testInfo.attach("owner-activity", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.polling).toEqual({ metricCaptures: 2000, metricValueReads: 1000, activityCaptures: 2, valueReads: 0, layoutReads: 0,
        inputStable: true, viewportStable: true, frozen: true });
    expect(result).toMatchObject({ comparisonSetterExposed: false, selectionStale: true, foldStale: true, insertionAborted: true, oldCapturesUnchanged: true, disposedStable: true });
    for (const name of ["mount", "selection queued", "revision queued", "fold queued", "alignment queued", "composition queued"])
        expect(result.states[name], name).toMatchObject({ ready: false, painted: { pending: true, disposed: false } });
    for (const name of ["selection painted", "revision painted", "fold painted", "alignment painted", "alignment cleared", "insertion cancelled", "composition painted", "composition ended"])
        expect(result.states[name], name).toMatchObject({ ready: true, painted: { pending: false }, input: { pendingCaret: false, pendingInput: false, pendingCommand: false } });
    expect(result.states["revision queued"]).toMatchObject({ painted: { revision: 0 } });
    expect(result.states["revision painted"]).toMatchObject({ painted: { revision: 1 } });
    expect(result.states["alignment queued"]).toMatchObject({ painted: { aligned: false, alignmentId: null } });
    expect(result.states["alignment painted"]).toMatchObject({ painted: { aligned: true, alignmentId: 42 } });
    expect(result.states["alignment cleared"]).toMatchObject({ painted: { aligned: false, alignmentId: null } });
    expect(result.states["insertion captured"]).toMatchObject({ ready: false, input: { pendingInput: true } });
    expect(result.states["composition painted"]).toMatchObject({ ready: true, input: { composing: true } });
    expect(result.states["composition ended"]).toMatchObject({ input: { composing: false } });
    expect(result.states["disposed"]).toMatchObject({ ready: false, input: { disposed: true, pendingInput: false, pendingCaret: false }, painted: { disposed: true, pending: false } });
});
