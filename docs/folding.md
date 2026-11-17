# Folding

Folding hides body rows within one document view while preserving raw document coordinates.
The host supplies ranges or a discovery policy; StTropez owns validated fold state, its
visible-row projection and disclosure controls. Views of the same document fold independently.

## Use

Attach indentation and marker discovery to an existing editor:

```ts
import { discoverIndentationFolds } from "sttropez";
import type { TabId, Workspace } from "sttropez";
import { createFoldingController } from "sttropez/browser";
import type { TextEditor } from "sttropez/browser";

export function attachFolding(
    workspace: Workspace, tab: TabId, editor: TextEditor
) {
    return createFoldingController(workspace, tab, editor, document =>
        discoverIndentationFolds(document.buffer, {
            tabSize: 2,
            group: "blocks",
            markers: [{ start: "#region", end: "#endregion", group: "regions" }]
        }));
}
```

Render controls from the returned `FoldingController.state` observable. Invoke
`runCommand("collapse-all", "regions")` to collapse a group, `refresh()` when host discovery
policy changes, and `dispose()` before destroying the editor.

A host with its own captured outline can publish directly through `DocumentView.folding`:

```ts
import type { DocumentView, FoldVersion } from "sttropez";

export function publishSection(
    view: DocumentView, expected: FoldVersion, from: number, to: number
) {
    return view.folding.setRanges(expected, [
        { id: "section", from, to, group: "sections", collapsed: true }
    ]);
}
```

Capture `expected` from `view.folding.getSnapshot()` before asynchronous work, together with
the document snapshot used to produce the offsets. `setRanges` replaces the complete range
set, so combine all outline sources before publication.

## Contract

### Ranges, versions and projection

`DocumentFolding` is a stable observable. Its immutable `FoldingSnapshot` contains document
`revision`, fold `generation`, validated `FoldRegion` values and a `FoldIndex`.

| Input | Validation and behavior |
| --- | --- |
| `FoldRange.id` | Unique, nonempty string of at most 256 UTF-16 units |
| `from`, `to` | Safe integer UTF-16 offsets within the document; `to` is exclusive |
| Rows | One visible header and at least one body row; one identity per header |
| Relationships | Nested or disjoint ranges; crossing ranges are rejected |
| `group` | Optional nonempty host string |
| `collapsed` | Optional boolean; omission preserves the same identity's state, otherwise defaults to expanded |
| `FoldVersion` | Both revision and generation must match this view |

`setRanges`, `setCollapsed`, `reveal` and `revealSelection` return `false` for stale or
unavailable targets. Invalid public ranges throw before publication. `createFoldRegions`
validates a complete set against a buffer and optional prior regions without publishing it.
A range ending at the next row's start leaves that row visible.

Folding changes neither text nor dirty state nor document history. Fold anchors follow edits
and undo/redo. Deleted boundaries expand their region; degenerate, merged or crossing definitions
are invalidated. Undo restores the text but does not recreate invalidated fold definitions.
Supply fresh definitions through discovery or a captured host publication.

`FoldIndex` maps source lines to visible rows and back through `rowAt` and `lineAt`.
`hiddenBy` identifies the covering collapsed region; `headerAt` identifies a fold header.
It stores collapsed intervals rather than one entry per source line. `sameProjection(other)`
compares hidden rows independently of expanded metadata. Use that distinction when display
intent depends on visible rows, while retaining separate document/selection/provider guards.
Updates can visit the supplied region array; arbitrary fold changes are not constant-time.

### Discovery

`discoverIndentationFolds(buffer, IndentationFoldingOptions)` returns a lazy
`IndentationFoldingCursor`. Indentation discovery defaults to enabled, tab size 4 and group
`"indentation"`. Tab size must be an integer from 1 through 256. Optional paired markers match
line prefixes after indentation and a whitespace/end boundary. Marker prefixes and groups
must be nonempty; prefixes cannot contain line endings. Nested blocks include interior blank
lines and exclude trailing blank lines. Unclosed markers produce no collapsed region.

The cursor exposes `next(workBudget?)`, `snapshot()` and `dispose()`. Frozen
`IndentationFoldingProgress` snapshots report status (`running`, `ready`, `failed`, `disposed`),
phase (`validate`, `scan`, `finish`, `publish`), counters, nullable `result` and nullable `failure`.
Only `ready` exposes a complete frozen array of frozen `DiscoveredFold` records. Errors are
rethrown and retained as failure messages. Disposal drops unfinished work and the cursor's
result reference; returned ranges remain usable. Advancing or disposing during `next()` throws.
Keep options immutable while discovery is pending. Validation and all discovery work run in
`next()`, including marker preparation and EOF stack cleanup.

