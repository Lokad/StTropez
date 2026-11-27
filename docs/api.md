# Public API index

Import a name from the entry above its table. Each entry includes TypeScript declarations in the package.
Follow a name to its source, or use Go to Definition in your project to open the installed declaration.

## `sttropez`

Declarations start at `index.d.ts` in the assets directory.

| Export | Kind | Purpose |
| --- | --- | --- |
| [`Affinity`](../src/core/positions.ts) | type |  |
| [`AfterDelivery`](../src/core/observable.ts) | type | Queue work from the active listener for after the synchronous command and its notifications. |
| [`anchoredRange`](../src/core/positions.ts) | function |  |
| [`AnchoredRange`](../src/core/positions.ts) | type |  |
| [`BatchEditResult`](../src/core/workspace.ts) | type | Success carries one resulting revision per document, in request order. |
| [`BracketMatchOptions`](../src/core/bracket-matching.ts) | type |  |
| [`BracketMatchResult`](../src/core/bracket-matching.ts) | type |  |
| [`BufferChange`](../src/core/text-buffer.ts) | type |  |
| [`BufferChangeSpan`](../src/core/buffer-change.ts) | type |  |
| [`BufferLine`](../src/core/text-buffer.ts) | type |  |
| [`BufferPosition`](../src/core/text-buffer.ts) | type |  |
| [`BufferRetention`](../src/core/text-buffer.ts) | type |  |
| [`Capabilities`](../src/core/workspace.ts) | type | Edit origins allowed to change the document and permission to save its text. |
| [`CharacterWarning`](../src/core/character-warnings.ts) | type |  |
| [`CharacterWarningBatch`](../src/core/character-warnings.ts) | type |  |
| [`CharacterWarningConfiguration`](../src/core/character-warnings.ts) | type |  |
| [`CharacterWarningKind`](../src/core/character-warnings.ts) | type |  |
| [`characterWarningLabel`](../src/core/character-warnings.ts) | function |  |
| [`CharacterWarningLimits`](../src/core/character-warnings.ts) | type |  |
| [`CharacterWarningOptions`](../src/core/character-warnings.ts) | type |  |
| [`ComparisonBaseline`](../src/core/comparison.ts) | type |  |
| [`ComparisonCapture`](../src/core/comparison.ts) | type |  |
| [`ComparisonController`](../src/core/comparison.ts) | type |  |
| [`ComparisonHunk`](../src/core/comparison.ts) | type | Exact hunk from one comparison run. |
| [`ComparisonReversion`](../src/core/comparison.ts) | type |  |
| [`ComparisonSnapshot`](../src/core/comparison.ts) | type |  |
| [`ComparisonTicket`](../src/core/comparison.ts) | type |  |
| [`createFoldRegions`](../src/core/folding.ts) | function |  |
| [`DiffHunk`](../src/core/diff.ts) | type |  |
| [`DiffProgress`](../src/core/diff.ts) | type |  |
| [`DiffRange`](../src/core/diff.ts) | type |  |
| [`DiscoveredFold`](../src/core/fold-discovery.ts) | type |  |
| [`discoverIndentationFolds`](../src/core/fold-discovery.ts) | function | Lazy off-side/marker discovery. |
| [`DocumentationContent`](../src/core/documentation.ts) | type |  |
| [`DocumentationPart`](../src/core/documentation.ts) | type | Provider/host content retains its format; literal text is never inferred to be Markdown. |
| [`DocumentChange`](../src/core/workspace.ts) | type | The edits and position mapping between two revisions of one document. |
| [`DocumentEditRequest`](../src/core/workspace.ts) | type | Range edits or replacement text for a captured revision of one document. |
| [`DocumentFolding`](../src/core/folding.ts) | type |  |
| [`DocumentId`](../src/core/workspace.ts) | type |  |
| [`DocumentLanguage`](../src/core/workspace.ts) | type |  |
| [`DocumentSnapshot`](../src/core/workspace.ts) | type | An immutable buffer and its local revision. |
| [`DocumentView`](../src/core/workspace.ts) | type | A retained selection and fold state that can outlive the editor mounted on it. |
| [`DocumentViewSnapshot`](../src/core/workspace.ts) | type |  |
| [`EditingCommand`](../src/core/language-edits.ts) | type |  |
| [`EditingPair`](../src/core/language-configuration.ts) | type |  |
| [`EditKind`](../src/core/history.ts) | type |  |
| [`EditOrigin`](../src/core/workspace.ts) | type |  |
| [`EditRequest`](../src/core/workspace.ts) | type |  |
| [`EditResult`](../src/core/workspace.ts) | type | Success carries the resulting document revision. |
| [`EnterIndent`](../src/core/language-configuration.ts) | type |  |
| [`FindBackend`](../src/core/find.ts) | type | One controller owns the backend until expiry/destruction. |
| [`FindPlanCursor`](../src/core/find.ts) | type |  |
| [`FindPlanStep`](../src/core/find.ts) | type |  |
| [`FindQueryCapture`](../src/core/find.ts) | type |  |
| [`FindSearchCursor`](../src/core/find.ts) | type |  |
| [`FoldIndex`](../src/core/folding.ts) | class | One interval per outer collapsed fold; no array proportional to document line count. |
| [`FoldingSnapshot`](../src/core/folding.ts) | type |  |
| [`FoldRange`](../src/core/folding.ts) | type | Host-owned raw anchors include a visible header and at least one complete body row. |
| [`FoldRegion`](../src/core/folding.ts) | type |  |
| [`FoldVersion`](../src/core/folding.ts) | type |  |
| [`HistoryOptions`](../src/core/history.ts) | type |  |
| [`HistoryRequest`](../src/core/workspace.ts) | type |  |
| [`HistorySnapshot`](../src/core/history.ts) | type |  |
| [`IndentationFoldingCursor`](../src/core/fold-discovery.ts) | type |  |
| [`IndentationFoldingOptions`](../src/core/fold-discovery.ts) | type |  |
| [`IndentationFoldingProgress`](../src/core/fold-discovery.ts) | type |  |
| [`LanguageConfiguration`](../src/core/language-configuration.ts) | type | Callbacks inspect this exact immutable buffer; language analysis and its cost belong to the host. |
| [`LanguageEditContext`](../src/core/language-configuration.ts) | type |  |
| [`LiteralSearchOptions`](../src/core/search.ts) | type |  |
| [`LoadedResource`](../src/core/workspace.ts) | type |  |
| [`MappedPosition`](../src/core/positions.ts) | type |  |
| [`NotificationScope`](../src/core/observable.ts) | class | All stores publish before delivery. |
| [`Observable`](../src/core/observable.ts) | type |  |
| [`ObservableListener`](../src/core/observable.ts) | type |  |
| [`PairingContext`](../src/core/language-configuration.ts) | type |  |
| [`planLanguageEdit`](../src/core/language-edits.ts) | function | Plan one complete edit against the captured text, selections and folds. |
| [`PositionMapping`](../src/core/positions.ts) | type |  |
| [`ResolvedLanguageConfiguration`](../src/core/language-configuration.ts) | type |  |
| [`resolveLanguageConfiguration`](../src/core/language-configuration.ts) | function |  |
| [`ResourceKey`](../src/core/workspace.ts) | type | Persistent host key for a resource, scoped by project and variant. |
| [`ResourceLease`](../src/core/workspace.ts) | type |  |
| [`ResourceLoad`](../src/core/workspace.ts) | type | Accept or reject the result of one load while it owns the resource. |
| [`ResourceMetadata`](../src/core/workspace.ts) | type | Loading, permission, dirty and save state available without reading the document text. |
| [`ResourceSnapshot`](../src/core/workspace.ts) | type |  |
| [`ResourceTarget`](../src/core/workspace.ts) | type | Identifies a document in its originating workspace across a delayed operation. |
| [`ResourceVisibility`](../src/core/workspace.ts) | type |  |
| [`runSaveBatch`](../src/core/workspace.ts) | function | Submit a fixed set of captured saves in one storage call. |
| [`SaveReceipt`](../src/core/workspace.ts) | type | The acknowledged baseline for a write and its relation to the current working copy. |
| [`SaveResponse`](../src/core/workspace.ts) | type |  |
| [`SaveReview`](../src/core/workspace.ts) | type | Host-confirmed remote version for saving the explicitly reviewed local revision. |
| [`SaveSubmission`](../src/core/workspace.ts) | type | Captured text, revision and expected storage version supplied to a host write. |
| [`SaveTicket`](../src/core/workspace.ts) | type | Holds text and revision for a save. |
| [`SearchMatch`](../src/core/search.ts) | type |  |
| [`SearchStep`](../src/core/search.ts) | type |  |
| [`Selection`](../src/core/selections.ts) | type |  |
| [`SelectionEditPlan`](../src/core/selections.ts) | type |  |
| [`SelectionSet`](../src/core/selections.ts) | type |  |
| [`Snippet`](../src/core/snippets.ts) | type |  |
| [`SnippetEditPlan`](../src/core/snippets.ts) | type |  |
| [`SnippetOccurrence`](../src/core/snippets.ts) | type |  |
| [`SnippetParseResult`](../src/core/snippets.ts) | type |  |
| [`SnippetStop`](../src/core/snippets.ts) | type |  |
| [`TextBuffer`](../src/core/text-buffer.ts) | class | Immutable persistent piece tree. |
| [`textDifference`](../src/core/changes.ts) | function | Minimal single replacement for explicit whole-text boundaries such as native input or canonical saves. |
| [`TextEdit`](../src/core/changes.ts) | type | Offsets are UTF-16 code units in the original document. |
| [`TextResourceHandle`](../src/core/workspace.ts) | type | Observe one resource from its creation through release, including periods when its text is unavailable. |
| [`TextResourceOptions`](../src/core/workspace.ts) | type | Omit value to open a loading document. |
| [`TextTransaction`](../src/core/text-transaction.ts) | type |  |
| [`TextTransactionOptions`](../src/core/workspace.ts) | type |  |
| [`TextWriteResult`](../src/core/workspace.ts) | type | Success carries the current revision and whether the text changed. |
| [`ViewId`](../src/core/workspace.ts) | type |  |
| [`Workspace`](../src/core/workspace.ts) | class | Framework-free resource ownership and versioned transactions. |
| [`WorkspaceOptions`](../src/core/workspace.ts) | type | History limits and the handler for errors thrown by observable listeners. |
| [`WorkspaceSnapshot`](../src/core/workspace.ts) | type |  |

