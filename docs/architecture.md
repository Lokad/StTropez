# Architecture

## Boundaries

The editor is an embeddable part of a workspace. It does not own accounts, authentication,
network clients, persistence, connection execution, application routing or an extension host.
The headless model owns editing decisions. The browser view translates native input into
transactions and projects the current document into DOM. Hosts render tabs, menus, forms,
job status, data previews and connection configuration.

Documents use an immutable indexed piece tree with bounded shared history. Snapshots expose a
buffer for range reads and a lazy string export for host services/native views. The native input
adapter derives range changes from whole values and maps independent view selections, including
LF display coordinates over preserved CRLF. It still performs document-sized rendering/diff work.
See [the storage decision](text-storage.md) and [history/view contracts](history.md); this baseline
does not qualify the production renderer or native-device input.
The separate [bounded editing candidate](editing-candidate.md) maps a small native context to
range transactions and uses local native glyph rectangles over the [viewport](viewport.md).
It preserves the same identities, selections and history, while leaving long contextual-line
geometry and native-device qualification open.
The [comparison controller](comparison.md) captures an independent reference buffer/version
and one working tab. Refresh and acceptance advance the reference through captured tickets;
they never implicitly save the working resource. Browser panes reuse the same buffer/view
contracts and release their reference display resources on refresh or teardown.

## Identity and asynchronous work

| Identity | Meaning | Lifetime |
| --- | --- | --- |
| Resource key | Opaque scope, resource and variant tuple | Host-defined; paths and titles are labels |
| Resource ID | One text or typed non-text resource handle | Until explicitly released; never reused |
| Document ID | One in-memory buffer and revision sequence | Until explicitly released |
| Tab ID | One opened workspace surface | Until closed; moving it preserves identity |
| Tab generation | The surface currently occupying a tab | Changes when its contents are replaced |
| View instance | One DOM mount, selection and scroll position | Until unmounted; not the document lifetime |
| Request ID | One pending operation | Until completed, cancelled or superseded |
| Proposal revision | One offered change against a specified baseline | Until explicitly acknowledged or retired |

The scaffold implements resource/document/tab/generation identities, guarded operations,
save receipts, captured Run inputs and versioned agent association/proposal/acknowledgement.
Shared history survives tab/view lifecycles. Stable document-view handles map selections across
edits while mounted or detached; scroll remains separate browser/host state.

Text and typed non-text handles share loading/ready/failed/released states, metadata,
capabilities and revision checks. A panel refers to a resource ID and requires no text document.
The host supplies plain typed form snapshots, schemas and validation; the workspace copies and
freezes the supplied values without interpreting them. Related connection, transfer and
historical-run resources may have independent IDs. See [resource contracts](resources.md).

An operation captures the target before awaiting. On completion it resolves the original
tab and generation, then checks the exact document revision relevant to the operation.
Closure or replacement cancels presentation work; a pane move does not. A newer request
for the same target needs an additional request-generation check even when the document
has not changed. Cancellation improves efficiency; validation enforces correctness.

Documents can have multiple views with different cursors and scroll positions. They share
text, dirty state and edit history. They must not acquire divergent copies through React
state. Releasing a document while a surface owns it is rejected. Closing the last tab does
not discard a buffer implicitly. Load/operation/save/Run tasks hold explicit leases as well.
Superseding or cancelling an operation invalidates its result but retains its lease until the
original work settles and is finished. Releasing dirty work additionally requires explicit discard.

## Transactions, saves and agent proposals

Edits use UTF-16 offsets in the original document, half-open ranges, and an expected
revision. A sorted batch validates before publication. No-op edits do not advance the
revision. Separate buffer transactions now provide position maps, affinities and anchored
ranges. Newline preservation/conversion is an explicit import/export choice. Workspace
transactions preflight all participants before publication, with shared undo units, explicit
history kinds/grouping and per-view selection mapping. Language providers still need their own
revision checks and cancellation at the adapter boundary.

Saved baseline/server version and current local revision are separate. A save captures the
submitted revision and immutable contents at invocation. `WorkspaceCommands` serializes writes
per resource and supplies the current saved server-version precondition at submission. The host
service must enforce that precondition. Receipts preserve exact submitted content; later typing
remains dirty. Proposal targets and acknowledgement receipts use their own versions and queues;
see [agent review](agent-review.md).

Dirty state follows divergence from the saved baseline, including undo back to saved content;
a monotonically increasing revision alone cannot determine it. Canonical save responses must
not overwrite later edits. A failed proposal acknowledgement can be retried independently of
the successful product save, before the host submits a subsequent agent request.

Agent changes enter the same transaction path. Capture immutable request inputs at a turn
boundary. Subsequent proposals name their base document and proposal revision. A host may
choose its editing policy. The initial policy uses an exclusive lease during an executing
request; concurrent editing/merging remains deferred. Switching the agent association is a visible
host action. Never overwrite human corrections because a delayed operation finished.

Save and Run are separate host commands with explicit resource/variant targets. A run captures
the source/configuration revisions and settings it requires; the host owns save-before-run
policy. Read-only and editing-lease transitions apply to human and programmatic changes under
explicit capabilities. A disabled view alone is insufficient; service authorization stays
with the host. Local atomic workspace edits do not imply atomic remote persistence.

## Frameworks and structured surfaces

The runtime imports no React. Its read-only observable contract consists of stable, bound
`getSnapshot` and `subscribe` functions; subscription returns a cleanup function, and unchanged
snapshots retain their identity. A host's existing observer hook can consume this contract
directly, or a generic React example can use `useSyncExternalStore`. Read compatibility does
not make editor commands interchangeable with a host's writable cells or async update queue.

