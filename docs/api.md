# Public API index

Each heading is an import path. Follow a source link to read the declarations for the names in that row.

## `sttropez`

| Source | Public names |
| --- | --- |
| [core/bracket-matching.ts](../src/core/bracket-matching.ts) | `BracketMatchOptions`, `BracketMatchResult` |
| [core/buffer-change.ts](../src/core/buffer-change.ts) | `BufferChangeProgress`, `BufferChangeSpan` |
| [core/changes.ts](../src/core/changes.ts) | `TextEdit`, `textDifference` |
| [core/character-warnings.ts](../src/core/character-warnings.ts) | `CharacterWarning`, `CharacterWarningBatch`, `CharacterWarningConfiguration`, `CharacterWarningKind`, `CharacterWarningLimits`, `CharacterWarningOptions`, `characterWarningLabel` |
| [core/comparison.ts](../src/core/comparison.ts) | `ComparisonBaseline`, `ComparisonCapture`, `ComparisonController`, `ComparisonHunk`, `ComparisonReversion`, `ComparisonSnapshot`, `ComparisonTicket` |
| [core/diff.ts](../src/core/diff.ts) | `DiffHunk`, `DiffProgress`, `DiffRange` |
| [core/documentation.ts](../src/core/documentation.ts) | `DocumentationContent`, `DocumentationPart` |
| [core/find.ts](../src/core/find.ts) | `FindBackend`, `FindPlanCursor`, `FindPlanStep`, `FindQueryCapture`, `FindSearchCursor` |
| [core/fold-discovery.ts](../src/core/fold-discovery.ts) | `DiscoveredFold`, `IndentationFoldingCursor`, `IndentationFoldingOptions`, `IndentationFoldingProgress`, `discoverIndentationFolds` |
| [core/folding.ts](../src/core/folding.ts) | `DocumentFolding`, `FoldIndex`, `FoldRange`, `FoldRegion`, `FoldVersion`, `FoldingSnapshot`, `createFoldRegions` |
| [core/graphemes.ts](../src/core/graphemes.ts) | `GraphemeCursor`, `GraphemeOptions`, `GraphemeProgress`, `GraphemeRange`, `GraphemeSource` |
| [core/history.ts](../src/core/history.ts) | `EditKind`, `HistoryOptions`, `HistorySnapshot` |
| [core/language-configuration.ts](../src/core/language-configuration.ts) | `EditingPair`, `EnterIndent`, `LanguageConfiguration`, `LanguageEditContext`, `PairingContext`, `ResolvedLanguageConfiguration`, `resolveLanguageConfiguration` |
| [core/language-edits.ts](../src/core/language-edits.ts) | `EditingCommand`, `planLanguageEdit` |
| [core/newlines.ts](../src/core/newlines.ts) | `ImportedText`, `LineEnding`, `exportText`, `importText` |
| [core/observable.ts](../src/core/observable.ts) | `AfterDelivery`, `NotificationScope`, `Observable`, `ObservableListener` |
| [core/positions.ts](../src/core/positions.ts) | `Affinity`, `AnchoredRange`, `MappedPosition`, `PositionMapping`, `anchoredRange` |
| [core/search.ts](../src/core/search.ts) | `LiteralSearchOptions`, `SearchMatch`, `SearchStep` |
| [core/selections.ts](../src/core/selections.ts) | `Selection`, `SelectionEditPlan`, `SelectionSet` |
| [core/snippets.ts](../src/core/snippets.ts) | `Snippet`, `SnippetEditPlan`, `SnippetOccurrence`, `SnippetParseResult`, `SnippetStop` |
| [core/text-buffer.ts](../src/core/text-buffer.ts) | `BufferChange`, `BufferLine`, `BufferPosition`, `BufferRetention`, `TextBuffer` |
| [core/text-transaction.ts](../src/core/text-transaction.ts) | `TextTransaction` |
| [core/values.ts](../src/core/values.ts) | `Immutable`, `SnapshotValue` |
| [core/workspace-tabs.ts](../src/core/workspace-tabs.ts) | `WorkspaceTabs` |
| [core/workspace.ts](../src/core/workspace.ts) | `BatchEditResult`, `Capabilities`, `ChangeResult`, `DocumentChange`, `DocumentEditRequest`, `DocumentId`, `DocumentLanguage`, `DocumentSnapshot`, `DocumentView`, `DocumentViewSnapshot`, `EditLease`, `EditOrigin`, `EditRequest`, `EditResult`, `HistoryRequest`, `LoadedResource`, `LoadedTextBuffer`, `PaneId`, `ResourceHandle`, `ResourceId`, `ResourceKey`, `ResourceLease`, `ResourceLoad`, `ResourceMetadata`, `ResourceOptions`, `ResourceSnapshot`, `ResourceTarget`, `ResourceVisibility`, `SaveReceipt`, `SaveReview`, `SaveSubmission`, `SaveTicket`, `Surface`, `TabId`, `TabSnapshot`, `TabTarget`, `TextResourceHandle`, `TextResourceOptions`, `TextTransactionOptions`, `TextWriteResult`, `ViewId`, `Workspace`, `WorkspaceOptions`, `WorkspaceSnapshot` |

