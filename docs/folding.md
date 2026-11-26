# Folding

Folding hides a block’s body in one view. The header stays visible. Source offsets address the whole document.

## Use

Attach indentation and marker discovery to an existing editor:

```ts
import { discoverIndentationFolds } from "sttropez";
import { createFoldingController } from "sttropez/browser";
import type { FoldingController, TextEditor } from "sttropez/browser";

export function attachFolding(editor: TextEditor): FoldingController {
    return createFoldingController(editor, document =>
        discoverIndentationFolds(document.buffer, {
            tabSize: 2,
            group: "blocks",
            markers: [{ start: "#region", end: "#endregion", group: "regions" }]
        }));
}
```

Use `getSnapshot()` and `subscribe()` for toolbar state. `controller.setCollapsed(true, "regions")`
collapses the group in place, keeping focus, selection and scroll within the new document height.
Omit the group to act on every fold. Call `refresh()` after changing discovery rules.

Customize gutter buttons and collapsed summaries with `settings.foldLabels`. Comparison settings
apply to both panes. Use `editor.configure` to change one pane.

```ts
import type { FoldLabels } from "sttropez/browser";

export const frenchFolds: FoldLabels = {
    action: fold => fold.group === "imports" ? (fold.collapsed ? "Ouvrir les imports" : "Replier les imports") : undefined,
    summary: (fold, changed) => {
        const count = fold.lineTo - fold.lineFrom - 1;
        return `… ${count} ${count === 1 ? "ligne masquée" : "lignes masquées"}${changed ? " · avec modifications" : ""}`;
    },
};
```

Both callbacks receive the fold. It hides gutter lines `lineFrom + 2` through `lineTo`.
The summary also receives whether a hidden line has changes. Return plain text or `undefined`
for the default label. Set `foldLabels: {}` to restore both defaults.

For a host-supplied outline, give each section a stable ID and omit `collapsed` on refresh.
A new section starts expanded. A known section keeps the user’s choice.

```ts
import type { DocumentView, FoldVersion } from "sttropez";

export function publishSection(
    view: DocumentView, expected: FoldVersion, from: number, to: number
) {
    return view.folding.setRanges(expected, [
        { id: "section", from, to, group: "sections" }
    ]);
}
```

Capture the document, view and `expected = view.folding.getSnapshot()` before starting asynchronous
work. Publish to that same view. `setRanges` replaces its whole outline, so combine all sources first.

## Contract

<a id="ranges-versions-and-projection"></a>

### How fold ranges map to visible rows

`view.folding.getSnapshot()` returns an immutable `FoldingSnapshot`. Subscribe to the same handle for updates.

| Input | Validation and behavior |
| --- | --- |
| `FoldRange.id` | Unique, nonempty string of at most 256 UTF-16 units |
| `from`, `to` | Safe integer UTF-16 offsets within the document; `to` is exclusive |
| Rows | One visible header and at least one body row; one identity per header |
| Relationships | Nested or disjoint ranges; crossing ranges are rejected |
| `group` | Optional nonempty host string |
| `collapsed` | Optional boolean; omission preserves the same identity's state, otherwise defaults to expanded |
| `FoldVersion` | Both revision and generation must match this view |

`setRanges`, `setCollapsed`, `reveal` and `revealSelection` return `false` for stale or unavailable
targets. Invalid ranges throw before publication. `createFoldRegions` validates a complete set
against a buffer and optional prior regions. Ending a range at the next line’s start leaves that line visible.

`setCollapsed` accepts an ID or array of IDs. An empty array or any unknown ID leaves the outline
intact and returns `false`. By default, selections keep their source offsets. With
`{ moveHiddenCarets: true }`, hidden insertion carets move to the visible header’s end and merge
where they coincide. Nonempty selections keep both endpoints. Subscribers see folds and selections together.

Folds follow edits, Undo and Redo. Undoing Delete Lines restores the block and each pane’s fold choices.
Surviving folds keep their settings. Editing a boundary can expand or invalidate its fold.
Toggling affects neither document history nor dirty state.

`FoldIndex.rowAt` maps source line to visible row. `lineAt` maps back. Look up a header with
`headerAt` or the collapsed block hiding a line with `hiddenBy`. Reading `snapshot.regions`
resolves the entire list at that revision. Older snapshots keep their positions.
Edits across fold boundaries can visit every region. `sameProjection(other)` compares hidden rows
only. Check document, selection and provider identity separately before applying delayed work.

### Discovery

`discoverIndentationFolds(buffer, options)` returns a lazy `IndentationFoldingCursor`. Indentation
discovery defaults to group `"indentation"` and tab size 4 (valid range 1–256). Blocks include
interior blank lines and leave trailing blank lines visible. Paired markers match a line prefix
after indentation, followed by whitespace or end of line. Groups and prefixes must be nonempty.
Prefixes cannot contain line endings. An unclosed marker yields no range.

