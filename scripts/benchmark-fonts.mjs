import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { chromium, firefox, webkit } from "@playwright/test";
import { SfntFont, createAdvanceBuilder } from "../src/index.ts";
import { FontBytes, fontFixture } from "../tests/fixtures/consumer/font-fixture.ts";
import { startServer } from "./serve.mjs";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";

const source = await sourceIdentity(), bytes = fontFixture(), font = SfntFont.from(bytes), other = fontFixture({ advanceA: 800 });
const collection = new FontBytes(20 + bytes.length + other.length).tag(0, "ttcf").u32(4, 0x10000).u32(8, 2); let base = 20;
for (const [i, original] of [bytes, other].entries()) { const copy = new Uint8Array(original), view = new DataView(copy.buffer); for (let t = 0; t < view.getUint16(4); t++) { const p = 20 + t * 16; view.setUint32(p, view.getUint32(p) + base); } collection.u32(12 + i * 4, base).put(base, copy); base += copy.length; }
const pattern = [65, 32, 66, 102, 105, 0x1f600, 0x301, 67], expected = [600, 250, 700, 400, 200, 1000, 0, 500], codes = Uint32Array.from({ length: 200_000 }, (_, i) => pattern[i % pattern.length]);
const kernel = [];
for (const name of ["parse-face", "parse-collection", "nominal-200000", "variation-200000"]) {
    const samples = [];
    for (let trial = 0; trial < 23; trial++) {
        const start = performance.now(); let details;
        if (name.startsWith("parse")) {
            const decoded = SfntFont.from(name === "parse-face" ? bytes : collection.data, { faceIndex: name === "parse-face" ? 0 : 1 });
            details = { glyph: decoded.glyphIndex(65), advanceA: decoded.nominalGlyphMetrics(2).advanceWidth, bytes: decoded.metadata.byteLength };
            assert.equal(details.advanceA, name === "parse-face" ? 600 : 800);
        } else if (name === "nominal-200000") {
            const builder = createAdvanceBuilder(), steps = [], values = new Float64Array(256); let sum = 0;
            for (let from = 0; from < codes.length; from += 256) {
                const stepStart = performance.now(), length = Math.min(256, codes.length - from);
                for (let i = 0; i < length; i++) { const code = codes[from + i], glyph = font.glyphIndex(code), value = font.nominalGlyphMetrics(glyph).advanceWidth; values[i] = value; sum += value; }
                builder.append(values, 0, length); steps.push(performance.now() - stepStart);
            }
            const index = builder.finish(); builder.dispose(); assert.equal(index.total, 91_250_000); assert.equal(sum, index.total);
            for (let i = 0; i < pattern.length; i++) assert.equal(index.at(i), expected[i]);
            const window = index.window(index.prefix(index.length - 16), index.total); assert.equal(window.truncated, false);
            details = { total: index.total, units: index.length, steps, window, diagnostics: index.diagnostics() };
        } else {
            let checksum = 0, unsupported = 0;
            for (let i = 0; i < 200_000; i++) { const choice = i % 4, glyph = font.variationGlyphIndex(choice < 2 ? 65 : 66, choice === 0 ? 0xfe00 : choice === 3 ? 0xe0100 : 0xfe0f); if (glyph === null) unsupported++; else checksum += glyph; }
            assert.equal(checksum, 500_000); assert.equal(unsupported, 100_000); details = { queries: 200_000, checksum, unsupported };
        }
        const totalMs = performance.now() - start; if (trial >= 3) samples.push({ totalMs, ...details });
    }
    kernel.push({ name, warmup: 3, measured: samples.length, totalMs: distribution(samples.map(s => s.totalMs)), samples });
    console.log(JSON.stringify({ name, p95Ms: kernel.at(-1).totalMs.p95 }));
}
const server = await startServer(0), engines = [];
try {
    for (const [name, type] of Object.entries({ chromium, firefox, webkit })) {
        const browser = await type.launch({ headless: true }), errors = [];
        try {
            const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on("pageerror", error => errors.push(error.message));
            await page.goto(`${server.url}/shaping/`); await page.waitForFunction(() => window.shapingFixture?.ready); const cases = [];
            for (const kind of ["load", "replace", "cancel"]) {
                const samples = [];
                for (let trial = 0; trial < 13; trial++) {
                    const sample = await page.evaluate(async kind => {
                        const f = window.shapingFixture.font, asset = f.createAsset("font-benchmark"), input = f.fixtureBytes(), revised = f.fixtureBytes(800), before = document.fonts.size, start = performance.now();
                        try {
                            const first = asset.request(0, input), requestMs = performance.now() - start; input.fill(0);
                            const second = kind === "replace" ? asset.request(1, revised) : null; if (kind === "cancel") asset.cancel();
                            const results = await Promise.all([first.settled, ...(second ? [second.settled] : [])]), readyProxyMs = performance.now() - start, current = asset.getSnapshot().current;
                            let nominal = null, widths = null, family = null;
                            if (current) { const ctx = document.createElement("canvas").getContext("2d"); ctx.font = `100px ${current.family}`; ctx.fontKerning = "normal"; family = current.family;
                                nominal = current.data.nominalGlyphMetrics(2).advanceWidth; widths = ["A B", "AB", "fi", "A\ufe0f", "😀"].map(text => ({ text, width: ctx.measureText(text).width })); }
                            const generation = current?.generation ?? null, active = current ? asset.isCurrent(current.generation) : false, facesWhileReady = document.fonts.size;
                            asset.dispose(); return { requestMs, readyProxyMs, results, generation, active, nominal, widths, family, before, facesWhileReady, after: document.fonts.size, status: asset.getSnapshot().status,
                                retainedA: current?.data.nominalGlyphMetrics(2).advanceWidth ?? null };
                        } finally { asset.dispose(); }
                    }, kind);
                    assert.equal(sample.after, sample.before); assert.equal(sample.status, "disposed");
                    if (kind === "cancel") { assert.equal(sample.results[0].status, "stale"); assert.equal(sample.active, false); assert.equal(sample.facesWhileReady, sample.before); }
                    else { assert.equal(sample.active, true); assert.equal(sample.facesWhileReady, sample.before + 1); assert.equal(sample.nominal, kind === "replace" ? 800 : 600); assert.equal(sample.retainedA, sample.nominal);
                        assert.equal(sample.widths.find(row => row.text === "A B").width, kind === "replace" ? 175 : 155); assert.equal(sample.widths.find(row => row.text === "fi").width, 50); }
                    if (kind === "replace") assert.deepEqual(sample.results.map(result => result.status), ["stale", "ready"]);
                    if (trial >= 3) samples.push(sample);
                }
                cases.push({ name: kind, warmup: 3, measured: samples.length, requestMs: distribution(samples.map(s => s.requestMs)), readyProxyMs: distribution(samples.map(s => s.readyProxyMs)), samples });
            }
            assert.deepEqual(errors, []); engines.push({ name, version: browser.version(), errors, cases }); console.log(JSON.stringify({ engine: name, cases: cases.map(c => ({ name: c.name, readyProxyP95Ms: c.readyProxyMs.p95 })) }));
        } finally { await browser.close(); }
    }
    assert.equal((await sourceIdentity()).sha256, source.sha256); await mkdir("artifacts/bench/fonts", { recursive: true });
    await writeFile("artifacts/bench/fonts/latest.json", JSON.stringify({ schemaVersion: 1, created: new Date().toISOString(), source, environment: environment(), kernel, engines,
        note: "Original generated fixture bytes and nominal default-instance table metrics. No third-party font data or shaper is used. SFNT parsing, nominal lookup/index construction and variation lookup are separate kernels, with source/reference generation excluded. Nominal glyph mapping/metrics are not shaping: the fixture retains actual kerning and fi ligature features, which native rendering applies. Native variation widths are raw observations and may disagree across engines. Browser font operations execute real FontFace loading, captured generations, copied input, stale rejection and owned-face disposal; readyProxy includes scheduling and native load work, not presentation. Native load success is not a complete font sanitizer or glyph-rendering qualification. Load/parser work is global startup work, not ordinary editing. No system-font enumeration, compressed-font decoder, complete shaper, renderer integration, worker or WASM is selected. Desktop diagnostics, not production budgets." }, null, 2));
} finally { await server.close(); }
