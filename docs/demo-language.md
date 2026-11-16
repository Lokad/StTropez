# Demo language integration

The local demo uses TypeScript 5.9.3 for syntax/JavaScript emission in a worker and
typescript-language-server 5.1.3 with the same compiler for type checking, completion,
hover, signature help, definition/reference navigation, rename and edit-only quick fixes.
The Node host uses vscode-uri 3.1.0 to provide the server's canonical file URIs, including
Windows drive spelling/escaping. These are pinned development dependencies. Shipped modules
and NuGet assets retain zero third-party runtime dependencies and exclude the provider/compiler.

The [GitHub Pages demo](demo-static.md) defaults to an example-owned browser worker provider
using the same compiler and public LSP clients. It needs no Node service. The local demo defaults
to the WebSocket/stdio route below; open `/?provider=browser` to select the published worker at
runtime. The page retains that choice across sample switches and retries.

Connection failures show **Language service unavailable**; its retry starts a fresh provider
and synchronizes the current documents. If mounting the language controls fails, the demo
releases their acquired listeners, popups and protocol scopes, reports the original error to
the console and shows **Language controls unavailable**. **Retry language controls** reuses the
connected provider. Editing and saving remain available in either case. A connection resolving
after the view is disposed cannot attach controls to a later view.

The syntax worker retains one language service and versioned snapshots. After the initial
document upload, the host uses the public `BufferChangeCursor` to send a bounded replacement
span in chunks; incomplete uploads cannot change the worker's committed document. File/session
changes seed fresh text, and worker retry starts a fresh session. Compiler snapshots supply
the direct previous version's change range without retaining an unbounded text history;
older compiler caches safely reparse. Classification still covers the whole source in the worker.

JavaScript is emitted from that service only while its panel is visible. Hidden/Problems/Changes
views continue syntax colors and editing rules without emitting JavaScript. Reopening output
requests the current version without uploading unchanged source. An emission already executing
in a worker cannot be interrupted; obsolete replies remain excluded by worker/job identity.
The host-language samples release their unused syntax worker. These changes stay in the demo;
they add no library API or runtime dependency.

Completed diagnostics remain visible at provisionally mapped positions during edits. Deleted
ranges and missing revision history discard their placement; related locations follow their
own documents. Problems are labeled “Awaiting recheck” and their navigation is disabled until
the current project check completes. Quick fixes still request fresh captured diagnostics.
Unchanged documents reuse syntax results; semantic checks still cover every loaded document,
because an edited export can change errors in an untouched importer. The current provider
supplies no dependency graph for narrower invalidation. Mapping traverses retained diagnostic
items and related locations without scanning document text. Retry/disconnect clear these caches.
Each check uses the project's source/inventory generation and validates its current target
before and after a reply. A final pass validates all captured bindings before publication,
including bindings that expired without a source change. This avoids checking the whole
project around every request while retaining rejection of cross-file and late replies.

The Code menu exposes line/block comments, indentation and two/four-space or tab settings.
The same public configuration serves the source and comparison views. TypeScript Enter adds
indentation after opening brackets and separates a matching closer. Quotes/brackets can surround
selections and skip a matching closing character. These are demo-host rules, independent of LSP.
They use unchanged compiler-classified line starts plus a bounded local quote scan. Multiline
comments/strings, regexes, templates, escaped quotes and unproved long prefixes conservatively
disable automatic pairing; ordinary literal typing continues. This is not a second TypeScript
parser, and provisional display colors never establish lexical authority. Compiler work remains
in the existing worker; no parser/compiler dependency enters the library or native input handler.

`npm run demo` binds to loopback. The host allocates a temporary project for each selected
sample and bridges text JSON-RPC 2.0 messages between WebSocket and the provider's stdio.
StTropez's public `LspWorkspace`, WebSocket transport and editor completion controller own
negotiation, UTF-16 synchronization, capture/response validation and completion edits/history.
Completion, hover, signature help, definition/reference navigation, rename and quick fixes use
standard language requests in this demo, with the bounded host adaptations described below.
The existing deterministic protocol fixture keeps its separate `/lsp-fixture` route.

## Current workflows

