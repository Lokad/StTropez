import { test, expect } from "./fixtures.ts";
import { build } from "esbuild";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";

for (const shadow of [false, true]) test(`${shadow ? "shadow" : "document"} caret placement measures every visible head before writes and remeasures after reveal`, async ({ page }, testInfo) => {
    const built = await build({ entryPoints: { core: "src/index.ts", viewport: "src/browser/viewport.ts", caret: "src/browser/input-caret.ts" },
        outdir: "artifacts/caret-placement", bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", write: false });
    const modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text]));
    await page.route("**/caret-placement/**", route => {
        const body = modules.get(new URL(route.request().url()).pathname.split("/").at(-1)!);
        return body === undefined ? route.abort() : route.fulfill({ contentType: "text/javascript", body });
    });
    await page.goto("/viewport/");
    const result = await page.evaluate(async ({ shadow, css }) => {
        const path = "/caret-placement/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextViewport } = await import(path + "viewport.js") as typeof import("../../src/browser/viewport.ts");
        const { mountInputCaret } = await import(path + "caret.js") as typeof import("../../src/browser/input-caret.ts");
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "test", resource: "caret", variant: "text" }, "Caret", { value: ("0123456789".repeat(16) + "\n").repeat(1000) });
        const tab = workspace.open({ kind: "text", documentId: source.documentId }, "caret"), host = document.createElement("section");
        const container = document.createElement("div"); document.body.append(container);
        const tree = shadow ? container.attachShadow({ mode: "closed" }) : container;
        const style = document.createElement("style"); style.textContent = css; tree.append(style, host);
        host.style.cssText = "height:220px;width:800px;position:fixed;top:10px;left:10px";
        const viewport = mountTextViewport(host, workspace, tab), root = viewport.element, input = document.createElement("textarea");
        root.classList.add("st-editor"); input.className = "st-input-context"; root.append(input);
        const binding = viewport.bindInput(() => input.focus({ preventScroll: true }));
        let composing = false, queries = 0, reveals = 0;
        const layer = mountInputCaret(root, input, viewport.view, { ...viewport,
            coordsAt: (...args) => { queries++; return viewport.coordsAt(...args); },
            revealOffset: (...args) => { reveals++; viewport.revealOffset(...args); } }, () => workspace.document(source.documentId), () => composing);
        const primary = root.querySelector<HTMLElement>(".st-input-caret")!;
        const run = () => {
            const request = window.requestAnimationFrame; let callback: FrameRequestCallback | undefined;
            window.requestAnimationFrame = work => { callback = work; return 0; };
            try { layer.schedule(); } finally { window.requestAnimationFrame = request; }
            if (!callback || !layer.pending()) throw new Error("Caret frame was not scheduled");
            callback(performance.now()); if (layer.pending()) throw new Error("Caret frame did not finish");
        };
        const select = (heads: number[]) => { viewport.view.setSelections(0, heads.map(head => ({ anchor: head, head }))); viewport.flush(); };
        const nativePoint = (offset: number) => {
            const row = [...root.querySelectorAll<HTMLElement>(".st-viewport-row")].find(row => offset >= Number(row.dataset.from) && offset < Number(row.dataset.to))!;
            let remaining = offset - Number(row.dataset.from); const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (remaining >= node.textContent!.length) { remaining -= node.textContent!.length; continue; }
                const range = document.createRange(); range.setStart(node, remaining); range.setEnd(node, remaining + 1); return range.getBoundingClientRect();
            }
            throw new Error("Missing native caret oracle");
        };
        const error = (node: HTMLElement, offset: number) => {
            const actual = node.getBoundingClientRect(), native = nativePoint(offset);
            return Math.max(Math.abs(actual.left - native.left), Math.abs(actual.top - native.top));
        };
        const measure = (count: number) => {
            select(Array.from({ length: count }, (_, i) => i + 3));
            const observer = new MutationObserver(() => {}); observer.observe(root, { subtree: true, attributes: true, childList: true });
            let written = false, lateReads = 0; const reads: Record<string, number> = {}, late: string[] = [];
            const read = (name: string) => {
                written ||= observer.takeRecords().some(record => record.target === input || record.target === primary || primary.nextElementSibling?.contains(record.target));
                reads[name] = (reads[name] ?? 0) + 1;
                if (written) { lateReads++; if (late.length < 5) late.push(name); }
            };
            const rectangle = Element.prototype.getBoundingClientRect, ranges = Range.prototype.getClientRects, style = window.getComputedStyle;
            const properties = ["scrollLeft", "scrollTop", "clientWidth", "clientHeight"] as const;
            for (const name of properties) {
                const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, name)!;
                Object.defineProperty(root, name, { configurable: true, get() { read(name); return descriptor.get!.call(this); },
                    ...(descriptor.set ? { set(value: number) { descriptor.set!.call(this, value); } } : {}) });
            }
            Element.prototype.getBoundingClientRect = function () { read("rectangle"); return rectangle.call(this); };
            Range.prototype.getClientRects = function () { read("range"); return ranges.call(this); };
            window.getComputedStyle = (...args) => { read("style"); return style.apply(window, args); };
            queries = 0;
            try { run(); } finally {
                for (const name of properties) Reflect.deleteProperty(root, name);
                Element.prototype.getBoundingClientRect = rectangle; Range.prototype.getClientRects = ranges; window.getComputedStyle = style; observer.disconnect();
            }
            const secondary = [...root.querySelectorAll<HTMLElement>(".st-input-secondary-caret")];
            return { count, lateReads, late, reads, queries, secondary: secondary.length, hidden: primary.hidden,
                error: Math.max(error(primary, 3), ...secondary.map((node, i) => error(node, i + 4))) };
        };
        try {
            viewport.flush(); input.focus({ preventScroll: true });
            const work = [measure(1), measure(33)];
            composing = true; binding.setComposing(true); run();
            const composition = { hidden: primary.hidden, secondary: root.querySelectorAll(".st-input-secondary-caret").length };
            composing = false; binding.setComposing(false);
            select([60]); run(); const beforeResize = { visible: !primary.hidden, error: error(primary, 60) };
            host.style.width = "200px"; viewport.flush(); reveals = 0;
            // A synchronous host layout change during the reveal flush moves client coordinates.
            const stop = viewport.onRender(() => { stop(); host.style.left = "70px"; });
            run();
            const revealed = { reveals, visible: !primary.hidden, error: error(primary, 60), left: host.getBoundingClientRect().left };
            input.blur(); run(); const blurred = primary.hidden;
            input.focus({ preventScroll: true }); select([161 * 900]); run();
            const offscreen = { hidden: primary.hidden, height: parseFloat(input.style.height), expectedHeight: viewport.snapshot().lineHeight, reveals };
            layer.dispose(); layer.schedule();
            return { work, composition, beforeResize, revealed, blurred, offscreen, disposed: !layer.pending() && !root.contains(primary) };
        } finally { layer.dispose(); viewport.destroy(); workspace.close(tab); workspace.releaseResource(source.id, true); container.remove(); }
    }, { shadow, css: await readFile("src/browser/editor.css", "utf8") });
    await testInfo.attach("caret-placement", { body: JSON.stringify(result), contentType: "application/json" });
    for (const work of result.work) {
        expect(work.lateReads, JSON.stringify(work)).toBe(0);
        expect(work.reads.scrollLeft).toBe(1); expect(work.reads.scrollTop).toBe(1);
        expect(work.queries).toBe(work.count); expect(work.secondary).toBe(work.count - 1); expect(work.hidden).toBe(false); expect(work.error).toBeLessThan(1.1);
    }
    expect(result.composition).toEqual({ hidden: true, secondary: 0 });
    expect(result.beforeResize.visible).toBe(true); expect(result.beforeResize.error).toBeLessThan(1.1);
    expect(result.revealed).toMatchObject({ reveals: 1, visible: true, left: 70 }); expect(result.revealed.error).toBeLessThan(1.1);
    expect(result.blurred).toBe(true); expect(result.offscreen.hidden).toBe(true); expect(result.offscreen.reveals).toBe(1);
    expect(result.offscreen.height).toBeCloseTo(result.offscreen.expectedHeight, 3); expect(result.disposed).toBe(true);
});
