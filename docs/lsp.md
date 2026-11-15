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
| Incremental synchronization | Captured URI/resource/document/revision bindings, separate wire versions, queued/coalesced open/change/close and exact raw UTF-16/CRLF/LF/bare-CR conversion. Proven transaction batches send separated edits in descending order, including inverses and compact typing groups. Unproved or skipped transitions retain a shared-edge replacement fallback. |
| Shared ownership | One exported `LspWorkspace` per workspace/provider configuration, one connection and one binding/stream per participating document. Feature scopes share versions and diagnostics while cancelling and disposing independently. |
| Diagnostics/completion | Bounded validation, current versioned or explicitly uncertain unversioned snapshot placement, retained unplaceable ranges/messages and shared diagnostic observation. Completion retains full catalogues, supports ordinary typing, triggers/filtering/incomplete retriggers, captured lazy primary/additional edits and pending keyboard acceptance. Flat numbered/default/choice/mirrored/final snippet fields reuse input and history; unsupported optional syntax has per-item disposition. Both hosts exercise typing, history, comparison, Save/Run and lifecycle guards over WebSocket. [Exact scope](lsp-editor.md). |
| Hover/navigation | Format-preserving hover content/optional ranges with a focused [documentation renderer](documentation.md), definition Location/LocationLink and references validation. Both actual hosts use WebSocket backends with captured project URIs, complete origin selections, target revision/authority checks, unmounted-resource reveal and stale/cancellation/lifecycle guards. See [navigation scope](lsp-navigation.md). |
| Rename/workspace text edits | Whole-batch URI/range/wire-version validation and exact provider edit previews/application in both hosts. Shared atomic history, unmounted targets, comparison, Save/Run, stale/authority/cancellation guards use existing Workspace transactions. See [supported forms and limits](lsp-rename.md). Optional prepareRename, file operations and annotations remain unsupported. |
| Code actions | Complete bounded literal/command list validation, disabled/preferred choices and captured lazy edit resolution. Both hosts preview exact multi-resource edits, page large results and apply atomic history transactions. Confirmed advertised Command/edit+Command choices preserve edit-before-command ordering and use the existing captured server-edit decision owner. Failed later phases leave earlier edits explicitly undoable. [Supported scope](lsp-code-actions.md). |
| Server edits/commands | Advertised static/dynamic global commands and bounded opaque arguments; both hosts explicitly review captured server edits, apply an atomic shared-history transaction and return a decision. Workspace and action-menu commands share one connection and exclusive captured command lane. Cancellation/timeout requires explicit reconnect before another command, while reads remain available. No edit replay. [Supported policy and limits](lsp-server-edits.md). |
| Signature help | Advertised trigger/retrigger context, explicit invocation, overload/parameter presentation with format-preserving documentation, and captured cancellation. The public client retains the last accepted wire context across superseded requests within the same binding/connection/registration identity. UTF-16 parameter offsets and protocol active-index defaults are validated. [Contract](lsp-language.md). |
| Folding | Captured `textDocument/foldingRange` with static/dynamic negotiation, whole-line conversion, custom kind groups, cancellation and reconnect authority. Both demo providers supply TypeScript ranges; the generic browser discovery controller preserves mapped per-view choices. [Contract](folding.md). |
| Occurrences | Captured `textDocument/documentHighlight`, text/read/write kinds, complete range validation and indexed visible-row queries. The public caret controller expires changed selection/document/provider results; both demo providers exercise it. [Contract](lsp-editor.md). |
| Document links | Validated ranges, exact opaque targets and captured lazy resolution. Host-controlled opening permits only registered captured resources; outside destinations and late focus changes cannot trigger an opening. [Contract](lsp-language.md). |
| Document colors | Normalized RGBA/range validation, provider presentation choices, fallback labels and complete additional-edit validation. Explicit host preview/application uses one shared undo transaction. One color registration covers discovery and presentation requests. [Contract](lsp-language.md). |
| Cancellation/reconnect | Opening, queued document calls, RPC requests and cooperative sync plans can be cancelled. Reconnect clears registrations/results and reopens current captures; commands never replay automatically. |
| Host URIs/custom messages | Exact opaque URI bindings, replaceable selector path policy and removable custom request/notification handlers. Custom result schemas, authority and service policy belong to the host. |

