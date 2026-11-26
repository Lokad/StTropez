# Language server

`BrowserLspWorkspace` shares a language-server connection across editor views. It sends incremental
edits and validates replies. The supported subset uses UTF-16 positions and ordered WebSocket text
messages. [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) · [JSON-RPC 2.0](https://www.jsonrpc.org/specification)

## Use

Create one provider per workspace and server configuration. Give each participating document a URI
and language ID. Fetch credentials on each connection attempt. [Text resources](workspace.md#identities-and-snapshots)

```ts
import type { Workspace } from "sttropez";
import { BrowserLspWorkspace, openWebSocketTransport } from "sttropez/browser";

type ConnectionSettings = Readonly<{
    url: string;
    protocols?: string | readonly string[];
    preProtocolMessage?: string;
}>;

export function createLanguageProvider(
    workspace: Workspace,
    settings: (signal: AbortSignal) => Promise<ConnectionSettings>,
    onError: (error: Error) => void
) {
    return new BrowserLspWorkspace(workspace, {
        onError,
        async connect(signal) {
            const connection = await settings(signal);
            return openWebSocketTransport(connection.url, { ...connection, signal });
        }
    });
}
```

Attach the features a pane uses. This example connects completion explicitly.

```ts
import { attachEditorLanguage, type TextEditor } from "sttropez/browser";
import type { LspWorkspace } from "sttropez/protocol";

export function attachLanguage(
    editor: TextEditor,
    provider: LspWorkspace,
    onError: (error: unknown) => void
) {
    const language = attachEditorLanguage(editor, provider, { completion: { autoConnect: false, onError } });
    language.completion.connect();
    return language;
}
```

For a custom completion list, subscribe to `language.completion` and read its snapshot.
Dispose the attachment and editor on unmount, and the provider after its last client.
[Feature commands](language-features.md) · [Embedding an editor](getting-started.md)

A custom handler validates its input. Here `read` authorizes the resource before loading it.
Both the resource and the request must remain current.

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

Send a custom request with `scope.request(method, params)`. Its handle exposes `result` and `cancel()`.
Use `notify` for one-way messages and `onRequest` or `onNotification` to receive them. Registration
survives reconnect. Use the returned removal function or dispose the scope to unregister. The client
reserves lifecycle and synchronization methods.

## Contract

### Transport and session

`BrowserLspWorkspace` gives each connection factory a fresh `AbortSignal`. Pass it through credential
lookup and `openWebSocketTransport`. Disconnect, disposal and the opening deadline abort the factory.
The workspace closes a transport that arrives late. For a headless `LspWorkspace` supply a scheduler
that defers even zero-delay callbacks and returns a cancellation function.

Send one JSON value per WebSocket text message without `Content-Length` framing. Binary input
closes the socket with code 4003, overflow with 4009. Disposal rejects a pending open and closes
the socket. Optional `preProtocolMessage` queues raw text once on open, under the same limits.
An empty string sends an empty message. Handle authentication replies in the factory.

| Provider operation | Effect |
| --- | --- |
| `connect()` | Initializes the server, checks its position encoding, sends `initialized` and synchronizes eligible files. Concurrent openings share the attempt. |
| `disconnect()` | Closes the connection. Pending calls expire. Local bindings and scopes survive. |
| `reconnect()` | Opens a fresh connection with the current document text. A Retry control can call this or call `connect()` after disconnect. Handle a rejected attempt. |
| `shutdown()` | Synchronizes workspace bindings and sends shutdown/exit on a ready connection. During shutdown new requests are refused. Failure closes that connection. Edits made while stopping join the next connection. |
| `dispose()` | Closes the connection and releases the provider's scopes, pending work and bindings. |

For direct buffers, give `LspSession` in `sttropez/kernels` a transport factory and scheduler.
Update each `bindDocument` handle by expected revision. Close it before reusing its URI.

`JsonRpcConnection` owns its transport and handles requests in both directions, notifications and
batches. It accepts string, safe-integer and null IDs, ignores late successes and reports unmatched
errors to `onError`. Cancellation rejects the call and releases its deadline even if
`notifyCancellation` suppresses the outgoing message. A throwing policy reports to `onError`.

Raw `request`, `requestDocument` and `requestCommand` results are immutable `JsonValue` snapshots.
Validate custom results for their method. The feature clients supply their own decoders.
`ProtocolDecodeError` identifies malformed or unsupported provider data. `RpcError` carries a protocol
code, message and optional JSON `data`. Handlers can throw it to return a structured error.
Handle cancellation, expiry and transport rejection. Host callback and local planning errors keep
their original types.

### Feature capability queries

By default `initialize` advertises the supported methods and pushed diagnostics. Use `features`
to restrict methods or `diagnostics: false` to omit diagnostics. Read the advertised set in
`getSnapshot().clientFeatures`. A pane can attach a controller after negotiation.

`canRequest` checks static capabilities and matching registrations. `queryFeatureOptions(method, document)` returns their immutable options. On a workspace pass the current `DocumentSnapshot`
(resource, revision and buffer). On a session pass `{ uri, languageId }`. A disconnected, disposed,
unmapped or failed binding yields no options. Mapping errors propagate. Querying reads metadata.
Use `requestDocument` for a synchronized request. Prepare-rename requires a matching rename
provider with `prepareProvider: true`.

### Workspace ownership and synchronization

Use `createScope()` and `attachDocument(id)` for one document or `setDocuments(snapshots)` for a
project. Views of the same file share its lease, observer, binding and wire versions. Disposing the
last participant closes the binding and releases the lease after notification delivery. Keep a project
scope open if closed panes should participate in rename or navigation.

`scope.ensureConnected()` starts or joins a connection. `scope.cancel()` expires requests and results.
`scope.dispose()` also releases handlers and documents. The provider owns disconnect and shutdown.
This project keeps its binding across a restart.

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

The binding uses the exact URI and language ID in `DocumentSnapshot.language`. Files without that
pair stay local. Changing either field expires the binding and its replies immediately. Attach again
to open the new identity. Local revisions, document IDs, resource IDs and wire versions are separate.
Wire versions increase across opens and changes on one connection, including URI reuse.

A document needs both open/close and incremental-change support through static or matching dynamic
capabilities. Losing coverage closes the remote copy. Regaining it sends current full text. A local
edit expires request captures immediately and queues that file for synchronization after transaction
delivery. Connection or capability changes reconcile all participating files.

Workspace bindings consume `DocumentChange.edits`. Direct bindings accept previous-revision edits in
`document.update(expectedRevision, revision, buffer, edits)`. Sparse edits use descending ranges.
Dense changes or missing edit history can use one spanning range. If encoding exceeds a local limit,
the client tries the other representation when available. A transport failure makes delivery
uncertain and stops retries.

| Operation | What it establishes |
| --- | --- |
| `flush(handles)` | Waits for those captured changes to reach the wire. A revision, binding or synchronization-capability change rejects the wait. Server analysis may finish later. |
| `synchronized(handle)` | Returns the sent snapshot, index and version, or `undefined`. |
| `captureProject()` | Collects synchronized captures by URI for the scope. |
| `requestDocument` | Flushes the document, supplies its URI and captures its revision, binding, connection and relevant registrations. Unrelated registrations can change. `scope.isDocumentCurrent` observes local changes before synchronization. |
| `scope.captureBinding(binding, method?)` | Tracks a synchronized binding without joining it. Its `getSnapshot()` reads local text across typing and scope cancellation. It returns `undefined` after closure, replacement, reconnect, relevant registration changes or scope disposal. |
| `isBindingCurrent` | Checks binding identity across revisions. Reusing a text range after typing also requires checking the operation and mapping the range. |

`LspLineIndex.create(buffer, cooperate)` preserves LF, CRLF and bare CR. `at` rejects invalid
offsets, including the interior of CRLF. `offsetAt` rejects malformed positions, clamps columns to
line end and maps lines beyond EOF to EOF. `change` produces a new index and edits with boundaries
outside CRLF pairs. Indexing and change planning yield. Dense bare-CR indexes can require linear copying.
[Measurement glossary](README.md#glossary)

### Capabilities and supported subset

Dynamic registration and unregistration validate the whole batch, including unique IDs and exact
methods. Selectors match language, URI scheme and path. Globs support `*`, `?`, `**`, `**/`,
brace alternatives, ranges, negated classes and escaped literals. Matching is bounded and
case-sensitive by default. It decodes paths, preserves invalid percent escapes and leaves the URI
itself unchanged. Supply `pathForUri` to customize the path. Rebind or reconnect if its mapping changes.

| Area | Supported behavior |
| --- | --- |
| Lifecycle and synchronization | Initialization, UTF-16 negotiation, incremental open/change/close, cancellation, dynamic registration and explicit reconnect |
| Diagnostics and completion | Versioned or uncertain diagnostics, completion filtering, lazy resolution and supported snippets. [Diagnostics](language-features.md#diagnostics) · [Completion](language-features.md#completion) |
| Hover and navigation | Format-preserving hover, definitions, references and captured target loading. [Hover](language-features.md#hover-and-documentation) · [Navigation](language-features.md#navigation-and-target-loading) |
| Rename and workspace text edits | URI, range and version validation for the whole edit, previews and atomic shared history. [Rename and edits](language-features.md#rename-and-workspace-edits) |
| Code actions | Literals and commands, disabled and preferred choices, lazy edit resolution and authorized commands. [Code actions](language-features.md#code-actions-and-commands) |
| Workspace commands and server edits | Advertised commands, exact host grants and review of incoming edits. [Command decisions](#commands-and-edit-decisions) |
| Signature, links and colors | Signature context, link discovery and resolution, colors and color presentations. [Feature controls](language-features.md) |
| Folding and occurrences | Whole-line folds grouped by kind, text/read/write occurrences and visible-row queries. [Folding](folding.md) · [Occurrences](language-features.md#occurrences) |
| Extensions | Host-defined URIs, removable custom handlers, connection settings and request preparation |

A new feature request expires its previous result. Preparation receives `LspScopeAccess` to flush
documents, read command names and make custom requests. Cancelling also cancels those requests and
releases loaded targets. Supply `resolveTarget` to authorize and load a URI outside the captured
project. The provider rechecks its identity after loading. [Target loading](language-features.md#navigation-and-target-loading)

### Commands and edit decisions

Build the menu from `provider.commandNames()` when `getSnapshot().commandAvailable` is true.
Discard choices on disconnect, loss of availability or a change in
`registrationVersion("workspace/executeCommand")`. Ask for a fresh choice from the new list.

Set `workspaceEdits: true` to advertise transactional text edits. To receive `workspace/applyEdit`
during a command, set `applyEdit: true`, which also enables workspace edits. `BrowserLspWorkspace`
and `LspWorkspace` install the request handler and route edits to the active command. Supply
`reviewCommandEdit` on the editor feature that runs it. A bare `LspSession` requires its own
`workspace/applyEdit` handler before `connect()`. [Reviewing command edits](language-features.md#code-actions-and-commands)

For headless review, use `createLspCommandRunner(scope)`. Supply project snapshots, `isCurrent`
and an asynchronous `review` callback. Use `run` for advertised commands and `runAuthorized`
for an exact host-approved route.
Both copy the arguments and reserve the connection for one command before preparation. Only its
incoming edits are eligible for review. Overlapping and unsolicited edits are refused. Local routes
use their captured `applyEdit` callback. Check target identities, revisions and permissions before
approval. Resolve targets outside the captured project even if another feature has them open.
[Workspace edit previews](language-features.md#rename-and-workspace-edits)

Use `runner.sync(scope, prepare)` for a custom request that needs synchronized documents. It
rechecks the project and established connection before synchronization and around `prepare`.
A stale capture reports `ContentModified`. For raw commands, `scope.requestCommand` reserves the
connection. To review edits, use `scope.reserveCommand(handler)`, send through its `requestCommand`
and `release()` in `finally`. For an authorized status command whose server guarantees it sends no
edits, `scope.request("workspace/executeCommand", { command, arguments: [] })` can poll independently.
Validate its result. A timeout on this path leaves the edit reservation alone.

Cancellation before sending releases the reservation immediately. After sending, cancellation, expiry
or a capability change may leave an unacknowledged command. A late edit carries no command ID.
The workspace then sets `commandRequiresReconnect` even while its phase is `ready`. Keep reading and
typing available, disable execution and offer `provider.reconnect()`. After reconnect, execute only
a fresh choice. Committed edits stay in Undo history even if their acknowledgement is lost.

### Limits and failures

Sizes count UTF-16 units except where marked. Allow for JSON escaping in wire budgets.

| Boundary | Default or fixed limit |
| --- | --- |
| Session documents | 100 (`maxDocuments`) |
| Bound text | 3 Mi units per document, 16 Mi total (`maxDocumentUnits` and `maxTotalUnits`) |
| Workspace scopes | 128 (`maxScopes`) |
| Dynamic registrations | 128 registrations, 64 Ki option units each, 1 Mi aggregate |
| Synchronization waits | 128 |
| Pending RPC calls | 64 outgoing and 64 incoming (`rpc.maxPending`). Queued document calls share the outgoing limit. |
| RPC request / opening deadline | 15 seconds by default. Command runner requests use 120 seconds. |
| RPC / WebSocket message | 4 Mi units each (`rpc.maxMessageUnits` and transport `maxMessageUnits`) |
| Wire JSON | 64 nesting levels. `rpc.maxJsonNodes` defaults to `rpc.maxMessageUnits`. |
| RPC batches | 128 elements |
| Host JSON snapshots | 100,000 finite plain JSON values, without accessors |
| WebSocket queued output | 16 MiB estimated UTF-8 (`maxBufferedBytes`) |
| Selectors | 32 filters, 256 units per pattern, 16 expanded alternatives totaling at most 1,024 units, 4,096-unit path |
| Commands | 128 names per provider or registration, 256-unit names, 256 distinct names combined, 8,192 JSON units per argument array |
| Synchronization and unopened-target indexing | Yield after 4 ms or 32 checkpoints. The optional `now` clock defaults to `Date.now`. |

Synchronization shares its scheduling budget across queued files. Encoding and sending one message
are synchronous. Transport or batch-count overflow closes the connection. An oversized response
rejects the identified call. A rejected batch settles its identified calls together. Other calls
continue. The codec copies and validates host JSON, including frozen objects, and normalizes
negative zero.

A document encoding or selector failure closes the remote copy and reports to `onError`. Requests
for that capture reject. Other files remain usable. A corrected revision, a synchronization
capability change or reconnect lets that binding synchronize again.

## Host responsibilities

Choose the endpoint, authentication, TLS/proxy settings and limits. Authorize URIs, custom messages,
navigation and command invocations. Present uncertain diagnostics, edit decisions and retry controls.
Capture the document, revision, view, selections and permissions an asynchronous action depends on.
Recheck before committing and schedule mutations after workspace notification delivery. Release
clients, scopes, target leases and handlers when their owners close.

## Not covered

See the [support matrix](README.md#support-matrix) for unsupported methods and provider qualification.
