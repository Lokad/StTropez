# StTropez documentation

StTropez supplies a text editor, a workspace model and language-server clients. The host
application owns storage, services, language policy and surrounding controls.

## Choose a task

- [Embed an editor](getting-started.md): obtain the assets, create a document, mount and dispose.
- [Configure editing](editor.md): keyboard commands, selections and language rules.
- [Connect a language server](language-server.md): WebSocket transport, session and workspace.
- [Save or review documents](workspace.md): resource ownership and captured save operations;
  [comparison](comparison.md) describes reference and working views.
- [Extend the host](host-integration.md): custom colors, captured insertion and source notes.

## Subjects

| Subject | Contents |
| --- | --- |
| [Getting started](getting-started.md) | Assets, minimal embedding and host lifecycle |
| [Editor](editor.md) | Input, commands, selections, configuration and view state |
| [Viewport](viewport.md) | Read-only rendering, scrolling and coordinates |
| [Folding](folding.md) | Fold ranges, discovery, groups and commands |
| [Search](search.md) | Literal/regular-expression search and replacement |
| [Comparison](comparison.md) | Baselines, hunks, navigation, refresh and acceptance |
| [Workspace](workspace.md) | Resources, tabs, leases, loading and saving |
| [Text model](text-model.md) | Buffers, UTF-16 positions, edits, selections and snippets |
| [Language server](language-server.md) | Protocol subset, synchronization, capabilities and transport |
| [Language features](language-features.md) | Diagnostics, completion, documentation, navigation and edit/command decisions |
| [Host integration](host-integration.md) | Tokenization, insertion, notes and commands |
| [Unicode](unicode.md) | Grapheme boundaries and Unicode text handling |
| [Packaging](packaging.md) | Assets, entry points, manifest and consumer integration |
| [Architecture](architecture.md) | Layering, ownership, identity and dependencies |
| [Testing](testing.md) | Test owners, readiness, measurement and device checks |
| [Examples](examples.md) | Demo, development hosts, providers and static deployment |

## Support matrix

“Supported” describes the implemented library contract. “Unverified” identifies evidence
that requires a real device or consuming application; it does not mean an automated test passed.

