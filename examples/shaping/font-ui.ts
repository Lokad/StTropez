import { AdvanceIndex } from "../../src/index.ts";
import { createFontAssetController } from "../../src/browser/index.ts";
import { fontFixture } from "../../tests/fixtures/consumer/font-fixture.ts";
import { scriptFontFixture } from "../../tests/fixtures/script-layout.ts";

/** Host-owned font bytes with explicit lifecycle. Nominal table metrics do not select a shaper. */
export function mountFontUI(owner: Document) {
    const asset = createFontAssetController(owner, "fixture-font"), load = owner.getElementById("font-load") as HTMLButtonElement, replace = owner.getElementById("font-replace") as HTMLButtonElement,
        dispose = owner.getElementById("font-dispose") as HTMLButtonElement, output = owner.getElementById("font-status")!, sample = owner.getElementById("font-sample")!, listeners = new AbortController();
    const scriptLoad = owner.getElementById("font-script-load") as HTMLButtonElement;
    const canvas = owner.createElement("canvas"), context = canvas.getContext("2d")!;
    const measure = () => {
        const current = asset.getSnapshot().current; if (!current) return null;
        context.font = `100px ${current.family}`; context.fontKerning = "normal";
        const data = current.data, units = data.metadata.unitsPerEm;
        const cases = [{ text: "A B", glyphs: [data.glyphIndex(65), data.glyphIndex(32), data.glyphIndex(66)] },
            { text: "AB", glyphs: [data.glyphIndex(65), data.glyphIndex(66)] }, { text: "fi", glyphs: [data.glyphIndex(102), data.glyphIndex(105)] },
            { text: "😀", glyphs: [data.glyphIndex(0x1f600)] }, { text: "A\ufe0f", glyphs: [data.variationGlyphIndex(65, 0xfe0f) ?? data.glyphIndex(65)] }];
        const plan = data.substitutionPlan({ features: [{ tag: "liga" }] }), positioning = data.positioningPlan({ features: [], legacyKerning: true });
        return cases.map(config => {
            const index = AdvanceIndex.from(config.glyphs.map(glyph => data.nominalGlyphMetrics(glyph).advanceWidth));
            const input = config.glyphs.map((glyphId, i) => ({ glyphId, source: { from: i, to: config.glyphs.length === 1 ? config.text.length : i + 1 } })), substituted = plan.apply(input);
            const substitutedUnits = substituted.glyphs.reduce((sum, glyph) => sum + data.nominalGlyphMetrics(glyph.glyphId).advanceWidth, 0);
            const positioned = positioning.apply(substituted);
            return { text: config.text, glyphs: config.glyphs, nominalUnits: index.total, nominalPx: index.total * 100 / units, nativePx: context.measureText(config.text).width,
                substitutedGlyphs: substituted.glyphs, substitutedUnits, substitutedPx: substitutedUnits * 100 / units,
                positionedGlyphs: positioned.glyphs, positionedUnits: positioned.advances.total, positionedPx: positioned.advances.total * 100 / units };
        });
    };
    const render = () => {
        const state = asset.getSnapshot(), current = state.current; load.disabled = replace.disabled = scriptLoad.disabled = dispose.disabled = state.status === "disposed";
        if (current) sample.style.fontFamily = current.family;
        const rows = measure(); output.textContent = [`Font asset: ${state.fontId} · Request ${state.generation} · ${state.status}`,
            current ? `Active version ${current.generation} · ${current.data.metadata.glyphCount} glyphs · ${current.data.metadata.unitsPerEm} units/em` : "No registered fixture face.",
            ...(rows ?? []).map(row => `${JSON.stringify(row.text)}: nominal ${row.nominalPx.toFixed(3)} px; substituted ${row.substitutedPx.toFixed(3)} px; positioned ${row.positionedPx.toFixed(3)} px; native ${row.nativePx.toFixed(3)} px`),
            "Positioning uses explicit fixture kerning. Script analysis, native variation behavior, ink/carets and the complete font backend still need qualification.", state.failure ?? ""].filter(Boolean).join("\n");
    };
    const unsubscribe = asset.subscribe(render); render();
    const request = (advanceA = 600, omitOutlines = false) => {
        const bytes = fontFixture({ advanceA, omitOutlines }), operation = asset.request(asset.getSnapshot().generation, bytes)!; bytes.fill(0); return operation;
    };
    const requestScript = () => { const bytes = scriptFontFixture(), operation = asset.request(asset.getSnapshot().generation, bytes)!; bytes.fill(0); return operation; };
    load.addEventListener("click", () => { request(); }, { signal: listeners.signal }); replace.addEventListener("click", () => { request(800); }, { signal: listeners.signal });
    scriptLoad.addEventListener("click", () => { requestScript(); }, { signal: listeners.signal });
    dispose.addEventListener("click", () => asset.dispose(), { signal: listeners.signal });
    return Object.freeze({ asset, request, requestScript, measure,
        createAsset: (id: string) => createFontAssetController(owner, id), fixtureBytes: (advanceA = 600) => fontFixture({ advanceA }),
        snapshot: () => { const state = asset.getSnapshot(); return { fontId: state.fontId, generation: state.generation, status: state.status, failure: state.failure,
            current: state.current ? { generation: state.current.generation, family: state.current.family, metadata: state.current.data.metadata } : null }; },
        destroy: () => { listeners.abort(); unsubscribe(); asset.dispose(); }
    });
}
