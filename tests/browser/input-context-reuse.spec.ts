import { test, expect } from "./fixtures.ts";
import { fixtureModules } from "../helpers/fixture-modules.ts";

const serveModules = fixtureModules({
    probe: "tests/observe-buffer-reads.ts",
    core: "src/index.ts",
    browser: "src/browser/index.ts",
    context: "src/browser/input-context.ts",
});

test("input refresh reuses bounded projections while repairing native state and capturing current targets", async ({ page }, testInfo) => {
    await serveModules(page, "/input-context-reuse/");
    await page.goto("/viewport/");
    const result = await page.evaluate(async () => {
        const path = "/input-context-reuse/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const { inputContext } = await import(path + "context.js") as typeof import("../../src/browser/input-context.ts");
        const { observeBufferReads } = await import(path + "probe.js") as typeof import("../observe-buffer-reads.ts");
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "test", resource: "context-reuse", variant: "text" }, "Context",
            { value: "const row = '東京 😀';\r\n".repeat(1000) });
        const host = document.createElement("section");
        host.style.cssText = "height:220px;width:800px;position:fixed;top:0;left:0"; document.body.append(host);
        const editor = mountTextEditor(host, workspace, source.id), input = editor.element.querySelector("textarea")!;
        const doc = () => workspace.document(source.id), refresh = () => input.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true }));
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
            const buffer = doc().buffer, before = reads.read(buffer).sliceUnits; action();
            work.push({ name, sliceUnits: reads.read(buffer).sliceUnits - before });
        };
        const edit = (from: number, to: number, insert: string) => {
            if (!workspace.edit({ documentId: source.id, expectedRevision: doc().revision, origin: "host", edits: [{ from, to, insert }] }).applied) throw new Error("Edit rejected");
        };
        const reads = observeBufferReads();
        try {
            const at = doc().buffer.offsetAt(500) + 6;
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
            await settle();
            editor.dispose(); const prior = reads.read(doc().buffer).sliceUnits; refresh();
            return { work, compressedExact, repaired, authority, directionChanged, completeSet, newBuffer, expiredComposition, rawCrLf,
                disposed: !input.isConnected && input.value === "" && reads.read(doc().buffer).sliceUnits === prior };
        } finally { reads.dispose(); editor.dispose(); workspace.releaseResource(source.id, true); host.remove(); }
    });
    await testInfo.attach("input-context-reuse", { body: JSON.stringify(result), contentType: "application/json" });
    for (const item of result.work) expect(item.sliceUnits, item.name).toBe(0);
    expect(result).toMatchObject({ compressedExact: true, repaired: true, authority: true, directionChanged: true, completeSet: true, newBuffer: true,
        expiredComposition: true, rawCrLf: true, disposed: true });
});