## `sttropez/browser`

| Source | Public names |
| --- | --- |
| [browser/anchored-overlay.ts](../src/browser/anchored-overlay.ts) | `AnchoredOverlay`, `AnchoredOverlayOptions`, `OverlayAnchor`, `OverlayHideReason`, `OverlayPosition`, `mountAnchoredOverlay` |
| [browser/bracket-highlights.ts](../src/browser/bracket-highlights.ts) | `BracketHighlightSnapshot`, `BracketHighlights` |
| [browser/captured-insertion.ts](../src/browser/captured-insertion.ts) | `CapturedInsertion` |
| [browser/captured-view.ts](../src/browser/captured-view.ts) | `CapturedViewOptions`, `CapturedViewRequest`, `captureViewRequest` |
| [browser/character-warnings.ts](../src/browser/character-warnings.ts) | `CharacterWarningCapture`, `CharacterWarningHighlights` |
| [browser/code-action-controller.ts](../src/browser/code-action-controller.ts) | `CodeActionChoice`, `CodeActionController`, `CodeActionControllerOptions`, `CodeActionPreview`, `CodeActionSnapshot` |
| [browser/code-action-popup.ts](../src/browser/code-action-popup.ts) | `CodeActionPopupOptions` |
| [browser/command-registry.ts](../src/browser/command-registry.ts) | `EditorCommand`, `EditorCommands`, `EditorKeymap` |
| [browser/comparison-alignment.ts](../src/browser/comparison-alignment.ts) | `ComparisonAlignmentSnapshot` |
| [browser/comparison.ts](../src/browser/comparison.ts) | `TextComparison`, `TextComparisonDiagnostics`, `TextComparisonHunk`, `TextComparisonOptions`, `TextComparisonSnapshot`, `mountTextComparison` |
| [browser/completion-controller.ts](../src/browser/completion-controller.ts) | `CompletionChoice`, `CompletionController`, `CompletionControllerOptions`, `CompletionSnapshot`, `CompletionSnippet` |
| [browser/control-strings.ts](../src/browser/control-strings.ts) | `ControlStrings` |
| [browser/decoration-layers.ts](../src/browser/decoration-layers.ts) | `DecorationLayer`, `DecorationLayerOptions`, `DecorationLayers`, `DecorationProvider` |
| [browser/diagnostic-controller.ts](../src/browser/diagnostic-controller.ts) | `DiagnosticController`, `DiagnosticControllerOptions`, `DiagnosticSnapshot`, `EditorDiagnostic`, `diagnosticDecoration` |
| [browser/document-color-controller.ts](../src/browser/document-color-controller.ts) | `ColorPresentationChoice`, `ColorPresentationReview`, `DocumentColorChoice`, `DocumentColorController`, `DocumentColorControllerOptions`, `DocumentColorSnapshot` |
| [browser/document-link-controller.ts](../src/browser/document-link-controller.ts) | `DocumentLinkChoice`, `DocumentLinkController`, `DocumentLinkControllerOptions`, `DocumentLinkSnapshot` |
| [browser/documentation.ts](../src/browser/documentation.ts) | `DocumentationOptions`, `DocumentationView`, `mountDocumentation` |
| [browser/editor-language.ts](../src/browser/editor-language.ts) | `EditorLanguageAttachment`, `EditorLanguageOptions`, `attachEditorLanguage` |
| [browser/find-bar.ts](../src/browser/find-bar.ts) | `FindBar`, `FindBarOptions`, `mountFindBar` |
| [browser/find-controls.ts](../src/browser/find-controls.ts) | `FindCommandOptions`, `bindFindCommands` |
| [browser/find.ts](../src/browser/find.ts) | `FindController`, `FindControllerOptions`, `FindDiagnostics`, `FindFlags`, `FindReason`, `FindSnapshot`, `createFindController` |
| [browser/folding-controller.ts](../src/browser/folding-controller.ts) | `FoldCommand`, `FoldDiscovery`, `FoldDiscoveryBatch`, `FoldDiscoveryCursor`, `FoldDiscoveryResult`, `FoldingController`, `FoldingStatus`, `createFoldingController` |
| [browser/hover-controller.ts](../src/browser/hover-controller.ts) | `HoverController`, `HoverControllerOptions`, `HoverDiagnostics`, `HoverSnapshot` |
| [browser/hover-popup.ts](../src/browser/hover-popup.ts) | `HoverPopupAction`, `HoverPopupOptions` |
| [browser/input-events.ts](../src/browser/input-events.ts) | `EditRefusedDetail`, `InputConflictDetail`, `editRefusedEvent`, `inputConflictEvent` |
| [browser/language-command.ts](../src/browser/language-command.ts) | `ChangedDocument`, `LanguageCommandOptions`, `LanguageCommands` |
| [browser/location-chooser.ts](../src/browser/location-chooser.ts) | `LocationChooserOptions` |
| [browser/lsp-highlights.ts](../src/browser/lsp-highlights.ts) | `LspHighlightController`, `LspHighlightSnapshot` |
| [browser/lsp-websocket.ts](../src/browser/lsp-websocket.ts) | `WebSocketTransportOptions`, `openWebSocketTransport` |
| [browser/lsp-workspace.ts](../src/browser/lsp-workspace.ts) | `BrowserLspWorkspace`, `BrowserLspWorkspaceOptions` |
| [browser/navigation-controller.ts](../src/browser/navigation-controller.ts) | `NavigationChoice`, `NavigationController`, `NavigationControllerOptions`, `NavigationDestination`, `NavigationPointerLink`, `NavigationResult`, `NavigationSnapshot` |
| [browser/navigation-history.ts](../src/browser/navigation-history.ts) | `NavigationHistory`, `NavigationOrigin`, `createNavigationHistory` |
| [browser/pointer-dwell.ts](../src/browser/pointer-dwell.ts) | `PointerDwell`, `PointerDwellOptions`, `PointerDwellPosition`, `observePointerDwell` |
| [browser/regex-find.ts](../src/browser/regex-find.ts) | `RegexFindBackendOptions`, `createRegexFindBackend` |
| [browser/rename-controller.ts](../src/browser/rename-controller.ts) | `RenameController`, `RenameControllerOptions`, `RenamePreview`, `RenameSnapshot` |
| [browser/rename-popup.ts](../src/browser/rename-popup.ts) | `RenamePopupOptions` |
| [browser/signature-controller.ts](../src/browser/signature-controller.ts) | `SignatureController`, `SignatureControllerOptions`, `SignatureSnapshot` |
| [browser/signature-popup.ts](../src/browser/signature-popup.ts) | `SignaturePopupOptions` |
| [browser/text-editor.ts](../src/browser/text-editor.ts) | `EditorEditIntent`, `EditorPasteHandler`, `EditorRevealOptions`, `EditorRevealRange`, `EditorSettings`, `LinePrompt`, `ResolvedEditorSettings`, `TextEditor`, `TextEditorActivity`, `TextEditorCommand`, `TextEditorDiagnostics`, `TextEditorEdit`, `TextEditorEditTransform`, `TextEditorOptions`, `TextEditorSnapshot`, `mountTextEditor` |
| [browser/view-state.ts](../src/browser/view-state.ts) | `ViewRestoreOptions`, `ViewRestoreResult`, `ViewState` |
| [browser/viewport.ts](../src/browser/viewport.ts) | `FoldLabels`, `InlineDecoration`, `LineClass`, `LineDecorator`, `PresentedLine`, `RenderedRowBounds`, `RevealAlignment`, `RevealOptions`, `TextViewport`, `TextViewportOptions`, `ViewportActivity`, `ViewportDiagnostics`, `ViewportInputBinding`, `ViewportSettings`, `ViewportSnapshot` |
| [core/documentation.ts](../src/core/documentation.ts) | `DocumentationContent`, `DocumentationPart` |
| [core/outcome.ts](../src/core/outcome.ts) | `Outcome` |

