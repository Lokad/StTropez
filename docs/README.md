# StTropez documentation

[Build a two-file editor](getting-started.md) or [find an import](api.md).

## Choose a task

- [Move a tab or keep a draft](getting-started.md#switch-and-move-tabs)
- [Mount an editor in React](getting-started.md#mount-an-editor-in-react)
- [Add a tokenizer](getting-started.md#plug-in-a-standalone-tokenizer)
- [Find a keyboard shortcut](editor.md#shortcuts)
- [Save while typing continues](workspace.md#save-and-conflicts)
- [Connect a language server](language-server.md#use)

## Subjects

| Area | Guides |
| --- | --- |
| Embedding | [Getting started](getting-started.md) · [Packaging](packaging.md) · [Examples](examples.md) · [Host integration](host-integration.md) |
| Text and views | [Text model](text-model.md) · [Unicode](unicode.md) · [Editor](editor.md) · [Viewport](viewport.md) |
| Editing and review | [Controls](controls.md) · [Folding](folding.md) · [Search](search.md) · [Comparison](comparison.md) · [Workspace](workspace.md) |
| Providers | [Language server](language-server.md) · [Language features](language-features.md) |
| Contributing | [Architecture](architecture.md) · [Testing](testing.md) |

## Support matrix

The supported document size is **512,000 UTF-8 bytes**. Larger files may open with slower editing.

| Area | Supported | Outside scope | Requires host or device checks |
| --- | --- | --- | --- |
| Editing | UTF-16 edits, multiple selections, shared Undo, host language rules, bounded input and rows | Word wrap, rich-text editing | Touch selection, native Undo/Redo menus |
| Keyboard | French AZERTY, US QWERTY, US International, keyboard navigation and focus traversal | Other layouts, multi-character IMEs | Physical shortcuts, dead keys and AltGr on each layout |
| Clipboard and drag | Plain-text events, host conversion, captured transfers | General rich-document import | OS clipboard formats and permissions, cross-app drag images and tokens |
| Search and review | Literal and regex replacement, immutable baselines, editable comparisons, pane-local folds and aligned rows | General merge UI | Host review and retention policies |
| Recovery | Explicit teardown, cached-page retention, save conflicts and host-managed drafts | Persistent Undo across sessions, crash durability | Native app termination, back/forward cache across devices and browsers, host storage |
| Language | [LSP 3.17 subset](language-server.md#capabilities-and-supported-subset), JSON-RPC 2.0 over WebSocket, UTF-16 positions, prepare-rename, host URIs and custom messages | Full-text sync, save notifications, file operations and watching, change annotations, notebooks, formatting, semantic tokens, code lens, inlay hints, completion follow-up commands | Consuming server and deployment |
| Documentation display | Plaintext, code, host-approved links and a [Markdown subset](language-features.md#hover-and-documentation) | Nested lists, headings, tables, entities, reference or automatic links, provider HTML and embedded media | — |
| Presentation | Virtualized rows, minimap, decorations, grapheme navigation, local text geometry | RTL caret and selection geometry, sticky scroll, bracket-pair coloring | Physical display latency, target fonts and constrained hardware |
| Distribution | Compiled modules, declarations, CSS and worker in an assets-only NuGet package | Managed editor runtime, consumer-time compilation | Production toolchain and deployed asset URLs |

Browsers decide whether Back restores a cached page. Headless Chrome on Windows restored the
static demo's text, selections, Undo, language services and local save. Check the browsers and
devices your application uses.

## Glossary

### API conventions

Text ranges are half-open UTF-16 offsets. `[from, to)` includes `from` and ends just before `to`.
Read immutable state with `getSnapshot()`. In a `subscribe()` callback, read again. The returned
function unsubscribes. `dispose()` releases a mount. Its document can outlive it.
[Text coordinates](text-model.md#buffers-and-coordinates) · [Observables](workspace.md#observables)

### Editing

| Term | Meaning |
| --- | --- |
| Resource | The host’s scope, resource and variant identify a file or value. Its workspace handle survives a label change. |
| Document | Panes with the same document ID share text and Undo. A revision identifies its text version. Storage has a separate version. |
| Tab | A host UI element that selects a document or panel. The host owns its identity and lifetime. |
| View | One set of selections, folds and scroll offsets for a document. |
| Capture | The target and inputs retained when an operation starts, including the checks needed to use its result. |
| Lease | Keeps the resource in the workspace until release. |

### Measuring an interaction

Start at keydown capture for a handled Enter and at beforeinput capture for native `insertText`.
Report handler duration separately from the time until the expected text, syntax, selection and
gutter are visible. State which frames satisfy readiness. Physical display latency requires a device measurement. [Visible readiness](testing.md#readiness-and-visible-continuity)

| Clock | Start and finish |
| --- | --- |
| Input handler | Entry to return of one listener, including synchronous model, subscribers and browser work. `lastKeydownMs`, `lastBeforeInputMs` and `lastInputMs` belong to different events. Check the event count for a fresh sample. |
| Completion handler | `lastCompletionBeforeInputMs` times its input listener, `lastCompletionCommandMs` the registered command through synchronous publication. Replies and paint can arrive later. |
| Navigation | `navigationWorkMs` totals setup and scheduled callbacks, including synchronous flushes. `maxNavigationTurnMs` is the longest turn. `navigationPreparationMs` covers initial geometry. Nested work counts once. |
| Event observation | Capture observer to bubble observer, including other listeners. |
| Headless edit planning | Planner creation to complete plan. Report elapsed time and calling-thread CPU. Commit and rendering follow. |
| Find | `FindDiagnostics.maxScanStepMs` is the longest synchronous scan/index step. Regex measures main-thread dispatch and indexing, excluding worker matching and transfer. `replaceTransactionMs` covers commit, notification and context refresh. |
| Comparison | `TextComparison.getDiagnostics()` reports `maxStepMs` and `totalStepMs` for controller advances. Rendering and row alignment follow separately. |
| Frame readiness | Declared input or command to a frame check that observes the required pane state. |
| Scripted action | Automation call through its readiness condition, including transport. A workflow duration covers a whole sequence. |

Elapsed time includes waits. Work units count algorithm steps. For aggregate browser work,
report the change in layout and style counters over the batch. For provider time, name the
request, transport and scheduling boundaries. Count events, transactions and UTF-16 units separately.