## `sttropez/browser`

Declarations start at `browser/index.d.ts` in the assets directory.

| Export | Kind | Purpose |
| --- | --- | --- |
| [`AnchoredOverlay`](../src/browser/anchored-overlay.ts) | type |  |
| [`AnchoredOverlayOptions`](../src/browser/anchored-overlay.ts) | type |  |
| [`attachEditorLanguage`](../src/browser/editor-language.ts) | function | Independently mounted panels on the same editor and provider share its source binding. |
| [`attachLineTokenizer`](../src/browser/line-tokenizer.ts) | function | Color one editor and reuse unchanged lines when their incoming lexer state agrees. |
| [`bindFindCommands`](../src/browser/find-controls.ts) | function | Bind the shared Find shortcuts to one pane and the host fields that act on it. |
| [`BracketHighlights`](../src/browser/bracket-highlights.ts) | type |  |
| [`BracketHighlightSnapshot`](../src/browser/bracket-highlights.ts) | type |  |
| [`BrowserLspWorkspace`](../src/browser/lsp-workspace.ts) | class | Shares the protocol workspace's bindings and scopes. |
| [`BrowserLspWorkspaceOptions`](../src/browser/lsp-workspace.ts) | type |  |
| [`CapturedInsertion`](../src/browser/captured-insertion.ts) | type |  |
| [`CapturedViewOptions`](../src/browser/captured-view.ts) | type |  |
| [`CapturedViewRequest`](../src/browser/captured-view.ts) | type |  |
| [`captureViewRequest`](../src/browser/captured-view.ts) | function | Capture a request until the editor closes or its source changes. |
| [`ChangedDocument`](../src/browser/language-command.ts) | type |  |
| [`CharacterWarningCapture`](../src/browser/character-warnings.ts) | type |  |
| [`CharacterWarningHighlights`](../src/browser/character-warnings.ts) | type |  |
| [`CodeActionChoice`](../src/browser/code-action-controller.ts) | type |  |
| [`CodeActionController`](../src/browser/code-action-controller.ts) | type |  |
| [`CodeActionControllerOptions`](../src/browser/code-action-controller.ts) | type |  |
| [`CodeActionPopupOptions`](../src/browser/code-action-popup.ts) | type |  |
| [`CodeActionPreview`](../src/browser/code-action-controller.ts) | type |  |
| [`CodeActionSnapshot`](../src/browser/code-action-controller.ts) | type |  |
| [`ColorPresentationChoice`](../src/browser/document-color-controller.ts) | type |  |
| [`ColorPresentationReview`](../src/browser/document-color-controller.ts) | type |  |
| [`ComparisonAlignmentSnapshot`](../src/browser/comparison-alignment.ts) | type |  |
| [`CompletionChoice`](../src/browser/completion-controller.ts) | type |  |
| [`CompletionController`](../src/browser/completion-controller.ts) | type |  |
| [`CompletionControllerOptions`](../src/browser/completion-controller.ts) | type |  |
| [`CompletionSnapshot`](../src/browser/completion-controller.ts) | type |  |
| [`CompletionSnippet`](../src/browser/completion-controller.ts) | type |  |
| [`ControlStrings`](../src/browser/control-strings.ts) | type |  |
| [`createFindController`](../src/browser/find.ts) | function | Host-rendered find UI; scanning/planning yield, while replacement uses one captured transaction. |
| [`createFoldingController`](../src/browser/folding-controller.ts) | function | One discovery policy for one retained view. |
| [`createNavigationHistory`](../src/browser/navigation-history.ts) | function | Keep successful jumps and map the saved positions through document changes. |
| [`createRegexFindBackend`](../src/browser/regex-find.ts) | function | The host creates a dedicated module worker from the shipped browser/regex-worker.js asset. |
| [`DecorationLayer`](../src/browser/decoration-layers.ts) | type |  |
| [`DecorationLayerOptions`](../src/browser/decoration-layers.ts) | type |  |
| [`DecorationLayers`](../src/browser/decoration-layers.ts) | type |  |
| [`DecorationProvider`](../src/browser/decoration-layers.ts) | type |  |
| [`DiagnosticController`](../src/browser/diagnostic-controller.ts) | type |  |
| [`DiagnosticControllerOptions`](../src/browser/diagnostic-controller.ts) | type |  |
| [`diagnosticDecoration`](../src/browser/diagnostic-controller.ts) | function | The same marks serve provider pushes and host-supplied diagnostics. |
| [`DiagnosticSnapshot`](../src/browser/diagnostic-controller.ts) | type |  |
| [`DocumentationContent`](../src/core/documentation.ts) | type |  |
| [`DocumentationOptions`](../src/browser/documentation.ts) | type |  |
| [`DocumentationPart`](../src/core/documentation.ts) | type | Provider/host content retains its format; literal text is never inferred to be Markdown. |
| [`DocumentationView`](../src/browser/documentation.ts) | type |  |
| [`DocumentColorChoice`](../src/browser/document-color-controller.ts) | type |  |
| [`DocumentColorController`](../src/browser/document-color-controller.ts) | type |  |
| [`DocumentColorControllerOptions`](../src/browser/document-color-controller.ts) | type |  |
| [`DocumentColorSnapshot`](../src/browser/document-color-controller.ts) | type |  |
| [`DocumentLinkChoice`](../src/browser/document-link-controller.ts) | type |  |
| [`DocumentLinkController`](../src/browser/document-link-controller.ts) | type |  |
| [`DocumentLinkControllerOptions`](../src/browser/document-link-controller.ts) | type |  |
| [`DocumentLinkSnapshot`](../src/browser/document-link-controller.ts) | type |  |
| [`EditorCommand`](../src/browser/command-registry.ts) | type |  |
| [`EditorCommands`](../src/browser/command-registry.ts) | type | Register, inspect and run commands on a specific editor mount. |
| [`EditorDiagnostic`](../src/browser/diagnostic-controller.ts) | type |  |
| [`EditorEditIntent`](../src/browser/text-editor.ts) | type |  |
| [`EditorKeymap`](../src/browser/command-registry.ts) | type | Bind shortcuts for this mount and forward a shared shortcut from a host control. |
| [`EditorLanguageAttachment`](../src/browser/editor-language.ts) | type | The selected controllers and one disposer for their shared attachment. |
| [`EditorLanguageOptions`](../src/browser/editor-language.ts) | type | Select the language features to attach to this editor and configure their UI. |
| [`EditorPasteHandler`](../src/browser/text-editor.ts) | type | Read custom formats during the paste event and return a converter for the captured insertion. |
| [`EditorRevealOptions`](../src/browser/text-editor.ts) | type | Set scrolling, selection and focus behavior and optionally require a specific revision. |
| [`EditorRevealRange`](../src/browser/text-editor.ts) | type |  |
| [`EditorSettings`](../src/browser/text-editor.ts) | type | Per-view language rules, drawing options and input preferences accepted by configure. |
| [`EditRefusedDetail`](../src/browser/input-events.ts) | type |  |
| [`editRefusedEvent`](../src/browser/input-events.ts) | value | Bubbles from the editor root when read-only authority prevents an input gesture. |
| [`FindBar`](../src/browser/find-bar.ts) | type |  |
| [`FindBarOptions`](../src/browser/find-bar.ts) | type |  |
| [`FindCommandOptions`](../src/browser/find-controls.ts) | type |  |
| [`FindController`](../src/browser/find.ts) | type | Find and replace within one captured editor view and observe progress as matches arrive. |
| [`FindControllerOptions`](../src/browser/find.ts) | type | Choose highlights, an optional regex backend and its query delay at construction. |
| [`FindDiagnostics`](../src/browser/find.ts) | type | Maximum search step and last replacement transaction durations, in milliseconds. |
| [`FindFlags`](../src/browser/find.ts) | type | Case, whole-word and regular-expression options for one query. |
| [`FindReason`](../src/browser/find.ts) | type | Stable cause of the last published notice, independent of its display message. |
| [`FindSnapshot`](../src/browser/find.ts) | type | Current query, revision, match count and replacement notice. |
| [`FoldCommand`](../src/browser/folding-controller.ts) | type |  |
| [`FoldDiscovery`](../src/browser/folding-controller.ts) | type |  |
| [`FoldDiscoveryBatch`](../src/browser/folding-controller.ts) | type |  |
| [`FoldDiscoveryCursor`](../src/browser/folding-controller.ts) | type |  |
| [`FoldDiscoveryResult`](../src/browser/folding-controller.ts) | type |  |
| [`FoldingController`](../src/browser/folding-controller.ts) | type |  |
| [`FoldingStatus`](../src/browser/folding-controller.ts) | type |  |
| [`FoldLabels`](../src/browser/viewport.ts) | type |  |
| [`HoverController`](../src/browser/hover-controller.ts) | type |  |
| [`HoverControllerOptions`](../src/browser/hover-controller.ts) | type |  |
| [`HoverDiagnostics`](../src/browser/hover-controller.ts) | type | Hosts with project-wide analysis can supply the diagnostics they actually paint. |
| [`HoverPopupAction`](../src/browser/hover-popup.ts) | type |  |
| [`HoverPopupOptions`](../src/browser/hover-popup.ts) | type |  |
| [`HoverSnapshot`](../src/browser/hover-controller.ts) | type |  |
| [`InlineDecoration`](../src/browser/viewport.ts) | type |  |
| [`InputConflictDetail`](../src/browser/input-events.ts) | type | A recovery notification, not permission to apply an edit. |
| [`inputConflictEvent`](../src/browser/input-events.ts) | value | Dispatched on the editor's input. |
| [`isEditorIdle`](../src/browser/captured-view.ts) | function | A mounted, enabled editor with no composition or host insertion in progress. |
| [`LanguageCommandOptions`](../src/browser/language-command.ts) | type |  |
| [`LanguageCommands`](../src/browser/language-command.ts) | type |  |
| [`LineClass`](../src/browser/viewport.ts) | type |  |
| [`LineDecorator`](../src/browser/viewport.ts) | type | Return decorations for one requested fragment using absolute document offsets. |
| [`LinePrompt`](../src/browser/text-editor.ts) | type | Ask the host for a one-based line number and cancel the prompt if its target expires. |
| [`LineTokenizerOptions`](../src/browser/line-tokenizer.ts) | type | A synchronous line lexer. |
| [`LocationChooserOptions`](../src/browser/location-chooser.ts) | type |  |
| [`LspHighlightController`](../src/browser/lsp-highlights.ts) | type |  |
| [`LspHighlightSnapshot`](../src/browser/lsp-highlights.ts) | type |  |
| [`mountAnchoredOverlay`](../src/browser/anchored-overlay.ts) | function | Positions a host popup against a painted source position without scrolling or focusing the editor. |
| [`mountDocumentation`](../src/browser/documentation.ts) | function | Small documentation presentation, not a general Markdown engine. |
| [`mountFindBar`](../src/browser/find-bar.ts) | function | Mount outside the editor subtree. |
| [`mountTextComparison`](../src/browser/comparison.ts) | function | Two independently virtualized panes. |
| [`mountTextEditor`](../src/browser/text-editor.ts) | function | Text editor with bounded native input and virtualized rendering. |
| [`NavigationChoice`](../src/browser/navigation-controller.ts) | type |  |
| [`NavigationController`](../src/browser/navigation-controller.ts) | type |  |
| [`NavigationControllerOptions`](../src/browser/navigation-controller.ts) | type |  |
| [`NavigationDestination`](../src/browser/navigation-controller.ts) | type |  |
| [`NavigationHistory`](../src/browser/navigation-history.ts) | type |  |
| [`NavigationOrigin`](../src/browser/navigation-history.ts) | type |  |
| [`NavigationPointerLink`](../src/browser/navigation-controller.ts) | type |  |
| [`NavigationResult`](../src/browser/navigation-controller.ts) | type |  |
| [`NavigationSnapshot`](../src/browser/navigation-controller.ts) | type |  |
| [`observePointerDwell`](../src/browser/pointer-dwell.ts) | function | Observe a stationary pointer over this editor's painted text without changing selection or focus. |
| [`openWebSocketTransport`](../src/browser/lsp-websocket.ts) | function | Host-owned, text-message JSON-RPC framing. |
| [`Outcome`](../src/core/outcome.ts) | type | Result of a command or request against a captured workspace or view. |
| [`OverlayAnchor`](../src/browser/anchored-overlay.ts) | type |  |
| [`OverlayHideReason`](../src/browser/anchored-overlay.ts) | type |  |
| [`OverlayPosition`](../src/browser/anchored-overlay.ts) | type |  |
| [`PointerDwell`](../src/browser/pointer-dwell.ts) | type |  |
| [`PointerDwellOptions`](../src/browser/pointer-dwell.ts) | type |  |
| [`PointerDwellPosition`](../src/browser/pointer-dwell.ts) | type |  |
| [`PresentedLine`](../src/browser/viewport.ts) | type | The visible UTF-16 fragment of a source line, identified by document and revision. |
| [`ReferenceViewState`](../src/browser/comparison.ts) | type | Scroll, folds and selection retained for the same working resource and reference baseline. |
| [`RegexFindBackendOptions`](../src/browser/regex-find.ts) | type |  |
| [`RenameController`](../src/browser/rename-controller.ts) | type |  |
| [`RenameControllerOptions`](../src/browser/rename-controller.ts) | type |  |
| [`RenamePopupOptions`](../src/browser/rename-popup.ts) | type |  |
| [`RenamePreview`](../src/browser/rename-controller.ts) | type |  |
| [`RenameSnapshot`](../src/browser/rename-controller.ts) | type |  |
| [`RenderedRowBounds`](../src/browser/viewport.ts) | type |  |
| [`ResolvedEditorSettings`](../src/browser/text-editor.ts) | type |  |
| [`RevealAlignment`](../src/browser/viewport.ts) | type |  |
| [`RevealOptions`](../src/browser/viewport.ts) | type |  |
| [`SignatureController`](../src/browser/signature-controller.ts) | type |  |
| [`SignatureControllerOptions`](../src/browser/signature-controller.ts) | type |  |
| [`SignaturePopupOptions`](../src/browser/signature-popup.ts) | type |  |
| [`SignatureSnapshot`](../src/browser/signature-controller.ts) | type |  |
| [`TextComparison`](../src/browser/comparison.ts) | type | Two review panes with hunk navigation and guarded reversion against the captured baseline. |
| [`TextComparisonDiagnostics`](../src/browser/comparison.ts) | type | Diff step durations and the current scroll and row-alignment state. |
| [`TextComparisonHunk`](../src/browser/comparison.ts) | type |  |
| [`TextComparisonOptions`](../src/browser/comparison.ts) | type | Set the working view, pane settings, scroll linking and optional review controls. |
| [`TextComparisonSnapshot`](../src/browser/comparison.ts) | type |  |
| [`TextEditor`](../src/browser/text-editor.ts) | type | One mounted editor with its own input, viewport, commands and lifetime signal. |
| [`TextEditorActivity`](../src/browser/text-editor.ts) | type |  |
| [`TextEditorCommand`](../src/browser/text-editor.ts) | type |  |
| [`TextEditorDiagnostics`](../src/browser/text-editor.ts) | type | Input-handler measurements and activity captured when diagnostics are read. |
| [`TextEditorEdit`](../src/browser/text-editor.ts) | type |  |
| [`TextEditorEditTransform`](../src/browser/text-editor.ts) | type |  |
| [`TextEditorOptions`](../src/browser/text-editor.ts) | type | Choose the retained view, initial settings, read-only mode and Go to Line prompt at mount. |
| [`TextEditorSnapshot`](../src/browser/text-editor.ts) | type | The mount’s focus, composition and edit availability. |
| [`TextViewport`](../src/browser/viewport.ts) | type | The mounted document surface for scrolling, decoration layers and text geometry. |
| [`TextViewportOptions`](../src/browser/viewport.ts) | type |  |
| [`ViewportActivity`](../src/browser/viewport.ts) | type |  |
| [`ViewportDiagnostics`](../src/browser/viewport.ts) | type |  |
| [`ViewportSettings`](../src/browser/viewport.ts) | type | Presentation choices shared by source and comparison panes. |
| [`ViewportSnapshot`](../src/browser/viewport.ts) | type |  |
| [`ViewRestoreOptions`](../src/browser/view-state.ts) | type |  |
| [`ViewRestoreResult`](../src/browser/view-state.ts) | type |  |
| [`ViewState`](../src/browser/view-state.ts) | type |  |
| [`WebSocketTransportOptions`](../src/browser/lsp-websocket.ts) | type |  |

