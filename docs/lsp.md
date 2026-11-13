# LSP compatibility

The target is LSP 3.17 over JSON-RPC 2.0 and WebSocket transport, using UTF-16 positions.
`vscode-languageserver-protocol@3.17.5` is a development/test reference peer only. It and the
WebSocket fixture server are excluded from compiled editor assets. Runtime code has no package
dependencies. A production language provider is not required for fixture qualification.
The wire engine is implemented in TypeScript because importing the reference implementation
would add runtime dependencies; JSON encoding and WebSocket I/O use platform APIs.

The protocol entry provides a wire engine, host-driven client session, shared Workspace provider
ownership and validated feature/edit models. Both development hosts have an explicit [LSP editor adapter](lsp-editor.md).
The selected feature routes below use that same public integration. The existing
[local worker protocol v1](project-sync.md) remains an internal fixture and establishes no LSP compatibility.

| Area | Current status / next work |
| --- | --- |
| JSON-RPC | Bidirectional requests/notifications, correlated out-of-order responses, structured errors, bounded batches, cancellation, deadlines and disposal. Interoperability uses the pinned reference peer. |
| WebSocket | Host-owned ordered text messages; real three-engine fixture checks use fresh browser processes. Binary messages are refused. Opening can be cancelled; closure releases pending RPC work. Firefox context deletion remains unqualified. |
| Initialization/capabilities | Ordered initialize/initialized, UTF-16 negotiation, immutable capabilities and shutdown/exit. Unsupported position encodings and full synchronization are explicitly refused. |
| Dynamic registration | Atomic register/unregister batches, unique identifiers, exact method matching and immutable snapshots. Text-document selectors cover language, scheme and bounded glob patterns; notebook and file-watcher registration are not advertised. |
| Incremental synchronization | Captured URI/resource/document/revision bindings, separate wire versions, queued/coalesced open/change/close and exact raw UTF-16/CRLF/LF/bare-CR conversion. Point changes reuse shared buffer edges and LF metadata. |
| Shared ownership | One exported `LspWorkspace` per workspace/provider configuration, one connection and one binding/stream per participating document. Feature scopes share versions and diagnostics while cancelling and disposing independently. |
| Diagnostics/completion | Bounded validation, current versioned or explicitly uncertain unversioned snapshot placement, retained unplaceable ranges/messages and shared diagnostic observation. Completion retains full catalogues, supports ordinary typing, triggers/filtering/incomplete retriggers, captured lazy primary/additional edits and pending keyboard acceptance. Flat numbered/default/choice/mirrored/final snippet fields reuse input and history; unsupported optional syntax has per-item disposition. Both hosts exercise typing, history, comparison, Save/Run and lifecycle guards over WebSocket. [Exact scope](lsp-editor.md). |
| Hover/navigation | Bounded literal hover content/optional ranges, definition Location/LocationLink and references validation. Both actual hosts use WebSocket backends with captured project URIs, complete origin selections, target revision/authority checks, unmounted-resource reveal and stale/cancellation/lifecycle guards. See [navigation scope](lsp-navigation.md). |
| Rename/workspace text edits | Whole-batch URI/range/wire-version validation and exact provider edit previews/application in both hosts. Shared atomic history, unmounted targets, comparison, Save/Run, stale/authority/cancellation guards use existing Workspace transactions. See [supported forms and limits](lsp-rename.md). Optional prepareRename, file operations and annotations remain unsupported. |
| Code actions | Complete bounded literal/command list validation, disabled/preferred choices and captured lazy edit resolution. Both hosts preview exact multi-resource edits, page large results and apply atomic history transactions. Confirmed advertised Command/edit+Command choices preserve edit-before-command ordering and use the existing captured server-edit decision owner. Failed later phases leave earlier edits explicitly undoable. [Supported scope](lsp-code-actions.md). |
| Server edits/commands | Advertised static/dynamic global commands and bounded opaque arguments; both hosts explicitly review captured server edits, apply an atomic shared-history transaction and return a decision. Workspace and action-menu commands share one connection and exclusive captured command lane. Cancellation/timeout requires explicit reconnect before another command, while reads remain available. No edit replay. [Supported policy and limits](lsp-server-edits.md). |
| Signature help | Advertised trigger/retrigger context, explicit invocation, literal overload/parameter presentation and captured cancellation. Public client and both hosts use the shared provider; UTF-16 parameter offsets and protocol active-index defaults are validated. [Contract](lsp-language.md). |
| Folding | Captured `textDocument/foldingRange` with static/dynamic negotiation, whole-line conversion, custom kind groups, cancellation and reconnect authority. Both demo providers supply TypeScript ranges; the generic browser discovery controller preserves mapped per-view choices. [Contract](folding.md). |
| Document links | Validated ranges, exact opaque targets and captured lazy resolution. Host-controlled opening permits only registered captured resources; outside destinations and late focus changes cannot trigger an opening. [Contract](lsp-language.md). |
| Document colors | Normalized RGBA/range validation, provider presentation choices, fallback labels and complete additional-edit validation. Explicit host preview/application uses one shared undo transaction. One color registration covers discovery and presentation requests. [Contract](lsp-language.md). |
| Cancellation/reconnect | Opening, queued document calls, RPC requests and cooperative sync plans can be cancelled. Reconnect clears registrations/results and reopens current captures; commands never replay automatically. |
| Host URIs/custom messages | Exact opaque URI bindings, replaceable selector path policy and removable custom request/notification handlers. Custom result schemas, authority and service policy belong to the host. |

