# Text comparison

To review unsaved edits, pass the last saved text to `mountTextComparison`. It displays that
baseline beside the editable document and keeps it fixed as the user types. Your application
fetches versions, chooses which changes to accept and saves the result. For a headless diff
between two buffers, use [`TextDiff` from `sttropez/kernels`](#exact-text-and-scheduling).

## Use

Pass the working document and its `ComparisonBaseline`. Give the container a height and load the
editor stylesheet. [Page setup](getting-started.md#open-the-first-editor)

The panes fill the space between the controls and the selected-change preview. At window widths
of 700 CSS pixels or less they stack and share the available height. While the files differ,
the preview has a fixed share of the panel, capped at 4.5 rem. Moving the caret between changed
and unchanged lines keeps both panes the same height. Long excerpts scroll inside the preview.
Identical files use the full space for the panes.

```ts
import type { ComparisonBaseline, DocumentId, Workspace } from "sttropez";
import { mountTextComparison } from "sttropez/browser";
import type { TextComparisonOptions } from "sttropez/browser";

export function showChanges(
    host: HTMLElement, workspace: Workspace, documentId: DocumentId, baseline: ComparisonBaseline
) {
    const options: TextComparisonOptions = {
        ariaLabel: "Review changes",
        rowsAligned: true
    };
    return mountTextComparison(host, workspace, documentId, baseline, options); // Call dispose() when the review attachment ends.
}
```

The toolbar lets you navigate changes, revert one, link scrolling and align rows. It shows the
current change and total using the browser’s number format. The `ariaLabel` option defaults to
`"Text comparison"`. Pass your working `DocumentView` through `view` to keep
its selection and folds when you close the comparison. The mount disposes only views it creates.

For a custom toolbar, set `controls: false` and mount your buttons outside the two panes.
The host example returns pointer users to their active pane and leaves keyboard users on the
navigation button. Its Restore button captures the selected change on press so a baseline
refresh before release cannot redirect the edit. [Custom toolbar source](../examples/comparison/controls.ts)

## Contract

### Identity and comparison state

Pass a working document or text tab to `mountTextComparison`. A supplied view must belong
to that workspace and document. Moving a tab preserves the comparison. Closing or replacing a
captured tab expires it.

For an external baseline, supply a `TextBuffer` and opaque `version`. Alternatively, pass the
baseline’s `DocumentId`. The comparison retains both documents, follows each baseline
revision, and uses its decimal revision as the baseline version. Editing either document expires
old hunk commands. Refresh and acceptance tickets apply to external baselines.

`ComparisonController` is an observable with immutable `ComparisonSnapshot` values:

| Field | Meaning |
| --- | --- |
| `status` | `running`, `ready`, `failed`, `expired` or `disposed` |
| `generation` | Identity of this comparison result or in-progress replacement |
| `baseline` | Buffer/version and a separate baseline `epoch`, or `null` after expiry/disposal |
| `working` | Captured working document snapshot, or `null` after expiry/disposal |
| `hunks` | Exact when ready; mapped presentation from the preceding comparison while running |
| `progress`, `failure` | Current diff work counters or a failure message |

Each edit starts a new diff. You may see old change markers move with the text while StTropez
recomputes the hunks. A gap in revision history or a new baseline clears those markers.
When the diff is ready, StTropez replaces them all at once and enables navigation and reversion.
A change to the progress count alone doesn't repaint the panes.

While checking an edit, the built-in toolbar keeps the last completed preview in place. A longer
comparison shows “Updating…”. Previous, Next and Use baseline stay disabled until the new result
is ready. Changing the baseline clears the old preview immediately.

Subscribe to `TextComparison` for a `TextComparisonSnapshot`. Repeated reads return the same
immutable object until a field changes. Its `comparison` field holds the controller snapshot.
`selectedHunk` indexes the change at the last focused pane's caret. Any column on a tinted
line targets that change, including when the selection covers the line and its ending.
An empty change is selectable at its exact offset. On an unchanged line or during recomputation,
`selectedHunk` is `null`. Before the first pane receives focus, Next starts at the initial caret.
Use `canNavigate` and `canRevert` to enable buttons. They account for pane readiness, active
composition and edit permission.

Read `scrollLinked`, `alignment` (`ComparisonAlignmentSnapshot`) and `disposed` to find out what
the panes are doing. Comparison and permission changes publish synchronously. Attaching panes
and aligning rows can take several turns. Subscribers get the latest alignment counts with each
published snapshot.

Read snapshots in notifications and queue commands until after delivery. Disposal publishes a final
snapshot with no selected hunk or available command. Commands check the capture and input state
again when invoked. Setting the DOM input’s `readOnly` or `disabled` property alone does not publish
a snapshot.

### Exact text and scheduling

`TextDiff` compares LF-inclusive lines, then trims equal UTF-16 boundaries within changed blocks.
CRLF, LF, tabs, spaces and final newlines participate in equality. `DiffHunk` contains baseline
and working `DiffRange` values with exclusive text and line ends. `whitespaceOnly` describes a
change without suppressing it. A hunk with only LF/CRLF substitutions has `lineEndingOnly: true`.
The controls label it “line endings only”. Pass `settings` once to configure both panes, including the working pane’s `pasteLineEndings` policy.
Both panes use the host’s `requestLine` prompt for Go to Line.
When a replacement spans the same number of rows on both sides, the panes trim the common
prefix and suffix on each paired row. A point marks an insertion or deletion within a row.
Uneven multi-row replacements and paired rows over 4,096 UTF-16 units use the line tint alone.
**Use baseline** restores the whole hunk as one undoable edit.
Alignment minimizes line insertions/deletions; it does not
provide a globally minimal character diff or moved-block detection.

If you use `TextDiff` directly, your caller decides when to take the next step.

```ts
import { TextDiff } from "sttropez/kernels";
import type { DiffProgress, TextBuffer } from "sttropez";

export function* compareText(baseline: TextBuffer, working: TextBuffer): Generator<DiffProgress> {
    const diff = new TextDiff(baseline, working);
    try {
        for (;;) {
            const progress = diff.next(4096);
            yield progress;
            if (progress.status !== "running") return;
        }
    } finally {
        diff.dispose();
    }
}
```

`DiffProgress` reports status (`running`, `ready`, `failed`, `disposed`), immutable hunks, work and
read units, line edit count and any failure message. `snapshot()` reads progress. `next()` advances
the two captured buffers by a work budget (default 32,768). Schedule further calls until `ready`,
which returns all hunks or an empty array for equal text. A failed advance throws the original error
and records `failed` with empty hunks.

`dispose()` clears the cursor's hunks and failure and is idempotent. Snapshots already held by callers
stay valid. Reentrant advancement or disposal throws. Terminal `next()` calls
validate the budget and return the current progress.

<a id="hunk-commands-and-host-tickets"></a>

### Reverting a change or accepting a version

Call `comparison.navigateHunk(1)` for the next change or `comparison.navigateHunk(-1)` for the previous
one. Both start at the active caret, wrap at either end and place a caret at the start of the first changed line in both panes.
Each pane registers `comparison.nextChange` (F7) and `comparison.previousChange` (Shift+F7).
The command starts at that pane’s caret and leaves focus in place. Hosts can rebind either shortcut on
the pane’s keymap. Clicking Previous or Next returns focus to the last active pane. Activating
either button from the keyboard keeps focus on the button. Clicking a disabled review button
preserves editor focus.

`comparison.revertSelectedHunk()` restores the change at the active caret and focuses the working pane.
If a button press or host confirmation spans multiple events, capture `comparison.getSnapshot()` at
the start and pass it to `revertSelectedHunk(shown)`. It returns `false` if the comparison or
target changed before activation.

Call `comparison.hunkAt(index)` when presenting a change. It returns a handle for that exact change,
or `undefined` while the diff is pending or the index is out of range. Keep the handle through a
confirmation dialog. Its `select()` reveals and selects both ranges, unfolding them if needed.
Its `revert()` restores the baseline range in one undoable edit and leaves a caret at its start. Both return `false` after either
side changes or the review closes. Browser actions also guard composition, and revert checks
write access. Headless consumers use `controller.hunkAt(index)?.revert()`. Undo restores
the text and selection. The built-in **Use baseline** button focuses the working editor so you can
undo or type there immediately. After a working edit the next ready comparison resolves the target again.

Take a ticket before fetching a baseline or asking the user to confirm a change.

| Command | Capture and completion |
| --- | --- |
| `beginRefresh()` | Capture baseline epoch/version, working snapshot and server version; complete with a fetched baseline |
| `beginAcceptance()` | Capture the working snapshot; complete with that exact buffer object and a host baseline version |
| `beginReversion()` | Capture a ready result, tab, complete selection set and authority for confirmation; `complete()` reverts all reviewed hunks in one transaction |

`ComparisonTicket` exposes `capture`, `isCurrent`, `complete`, `cancel` and `finish`. Its
`ComparisonCapture` records the baseline identity, the working snapshot and the server version
separately. Starting a refresh supersedes an earlier refresh. The same rule applies to two
acceptances. When the baseline advances, all tickets for its previous epoch expire.

If a user types another line while acceptance is pending, that line stays in the working pane
as an edit. The new baseline is the revision the ticket captured. Refresh also changes only
the baseline. Acceptance requires user edit permission and an unlocked document both when you
take the ticket and when you complete it. The dirty flag, undo history and server version
keep their values. To persist the text, save it separately.

```ts
import type { ComparisonBaseline, ComparisonCapture, ComparisonController } from "sttropez";

export async function refreshBaseline(
    controller: ComparisonController,
    load: (capture: ComparisonCapture) => Promise<ComparisonBaseline>
): Promise<boolean> {
    const ticket = controller.beginRefresh();
    try {
        return ticket.complete(await load(ticket.capture));
    } finally {
        ticket.finish();
    }
}
```

`ComparisonReversion` also captures the comparison generation and every selection in the
initiating view. Ask for confirmation again if the text, selections, server version,
permissions or edit lock changed, even if the user regained permission. A new baseline
request, replacement tab, disposed view or newer confirmation also expires the ticket.
An empty comparison succeeds without adding an undo step. Otherwise the other views map
their selections through the same transaction.

Tickets hold a resource lease until `complete`, `cancel` or `finish()`. Capture throws when a
command is unavailable. Completing a stale ticket returns `false` and releases it. Finish and cancel
are idempotent. `isCurrent()` checks lifetime. Completion also checks edit authority. Cancel the
host fetch separately if needed.

### Baseline views and decoration

Both entries in `comparison.panes` are editor handles. Attach Find, folding and decoration providers
once. Replacing a baseline keeps the baseline editor, its settings and its view. Find reruns its
current query, and folding maps surviving ranges to the new revision. Publish decoration ranges
against the revision of the pane they describe. [Decoration layers](viewport.md#decoration-layers)

A pure insertion or deletion marks the empty side with a point at the corresponding text position.
The preview shows line numbers on the changed side and says when no text was added or removed.
Only the side containing changed text receives a changed-line background. The tint fills the
visible text area as you scroll sideways. Its change bar stays beside the gutter.
In forced colors, dashed bars and underlines mark removals and solid ones mark additions.
A bracket marks an empty change. Aligned padding has a dotted bar.

Set `--st-comparison-baseline-line` and `--st-comparison-working-line` on the host to theme the
row tints. The matching `--st-comparison-baseline-bar` and `--st-comparison-working-bar` set
the gutter-edge colors. `--st-comparison-removed` and `--st-comparison-added` set the backgrounds
behind the changed characters. Choose colors that keep your syntax tokens legible on both backgrounds.

The baseline pane is read-only. Passing a workspace document displays it directly and follows
its edits. An external baseline uses a private read-only document with Save disabled. It takes no tab
and stays out of the workspace inventory. A host lease can retain it after comparison disposal.
[Inventory visibility](workspace.md#inventory-visibility)

`comparison.activePane()` returns the last focused pane and defaults to the working editor.
Opening a toolbar leaves the command target intact. Pass shared settings at mount, then call
`configure()` on either pane for per-pane changes. [Editor settings](editor.md)

Register a review command once with `comparison.commands.register()`. Both pane palettes
list it. A shortcut passes its originating editor to the handler. A toolbar calling
`comparison.commands.run()` uses the last focused pane. Each pane keeps its own key
bindings and pending chord. Refreshing the baseline cancels any unfinished chord.

```ts
import type { TextComparison, TextEditor } from "sttropez/browser";

export function bindReviewNote(review: TextComparison, addNote: (pane: TextEditor) => void) {
    return review.commands.register({
        id: "review.note", label: "Add note", category: "Review", run: (_, pane) => addNote(pane)
    }, { keys: ["Mod+k Mod+j"] });
}
```

### Linked scrolling and aligned rows

Pass `settings: { minimap: true }` to show the [viewport minimap](viewport.md#mounting-and-presentation)
in both panes, including each replacement baseline. Each pane follows its own row projection.

With the default options, the panes scroll independently. Pass `rowsAligned: true` to line up
changes and link scrolling, or add `scrollLinked: false` to keep scrolling independent. After
mounting, turning alignment on with `setRowsAligned(true)` also links scrolling. Call `setScrollLinked(false)`
to turn linking off while keeping the rows aligned.
The comparison mount owns row publication for its captured working and baseline panes.

Linked scrolling projects vertical positions through the completed diff and each pane's folds.
Unchanged rows keep their fractional position; changed rows interpolate between captured bounds,
and insertions/deletions map to opposite anchors. Each pane clamps to its own extent. Horizontal
scroll, focus, selection, history and baseline identity are independent.

Aligned panes use the same measured line height. If you insert three lines on the right, the
grid adds three lines of padding on the left using the completed diff. An empty document keeps
line 1 at the top, with padding below it. When a pane is at the top, adding leading
padding leaves the removed or inserted first lines in view. A scrolled pane keeps
its reading position. Each pane keeps its own folds.
A row folded on one side leaves padding there. A row folded on both sides disappears
from the grid. Each collapsed header says “contains changes” when it hides part of a hunk.
Navigating to that change unfolds it in both panes. Padding contributes nothing to copied text and contains no focusable control.
Click it to select an adjacent source boundary. Arrows skip it and Page commands follow the grid.

Alignment charges one work unit per collapsed-fold boundary, comparison hunk or processed
span. Unchanged and padded spans stay compact regardless of their row count; expanded folds
and hidden nested folds require no alignment traversal. Progress exposes cumulative work.
Both panes use the completed grid. While typing leaves the visible line structure intact,
they keep that grid until the next diff supplies its replacement.

Both features wait for current comparison/view captures and settled input/navigation. Alignment
also waits for pointer gestures. Edits, baseline/fold changes, disable and disposal cancel stale
work. Disabling either feature releases its subscriptions and pending work independently.
Both features share pane render and fold subscriptions. Disabling both releases those subscriptions.
Only the visible row window creates DOM. `getDiagnostics()` exposes `scrollLinked`, `pendingScroll`, `rowsAligned`
and alignment phase/work/failure; controller readiness alone does not establish settled panes.

## Host responsibilities

Fetch and retain the baseline, attach search or language clients and store view state. Capture the
working resource explicitly for Save or Run from the baseline pane. On confirmation, check
composition and whether the user chose another version. Handle transport failures in the host.
Finish or cancel tickets and call `dispose()` on the mount before releasing host-owned views.

## Not covered

The comparison works with a baseline and a working document. If users need a three-way merge
or a conflict-resolution UI, the host supplies it. [Search and review support](README.md#support-matrix)
