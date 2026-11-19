import { test, expect } from "./fixtures.ts";
import { build } from "esbuild";
import { basename } from "node:path";

test("decorated viewport bounds endpoint reads and preserves overlap order, selection styling and child identity", async ({ page }) => {
    const built = await build({ entryPoints: { core: "src/index.ts", viewport: "src/browser/viewport.ts" }, outdir: "artifacts/viewport-decorations",
        bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", write: false });
    const modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text]));
    await page.route("**/viewport-decorations/**", route => {
        const body = modules.get(new URL(route.request().url()).pathname.split("/").at(-1)!);
        return body === undefined ? route.abort() : route.fulfill({ contentType: "text/javascript", body });
    });
    await page.goto("/viewport/");
    const result = await page.evaluate(async () => {
        const path = "/viewport-decorations/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextViewport } = await import(path + "viewport.js") as typeof import("../../src/browser/viewport.ts");
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "test", resource: "paint", variant: "text" }, "Paint", { value: "x".repeat(512) });
        const tab = workspace.open({ kind: "text", documentId: source.documentId }, "paint"), host = document.createElement("section"), style = document.createElement("style");
        host.style.cssText = "height:200px;width:1000px"; style.textContent = ".paint-first { color: rgb(200, 20, 30) } .paint-second { background-color: rgb(10, 30, 60) }"; document.body.append(host, style);
        let reads = 0, overlap = false;
        const disjoint = Array.from({ length: 256 }, (_, i) => ({ get from() { reads++; return i * 2; }, get to() { reads++; return i * 2 + 1; }, className: "paint-first" }));
        const combined = [{ from: 4, to: 8, className: "paint-first" }, { from: 0, to: 6, className: "paint-second" }, { from: 4, to: 5, className: "paint-first" }, { from: 0, to: 512, className: "invalid class" }];
        const viewport = mountTextViewport(host, workspace, tab, { decorate: () => overlap ? combined : disjoint });
        try {
            reads = 0; viewport.flush(); const endpointReads = reads, row = host.querySelector<HTMLElement>('.st-viewport-row[data-line="0"]')!;
            const exact = row.textContent === "x".repeat(512), colored = row.querySelectorAll(".paint-first").length;
            overlap = true; viewport.view.setSelection(0, { anchor: 3, head: 7 }); viewport.invalidate(); viewport.flush();
            const parts = [...row.childNodes].map(node => ({ text: node.textContent, className: node instanceof HTMLElement ? node.className : "" }));
            const first = row.querySelector<HTMLElement>(".paint-first.paint-second")!, paint = getComputedStyle(first);
            const color = paint.color, background = paint.backgroundColor, children = [...row.childNodes], texts = children.map(node => node.firstChild);
            viewport.invalidate(); viewport.flush();
            const reused = children.every((node, i) => row.childNodes[i] === node && node.firstChild === texts[i]);
            return { endpointReads, exact, colored, parts, color, background, reused, exports: workspace.document(source.documentId).buffer.readMetrics().textExports };
        } finally { viewport.dispose(); workspace.close(tab); workspace.releaseResource(source.id, true); host.remove(); style.remove(); }
    });
    expect(result).toMatchObject({ endpointReads: 512, exact: true, colored: 256, color: "rgb(200, 20, 30)", background: "rgb(10, 30, 60)", reused: true, exports: 0 });
    expect(result.parts).toEqual([
        { text: "xxx", className: "paint-second" }, { text: "x", className: "paint-second st-viewport-selected" },
        { text: "x", className: "paint-first paint-second paint-first st-viewport-selected" },
        { text: "x", className: "paint-first paint-second st-viewport-selected" }, { text: "x", className: "paint-first st-viewport-selected" },
        { text: "x", className: "paint-first" }, { text: "x".repeat(504), className: "" },
    ]);
});
