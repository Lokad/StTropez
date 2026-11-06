import { TextBuffer, normalizeText, createNormalizationCursor, FontCascade } from "../../src/index.ts";
import type { NormalizationCursor } from "../../src/index.ts";
import { createFontAssetController } from "../../src/browser/index.ts";
import { fallbackFontFixtures, fallbackNativeCases, visibilityNativeCases } from "../../tests/fixtures/fallback-layout.ts";
import { createFallbackPipeline } from "./fallback-pipeline.ts";
import type { FallbackResult } from "./fallback-pipeline.ts";
type Complete = Readonly<{ capture: Capture; result: FallbackResult }>;
type Capture = Readonly<{ request: number; revision: number; style: number; primary: number | null; secondary: number | null }>;
export function mountFallbackUI(owner: Document) {
    const win = owner.defaultView!, primary = createFontAssetController(owner, "cascade-primary"), secondary = createFontAssetController(owner, "cascade-secondary"), listeners = new AbortController(),
        source = owner.getElementById("cascade-source") as HTMLTextAreaElement, preference = owner.getElementById("cascade-preference") as HTMLSelectElement, output = owner.getElementById("cascade-status")!, canvas = owner.createElement("canvas"), context = canvas.getContext("2d")!;
    let request = 0, revision = 0, style = 0, timer = 0, steps = 0, status: "idle" | "running" | "ready" | "expired" | "cancelled" | "failed" | "disposed" = "idle", failure: string | null = null,
        job: { capture: Capture; normalizer: NormalizationCursor; cascade: FontCascade; preference: "composed" | "decomposed"; pipeline?: ReturnType<typeof createFallbackPipeline> } | null = null,
        complete: Complete | null = null, retained: Complete | null = null;
    const capture = (): Capture => Object.freeze({ request, revision, style, primary: primary.getSnapshot().current?.generation ?? null, secondary: secondary.getSnapshot().current?.generation ?? null });
    const current = (value: Capture) => { const now = capture(); return status !== "disposed" && Object.keys(now).every(k => now[k as keyof Capture] === value[k as keyof Capture]); };
    const stop = () => { win.clearTimeout(timer); timer = 0; job?.normalizer.dispose(); job?.pipeline?.dispose(); job = null; };
    const snapshot = () => Object.freeze({ status, request, revision, styleVersion: style, fontVersions: [primary.getSnapshot().current?.generation ?? null, secondary.getSnapshot().current?.generation ?? null], steps,
        phase: job?.pipeline?.snapshot().phase ?? (job ? "source" : null), failure, current: complete !== null && current(complete.capture), points: complete?.result.fonts.text.length ?? null,
        clusters: complete?.result.fonts.clusterCount ?? null, fontRuns: complete?.result.fonts.runCount ?? null, parts: complete?.result.parts.length ?? null, pixels: complete?.result.pixels ?? null,
        hiddenGlyphs: complete?.result.hiddenGlyphs ?? null,
        sourceExports: complete?.result.fonts.input.source.readMetrics().textExports ?? null });
    const render = () => { const state = snapshot(), result = complete?.result; output.textContent = [`Font cascade: ${status} · source ${revision} · style ${style} · request ${request}`,
            `Fonts: ${state.fontVersions.join(" / ")} · ${steps} scheduled steps${state.phase ? ` · ${state.phase}` : ""}`,
            result ? `Layout: ${state.points} points · ${state.clusters} graphemes · ${state.fontRuns} font runs · ${state.parts} script parts · ${state.pixels} px at 100px em` : "",
            result ? `Control visibility: ${state.hiddenGlyphs} hidden glyphs with zero advance` : "",
            ...(result ? Array.from({ length: Math.min(8, result.fonts.clusterCount) }, (_, i) => { const c = result.fonts.clusterAt(i); return `Source ${c.sourceFrom}..${c.sourceTo} → points ${c.textFrom}..${c.textTo}: font ${c.fontIndex + 1}, ${c.coverage} · missing ${c.missingGlyphs}, unsupported variations ${c.unsupportedVariations}`; }) : []),
            "Whole clusters use the host's ordered fonts. Canonical coverage preserves source spans and variation pairs. This fixture enables ccmp/locl and explicit script plans. Nominal coverage does not certify language models, variation-sequence validation, ink/carets, system font discovery or complete renderer integration.", failure ?? ""].filter(Boolean).join("\n"); };
    const expire = () => { if (status === "disposed") return; request++; stop(); complete = null; status = "expired"; render(); };
    const advance = () => {
        const active = job; if (!active || status !== "running") return; if (!current(active.capture)) { expire(); return; }
        try { steps++; let remaining = 32768, calls = 0; const began = win.performance.now();
            while (job === active && remaining > 0 && calls < 8 && (calls === 0 || win.performance.now() - began < 4)) { calls++; if (!active.pipeline) { const before = active.normalizer.snapshot().workUnits, step = active.normalizer.next(Math.min(4096, Math.max(256, remaining))); remaining -= Math.max(256, step.workUnits - before);
                    if (step.status === "ready") { active.pipeline = createFallbackPipeline(step.result!, active.cascade, active.preference); active.normalizer.dispose(); }
                } else { const before = active.pipeline.snapshot().workUnits, step = active.pipeline.next(Math.min(4096, Math.max(256, remaining))); remaining -= Math.max(256, step.workUnits - before);
                    if (step.status === "ready") { if (!current(active.capture)) { expire(); return; } complete = Object.freeze({ capture: active.capture, result: step.result! }); stop(); status = "ready"; render(); return; } }
            } if (job === active) { render(); timer = win.setTimeout(advance, 0); }
        } catch (error) { stop(); complete = null; status = "failed"; failure = error instanceof Error ? error.message : String(error); render(); }
    };
    const analyze = () => { if (status === "disposed") return; request++; stop(); complete = null; steps = 0; failure = null; const p = primary.getSnapshot().current, s = secondary.getSnapshot().current;
        if (!p || !s) { status = "failed"; failure = "Load both cascade fonts first."; render(); return; }
        job = { capture: capture(), normalizer: createNormalizationCursor(TextBuffer.from(source.value), { form: "none" }), cascade: FontCascade.from([p.data, s.data]), preference: preference.value as "composed" | "decomposed" }; status = "running"; render(); timer = win.setTimeout(advance, 0);
    };
    const load = async () => { const bytes = fallbackFontFixtures(); const p = primary.request(primary.getSnapshot().generation, bytes[0]), s = secondary.request(secondary.getSnapshot().generation, bytes[1]); await Promise.all([p?.settled, s?.settled]); render(); };
    const replace = async () => { const op = secondary.request(secondary.getSnapshot().generation, fallbackFontFixtures(true)[1]); await op?.settled; render(); };
    const replacePrimary = async () => { const op = primary.request(primary.getSnapshot().generation, fallbackFontFixtures()[0]); await op?.settled; render(); };
    const cancel = () => { if (status === "disposed") return; request++; stop(); complete = null; status = "cancelled"; render(); };
    const measure = (cases: readonly Readonly<{ name: string; text: string }>[] = fallbackNativeCases, details = false) => { const p = primary.getSnapshot().current, s = secondary.getSnapshot().current; if (!p || !s) return null; const cascade = FontCascade.from([p.data, s.data]); context.font = `100px ${p.family}, ${s.family}`; context.fontKerning = "normal";
        return cases.map(value => { const cursor = createFallbackPipeline(normalizeText(TextBuffer.from(value.text), { form: "none" }), cascade, "composed"); try { let step = cursor.next(65536); while (step.status === "running") step = cursor.next(65536); const result = step.result!, native = context.measureText(value.text).width;
                return { ...value, normalized: result.fonts.text.text(), clusters: Array.from({ length: result.fonts.clusterCount }, (_, i) => result.fonts.clusterAt(i)), parts: result.parts.map(v => ({ fontIndex: v.fontIndex, script: v.script, units: v.units, pixels: v.pixels, glyphs: v.positioned.glyphs.map(g => g.source.glyphId), substitution: v.substitution, positioning: v.positioned.selection,
                    ...(details ? { visibility: v.positioned.glyphs.map(g => ({ hidden: g.hidden, advance: g.xAdvance, properties: g.source.properties, sources: g.source.sources })) } : {}) })), core: result.pixels, native, difference: native - result.pixels };
            } finally { cursor.dispose(); } }); };
    for (const [id, action] of [["cascade-load", load], ["cascade-replace", replace], ["cascade-primary-replace", replacePrimary], ["cascade-run", analyze], ["cascade-cancel", cancel]] as const) owner.getElementById(id)!.addEventListener("click", () => { void action(); }, { signal: listeners.signal });
    source.addEventListener("input", () => { revision++; expire(); }, { signal: listeners.signal }); preference.addEventListener("change", () => { style++; expire(); }, { signal: listeners.signal });
    const unsubscribers = [primary, secondary].map(asset => asset.subscribe(() => { if (job && !current(job.capture) || complete && !current(complete.capture)) expire(); else render(); }));
    render(); const dispose = () => { if (status === "disposed") return; request++; stop(); complete = null; retained = null; status = "disposed"; listeners.abort(); unsubscribers.forEach(f => f()); primary.dispose(); secondary.dispose(); render(); };
    win.addEventListener("pagehide", dispose, { once: true }); return Object.freeze({ snapshot, load, replace, replacePrimary, analyze, cancel, measure, measureVisibility: () => measure(visibilityNativeCases, true), dispose,
        clusterAt: (index: number) => complete?.result.fonts.clusterAt(index) ?? null, pointAt: (index: number) => complete?.result.fonts.text.at(index) ?? null,
        retain: () => { retained = complete; }, retained: () => retained ? { current: current(retained.capture), pixels: retained.result.pixels, first: retained.result.fonts.text.at(0), fonts: retained.result.fonts.cascade.length } : null });
}
