# Demo language integration

The local demo uses TypeScript 5.9.3 for syntax/JavaScript emission in a worker and
typescript-language-server 5.1.3 with the same compiler for type checking, completion,
hover, signature help, definition/reference navigation, rename and edit-only quick fixes.
The Node host uses vscode-uri 3.1.0 to provide the server's canonical file URIs, including
Windows drive spelling/escaping. These are pinned development dependencies. Shipped modules
and NuGet assets retain zero third-party runtime dependencies and exclude the provider/compiler.

The [GitHub Pages build](demo-static.md) substitutes an example-owned browser worker provider
using the same compiler and public LSP clients. It needs no Node service; the local route below
retains its WebSocket/stdio integration and qualification.

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
  [documentation view](documentation.md). Choose **Documentation & help links** to see
  formatted JSDoc, lists, code and a permitted handbook link. HTML is never inserted.
- Signature help opens while typing advertised trigger characters and follows the active
  argument. Code → Signature help or Ctrl+Shift+Space requests it explicitly. Completion gets
  the first Escape when both are open. Overload controls appear when the provider offers choices.
  Edits, navigation, composition, file switches and disposal invalidate captured popup work.
  Signature and active-parameter documentation use the same renderer and host link policy.
- F12 or Code → Go to definition opens the validated sample file and selects its symbol.
  Shift+F12 or Find references offers captured locations; arrows/Enter or a click choose one,
  and Escape closes the list. Definitions outside the sample, including standard library files,
  are unavailable. Late results cannot follow later file focus or typing.
- F2 or Code → Rename symbol captures the source, then offers a new-name preview. Changing the
  name requires a fresh preview. Apply commits all validated file edits as one undo command;
  edits, changed selection/authority, file switches and provider restart expire old previews.
  Renaming at the function definition updates the importing file too. At an imported alias,
  TypeScript may instead introduce a local alias; the preview shows the actual provider edits.
- Ctrl+. or Code → Quick fix requests fixes for the current error/range. Review the named fix
  and its before/after text, then Apply fix or Enter; Escape cancels. The real spelling fix for
  a mistyped known name is qualified. The existing action controller validates every captured
  file and permission, and applies the exact edit batch as one shared undo command.
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
converts its compiler's outlining spans to whole-line ranges. Saved comparison text uses host
indentation discovery and keeps independent fold choices. The **Host outline · indentation
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

Quick fixes need the pinned server's diagnostic codes. Before requesting standard code actions,
the host obtains fresh syntactic/semantic results over the same captured public request scope.
The bridge correlates each response with every open mirrored file/version; any file change
clears its cache. Only a current complete diagnostic context is forwarded, narrowed to the
requested range and quick-fix kind. A refresh for unchanged files retains valid context while
pending; malformed replacement results invalidate that kind. This is a provider host adaptation,
not qualification of standard diagnostic pull or generic diagnostic metadata passthrough.

The pinned provider attaches an empty-title `_typescript.applyCodeActionCommand` even to some
pure edits. The bridge removes only that demonstrated no-op form when its nested command list
is absent or empty. Edits, metadata and target ranges still reach the unchanged strict decoder.
No action command executes. Fixes requiring other commands, package installation, file creation
or targets outside the known sample remain unsupported.

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
spelling-fix preview/apply/history, concurrent diagnostic refresh, related-file invalidation,
incremental synchronization, reconnect and owned process/workspace cleanup. The actual demo's
restored-package walkthrough and integrated normal/100k measurements are recorded in
[demo qualification](demo-qualification.md), including separate handler, editor-frame,
automation, compiler and provider clocks. Headless checks do not qualify native IME,
OS clipboard or physical input/display behavior.
