export { applyTextEdits, textDifference } from "./core/changes.ts";
export { validateTextEdits } from "./core/changes.ts";
export type { TextEdit } from "./core/changes.ts";
export { PositionMap, anchoredRange, composePositionMaps } from "./core/positions.ts";
export type { Affinity, AnchoredRange, MappedPosition, PositionMapping } from "./core/positions.ts";
export { importText, exportText } from "./core/newlines.ts";
export type { ImportedText, LineEnding } from "./core/newlines.ts";
export { TextBuffer } from "./core/text-buffer.ts";
export type { BufferChange, BufferReadMetrics, BufferRetention } from "./core/text-buffer.ts";
export { LiteralSearch } from "./core/search.ts";
export type { SearchMatch, SearchStep } from "./core/search.ts";
export { WordCursor } from "./core/words.ts";
export type { WordStep } from "./core/words.ts";
export { GraphemeIndex, GraphemeLimitError, createGraphemeCursor, createNormalizedGraphemeCursor, graphemeBoundaries } from "./core/graphemes.ts";
export type { GraphemeSource, GraphemeRange, GraphemeOptions, GraphemeProgress, GraphemeCursor } from "./core/graphemes.ts";
export { graphemeUnicodeVersion as unicodeGraphemeVersion, graphemeBreakProperty, indicConjunctBreak, extendedPictographic } from "./core/grapheme-data.ts";
export type { GraphemeBreakProperty, IndicConjunctBreak } from "./core/grapheme-data.ts";
export { resolveBidi } from "./core/bidi.ts";
export type { BidiDirection, BidiParagraph, BidiText } from "./core/bidi.ts";
export { BidiCursor } from "./core/bidi-cursor.ts";
export type { BidiIndex, BidiStep } from "./core/bidi-cursor.ts";
export { createBidiIndexController } from "./core/bidi-controller.ts";
export type { BidiIndexController, BidiIndexRequest, BidiIndexSnapshot, BidiProgress } from "./core/bidi-controller.ts";
export { TextDiff } from "./core/diff.ts";
export type { DiffHunk, DiffProgress, DiffRange } from "./core/diff.ts";
export { createComparisonController } from "./core/comparison.ts";
export type { ComparisonBaseline, ComparisonCapture, ComparisonController, ComparisonSnapshot, ComparisonTicket } from "./core/comparison.ts";
export type { EditKind, HistoryOptions, HistorySnapshot, Selection } from "./core/history.ts";
export { Workspace } from "./core/workspace.ts";
export type {
    BatchEditResult, Capabilities, ChangeResult, CloseIntent, CloseOperation, DocumentChange, DocumentId, DocumentSnapshot, DocumentView,
    DocumentViewSnapshot, EditLease, EditOrigin, EditRequest, EditResult, HistoryRequest,
    LoadedResource, LoadedTextBuffer, LoadOperation, Operation, PaneId, ResourceHandle, ResourceId, ResourceKey, ResourceLease,
    ResourceMetadata, ResourceSnapshot, ResourceTarget, SaveReceipt, SaveSubmission, SaveTicket, Surface, TabId, TabSnapshot, TabTarget, TextResourceHandle,
    ViewId, WorkspaceOptions, WorkspaceSnapshot,
} from "./core/workspace.ts";
export type { Observable } from "./core/observable.ts";
export type { Immutable, SnapshotValue } from "./core/values.ts";
export { WorkspaceCommands } from "./core/commands.ts";
export type { AcknowledgementPort, CapturedResource, RunPort, RunSubmission, SaveOutcome, SavePort, SaveResponse } from "./core/commands.ts";
export type { AcknowledgementState, AcknowledgementSubmission, AcknowledgementTicket, AgentAssociation, AgentInput,
    AgentRequest, AgentSnapshot, Proposal, ProposalGuard, ProposalTarget, ProposedEdits } from "./core/agent.ts";
export { AdvanceIndex, createAdvanceBuilder } from "./core/advances.ts";
export type { AdvanceCell, AdvanceWindow, AdvanceBuilder, AdvanceBuildSnapshot, AdvanceRetention } from "./core/advances.ts";
export { SfntFont } from "./core/font-data.ts";
export type { FontEncoding, NominalGlyphMetrics, SfntMetadata } from "./core/font-data.ts";
export { SubstitutionLimitError } from "./core/font-substitution.ts";
export type { GlyphSourceSpan, SubstitutionGlyph, SubstitutionInputGlyph, SubstitutionSource, SubstitutionOptions, SubstitutionLimits, SubstitutionResult, SubstitutionPlan } from "./core/font-substitution.ts";
export { GlyphRun, createGlyphRunBuilder } from "./core/glyph-run.ts";
export type { GlyphRunEntry, NominalGlyph, GlyphRunBuilder, GlyphRunBuildSnapshot } from "./core/glyph-run.ts";
export type { GlyphProperties } from "./core/glyph-properties.ts";
export type { SubstitutionCursor, SubstitutionProgress, SubstitutionPhase } from "./core/font-substitution-cursor.ts";
export { NormalizedText, NormalizationLimitError, createNormalizationCursor, normalizeText } from "./core/unicode-normalization.ts";
export type { NormalizationForm, LayoutNormalizationForm, NormalizationOptions, NormalizationPhase, NormalizationProgress, NormalizationCursor, NormalizedPoint } from "./core/unicode-normalization.ts";
export { shapingUnicodeVersion as unicodeShapingVersion, unicodeScript, unicodeScriptExtensions, unicodeCategory, canonicalCombiningClass,
    unicodeDefaultIgnorable, unicodeVariationSelector, unicodeJoinControl, unicodeBidiControl } from "./core/unicode-shaping-data.ts";
export type { UnicodeScript, UnicodeCategory } from "./core/unicode-shaping-data.ts";
export { GlyphMappingLimitError, createGlyphMappingCursor } from "./core/glyph-mapping.ts";
export type { GlyphMappingOptions, GlyphPointRange, GlyphMappingResult, GlyphMappingProgress, GlyphMappingCursor } from "./core/glyph-mapping.ts";
export { FontCascade, FontNormalizationIndex, FontNormalizationLimitError, createFontNormalizationCursor } from "./core/font-normalization.ts";
export type { FontCoverage, FontCluster, FontTextRun, FontNormalizationOptions, FontNormalizationPhase, FontNormalizationProgress, FontNormalizationCursor } from "./core/font-normalization.ts";
export { ScriptIndex, ScriptItemizationLimitError, createScriptItemizationCursor, itemizeScripts } from "./core/script-itemization.ts";
export type { ScriptRunKind, ScriptRun, ScriptCluster, ScriptItemizationOptions, ScriptItemizationProgress, ScriptItemizationCursor } from "./core/script-itemization.ts";
export { ScriptGlyphIndex, createScriptGlyphCursor } from "./core/script-glyphs.ts";
export type { ScriptGlyphPart, ScriptGlyphOptions, ScriptGlyphProgress, ScriptGlyphCursor } from "./core/script-glyphs.ts";
export type { LayoutFeature, LayoutSelection } from "./core/font-layout.ts";
export { PositioningLimitError } from "./core/font-positioning.ts";
export type { PositioningOptions, PositioningLimits, PositioningCursorOptions, PositionedGlyph, PositioningResult, PositioningPlan } from "./core/font-positioning.ts";
export type { PositioningCursor, PositioningProgress, PositioningPhase } from "./core/font-position-cursor.ts";
export type { ContourAnchorPoint } from "./core/font-position-values.ts";
