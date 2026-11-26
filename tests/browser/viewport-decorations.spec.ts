import { test, expect } from "./fixtures.ts";
import { fixtureModules } from "../helpers/fixture-modules.ts";

const serveModules = fixtureModules({
    core: "src/index.ts",
    viewport: "src/browser/viewport.ts",
    editor: "src/browser/text-editor.ts",
});

test.beforeEach(async ({ page }) => {
    await serveModules(page, "/viewport-decorations/");
    await page.goto("/viewport/");
});

test("decorated viewport bounds endpoint reads and preserves overlap order, selection styling and child identity", async ({ page }) => {
    const result = await page.evaluate(async () => {
        const path = "/viewport-decorations/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextViewport } = await import(path + "viewport.js") as typeof import("../../src/browser/viewport.ts");
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "test", resource: "paint", variant: "text" }, "Paint", { value: "x".repeat(512) });
        const host = document.createElement("section"), style = document.createElement("style");
        host.style.cssText = "height:200px;width:1000px"; style.textContent = ".paint-first { color: rgb(200, 20, 30) } .paint-second { background-color: rgb(10, 30, 60) }"; document.body.append(host, style);
        let reads = 0, overlap = false;
        const disjoint = Array.from({ length: 256 }, (_, i) => ({ get from() { reads++; return i * 2; }, get to() { reads++; return i * 2 + 1; }, className: "paint-first" }));
        const combined = [{ from: 4, to: 8, className: "paint-first" }, { from: 0, to: 6, className: "paint-second" }, { from: 4, to: 5, className: "paint-first" }, { from: 0, to: 512, className: "invalid .class" }];
        const viewport = mountTextViewport(host, workspace, source.id);
        const tokens = viewport.decorations.addProvider({ order: 0, provide: () => overlap ? combined : disjoint });
        try {
            reads = 0; viewport.flush(); const endpointReads = reads, row = host.querySelector<HTMLElement>('.st-viewport-row[data-line="0"]')!;
            const exact = row.textContent === "x".repeat(512), colored = row.querySelectorAll(".paint-first").length;
            overlap = true; viewport.view.setSelection(0, { anchor: 3, head: 7 }); tokens.invalidate(0, 1); viewport.flush();
            const run = row.querySelector<HTMLElement>(".st-selection-run")!;
            const leaves = () => [...row.childNodes].flatMap(node => node === run ? [...run.childNodes] : [node]);
            const parts = leaves().map(node => ({ text: node.textContent, className: node instanceof HTMLElement ? node.className : "" }));
            const first = row.querySelector<HTMLElement>(".paint-first.paint-second")!, paint = getComputedStyle(first);
            const unselected = row.querySelector<HTMLElement>(".paint-second:not(.st-viewport-selected)")!;
            const color = paint.color, tokenBackground = paint.backgroundColor, selectedBackground = getComputedStyle(run).backgroundColor, decorationBackground = getComputedStyle(unselected).backgroundColor;
            const children = leaves(), texts = children.map(node => node.firstChild);
            tokens.invalidate(0, 1); viewport.flush();
            const after = leaves(), reused = children.every((node, i) => after[i] === node && node.firstChild === texts[i]);
            return { endpointReads, exact, colored, parts, color, tokenBackground, selectedBackground, decorationBackground, reused };
        } finally { viewport.dispose(); workspace.releaseResource(source.id, true); host.remove(); style.remove(); }
    });
    expect(result).toMatchObject({ endpointReads: 512, exact: true, colored: 256, color: "rgb(200, 20, 30)",
        tokenBackground: "rgba(0, 0, 0, 0)", selectedBackground: "rgb(36, 73, 107)", decorationBackground: "rgb(10, 30, 60)", reused: true });
    expect(result.parts).toEqual([
        { text: "xxx", className: "paint-second" }, { text: "x", className: "paint-second st-viewport-selected" },
        { text: "x", className: "paint-first paint-second paint-first st-viewport-selected" },
        { text: "x", className: "paint-first paint-second st-viewport-selected" }, { text: "x", className: "paint-first st-viewport-selected" },
        { text: "x", className: "paint-first" }, { text: "x".repeat(504), className: "" },
    ]);
});