Budgets are safe integers of at least 256, defaulting to 4096. `workUnits` combines UTF-16 reads,
marker/row/stack visits, output records and `bulkWorkUnits`. `readUnits` counts buffer units
read, including repeated reads. Bulk charges estimate input cardinality for native marker
validation/comparison, large prefix reads and output-array freezing; they are included once
in work, and prefix reads also contribute to reads. They do not count helper internals or time.
Checkpoints follow roughly 256 charged units at operation boundaries; whitespace chunks read
up to 4096 units. A large delimiter, native helper or host callback can exceed the requested
budget. This is not a time limit or a complete interaction-latency bound.

`reconcileFoldRanges(buffer, discovered, previous)` chooses one outer range per header,
discards crossings and preserves identity for a matching mapped header/group. It returns a
complete range set. Reconciliation does not merge independent publications for the host.
Reconciliation and installing the resulting fold projection are synchronous costs outside
the discovery cursor; include them when measuring visible acceptance.

`createFoldingController` captures a tab and retained editor view. Its `FoldDiscovery` callback
receives an immutable document and `AbortSignal`. A `FoldDiscoveryResult` may be ranges, a
`FoldDiscoveryCursor`, or a `FoldDiscoveryBatch` with `ranges` and an optional `isCurrent` guard;
the callback may return a promise. `delayMs` defaults to 100 and must be finite and nonnegative.
The controller takes ownership of a returned cursor, including a late promise result. A custom
cursor provides `next(workBudget?)`, `snapshot()` and `dispose()`, and reports the same status,
nullable result and failure fields; indentation-specific counters are not required. The controller
advances 4096 work units at a time, with at most 64 advances per task and a four-millisecond
elapsed check between advances. It releases completed, cancelled and failed cursors. A terminal
cursor without a result fails discovery. Custom callbacks/cursors must cooperate: scheduling
cannot preempt their synchronous work. Disposal must release work and tolerate repeated calls.

The controller rejects stale edits, tab replacements, expired authority and disposal. Publication
waits for composition and queued editing, then reconciles the latest view collapse choices.
Failures retain mapped folds and publish a `FoldingStatus` message. States are `pending`,
`ready`, `failed` and `disposed`; snapshots include revision, counts and available groups.

### Language-server discovery

`createLspFoldingClient(provider).run(document, prepare?)` from `sttropez/protocol` supplies a
cancellable captured result with revision, ranges and an `isCurrent` guard. Enable
`textDocument/foldingRange` in the [provider configuration](language-server.md), and preserve
the guard when returning a batch to the folding controller. Dispose the client with its host
attachment. Capability registration and reconnect use the shared provider session.

The client advertises complete-line folds. `decodeLspFoldingRanges` converts inclusive LSP end
lines to exclusive raw offsets using the captured LSP line index. Optional character positions
and collapsed text are ignored. Out-of-document or degenerate ranges are skipped; malformed
response shapes reject the whole batch. Bare CR is an LSP line break, but a range covering no
complete body row in the editor's LF projection is skipped. Expired captures reject with RPC
code `-32801`. Provider kinds become groups, including custom kinds; the host chooses discovery
and collapse policy.

### Commands and interaction

`FoldCommand` supports `collapse`, `expand`, `collapse-all` and `expand-all`, with an optional
group filter. The controller handles Ctrl/Cmd+Shift+[ and Ctrl/Cmd+Shift+] at the caret.
Commands reject busy or unavailable views. Collapsing preserves the logical selection and
reveals its visible header edge; it does not replace hidden selection endpoints.

A collapsed logical caret paints at its header. Arrow/Page traversal skips hidden rows.
Explicit selection, typing, Find and reveal expand hidden targets. Disclosure buttons toggle
with Enter/Space; Escape returns focus to the source. Buttons capture tab, revision and fold
generation. Inline hidden-line counts add no source text, clipboard data or caret offsets.
Comparison panes retain independent fold choices; hunk reveal expands the entire target range.

Retained view handles preserve folds through remount. The [viewport view-state contract](viewport.md#scrolling-and-saved-views)
describes initialization of fold metadata in a new view without overwriting newer state.

## Host responsibilities

Choose discovery, groups and initial collapse state. Combine multiple sources into one result,
retain captured identities across asynchronous work, and stop obsolete providers on abort.
Call mutation commands outside workspace notification callbacks. Dispose the controller and
its state subscriptions with the attachment; dispose a host-owned view only at the end of that
view's lifetime. Discovery ownership does not transfer storage or resource ownership.

## Not covered

See the [support matrix](README.md#support-matrix) for unsupported features and device checks.
