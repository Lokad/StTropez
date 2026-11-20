# Language server

Use `LspWorkspace` to share one language-server connection across editor views. The client handles
document synchronization and validates replies. You choose the endpoint, authorize access and show the
results. The WebSocket transport carries [JSON-RPC 2.0](https://www.jsonrpc.org/specification) text
messages. The client supports the
[LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
subset below with UTF-16 positions.

## Use

Create one provider per workspace and provider configuration. Map each document to a stable URI and
language ID. Obtain fresh settings and credentials for each connection attempt.

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

Creating the provider opens no connection. Supply a scheduler that defers even a zero-delay callback.
When fetching credentials, honor the cancellation context. The example enables completion, hover and
diagnostics. `features` starts empty. Opt into diagnostics, workspace edits, incoming edits and
Markdown separately.

Attach completion and diagnostics to an existing mounted editor:

```ts
import type { TabId, Workspace } from "sttropez";
import { createLspEditor, type TextEditor } from "sttropez/browser";
import type { LspWorkspace } from "sttropez/protocol";

export function attachLanguage(
    workspace: Workspace,
    tab: TabId,
    editor: TextEditor,
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

Subscribe with `language.subscribe()` and read `language.getSnapshot()` to update your UI. Wire Retry
to `provider.connect()` or `provider.reconnect()` and handle a rejected promise. On detach, call
`language.dispose()`. Dispose the editor separately. Release the clients before their provider.
[Feature commands](language-features.md) · [Embedding an editor](getting-started.md)

Custom handlers validate their own messages. This reader authorizes and captures the resource before
loading it, then checks the capture before replying.

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

Use `request`/`notify` to send custom messages and `onRequest`/`onNotification` to receive them.
Registrations survive reconnects. Pending calls expire. Use the removal function or dispose the
scope to unregister. Lifecycle, synchronization and reserved methods cannot be overridden.

## Contract

### Transport and session

`openWebSocketTransport` opens a browser `RpcTransport` with cancellation and a deadline. Send one
JSON value per ordered text message, without `Content-Length` headers. Binary messages close the
socket with `4003`, message or buffer overflow with `4009`. Disposal removes listeners, rejects a
pending open and requests closure. Even if the browser finishes the handshake, a disposed session
cannot initialize. Importing the module opens no socket.

`preProtocolMessage` sends raw text once after open and before the transport promise resolves. Omit
it to send nothing. An empty string sends an empty message. The adapter captures and validates it
before opening the socket and applies the usual send limits. Success means the send was queued. Put
any authentication reply or further handshake in the host connection factory.

`JsonRpcConnection` handles requests in both directions, notifications, bounded batches, cancellation
and deadlines. Each call has an ID, a result promise and `cancel()`. The connection accepts string,
null and safe-integer IDs. A notification gets no reply. A late success is ignored. An error with no
matching call goes to `onError`.

Raw `request`, `requestDocument` and `requestCommand` calls return immutable `JsonValue` snapshots,
including on session and workspace scopes. Validate the result for the method you called. A feature
client does this in its decoder. A generic type argument cannot supply that check.

Remove a handler with its removal function. Dispose the connection to release its transport, pending
calls and deadlines. If `notifyCancellation` suppresses a cancellation message, the call rejects
locally and releases its deadline. If the policy throws, `onError` receives the error and the
connection skips the message.

`RpcError` carries a numeric protocol `code`, message and optional JSON `data`. Remote error
responses reject their calls with this error; request handlers can throw it to supply a
structured error response. Cancellation, expiry and transport failures also reject pending
work, so callers must handle rejected results and release their captured intent.

`ProtocolDecodeError` means the provider sent malformed or unsupported data, including initialization
capabilities or feature results. Completion counts it as an invalid reply. Errors in host callbacks,
configuration and local edit planning keep their original types. `RpcError` carries the codes for
cancellation and expired captures.

If you don’t use a `Workspace`, create an `LspSession` with a connection factory and scheduler. Pass
immutable buffers to `bindDocument`. Keep the returned handles to submit expected-revision updates and
to close bindings. Close a binding before reusing its URI. An old handle cannot update the new
document.

`connect()` sends `initialize`, checks the negotiated UTF-16 encoding, sends `initialized` and
synchronizes eligible documents. To change connections but keep local bindings, call `disconnect()`.
To release the session, call `dispose()`. `LspWorkspace.dispose()` closes its connection directly.

For an orderly stop, call `LspSession.shutdown()` or `LspWorkspace.shutdown()` on a ready connection.
The workspace first synchronizes its participating documents. During shutdown/exit the client
refuses new requests and settles cancellations locally. Failure closes only the connection being
stopped. Local bindings and scopes survive. On reconnect, the new connection picks up edits made
during shutdown.

### Feature capability queries

`queryFeatureOptions(method, document)` returns immutable matching static and dynamic options. It
uses the same selectors, URI mapping, connection and synchronization checks as a request.
Disconnected, disposed, unmapped or failed bindings yield no options. Mapping errors propagate.

Pass a current `DocumentSnapshot` to `LspWorkspace`, matching resource, revision and buffer. For
`LspSession`, pass `{ uri, languageId }`. Querying options only reads metadata. Obtain a current
synchronized capture before issuing a request.

### Workspace ownership and synchronization

Create a scope with `LspWorkspace.createScope()`. Use `attachDocument(id)` for one document or
`setDocuments(snapshots)` for a project. Multiple views of a file share one workspace lease, observer,
protocol binding and stream of wire versions. Dispose the `LspDocument` to withdraw that participant.
After the last participant leaves, the client closes the binding and releases the lease after
notification delivery. Keep a project scope if closed panes should contribute files to rename or
navigation.

`LspScopeAccess` exposes scoped requests and host preparation callbacks. `scope.ensureConnected()`
starts or joins the shared connection. Cancelling your wait leaves other scopes connected.
`scope.cancel()` expires the scope’s requests and results but keeps bindings and handlers.
`scope.dispose()` also releases the handlers and document participation and is safe to repeat. Use the
owner to `disconnect()`, `reconnect()` or `shutdown()` the shared connection. Disposing the owner
closes every scope.

Keep the project scope open when restarting its provider.

```ts
import type { DocumentId } from "sttropez";
import type { LspWorkspace } from "sttropez/protocol";

export async function reconnectProject(provider: LspWorkspace, document: DocumentId) {
    const scope = provider.createScope();
    try {
        scope.attachDocument(document);
        await scope.ensureConnected();
        await provider.shutdown();
        await scope.ensureConnected();
    } finally {
        scope.dispose();
    }
}
```

Use `scope.captureBinding(binding)` to track a synchronized document without adding another
participant. The immutable `LspBindingCapture` exposes the captured binding as `document`.
`getSnapshot()` reads the current local Core snapshot, even with edits waiting to be sent. Local
revisions and scope request cancellation preserve the capture. After URI replacement, binding
closure, a connection or registration change, or scope disposal, the getter returns `undefined`.

A live binding alone cannot tell you whether completion offsets fit. To keep a completion across
typing, also check the operation and map the edit. Ordinary request captures check the revision
and the scope’s request.

URI identity is exact and opaque. `documentInfo` determines the URI/language pair when a document
joins. Replace participation or the provider explicitly when configuration changes. Local revision,
resource/document identity and wire version are separate. Local edits expire captures immediately;
their synchronization coalesces after workspace transaction delivery. Ordinary edits queue only
the changed document. Capability and connection changes reconcile the participating bindings.

The client opens a document only when static or matching dynamic capabilities cover both open/close
and incremental change. Losing that coverage closes the remote copy. Regaining it sends the current
full text. For later edits, the client sends proven transaction ranges in descending original-offset
order. If it skipped a revision, lacks a usable map, cannot prove a gap, or the batch would cost too
much to encode, it sends one replacement between the known shared edges. A transport failure leaves
the edit unsent or unacknowledged. The client does not retry it.

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

`flush()` waits for changes to reach the wire. Server analysis can finish later. Pass document handles
to wait for specific captures in a session or scope. A revision, binding or capability change rejects
that wait. Feature clients use it to skip unrelated files. `synchronized(handle)` returns the sent
snapshot, index and version, or `undefined`. `captureProject()` returns the scope’s synchronized URI
captures.

`requestDocument` waits for synchronization, supplies the bound URI and captures the binding,
revision, connection epoch and registration generation. Stale replies are refused. Its immutable
JSON result needs a feature decoder before presentation. `scope.isDocumentCurrent` also observes
workspace edits before deferred binding synchronization. `isBindingCurrent` allows revision changes
and does not establish range freshness. No capture or syntax cache grants edit authority.

### Capabilities and supported subset

`canRequest` checks the enabled methods against static and matching dynamic capabilities. Registration
and unregistration validate the entire batch, including unique IDs and exact methods.

Selectors can match language, scheme and a path glob (`*`, `?`, `**`, `**/`, brace alternatives,
ranges, negated classes or escaped literals). Matching uses bounded dynamic programming and rejects
unsupported forms. By default it decodes the URI path, keeps invalid percent escapes literal and
matches case sensitively. The URI itself stays unchanged. Supply `pathForUri` for another policy. If
it changes, rebind the document or reconnect.

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

A new feature request expires the previous result even if the text is unchanged. Cancelling settles
the request immediately, including a wait for host preparation. Host code may finish later. The client
ignores its reply, releases loaded targets and keeps synchronization bindings. Participation ends when
the next project omits the file, the client or host closes it, or a request fails. Releasing a
completed wire call leaves later calls alone.

Target lookup starts in the captured project. To load a missing URI, supply `resolveTarget` and a
release callback. The host authorizes each load. Recheck the project and loaded targets after
awaiting the result. See [target loading](language-features.md#navigation-and-target-loading).

### Commands and edit decisions

Enable `workspace/executeCommand` for command support and `applyEdit: true` for incoming edits.
A session advertising incoming edits requires a `workspace/applyEdit` handler before connecting;
the workspace owner supplies routing for feature scopes. `createLspCommandRunner(scope)` installs
the scoped decision handler. Supply captured project snapshots, `isCurrent`, optional preparation
and an explicit asynchronous review callback. Use `run` for advertised commands or `runAuthorized`
with a host-approved exact invocation route. Advertisement alone does not authorize execution.

Before preparation or synchronization, the runner copies the arguments and reserves the shared command
lane. A competing command or a lane waiting for reconnect cannot apply a preparation edit. Only the
active server command receives incoming edit requests. The runner refuses unsolicited or overlapping
requests. Host command handlers use their captured `applyEdit` callback under the same checks. Before
each approval, recheck the request, target identities and revisions, and host permissions.

`scope.requestCommand` also reserves this session-wide lane. For a host-defined status command
whose server contract guarantees it never sends `workspace/applyEdit`, a host can poll with
`scope.request("workspace/executeCommand", { command, arguments: [] })`. The host validates the
command and reply. If the poll times out, the edit lane keeps its current state.

See [workspace-edit previews](language-features.md#rename-and-workspace-edits) and
[applying a code action](language-features.md#code-actions-and-commands).

If you cancel before the server command is sent, the next command can use the lane immediately. After
sending, a cancellation, timeout or capability change can leave a late `workspace/applyEdit` with no
command ID to identify it. The runner then holds the lane until reconnect. Read `commandAvailable` and
`commandRequiresReconnect` to decide which control to show. Reading and typing work. A host-only
command that never contacts the server can fail or cancel without holding the lane. Reconnect never
replays a command or an edit. If the acknowledgement is lost after an edit, the edit stays in history.

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

Transport or batch-count overflow closes the connection. An oversized response rejects the identified
call and releases its deadline. A rejected batch rejects its identified calls together. Other calls
continue. The client can reuse frozen JSON it validated itself. It checks and copies all host JSON,
even frozen objects, and normalizes negative zero as JSON does. Decoding rechecks captures, versions,
bounds and overlap.

If encoding a document or matching its selector fails, the client closes that remote document and
calls `onError`. Other files stay usable. Requests for the failed capture reject with that error. A
corrected revision, capability change or reconnect lets the binding synchronize again. After a failed
connection or disconnect, call `connect()` or `reconnect()` from your Retry control. Repeating a
feature request won’t reconnect. Cleanup continues even if a deferred release or cancellation reports
an error to `onError`.

## Host responsibilities

Choose the endpoint, TLS/proxy and authentication policy, scheduler and limits. Keep URI mappings
stable, validate custom messages and authorize loads, navigation and commands. Show uncertain
diagnostic freshness and command outcomes. Let the user retry explicitly.

Capture the document, revision, view, selections and permissions before a request. Recheck them
after awaits and before committing. Cancellation leaves earlier edits in history. Schedule mutations
after workspace notifications. Release clients, scopes, target leases and handlers when their owner
closes.

## Not covered

See the [support matrix](README.md#support-matrix) for unsupported methods and provider qualification.
