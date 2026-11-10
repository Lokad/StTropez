# LSP compatibility

The target is LSP 3.17 over JSON-RPC 2.0 and WebSocket transport, using UTF-16 positions.
`vscode-languageserver-protocol@3.17.5` is a development/test reference peer only. It and the
WebSocket fixture server are excluded from compiled editor assets. Runtime code has no package
dependencies. A production language provider is not required for fixture qualification.
The wire engine is implemented in TypeScript because importing the reference implementation
would add runtime dependencies; JSON encoding and WebSocket I/O use platform APIs.

The first checkpoint provides the wire foundation. It does **not** yet provide an LSP client
session or editor feature adapters. The existing [local worker protocol v1](project-sync.md)
remains an internal fixture and establishes no LSP compatibility.

| Area | Current status / next work |
| --- | --- |
| JSON-RPC | Bidirectional requests/notifications, correlated out-of-order responses, structured errors, bounded batches, cancellation, deadlines and disposal. Interoperability uses the pinned reference peer. |
| WebSocket | Host-owned ordered text messages; real three-engine fixture checks use fresh browser processes. Binary messages are refused. Opening can be cancelled; closure releases pending RPC work. Firefox context deletion remains unqualified. |
| Initialization/capabilities | Raw standard initialize packets are exchanged in transport tests; the LSP lifecycle/UTF-16 negotiation state machine is still required. |
| Dynamic registration | Bidirectional standard registration packets are exchanged; capability registry, selectors and unregister semantics are still required. |
| Incremental synchronization | LSP open/change/close, exact UTF-16 positions, document versions and reconnect resynchronization are still required. Worker-v1 synchronization does not substitute for them. |
| Diagnostics/completion/hover/navigation | Wire-backed feature negotiation, validation, captured result ownership and editor adapters are still required. |
| Rename/code actions/workspace edits | Versioned URI-to-resource mapping, complete validation, explicit application, shared atomic history and stale/authority refusal are still required. |
| Cancellation/reconnect | RPC cancellation and fresh connections are exercised. LSP session cancellation, invalidating stale results and reopening current documents remain required; commands must not replay automatically. |
| Host URIs/custom messages | RPC payloads preserve opaque host URI strings; explicit request/notification handlers are available. LSP document binding and extension policy remain required. |

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

Default limits are 64 concurrent outgoing and incoming calls, 15-second request/open deadlines,
4 Mi UTF-16 units per message, 128 batch elements, 64 JSON nesting levels and 100,000 JSON values.
The browser adapter also bounds queued output by a conservative 16 MiB UTF-8 estimate. Exceeding
transport bounds closes the connection; malformed responses cannot advance another request.
Notifications receive no responses, and late cancelled/expired response identifiers are ignored.
Identifiers support strings, null and safe integers; fractional or unsafe numeric identifiers are refused.

The envelope/error/batch rules follow [JSON-RPC 2.0](https://www.jsonrpc.org/specification).
Method and lifecycle contracts target the [LSP 3.17 specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/).