## `sttropez/protocol`

Declarations start at `protocol/index.d.ts` in the assets directory.

| Export | Kind | Purpose |
| --- | --- | --- |
| [`createLspCommandRunner`](../src/protocol/lsp-command.ts) | function | One confirmed command per session. |
| [`createLspFoldingClient`](../src/protocol/lsp-folding.ts) | function |  |
| [`DocumentationContent`](../src/core/documentation.ts) | type |  |
| [`DocumentationPart`](../src/core/documentation.ts) | type | Provider/host content retains its format; literal text is never inferred to be Markdown. |
| [`JsonValue`](../src/protocol/wire.ts) | type |  |
| [`LspApplyEdit`](../src/protocol/lsp-features.ts) | type |  |
| [`LspApplyEditResult`](../src/protocol/lsp-features.ts) | type |  |
| [`LspBindingCapture`](../src/protocol/lsp-workspace.ts) | type |  |
| [`LspCall`](../src/protocol/lsp-session.ts) | type |  |
| [`LspChangeHint`](../src/protocol/lsp-positions.ts) | type |  |
| [`LspClientDiagnostics`](../src/protocol/lsp-client.ts) | type |  |
| [`LspClientFeature`](../src/protocol/lsp-session.ts) | type |  |
| [`LspCodeAction`](../src/protocol/lsp-code-actions.ts) | type |  |
| [`LspCodeActions`](../src/protocol/lsp-code-actions.ts) | type |  |
| [`LspColor`](../src/protocol/lsp-features.ts) | type |  |
| [`LspColorPresentation`](../src/protocol/lsp-features.ts) | type |  |
| [`LspCommand`](../src/protocol/lsp-command-value.ts) | type |  |
| [`LspCommandAuthorization`](../src/protocol/lsp-session.ts) | type | Host grant for one invocation, including opaque arguments; never inferred from a server response. |
| [`LspCommandCall`](../src/protocol/lsp-session.ts) | type |  |
| [`LspCommandPolicy`](../src/protocol/lsp-command.ts) | type | Called once for each captured invocation. |
| [`LspCommandReceipt`](../src/protocol/lsp-command.ts) | type |  |
| [`LspCommandRoute`](../src/protocol/lsp-command.ts) | type |  |
| [`LspCommandRunner`](../src/protocol/lsp-command.ts) | type |  |
| [`LspCommandScope`](../src/protocol/lsp-command.ts) | type |  |
| [`LspCompletion`](../src/protocol/lsp-features.ts) | type |  |
| [`LspCompletionFallback`](../src/protocol/lsp-features.ts) | type |  |
| [`LspCompletionOptions`](../src/protocol/lsp-features.ts) | type |  |
| [`LspCompletionPlan`](../src/protocol/lsp-features.ts) | type |  |
| [`LspCompletions`](../src/protocol/lsp-features.ts) | type |  |
| [`LspConnectContext`](../src/protocol/lsp-session.ts) | type |  |
| [`LspCooperate`](../src/protocol/lsp-positions.ts) | type |  |
| [`LspDiagnostic`](../src/protocol/lsp-features.ts) | type |  |
| [`LspDiagnostics`](../src/protocol/lsp-features.ts) | type |  |
| [`LspDiagnosticState`](../src/protocol/lsp-workspace.ts) | type |  |
| [`LspDocument`](../src/protocol/lsp-session.ts) | type |  |
| [`LspDocumentCapture`](../src/protocol/lsp-session.ts) | type |  |
| [`LspDocumentColor`](../src/protocol/lsp-features.ts) | type |  |
| [`LspDocumentEdits`](../src/protocol/lsp-features.ts) | type |  |
| [`LspDocumentFeature`](../src/protocol/lsp-session.ts) | type |  |
| [`LspDocumentHighlight`](../src/protocol/lsp-highlights.ts) | type |  |
| [`LspDocumentHighlights`](../src/protocol/lsp-highlights.ts) | type |  |
| [`LspDocumentLink`](../src/protocol/lsp-features.ts) | type |  |
| [`LspDocumentRequest`](../src/protocol/lsp-client.ts) | type |  |
| [`LspDocumentSnapshot`](../src/protocol/lsp-session.ts) | type |  |
| [`LspEditNotes`](../src/protocol/lsp-workspace-edit.ts) | type |  |
| [`LspEditTarget`](../src/protocol/lsp-features.ts) | type |  |
| [`LspFeature`](../src/protocol/lsp-session.ts) | type |  |
| [`LspFeatureClient`](../src/protocol/lsp-client.ts) | type |  |
| [`LspFoldingClient`](../src/protocol/lsp-folding.ts) | type |  |
| [`LspHostCommandContext`](../src/protocol/lsp-command.ts) | type |  |
| [`LspHover`](../src/protocol/lsp-features.ts) | type |  |
| [`LspLineIndex`](../src/protocol/lsp-positions.ts) | class | Reuses the buffer's LF index and retains only additional bare-CR positions. |
| [`LspLocation`](../src/protocol/lsp-features.ts) | type |  |
| [`LspLocationTarget`](../src/protocol/lsp-features.ts) | type |  |
| [`LspNavigationRequest`](../src/protocol/lsp-navigation.ts) | type |  |
| [`LspPosition`](../src/protocol/lsp-positions.ts) | type |  |
| [`LspPositionRequest`](../src/protocol/lsp-client.ts) | type |  |
| [`LspPrepare`](../src/protocol/lsp-workspace.ts) | type | Optional host custom-message preparation, inside the feature's captured request lifetime. |
| [`LspProjectRequest`](../src/protocol/lsp-client.ts) | type |  |
| [`LspRange`](../src/protocol/lsp-positions.ts) | type |  |
| [`lspRangeOffsets`](../src/protocol/lsp-features.ts) | function | LSP clamps characters to the line end; nonexistent lines and reversed wire ranges remain invalid. |
| [`LspRegistration`](../src/protocol/lsp-session.ts) | type |  |
| [`LspRequestContext`](../src/protocol/lsp-session.ts) | type |  |
| [`LspScopeAccess`](../src/protocol/lsp-workspace.ts) | type | Preparation can synchronize the capture and send custom requests on its behalf. |
| [`LspSessionOptions`](../src/protocol/lsp-session.ts) | type | Provide the connection factory, scheduler and configuration for a protocol session. |
| [`LspSessionSnapshot`](../src/protocol/lsp-session.ts) | type |  |
| [`LspSignature`](../src/protocol/lsp-features.ts) | type |  |
| [`LspSignatureHelp`](../src/protocol/lsp-features.ts) | type |  |
| [`LspTargetContext`](../src/protocol/lsp-targets.ts) | type |  |
| [`LspTargetResolver`](../src/protocol/lsp-targets.ts) | type |  |
| [`LspTargetSource`](../src/protocol/lsp-targets.ts) | type | A project document, or read-only contents without a project resource. |
| [`LspTextChange`](../src/protocol/lsp-positions.ts) | type |  |
| [`LspWorkspace`](../src/protocol/lsp-workspace.ts) | class | One explicitly owned provider connection and synchronization stream per workspace/configuration. |
| [`LspWorkspaceEdit`](../src/protocol/lsp-features.ts) | type |  |
| [`LspWorkspaceEditNote`](../src/protocol/lsp-workspace-edit.ts) | type |  |
| [`LspWorkspaceOptions`](../src/protocol/lsp-workspace.ts) | type | Configure the shared session, diagnostic delivery and host resolution of unopened targets. |
| [`LspWorkspaceScope`](../src/protocol/lsp-workspace.ts) | type | Own document bindings, requests and subscriptions that share a workspace connection. |
| [`LspWorkspaceSnapshot`](../src/protocol/lsp-workspace.ts) | type |  |
| [`ProtocolDecodeError`](../src/protocol/wire.ts) | class | Malformed or unsupported provider data; distinct from host validation and callbacks. |
| [`readLspEditNotes`](../src/protocol/lsp-workspace-edit.ts) | function | Read notes for [first, end) across the edit's documents in provider order. |
| [`RpcCall`](../src/protocol/json-rpc.ts) | type |  |
| [`RpcError`](../src/protocol/wire.ts) | class |  |
| [`RpcId`](../src/protocol/json-rpc.ts) | type |  |
| [`RpcOptions`](../src/protocol/json-rpc.ts) | type |  |
| [`RpcRequestContext`](../src/protocol/json-rpc.ts) | type |  |
| [`RpcScheduler`](../src/protocol/json-rpc.ts) | type | Hosts supply scheduling; this module imports no platform, networking or storage APIs. |
| [`RpcTransport`](../src/protocol/json-rpc.ts) | type |  |

