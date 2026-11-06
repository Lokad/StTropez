import { TextBuffer, createNormalizationCursor, createScriptItemizationCursor, createScriptGlyphCursor, unicodeScript, unicodeScriptExtensions, unicodeCategory, canonicalCombiningClass } from "../../src/index.ts";
import type { NormalizationCursor, NormalizationForm, NormalizedText, GlyphMappingCursor, GlyphMappingResult, SubstitutionCursor, SubstitutionResult, PositioningCursor, PositioningResult, SfntFont, ScriptItemizationCursor, ScriptIndex, ScriptGlyphCursor, ScriptGlyphIndex, SubstitutionPlan, PositioningPlan } from "../../src/index.ts";
import type { mountFontUI } from "./font-ui.ts";

type Capture = Readonly<{ generation: number; revision: number; style: number; font: number | null }>;
type Job = { capture: Capture; font: SfntFont | null; stage: "normalize" | "script" | "map" | "partition" | "substitute" | "position";
    normalizer: NormalizationCursor; normalized?: NormalizedText; itemizer?: ScriptItemizationCursor; scripts?: ScriptIndex; mapper?: GlyphMappingCursor; mapped?: GlyphMappingResult;
    partitioner?: ScriptGlyphCursor; parts?: ScriptGlyphIndex; part: number; substitution?: SubstitutionCursor; shaped?: SubstitutionResult; positioning?: PositioningCursor;
    plans: Map<string, Readonly<{ sub: SubstitutionPlan; pos: PositioningPlan }>>; positioned: PositioningResult[]; glyphs: number; advance: number };
type Complete = Readonly<{ capture: Capture; normalized: NormalizedText; scripts: ScriptIndex; mapped: GlyphMappingResult | null; parts: ScriptGlyphIndex | null;
    positioned: readonly PositioningResult[]; glyphs: number | null; advance: number | null }>;