The supported subset and this matrix must be updated with each qualified session/feature checkpoint.
The generic peer's opt-in `fixtureHostProfile` initialization option qualifies dynamically
registered completion for `host+fixture` URIs with language `fixture`, including a space trigger,
lazy snippet imports and unregistration. Its document highlights reuse the lexical reference
scanner and report textual occurrences, without claiming language-level read/write semantics.
The peer also accepts an unadvertised review command: clients refuse it by default, while an
explicit host command policy can authorize its existing server-edit review route. The joined
fixture test checks action-edit synchronization and separately undoable command phases.
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

For a peer that requires a host message before JSON-RPC, pass `preProtocolMessage` to
`openWebSocketTransport`. The adapter captures the string at invocation and sends it once
after the socket opens, before resolving the transport promise. An empty string sends an empty
text message; omission sends none. It is raw host text, without a JSON-RPC envelope. The host
supplies the option on every connection attempt and obtains any fresh credentials beforehand.
Sending uses the same message and queued-buffer limits as protocol traffic. Invalid or oversized
options reject before creating a socket; send failure, cancellation or opening timeout rejects
and releases the pending socket. Successful opening means the message was queued, not that
the server accepted authentication. This option does not wait for or consume a separate handshake
response; protocols requiring that exchange belong in the host connection factory.
Transport policy failures close the native socket with application codes `4003` (binary
message) or `4009` (message/buffer limit), which the browser's `close()` API permits.

`LspSession` consumes a host connection factory and scheduler; constructing it starts no work.
The scheduler must invoke callbacks on a future turn, including zero-delay cooperative work.
Bind immutable `TextBuffer` snapshots with `bindDocument`; retain the returned handle to update an
expected local revision or close that binding. Reusing a URI requires closing the previous binding.
An old handle cannot update or close its replacement. Binding and update calls queue work; `flush`
waits for the current eligible captures to reach the wire. This is transport ordering, not an
acknowledgement that a language provider has finished analysis. A later request can supply a peer
barrier. Disconnect preserves local bindings for reconnect; dispose releases session ownership.
Handles retained by the host retain their last immutable snapshot.

The optional fourth `document.update` argument supplies the position mapping from that exact
previous buffer. `LspWorkspace` supplies transaction mappings automatically. Batch ranges are
accepted only after proving unchanged gaps by shared storage or bounded short-text comparisons;
they are expanded across newline boundaries and sent in descending original-offset order, so
each range addresses the text produced by preceding wire changes. Opaque maps, general composed
history maps, skipped revisions and unproved gaps use the single-replacement fallback. A batch
rejected during RPC encoding also falls back if its range overhead exceeds the host's message or
JSON-node limit; transport failures are never retried. Both forms retain those limits. A prepared
line index may be ahead of the last sent snapshot; wire ranges always use the actual sent base.
LF metadata is reused; changed regions are scanned and the extra bare-CR index is copied/shifted
once per transition. Bare-CR-heavy documents can therefore still require linear index copying.

Use `LspWorkspace(workspace, options)` to share that session across features and views. The host
supplies the transport factory, future-turn scheduler and `documentInfo` mapping from a live
Workspace snapshot to its opaque URI/language ID. Construction starts no connection. Create a
feature scope, `attachDocument(id)` or `setDocuments(snapshots)`, then connect/request/flush through
that scope. `captureProject()` returns the exact synchronized URI captures. An owner holds one
Workspace lease/observer and one protocol binding per participating document; further scopes reuse
them. Local edits expire captures immediately and coalesce synchronization after commit delivery.
Ordinary edits queue only their document URI. Connection and capability changes reconcile all
bindings, including pending closes, before reopening matching captures. Static/dynamic selector
results are reused within a binding and registration generation; revision changes preserve URI
and language identity. A host `pathForUri` policy must remain stable for the binding's lifetime;
close/rebind or reconnect after changing that policy. Closing releases the binding's cached results.
The last participant closes the binding and releases its lease after delivery. The host may retain
its own scope for open, unmounted project resources. Scope disposal releases its calls, subscriptions
and participation; `scope.disconnect()` cancels that feature's work. Owner `disconnect()` or
`reconnect()` changes the shared connection. Owner disposal closes every scope and transport.
Scopes are bounded to 128 by default, in addition to the existing session/document/RPC limits.