## `sttropez/kernels`

Declarations start at `kernels/index.d.ts` in the assets directory.

| Export | Kind | Purpose |
| --- | --- | --- |
| [`applyLspWorkspaceEdit`](../src/protocol/lsp-workspace-edit.ts) | function | Apply a decoded, retained text-only edit as one shared undo command. |
| [`bufferDifference`](../src/core/buffer-change.ts) | function | Return a replacement span after skipping storage shared by the two versions. |
| [`composePositionMaps`](../src/core/positions.ts) | function | Known maps compile sequential semantics; opaque host mappings retain their own ordered pipeline. |
| [`decodeLspDiagnostics`](../src/protocol/lsp-features.ts) | function | Place valid wire ranges against this explicit snapshot without inventing a provider version. |
| [`JsonRpcConnection`](../src/protocol/json-rpc.ts) | class | Bidirectional JSON-RPC 2.0 over an ordered, message-delimited host transport. |
| [`LiteralSearch`](../src/core/search.ts) | class | Non-overlapping literal UTF-16 matches over immutable pieces. |
| [`LspSession`](../src/protocol/lsp-session.ts) | class | Host-driven LSP 3.17 session. |
| [`LspWorkspaceEditOptions`](../src/protocol/lsp-workspace-edit.ts) | type |  |
| [`mapSelectionSet`](../src/core/selections.ts) | function | Map each range using its endpoint affinities, then merge overlapping ranges. |
| [`offsetSnippetStops`](../src/core/snippets.ts) | function |  |
| [`parseSnippet`](../src/core/snippets.ts) | function | Numbered stops, literal defaults/choices and mirrors; no variables, nesting or transforms. |
| [`planSelectionEdits`](../src/core/selections.ts) | function | Plan one original-coordinate replacement per normalized range; text may differ per range. |
| [`planSnippetChoice`](../src/core/snippets.ts) | function |  |
| [`planSnippetEdit`](../src/core/snippets.ts) | function | Mirror an ordinary input edit through every flat occurrence, including coincident empty stops. |
| [`PositionMap`](../src/core/positions.ts) | class | An immutable indexed map for one batch. |
| [`snippetChoiceText`](../src/core/snippets.ts) | function | The provider's choice text is contextual only at explicit choice acceptance. |
| [`TextDiff`](../src/core/diff.ts) | class |  |
| [`validateTextEdits`](../src/core/changes.ts) | function |  |
