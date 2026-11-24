# StTropez documentation

Build a two-file editor in [Getting started](getting-started.md). You can run the first snippet
as soon as you serve the page, then add the features you need.

## Choose a task

- [Move a tab or close it without losing the draft](getting-started.md#switch-and-move-tabs)
- [Color source text with your own tokenizer](getting-started.md#plug-in-a-standalone-tokenizer)
- [Look up a keyboard or pointer command](editor.md#shortcuts)
- [Save a file while the user keeps typing](workspace.md#save-and-conflicts)
- [Connect a language server](language-server.md#use)

## Subjects

| Subject | Contents |
| --- | --- |
| [Getting started](getting-started.md) | A runnable editor with tabs, syntax coloring, Save and Run |
| [Editor](editor.md) | Input, commands, selections, configuration and view state |
| [Viewport](viewport.md) | Read-only rendering, scrolling and coordinates |
| [Folding](folding.md) | Fold ranges, discovery, groups and commands |
| [Search](search.md) | Literal/regular-expression search and replacement |
| [Comparison](comparison.md) | Baselines, hunks, navigation, refresh and acceptance |
| [Workspace](workspace.md) | Resources, tabs, leases, loading and saving |
| [Text model](text-model.md) | Buffers, UTF-16 positions, edits, selections and snippets |
| [Language server](language-server.md) | Protocol subset, synchronization, capabilities and transport |
| [Language features](language-features.md) | Diagnostics, completion, hover, navigation and how to handle proposed edits or commands |
| [Host integration](host-integration.md) | Tokenization, insertion, notes and commands |
| [Unicode](unicode.md) | Grapheme boundaries and Unicode text handling |
| [Packaging](packaging.md) | Restore the NuGet assets and serve them in a frontend |
| [Architecture](architecture.md) | What the workspace, browser, protocol clients and host each own |
| [Testing](testing.md) | Which tests to run, what to measure and which checks need a device |
| [Examples](examples.md) | Demo, development hosts, providers and static deployment |

## Support matrix

StTropez supports documents up to 512,000 UTF-8 bytes. Larger documents may open, with no responsiveness guarantee.
The **Supported** column lists what StTropez guarantees. Check the **Unverified** column
when choosing devices and integration tests for your application.

| Area | Supported | Not supported | Unverified |
| --- | --- | --- | --- |
| Text and editing | UTF-16 range edits; multiple selections; shared undo/redo; host language rules; bounded native input and rendered rows | Word wrapping; general rich-text editing | Touch/mobile selection; browser/OS menu undo and redo |
| Keyboard layouts | French AZERTY (France), US QWERTY and US International | Dedicated support for other layouts or multi-character input methods | Physical shortcuts, dead keys and AltGr on the three supported layouts |
| Clipboard and drag | Plain-text clipboard events; host conversion; captured text transfer | Arbitrary rich-document import | OS/app clipboard formats and permissions; native drag images and token-preserving transfer across applications |
| Search and review | Literal/regular-expression search; replacement; immutable references; editable comparisons; independent folding and aligned rows | General merge/conflict-resolution UI | Consuming-host review policies and durable retention |
| Lifecycle and recovery | Explicit teardown, cached-page retention, captured save conflicts and host-managed draft restoration | Portable previous-session undo; a crash/power-loss durability guarantee | Native application termination; interactive/cross-browser back/forward-cache restoration; consuming-host storage policy |
| Language services | [LSP subset](language-server.md), JSON-RPC 2.0, WebSocket transport, UTF-16 positions, prepare-rename, host-defined URIs and custom messages | Full LSP coverage; full text synchronization, save notifications, file operations/change annotations, notebooks/file watching, semantic tokens, formatting, code lens, inlay hints and completion follow-up commands | Compatibility with a consuming application's language server and deployment |
| Documentation | Plaintext, code and a [focused Markdown subset](language-features.md#hover-and-documentation); explicit host link actions | Full CommonMark/GFM; nested lists, headings, tables, entities, reference links, automatic URLs, provider HTML and embedded media | — |
| Presentation | Virtualized rows, optional minimap, decorations, measured local geometry, grapheme navigation | Right-to-left caret and selection geometry; sticky scroll; bracket-pair coloring | Physical display latency; native font rendering across target devices; constrained hardware |
| Distribution | Compiled dependency-free modules, declarations, CSS and worker assets in NuGet | A .NET runtime dependency or consumer-time library compilation | Production deployment/toolchain adoption |
| Accessibility | Keyboard navigation and explicit focus traversal | A screen-reader support contract | — |

In the Windows headless Chrome test, going back to the static demo restores the editor, full
text, selections, undo/redo, services and local save. Each browser decides whether to cache the
page. Repeat the check on the browsers and devices you support.

## Glossary

### Editing

| Term | Meaning |
| --- | --- |
| Resource identity | The scope, resource and variant the host uses to identify a file or value, and the handle the workspace assigns it. Renaming its label preserves the handle. |
| Document identity | Views with the same document ID share their text and undo history. |
| Revision | A version of document contents. A saved/server version is a separate value. |
| Tab identity and generation | A tab keeps its ID when moved. Replacing its contents increments the generation, so a delayed command can detect the replacement. |
| View identity | Two panes can show the same document with different selections, folds and scroll positions. |
| Capture | The target, inputs and checks an operation keeps when it starts. If focus moves to another tab, the original target stays the same. |
| Lease | Keeps a resource in the workspace until its owner releases it. |

### Measuring an interaction

| Term | What it measures |
| --- | --- |
| Elapsed duration | Time between the stated start and end, including waiting. |
| Headless command planning | Elapsed time and calling-thread CPU from planner creation to the complete edit plan. Applying edits, input handling and rendering fall outside this measurement. |
| Input-handler duration | Time inside one adapter listener. It includes model updates, synchronous subscribers and browser work triggered there. Native work before the listener, other listeners and later service or render work fall outside it. |
| Editor handler samples | `lastBeforeInputMs`, `lastInputMs` and `lastKeydownMs` each time one listener. Check its event counter to tell whether a sample is new. |
| Completion samples | `lastCompletionBeforeInputMs` times the completion input listener. `lastCompletionCommandMs` times a registered command, including synchronous publication. `completionCommands` counts those calls. Provider replies and later paint fall outside both clocks. |
| Command callback duration | `maxQueuedInputTurnMs`, `maxWordSelectionTurnMs` and `maxDragScrollStepMs` are per-mount maxima for whole synchronous callbacks, including guards, publication, refresh and scheduling. Later work falls outside them. |
| Navigation work | `navigationWorkMs` and `maxNavigationTurnMs` count initialization and scheduled navigation callbacks, including synchronous flushes. Nested work counts once. Later caret and render frames fall outside the measurement. |
| Navigation preparation | `navigationPreparationMs` times the initial viewport and primary-caret geometry setup within navigation work. |
| Pointer word selection | `lastWordSelectionMs` times the double-click handler, including its first scans and synchronous subscribers. Measure later scan turns and rendering separately. |
| Word/grapheme scan step | `maxWordScanStepMs` and `maxGraphemeScanStepMs` time kernel advances. Final normalization, model commit and rendering fall outside this span. |
| Event observation span | Time from the capture observer to the bubble observer, including every listener between them. |
| Edit interaction start | For a handled Enter, start at keydown capture. For native `insertText`, start at beforeinput capture. Keep the two handler and readiness measurements separate. Count UTF-16 units, input events and transactions independently. |
| Work units | Algorithm steps charged against a cooperative scheduling budget. Duration and memory use vary. |
| Search scan step | `FindDiagnostics.maxScanStepMs` times the longest synchronous matching or indexing step. For regex, it covers main-thread dispatch and indexing. Worker matching, later transfer and decoding, publication and waiting fall outside it. |
| Replacement transaction | `FindDiagnostics.replaceTransactionMs` times the final model transaction, synchronous publication and context refresh. Planning and later rendering fall outside it. |
| Comparison advance loop | `TextComparison.getDiagnostics()` reports `maxStepMs` and `totalStepMs` for synchronous controller advances within scheduled tasks. Later rendering, scrolling and row alignment fall outside the loop. |
| Frame readiness | Time from the declared event or command until frame checks can observe the required text, selections, decorations and pane state. Physical display latency needs a device measurement. |
| Aggregate browser work | Change in layout and style counters across a batch. Intervening activity counts toward the total. |
| Provider duration | Time attributed to language/service work, with transport and scheduling boundaries stated by the measurement. |
| Automation action duration | Time around a complete scripted action and its readiness condition, including automation transport. |
| Workflow duration | Elapsed time for a sequence of setup, interaction and verification steps. |
