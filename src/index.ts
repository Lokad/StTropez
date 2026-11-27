export { textDifference } from "./core/changes.ts";
export type { TextEdit } from "./core/changes.ts";
export { anchoredRange } from "./core/positions.ts";
export type { Affinity, AnchoredRange, MappedPosition, PositionMapping } from "./core/positions.ts";
export { TextBuffer } from "./core/text-buffer.ts";
export type { BufferChangeSpan } from "./core/buffer-change.ts";
export type { BufferChange, BufferLine, BufferPosition, BufferRetention } from "./core/text-buffer.ts";
export type { SearchMatch, SearchStep, LiteralSearchOptions } from "./core/search.ts";
export type { FindBackend, FindQueryCapture, FindSearchCursor, FindPlanCursor, FindPlanStep } from "./core/find.ts";
export { createFoldRegions, type FoldIndex } from "./core/folding.ts";
export type { FoldRange, FoldRegion, FoldVersion, FoldingSnapshot, DocumentFolding } from "./core/folding.ts";
export { discoverIndentationFolds } from "./core/fold-discovery.ts";
export type { DiscoveredFold, IndentationFoldingOptions, IndentationFoldingProgress, IndentationFoldingCursor } from "./core/fold-discovery.ts";
export type { DiffHunk, DiffProgress, DiffRange } from "./core/diff.ts";
export type { ComparisonBaseline, ComparisonCapture, ComparisonController, ComparisonHunk, ComparisonSnapshot, ComparisonTicket, ComparisonReversion } from "./core/comparison.ts";
export type { EditKind, HistoryOptions, HistorySnapshot, Selection } from "./core/history.ts";
export type { SelectionSet, SelectionEditPlan } from "./core/selections.ts";
export { resolveLanguageConfiguration, planLanguageEdit } from "./core/language-edits.ts";
export type { LanguageConfiguration, ResolvedLanguageConfiguration, EditingCommand, EditingPair, LanguageEditContext, PairingContext, EnterIndent } from "./core/language-edits.ts";
export type { BracketMatchOptions, BracketMatchResult } from "./core/bracket-matching.ts";
export { characterWarningLabel } from "./core/character-warnings.ts";
export type { CharacterWarningKind, CharacterWarningOptions, CharacterWarningConfiguration, CharacterWarning, CharacterWarningLimits, CharacterWarningBatch } from "./core/character-warnings.ts";
export type { Snippet, SnippetStop, SnippetOccurrence, SnippetParseResult, SnippetEditPlan } from "./core/snippets.ts";
export { runSaveBatch, Workspace, type SaveResponse } from "./core/workspace.ts";
export type { TextTransaction } from "./core/text-transaction.ts";
export type {
    BatchEditResult, Capabilities, DocumentChange, DocumentEditRequest, DocumentId, DocumentLanguage, DocumentSnapshot, DocumentView,
    DocumentViewSnapshot, EditOrigin, EditRequest, EditResult, HistoryRequest,
    LoadedResource, ResourceLoad, ResourceKey, ResourceLease,
    ResourceMetadata, ResourceSnapshot, ResourceTarget, ResourceVisibility, SaveReceipt, SaveReview, SaveSubmission, SaveTicket, TextResourceHandle, TextResourceOptions, TextTransactionOptions, TextWriteResult,
    ViewId, WorkspaceOptions, WorkspaceSnapshot,
} from "./core/workspace.ts";
export type { AfterDelivery, NotificationScope, Observable, ObservableListener } from "./core/observable.ts";
export type { DocumentationContent, DocumentationPart } from "./core/documentation.ts";
