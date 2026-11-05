# Architecture

## Boundaries

The editor is an embeddable part of a workspace. It does not own accounts, authentication,
network clients, persistence, connection execution, application routing or an extension host.
The headless model owns editing decisions. The browser view translates native input into
transactions and projects the current document into DOM. Hosts render tabs, menus, forms,
job status, data previews and connection configuration.

The initial text representation is a string and each input replaces the document. This is
deliberately a baseline. It extracts the whole native value and has no application-level undo. A later
text-buffer benchmark selects a chunked tree or piece tree; do not treat this scaffold as
the final large-document implementation.

## Identity and asynchronous work

| Identity | Meaning | Lifetime |
| --- | --- | --- |
| Resource key | Opaque scope, resource and variant tuple | Host-defined; paths and titles are labels |
| Document ID | One in-memory buffer and revision sequence | Until explicitly released |
| Tab ID | One opened workspace surface | Until closed; moving it preserves identity |
| Tab generation | The surface currently occupying a tab | Changes when its contents are replaced |
| View instance | One DOM mount, selection and scroll position | Until unmounted; not the document lifetime |
| Request ID | One pending operation | Until completed, cancelled or superseded |
| Proposal revision | One offered change against a specified baseline | Until explicitly acknowledged or retired |

The scaffold implements resource/document/tab/generation identities. Request, proposal and
save-receipt protocols remain planned. View selection and scroll can be captured/restored;
automatic selection mapping across changes remains planned.

The planned resource lifecycle also covers non-text surfaces without requiring a dummy text
document. Common handles expose ownership, version, dirty/save status and capabilities; the
host owns typed data and validation. The scaffold's string-backed panel does not yet meet this
contract. Related connection, transfer and historical-run resources may have independent IDs.

An operation captures the target before awaiting. On completion it resolves the original
tab and generation, then checks the exact document revision relevant to the operation.
Closure or replacement cancels presentation work; a pane move does not. A newer request
for the same target needs an additional request-generation check even when the document
has not changed. Cancellation improves efficiency; validation enforces correctness.

Documents can have multiple views with different cursors and scroll positions. They share
text, dirty state and edit history. They must not acquire divergent copies through React
state. Releasing a document while a surface owns it is rejected. Closing the last tab does
not discard a buffer implicitly. Future load/poll/save tasks hold explicit leases as well.

## Transactions, saves and agent proposals

Edits use UTF-16 offsets in the original document, half-open ranges, and an expected
revision. A sorted batch validates before publication. No-op edits do not advance the
revision. LF storage normalization, offset mapping, atomic workspace edits and history
grouping require explicit policies before language services are integrated.

The production design distinguishes saved server version, current local revision and
proposal revision. A save captures the submitted revision and contents before awaiting.
Its receipt marks only that version saved. Later typing remains dirty; a later proposal
remains pending. Serialize saves per resource or require a server version precondition:
client-side receipt ordering alone cannot prevent out-of-order server writes.

Dirty state follows divergence from the saved baseline, including undo back to saved content;
a monotonically increasing revision alone cannot determine it. Canonical save responses must
not overwrite later edits. A failed proposal acknowledgement can be retried independently of
the successful product save, before the host submits a subsequent agent request.

Agent changes enter the same transaction path. Capture immutable request inputs at a turn
boundary. Subsequent proposals name their base document and proposal revision. A host may
choose an exclusive editing lease while an agent works, or permit concurrent human editing
and require explicit conflict review. Switching the associated agent session is a visible
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

Add per-resource/field subscriptions and stable unchanged snapshots before scaling the
workspace; the scaffold currently publishes every update to every listener. Keep text changes
out of unrelated tab metadata and form subscriptions. Exercise plain and React hosts early
with two text views, a typed form, queued host updates and Strict Mode remounts. The runtime
must not acquire a second reactive framework to support these adapters.

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

Keep DOM rendering as the initial production direction for accessibility and native text
interaction. Benchmark input approaches before choosing a hidden textarea or contenteditable
implementation. Canvas and GPU text rendering add hit-testing, accessibility and composition
burdens and require measured justification. The native textarea scaffold settles neither choice.

Language support is supplied by host adapters: incremental tokenization, completion, hover,
signature help, diagnostics, definition/reference navigation, rename, code actions, folds,
colors and links. Requests carry document revisions. Results are mapped through recorded
changes or discarded. Workspace edits validate all documents before changing any of them.
Allow dynamic capability registration, server-initiated edits, cancellation, reconnect and
custom messages without emulating another editor's extension API.

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
