import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { nativePositioningCases } from "../fixtures/positioning.ts";

test.beforeEach(async ({ page }) => { page.on("pageerror", error => { throw error; }); await page.goto("/shaping/"); await page.waitForFunction(() => window.shapingFixture?.ready); });

test("original GPOS fixtures retain actual native pixels, widths and explicit policy differences", async ({ page, browser }, info) => {
    const rows = []; await mkdir("artifacts/positioning-pixels", { recursive: true });
    for (const c of nativePositioningCases()) {
        const captured = await page.evaluateHandle(async c => {
            const asset = window.shapingFixture.font.createAsset(c.name), before = document.fonts.size;
            try {
                const loaded = await asset.request(0, new Uint8Array(c.bytes))!.settled; if (loaded.status !== "ready") throw new Error(asset.getSnapshot().failure ?? loaded.status);
                const current = asset.getSnapshot().current!, font = current.data; let at = 0;
                const glyphs = [...c.text].map(ch => { const from = at; at += ch.length; return { glyphId: font.glyphIndex(ch.codePointAt(0)!), source: { from, to: at } }; });
                const substituted = font.substitutionPlan({ features: c.substitute ? [{ tag: "liga" }] : [] }).apply(glyphs), result = font.positioningPlan({ features: [{ tag: c.feature }], direction: c.direction, legacyKerning: c.legacy, ppem: { x: 100, y: 100 }, contourPoints: c.points ?? [] }).apply(substituted);
                const style = { fontFamily: current.family, fontSize: "100px", fontKerning: c.legacy ? "normal" : "none", fontFeatureSettings: `"${c.feature}" 1, "liga" ${c.substitute ? 1 : 0}`, direction: c.direction, unicodeBidi: "bidi-override" };
                const span = document.createElement("span"); span.textContent = c.text; Object.assign(span.style, style, { display: "inline-block", whiteSpace: "pre" }); document.body.append(span); const nativeWidth = span.getBoundingClientRect().width; span.remove();
                const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), text = document.createElementNS(svg.namespaceURI, "text"); svg.id = "positioning-pixels"; svg.setAttribute("width", "800"); svg.setAttribute("height", "300");
                Object.assign(svg.style, { background: "white", position: "fixed", left: "0px", top: "0px", display: "block", zIndex: "2147483647" }); text.setAttribute("x", "300"); text.setAttribute("y", "200"); text.setAttribute("fill", "black"); text.textContent = c.text; Object.assign((text as SVGElement).style, style); svg.append(text); document.body.append(svg);
                // Independent known rectangle outlines of the original fixture; no native range/pen API stands in for ink.
                const nominal = [500, 250, 600, 700, 400, 200, 500, 1000, 900, 0], rectangles = result.glyphs.filter(g => g.source.glyphId !== 1).map(g => {
                    const id = g.source.glyphId, width = id === 9 ? 150 : Math.max(100, nominal[id]! - 100), bottom = id === 9 ? 700 : 0, height = id === 9 ? 150 : 700;
                    return { left: 300 + g.x / 10, right: 300 + (g.x + width) / 10, top: 200 - (g.y + bottom + height) / 10, bottom: 200 - (g.y + bottom) / 10 };
                });
                return { asset, svg, before, data: { nativeWidth, coreWidth: Math.abs(result.advances.total) / 10, rectangles, glyphs: result.glyphs, dpr: devicePixelRatio } };
            } catch (error) { asset.dispose(); throw error; }
        }, { ...c, bytes: Array.from(c.bytes) });
        try {
            const data = await (await captured.getProperty("data")).jsonValue() as { nativeWidth: number; coreWidth: number; dpr: number; glyphs: unknown; rectangles: { left: number; right: number; top: number; bottom: number }[] }, png = await page.locator("#positioning-pixels").screenshot({ path: `artifacts/positioning-pixels/${info.project.name}-${c.name}.png` });
            const pixels = await page.evaluate(async ({ png, rectangles }) => {
                const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode(); const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
                const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0); const rgba = context.getImageData(0, 0, image.width, image.height).data;
                let mismatches = 0, compared = 0, ignored = 0, left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
                for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
                    const p = (y * image.width + x) * 4, actual = rgba[p]! < 128 && rgba[p + 1]! < 128 && rgba[p + 2]! < 128; if (actual) { left = Math.min(left, x); right = Math.max(right, x + 1); top = Math.min(top, y); bottom = Math.max(bottom, y + 1); }
                    const px = x + .5, py = y + .5, near = rectangles.some(r => px >= r.left - 1 && px <= r.right + 1 && (Math.abs(py - r.top) <= 1 || Math.abs(py - r.bottom) <= 1) || py >= r.top - 1 && py <= r.bottom + 1 && (Math.abs(px - r.left) <= 1 || Math.abs(px - r.right) <= 1));
                    if (near) { ignored++; continue; } compared++; if (actual !== rectangles.some(r => px >= r.left && px < r.right && py >= r.top && py < r.bottom)) mismatches++;
                }
                return { mismatches, compared, ignored, box: { left, right, top, bottom }, width: image.width, height: image.height };
            }, { png: png.toString("base64"), rectangles: data.rectangles });
            const engine = info.project.name, rtlPolicy = ["rtl-pair", "hebrew-rtl-pair", "hebrew-rtl-single"].includes(c.name), devicePolicy = c.name === "device-advance" && engine !== "firefox", singlePolicy = c.name === "single-character" && engine === "webkit";
            const webkitPlacement = engine === "webkit" && (["single-shared", "single-indexed", "cursive-first-baseline", "cursive-last-baseline", "mark-stack", "registered-hebrew-cursive", "single-placement-marked-control"].includes(c.name) || c.name.startsWith("context-") || c.name.startsWith("chain-"));
            expect(data.coreWidth, c.name).toBe(c.width); expect(data.dpr).toBe(1); expect(data.nativeWidth, c.name).toBe(rtlPolicy ? c.name === "hebrew-rtl-single" ? 120 : 130 : devicePolicy ? 120 : singlePolicy ? 60 : c.width);
            expect(pixels.width).toBe(800); expect(pixels.height).toBe(300); expect(pixels.compared).toBeGreaterThan(230_000);
            if (rtlPolicy || devicePolicy || singlePolicy || webkitPlacement || c.name === "contour-anchor") expect(pixels.mismatches, c.name).toBeGreaterThan(0);
            else expect(pixels.mismatches, c.name).toBe(0);
            rows.push({ name: c.name, text: c.text, direction: c.direction, fontSha256: createHash("sha256").update(c.bytes).digest("hex"), ...data, pixels });
        } finally { await captured.evaluate(c => { c.svg.remove(); c.asset.dispose(); if (document.fonts.size !== c.before) throw new Error("Owned font face leak."); }); await captured.dispose(); }
    }
    await writeFile(`artifacts/positioning-native-${info.project.name}.json`, JSON.stringify({ created: new Date().toISOString(), engine: info.project.name, browser: browser.version(), viewport: page.viewportSize(), fontSizePx: 100, ppem: 100, edgeAllowancePx: 1, rows }, null, 2));
});

