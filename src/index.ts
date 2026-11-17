export { applyTextEdits, textDifference } from "./core/changes.ts";
export { validateTextEdits } from "./core/changes.ts";
export type { TextEdit } from "./core/changes.ts";
export { PositionMap, anchoredRange, composePositionMaps } from "./core/positions.ts";
export type { Affinity, AnchoredRange, MappedPosition, PositionMapping } from "./core/positions.ts";
export { importText, exportText } from "./core/newlines.ts";
export type { ImportedText, LineEnding } from "./core/newlines.ts";
export { TextBuffer } from "./core/text-buffer.ts";
export { BufferChangeCursor } from "./core/buffer-change.ts";
export type { BufferChangeSpan, BufferChangeProgress } from "./core/buffer-change.ts";
export type { BufferChange, BufferReadMetrics, BufferRetention } from "./core/text-buffer.ts";
export { LiteralSearch } from "./core/search.ts";
export type { SearchMatch, SearchStep, LiteralSearchOptions } from "./core/search.ts";
export { FoldIndex, createFoldRegions } from "./core/folding.ts";
export type { FoldRange, FoldRegion, FoldVersion, FoldingSnapshot, DocumentFolding } from "./core/folding.ts";
export { discoverIndentationFolds, reconcileFoldRanges } from "./core/fold-discovery.ts";
export type { DiscoveredFold, IndentationFoldingOptions } from "./core/fold-discovery.ts";
export { WordCursor, codeWordConstituentPattern } from "./core/words.ts";
export type { WordStep, WordOptions } from "./core/words.ts";
export { GraphemeIndex, GraphemeLimitError, createGraphemeCursor, graphemeBoundaries } from "./core/graphemes.ts";
export type { GraphemeSource, GraphemeRange, GraphemeOptions, GraphemeProgress, GraphemeCursor } from "./core/graphemes.ts";
export { unicodeGraphemeVersion, graphemeBreakProperty, indicConjunctBreak, extendedPictographic, defaultIgnorable } from "./core/grapheme-data.ts";
export type { GraphemeBreakProperty, IndicConjunctBreak } from "./core/grapheme-data.ts";
export { resolveBidi } from "./core/bidi.ts";
export type { BidiDirection, BidiParagraph, BidiText } from "./core/bidi.ts";
export { BidiCursor } from "./core/bidi-cursor.ts";
export type { BidiIndex, BidiStep } from "./core/bidi-cursor.ts";
export { createBidiIndexController } from "./core/bidi-controller.ts";
export type { BidiIndexController, BidiIndexRequest, BidiIndexSnapshot, BidiProgress } from "./core/bidi-controller.ts";
export { DiffReferenceCache, TextDiff } from "./core/diff.ts";
export type { DiffHunk, DiffProgress, DiffRange } from "./core/diff.ts";
export { createComparisonController } from "./core/comparison.ts";
export type { ComparisonBaseline, ComparisonCapture, ComparisonController, ComparisonSnapshot, ComparisonTicket, ComparisonReversion } from "./core/comparison.ts";
export type { EditKind, HistoryOptions, HistorySnapshot, Selection } from "./core/history.ts";
export { createSelectionSet, mapSelectionSet, planSelectionEdits } from "./core/selections.ts";
export type { SelectionSet, SelectionEditPlan } from "./core/selections.ts";
export { resolveLanguageConfiguration, planLanguageEdit } from "./core/language-edits.ts";
export type { LanguageConfiguration, ResolvedLanguageConfiguration, EditingCommand, EditingPair, LanguageEditContext, PairingContext, EnterIndent } from "./core/language-edits.ts";
export { BracketMatcher } from "./core/bracket-matching.ts";
export type { BracketMatchOptions, BracketMatchResult, BracketMatchProgress, BracketMatchCursor } from "./core/bracket-matching.ts";
export { CharacterWarnings, characterWarningKinds, characterWarningLabel } from "./core/character-warnings.ts";
export type { CharacterWarningKind, CharacterWarningOptions, CharacterWarningConfiguration, CharacterWarning, CharacterWarningLimits, CharacterWarningBatch } from "./core/character-warnings.ts";
export { parseSnippet, offsetSnippetStops, planSnippetEdit, snippetChoiceText, planSnippetChoice } from "./core/snippets.ts";
export type { Snippet, SnippetStop, SnippetOccurrence, SnippetParseResult, SnippetEditPlan } from "./core/snippets.ts";
export { Workspace } from "./core/workspace.ts";
export type {
    BatchEditResult, Capabilities, ChangeResult, CloseIntent, CloseOperation, DocumentChange, DocumentId, DocumentSnapshot, DocumentView,
    DocumentViewSnapshot, EditLease, EditOrigin, EditRequest, EditResult, HistoryRequest,
    LoadedResource, LoadedTextBuffer, LoadOperation, Operation, PaneId, ResourceHandle, ResourceId, ResourceKey, ResourceLease,
    ResourceMetadata, ResourceOptions, ResourceSnapshot, ResourceTarget, ResourceVisibility, SaveReceipt, SaveReview, SaveSubmission, SaveTicket, Surface, TabId, TabSnapshot, TabTarget, TextResourceHandle,
    ViewId, WorkspaceOptions, WorkspaceSnapshot,
} from "./core/workspace.ts";
export type { Observable } from "./core/observable.ts";
export type { Immutable, SnapshotValue } from "./core/values.ts";
export { WorkspaceCommands } from "./core/commands.ts";
export type { CapturedResource, RunPort, RunSubmission, SaveOutcome, SavePort, SaveResponse } from "./core/commands.ts";
export { createAgentReview } from "./core/agent.ts";
export type { AcknowledgementPort, AcknowledgementState, AcknowledgementSubmission, AcknowledgementTicket, AgentAssociation, AgentInput,
    AgentChangeResult, AgentReview, AgentRequest, AgentSnapshot, AgentSaveSubmission, AgentSaveReceipt, AgentSaveTicket,
    Proposal, ProposalGuard, ProposalTarget, ProposedEdits } from "./core/agent.ts";