Build the host around a controller with stable readonly observable handles. The controller
owns shared navigation, modal, selection, loading and command state; views subscribe to the
specific values they display. Represent navigation and modal alternatives with discriminated
unions. Derive values through pure selectors in the host's existing reactive system. The
editor retains authoritative text/history, rather than mirroring it into a second host cell.
Commands call the editor's versioned transaction API; host-cell writes keep their own explicit
completion semantics. Test their ordering when queued host updates and synchronous edits meet.

Use function components with hooks, keeping shared state outside component-local state.
Local state is for local presentation and is explicitly initialized. Keep render bindings
constant and extract non-UI logic into plain TypeScript modules. Effects register listeners
and clean them up; they do not load, reset or synchronize editor/application state. Do not
move that state management into layout effects, memo callbacks or render-time side effects.

Attach/detach imperative views through stable callback refs or an explicit host mount API,
with symmetric cleanup. A view detach does not destroy its document/controller. Ref callbacks
must tolerate repeated attachment and cleanup without duplicating views or subscriptions.
Construct persistent controllers at the host composition boundary, outside component renders.

Resource, document, metadata and tab observables now notify only for their own changes; a coarse
workspace observable remains for tooling. Unchanged metadata and unrelated form snapshots keep
their identity through typing. Listener exceptions are reported without stopping other delivery.
Reentrant mutations are rejected during notification; a host can queue its next command after
delivery. Plain-host fixtures exercise two text views, a typed form and deferred save/Run ports.
The shared plain/React controller fixtures test queued host-write ordering, stable refs and
Strict Mode remounts, plus root error recovery without discarding documents. The runtime imports
no React or host cell library. See [the host adapter](host-adapter.md) for fixture boundaries.

React owns a container; StTropez owns its descendants. Host-rendered panels or inline
widgets get separate DOM roots and explicit mount/update/dispose contracts. A future
widget contract also specifies focus ownership, event routing, resize notification,
virtualization, anchored position mapping, and behavior during folding and undo. Never let
React and the editor reconcile the same descendants. Start with adjacent surfaces before
supporting complex forms inside text layout.

The consuming host supplies its design-system controls, menus, dialogs, alerts and style
tokens. Editor CSS stays scoped and exposes configurable visual properties; the standalone
demo's appearance does not prescribe application styling. Report user-facing failures through
host callbacks from commands or asynchronous completions, outside render. A host can place a
recoverable error boundary around a secondary surface without releasing its document state.

Connection settings, transfers, schedules and run inspection should be typed workspace
surfaces. They reference resource identity and versioned data rather than pretending to
be strings in a text model. Validation and save status are shared concepts; field models
and execution controls belong to the host. Textual configuration and a visual form can
share a controller through a lossless parser/serializer with explicit invalid-text states.
This conversion applies only when source and form represent the same resource; distinct
connection, transfer and run resources retain independent ownership and save state.
Credentials stay with the host. Running a transfer is an explicit application command and
is independent of committing an editor transaction.

## Rendering and language services

Keep DOM rendering as the initial production direction for native text interaction.
Benchmark input approaches before choosing a hidden textarea or contenteditable
implementation. Canvas and GPU text rendering add hit-testing and composition
burdens and require measured justification. The native textarea scaffold settles neither choice.
The [read-only viewport layer](viewport.md) now bounds DOM/range work in both axes and keeps
logical scroll ranges separate from browser scroll extents. It shares indexed documents and
mapped view handles. The bounded editing candidate exercises input on that layer; the production
input strategy and full contextual-line geometry remain unselected.
The [literal find controller](search.md) scans pieces with explicit scheduling and applies
revision-checked replacement transactions. Generic line decorators keep presentation within
the owned subtree. The [provider fixture](providers.md) supplies incremental visible tokens
and scoped completion/diagnostics through a real host-owned worker, with no runtime service
dependency or full language-protocol claim.

Language support is supplied by host adapters: incremental tokenization, completion, hover,
signature help, diagnostics, definition/reference navigation, rename, code actions, folds,
colors and links. Requests carry document revisions. Results are mapped through recorded
changes or discarded. Workspace edits validate all documents before changing any of them.
Allow dynamic capability registration, server-initiated edits, cancellation, reconnect and
custom messages without emulating another editor's extension API.

The optional protocol layer's `LspWorkspace` owns one existing `LspSession` per workspace/provider
configuration. Feature scopes share document leases, synchronization, wire versions and diagnostics;
view/request cancellation has its own lifetime. The host supplies URI/language/transport policy and
retains edit authorization. Command review is exclusive on that connection, with explicit recovery
after cancellation. This reuses the existing session, observable stores and Workspace snapshots
without introducing runtime packages. [The supported subset](lsp.md) distinguishes delivered
protocol ownership from the remaining reusable editor coordination and feature routes.

Local tokenization and server features are separate contracts. Verify that token classes
produce the intended visible styles and that unavailable services leave basic editing usable.
The host may supply a small incremental line tokenizer; a general parser or semantic-token
pipeline is not a prerequisite. Protocol and provider fixtures must produce real results in
browser tests, including completion insertion ranges and stale-response rejection.

## Optional compute acceleration

Keep the DOM, input lifecycle, model ownership and ordinary editing in TypeScript.
Potential WASM kernels are large diff computation, bulk search, indexing and token scanning.
Define bounded buffer-oriented inputs/outputs and measure encoding, allocation, copying,
startup and return conversion. A worker solves main-thread scheduling; WASM solves only
particular compute costs. Neither implies the other.

Any kernel has a TypeScript fallback, differential tests and cancellation/version checks.
Prefer a small build-time compiler for a proven restricted kernel language over a new
general TypeScript compiler. Do not ship the compiler, a managed runtime or a hidden npm
runtime dependency. The fallback is a required delivery path when optional artifacts fail.
