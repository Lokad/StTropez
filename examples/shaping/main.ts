import { mountNativeShapingProbe } from "../../experiments/native-shaping.ts";
import type { ShapingStyle } from "../../experiments/native-shaping.ts";
import { mountFontUI } from "./font-ui.ts";
import { mountUnicodeUI } from "./unicode-ui.ts";
import { mountFallbackUI } from "./fallback-ui.ts";
import { TextBuffer, normalizeText, graphemeBoundaries, createGraphemeCursor, BidiCursor } from "../../src/index.ts";
import type { NormalizationForm } from "../../src/index.ts";

const host = document.getElementById("probe-host")!, output = document.getElementById("result")!, sample = document.getElementById("sample")!;
const font = mountFontUI(document);
const unicode = mountUnicodeUI(document, font);
const fallback = mountFallbackUI(document);
let probe: ReturnType<typeof mountNativeShapingProbe> | undefined;
let generation = 0, retained: Readonly<{ generation: number; value: NonNullable<ReturnType<NonNullable<typeof probe>["retainOrigins"]>> }> | undefined;
let presentedText = "";
const retainButton = document.getElementById("retain-origins") as HTMLButtonElement, releaseButton = document.getElementById("release-probe") as HTMLButtonElement;
function retain(expectedRevision: number, ranges: readonly Readonly<{ from: number; to: number }>[]) {
    const capturedGeneration = generation, value = probe!.retainOrigins(expectedRevision, ranges);
    if (!value || capturedGeneration !== generation) return null; retained = Object.freeze({ generation: capturedGeneration, value });
    return Object.freeze({ generation: capturedGeneration, revision: value.revision, font: value.font, samples: value.samples, index: value.index.diagnostics(), minimum: value.index.minimum, maximum: value.index.maximum });
}
function showOrigins() {
    const result = document.getElementById("origins")!; if (!retained) { result.textContent = "No retained observations."; return; }
    const index = retained.value.index, active = retained.generation === generation && probe?.snapshot().disposed === false && retained.value.revision === probe.snapshot().revision;
    result.textContent = [`Retained ${index.length} native origins · ${active ? "current probe" : "historical observation"}`,
        ...retained.value.samples.slice(0, 6).map((s, i) => `Source ${s.from}..${s.to}: ${index.prefix(i + 1).toFixed(3)} px`),
        `Probe DOM text: ${probe?.snapshot().domTextUnits ?? 0} units`, "These sparse observations do not supply a complete glyph layout."].join("\n");
}
const cases = { kerning: { text: "AVATAR office affinity", from: 1, to: 2, windowFrom: 1, windowTo: 6 },
    arabic: { text: "ب".repeat(80), from: 40, to: 41, windowFrom: 40, windowTo: 48 },
    isolate: { text: "abc \u2067" + "א".repeat(80) + " 123\u2069 end", from: 86, to: 87, windowFrom: 80, windowTo: 89 },
    tabs: { text: "ab\tcd\te", from: 3, to: 4, windowFrom: 3, windowTo: 7 } };
document.getElementById("run")!.addEventListener("click", () => {
    const data = cases[(document.getElementById("corpus") as HTMLSelectElement).value as keyof typeof cases];
    probe?.dispose(); generation++; probe = mountNativeShapingProbe(host, data.text); sample.textContent = data.text;
    presentedText = data.text; retainButton.disabled = false; releaseButton.disabled = false; showOrigins();
    document.getElementById("fragment")!.textContent = data.text.slice(data.windowFrom, data.windowTo);
    const query = probe.query(data.from, data.to, data.windowFrom, data.windowTo), numeric = (value: number) => value.toFixed(3);
    output.textContent = [`Font: ${probe.initial.style.font}`, `Native paragraph width: ${numeric(probe.initial.nativeWidth)} px`, `Canvas paragraph width: ${numeric(probe.initial.canvasWidth)} px`,
        `Queried source range: ${data.from}..${data.to}; fragment range: ${data.windowFrom}..${data.windowTo}`,
        `Full-context ranges (left, width): ${query.wholeBoxes.map(b => `${numeric(b.left)}, ${numeric(b.width)}`).join(" / ")}`,
        `Fragment ranges (left, width): ${query.fragmentBoxes.map(b => `${numeric(b.left)}, ${numeric(b.width)}`).join(" / ")}`,
        `Canvas prefix width: ${numeric(query.prefixWidth)} px`, `Probe DOM text: ${query.domTextUnits} UTF-16 units`,
        `Initial native layout: ${numeric(probe.initial.layoutMs)} ms`, "Raw range rectangles are observations, not certified caret or glyph advances."].join("\n");
});
retainButton.addEventListener("click", () => {
    const ranges = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(presentedText)].filter(p => /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(p.segment))
        .slice(0, 128).map(p => ({ from: p.index, to: p.index + p.segment.length }));
    retain(probe!.snapshot().revision, ranges); showOrigins();
});
releaseButton.addEventListener("click", () => { probe?.dispose(); retainButton.disabled = true; releaseButton.disabled = true; showOrigins(); });
const fixture = Object.freeze({ ready: true,
    font,
    unicode,
    fallback,
    normalize: (text: string, form: NormalizationForm) => normalizeText(TextBuffer.from(text), { form }).text(),
    graphemes: (text: string) => graphemeBoundaries(text),
    ranges: (text: string, from: number, to: number) => {
        const buffer = TextBuffer.from(text), normalized = normalizeText(buffer, { from, to, form: "none" }), graphemes = createGraphemeCursor(buffer, { from, to }), bidi = new BidiCursor(buffer, { from, to, direction: "rtl" });
        try { let g = graphemes.next(), b = bidi.next(); while (g.status === "running") g = graphemes.next(); while (b.status === "running") b = bidi.next(); return { points: Array.from({ length: normalized.length }, (_, i) => normalized.at(i)), boundaries: g.result!.boundaries(), scanned: [g.scannedUnits, b.scannedUnits], lastLevel: to > from ? b.result!.levelAt(to - 1) : null }; }
        finally { graphemes.dispose(); bidi.dispose(); }
    },
    mount: (text: string, style: ShapingStyle = {}) => { probe?.dispose(); generation++; probe = mountNativeShapingProbe(host, text, style); return probe.initial; },
    query: (from: number, to: number, windowFrom: number, windowTo: number) => probe!.query(from, to, windowFrom, windowTo),
    replace: (expectedRevision: number, from: number, to: number, insert: string) => probe!.replace(expectedRevision, from, to, insert),
    retain,
    retainedOrigin: (ordinal: number) => { retained!.value.index.at(ordinal); return retained!.value.index.prefix(ordinal + 1); },
    retainedCurrent: () => retained !== undefined && retained.generation === generation && probe?.snapshot().disposed === false && retained.value.revision === probe.snapshot().revision,
    clearOrigins: () => { retained = undefined; },
    retainedSnapshot: () => retained ? Object.freeze({ generation: retained.generation, revision: retained.value.revision, samples: retained.value.samples, index: retained.value.index.diagnostics() }) : null,
    snapshot: () => probe?.snapshot(), dispose: () => probe?.dispose(), hostNodes: () => host.childElementCount,
    fontsReady: () => document.fonts.ready.then(() => undefined) });
Object.assign(window, { shapingFixture: fixture });
declare global { interface Window { shapingFixture: typeof fixture } }