Call `next(workBudget?)` to validate, scan, close the stacks and publish. Keep options immutable
until completion. `snapshot()` reports phase, status, counters, result and failure. A ready cursor
returns frozen `DiscoveredFold` records in a frozen array. Errors set `failure` and rethrow.
`dispose()` releases the cursor’s work and its result reference. The caller can keep the returned ranges.
Calling `next()` or `dispose()` during `next()` throws.

The default budget is 4,096 units. Supply a safe integer of at least 256. `workUnits` counts UTF-16
reads, marker, row and stack visits, and output records. It includes `bulkWorkUnits` once for
operations such as prefix comparisons and freezing output. `readUnits` counts repeated reads.
Budget checks occur about every 256 units. Whitespace scans can span 4,096 units, and native
operations or callbacks can exceed the budget. Measure elapsed time to visible folds separately.

`createFoldingController` calls the discovery function with a document snapshot and an `AbortSignal`.
Its `delayMs` defaults to 100 and must be finite and nonnegative. Return ranges, a cursor, or a
batch with `ranges` and an optional `isCurrent` guard. Any of these can arrive in a promise.

A custom cursor supplies `next(workBudget?)`, `snapshot()` and idempotent `dispose()`. Report
status, result and failure. Indentation counters are optional. The controller disposes every returned
cursor, including late arrivals. Finishing without a result fails discovery. Each advance gets
4,096 units, up to 64 advances per task with a 4 ms time check between calls. Yield within
`next()` to bound synchronous work.

Discovery keeps the outer range at a shared header and drops crossing ranges. `initiallyCollapsed`
applies on first discovery. Matching headers and groups keep their current fold choices.
The controller waits for composition and queued edits before publishing. A block that grows over
a visible selection endpoint opens. A changed document, replaced tab, expired provider guard or
disposed controller prevents a stale result from replacing the outline.

`FoldingStatus` reports `pending`, `ready`, `failed` or `disposed`, plus revision, counts, groups
and a message. On failure, the mapped outline stays visible. Editor disposal cancels discovery.
Subscribe to the new controller after remounting. The old one retains its final snapshot.

### Language-server discovery

Use `createLspFoldingClient(provider)` from `sttropez/protocol` with a server that provides
`textDocument/foldingRange`. Call `client.run({ document })`, cancel the call on abort and return
its `result` to the controller. The resolved batch carries the captured revision, ranges and
`isCurrent` guard. Keep that guard. Dispose the client with its attachment. Capability registration
and reconnect follow the provider session.

The client requests whole lines and converts inclusive LSP end lines to exclusive offsets in the
captured document. Server kinds become fold groups. Character positions and collapsed text are
ignored. Degenerate and out-of-document ranges are skipped, including bare-CR ranges that hide
no body row in the editor’s LF projection. A malformed response rejects the batch. An expired
capture rejects with RPC code `-32801`.

### Commands and interaction

`fold.collapse` and `fold.expand` act at the caret (Ctrl/Cmd+Shift+[ and Ctrl/Cmd+Shift+] on the
physical bracket keys). `fold.collapse-all` and `fold.expand-all` act across the view. Pass a
group to any command to limit its scope. For example, `editor.commands.run("fold.collapse-all", "imports")`
collapses imports. Read the label and availability with `editor.commands.get(id, group)`.
Dispatch checks the current caret, group and fold state and rejects busy or unavailable views.
Disposing the controller removes its commands and shortcuts.

- **Caret and selection.** A collapse command or gutter click moves hidden insertion carets to the
  header’s end. Typing there edits the header. A host can leave a logical caret inside a fold.
  It paints at the header. Arrow and Page keys skip hidden rows. Explicit selection, typing,
  Find and reveal open hidden targets.
- **Line edits.** A gutter selection, triple-click or Ctrl/Cmd+L selects the header, hidden body
  and any following line ending. Selecting through EOF keeps the last block folded. Moving lines
  carries a folded block across its visible neighbor, including another folded block. Their folds
  follow the text through Undo and Redo. Duplicating leaves the original folded and the copy expanded.
- **Gutter.** Clicking a disclosure returns focus to the editor. Fold buttons sit outside the Tab
  order. A focused button keeps focus on Enter or Space. Escape returns to the input. Buttons
  capture tab, revision and fold generation. Import folds read **Collapse imports** or **Expand
  imports**. Clicking or double-clicking the hidden-line count expands the fold and keeps the
  selection. The count contributes no source text, clipboard data or caret offsets.
- **Review.** Panes keep independent fold choices. Revealing a hunk expands its target range.

## Host responsibilities

Choose the outline source, groups and initial state. Abort obsolete requests and publish after
workspace notifications. Dispose controllers and subscriptions on detach. Retain the `DocumentView`
to keep its folds across remounts. [Restoring a saved view](viewport.md#scrolling-and-saved-views)

## Not covered

For sticky scroll and other display limits, see the [support matrix](README.md#support-matrix).
