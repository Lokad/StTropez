import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, firefox, webkit } from "@playwright/test";
import { startServer } from "./serve.mjs";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";

const source = await sourceIdentity(), server = await startServer(0), engines = [];
try {
    for (const [name, type] of Object.entries({ chromium, firefox, webkit })) {
        const browser = await type.launch({ headless: true }), errors = [];
        try {
            const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on("pageerror", error => errors.push(error.message));
            await page.goto(`${server.url}/shaping/`); await page.waitForFunction(() => window.shapingFixture?.ready); await page.evaluate(() => window.shapingFixture.fontsReady());
            const display = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio, colorDepth: screen.colorDepth })), cases = [];
            for (const config of [{ name: "kerning", kind: "kerning" }, { name: "tabs", kind: "tabs" }, { name: "transparent-marks", kind: "marks" },
                { name: "distant-override", kind: "override" }, { name: "ltr-10000", kind: "ltr", length: 10_000 }, { name: "ltr-200000", kind: "ltr", length: 200_000 },
                { name: "ltr-2400000", kind: "ltr", length: 2_400_000 }, { name: "mixed-200000", kind: "mixed" }]) {
                const samples = [];
                for (let trial = 0; trial < 23; trial++) {
                    const sample = await page.evaluate(config => new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => reject(new Error("Native shaping sample timed out.")), 30_000);
                        requestAnimationFrame(() => { try {
                        const f = window.shapingFixture, block = "abc אבג (12) \u2067العربية\u2069 👩‍💻 á ";
                        const text = config.kind === "kerning" ? "AVATAR office affinity" : config.kind === "tabs" ? "ab\tcd\te" : config.kind === "marks" ? "ل" + "\u064e".repeat(2048) + "ا"
                            : config.kind === "override" ? "\u202e" + "a".repeat(600) + "123\u202c" : config.kind === "mixed" ? block.repeat(Math.ceil(200_000 / block.length)) : "a".repeat(config.length);
                        const points = config.kind === "kerning" ? [1] : config.kind === "tabs" ? [3] : config.kind === "marks" ? [text.length - 1]
                            : config.kind === "override" ? [601, 602, 603] : config.kind === "mixed" ? [4, Math.floor(text.length / block.length / 2) * block.length + 4, text.length - block.length + 4]
                            : [0, Math.floor(text.length / 2), text.length - 1];
                        const start = performance.now(), initial = f.mount(text), queries = [];
                        for (const from of points) for (const context of [0, 32, 512]) queries.push({ context, ...f.query(from, from + 1, Math.max(0, from - context), Math.min(text.length, from + 1 + context)) });
                        const editFrom = points[Math.floor(points.length / 2)], edit = f.replace(0, editFrom, editFrom + 1, "x"), mounted = f.snapshot();
                        f.dispose(); const released = f.snapshot(), hostNodes = f.hostNodes(), synchronousMs = performance.now() - start;
                        requestAnimationFrame(() => { clearTimeout(timeout); resolve({ initial, queries, editFrom, edit, mounted, released, hostNodes, synchronousMs, nextFrameProxyMs: performance.now() - start }); });
                        } catch (error) { clearTimeout(timeout); window.shapingFixture.dispose(); reject(error); } });
                    }), config);
                    assert.equal(sample.initial.domTextUnits, sample.initial.units); assert.equal(sample.initial.nativeTextNodes, 1);
                    assert.ok(sample.initial.style.canvasFont.includes(sample.initial.style.fontSize));
                    assert.equal(sample.mounted.domTextUnits, sample.initial.units + sample.queries.at(-1).windowTo - sample.queries.at(-1).windowFrom);
                    assert.deepEqual(sample.released, { disposed: true, revision: 1, domTextUnits: 0, nativeTextNodes: 0 }); assert.equal(sample.hostNodes, 0); assert.equal(sample.edit.readbackUnits, sample.initial.units);
                    for (const query of sample.queries) for (const rectangle of [...query.wholeBoxes, ...query.fragmentBoxes]) for (const value of Object.values(rectangle)) assert.ok(Number.isFinite(value));
                    if (trial >= 3) samples.push(sample);
                }
                const width = boxes => boxes.reduce((sum, box) => sum + box.width, 0);
                const disagreement = sample => ({ canvasWidthError: Math.abs(sample.initial.nativeWidth - sample.initial.canvasWidth),
                    queries: sample.queries.map(query => ({ from: query.from, context: query.context, wholeRectangles: query.wholeBoxes.length, fragmentRectangles: query.fragmentBoxes.length,
                        rangeWidthError: Math.abs(width(query.wholeBoxes) - width(query.fragmentBoxes)),
                        prefixOriginError: query.wholeBoxes[0] && query.fragmentBoxes[0] ? Math.abs(query.wholeBoxes[0].left - query.prefixWidth - query.fragmentBoxes[0].left) : null })) });
                const result = { name: config.name, units: samples[0].initial.units, warmup: 3, measured: samples.length,
                    prepareMs: distribution(samples.map(s => s.initial.prepareMs)), initialLayoutMs: distribution(samples.map(s => s.initial.layoutMs)), canvasMs: distribution(samples.map(s => s.initial.canvasMs)),
                    localNativeUpdateMs: distribution(samples.map(s => s.edit.updateMs)), localNativeLayoutMs: distribution(samples.map(s => s.edit.layoutMs)),
                    wholeQueryMs: distribution(samples.flatMap(s => s.queries.map(q => q.wholeQueryMs))), prefixMs: distribution(samples.flatMap(s => s.queries.map(q => q.prefixMs))),
                    synchronousMs: distribution(samples.map(s => s.synchronousMs)), nextFrameProxyMs: distribution(samples.map(s => s.nextFrameProxyMs)), disagreement: disagreement(samples[0]), samples };
                if (config.kind === "kerning") assert.ok(result.disagreement.queries[0].prefixOriginError > .2);
                if (config.kind === "tabs") assert.ok(result.disagreement.canvasWidthError > 1);
                if (config.kind === "marks") assert.ok(result.disagreement.queries.find(q => q.context === 512).rangeWidthError > 1);
                cases.push(result); console.log(JSON.stringify({ engine: name, name: config.name, layoutP95Ms: result.initialLayoutMs.p95, editLayoutP95Ms: result.localNativeLayoutMs.p95, synchronousP95Ms: result.synchronousMs.p95 }));
            }
            assert.deepEqual(errors, []); engines.push({ name, version: browser.version(), display, errors, cases });
        } finally { await browser.close(); }
    }
    assert.equal((await sourceIdentity()).sha256, source.sha256);
    await mkdir("artifacts/bench/shaping", { recursive: true });
    await writeFile("artifacts/bench/shaping/latest.json", JSON.stringify({ schemaVersion: 1, created: new Date().toISOString(), source, environment: environment(), engines,
        note: "Development oracle, excluded from production assets. Full paragraph HTML text is retained and synchronously laid out. DOM text assignment/readback, initial layout, native one-unit replacement layout, canvas measurement, full-context Range queries and prefix measurements have separate clocks. Prefix/fragment metrics are candidate measurements and deliberately disagree; raw range boxes are not certified caret/glyph advances, especially for ligatures/controls and engine coordinate limits. The first frame after the synchronous batch is a scheduling proxy, not physical paint. Input generation occurs outside the kernel clock. Repeated same-text trials are warm native diagnostics, not cold-font or production guarantees. Full source DOM and synchronous full-context work disqualify this path as the bounded renderer. No font shaper, worker or WASM is selected by this experiment." }, null, 2));
} finally { await server.close(); }