- **Host integrations · paste & notes** is an on-demand, example-owned rule/CSV sample without
  a language provider. It demonstrates host syntax colors, colon indentation, `#` comments,
  CSV/literal insertion and source notes that track edits, scrolling, folds and view remounts.
  Code exposes its custom commands and shortcuts; comparison colors both snapshots. The
  [consumer recipe](host-integrations.md) uses only public exports and explains note lifetime.

- Placing the caret on a symbol highlights occurrences in the active source or comparison
  working view through standard `textDocument/documentHighlight`. Reads are shaded and writes
  also outlined, without replacing syntax colors. The browser provider maps TypeScript compiler
  reference/write/definition spans to LSP kinds; plain text occurrences retain a neutral shade.
  The pinned Node language server reports reads for these variable declarations and assignments,
  so its local demo cannot distinguish those writes; the static compiler provider can.
  Changed caret, edits, blur, file switches and provider authority expire prior results. The host
  queries the public occurrence index only for visible rows, including large result sets.
- Problems lists syntactic/type errors across the sample's files. Clicking an error selects
  its captured range in its named file. All errors are retained, with 64 rows per page.
  Typing expires the published project diagnostics.
- Member access and ordinary identifier typing can offer completion automatically. Ctrl+Space
  or Code → Complete requests suggestions explicitly. Arrow keys select a candidate; Enter or a click
  accepts it after resolution. Escape dismisses the offer. The public editor controller applies
  one guarded transaction, including any validated additional edits.
