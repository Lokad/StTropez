import { test, expect } from "./fixtures.ts";
import { build } from "esbuild";

test("lazy caret points match full native preparation before and after reordered queries", async ({ page }, testInfo) => {
    const built = await build({ entryPoints: ["src/browser/text-geometry.ts"], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false });
    await page.route("**/text-geometry-owner.js", route => route.fulfill({ contentType: "text/javascript", body: built.outputFiles[0]!.text }));
    await page.goto("/viewport/");
    const result = await page.evaluate(async () => {
        const path = "/text-geometry-owner.js", { rowGeometry } = await import(path) as typeof import("../../src/browser/text-geometry.ts");
        await document.fonts.ready;
        const row = document.createElement("div"); document.body.append(row);
        const texts = ["", "x", "office affine ffi fl", "abc אבג xyz", "abc العربية 123 xyz", "a é 👩‍💻 z", "a\t東京\txyz",
            "\u202exyz\u202c", "a \u2067אבג 123\u2069 z", "a (אבג [12]) z", "a \u2068אבג \u2066xy\u2069\u2069 z",
            "\u200e\u200f\u061c", "\u2066\u2069\u202e\u202c", "a\u200b\u200b\u200bب", "\u200fב\u200e", "\u200bstart\u200b",
            "\u0301\u200d\u200b", "a\r\nb\n", "a\u2028ב\u2029z", "x\ud800y\udc00z"];
        let checked = 0, cases = 0, seed = 0x51a7;
        const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
        try {
            for (const font of ["monospace", "serif", "sans-serif"]) for (const direction of ["ltr", "rtl"]) for (const split of [false, true]) for (const text of texts) {
                row.style.cssText = `position:fixed;left:40px;top:40px;width:max-content;height:24px;white-space:pre;font:16px/24px ${font};direction:${direction};font-variant-ligatures:normal;letter-spacing:${split ? ".35px" : "0"};zoom:${split ? 1.25 : 1}`;
                if (split) { const a = document.createElement("span"), b = document.createElement("span"), middle = text.length >>> 1;
                    a.textContent = text.slice(0, middle); b.textContent = text.slice(middle); row.replaceChildren(a, b); }
                else row.textContent = text;
                const from = 37, revision = 9, height = 24 * (split ? 1.25 : 1), eager = rowGeometry(row, from, revision, height);
                eager.edge(-1); // Force complete preparation before collecting the reference points.
                const requests = Array.from({ length: text.length + 1 }, (_, offset) => (["before", "after"] as const).map(affinity => ({ offset: from + offset, affinity }))).flat();
                const expected = new Map(requests.map(request => [request.offset + request.affinity, eager.point(request.offset, request.affinity)]));
                for (let i = requests.length - 1; i > 0; i--) { const at = random() % (i + 1); [requests[i], requests[at]] = [requests[at]!, requests[i]!]; }
                const series = rowGeometry(row, from, revision, height), values = [];
                for (const request of requests) {
                    const fresh = rowGeometry(row, from, revision, height), first = fresh.point(request.offset, request.affinity), reference = expected.get(request.offset + request.affinity);
                    const point = series.point(request.offset, request.affinity); values.push(point);
                    fresh.edge(1); const after = fresh.point(request.offset, request.affinity);
                    if ([first, point, after].some(value => JSON.stringify(value) !== JSON.stringify(reference)))
                        return { checked, cases, mismatch: { text, font, direction, split, request, reference, first, point, after } };
                    checked++;
                }
                series.edge(1);
                for (const [index, request] of requests.entries()) if (JSON.stringify(series.point(request.offset, request.affinity)) !== JSON.stringify(values[index]))
                    return { checked, cases, mismatch: { text, font, direction, split, request, phase: "series after full preparation" } };
                cases++;
            }
            return { checked, cases, mismatch: null };
        } finally { row.remove(); }
    });
    await testInfo.attach("point-equivalence", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.mismatch).toBeNull(); expect(result.cases).toBe(240); expect(result.checked).toBeGreaterThan(4000);
});