## `sttropez/protocol`

| Source | Public names |
| --- | --- |
| [core/documentation.ts](../src/core/documentation.ts) | `DocumentationContent`, `DocumentationPart` |
| [protocol/json-rpc.ts](../src/protocol/json-rpc.ts) | `RpcCall`, `RpcId`, `RpcOptions`, `RpcRequestContext`, `RpcScheduler`, `RpcTransport` |
| [protocol/lsp-client.ts](../src/protocol/lsp-client.ts) | `LspClientDiagnostics`, `LspDocumentRequest`, `LspFeatureClient`, `LspPositionRequest`, `LspProjectRequest` |
| [protocol/lsp-code-actions.ts](../src/protocol/lsp-code-actions.ts) | `LspCodeAction`, `LspCodeActions` |
| [protocol/lsp-command-value.ts](../src/protocol/lsp-command-value.ts) | `LspCommand` |
| [protocol/lsp-command.ts](../src/protocol/lsp-command.ts) | `LspCommandPolicy`, `LspCommandReceipt`, `LspCommandRoute`, `LspCommandRunner`, `LspCommandScope`, `LspHostCommandContext`, `createLspCommandRunner` |
| [protocol/lsp-features.ts](../src/protocol/lsp-features.ts) | `LspApplyEdit`, `LspApplyEditResult`, `LspColor`, `LspColorPresentation`, `LspCompletion`, `LspCompletionFallback`, `LspCompletionOptions`, `LspCompletionPlan`, `LspCompletions`, `LspDiagnostic`, `LspDiagnostics`, `LspDocumentColor`, `LspDocumentEdits`, `LspDocumentLink`, `LspEditTarget`, `LspHover`, `LspLocation`, `LspLocationTarget`, `LspSignature`, `LspSignatureHelp`, `LspWorkspaceEdit`, `lspRangeOffsets` |
| [protocol/lsp-folding.ts](../src/protocol/lsp-folding.ts) | `LspFoldingClient`, `createLspFoldingClient` |
| [protocol/lsp-highlights.ts](../src/protocol/lsp-highlights.ts) | `LspDocumentHighlight`, `LspDocumentHighlights` |
| [protocol/lsp-navigation.ts](../src/protocol/lsp-navigation.ts) | `LspNavigationRequest` |
| [protocol/lsp-positions.ts](../src/protocol/lsp-positions.ts) | `LspChangeHint`, `LspCooperate`, `LspLineIndex`, `LspPosition`, `LspRange`, `LspTextChange` |
| [protocol/lsp-session.ts](../src/protocol/lsp-session.ts) | `LspCall`, `LspClientFeature`, `LspCommandAuthorization`, `LspCommandCall`, `LspConnectContext`, `LspDocument`, `LspDocumentCapture`, `LspDocumentFeature`, `LspDocumentSnapshot`, `LspFeature`, `LspRegistration`, `LspRequestContext`, `LspSessionOptions`, `LspSessionSnapshot` |
| [protocol/lsp-targets.ts](../src/protocol/lsp-targets.ts) | `LspTargetContext`, `LspTargetResolver`, `LspTargetSource` |
| [protocol/lsp-workspace-edit.ts](../src/protocol/lsp-workspace-edit.ts) | `LspEditNotes`, `LspWorkspaceEditNote`, `readLspEditNotes` |
| [protocol/lsp-workspace.ts](../src/protocol/lsp-workspace.ts) | `LspBindingCapture`, `LspDiagnosticState`, `LspPrepare`, `LspScopeAccess`, `LspWorkspace`, `LspWorkspaceOptions`, `LspWorkspaceScope`, `LspWorkspaceSnapshot` |
| [protocol/wire.ts](../src/protocol/wire.ts) | `JsonValue`, `ProtocolDecodeError`, `RpcError` |

