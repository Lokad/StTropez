export { validateTextEdits } from "../core/changes.ts";
export { PositionMap, composePositionMaps } from "../core/positions.ts";
export { bufferDifference } from "../core/buffer-change.ts";
export { LiteralSearch } from "../core/search.ts";
export { GraphemeIndex, GraphemeLimitError, createGraphemeCursor, graphemeBoundaries } from "../core/graphemes.ts";
export { TextDiff } from "../core/diff.ts";
export { mapSelectionSet, planSelectionEdits } from "../core/selections.ts";
export { parseSnippet, offsetSnippetStops, planSnippetEdit, snippetChoiceText, planSnippetChoice } from "../core/snippets.ts";
export { JsonRpcConnection } from "../protocol/json-rpc.ts";
export { LspSession } from "../protocol/lsp-session.ts";

export { decodeLspDiagnostics } from "../protocol/lsp-features.ts";
export { applyLspWorkspaceEdit, type LspWorkspaceEditOptions } from "../protocol/lsp-workspace-edit.ts";
