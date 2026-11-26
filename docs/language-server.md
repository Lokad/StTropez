# Language server

`BrowserLspWorkspace` shares a connection across editor views. It uses LSP 3.17 over JSON-RPC 2.0,
with WebSocket text messages, UTF-16 positions and incremental synchronization.
[LSP specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
· [JSON-RPC specification](https://www.jsonrpc.org/specification)

## Use

Create one provider per workspace and server configuration. Give each participating document a URI
and language ID. Fetch credentials on each connection attempt.
[Text resources](workspace.md#identities-and-snapshots)

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

Attach features per pane. Dispose the attachment with its editor and the provider after its last
client. [Feature controls](language-features.md)

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

## Contract

### Transport and session

Pass the factory’s `AbortSignal` through credential lookup and transport opening. Disconnect,
disposal and the opening deadline cancel an attempt. The workspace closes a late transport. Each
WebSocket text message holds one JSON value. To send a preface before initialization, set
`preProtocolMessage` and handle any authentication reply in the factory.

| Provider call | Effect |
| --- | --- |
| `connect()` | Concurrent callers share initialization, UTF-16 negotiation and synchronization. |
| `disconnect()` | Pending calls expire. Bindings and scopes survive. |
| `reconnect()` | Opens a fresh connection and sends current text. |
| `shutdown()` | Synchronizes bindings, then sends shutdown/exit on a ready connection. Edits made while stopping join the next connection. |
| `dispose()` | Closes the connection and releases scopes, calls and bindings. |

For headless use supply a transport factory and a cancellable scheduler that defers zero-delay
callbacks. For direct buffers use `LspSession` from `sttropez/kernels`. Update each binding by
expected revision and close it before reusing its URI.

`JsonRpcConnection` owns its transport. It handles bidirectional calls, notifications and batches.
Cancellation releases the deadline and rejects the call. Validate custom results, which arrive as
immutable JSON. Feature clients decode theirs. `ProtocolDecodeError` identifies malformed or
unsupported data. Throw `RpcError` to return a structured protocol error.

### Feature capability queries

`initialize` advertises the supported methods and push diagnostics. Restrict them with `features` or
`diagnostics: false`. Inspect `getSnapshot().clientFeatures` for the advertised set.

`canRequest` checks static capabilities and matching registrations.
`queryFeatureOptions(method, document)` returns their options. Pass the current document snapshot on
a workspace or `{ uri, languageId }` on a session. Use `requestDocument` for synchronized text.
Prepare-rename requires `prepareProvider: true`.

### Workspace ownership and synchronization

Use `scope.attachDocument(id)` for a pane or `setDocuments(snapshots)` for a project. Views share a
binding and lease per document. Keep a project scope for files that should participate after their
panes close. The last owner closes the binding. `scope.cancel()` expires requests. `scope.dispose()`
also releases documents and handlers.

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

`DocumentSnapshot.language` supplies the exact URI and language ID. Changing either expires replies.
Reattach to open the new identity. Local revisions and wire versions are distinct. URI reuse within a
connection advances the wire version.

A document needs open/close and incremental-change capabilities. Withdrawing coverage closes its
remote copy. Regaining it sends current text. A local edit expires request captures before
synchronization. Sparse updates send descending previous-revision ranges. Dense updates can send one
spanning range.

| Operation | Guarantee |
| --- | --- |
| `flush(handles)` | Captured changes reached the wire. A changed revision, binding or sync capability rejects the wait. Server analysis can finish later. |
| `synchronized(handle)` / `captureProject()` | Read a sent snapshot, index and wire version, or collect synchronized captures by URI. |
| `requestDocument` | Flushes and ties a request to a binding, revision and relevant registrations. |
| `scope.captureBinding(binding, method?)` | Observes local text without retaining the binding. Its snapshot expires on closure, replacement, reconnect, relevant registration change or scope disposal. |
| `isBindingCurrent` | Checks identity across edits. Reusing a range also requires checking or mapping its revision. |

`LspLineIndex` preserves LF, CRLF and bare CR. `at` rejects the interior of CRLF. `offsetAt` clamps
columns past line end and lines past EOF.

### Capabilities and supported subset

The generic WebSocket fixture runs against `vscode-languageserver-protocol` 3.17.5 as a development
dependency. StTropez’s runtime has zero third-party dependencies.
[Fixture peer](../tests/fixtures/protocol/reference-peer.ts)

| Feature | Supported subset |
| --- | --- |
| Session | Initialization, static and dynamic capabilities, incremental synchronization, cancellation and reconnect. |
| Diagnostics and completion | Pushed diagnostics, completion filtering, lazy resolution and supported snippets. [Diagnostics](language-features.md#diagnostics) · [Completion](language-features.md#completion) |
| Hover and navigation | Hover, definitions, references and host-authorized target loading. [Navigation](language-features.md#navigation-and-target-loading) |
| Rename and code actions | Prepare-rename, workspace text edits, atomic Undo, action literals, edit resolution and authorized commands. [Rename](language-features.md#rename-and-workspace-edits) · [Code actions](language-features.md#code-actions-and-commands) |
| Other requests | Signature help, links, colors, folding and symbol occurrences. [Language features](language-features.md) · [Folding](folding.md) |

Registrations validate as a batch. Selectors match language, URI scheme and decoded path, with
case-sensitive globs by default. Use `pathForUri` for custom paths. Rebind or reconnect when the
mapping changes. Authorize and load out-of-project URIs with `resolveTarget`. Identity is rechecked
after loading.

Use `scope.request` and `notify` for custom messages. Register handlers with `onRequest` or
`onNotification`. They survive reconnect until removal or scope disposal. The client reserves
lifecycle and synchronization methods. Authorize both request and resource in a handler.

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

### Commands and edit decisions

Show `provider.commandNames()` while `commandAvailable` is true. Discard choices on disconnect, loss
of availability or a change to `registrationVersion("workspace/executeCommand")`.

Set `workspaceEdits: true` for transactional text edits, or `applyEdit: true` to also receive edits
during a command. Use `reviewCommandEdit` on the feature running it. A bare `LspSession` needs its
own `workspace/applyEdit` handler before connect.
[Command review](language-features.md#code-actions-and-commands)

For headless use, `createLspCommandRunner(scope)` takes project snapshots, a freshness check and a
review callback at invocation. Use `run` for advertised commands or `runAuthorized` for an exact host
grant. Both reserve one command on the connection. Check resources, revisions and permissions before
accepting an incoming edit. Overlapping and unsolicited edits are refused.

Use `runner.sync(scope, prepare)` for a synchronized extension request. For raw command review, send
through `scope.reserveCommand(handler)` and release it in `finally`. An independent status call via
`scope.request` requires a server guarantee that the command sends no edits.

**Check `commandRequiresReconnect` after an interrupted command.** Cancelling before send frees the
reservation. After send, a late edit has no command ID. A connection can be `ready` for editing while
further commands need a reconnect. Offer `provider.reconnect()`, then require a fresh choice.
Committed edits stay in Undo history.

### Limits and failures

Sizes count UTF-16 units unless indicated. Allow for JSON escaping on the wire. The
[editor support envelope](README.md#support-matrix) applies separately.

| Boundary | Default or fixed limit |
| --- | --- |
| Documents and scopes | 100 documents, 3 Mi units per file, 16 Mi total, 128 scopes. |
| Registrations | 128, with 64 Ki units of options each and 1 Mi aggregate. |
| Synchronization and RPC | 128 sync waits. 64 outgoing and 64 incoming calls. Queued document calls share the outgoing limit. |
| Deadlines | 15 seconds for RPC and opening. Command runner requests use 120 seconds. |
| Transport | 4 Mi units per RPC or WebSocket message, 16 MiB estimated UTF-8 queued output. Binary input closes with 4003, transport overflow with 4009. |
| JSON | 64 levels, 128 elements per batch. `rpc.maxJsonNodes` defaults to `rpc.maxMessageUnits`. Detached host snapshots allow 100,000 plain JSON values. |
| Selectors | 32 filters, 256 units per pattern, 16 alternatives totaling 1,024 units, 4,096-unit path. |
| Commands | 128 names per provider or registration, 256 distinct names combined, 256 units per name, 8,192 units of JSON arguments. |
| Scheduling | Synchronization yields after 4 ms or 32 checkpoints across files. Encoding and sending one message run synchronously. |

An encoding or selector failure closes that file’s remote copy and reports to `onError`. Correct the
revision, change capabilities or reconnect to resynchronize it. A transport failure leaves delivery
uncertain.

## Host responsibilities

Supply authentication, transport settings and limits. Authorize URIs and commands, validate custom
messages and present edit reviews. Retain the intended document and view across awaits. Release
scopes, handlers and target leases on detach.

## Not covered

The [support matrix](README.md#support-matrix) lists unsupported methods and host-provider
qualification.