## `sttropez/kernels`

| Source | Public names |
| --- | --- |
| [core/buffer-change.ts](../src/core/buffer-change.ts) | `BufferChangeCursor` |
| [core/changes.ts](../src/core/changes.ts) | `validateTextEdits` |
| [core/diff.ts](../src/core/diff.ts) | `TextDiff` |
| [core/graphemes.ts](../src/core/graphemes.ts) | `GraphemeIndex`, `GraphemeLimitError`, `createGraphemeCursor`, `graphemeBoundaries` |
| [core/positions.ts](../src/core/positions.ts) | `PositionMap`, `composePositionMaps` |
| [core/search.ts](../src/core/search.ts) | `LiteralSearch` |
| [core/selections.ts](../src/core/selections.ts) | `mapSelectionSet`, `planSelectionEdits` |
| [core/snippets.ts](../src/core/snippets.ts) | `offsetSnippetStops`, `parseSnippet`, `planSnippetChoice`, `planSnippetEdit`, `snippetChoiceText` |
| [protocol/json-rpc.ts](../src/protocol/json-rpc.ts) | `JsonRpcConnection` |
| [protocol/lsp-features.ts](../src/protocol/lsp-features.ts) | `decodeLspDiagnostics` |
| [protocol/lsp-session.ts](../src/protocol/lsp-session.ts) | `LspSession` |
| [protocol/lsp-workspace-edit.ts](../src/protocol/lsp-workspace-edit.ts) | `LspWorkspaceEditOptions`, `applyLspWorkspaceEdit` |
