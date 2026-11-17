# Language server

Connect a host-owned language service through `LspWorkspace`. StTropez implements a subset of
[LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
over [JSON-RPC 2.0](https://www.jsonrpc.org/specification), with WebSocket text messages and UTF-16
positions. The headless protocol entry owns validation, synchronization and request lifetime;
the host owns connection settings, resource access, presentation and edit authorization.
The TypeScript wire engine uses platform JSON and transport APIs and has no runtime package
dependencies.

## Use

Create one provider per workspace and provider configuration. Supply a stable mapping from
document snapshots to exact URIs and language IDs. Obtain fresh connection settings for each
attempt, including any credentials required by the server:

```ts
import type { Workspace } from "sttropez";
import { openWebSocketTransport } from "sttropez/browser";
import {
    LspWorkspace,
    type LspConnectContext,
    type LspWorkspaceOptions
} from "sttropez/protocol";

type ConnectionSettings = Readonly<{
    url: string;
    protocols?: string | readonly string[];
    preProtocolMessage?: string;
}>;

export function createLanguageProvider(
    workspace: Workspace,
    documentInfo: LspWorkspaceOptions["documentInfo"],
    settings: (context: LspConnectContext) => Promise<ConnectionSettings>,
    onError: (error: Error) => void
) {
    return new LspWorkspace(workspace, {
        documentInfo,
        features: ["textDocument/completion", "textDocument/hover"],
        diagnostics: true,
        onError,
        schedule(delay, callback) {
            const timer = window.setTimeout(callback, delay);
            return () => window.clearTimeout(timer);
        },
        async connect(context) {
            const connection = await settings(context);
            if (context.cancelled) throw new Error("Connection cancelled.");
            const abort = new AbortController();
            const stop = context.onCancel(() => abort.abort());
            try {
                return await openWebSocketTransport(connection.url, {
                    ...connection, signal: abort.signal
                });
            } finally {
                stop();
            }
        }
    });
}
```

Construction opens no connection. The scheduler runs callbacks on a future turn, including
zero-delay work. The settings callback can use its cancellation context to abandon credential
retrieval; returning settings after cancellation cannot open a socket through this recipe.
Enable only features whose results the host validates and presents. `features` defaults to an
empty list; diagnostics, workspace edits, incoming edits and Markdown documentation are separate
opt-ins. The example enables completion, hover and diagnostics.

Attach completion and diagnostics to an existing mounted editor:

```ts
import type { TabId, Workspace } from "sttropez";
import { createLspEditor, type EditingCandidate } from "sttropez/browser";
import type { LspWorkspace } from "sttropez/protocol";

export function attachLanguage(
    workspace: Workspace,
    tab: TabId,
    editor: EditingCandidate,
    provider: LspWorkspace,
    onError: (error: unknown) => void
) {
    const language = createLspEditor(workspace, tab, editor, {
        provider, autoConnect: false, onError
    });
    language.connect();
    return language;
}
```

Render `language.state` through the host's observable integration and call `language.destroy()`
when the view detaches. It releases its requests and subscriptions without destroying the editor
or provider. Dispose other feature clients at their own boundaries, then `provider.dispose()` at
the workspace/configuration boundary. Destroy the mounted editor separately. Connect the host's
retry control to `provider.connect()` or `provider.reconnect()` and handle its rejected promise.
The [language-feature contract](language-features.md) defines controller commands and capture
guards; [embedding](getting-started.md) defines mounting and view teardown.

Custom handlers use a feature scope and validate their own schemas. In this example, the host
reader authorizes the resource and captures its identity before asynchronous work; its result
guard checks that capture when the reply is ready:

```ts
import {
    RpcError,
    type JsonValue,
    type LspRequestContext,
    type LspWorkspaceScope
} from "sttropez/protocol";

type ReadResult = Readonly<{ value: JsonValue; isCurrent: () => boolean }>;

export function registerResourceContext(
    scope: LspWorkspaceScope,
    read: (resource: string, context: LspRequestContext) => Promise<ReadResult>
) {
    return scope.onRequest("host/resourceContext", async (params, context) => {
        if (params === null || typeof params !== "object" || Array.isArray(params)
            || !("resource" in params)
            || typeof params.resource !== "string" || params.resource.length > 4096) {
            throw new RpcError(-32602, "Expected a bounded resource identifier.");
        }
        const result = await read(params.resource, context);
        if (!context.isCurrent() || !result.isCurrent()) {
            throw new RpcError(-32801, "Captured resource changed.");
        }
        return result.value;
    });
}
```

Retain the returned removal function, or dispose the scope to remove its handlers. Custom
handlers persist across reconnect; pending calls do not. Use `request`/`notify` for outgoing
custom messages and `onRequest`/`onNotification` for incoming ones. Lifecycle, synchronization
and reserved protocol methods cannot be replaced through the custom-message API.

## Contract

### Transport and session

`openWebSocketTransport` creates a browser `RpcTransport` only when invoked. Each ordered text
message contains one JSON value, without stream `Content-Length` headers. Binary messages are
refused. Opening supports cancellation and a deadline; disposal releases the socket and listeners.
Transport policy failures close the native socket with code `4003` for binary input or `4009`
for a message/buffer limit. Imports perform no network work.

`preProtocolMessage` is raw host text sent once after opening and before the transport promise
resolves. Omission sends nothing; an empty string sends an empty message. The adapter captures
the option at invocation, validates it before creating the socket and applies the protocol
traffic limits to its send. Success means the text was queued. It does not establish successful
authentication or consume a handshake reply. A separate handshake exchange belongs in the host
connection factory.

`JsonRpcConnection` supplies bidirectional requests, notifications, correlated responses,
structured errors, bounded batches, cancellation and deadlines. Calls expose an ID, a result
promise and `cancel()`. Responses are immutable JSON snapshots; handlers have removal functions.
String, null and safe-integer IDs are accepted; fractional and unsafe numeric IDs are refused.
Notifications receive no replies. Late successful replies are ignored; uncorrelated error replies
reach `onError`. Disposing the connection releases its transport, deadlines and pending work.

`RpcError` carries a numeric protocol `code`, message and optional JSON `data`. Remote error
responses reject their calls with this error; request handlers can throw it to supply a
structured error response. Cancellation, expiry and transport failures also reject pending
work, so callers must handle rejected results and release their captured intent.

`ProtocolDecodeError` identifies malformed or unsupported provider data, including feature
results and initialization capabilities. Completion counters classify these failures as
invalid replies. Errors thrown by host callbacks retain their original identity; they are
not decode failures. Caller configuration and local edit planning retain their validation
errors. Cancellation and expired captures use the protocol codes carried by `RpcError`.

`LspSession` is the lower-level owner for hosts without a `Workspace`. Construct it with a
connection factory and scheduler, bind immutable buffers with `bindDocument`, and retain each
handle for expected-revision updates or closing. An old handle cannot modify its replacement;
close a binding before reusing its URI. `connect()` orders `initialize` and `initialized`, checks
UTF-16 negotiation and synchronizes eligible bindings. `shutdown()` performs the orderly
shutdown/exit exchange. `disconnect()` retains local bindings for a new connection; `dispose()`
releases session ownership. `LspWorkspace.dispose()` closes the connection directly.

### Workspace ownership and synchronization

`LspWorkspace.createScope()` creates independent feature participation over the shared session.
Use `attachDocument(id)` or `setDocuments(snapshots)` to participate. Each participating document
has one workspace lease/observer, one protocol binding and one wire-version stream across views.
The last participant closes that binding and releases its lease after notification delivery.
Keep a host scope when unmounted project documents must participate. `scope.disconnect()` cancels
that scope's work; owner `disconnect()` and `reconnect()` change the shared connection. Scope
disposal releases its calls, handlers and participation; owner disposal closes every scope.

URI identity is exact and opaque. `documentInfo` determines the URI/language pair when a document
joins. Replace participation or the provider explicitly when configuration changes. Local revision,
resource/document identity and wire version are separate. Local edits expire captures immediately;
their synchronization coalesces after workspace transaction delivery. Ordinary edits queue only
the changed document. Capability and connection changes reconcile the participating bindings.

Documents synchronize only with both open/close and incremental-change support from static or
matching dynamic capabilities. Losing coverage closes the remote document; regaining coverage
opens the current capture. Initial opening sends the full document. Changes use incremental
replacements: proven transaction ranges are sent in descending original-offset order; skipped
revisions, opaque maps and unproved gaps use a shared-edge replacement. Excess batch-encoding
overhead can also use that replacement fallback. Transport failures do not retry an edit.

`LspLineIndex.create(buffer, cooperate)` builds an immutable UTF-16 position index. `positionAt`
rejects invalid offsets; `offsetAt` rejects malformed positions, clamps oversized characters to
the line's content end and maps lines beyond the document to EOF. `change` returns a replacement
index and incremental changes without mutating the original. The caller supplies cooperative
scheduling for construction and change planning.

The index preserves raw LF, CRLF and bare-CR text. CRLF interiors have no unambiguous protocol
position and are refused; generated change boundaries expand across the pair. LF metadata is
reused and changed regions are scanned. Dense bare-CR indexes can require linear copying.
Synchronization planning yields after its time/checkpoint budget; encoding, allocation and server
analysis have separate costs. The [measurement glossary](README.md#glossary) defines latency terms.

`flush()` waits for pending synchronization to reach the wire. It does not acknowledge completed
server analysis. On a session or scope, pass document handles to wait only for those exact captures;
a revision, binding or capability change rejects that selective wait. Feature clients use selective
waits so an unrelated large document does not delay their synchronized source. `synchronized(handle)`
returns the exact sent snapshot, index and version, or `undefined` while it is unavailable.
`captureProject()` supplies the scope's synchronized URI captures.

`requestDocument` waits for synchronization, supplies the bound URI and captures the binding,
revision, connection epoch and registration generation. Stale replies are refused. Its immutable
JSON result needs a feature decoder before presentation. `scope.isDocumentCurrent` also observes
workspace edits before deferred binding synchronization. `isBindingCurrent` allows revision changes
and does not establish range freshness. No capture or syntax cache grants edit authority.

### Capabilities and supported subset

`canRequest` combines the host's enabled features with static and matching dynamic support.
Register/unregister batches validate atomically, with unique IDs and exact method matching.
The default selector policy decodes URI paths and matches case sensitively without changing URI
identity. Invalid percent escapes are literal path text. Supply `pathForUri` for another path
policy and keep it stable for the binding lifetime; close/rebind or reconnect after changing it.
Selectors support language, scheme and bounded glob patterns: `*`, `?`, `**`, `**/`, brace
alternatives, character ranges, negated classes and escaped literals. Matching uses bounded
dynamic programming. Unsupported selector forms are refused instead of becoming match-all.

| Area | Contract and detailed owner |
| --- | --- |
| Lifecycle and synchronization | Initialize/initialized, UTF-16 negotiation, incremental open/change/close, cancellation, dynamic registration and explicit reconnect |
| Diagnostics and completion | Versioned or explicitly uncertain [diagnostics](language-features.md#diagnostics), complete result validation, filtering, lazy resolution, supported snippets and captured [completion](language-features.md#completion) |
| Hover and navigation | Format-preserving hover, definitions and references, captured target loading/reveal; [navigation](language-features.md#navigation-and-target-loading) and [documentation rendering](language-features.md#hover-and-documentation) |
| Rename and workspace text edits | Whole-batch URI/range/version validation, previews and atomic shared history; [rename/edit forms](language-features.md#rename-and-workspace-edits) |
| Code actions | Literals/commands, disabled/preferred choices, lazy edit resolution and authorized command phases; [actions](language-features.md#code-actions-and-commands) |
| Workspace commands and server edits | Advertised commands or exact host grants, one captured command lane, explicit incoming-edit decisions; [server edits](language-features.md#code-actions-and-commands) |
| Signature, links and colors | Captured signature context, link discovery/resolution, color discovery/presentations and host application; [language features](language-features.md) |
| Folding and occurrences | Whole-line folding with kind groups; text/read/write occurrence ranges and visible-row queries; [folding](folding.md) and [occurrences](language-features.md#occurrences) |
| Extensions | Host-defined URI mapping, removable custom handlers and host-supplied connection/preparation policies |

Feature clients share capture and cancellation ownership. Supersession expires earlier results
even on unchanged documents. Cancellation settles work waiting on host preparation and ignores
its late completion; it cannot stop arbitrary host code. Cancelling a client releases loaded
targets and expires published results while retaining synchronization bindings. Participation
ends when the next project omits a document, the client is disposed, the host closes it or a
request fails. Completed wire calls can be released without cancelling later calls.

Target lookup first uses captured project resources. An optional `resolveTarget` loads missing
targets through host policy and returns an exact retained target with a release callback. No
server URI is fetched or opened automatically. Guards check the captured project and loaded
targets without caching authority across asynchronous work. See [target loading](language-features.md#navigation-and-target-loading).

### Commands and edit decisions

Enable `workspace/executeCommand` for command support and `applyEdit: true` for incoming edits.
A session advertising incoming edits requires a `workspace/applyEdit` handler before connecting;
the workspace owner supplies routing for feature scopes. `createLspCommandRunner(scope)` installs
the scoped decision handler. Supply captured project snapshots, `isCurrent`, optional preparation
and an explicit asynchronous review callback. Use `run` for advertised commands or `runAuthorized`
with a host-approved exact invocation route. Advertisement alone does not authorize execution.

The runner snapshots arguments and reserves the shared command lane before preparation or
synchronization. A competing or quarantined command cannot perform a preparation edit. Only the
active server command can receive its incoming edits; unsolicited and overlapping requests are
refused. Host routes use the same lane and validation through their captured `applyEdit` callback.
Each review rechecks request currentness, all target identities/revisions and host authority.

The feature guide defines [workspace-edit validation, previews and atomic application](language-features.md#rename-and-workspace-edits)
and [action/command phase decisions](language-features.md#code-actions-and-commands).

Cancellation before a server command is sent releases its reservation. Cancellation, timeout or
capability invalidation after sending quarantines the command lane until a fresh connection:
`workspace/applyEdit` carries no originating command ID. `commandAvailable` and
`commandRequiresReconnect` expose this state. Reads and local typing continue. A host-only route
that never sends a server command can fail or cancel without this quarantine. Reconnect never
replays a command or edit. Lost acknowledgements cannot undo committed changes; those transactions
stay applied and undoable even if their reply cannot be delivered.

### Limits and failures

Sizes below use UTF-16 code units unless marked as bytes. Configure compatible document, RPC,
WebSocket and server limits: JSON escaping can exceed a wire budget even when raw text fits.

| Boundary | Default or fixed limit |
| --- | --- |
| Session documents | 100; configurable `maxDocuments` |
| Bound text | 3 Mi units/document, 16 Mi total; configurable `maxDocumentUnits`/`maxTotalUnits` |
| Workspace feature scopes | 128; configurable `maxScopes` |
| Dynamic registrations | 128, 64 Ki option units each, 1 Mi aggregate |
| Synchronization waits | 128 |
| RPC pending calls | 64 outgoing and 64 incoming; configurable `rpc.maxPending`; queued document calls share the outgoing bound |
| RPC request / opening deadline | 15 seconds by default; command runner requests use 120 seconds |
| RPC / WebSocket message | 4 Mi units; separately configurable `rpc.maxMessageUnits` / transport `maxMessageUnits` |
| Complete wire JSON | 64 nesting levels; `rpc.maxJsonNodes` values, defaulting to `rpc.maxMessageUnits` |
| RPC batches | 128 elements |
| Host JSON snapshots | 100,000 values; finite plain JSON without accessors |
| WebSocket queued output | 16 MiB conservative UTF-8 estimate; configurable `maxBufferedBytes` |
| Selectors | 32 filters, 256 units/pattern, 16 expanded alternatives/1,024 aggregate units, 4,096-unit path |
| Commands | 128 names/static provider or registration, 256-unit names, 256-name combined union, 8,192 JSON units/argument array |
| Cooperative synchronization | 4 ms or 32 checkpoints per turn; optional `now` clock, default `Date.now` |

Transport or batch-count overflow closes the connection. A structurally over-budget response
rejects its identified call and releases the deadline; other calls can continue. Rejected batches
reject their identified calls together. Protocol-owned frozen JSON can reuse validated syntax;
host JSON, including frozen host objects, is validated and copied. Negative zero follows JSON's
zero normalization. Each decode rechecks target captures, versions, bounds and overlap.

A document encoding or selector-policy failure closes only that remote document and reports
through `onError`. Its local binding can synchronize after a corrected revision, capability
change or explicit reconnect; other documents stay usable. Requests for the failed capture
reject with its synchronization error. After opening failure or connection loss, the host calls
`connect()` or `reconnect()` explicitly. Repeated feature requests do not initiate retries.
Deferred release and cancellation failures reach `onError` without interrupting other cleanup.

## Host responsibilities

Own endpoint selection, browser TLS/proxy policy, authentication, connection lifetime and custom
message schemas. Keep URI/resource mapping stable and authorize target loading, navigation and
commands explicitly. Supply a future-turn scheduler and suitable resource limits. Render only
validated results, respecting uncertain diagnostic freshness and capture guards.

Capture resource, document, revision, selections, view/lifecycle and edit authority before delayed
work. Revalidate after every await and immediately before a commit. Cancelling a request cannot
reverse a committed transaction. Keep retries explicit and expose uncertain command outcomes.
Observe immutable state without mutating the workspace during notification delivery; use host
events or scheduled work for subsequent changes. Retain and release clients, scopes, loaded
targets and handlers at their ownership boundaries.

## Not covered

See the [support matrix](README.md#support-matrix) for unsupported capabilities and consuming-host
qualification. Feature pages define narrower result forms and presentation limits.