`scope.observeDiagnostics(binding)` supplies one stable shared diagnostic snapshot per binding.
It distinguishes received/current, mapped pending, empty and expired results, rejected stale/invalid batches and
unknown URIs. A result keeps the provider `version`/`revision` nullable, independently of the explicit
`snapshotRevision` used to place its validated wire ranges. Unversioned markers have uncertain
freshness; ranges with nonexistent lines retain their message and wire range with null offsets.
Character positions past a valid line's end clamp to that end under LSP 3.17; the original wire
range remains available alongside the placed offsets. These presentation anchors grant
no edit authority. Consecutive local edits map placed offsets through the document's transaction
map and set `status: "pending"`; wholly deleted ranges disappear. `snapshotRevision` follows
the mapped source, while provider `version`/`revision`, original wire ranges and related metadata
remain unchanged. Pending `isCurrent()` is always false; `isPlacementCurrent()` separately
guards display/navigation offsets against the local revision, buffer and provider lifetime.
Undo maps surviving ranges but cannot resurrect deleted diagnostics. Missing transaction maps,
close/URI reuse and reconnect expire associations. Fresh pushes replace the batch, including
an empty batch that clears it. Invalid or known stale pushes preserve the previous valid batch.
Mapping visits the retained diagnostics, with no full-source export or provider request.
An unrelated capability registration does not
manufacture a new analysis revision or erase still-current diagnostic placement.

Diagnostics retain immutable `code` (integer or string), `codeDescription`, `tags`,
`relatedInformation` and opaque JSON `data`. Unknown integer tags survive forwarding;
the advertised presentation tags are unnecessary and deprecated. Related URIs and ranges
are preserved without loading resources. Help opening and related-location navigation belong
to the host. Malformed metadata rejects the complete batch, including an invalid final item.
The action client forwards this metadata for overlapping, placed diagnostics from a matching
current provider version. Pending and unversioned diagnostics remain available for uncertain presentation
but are excluded from that version-verified context. Action results also retain attached
diagnostics, including after edit resolution. No metadata supplies edit or command authority.

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
The line index cooperates during initial scanning, shared-edge planning and bare-CR index updates.
The session batches work until 4 ms or 32 checkpoints, then schedules another turn. Its optional
`now` clock defaults to `Date.now`; the chunk cap also bounds a stopped or backward clock.
Completed indexes remain on their binding across revisions, capability changes and reconnect.
Edits during indexing reuse that work and only the current snapshot is sent. Replacing or closing
the binding cancels its work. Encoding/allocation and provider analysis are separate costs, so the
cooperative slice budget is not a complete interaction-latency guarantee.
An ordinary LF/CRLF point edit reads only the replacement boundary. A dense bare-CR index still
requires cooperative linear copying. CRLF interiors have no unambiguous protocol position and are
refused; generated change boundaries expand across a pair rather than normalizing source text.