The supported subset and this matrix must be updated with each qualified session/feature checkpoint.
No general language semantics, production-provider, native-input or physical-display claim follows
from a protocol fixture.

`sttropez/protocol` exports `JsonRpcConnection`, `RpcError` and their transport/call types.
The host supplies an ordered `RpcTransport` and a scheduler returning a cancellation function.
Calls return an identifier, a result promise and an explicit cancellation method. Responses retain
immutable JSON snapshots. Registered handlers have explicit removal functions. Dispose the
connection at its host lifetime boundary; it releases the transport, deadlines and pending work.
Application handlers must still revalidate captured resource/revision/authority after awaiting
work: cancelling a protocol call cannot reverse an already committed host transaction.

`openWebSocketTransport` is an explicitly invoked browser adapter. Importing it opens no socket.
Each WebSocket text message carries one JSON value, without stream `Content-Length` headers;
this framing must agree with the peer. WebSocket URL, subprotocols, authentication and connection
lifetime belong to the host. TLS/certificate policy follows the browser; the current local fixture
qualifies `ws`, not a deployment's `wss`/proxy/authentication environment.

`LspSession` consumes a host connection factory and scheduler; constructing it starts no work.
The scheduler must invoke callbacks on a future turn, including zero-delay cooperative work.
Bind immutable `TextBuffer` snapshots with `bindDocument`; retain the returned handle to update an
expected local revision or close that binding. Reusing a URI requires closing the previous binding.
An old handle cannot update or close its replacement. Binding and update calls queue work; `flush`
waits for the current eligible captures to reach the wire. This is transport ordering, not an
acknowledgement that a language provider has finished analysis. A later request can supply a peer
barrier. Disconnect preserves local bindings for reconnect; dispose releases session ownership.
Handles retained by the host retain their last immutable snapshot.

Use `LspWorkspace(workspace, options)` to share that session across features and views. The host
supplies the transport factory, future-turn scheduler and `documentInfo` mapping from a live
Workspace snapshot to its opaque URI/language ID. Construction starts no connection. Create a
feature scope, `attachDocument(id)` or `setDocuments(snapshots)`, then connect/request/flush through
that scope. `captureProject()` returns the exact synchronized URI captures. An owner holds one
Workspace lease/observer and one protocol binding per participating document; further scopes reuse
them. Local edits expire captures immediately and coalesce synchronization after commit delivery.
The last participant closes the binding and releases its lease after delivery. The host may retain
its own scope for open, unmounted project resources. Scope disposal releases its calls, subscriptions
and participation; `scope.disconnect()` cancels that feature's work. Owner `disconnect()` or
`reconnect()` changes the shared connection. Owner disposal closes every scope and transport.
Scopes are bounded to 128 by default, in addition to the existing session/document/RPC limits.

`scope.observeDiagnostics(binding)` supplies one stable shared diagnostic snapshot per binding.
It distinguishes received/current, empty and expired results, rejected stale/invalid batches and
unknown URIs. A result keeps the provider `version`/`revision` nullable, independently of the explicit
`snapshotRevision` used to place its validated wire ranges. Unversioned markers have uncertain
freshness; out-of-bounds ranges retain their message and wire range with null offsets. They grant
no edit authority. A local edit, close/URI reuse or reconnect expires associations. Invalid or known
stale pushes preserve the previous valid batch. An unrelated capability registration does not
manufacture a new analysis revision or erase still-current diagnostic placement.

