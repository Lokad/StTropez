# Demo language integration

The root demo uses TypeScript 5.9.3 for syntax/JavaScript emission in a worker and
typescript-language-server 5.1.3 with the same compiler for type checking, completion,
hover and signature help.
The Node host uses vscode-uri 3.1.0 to provide the server's canonical file URIs, including
Windows drive spelling/escaping. These are pinned development dependencies. Shipped modules
and NuGet assets retain zero third-party runtime dependencies and exclude the provider/compiler.

`npm run demo` binds to loopback. The host allocates a temporary project for each selected
sample and bridges text JSON-RPC 2.0 messages between WebSocket and the provider's stdio.
StTropez's public `LspWorkspace`, WebSocket transport and editor completion controller own
negotiation, UTF-16 synchronization, capture/response validation and completion edits/history.
Completion, hover and signature help are exposed as standard language features in this demo;
definition/reference navigation, rename and code actions remain to be connected.
The existing deterministic protocol fixture keeps its separate `/lsp-fixture` route.

## Current workflows

- Problems lists syntactic/type errors across the sample's files. Clicking an error selects
  its captured range in its named file. Typing expires the published project diagnostics.
- Member access and ordinary identifier typing can offer completion automatically. Ctrl+Space
  or Code → Complete requests suggestions explicitly. Arrow keys select a candidate; Enter or a click
  accepts it after resolution. Escape dismisses the offer. The public editor controller applies
  one guarded transaction, including any validated additional edits.
- Hover over a symbol to inspect its real type without changing focus. Code → Inspect type or
  Ctrl+K, Ctrl+I inspects the caret instead. Escape dismisses the popup. Provider documentation
  is displayed as literal text; markup is never inserted as HTML.
- Signature help opens while typing advertised trigger characters and follows the active
  argument. Code → Signature help or Ctrl+Shift+Space requests it explicitly. Completion gets
  the first Escape when both are open. Overload controls appear when the provider offers choices.
  Edits, navigation, composition, file switches and disposal invalidate captured popup work.
- A failed provider leaves typing, history, comparison and local saves usable. Retry creates
  a fresh provider connection with current document snapshots. Switching samples suspends
  the inactive provider; file switches retain the same project synchronization stream.
- Closing a view disposes its completion scope/popup. Closing the project cancels requests,
  disposes synchronization and requests server cleanup. The host stops the owned process and
  removes its allocated workspace. Idle allocations expire after two minutes as a fallback.

## Provider adaptation and limits

The provider's pushed diagnostics omit document versions. The demo does not treat them as
current annotations. Its host extension `sttropez/diagnostics` invokes the pinned provider's
read-only synchronous syntactic/semantic diagnostic commands over the same connection.
The client flushes and captures every project document before requesting them, then validates
all document captures and the request generation before publication. Edits, suspend/dispose
or changed provider participation reject a late result. This is a documented host extension,
not qualification of standard LSP diagnostic pull. Each syntactic or semantic response
contributes at most 256 diagnostics per file/check; wider presentation remains a support limit.

Pinned-provider completion behaviors are adapted by the development bridge. It preserves
the input item's opaque data when resolution replaces the server's cache key, and excludes
candidates whose edit range fails to contain the requested caret. Other item fields, edits and
additional edits reach the public client's strict decoder unchanged. The editor filters each
candidate against its own edit prefix, including punctuation, using bounded reads shared by
candidates with the same start offset.
The provider can offer over 1,000 global candidates at an empty argument. The development host
uses the existing reference document implementation to capture the bounded word prefix, narrows
oversized lists against that prefix and returns at most 256 candidates. A truncated page is
marked incomplete so further typing requests a fresh page. The editor's strict decoding budget
stays unchanged; a later prefix can reach candidates beyond the initial page.

The bridge fixes the project root/compiler settings, validates addressed document URIs and
read-command file paths, and writes only known sample files in its allocated workspace.
Compiler standard libraries come from the pinned toolchain. Automatic type acquisition is off;
the demo does not install project packages or execute edited programs. Unsupported provider
commands and project configuration changes are rejected.

Focused qualification uses a real provider for type-error correction, member completion and
resolution/history, pointer/keyboard inspection, argument changes and popup Escape priority,
held real responses after edits/file switches, startup failure/retry,
incremental synchronization, reconnect and owned process/workspace cleanup. Full packaged
provider integration and integrated responsiveness remain later milestones. Headless checks
do not qualify native IME, OS clipboard or physical input/display behavior.
