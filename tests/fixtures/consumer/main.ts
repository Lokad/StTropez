import { SfntFont, AdvanceIndex, createAdvanceBuilder, Workspace, TextBuffer, TextDiff, WordCursor, BidiCursor, createBidiIndexController, resolveBidi, importText, exportText, anchoredRange, composePositionMaps, normalizeText, itemizeScripts, createScriptGlyphCursor, unicodeScript, unicodeScriptExtensions, unicodeShapingVersion } from "sttropez";
import { createFontAssetController, createFindController, mountTextComparison, mountTextEditor, mountTextViewport, mountEditingCandidate } from "sttropez/browser";
import { fontFixture, FontBytes, assembleFont, fontTables, cmapTable } from "./font-fixture.js";
import { FontCascade, createFontNormalizationCursor } from "sttropez";
import { createGraphemeCursor, createNormalizedGraphemeCursor, createScriptItemizationCursor } from "sttropez";
import { DiffReferenceCache, WorkspaceCommands } from "sttropez";
import { createSelectionSet, planSelectionEdits } from "sttropez";
import type { SaveReview } from "sttropez";
import type { PresentedLine } from "sttropez/browser";
const workspace = new Workspace();
const documentId = workspace.createDocument({ scope: "consumer", resource: "source", variant: "working" }, "Consumer source", "restored assets");
const tabId = workspace.open({ kind: "text", documentId }, "main");
const host = document.getElementById("editor");
if (!host) throw new Error("Missing editor host.");
mountTextEditor(host, workspace, tabId);
const viewport = mountTextViewport(document.getElementById("viewport")!, workspace, tabId, { ariaLabel: "Restored viewport" });
const candidate = mountEditingCandidate(document.getElementById("candidate")!, workspace, tabId, { ariaLabel: "Restored candidate", decorate: line => {
    const from = line.text.indexOf("restored"); return from < 0 ? [] : [{ from: line.from + from, to: line.from + from + 8, className: "consumer-token" }];
} });
const find = createFindController(workspace, tabId, candidate);
const comparisonResource = workspace.createTextResourceFromBuffer({ scope: "consumer", resource: "review", variant: "working" }, "Review", { buffer: TextBuffer.from("working\r\n"), serverVersion: "saved-1" });
const comparisonTab = workspace.open({ kind: "text", documentId: comparisonResource.documentId }, "review");
const comparisonView = workspace.createDocumentView(comparisonResource.documentId);
const reviewDecorate = (line: PresentedLine) => [{ from: line.from, to: line.to, className: "consumer-review-token" }];
const reviewOptions = { view: comparisonView, workingDecorate: reviewDecorate, baselineDecorate: reviewDecorate };
let comparison = mountTextComparison(document.getElementById("comparison")!, workspace, comparisonTab, { buffer: TextBuffer.from("baseline\r\n"), version: "reference-1" }, reviewOptions);
Object.assign(window, { consumer: { text: () => workspace.document(documentId).text,
    readonlyIndent: async (outdent: boolean) => {
        const model = new Workspace(), text = "    const sample = 1;\r\n".repeat(1024), source = model.createTextResource({ scope: "consumer", resource: "readonly-indent", variant: "working" }, "Locked command", { value: text });
        const tab = model.open({ kind: "text", documentId: source.documentId }, "locked-command"), host = document.createElement("div"); host.style.height = "200px"; document.body.append(host);
        const editor = mountEditingCandidate(host, model, tab, { ariaLabel: "Restored locked command" });
        try {
            editor.view.setSelection(0, { anchor: 0, head: text.length }); model.setCapabilities(source.id, { edit: ["host"], save: true, run: true });
            const before = model.observeHistory(source.documentId).getSnapshot(); let lockedAtHandler = false;
            editor.input.addEventListener("keydown", () => { lockedAtHandler = editor.input.readOnly;
                queueMicrotask(() => model.setCapabilities(source.id, { edit: ["human", "host"], save: true, run: true })); }, { once: true });
            editor.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: outdent, bubbles: true, cancelable: true }));
            await new Promise<void>(resolve => { let turns = 16; const step = () => { if (--turns) setTimeout(step, 0); else resolve(); }; setTimeout(step, 0); });
            const current = model.document(source.documentId);
            return { outdent, lockedAtHandler, revision: current.revision, sameText: current.buffer.slice(0, text.length) === text,
                undoBefore: before.undoDepth, undoAfter: model.observeHistory(source.documentId).getSnapshot().undoDepth, exports: current.buffer.readMetrics().textExports };
        } finally { editor.destroy(); host.remove(); model.close(tab); model.releaseResource(source.id, true); }
    },
    saveReview: async () => {
        const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: "retry", variant: "working" }, "Retry", { value: "base", serverVersion: "v0" });
        model.edit({ documentId: source.documentId, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 4, insert: "merged" }] });
        const commands = new WorkspaceCommands(model);
        await commands.save(source, { save: async () => ({ kind: "conflict", serverVersion: "v1" }) });
        const baselineBefore = source.metadata.getSnapshot().serverVersion;
        const review: SaveReview = { target: model.captureResource(source.id), expectedRevision: source.getSnapshot().revision, expectedServerVersion: "v1" };
        let precondition: string | null = null;
        const saved = await commands.save(source, { save: async submission => {
            precondition = submission.expectedServerVersion;
            model.edit({ documentId: source.documentId, expectedRevision: submission.revision, origin: "human", edits: [{ from: 6, to: 6, insert: " later" }] });
            return { kind: "saved", serverVersion: "v2" };
        } }, review);
        const textAfter = model.document(source.documentId).text, dirtyAfter = source.metadata.getSnapshot().dirty;
        model.undo({ documentId: source.documentId, expectedRevision: source.getSnapshot().revision });
        return { baselineBefore, precondition, saved: saved.kind, textAfter, dirtyAfter, cleanAfterUndo: !source.metadata.getSnapshot().dirty,
            serverVersion: source.metadata.getSnapshot().serverVersion, leases: model.ownership(source.id).leases };
    },
    fontNormalization: async () => {
        const asset = createFontAssetController(document, "consumer-cascade"), before = document.fonts.size;
        try { const load = asset.request(0, fontFixture())!; await load.settled;
        const primary = asset.getSnapshot().current!.data, tables = fontTables(fontFixture()), cmap = new FontBytes(28).u16(0, 12).u32(4, 28).u32(12, 1).u32(16, 0x3b1).u32(20, 0x3b1).u32(24, 7);
        tables.set("cmap", cmapTable([{ platform: 3, encoding: 10, bytes: cmap.data }])); const secondary = SfntFont.from(assembleFont(tables)), input = normalizeText(TextBuffer.from("Áα"), { form: "none" }), cursor = createFontNormalizationCursor(input, FontCascade.from([primary, secondary])); let p = cursor.next(256); while (p.status === "running") p = cursor.next(256); const result = p.result!; cursor.dispose();
        const rows = Array.from({ length: result.runCount }, (_, i) => { const r = result.runAt(i), font = result.cascade.at(r.fontIndex), mapper = font.createGlyphMappingCursor(result.text, { from: r.from, to: r.to }); let m = mapper.next(256); while (m.status === "running") m = mapper.next(256); const mapped = m.result!; mapper.dispose();
            const index = itemizeScripts(result.text, { from: r.from, to: r.to }), partsCursor = createScriptGlyphCursor(mapped, index); let q = partsCursor.next(256); while (q.status === "running") q = partsCursor.next(256); const parts = q.result!; partsCursor.dispose();
            const placed = font.positioningPlan({ features: [], legacyKerning: false }).apply(font.substitutionPlan({ features: [] }).apply(parts.at(0).glyphs)); return { from: r.from, to: r.to, fontIndex: r.fontIndex, glyphs: placed.glyphs.map(g => g.source.glyphId), units: placed.advances.total }; });
        asset.dispose(); return { form: result.text.form, text: result.text.text(), clusters: result.clusterCount, runs: result.runCount, fonts: [result.clusterAt(0).fontIndex, result.clusterAt(1).fontIndex], origin: result.text.at(1).sources, rows, released: cursor.snapshot().result === null, nativeReleased: document.fonts.size === before, exports: input.source.readMetrics().textExports };
        } finally { asset.dispose(); }
    },
    glyphVisibility: () => {
        const font = SfntFont.from(fontFixture()), text = normalizeText(TextBuffer.from("A\u200dB"), { form: "none" }), cursor = font.createGlyphMappingCursor(text);
        let s = cursor.next(256); while (s.status === "running") s = cursor.next(256); const mapped = s.result!; cursor.dispose();
        const shaped = font.substitutionPlan({ features: [] }).apply(mapped.run), result = font.positioningPlan({ features: [] }).apply(shaped), preserved = font.positioningPlan({ features: [], defaultIgnorables: "preserve" }).apply(shaped);
        return { glyphs: result.glyphs.map(g => g.source.glyphId), hidden: result.glyphs.map(g => g.hidden), widths: result.glyphs.map(g => g.xAdvance), total: result.advances.total, preserved: preserved.advances.total,
            source: result.glyphs[1]!.source.sources, properties: result.glyphs[1]!.source.properties, released: cursor.snapshot().result === null, exports: text.source.readMetrics().textExports };
    },
    graphemes: () => {
        const buffer = TextBuffer.from("🇦🇧👩‍💻\r\n"), cursor = createGraphemeCursor(buffer); let step = cursor.next(256); while (step.status === "running") step = cursor.next(256); const raw = step.result!; cursor.dispose();
        const text = normalizeText(TextBuffer.from("é👩‍💻"), { form: "NFD" }), normalized = createNormalizedGraphemeCursor(text); let n = normalized.next(256); while (n.status === "running") n = normalized.next(256); const index = n.result!; normalized.dispose();
        const itemizer = createScriptItemizationCursor(text, { graphemes: index }); let s = itemizer.next(256); while (s.status === "running") s = itemizer.next(256); const scripts = s.result!; itemizer.dispose();
        return { version: raw.unicodeVersion, raw: raw.boundaries(), normalized: index.boundaries(), coordinates: [raw.source.kind, index.source.kind], scripts: scripts.clusterCount, origin: text.at(1).sources,
            released: cursor.snapshot().result === null && normalized.snapshot().result === null && itemizer.snapshot().result === null, exports: buffer.readMetrics().textExports };
    },
    font: async () => {
        const bytes = fontFixture(), data = SfntFont.from(bytes), before = document.fonts.size, asset = createFontAssetController(document, "consumer-font");
        try {
            const operation = asset.request(0, bytes)!; bytes.fill(0); const result = await operation.settled, current = asset.getSnapshot().current!;
            const context = document.createElement("canvas").getContext("2d")!; context.font = `100px ${current.family}`; context.fontKerning = "normal";
            const native = ["A B", "AB", "fi"].map(text => context.measureText(text).width), index = AdvanceIndex.from([65, 32, 66].map(code => data.nominalGlyphMetrics(data.glyphIndex(code)).advanceWidth));
            const substitution = current.data.substitutionPlan({ features: [{ tag: "liga" }] }).apply([4, 5].map((glyphId, from) => ({ glyphId, source: { from, to: from + 1 } })));
            const positioner = current.data.positioningPlan({ features: [], legacyKerning: true }), positioned = positioner.apply(substitution), pair = positioner.apply(current.data.substitutionPlan({ features: [] }).apply([2, 3].map((glyphId, from) => ({ glyphId, source: { from, to: from + 1 } }))));
            const cursor = positioner.createCursor(substitution); let step = cursor.next(256); while (step.status === "running") step = cursor.next(256); const cursorUnits = step.result!.advances.total; cursor.dispose();
            const builder = current.data.createGlyphRunBuilder(); builder.append([4, 5].map((glyphId, from) => ({ glyphId, source: { from, to: from + 1 } }))); const supplied = builder.finish(); builder.dispose();
            const subCursor = current.data.substitutionPlan({ features: [{ tag: "liga" }] }).createCursor(supplied); let shaped = subCursor.next(256); while (shaped.status === "running") shaped = subCursor.next(256); const glyphs = shaped.result!; subCursor.dispose();
            const placedCursor = positioner.createCursor(glyphs, { advanceWidths: AdvanceIndex.from([500]) }); let placed = placedCursor.next(256); while (placed.status === "running") placed = placedCursor.next(256); const pipelineUnits = placed.result!.advances.total; placedCursor.dispose();
            const normalized = normalizeText(TextBuffer.from("ﬁAB"), { form: "NFKD" }), mappingCursor = current.data.createGlyphMappingCursor(normalized); let mapping = mappingCursor.next(256); while (mapping.status === "running") mapping = mappingCursor.next(256); const mapped = mapping.result!; mappingCursor.dispose();
            const normalizedSub = current.data.substitutionPlan({ features: [{ tag: "liga" }] }).createCursor(mapped.run); let normalizedStep = normalizedSub.next(256); while (normalizedStep.status === "running") normalizedStep = normalizedSub.next(256); const normalizedGlyphs = normalizedStep.result!; normalizedSub.dispose(); const normalizedPlaced = positioner.apply(normalizedGlyphs);
            const scriptText = normalizeText(TextBuffer.from("ﬁABα"), { form: "NFKD" }), scriptMapCursor = current.data.createGlyphMappingCursor(scriptText); let scriptMapped = scriptMapCursor.next(); while (scriptMapped.status === "running") scriptMapped = scriptMapCursor.next(); const scriptMapping = scriptMapped.result!; scriptMapCursor.dispose();
            const scriptIndex = itemizeScripts(scriptText), partCursor = createScriptGlyphCursor(scriptMapping, scriptIndex); let partitioned = partCursor.next(); while (partitioned.status === "running") partitioned = partCursor.next(); const parts = partitioned.result!; partCursor.dispose();
            const scriptRows = Array.from({ length: parts.length }, (_, i) => { const part = parts.at(i), script = part.script.script === "Latn" ? "latn" : "grek", plan = current.data.substitutionPlan({ script, features: [{ tag: "liga" }] }), cursor = plan.createCursor(part.glyphs.slice()); let step = cursor.next(); while (step.status === "running") step = cursor.next(); const shaped = step.result!; cursor.dispose(); const positioned = positioner.apply(shaped); return { script: part.script.script, from: part.fromGlyph, to: part.toGlyph, glyphs: shaped.glyphs.map(g => g.glyphId), units: positioned.advances.total }; });
            const captured = { result: result.status, current: asset.isCurrent(result.generation), ownedFaces: document.fonts.size - before,
                unitsPerEm: data.metadata.unitsPerEm, glyphCount: data.metadata.glyphCount, nominalUnits: index.total, variation: data.variationGlyphIndex(65, 0xfe0f),
                native, copiedNominalA: current.data.nominalGlyphMetrics(2).advanceWidth,
                positioning: { pairUnits: pair.advances.total, pairPrefix: pair.advances.prefix(1), ligatureUnits: positioned.advances.total, source: positioned.glyphs[0]!.source.components },
                cursor: { units: cursorUnits, disposed: cursor.snapshot().status, resultReleased: cursor.snapshot().result === null },
                scripts: { runs: scriptIndex.runCount, clusters: scriptIndex.clusterCount, rows: scriptRows, missing: scriptMapping.missingGlyphs, repeatedOrigin: parts.at(0).glyphs.at(1).sources,
                    released: scriptMapCursor.snapshot().result === null && partCursor.snapshot().result === null },
                glyphPipeline: { inputGlyphs: supplied.length, glyphs: glyphs.glyphs.map(g => g.glyphId), units: pipelineUnits, source: glyphs.glyphs[0]!.components,
                    released: builder.snapshot().result === null && subCursor.snapshot().result === null && placedCursor.snapshot().result === null },
                unicode: { version: unicodeShapingVersion, text: normalized.text(), points: normalized.length, glyphs: normalizedGlyphs.glyphs.map(g => g.glyphId), units: normalizedPlaced.advances.total,
                    components: normalizedGlyphs.glyphs[0]!.components, script: unicodeScript(65), extensions: unicodeScriptExtensions(0x30fc), mappingReleased: mappingCursor.snapshot().result === null },
                substitution: { glyphs: substitution.glyphs.map(g => g.glyphId), components: substitution.glyphs[0]!.components, units: current.data.nominalGlyphMetrics(substitution.glyphs[0]!.glyphId).advanceWidth } };
            asset.dispose(); return { ...captured, released: document.fonts.size === before, retainedA: current.data.nominalGlyphMetrics(2).advanceWidth, retainedPositioned: pair.advances.total };
        } finally { asset.dispose(); }
    },
    comparison: () => { const s = comparison.controller.getSnapshot(); return { status: s.status, generation: s.generation, count: s.hunks.length, version: s.baseline?.version,
        viewId: comparisonView.id, selection: comparisonView.getSnapshot().selection, reference: comparison.referenceViewport()?.snapshot(), working: comparison.working.viewport.snapshot() }; },
    remountComparison: () => {
        const baseline = comparison.controller.getSnapshot().baseline!, state = comparison.working.captureView();
        comparison.destroy(); const retained = workspace.ownsDocumentView(comparisonView);
        comparison = mountTextComparison(document.getElementById("comparison")!, workspace, comparisonTab, baseline, reviewOptions);
        comparison.working.restoreView({ ...state, ...comparisonView.getSnapshot().selection }); return retained;
    },
    acceptComparison: () => { const t = comparison.controller.beginAcceptance(); return t.complete({ buffer: t.capture.working.buffer, version: "accepted-2" }); },
    diff: () => { const cache = new DiffReferenceCache(), d = new TextDiff(TextBuffer.from("a\r\n"), TextBuffer.from("a\n"), cache);
        try { let s = d.next(512); while (s.status === "running") s = d.next(512); return { status: s.status, whitespaceOnly: s.hunks[0]?.whitespaceOnly }; }
        finally { d.dispose(); cache.dispose(); } },
    viewport: () => viewport.snapshot(),
    candidate: () => ({ ...candidate.snapshot(), viewport: candidate.viewport.snapshot() }),
    captureCandidate: candidate.captureView,
    bidi: () => resolveBidi("abc אבג xyz"),
    paragraph: () => {
        const buffer = TextBuffer.from("x".repeat(100_000) + " א"), cursor = new BidiCursor(buffer); let step = cursor.next(256), advances = 1;
        while (step.status === "running") { step = cursor.next(256); advances++; }
        const index = step.result!, level = index.levelAt(100_001); cursor.dispose();
        const controller = createBidiIndexController(workspace, tabId), document = workspace.document(documentId), ownership = workspace.ownership(workspace.resourceForDocument(documentId).id).leases;
        const generation = controller.request({ expectedRevision: document.revision, from: 0, to: document.buffer.length })!;
        let state = controller.advance(256); while (state.status === "running") state = controller.advance(256);
        const current = controller.isCurrent(generation), mainLevel = state.index!.levelAt(4), rejected = controller.request({ expectedRevision: document.revision - 1, from: 0, to: 1 }) === null;
        controller.dispose();
        return { advances, level, retainedLevel: index.levelAt(100_001), exports: buffer.readMetrics().textExports, current, mainLevel, rejected,
            releasedLease: workspace.ownership(workspace.resourceForDocument(documentId).id).leases === ownership - 1, sourceRevision: workspace.document(documentId).revision === document.revision };
    },
    advances: () => {
        const builder = createAdvanceBuilder(), values = new Float64Array(2_400_000).fill(32.25);
        for (let from = 0; from < values.length; from += 256) builder.append(values, from, Math.min(values.length, from + 256));
        const index = builder.finish(); builder.dispose(); values.fill(0);
        const window = index.window(2_399_980 * 32.25, 2_399_990 * 32.25), changed = index.replace(1_200_000, 1_200_001, AdvanceIndex.from([1.25]));
        const signed = AdvanceIndex.from([4, 0, -4]).window(4, 5);
        return { total: index.total, changedTotal: changed.total, origin: index.prefix(2_399_980), cells: window.cells.length, readValues: window.readValues,
            first: window.cells[0]!.index, truncated: window.truncated, retained: AdvanceIndex.retained([index, changed]), signed: signed.cells, disposed: builder.snapshot().status };
    },
    bidiSample: () => {
        const document = workspace.document(documentId);
        workspace.edit({ documentId, expectedRevision: document.revision, origin: "host", edits: [{ from: 0, to: document.buffer.length, insert: "abc אבג xyz" }] });
        candidate.view.setSelection(workspace.document(documentId).revision, { anchor: 4, head: 4, anchorAffinity: "after", headAffinity: "after" });
        candidate.viewport.revealOffset(4); candidate.focus();
    },
    navigation: () => {
        const buffer = TextBuffer.from("x".repeat(100_000) + "  tail"), cursor = new WordCursor(buffer, 0, 1);
        let step = cursor.next(256), advances = 1; while (step.status === "running") { step = cursor.next(256); advances++; }
        const run = new WordCursor(buffer, 7, 1, { from: 0, to: 100_000, skipWhitespace: false });
        let runStep = run.next(256), runAdvances = 1; while (runStep.status === "running") { runStep = run.next(256); runAdvances++; }
        const runOffset = runStep.offset; run.dispose();
        candidate.viewport.revealOffset(candidate.view.getSnapshot().selection.head, { horizontal: "nearest", vertical: "nearest" });
        return { offset: step.offset, advances, runOffset, runAdvances, exports: buffer.readMetrics().textExports };
    },
    find: find.setQuery, findOptions: find.setOptions, findState: find.state.getSnapshot, replaceAll: find.replaceAll,
    history: () => workspace.observeHistory(documentId).getSnapshot(),
    selectionSets: () => {
        const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: "sets", variant: "working" }, "Sets", { value: "abcd" });
        const view = model.createDocumentView(source.documentId, createSelectionSet(4, [{ anchor: 0, head: 1 }, { anchor: 4, head: 3 }], 1));
        const before = view.getSnapshot().selectionSet, plan = planSelectionEdits(4, before, "X");
        model.edit({ documentId: source.documentId, expectedRevision: 0, origin: "human", view, ...plan });
        const changed = model.document(source.documentId).buffer.slice(0, 4), after = view.getSnapshot().selectionSet;
        model.undo({ documentId: source.documentId, expectedRevision: 1 });
        const restored = model.document(source.documentId).buffer.slice(0, 4), restoredSet = view.getSnapshot().selectionSet;
        const alias = view.getSnapshot().selection === restoredSet.ranges[restoredSet.primary];
        const tab = model.open({ kind: "text", documentId: source.documentId }, "sets"), container = document.createElement("div"); document.body.append(container);
        const mounts = [mountTextEditor(container, model, tab, { view }), mountEditingCandidate(container, model, tab, { view }), mountTextViewport(container, model, tab, { view })];
        const states = mounts.map(editor => editor.captureView());
        const browserSelections = mounts.map((editor, index) => {
            const state = states[index]!; view.setSelection(2, { anchor: 0, head: 0 });
            editor.restoreView({ ...state, anchor: 0, head: 0 }); const fullSet = view.getSnapshot().selectionSet;
            const { selectionSet: _, ...legacy } = state; editor.restoreView({ ...legacy, anchor: 2, head: 2 });
            return { captured: state.selectionSet, fullSet, legacy: view.getSnapshot().selectionSet };
        });
        mounts.forEach(editor => editor.destroy()); container.remove(); model.close(tab);
        view.dispose(); model.releaseResource(source.id, true);
        return { before, after, restoredSet, changed, restored, alias, browserSelections, views: model.diagnostics().views, leases: model.diagnostics().leases };
    },
    storage: () => {
        const imported = importText("a😀\r\nb", "lf"), original = TextBuffer.from(imported.text);
        const changed = original.apply([{ from: 1, to: 3, insert: "X" }]);
        const mapping = composePositionMaps(imported.mapping, changed.mapping);
        const batch = TextBuffer.from("a\r\n😀b").apply([{ from: 0, to: 1, insert: "X" }, { from: 3, to: 5, insert: "Y" }]);
        return { original: original.text(), exported: exportText(changed.buffer.text(), "crlf").text,
            readMetrics: original.readMetrics(),
            batch: { text: batch.buffer.text(), mappedEnd: batch.mapping.map(6).offset, lineOffset: batch.buffer.offsetAt(1) },
            lineCount: changed.buffer.lineCount, lineOffset: changed.buffer.offsetAt(1),
            mappedEnd: mapping.map(6).offset, anchor: changed.mapping.mapRange(anchoredRange(original.length, 3, 5)) };
    } } });