`createLspCommandRunner(scope)` reuses the captured shared command lane and takes host callbacks
for live project snapshots, intent currentness, optional preparation and explicit edit review.
Only the active confirmed command scope receives incoming edits; unclaimed requests are declined.
`owner.state` exposes `commandAvailable` and `commandRequiresReconnect`. A cancelled/timed-out
command or capability change during a command quarantines the lane until a fresh connection,
because incoming `workspace/applyEdit` has no originating command ID. This prevents an abandoned
command's later edit from being assigned to the next intent. Reads and typing continue independently.
The [public editor integration](lsp-integration.md) supplies captured browser coordination and
headless hover/navigation/rename/action clients. Both hosts reuse those exports. Optional host
preparation hooks contain custom-message policy. Signature/link/color clients use
that same scope/capture lifetime and the [selected language contract](lsp-language.md).

Documents synchronize when both open/close and incremental changes are enabled by static or
matching dynamic capabilities. Losing that coverage closes the managed remote document; regaining
it opens the current capture. The client sends incremental replacements and never silently falls
back to exporting the full document on each edit. Initial opening is an explicit bulk payload.
The line index cooperates during initial scanning, shared-edge planning and bare-CR index updates;
an ordinary LF/CRLF point edit reads only the replacement boundary. A dense bare-CR index still
requires cooperative linear copying. CRLF interiors have no unambiguous protocol position and are
refused; generated change boundaries expand across a pair rather than normalizing source text.

Declare `features` only for results the host validates and presents. `canRequest` combines static
and matching dynamic support. `requestDocument` waits for synchronization, captures binding,
revision, session and registration generation, supplies the bound URI, and refuses stale replies.
Its result is immutable wire JSON. Use `decodeLspCompletions` with the supplied capture to validate
all items/ranges/additional edits before presenting any choice. `synchronized(binding)` returns the
exact sent snapshot/index/wire version, or undefined while local updates are pending; its `isCurrent`
guard expires on session, registration or binding/revision changes. `decodeLspDiagnostics` validates
pushes against that capture. `decodeLspHover` and `decodeLspLocations` validate literal content and
captured host URI locations. `decodeLspWorkspaceEdit` normalizes complete text-only batches for
captured resources; the host rechecks edit authority before its atomic transaction.
`decodeLspCodeActions` and `decodeLspResolvedCodeAction` validate choices and edit resolution.
`commandNames` and `requestCommand` expose advertised global commands with captured generations;
the host supplies explicit confirmation and execution policy. With `applyEdit: true`, register a
`workspace/applyEdit` handler before connecting and use `decodeLspApplyEdit` to validate captured
requests before a host decision. Custom handlers persist
across reconnect, but pending calls do not. Incoming request contexts expose cancellation and an
`isCurrent` guard; hosts must check authority again before committing after an await.

The default selector path policy decodes the URI path and matches case sensitively; URI identity
itself is never decoded, normalized or case folded. Hosts can supply `pathForUri` for opaque URI or
filesystem case policy. Supported text-document patterns include `*`, `?`, `**`, `**/`, brace
alternatives, character ranges, negated classes and escaped literals. Matching uses bounded dynamic
programming, without regex backtracking. Limits are 32 filters, 256 units per pattern, 16 expanded
alternatives/1,024 aggregate units and a 4,096-unit path. Relative file-watcher patterns and notebook
selectors belong to unimplemented capabilities and are refused rather than treated as match-all.

Session defaults are 100 documents, 3 Mi UTF-16 units per document and 16 Mi total bound units,
128 registrations/1 Mi aggregate options (64 Ki per registration), and 128 synchronization waits.
Queued document requests share the configured RPC pending-count limit. Wire message limits still
apply after JSON escaping, so a permitted raw document can exceed the encoded-message budget.
The host must configure compatible session, RPC, WebSocket and provider limits for larger payloads.

Reference-peer model checks and real WebSocket journeys cover mixed newlines, a 100,000-line
document, capability withdrawal, cancellation, URI reuse and fresh-session reopening. Browser
journeys stay headless. Their single-action enqueue and peer-barrier times are diagnostics: enqueue
time is neither editor input-handler time nor complete interaction/display latency. These checks
establish session behavior, not native input, production-provider or full LSP feature qualification.

Default limits are 64 concurrent outgoing and incoming calls, 15-second request/open deadlines,
4 Mi UTF-16 units per message, 128 batch elements, 64 JSON nesting levels and 100,000 JSON values.
The browser adapter also bounds queued output by a conservative 16 MiB UTF-8 estimate. Exceeding
transport bounds closes the connection; malformed responses cannot advance another request.
Notifications receive no responses, and late cancelled/expired response identifiers are ignored.
Identifiers support strings, null and safe integers; fractional or unsafe numeric identifiers are refused.

The envelope/error/batch rules follow [JSON-RPC 2.0](https://www.jsonrpc.org/specification).
Method and lifecycle contracts target the [LSP 3.17 specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/).
