# Captured rename preview

The default worker route below is a local lexical fixture. The explicit LSP route uses a
[provider edit preview](lsp-rename.md): enter the new name before requesting its edits;
changing the name requires a fresh request. Both routes share atomic Workspace history.

The example owns one lazy `RenameBackend` through `ProviderLane`. The adapters reuse the
existing worker and LSP clients; the host keeps preview validation, captured identities,
permissions and application policy. Dropping a lane invalidates its callbacks before disposing
the client, so late notifications cannot affect a replacement. Pending cancellation releases
uncertain transport state; dismissing a ready preview releases provider targets while retaining
the idle client for reuse. No public library API or runtime dependency is added.

Both candidate hosts offer **Prepare rename preview** (F2 in a source), a **New
identifier** field, paged targets and **Apply captured rename**. The origin can be
primary, secondary or comparison working source. Preparing and editing the name
leave source text and history unchanged. Each target shows its document and
resource identities, captured revision, UTF-16 range, line/column and bounded
context. Review the entire preview before applying it.

F2 focuses and selects the current name in the host field, so typing edits the new
name. Escape in that field dismisses the preview and returns focus to the captured
source without changing its complete selections. Tab reaches the preparation and
apply buttons; Enter on **Apply captured rename** confirms the reviewed batch.

This is a lexical token fixture across the host's captured working resources. It
reuses the actual versioned reference worker, including acknowledged project
snapshots/deltas and one 16,384-unit scan chunk per continuation. Strings,
comments and opaque templates are skipped. Identically named tokens in different
scopes, properties and regular expressions may be included. There is no scope,
type or module resolution; a complete lexical scan is not a semantic rename
proof. General semantic rename and consuming-host/protocol qualification remain
required. No language-service dependency or copied parser implementation is added.

The scope is at most 100 ready working documents and 16 Mi UTF-16 units. Names use
the worker's Unicode identifier subset, at most 256 units, excluding dollar
identifiers and reserved names. A preview has at most 1,024 locations and displays
64 per page. A truncated result is rejected in full. The captured caret must
occur in a returned code-token range; a position in quoted/comment text is not
renameable. Every returned target is validated for identity, revision, range,
exact original name, token boundaries, document order and non-overlap before the
preview becomes applicable. Provider progress must cover the complete project.

The host retains resource leases, the original tab/view, complete selection set,
fold generation, working revisions and edit authority while the preview is open.
Changed revisions, selection, folds, authority or origin lifecycle invalidate the
preview. Delayed results cannot follow future focus. Composition, pending semantic
input/navigation and table conversion prevent capture. User typing cancels it.
Changing the new-name field is a host form edit and never types into the source.
Requests have a 5-second reply deadline and a 30-second whole-operation deadline.
Failure or disconnect releases uncertain transport state; reconnect takes fresh
snapshots. Disposal releases workers, subscriptions, sessions and leases.

Apply validates human and host edit permission and absence of a lock for **every**
target, then uses the existing atomic `Workspace.editDocuments` transaction.
Failure in a later resource cannot publish earlier edits. All changes form one
shared undo command. The origin's complete selections retain their positions
within renamed identifiers, clamped for shorter names without splitting surrogate
pairs; undo restores the exact prior set. Other live views follow the workspace's
documented replacement-affinity mapping. Later human corrections remain separate
undo commands. **Open renamed changes in …** reveals a participating resource,
including a previously unmounted companion, for keyboard undo/redo. Primary
Save/Run identity and immutable comparison references stay captured independently.

Focused model and actual-worker browser regressions cover bounded and truncated
previews, Unicode/CRLF, late malformed targets, authority, stale selections,
typing, remount, reconnect, synthetic composition/table guards, shared history,
comparison, primary Save/Run and cleanup. Native IME/reconversion/dead keys, OS
and application clipboard and physical display latency
remain unverified. Automated synthetic guards do not qualify native input.