test("a retained diagnostic, swatch and point follow typing and history in a scrolled editor", async ({ page }) => {
    const painted = await page.evaluate(async () => {
        const path = "/viewport-decorations/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "editor.js") as typeof import("../../src/browser/text-editor.ts");
        const workspace = new Workspace(), target = 500;
        const lines = Array<string>(1000).fill("const item = 1;");
        lines[target] = "paint red"; lines[target + 1] = "";
        const id = workspace.createDocument({ scope: "test", resource: "marks", variant: "text" }, "Paint", lines.join("\r\n"));
        const host = document.createElement("div"), style = document.createElement("style");
        style.textContent = ".swatch { width: .7em; height: .7em; background: var(--color) }";
        host.style.cssText = "position:fixed;inset:0;width:700px;height:260px";
        document.body.append(style, host);
        const editor = mountTextEditor(host, workspace, id, { ariaLabel: "Layer source" });
        const visited: number[] = [];
        editor.decorations.addProvider({ order: 0, provide: line => {
            visited.push(line.line); return [{ from: line.from, to: line.to, className: "test-token" }];
        } });
        const layer = editor.decorations.add({ order: 30 });
        const buffer = workspace.document(id).buffer, start = buffer.offsetAt(target), point = buffer.offsetAt(target + 1);
        editor.view.setSelection(0, { anchor: start, head: start }); editor.viewport.revealOffset(start); editor.viewport.flush(); editor.focus();
        editor.viewport.flush(); visited.length = 0;
        const range = { from: start + 6, to: start + 9, className: "test-diagnostic", before: "swatch",
            properties: { "--color": "rgb(189, 44, 31)" }, afterLine: "<b>error</b>" };
        layer.set(0, [range, { from: point, to: point, className: "missing" }]);
        range.properties["--color"] = "black";
        editor.viewport.flush();
        const visits = [...visited], swatch = host.querySelector<HTMLElement>(".swatch")!, mark = host.querySelector<HTMLElement>(".missing")!;
        visited.length = 0;
        layer.set(0, [{ ...range, properties: { "--color": "rgb(189, 44, 31)" } }, { from: point, to: point, className: "missing-again" }]);
        editor.viewport.flush();
        const changed = [...visited];
        const text = host.querySelector('.st-viewport-row[data-line="500"]')!.textContent;
        const label = host.querySelector<HTMLElement>('[data-ornament="afterLine"]')!;
        const stamp = () => {
            const line = host.querySelector<HTMLElement>('.st-viewport-row[data-line="500"]')!;
            const span = line.querySelector<HTMLElement>(".test-diagnostic:not([data-ornament])");
            return { text: line.textContent, word: span?.textContent, stale: layer.set(workspace.document(id).revision - 1, []),
                offset: span && editor.viewport.hitTest(span.getBoundingClientRect().left + 1, span.getBoundingClientRect().top + 5)?.offset,
                revision: workspace.document(id).revision, start };
        };
        Object.assign(window, { inspectMarks: stamp, indentMany: () => {
            const doc = workspace.document(id);
            const edits = Array.from({ length: 200 }, (_, i) => {
                const at = doc.buffer.offsetAt(i * 5); return { from: at, to: at, insert: "  " };
            });
            return workspace.edit({ documentId: id, expectedRevision: doc.revision, edits, origin: "human" }).status === "done";
        }, clearMarks: () => { layer.dispose(); editor.viewport.flush(); return layer.set(workspace.document(id).revision, []); } });
        return { visits, changed, text, label: label.dataset.label, markup: !!label.querySelector("b"),
            width: parseFloat(getComputedStyle(host.querySelector(".missing-again")!, "::after").width), replaced: !mark.isConnected,
            color: getComputedStyle(swatch).backgroundColor };
    });
    expect(painted).toMatchObject({ visits: [500, 501], changed: [501], replaced: true, text: "paint red", label: "<b>error</b>", markup: false, color: "rgb(189, 44, 31)" });
    expect(painted.width).toBeGreaterThan(1);
    const input = page.getByRole("textbox", { name: "Layer source", exact: true });
    const inspect = () => page.evaluate(() => (window as unknown as { inspectMarks(): {
        text: string; word: string; stale: boolean; offset: number; revision: number; start: number } }).inspectMarks());
    await input.press("Home"); await page.keyboard.insertText("// ");
    const start = (await inspect()).start;
    await expect.poll(inspect).toMatchObject({ text: "// paint red", word: "red", stale: false, offset: start + 9, revision: 1 });
    await input.press("Control+z");
    await expect.poll(inspect).toMatchObject({ text: "paint red", word: "red", offset: start + 6, revision: 2 });
    await input.press("Control+y");
    await expect.poll(inspect).toMatchObject({ text: "// paint red", word: "red", offset: start + 9, revision: 3 });
    expect(await page.evaluate(() => (window as unknown as { indentMany(): boolean }).indentMany())).toBe(true);
    await input.press("Home"); await page.keyboard.insertText("!");
    await expect.poll(inspect).toMatchObject({ text: expect.stringContaining("!"), word: "red", offset: start + 212, revision: 5 });
    await expect(page.locator(".missing-again")).toHaveCount(1);
    await input.press("End"); await input.press("Shift+ArrowDown"); await input.press("Shift+ArrowDown");
    await input.press("Delete");
    await expect.poll(inspect).toMatchObject({ word: "red", revision: 6 });
    await expect(page.locator(".missing-again")).toHaveCount(0);
    await input.press("Control+z");
    await expect.poll(inspect).toMatchObject({ word: "red", revision: 7 });
    await expect(page.locator(".missing-again")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { clearMarks(): boolean }).clearMarks())).toBe(false);
    await expect(page.locator(".swatch, .test-diagnostic, .missing-again")).toHaveCount(0);
});
