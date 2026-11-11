# Public editor integration

`sttropez/protocol` exports `LspWorkspace`, `createLspHoverClient`,
`createLspNavigationClient`, `createLspRenameClient`, `createLspActionClient`,
`createLspSignatureClient`, `createLspLinkClient`, `createLspColorClient` and
`createLspCommandRunner`. `sttropez/browser` exports `createLspEditor` for a mounted
editing candidate. They share the existing session, synchronized documents and
diagnostics. Both development hosts use these implementations; their small wrappers
retain fixture configuration, counters and application controls.

Create one provider owner per Workspace/provider configuration. Supply its connection
factory, cancellable future-turn scheduler and `documentInfo(snapshot)` URI/language
mapping. Endpoints, credentials and resource selection belong to the host. Construction
opens no socket. `createLspEditor(workspace, tab, editor, { provider, autoConnect: false })`
attaches one view; call `connect()` explicitly or enable its default automatic connection.
Imports start no network work. Runtime dependencies remain zero.

The editor controller exposes a stable observable `state`, manual `request()`,
`chooseCompletion(index)`, `apply("insert" | "replace")`, `cancel()` and
`selectDiagnostic(index)`. Its immutable snapshots describe choices and diagnostic
presentation. Hosts render controls through their own UI system. Captured tab/view,
selection, folding, input readiness, document revision, provider generation and authority
checks stay in the controller. Completion application uses the existing shared history.
`destroy()` detaches this controller and its subscriptions/requests without disposing
the editor view or the shared provider. Disposed controllers accept no new subscriptions.

Feature clients take that same owner. Their `state` observes provider capabilities;
request results are immutable models with currentness guards. `cancel()` or `dispose()`
expires that client's work. Other clients retain their connection and participation.

| Client | Request/result |
| --- | --- |
| Hover | `run(documentSnapshot, offset, prepare?)` returns a cancellable call with literal text, optional range and a currentness guard. |
| Navigation | `run(snapshots, originId, offset, "definition" or "references", includeDeclaration?, prepare?)` returns exact validated targets and a batch guard. |
| Rename | `run(snapshots, originId, offset, newName, prepare?)` returns a complete validated workspace text-edit preview. |
| Actions | `run(snapshots, originId, from, to, prepare?)` returns choices, supported-command/currentness checks and captured `resolve`/`execute` methods. |
| Signature | `run(document, offset, context?, prepare?)` returns a cancellable call with active signature/parameter models, literal documentation and a currentness guard. |
| Links | `run(document, prepare?)` returns validated items, currentness and explicit captured item `resolve`. Opening belongs to the host. |
| Colors | `run(document, prepare?)` returns validated items, currentness and captured `presentations(item, rgba, prepare?)`. The host previews and applies the selected edits. |

Project snapshots must still match their Workspace resource, document, revision and
buffer. URI resolution uses those explicitly participating host resources, including
unmounted targets. No server URI is automatically fetched or opened. The host chooses
navigation/opening policy and rechecks currentness and resource authority before an
edit decision. Existing `Workspace.editDocuments` applies a complete authorized batch
as one shared undo transaction. The library supplies validated plans and request lifetime;
application review controls, resource loading and edit authorization belong to the host.

Optional `prepare` callbacks run inside the captured request lifetime and receive
the scoped custom-message API. No fixture messages, faults, delays or language IDs
are embedded in these clients. Custom request handlers expire their context and settle
with cancellation when their feature scope closes, including a still-pending host handler.
Host-defined message schemas and document authority still need host validation.

`createLspCommandRunner(scope)` takes captured project/currentness, optional preparation
and explicit review callbacks. Use a provider configured with `applyEdit: true` for this
review path. The runner snapshots bounded arguments and reserves the provider command
lane before preparation or synchronization. A competing or quarantined command cannot
apply an initial preparation edit. Cancellation before sending releases the reservation;
after sending it requires a fresh connection before another command. Incoming edits are
routed only after the command was sent. The host never loses an already committed phase
automatically. Further details are in the [server-edit contract](lsp-server-edits.md).

Dispose clients/controllers at their view or feature boundary, then dispose the shared
provider at the workspace/configuration boundary. Destroy the mounted editor separately.
An owner disconnect/reconnect expires old results across its features and reopens each
current participating document once; it never replays edits or commands. Provider size,
document, request and scope bounds remain [explicit](lsp.md).

`npm run test:package:lsp` restores the assets-only NuGet package into an isolated
consumer, checks its public declarations and bundles a minimal plain TypeScript host.
That host imports no example controller, React package or library source. It mounts an
editor and exercises the actual WebSocket provider through these exports, including
additional completion edits, undo, inspection/navigation, rename, action resolution, signature help,
link resolution and color presentation/application
and final disposal. The separate host suites cover their richer review/Save/Run UI.
This boundary test does not establish native IME/OS clipboard or full LSP compatibility.
Automatic completion uses the same public controller: prefix/advertised-trigger invocation,
compatible filtering, incomplete refresh, selected-item resolve and keyboard/commit acceptance.
The [completion contract](lsp-editor.md) defines exact rebasing, pending-resolution input policy
and generation IDs for retained host controls. [Signature/link/color contracts](lsp-language.md)
describe their capability, validation and host-policy boundaries. Owner snapshots supply actual
connection/open/change/close accounting; feature adapters report their own intent state.