| Area | Supported | Not supported | Unverified |
| --- | --- | --- | --- |
| Text and editing | UTF-16 range edits; multiple selections; shared undo/redo; host language rules; bounded native input and rendered rows | Word wrapping; general rich-text editing | Native IME reconversion/placement; dead keys and AltGr across keyboard layouts; touch/mobile selection; browser/OS menu undo and redo |
| Clipboard and drag | Plain-text clipboard events; host conversion; captured text transfer | Arbitrary rich-document import | OS/app clipboard formats and permissions; native drag images and token-preserving transfer across applications |
| Search and review | Literal/regular-expression search; replacement; immutable references; editable comparisons; independent folding and aligned rows | General merge/conflict-resolution UI | Consuming-host review policies and durable retention |
| Lifecycle and recovery | Explicit teardown, cached-page retention, captured save conflicts and host-managed draft restoration | Portable previous-session undo; a crash/power-loss durability guarantee | Native application termination; interactive/cross-browser back/forward-cache restoration; consuming-host storage policy |
| Language services | [LSP subset](language-server.md), JSON-RPC 2.0, WebSocket transport, UTF-16 positions; host-defined URIs and custom messages | Full LSP coverage; full text synchronization, save notifications, prepare-rename, file operations/change annotations, notebooks/file watching, semantic tokens, formatting, code lens, inlay hints and completion follow-up commands | Compatibility with a consuming application's language server and deployment |
| Documentation | Plaintext, code and a [focused Markdown subset](language-features.md#hover-and-documentation); explicit host link actions | Full CommonMark/GFM; nested lists, headings, tables, entities, reference links, automatic URLs, provider HTML and embedded media | — |
| Presentation | Virtualized rows, decorations, measured local geometry, grapheme and bidirectional text support | Minimap; sticky scroll; bracket-pair coloring | Physical display latency; native font rendering across target devices; constrained hardware |
| Distribution | Compiled dependency-free modules, declarations, CSS and worker assets in NuGet | A .NET runtime dependency or consumer-time library compilation | Production deployment/toolchain adoption |
| Accessibility | Keyboard navigation and explicit focus traversal | A screen-reader support contract | — |

Actual history restoration of the static demo has focused coverage in isolated headless Chrome
on Windows: retained editor identity, complete source text, selection, undo/redo, service
resumption and local save. Cache admission is browser policy; this scope does not establish
general cache eligibility, interactive device behavior or other browser/platform combinations.

## Glossary

| Term | Meaning |
| --- | --- |
| Resource identity | A host-defined scope/resource/variant key and its workspace resource handle; labels are not identity. |
| Document identity | The text model shared by views and history. |
| Revision | A version of document contents. A saved/server version is a separate value. |
| Tab identity and generation | The presentation target and the generation captured before delayed work; replacement invalidates the old target. |
| View identity | An independent selection, folding and scroll state over a document. |
| Capture | Immutable operation inputs and guards retained before asynchronous work. Later focus cannot change the target. |
| Lease | Explicit resource retention while a view or operation needs it. |
| Elapsed duration | Wall-clock time between declared endpoints, including delays inside that span; not process CPU time. |
| Input-handler duration | Time inside the named adapter listener, including model/context work, synchronous subscribers and browser work triggered there. It excludes preceding native work, other listeners and later queued/service/rendering work. |
| Editor handler samples | `lastBeforeInputMs`, `lastInputMs` and `lastKeydownMs` are separate listener spans. Event counters distinguish a new sample from a retained last value. |
| Command callback duration | `maxQueuedInputTurnMs`, `maxWordSelectionTurnMs` and `maxDragScrollStepMs` cover their complete synchronous callbacks, including guards, synchronous publication/refresh and scheduling. Per-mount maxima are not callback distributions or whole-interaction latency. |
| Navigation work | `navigationWorkMs` and `maxNavigationTurnMs` include initialization and complete scheduled navigation callbacks; nested work counts once. Later caret/render frames are excluded except synchronous flushes inside the measured callback. |
| Navigation preparation | `navigationPreparationMs` covers initial viewport/primary-geometry preparation only; it is a substage of navigation work. |
| Pointer word selection | `lastWordSelectionMs` covers the synchronous double-click handler and its first scans/subscribers. Later cooperative turns and rendering need separate observations. |
| Word/grapheme scan step | `maxWordScanStepMs` and `maxGraphemeScanStepMs` cover kernel advances, excluding final normalization, model commit and rendering. They are smaller spans than complete command callbacks. |
| Event observation span | Time between capture and bubble observers, including intervening listeners; it does not isolate the adapter's own handler. |
| Edit interaction start | Handled Enter starts at keydown capture; native `insertText` starts at beforeinput capture. Their handler samples and readiness clocks stay separate. A command or native payload can insert several UTF-16 units in one transaction; that transaction can produce several input events. Inserted units, native events and commits are counted separately. |
| Work units | Algorithmic work counters used for cooperative scheduling; not time deadlines or CPU/memory measurements. |
| Search scan step | `FindDiagnostics.maxScanStepMs`: maximum synchronous matching/index span. Regex mode measures main-thread dispatch/index work; worker matching, later transfer/decoding, publication and waiting are excluded. |
| Replacement transaction | `FindDiagnostics.replaceTransactionMs`: final model transaction and synchronous publication/context refresh. Planning and later rendering are excluded. |
| Comparison advance loop | `TextComparison.getDiagnostics()` reports `maxStepMs` and `totalStepMs` for synchronous controller advances grouped within scheduled tasks. Rendering after the loop and later view/scroll/alignment settlement are excluded. |
| Frame readiness | Time from a declared event/command start until required text, selection, decorations and working/reference view state are observable under the declared frame checks. It does not establish physical display latency. |
| Aggregate browser work | Layout/style counter deltas across a batch, including intervening activity; not per-interaction percentiles. |
| Provider duration | Time attributed to language/service work, with transport and scheduling boundaries stated by the measurement. |
| Automation action duration | Time around a complete scripted action and its readiness condition, including automation transport. |
| Workflow duration | Time around a sequence of setup, interaction and verification steps; it is not a single interaction's latency. |
