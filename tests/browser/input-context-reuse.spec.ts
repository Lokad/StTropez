import { test, expect } from "./fixtures.ts";
import { build } from "esbuild";
import { basename } from "node:path";

test("input refresh reuses bounded projections while repairing native state and capturing current targets", async ({ page }, testInfo) => {
    const built = await build({ entryPoints: { core: "src/index.ts", browser: "src/browser/index.ts", context: "src/browser/input-context.ts" },
        outdir: "artifacts/input-context-reuse", bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", write: false });
    const modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text]));
    await page.route("**/input-context-reuse/**", route => {
        const body = modules.get(new URL(route.request().url()).pathname.split("/").at(-1)!);
        return body === undefined ? route.abort() : route.fulfill({ contentType: "text/javascript", body });
    });
    await page.goto("/viewport/");
    const result = await page.evaluate(async () => {
        const path = "/input-context-reuse/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const { inputContext } = await import(path + "context.js") as typeof import("../../src/browser/input-context.ts");
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "test", resource: "context-reuse", variant: "text" }, "Context",
            { value: "const row = '東京 😀';\r\n".repeat(100000) });
        const tab = workspace.tabs.open({ kind: "text", documentId: source.documentId }, "context"), host = document.createElement("section");
        host.style.cssText = "height:220px;width:800px;position:fixed;top:0;left:0"; document.body.append(host);
        const editor = mountTextEditor(host, workspace, tab), input = editor.element.querySelector("textarea")!, target = workspace.tabs.capture(tab);
        const doc = () => workspace.document(source.documentId), refresh = () => input.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true }));
        const settle = async () => { for (let i = 0; i < 60; i++) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            if (!editor.activity().pendingCaret && !editor.viewport.activity().pending) return;
        } throw new Error("Editor did not settle"); };
        const expected = () => inputContext(doc().buffer, editor.view.getSnapshot().selection);
        const exact = (projection = expected()) => input.value === projection.text
            && input.selectionStart === Math.min(projection.nativeAnchor, projection.nativeHead)
            && input.selectionEnd === Math.max(projection.nativeAnchor, projection.nativeHead)
            && (input.selectionDirection === "backward") === (projection.nativeAnchor > projection.nativeHead);
        const work: { name: string; sliceUnits: number }[] = [];
        const measure = (name: string, action: () => void) => {
            const buffer = doc().buffer, before = buffer.readMetrics().sliceUnits; action();
            work.push({ name, sliceUnits: buffer.readMetrics().sliceUnits - before });
        };
        const edit = (from: number, to: number, insert: string) => {
            if (!workspace.edit({ documentId: source.documentId, expectedRevision: doc().revision, origin: "host", edits: [{ from, to, insert }] }).applied) throw new Error("Edit rejected");
        };
        try {
            const at = doc().buffer.offsetAt(50000) + 6;
            editor.view.setSelection(doc().revision, { anchor: at, head: at }); await settle();
            measure("100 unchanged refreshes", () => { for (let i = 0; i < 100; i++) refresh(); });
            editor.view.setSelection(doc().revision, { anchor: at + 5000, head: at });
            const compressed = expected(), compressedExact = exact(compressed) && input.value.includes("\ufffc");
            measure("100 compressed backward refreshes", () => { for (let i = 0; i < 100; i++) refresh(); });
            measure("repair native value and range", () => { input.value = "changed outside input"; input.setSelectionRange(1, 2); refresh(); });
            const repaired = exact(compressed);
            const capabilities = source.metadata.getSnapshot().capabilities;
            let locked = false, denied = false;
            measure("authority and language refreshes", () => {
                workspace.setCapabilities(source.id, { ...capabilities, edit: ["host"] }); locked = input.readOnly;
                denied = !input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "Q", cancelable: true, bubbles: true }));
                workspace.setCapabilities(source.id, capabilities); editor.configure({ language: { tabSize: 8 } });
            });
            const authority = locked && denied && !input.readOnly && exact(compressed);
            editor.view.setSelection(doc().revision, { anchor: at, head: at + 5000 });
            const directionChanged = exact() && input.selectionDirection === "forward";
            // A changed complete set with the same primary range must still become the native target.
            editor.view.setSelection(doc().revision, { anchor: at, head: at });
            editor.view.setSelections(doc().revision, [{ anchor: at, head: at }, { anchor: at + 100, head: at + 100 }], 0);
            const before = doc().buffer.length;
            if (input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "Z", cancelable: true, bubbles: true }))) {
                input.setRangeText("Z", input.selectionStart, input.selectionEnd, "end");
                input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "Z", bubbles: true }));
            }
            const completeSet = doc().buffer.length === before + 2 && doc().buffer.slice(at, at + 1) === "Z"
                && doc().buffer.slice(at + 101, at + 102) === "Z" && exact();
            editor.view.setSelection(doc().revision, { anchor: at + 1, head: at + 1 });
            edit(at + 10, at + 11, "X"); const newBuffer = exact() && input.value.includes("X");
            // Composition keeps its captured projection while a later model revision expires it.
            input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
            input.setRangeText("あ", input.selectionStart, input.selectionEnd, "end"); const composingValue = input.value;
            edit(doc().buffer.length, doc().buffer.length, "tail"); refresh();
            const held = input.value === composingValue, conflicts = editor.getDiagnostics().conflicts;
            input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
            const expiredComposition = held && editor.getDiagnostics().conflicts === conflicts + 1 && exact()
                && doc().buffer.slice(at, at + 2) !== "Zあ" && doc().buffer.slice(doc().buffer.length - 4, doc().buffer.length) === "tail";
            // Raw positions on either side of CRLF can share one native offset; capture each exact model target.
            const crlf = doc().buffer.offsetAt(1) - 1;
            editor.view.setSelection(doc().revision, { anchor: crlf, head: crlf }); refresh(); input.dispatchEvent(new Event("select"));
            const rawCrLf = editor.view.getSnapshot().selection.head === crlf && exact();
            await settle(); workspace.tabs.close(tab); const disabled = input.disabled;
            editor.dispose(); const reads = doc().buffer.readMetrics().sliceUnits; refresh();
            return { work, compressedExact, repaired, authority, directionChanged, completeSet, newBuffer, expiredComposition, rawCrLf, disabled,
                disposed: !input.isConnected && input.value === "" && doc().buffer.readMetrics().sliceUnits === reads,
                exports: doc().buffer.readMetrics().textExports };
        } finally { editor.dispose(); if (workspace.tabs.resolve(target)) workspace.tabs.close(tab); workspace.releaseResource(source.id, true); host.remove(); }
    });
    await testInfo.attach("input-context-reuse", { body: JSON.stringify(result), contentType: "application/json" });
    for (const item of result.work) expect(item.sliceUnits, item.name).toBe(0);
    expect(result).toMatchObject({ compressedExact: true, repaired: true, authority: true, directionChanged: true, completeSet: true, newBuffer: true,
        expiredComposition: true, rawCrLf: true, disabled: true, disposed: true, exports: 0 });
});
