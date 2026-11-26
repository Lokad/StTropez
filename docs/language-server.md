# Language server

`BrowserLspWorkspace` shares an LSP 3.17 connection across panes. It uses JSON-RPC 2.0 WebSocket text
messages, incremental sync and UTF-16 positions.
[LSP](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) ·
[JSON-RPC](https://www.jsonrpc.org/specification)

## Use

Create one provider per workspace and server configuration. Set each document’s URI and language ID. Fetch
credentials on each connection.

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

Attach features per pane. Dispose the attachment with its editor, then the provider after its last client.
[Feature controls](language-features.md)

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

Pass the factory’s `AbortSignal` to credential lookup and transport opening. Disconnect, disposal or
deadline cancels the attempt. The workspace closes late transports. Each WebSocket text message carries one
JSON value. For authentication before initialization, set `preProtocolMessage` and handle the reply in the
factory.

Concurrent `connect()` calls share initialization, UTF-16 negotiation and synchronization. `disconnect()`
expires calls and keeps scopes and bindings. `reconnect()` sends current text. `shutdown()` synchronizes,
then sends shutdown/exit when ready. Edits during shutdown join the next connection. `dispose()` releases
the connection, calls, scopes and bindings.

Headless clients supply transport and a cancellable scheduler that defers zero-delay callbacks. For direct
buffers, use `LspSession` from `sttropez/kernels`. Update bindings by expected revision and close before URI
reuse.

`JsonRpcConnection` owns the transport and supports bidirectional calls, notifications and batches.
Cancellation rejects the call and releases its deadline. Validate immutable custom JSON results. Feature
decoders throw `ProtocolDecodeError` for malformed or unsupported data. Throw `RpcError` to return a
structured error.

### Feature capability queries

`initialize` advertises supported methods and push diagnostics. Restrict with `features` or
`diagnostics: false`. Inspect `getSnapshot().clientFeatures`. `canRequest` checks static capabilities and
matching registrations. `queryFeatureOptions(method, document)` returns options. Pass a workspace document
snapshot or a session’s `{ uri, languageId }`. `requestDocument` synchronizes text. Prepare-rename requires
`prepareProvider: true`.

### Workspace ownership and synchronization

`scope.attachDocument(id)` retains one document. `setDocuments(snapshots)` retains a project, including
files with closed panes. Owners share one binding and lease per document. The last release closes it.
`scope.cancel()` expires requests. `scope.dispose()` releases documents and handlers too.

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

Changing the URI or language ID expires replies. Reattach to open the new identity. Wire versions advance
across URI reuse on one connection and are distinct from local revisions. Loss of open/close or
incremental-change coverage closes the remote copy. Regaining coverage sends current text. Edits expire
requests before sync. Sparse updates send descending previous-revision ranges, dense updates can send one
spanning range.

| Call | Guarantee |
| --- | --- |
| `flush(handles)` | Captured changes reached the wire. Changed revision, binding or sync capability rejects the wait. Analysis may follow. |
| `synchronized(handle)`, `captureProject()` | Sent snapshot, line index and version for one binding, or synchronized captures by URI. |
| `requestDocument` | Flushes and checks binding, revision and relevant registrations. |
| `scope.captureBinding(binding, method?)` | Observes local text without retaining it. Closure, replacement, reconnect, relevant registration change or scope disposal expires the snapshot. |
| `isBindingCurrent` | Checks identity across edits. Check or map the revision to reuse a range. |

`LspLineIndex` preserves LF, CRLF and bare CR. `at` rejects a position inside CRLF. `offsetAt` clamps
columns to line end and lines to EOF.

### Capabilities and supported subset

The [WebSocket fixture](../tests/fixtures/protocol/reference-peer.ts) uses `vscode-languageserver-protocol`
3.17.5 as its development reference. The runtime has zero third-party dependencies.

The client supports initialization, capability negotiation and dynamic registration, incremental sync,
cancellation and reconnect. Features include pushed diagnostics, completion and resolve, hover, definitions,
references, prepare-rename, workspace text edits, code actions, authorized commands, signature help, links,
colors, folds and occurrences. [Feature contracts](language-features.md) · [Folding](folding.md)

Registrations validate as a batch. Selectors use language, URI scheme and decoded path, with case-sensitive
globs by default. For host URI paths use `pathForUri` and rebind or reconnect when it changes.
`resolveTarget` authorizes and loads out-of-project URIs. Identity is rechecked after loading.

Use `scope.request` and `notify` for custom messages. `onRequest` and `onNotification` survive reconnect
until removed or disposed. Lifecycle and sync methods are reserved. Authorize the request and resource.

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

Show `provider.commandNames()` while `commandAvailable`. Discard choices on disconnect, loss of availability
or a change to `registrationVersion("workspace/executeCommand")`.

`workspaceEdits: true` enables transactional text edits. `applyEdit: true` also receives edits during a
command. Supply `reviewCommandEdit` on its feature. A bare `LspSession` needs a `workspace/applyEdit`
handler before connect. [Command review](language-features.md#code-actions-and-commands)

`createLspCommandRunner(scope)` takes project snapshots, a freshness check and review callback at
invocation. `run` requires an advertised command, `runAuthorized` an exact host grant. Both reserve one
command per connection. Check resources, revisions and permissions before accepting edits. Overlapping or
unsolicited edits are refused.

Use `runner.sync(scope, prepare)` for synchronized extensions. For raw review, release
`scope.reserveCommand(handler)` in `finally`. Use `scope.request` independently only if the server
guarantees the command sends no edits.

Moving the caret preserves standalone commands. Cancelling before send frees the reservation. After send,
edits lack a command ID. StTropez declines them until the matching reply arrives. While
`commandRequiresReconnect` is true, wait or call `provider.reconnect()` for a fresh command. Earlier edits
remain undoable.

### Limits and failures

Limits use UTF-16 units unless marked otherwise. Account for JSON escaping. The
[editor document limit](README.md#support-matrix) applies separately.

| Boundary | Limits |
| --- | --- |
| Workspace | 100 documents, 3 Mi units/file, 16 Mi total, 128 scopes |
| Registrations | 128, 64 Ki units of options each, 1 Mi aggregate |
| Concurrent work | 128 sync waits, 64 outgoing and 64 incoming RPCs. Queued document calls share the outgoing limit. |
| Deadlines | 15 s for opening and RPC, 120 s for command runner requests |
| Transport | 4 Mi units/message, 16 MiB estimated UTF-8 queued. Binary input closes with 4003, overflow with 4009. |
| JSON | Depth 64, batch length 128. `rpc.maxJsonNodes` defaults to `rpc.maxMessageUnits`. Detached host snapshots allow 100,000 plain values. |
| Selectors | 32 filters, 256 units/pattern, 16 alternatives totaling 1,024 units, 4,096-unit path |
| Commands | 128 names/provider or registration, 256 distinct combined, 256 units/name, 8,192 units of JSON arguments |
| Sync | Yields after 4 ms or 32 checkpoints across files. Encoding and sending one message are synchronous. |

Encoding or selector failures close the affected remote copy and call `onError`. Correct the revision,
change capabilities or reconnect to resync. Delivery is uncertain after transport failure.

## Host responsibilities

Supply credentials, transport settings and limits. Authorize URIs and commands, validate custom messages and
review edits. Retain request targets across awaits. Release scopes, handlers and leases on detach.

## Not covered

[Unsupported methods and provider qualification](README.md#support-matrix)