// Explicit diagnostic policy for the original fixtures; this is not a complete ISO15924/OpenType mapping.
const scriptTag = (script: string) => script === "Latn" ? "latn" : script === "Grek" ? "grek" : script === "Hebr" ? "hebr" : "DFLT";
const previewText = (value: string) => JSON.stringify(value).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Diagnostic host lifecycle, independent of the editor resource/document/tab controller. */
export function mountUnicodeUI(owner: Document, font: ReturnType<typeof mountFontUI>) {
    const source = owner.getElementById("unicode-source") as HTMLTextAreaElement, form = owner.getElementById("unicode-form") as HTMLSelectElement,
        run = owner.getElementById("unicode-run") as HTMLButtonElement, cancel = owner.getElementById("unicode-cancel") as HTMLButtonElement,
        output = owner.getElementById("unicode-status")!, listeners = new AbortController(), view = owner.defaultView!;
    let revision = 0, style = 0, generation = 0, steps = 0, timer = 0, status: "idle" | "running" | "ready" | "expired" | "cancelled" | "failed" | "disposed" = "idle", failure: string | null = null,
        job: Job | null = null, complete: Complete | null = null;
    const activeFont = () => font.asset.getSnapshot().current?.generation ?? null;
    let observedFont = activeFont();
    const current = (capture: Capture) => capture.generation === generation && capture.revision === revision && capture.style === style && capture.font === activeFont();
    const stop = () => { view.clearTimeout(timer); timer = 0; job?.normalizer.dispose(); job?.itemizer?.dispose(); job?.mapper?.dispose(); job?.partitioner?.dispose(); job?.substitution?.dispose(); job?.positioning?.dispose(); job = null; };
    const snapshot = () => Object.freeze({ status, generation, revision, styleVersion: style, fontVersion: observedFont, steps, stage: job?.stage ?? null, failure,
        capturedRevision: job?.capture.revision ?? complete?.capture.revision ?? null, capturedStyle: job?.capture.style ?? complete?.capture.style ?? null,
        capturedFont: job?.capture.font ?? complete?.capture.font ?? null, current: complete !== null && current(complete.capture),
        points: complete?.normalized.length ?? null, normalizedUnits: complete?.normalized.utf16Length ?? null, glyphs: complete?.glyphs ?? null,
        scriptRuns: complete?.scripts.runCount ?? null, clusters: complete?.scripts.clusterCount ?? null, scriptParts: complete?.parts?.length ?? null,
        missingGlyphs: complete?.mapped?.missingGlyphs ?? null, unsupportedVariations: complete?.mapped?.unsupportedVariations ?? null,
        advanceUnits: complete?.advance ?? null, preview: complete?.normalized.text(0, Math.min(80, complete.normalized.length)) ?? null });
    const render = () => {
        run.disabled = status === "disposed"; cancel.disabled = status !== "running"; const state = snapshot();
        output.textContent = [`Unicode layout analysis: ${status} · source ${revision} · style ${style} · request ${generation}`,
            job ? `${job.stage} · ${steps} scheduled steps` : "",
            complete ? `Normalized: \u2068${previewText(state.preview!)}\u2069 · ${state.points} points / ${state.normalizedUnits} UTF-16 units` : "",
            complete ? `Resolved ${state.scriptRuns} script runs / ${state.clusters} grapheme clusters (Unicode 18)` : "",
            complete?.mapped ? `Mapped ${complete.mapped.run.length} glyphs · missing ${state.missingGlyphs} · unsupported variation pairs ${state.unsupportedVariations}` : "",
            complete?.parts ? `After features selected separately for ${state.scriptParts} script runs: ${state.glyphs} glyphs · ${state.advanceUnits} font-unit advance` : "",
            ...(complete ? Array.from({ length: Math.min(6, complete.scripts.runCount) }, (_, i) => { const r = complete!.scripts.runAt(i); return `Points ${r.from}..${r.to}: ${r.script} → ${scriptTag(r.script)} · ${r.kind}`; }) : []),
            ...(complete ? Array.from({ length: Math.min(6, complete.normalized.length) }, (_, i) => { const p = complete!.normalized.at(i); return `U+${p.codePoint.toString(16).toUpperCase().padStart(4, "0")} · ${unicodeScript(p.codePoint)} / ${unicodeScriptExtensions(p.codePoint).join(" ")} · ${unicodeCategory(p.codePoint)} · ccc ${canonicalCombiningClass(p.codePoint)} · source ${p.sources.map(s => `${s.from}..${s.to}`).join(", ")}`; }) : []),
            "Document text stays unchanged. This fixture selects Latn/latn, Grek/grek, Hebr/hebr and otherwise DFLT. Bidi direction, font-aware normalization/fallback, complex-script policies, ink/carets and full renderer integration remain unqualified.", failure ?? ""].filter(Boolean).join("\n");
    };
    const expire = (reason: string) => { if (status === "disposed") return; generation++; stop(); complete = null; status = "expired"; failure = reason; render(); };
    const finish = (active: Job) => {
        if (job !== active || !current(active.capture)) { expire("Captured source, style or font version expired."); return; }
        complete = Object.freeze({ capture: active.capture, normalized: active.normalized!, scripts: active.scripts!, mapped: active.mapped ?? null, parts: active.parts ?? null,
            positioned: Object.freeze(active.positioned), glyphs: active.font ? active.glyphs : null, advance: active.font ? active.advance : null }); stop(); status = "ready"; failure = null; render();
    };
    const beginPart = (active: Job) => {
        if (active.part === active.parts!.length) { finish(active); return; }
        const part = active.parts!.at(active.part), script = scriptTag(part.script.script); let plans = active.plans.get(script);
        if (!plans) { plans = Object.freeze({ sub: active.font!.substitutionPlan({ script, features: [{ tag: "liga" }, { tag: "test" }] }), pos: active.font!.positioningPlan({ script, features: [{ tag: "test" }], legacyKerning: true }) }); active.plans.set(script, plans); }
        active.substitution = plans.sub.createCursor(part.glyphs); active.stage = "substitute";
    };
    const advance = () => {
        const active = job; if (!active || status !== "running") return; if (!current(active.capture)) { expire("Captured source, style or font version expired."); return; }
        try {
            steps++; let remaining = 4096;
            const take = <P extends { workUnits: number }>(cursor: { snapshot: () => P; next: (budget: number) => P }) => { const before = cursor.snapshot().workUnits, step = cursor.next(Math.max(256, remaining)); remaining -= Math.max(256, step.workUnits - before); return step; };
            // Charge at least one quantum per transition so many tiny/empty runs cannot monopolize a turn.
            while (job === active && remaining > 0) {
                if (active.stage === "normalize") { const step = take(active.normalizer); if (step.status === "ready") { active.normalized = step.result!; active.normalizer.dispose(); active.itemizer = createScriptItemizationCursor(active.normalized); active.stage = "script"; } }
                else if (active.stage === "script") { const step = take(active.itemizer!); if (step.status === "ready") { active.scripts = step.result!; active.itemizer!.dispose(); if (!active.font) { finish(active); break; } active.mapper = active.font.createGlyphMappingCursor(active.normalized!); active.stage = "map"; } }
                else if (active.stage === "map") { const step = take(active.mapper!); if (step.status === "ready") { active.mapped = step.result!; active.mapper!.dispose(); active.partitioner = createScriptGlyphCursor(active.mapped, active.scripts!); active.stage = "partition"; } }
                else if (active.stage === "partition") { const step = take(active.partitioner!); if (step.status === "ready") { active.parts = step.result!; active.partitioner!.dispose(); beginPart(active); } }
                else if (active.stage === "substitute") { const step = take(active.substitution!); if (step.status === "ready") { active.shaped = step.result!; active.substitution!.dispose(); active.positioning = active.plans.get(scriptTag(active.parts!.at(active.part).script.script))!.pos.createCursor(active.shaped); active.stage = "position"; } }
                else { const step = take(active.positioning!); if (step.status === "ready") { const positioned = step.result!; active.positioned.push(positioned); active.glyphs += positioned.glyphs.length; active.advance += positioned.advances.total; active.positioning!.dispose(); active.part++; beginPart(active); } }
            }
            if (job === active) { render(); timer = view.setTimeout(advance, 0); }
        } catch (error) { stop(); complete = null; status = "failed"; failure = error instanceof Error ? error.message : "Unicode analysis failed."; render(); }
    };
    const request = () => {
        if (status === "disposed") return; stop(); complete = null; generation++; steps = 0; failure = null;
        try {
            const currentFont = font.asset.getSnapshot().current, buffer = TextBuffer.from(source.value), capture = Object.freeze({ generation, revision, style, font: currentFont?.generation ?? null });
            job = { capture, font: currentFont?.data ?? null, stage: "normalize", normalizer: createNormalizationCursor(buffer, { form: form.value as NormalizationForm }), part: 0, plans: new Map(), positioned: [], glyphs: 0, advance: 0 }; status = "running"; render(); timer = view.setTimeout(advance, 0);
        } catch (error) { status = "failed"; failure = error instanceof Error ? error.message : "Unicode analysis failed."; render(); }
    };
    run.addEventListener("click", request, { signal: listeners.signal }); cancel.addEventListener("click", () => { generation++; stop(); complete = null; status = "cancelled"; failure = null; render(); }, { signal: listeners.signal });
    source.addEventListener("input", () => { revision++; if (status === "running" || status === "ready") expire("Source revision changed; analyze again."); else render(); }, { signal: listeners.signal });
    form.addEventListener("change", () => { style++; if (status === "running" || status === "ready") expire("Normalization form changed; analyze again."); else render(); }, { signal: listeners.signal });
    const unsubscribe = font.asset.subscribe(() => { observedFont = activeFont(); const capture = job?.capture ?? complete?.capture; if (capture && !current(capture)) expire("Active font version changed; analyze again."); }); render();
    return Object.freeze({ request, snapshot, sourceAt: (index: number) => complete?.normalized.at(index) ?? null, mappedAt: (index: number) => complete?.mapped?.run.at(index) ?? null,
        scriptAt: (index: number) => complete?.scripts.runAt(index) ?? null, scriptPart: (index: number) => complete?.parts?.at(index) ?? null, positionedPart: (index: number) => complete?.positioned[index] ?? null,
        dispose: () => { if (status === "disposed") return; generation++; stop(); complete = null; status = "disposed"; unsubscribe(); listeners.abort(); render(); } });
}
