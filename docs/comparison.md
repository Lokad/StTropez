# Text comparison

Pass a saved version to `mountTextComparison` to review it beside the working document. The host
chooses the baseline and saves accepted changes. For a headless diff, use the stepped `TextDiff`
cursor. [Exact text and scheduling](#exact-text-and-scheduling)

## Use

Pass the working document and its `ComparisonBaseline`. Give the container a height and load the
editor stylesheet. [Page setup](getting-started.md#open-the-first-editor)

The panes stack at window widths of 700 CSS pixels or less. The selected-change preview scrolls
within its share of the panel (up to 4.5 rem), so moving the caret keeps the pane heights steady.
Identical files use the full space.

```ts
import type { ComparisonBaseline, DocumentId, Workspace } from "sttropez";
import { mountTextComparison } from "sttropez/browser";
import type { TextComparisonOptions } from "sttropez/browser";

export function showChanges(
    host: HTMLElement, workspace: Workspace, documentId: DocumentId, baseline: ComparisonBaseline
) {
    const options: TextComparisonOptions = {
        ariaLabel: "Révision",
        rowsAligned: true,
        strings: {
            previousChange: "Précédente",
            nextChange: "Suivante",
            useBaseline: "Rétablir",
            statusText: ({ selectedHunk, comparison }) => selectedHunk === null
                ? undefined : `Différence ${selectedHunk + 1} sur ${comparison.hunks.length}`,
        },
    };
    return mountTextComparison(host, workspace, documentId, baseline, options); // Call dispose() when the review attachment ends.
}
```

Pass a working `DocumentView` as `view` to keep its selection and folds on close. The mount
disposes the views it creates. The toolbar navigates and restores changes, links scrolling and
aligns rows. Its change counter uses the browser’s number format.

`ariaLabel` defaults to `"Text comparison"`. Set `strings` to a partial `TextComparisonStrings` to
translate pane names, headings, commands, hints and previews. Both command lists use the labels even
with `controls: false`. Formatters return plain text synchronously, or `undefined` for the English
default. Excerpt formatters receive the side, original hunk range and bounded, whitespace-marked text.

For a custom toolbar, pass `controls: false` and put buttons outside the panes. Capture the target
on press if activation happens on release. [Custom toolbar example](../tests/fixtures/comparison/controls.ts)

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

Typing starts a diff. Until it finishes, both panes show mapped change markers and the toolbar
keeps its last preview, with “Updating…” for a longer comparison. A baseline change clears the
preview and markers. A revision-history gap also clears the markers. Both panes replace the markers
when the result is ready. Progress alone does not repaint.

`TextComparison.getSnapshot()` returns the same immutable `TextComparisonSnapshot` until a field
changes. Its `comparison` is the controller snapshot. `selectedHunk` follows the last focused
pane’s caret, including anywhere on a tinted line or a selection covering the line ending. An empty
change requires its exact offset. An unchanged line or pending result gives `null`. Before either
pane receives focus, navigation starts at the initial caret.

Bind buttons to `canNavigate` and `canRevert`, which check pane readiness, composition and edit
permission as applicable. `scrollLinked`, `alignment` (`ComparisonAlignmentSnapshot`) and `disposed`
describe the panes. Permission and comparison changes publish synchronously. Pane attachment and
alignment can take several turns. Read snapshots during notification and run commands after delivery.
Commands recheck their captures at invocation. Direct changes to the DOM input’s `readOnly` or
`disabled` property do not publish. Disposal publishes a final snapshot with no available command
or selected hunk.

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

`navigateHunk(1)` and `navigateHunk(-1)` wrap from the active caret and position both carets at the
first changed line. Each pane binds `comparison.nextChange` to F7 and `comparison.previousChange`
to Shift+F7. Rebind either in that pane’s keymap. Shortcuts preserve focus. Clicking a navigation
button returns focus to the last active pane. Keyboard activation keeps focus on the button.
Clicking a disabled button preserves editor focus.

`revertSelectedHunk()` restores the change at the caret and focuses the working editor. For a
button or dialog, capture `comparison.getSnapshot()` on press and pass it to
`revertSelectedHunk(shown)`. A changed target or comparison returns `false`.

To act on a particular change, retain `comparison.hunkAt(index)` through confirmation. A pending
diff or invalid index gives `undefined`. The handle’s `select()` reveals both ranges and unfolds
them. Its `revert()` restores the baseline text in one Undo step and places the working caret at
the start. Either action returns `false` after an edit to either side or after close. Browser
actions check composition, and revert also checks write access. Headless hosts can call
`controller.hunkAt(index)?.revert()`. Undo restores the text and selection.

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

export function bindReviewNote(comparison: TextComparison, addNote: (pane: TextEditor) => void) {
    return comparison.commands.register({
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