- Hover over a symbol to inspect its real type without changing focus. Code → Inspect type or
  Ctrl+K, Ctrl+I inspects the caret instead. Escape dismisses the popup. Provider documentation
  preserves plaintext/Markdown/code identity and uses the focused public
  [documentation view](language-features.md#hover-and-documentation). Choose **Documentation & help links** to see
  formatted JSDoc, lists, code and a permitted handbook link. HTML is never inserted.
- Signature help opens while typing advertised trigger characters and follows the active
  argument. Code → Signature help or Ctrl+Shift+Space requests it explicitly. Completion gets
  the first Escape when both are open. Overload controls appear when the provider offers choices.
  Edits, navigation, composition, file switches and disposal invalidate captured popup work.
  Signature and active-parameter documentation use the same renderer and host link policy.
- F12 or Code → Go to definition opens the validated sample file and selects its symbol.
  Shift+F12 or Find references offers captured locations; arrows/Enter or a click choose one,
  and Escape closes the list. Definitions outside the sample, including standard library files,
  are unavailable. Late results cannot follow later file focus or typing. Alt+Left or Code → Back
  to previous location returns to the source selection and view; edited sources keep their mapped
  selections. The **Unopened files & navigation** sample starts with only `main.ts` registered.
  Its host resolves `labels.ts` and read-only `contracts.d.ts` asynchronously using the public
  `resolveTarget` callback. The demo-owned `sttropez/readDocument` message reads only known sample
  contents; it is not a standard LSP file-loading method. Save and recovery preserve unopened
  editable contents without saving read-only declarations.
- F2 or Code → Rename symbol captures the source, then offers a new-name preview. Changing the
  name requires a fresh preview. Apply commits all validated file edits as one undo command;
  edits, changed selection/authority, file switches and provider restart expire old previews.
  Renaming at the function definition updates the importing file too. At an imported alias,
  TypeScript may instead introduce a local alias; the preview shows the actual provider edits.
  Rename the exported `LabelOptions` type to exercise edits to an unopened module.
- Ctrl+. or Code → Quick fix requests fixes for the current error/range. Clicking an ordinary
  small single-file fix applies it directly; receiving a response or selecting with arrows does
  not apply anything. The before/after preview remains available, with Apply fix or Enter;
  Escape cancels. Broader actions stay in preview when selected. The existing controller
  validates every captured file and permission and commits one shared undo command.
  This demo policy treats an edit-only quickfix to the current file with at most four edits
  and 256 replaced/inserted UTF-16 units as direct; it is not a library restriction.
  Explicit activation survives lazy resolution only while its original capture stays current.
- **Project actions** is a small, labeled provider fixture for a refactoring spanning two files.
  Its fixed sample-name replacement travels through standard code-action decoding, previews
  every edit, rejects stale captures and applies atomically. Undo from either participating
  file restores both files. Both demo providers share this fixture; TypeScript continues to
  check and color the editable code. This is not a general-purpose rename implementation.
- The same sample offers **Demo host: add review note**, a command-only action, and a refactor
  followed by a host project check. Select a command, then **Run action**. A deliberately failed
  check leaves the earlier rename applied and undoable, with a recovery message. Undo and request
  a fresh action without reconnecting. The host authorizes the exact sample URI/mode, and only
  permits the fixed end-of-file note through its selected-operation edit policy. These handlers
  use the public command client and captured workspace transactions; they never execute source code.
- A failed provider leaves typing, history, comparison and local saves usable. Retry creates
  a fresh provider connection with current document snapshots. Switching samples suspends
  the inactive provider; file switches retain the same project synchronization stream. Retry
  keeps the current input element, view state and offline edits while replacing provider scopes.
- Closing a view disposes its completion scope/popup. Closing the project cancels requests,
  disposes synchronization and requests server cleanup. The host stops the owned process and
  removes its allocated workspace. Idle allocations expire after two minutes as a fallback.

## Provider adaptation and limits

The Code menu exposes automatic fold commands and groups, with Ctrl/Cmd+Shift+[ / ] at the
caret. Source TypeScript ranges use standard `textDocument/foldingRange`; the browser provider
converts its compiler's outlining spans to whole-line ranges. Saved comparison text uses the
same compiler outlining semantics in its snapshot-bound syntax-color worker, without emission
or attachment to the live language session. Both panes are colored and keep independent fold
choices; the working pane preserves source-view preferences. Hidden-line labels and the review
hint distinguish folded rows/alignment gaps from deleted text. Snapshot replacement/disposal
cancels pending discovery and rejects obsolete colors; analysis failure exposes Retry.
The **Host outline · indentation
folding** sample uses a plain editable outline with nested blocks and `#region` markers,
without connecting a language service. Find reveals collapsed matches, and edits/undo retain
corresponding mapped regions. See the public [folding contract](folding.md).

The provider's pushed diagnostics omit document versions. The demo does not treat them as
current annotations. Its host extension `sttropez/diagnostics` invokes the pinned provider's
read-only synchronous syntactic/semantic diagnostic commands over the same connection.
The client flushes and captures every project document before requesting them, then validates
all document captures and the request generation before publication. Edits, suspend/dispose
or changed provider participation reject a late result. This is a documented host extension,
not qualification of standard LSP diagnostic pull. Each syntactic or semantic response is
validated completely, with no silent diagnostic truncation. Existing transport limits remain.
Both demo providers return standard diagnostic shapes inside this custom response. The host
uses the public diagnostic decoder without inventing a provider version; request correlation
still owns the project association. Compiler severity, codes, tags and related locations within
the sample inventory survive the adapter. Related messages are retained when a target is not
loaded; navigation is offered only for a captured, placed target in the current project.

Quick fixes need the pinned server's diagnostic codes. Before requesting standard code actions,
the host obtains fresh syntactic/semantic results over the same captured public request scope.
The bridge correlates each response with every open mirrored file/version; any file change
clears its cache. Only a current complete diagnostic context is forwarded, narrowed to the
requested range and quick-fix kind. A refresh for unchanged files retains valid context while
pending; malformed replacement results invalidate that kind. This is a provider host adaptation,
not qualification of standard diagnostic pull. Generic metadata passthrough is qualified
separately through the public push observer and action client against the protocol fixture.

The development host also has an explicit `attachDemoProvider(server, { refactoring: true })`
profile for real-provider qualification. It includes refactor actions and permits the pinned
provider's `_typescript.applyRefactoring` command for a known project file. Default demo hosts
retain their diagnostic-command restriction. The qualification journey uses the public
`LspCommandPolicy` and captured review handler: declining leaves the source untouched; accepting
applies the server's `workspace/applyEdit` as one undoable transaction. It acknowledges the
provider-specific `_typescript.rename` hint through the host custom-request hook, without
claiming a rename-dialog workflow. The same journey verifies real lazy auto-imports and a
method-override snippet, including final caret placement and undo. It runs through `npm test`
on the existing Linux CI route; its Windows execution also checks process/file cleanup.

**Diagnostic details** demonstrates a real TypeScript property error with its related
declaration and a clearly labeled Demo host warning with a deprecated tag, help URI and opaque
data. Problems shows severity/source, pages related locations in groups of 16 on demand, and
opens captured loaded locations without applying edits. Help shares the hover/signature policy:
an explicit click may open an HTTPS TypeScript documentation URL without an opener. Provider
data is never rendered or executed. Correcting the warning and undoing refresh its association.
The small host fixture exercises metadata the demo's TypeScript query does not emit; it is
not a claim about TypeScript's diagnostic capabilities or another language implementation.

The pinned provider attaches an empty-title `_typescript.applyCodeActionCommand` even to some
pure edits. The bridge removes only that demonstrated no-op form when its nested command list
is absent or empty. Edits, metadata and target ranges still reach the unchanged strict decoder.
Only the explicitly registered Project actions host handlers execute. Arbitrary TypeScript server
commands, package installation, file creation and targets outside the known sample remain unsupported.

Pinned-provider completion behaviors are adapted by the development bridge. It preserves
the input item's opaque data when resolution replaces the server's cache key, and excludes
candidates whose edit range fails to contain the requested caret. Other item fields, edits and
additional edits reach the public client's strict decoder unchanged. The editor filters each
candidate against its own edit prefix, including punctuation, using bounded reads shared by
candidates with the same start offset.
Both demo providers retain complete candidate lists and the provider's own incomplete flag.
The **Completion catalogue · 1,200 fields** sample uses the real TypeScript provider: at the end,
type `catalogue.`, use Up to reach `item1199`, or type `item119` to narrow to ten candidates.
Tab accepts the selected item; Undo restores the prefix. The popup renders at most 16 rows and
shows the selected position/count, including an explicit partial-list label when applicable.
The browser provider retains resolution references for the current and preceding response only;
older keys expire. The library's configurable transport limit remains separate from presentation.

The **Snippets & lazy completion** sample exercises a labeled demo-owned template provider,
because the ordinary TypeScript provider does not supply this complete demonstration. In
`templates.ts`, press Ctrl+End then Ctrl+Space. The first choice includes linked names, numbered
fields, a visible choice and a final caret; Tab/Shift+Tab traverse fields, Alt+Up/Down changes a
choice, and Escape keeps text while ending snippet mode. The lazy declaration supplies its body
and import on resolve. Both use standard completion messages and the public controller's input,
selection and history paths. An unsupported-variable example is individually omitted with a
reason. TypeScript still checks, colors and compiles the editable result. Template resolution
requires the captured URI and document version; it cannot insert after that source changes.

The **Project-wide results · 1,200 uses** sample supplies real TypeScript results: 300 type
errors in `problems.ts` and 1,201 references/rename edits for `sharedValue` in `uses.ts`.
Problems and locations page 64 entries; arrow navigation crosses reference pages. Rename
previews page 64 edits and apply the complete batch as one undo command. Switching samples
cannot retain another sample's problem page or retarget a captured result.

The bridge fixes the project root/compiler settings, validates addressed document URIs and
read-command file paths, and writes only known sample files in its allocated workspace.
Compiler standard libraries come from the pinned toolchain. Automatic type acquisition is off;
the demo does not install project packages or execute edited programs. Unsupported provider
commands and project configuration changes are rejected.

Focused qualification uses a real provider for type-error correction, member completion and
resolution/history, pointer/keyboard inspection, argument changes and popup Escape priority,
held real responses after edits/file switches, startup failure/retry,
direct spelling-fix selection/history, delayed activated resolution, reviewed two-file actions,
concurrent diagnostic refresh, related-file invalidation,
incremental synchronization, reconnect and owned process/workspace cleanup. The actual demo's
restored-package walkthrough and integrated normal/100k measurements are recorded in
[demo qualification](demo-qualification.md), including separate handler, editor-frame,
automation, compiler and provider clocks. Headless checks do not qualify native IME,
OS clipboard or physical input/display behavior.
