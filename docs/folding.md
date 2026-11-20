# Folding

Collapse a region to leave its header visible in one view. You can supply the ranges yourself or let a
discovery policy find them. Other views keep their folds, and source offsets address the whole
document.

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

Build controls from `FoldingController.getSnapshot()` and `subscribe()`. To collapse a group, call
`runCommand("collapse-all", "regions")`. Call `refresh()` after a rule change and `dispose()` before
disposing the editor.

If you already have an outline, pass its ranges to `DocumentView.folding`.

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

Before awaiting discovery, capture the document and `expected` from `view.folding.getSnapshot()`.
Combine all outline sources before `setRanges`, which replaces the whole set.

## Contract

<a id="ranges-versions-and-projection"></a>

### How fold ranges map to visible rows

Subscribe to `DocumentFolding` for an immutable `FoldingSnapshot` with document `revision`, fold
`generation`, validated `FoldRegion` values and a `FoldIndex`.

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

Fold anchors follow edits, undo and redo. Deleting a boundary expands its region. Degenerate, merged
or crossing ranges lose their definitions. Undo restores the text. To restore an invalidated fold,
publish fresh ranges. Folding leaves history and dirty state untouched.

Use `FoldIndex.rowAt` and `lineAt` to move between source lines and visible rows. `hiddenBy` finds the
collapsed region hiding a line. `headerAt` finds the fold at a header. The index stores collapsed
intervals. `sameProjection(other)` compares just the hidden rows. For example, adding an expanded
region leaves the projection equal. Check the document, selection and provider separately before using
a delayed result. Updating folds can visit every supplied region.

### Discovery

`discoverIndentationFolds(buffer, IndentationFoldingOptions)` returns a lazy
`IndentationFoldingCursor`. Indentation discovery defaults to enabled, tab size 4 and group
`"indentation"`. Tab size must be an integer from 1 through 256. Optional paired markers match
line prefixes after indentation and a whitespace/end boundary. Marker prefixes and groups
must be nonempty; prefixes cannot contain line endings. Nested blocks include interior blank
lines and exclude trailing blank lines. Unclosed markers produce no collapsed region.

Call `next(workBudget?)` to validate options, prepare markers, scan and finish open stacks at EOF.
Between calls, `snapshot()` returns frozen `IndentationFoldingProgress` with a status (`running`,
`ready`, `failed`, `disposed`), phase (`validate`, `scan`, `finish`, `publish`), counters, `result`
and `failure`. Keep options immutable until discovery finishes. Read the frozen array of frozen
`DiscoveredFold` records when status is `ready`. An error records its message and rethrows.
`dispose()` releases unfinished work and the cursor’s reference to the result. You can keep ranges it
already returned. Calling `next()` or `dispose()` from inside `next()` throws.

Pass a safe integer of at least 256 work units (default 4,096). `workUnits` counts UTF-16 reads,
visits to markers, rows and stacks, and output records. It includes `bulkWorkUnits` once, estimated
from the input sizes for marker validation and comparison, large prefix reads and freezing the output
array. `readUnits` includes prefix reads and counts repeat reads each time.

The cursor checks its budget at operation boundaries roughly every 256 units. Whitespace reads can
span 4,096 units. A large delimiter, native operation or host callback can run past the budget.
Measure time to visible folds separately.

`reconcileFoldRanges(buffer, discovered, previous)` keeps one outer range per header, drops crossings
and reuses IDs for matching mapped headers and groups. Combine your sources before calling it. Include
reconciliation and installation in measurements of time to visible folds. Both run synchronously after
discovery.

`createFoldingController` captures the tab and retained editor view. Set `delayMs` to a finite,
nonnegative delay (default 100). Its `FoldDiscovery` callback takes an immutable document and
`AbortSignal`. Return a `FoldDiscoveryResult` directly or in a promise: ranges, a
`FoldDiscoveryCursor`, or a `FoldDiscoveryBatch` with `ranges` and an optional `isCurrent` guard.

For a custom cursor, implement `next(workBudget?)`, `snapshot()` and idempotent `dispose()`. Report
status, nullable result and failure. Indentation counters are optional. The controller owns any
returned cursor, even one that arrives late. It releases completed, failed and cancelled cursors.
Finishing without a result fails discovery. Each advance gets 4,096 work units. A task makes at most
64 advances and checks elapsed time between them against a 4 ms target. Yield inside your cursor to
bound synchronous work.

If the text changes, the tab is replaced, the result loses authority or the controller is disposed,
the controller drops the stale result. During composition or queued editing, it waits to publish, then
honors the user’s latest fold choices. On failure, existing mapped folds stay visible. Read the
`FoldingStatus` message for the cause. Status can be `pending`, `ready`, `failed` or `disposed`.
Snapshots also give the revision, counts and available groups.

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

`FoldCommand` accepts `collapse`, `expand`, `collapse-all` or `expand-all`, optionally filtered by
group. Enable controls with `canRunCommand(command, group)`. `runCommand` rechecks the caret, group,
collapse state and availability. Ctrl/Cmd+Shift+[ and Ctrl/Cmd+Shift+] act at the caret. Collapsing
shows the header and preserves hidden selection endpoints. Busy or unavailable views reject the
command.

A collapsed logical caret paints at its header. Arrow/Page traversal skips hidden rows.
Explicit selection, typing, Find and reveal expand hidden targets. Disclosure buttons toggle
with Enter/Space; Escape returns focus to the source. Buttons capture tab, revision and fold
generation. For the `imports` group the button reads **Collapse imports** or **Expand imports**.
Inline hidden-line counts add no source text, clipboard data or caret offsets.
Comparison panes retain independent fold choices; hunk reveal expands the entire target range.

Keep the `DocumentView` if you want the same folds after remounting. To initialize a fresh view from a
saved capture, see [restoring scroll and folds](viewport.md#scrolling-and-saved-views).

## Host responsibilities

Choose discovery rules, groups and initial collapse state. Combine all sources before publishing.
Abort obsolete work. Make changes after workspace notifications and dispose the controller and
subscriptions on detach. Retain a view to keep its folds.

## Not covered

A fold hides source rows. Sticky scroll headers are outside this view’s
[presentation support](README.md#support-matrix).
