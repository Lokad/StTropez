import type { AdvanceIndex, SfntMetadata, SubstitutionResult, DocumentSnapshot, DocumentView, Observable, ResourceHandle, ResourceSnapshot, SaveSubmission } from "../src/index.ts";
import type { FontAssetSnapshot } from "../src/browser/index.ts";
import type { FontNormalizationIndex, FontCascade, FontNormalizationProgress } from "../src/index.ts";
export function glyphPropertiesReadContract(glyph: import("../src/index.ts").SubstitutionGlyph, placed: import("../src/index.ts").PositionedGlyph): void {
    // @ts-expect-error Captured glyph properties cannot be changed by a reader.
    if (glyph.properties) glyph.properties.defaultIgnorable = false;
    // @ts-expect-error Published visibility is immutable.
    placed.hidden = false;
}

export function fontNormalizationReadContract(result: FontNormalizationIndex, cascade: FontCascade, progress: FontNormalizationProgress): void {
    // @ts-expect-error Font assignments are immutable published cluster data.
    result.clusterAt(0).fontIndex = 0;
    // @ts-expect-error Output-point run boundaries cannot be changed by a reader.
    result.runAt(0).to = 0;
    // @ts-expect-error Canonical layout policy is captured metadata.
    result.text.form = "none";
    // @ts-expect-error The captured font ordering is immutable.
    cascade.length = 0;
    // @ts-expect-error Progress cannot publish a caller-supplied result.
    progress.result = result;
}
import type { GraphemeIndex, GraphemeProgress } from "../src/index.ts";

export function graphemeReadContract(index: GraphemeIndex, progress: GraphemeProgress): void {
    // @ts-expect-error Published boundaries are immutable.
    index.boundaries().push(0);
    // @ts-expect-error Cluster coordinates are immutable.
    index.clusterAt(0).from = 1;
    // @ts-expect-error Source identity is captured.
    index.source.kind = "buffer";
    // @ts-expect-error Ready-only progress is immutable.
    progress.result = null;
}

export function fontReadContract(metadata: SfntMetadata, state: FontAssetSnapshot): void {
    // @ts-expect-error Published font table names are immutable.
    metadata.tables.push("test");
    // @ts-expect-error Published cmap descriptors are immutable.
    metadata.encodings[0]!.format = 12;
    if (state.current) {
        // @ts-expect-error Native font versions retain their captured generation.
        state.current.generation = 0;
    }
}

export function substitutionReadContract(result: SubstitutionResult): void {
    // @ts-expect-error Glyph IDs belong to an immutable font/source snapshot.
    result.glyphs[0]!.glyphId = 1;
    // @ts-expect-error Component source spans cannot be changed after publication.
    result.glyphs[0]!.components[0]![0]!.from = 0;
    // @ts-expect-error Lookup order is fixed in the selected font program.
    result.selection.lookups.push(0);
}

export function positioningReadContract(result: import("../src/index.ts").PositioningResult): void {
    // @ts-expect-error Published glyph positions are immutable.
    result.glyphs[0]!.x = 0;
    // @ts-expect-error Positioned source components retain immutable provenance.
    result.glyphs[0]!.source.components[0]![0]!.from = 0;
    // @ts-expect-error Selected lookup order cannot be changed.
    result.selection.lookups.push(0);
}

export function positioningCursorReadContract(plan: import("../src/index.ts").PositioningPlan, input: SubstitutionResult, progress: import("../src/index.ts").PositioningProgress): void {
    // @ts-expect-error Cooperative metrics must be an immutable retained index.
    plan.createCursor(input, { advanceWidths: [1000] });
    // @ts-expect-error Published progress is immutable.
    progress.preparedGlyphs = 0;
}

export function substitutionCursorReadContract(plan: import("../src/index.ts").SubstitutionPlan, run: import("../src/index.ts").GlyphRun, progress: import("../src/index.ts").SubstitutionProgress): void {
    // @ts-expect-error Cooperative input requires owned immutable data.
    plan.createCursor([{ glyphId: 2, source: { from: 0, to: 1 } }]);
    // @ts-expect-error Published nominal spans are immutable.
    run.at(0).source.from = 1;
    // @ts-expect-error Progress cannot be used to mutate private glyph state.
    progress.currentGlyphs = 0;
}

export function unicodeReadContract(text: import("../src/index.ts").NormalizedText, progress: import("../src/index.ts").NormalizationProgress, mapped: import("../src/index.ts").GlyphMappingResult): void {
    // @ts-expect-error Normalized source facts are immutable.
    text.at(0).sources[0]!.from = 0;
    // @ts-expect-error Progress does not expose mutable job state.
    progress.scannedUnits = 0;
    // @ts-expect-error Mapped source components cannot be rewritten.
    mapped.run.at(0).components[0]![0]!.to = 1;
}
export function scriptReadContract(scripts: import("../src/index.ts").ScriptIndex, parts: import("../src/index.ts").ScriptGlyphIndex, progress: import("../src/index.ts").ScriptItemizationProgress): void {
    // @ts-expect-error Script interpretations are immutable snapshots.
    scripts.runAt(0).script = "Latn";
    // @ts-expect-error Candidate sets cannot be changed by readers.
    scripts.runAt(0).candidates.push("Latn");
    // @ts-expect-error Glyph views retain immutable source components.
    parts.at(0).glyphs.at(0).components[0]![0]!.from = 0;
    // @ts-expect-error Private publication counters are read-only.
    progress.publishedClusters = 0;
}

type Form = { nested: { enabled: boolean }; fields: string[] };
/** Compile-only consumer contract; these attempted writes must remain type errors. */
export function readCompatibility(handle: ResourceHandle<Form>, submission: SaveSubmission<Form>): Observable<ResourceSnapshot<Form>> {
    const snapshot = handle.getSnapshot();
    if (snapshot.state === "ready") {
        // @ts-expect-error Published nested values are deeply readonly even for a mutable host schema.
        snapshot.value.nested.enabled = false;
        // @ts-expect-error Published arrays are immutable.
        snapshot.value.fields.push("field");
    }
    // @ts-expect-error A captured submission must not become a second writable form.
    submission.value.nested.enabled = false;
    return handle;
}

export function documentReadContract(document: DocumentSnapshot, view: DocumentView): void {
    // @ts-expect-error Buffer snapshots expose no mutable text or position properties.
    document.buffer.length = 0;
    // @ts-expect-error Selection writes require the versioned view command.
    view.getSnapshot().selection.head = 0;
    // @ts-expect-error A published map's coordinate dimensions are immutable.
    if (document.change) document.change.mapping.oldLength = 0;
}

export function advanceReadContract(index: AdvanceIndex): void {
    // @ts-expect-error Geometry snapshots expose no writable totals.
    index.total = 0;
    const window = index.window(0, 1);
    // @ts-expect-error Window cells cannot be appended by a reader.
    window.cells.push({ index: 0, from: 0, to: 1, advance: 1 });
    // @ts-expect-error Published cell coordinates are immutable.
    if (window.cells[0]) window.cells[0].from = 0;
}