Declare `features` only for results the host validates and presents. `canRequest` combines static
and matching dynamic support. `requestDocument` waits for synchronization, captures binding,
revision, session and registration generation, supplies the bound URI, and refuses stale replies.
Its result is immutable wire JSON. Use `decodeLspCompletions` with the supplied capture to validate
all items/ranges/additional edits before presenting any choice. `synchronized(binding)` returns the
exact sent snapshot/index/wire version, or undefined while local updates are pending; its `isCurrent`
guard expires on session, registration or binding/revision changes. `decodeLspDiagnostics` validates
pushes against that capture. `decodeLspHover` and `decodeLspLocations` validate documentation and
captured host URI locations. `decodeLspWorkspaceEdit` normalizes complete text-only batches for
captured resources. After checking its captured intent and obtaining approval, the host can call
`applyLspWorkspaceEdit(workspace, edit, { origin: "host", requiredOrigins: ["human"], view })`.
This rechecks provider currentness and exact workspace document/resource/buffer/revision identity,
then delegates range, authority and lock validation to one atomic `Workspace.editDocuments`
transaction with shared undo. It throws on refusal and returns immutable updated snapshots of
changed documents. Empty and text-identical batches return an empty array without history.
The optional view is the captured origin; selections in other live views are mapped by the core.
The helper is synchronous and owns no leases: retain the provider result through the decision,
and keep host selection, lifecycle and approval guards outside it.
`previewLspWorkspaceEdit(edit, titleForDocumentId, page)` reads captured buffers into immutable
64-edit pages with bounded titles, before/insert text and context. It reports the complete edit
count and insertion sizes, does not materialize off-page edits and grants no authority to apply.
URI discovery and decoding share parsed location/workspace-edit syntax only for JSON
captured and deeply frozen by the protocol owner. Mutable or frozen host inputs are
validated afresh. Each decode still resolves captured targets and checks currentness,
wire versions, buffer bounds and edit overlap; syntax reuse conveys no edit authority.
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
An encoded document or selector-policy failure closes only that document's remote copy and reports
the error through `onError`. The local binding remains available for a corrected revision; a new
revision, capability generation or explicit reconnect retries synchronization. Requests against the
failed capture reject with its synchronization error. Other documents remain usable.

Feature clients may establish the initial connection. After a failed opening or connection loss,
the host must call the provider's `connect()` or `reconnect()` explicitly; repeated feature requests
do not initiate reconnect attempts. Reconnection never replays an edit or command. Invalid percent
escapes in the default selector pathname are treated as literal path text; opaque URI identity is
unchanged, and a host can still supply `pathForUri`.

Reference-peer model checks and real WebSocket journeys cover mixed newlines, a 100,000-line
document, capability withdrawal, cancellation, URI reuse and fresh-session reopening. Browser
journeys stay headless. Their single-action enqueue and peer-barrier times are diagnostics: enqueue
time is neither editor input-handler time nor complete interaction/display latency. These checks
establish session behavior, not native input, production-provider or full LSP feature qualification.

Default limits are 64 concurrent outgoing and incoming calls, 15-second request/open deadlines,
4 Mi UTF-16 units per message, 128 batch elements and 64 JSON nesting levels. `rpc.maxJsonNodes`
bounds JSON values in a complete message, including a batch; it defaults to `rpc.maxMessageUnits`
(4,194,304). A value counts once, including each array/object and each primitive. Host-supplied
option/feature snapshots retain their separate 100,000-value validation bound.
Opaque snapshots reuse parsed, deeply frozen JSON subtrees only when they satisfy that
narrower bound. Host-supplied values are still validated and copied, including frozen host
objects; array/object accessors are refused. A subtree containing negative zero follows the
copy path to retain JSON serialization's zero normalization. Completion resolution keeps
unchanged captured items and copies items that inherit list defaults.
The browser adapter also bounds queued output by a conservative 16 MiB UTF-8 estimate. Exceeding
transport or batch-count bounds closes the connection; malformed responses cannot advance another request.
A structurally over-budget response rejects its identified pending call and releases its deadline
immediately. Other calls remain usable. A rejected batch rejects its identified calls as a group.
Notifications receive no responses; successful late replies are ignored, while uncorrelated error
responses (including null IDs) reach `onError` without generating a response of their own.
Identifiers support strings, null and safe integers; fractional or unsafe numeric identifiers are refused.

The envelope/error/batch rules follow [JSON-RPC 2.0](https://www.jsonrpc.org/specification).
Method and lifecycle contracts target the [LSP 3.17 specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/).