test("captured positions and retained advances survive font replacement and native disposal", async ({ page }) => {
    const state = await page.evaluate(async () => {
        const f = window.shapingFixture.font; await f.request().settled; const old = f.asset.getSnapshot().current!, plan = old.data.positioningPlan({ features: [], legacyKerning: true }), input = old.data.substitutionPlan({ features: [] }).apply([2, 3].map((glyphId, from) => ({ glyphId, source: { from: 100_000 + from, to: 100_001 + from } }))), result = plan.apply(input);
        await f.request(800).settled; const stale = !f.asset.isCurrent(old.generation); f.asset.dispose();
        return { stale, same: result.font === old.data && plan.font === old.data, total: result.advances.total, prefix: result.advances.prefix(1), replay: plan.apply(input).advances.total, source: result.glyphs[0]!.source.sources, status: f.snapshot().status };
    });
    expect(state).toEqual({ stale: true, same: true, total: 1200, prefix: 500, replay: 1200, source: [{ from: 100_000, to: 100_001 }], status: "disposed" });
});

test("positioned signed advances retain bounded queries beyond native coordinate ranges", async ({ page }) => {
    const state = await page.evaluate(async () => {
        const f = window.shapingFixture.font; await f.request().settled; const font = f.asset.getSnapshot().current!.data, input = font.substitutionPlan({ features: [] }).apply(Array.from({ length: 100_000 }, (_, from) => ({ glyphId: 2, source: { from, to: from + 1 } })));
        const result = font.positioningPlan({ features: [], direction: "rtl" }).apply(input, { advanceWidths: Array(100_000).fill(1000) }), visible = result.advances.window(-99_990_000, -99_980_000); f.asset.dispose();
        return { total: result.advances.total, origin: result.advances.prefix(99_990), last: result.glyphs.at(-1)!.x, cells: visible.cells.length, reads: visible.readValues, truncated: visible.truncated };
    });
    expect(state).toMatchObject({ total: -100_000_000, origin: -99_990_000, last: -100_000_000, cells: 10, truncated: false }); expect(state.reads).toBeLessThanOrEqual(512);
});
