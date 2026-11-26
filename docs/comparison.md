# Text comparison

`mountTextComparison` shows a baseline beside an editable working document. Revert restores
baseline text in the working document. Accept updates the baseline. The host owns persistence.

## Use

Give the container a height and load the [editor stylesheet](getting-started.md#open-the-first-editor).
Pass a baseline buffer and version, or the ID of a baseline document in the workspace.

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

Pass the working `DocumentView` as `view` to retain its selection and folds on close.
The mount disposes views it creates. Use `settings` for both panes and `configure` for one.
`strings` translates headings, commands, hints and previews. A formatter can return
`undefined` for the English default. Set `controls: false` for a custom toolbar.
[Toolbar example](../tests/fixtures/comparison/controls.ts)

## Contract

### Identity and comparison state

Mount by working document or tab ID. Moving a tab keeps the review. Replacing or closing it
expires the captured target. Keep baseline identity, working revision and server version separate.

| Baseline | Lifetime |
| --- | --- |
| `{ buffer, version }` | The host supplies the version and refreshes the baseline. StTropez creates a private read-only document. |
| `DocumentId` | The comparison follows the workspace document, using its decimal revision as the version. Edit that document to change the baseline. |

The controller publishes immutable snapshots through `getSnapshot()` and `subscribe()`.
A `ready` snapshot has exact hunks for its `generation`. Typing starts another diff. While
`running`, both panes show mapped markers from the prior result when possible. A new baseline
or missing revision history clears them. Treat those markers as provisional.

The mounted view also reports `selectedHunk`, `canNavigate` and `canRevert`. Selection follows
the last focused pane’s caret on a changed line. A point change requires its exact offset.
A pending diff or unchanged line gives `null`. Observe command availability in a toolbar and
invoke after notification delivery. Disposal publishes a final snapshot with no available action.

### Exact text and scheduling

`TextDiff` compares lines including their endings, then trims equal UTF-16 edges within changed
blocks. Whitespace and final newlines count. `DiffHunk` ranges have exclusive text and line ends.
`whitespaceOnly` and `lineEndingOnly` identify changes. Equal-row replacements highlight changed
characters per row, up to 4,096 UTF-16 units per paired row. Uneven or longer rows use line tints.
Revert always restores the whole hunk.

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

Advance the cursor until `ready`, scheduling between steps. A failed advance records `failed`
and throws. `dispose()` releases its retained result. Snapshots already held remain valid.

<a id="hunk-commands-and-host-tickets"></a>

### Reverting a change or accepting a version

F7 and Shift+F7 wrap through changes from the active caret and reveal both ranges. For custom
controls call `navigateHunk(1)` or `navigateHunk(-1)`. Capture `comparison.getSnapshot()` on
button press and pass it to `revertSelectedHunk(shown)` on release. The command focuses the
working pane before reverting. It returns `false` if the selected hunk or comparison result changed.

For a specific change, bind the row to `comparison.hunkAt(index)`. Its `select()` unfolds and
reveals both sides. `revert()` restores that hunk in one Undo and puts the working caret at its
start. An invalid index or pending diff yields no handle. Editing either side or closing the
view expires it. Browser commands check composition and revert checks write access.

| Ticket | Completion |
| --- | --- |
| `beginRefresh()` | For an external baseline, capture before fetching. Complete with the fetched buffer and version. |
| `beginAcceptance()` | For an external baseline, complete with the **captured working buffer** and a version. Later edits appear in the working pane. |
| `beginReversion()` | Capture a ready result before confirmation. Complete to restore all reviewed hunks in one working transaction. |

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

A newer refresh supersedes a refresh, and a newer acceptance supersedes an acceptance. Advancing
the baseline expires tickets for its old epoch. Acceptance needs edit permission at capture and
completion. Neither refresh nor acceptance saves, changes dirty state or adds an Undo step.

Reversion captures both versions, the result generation, working selection set and edit authority.
Ask again after any of them changes, including a lock acquired and released during confirmation.
A new baseline request or replaced target also expires it. An empty revert creates no history.

Capture can throw when unavailable. Stale completion returns `false`. Complete, cancel or finish
each ticket to release its lease. `finish()` is idempotent. Cancel the host fetch separately.

### Baseline views and decoration

Attach Find, folding and colors to `comparison.panes.reference` and `comparison.panes.working`.
An external baseline refresh keeps the same editor and view. Find reruns its query and surviving
folds follow edits. Publish decorations against each pane’s own revision. The private baseline
resource has Save disabled and stays out of tabs and public inventory. [Decoration layers](viewport.md#decoration-layers)

Insertions and deletions mark the empty side with a point. Only changed source rows get a tint.
Use `--st-comparison-baseline-line` and `--st-comparison-working-line` for row backgrounds, the
corresponding `-bar` variables for gutters, and `--st-comparison-removed` and
`--st-comparison-added` for inline changes.

`activePane()` returns the last focused editor, initially the working pane. Register a shared
review command once. A shortcut passes its originating editor. A toolbar’s `commands.run` uses
the active pane. Each pane has its own keymap and unfinished chords expire on baseline refresh.

```ts
import type { TextComparison, TextEditor } from "sttropez/browser";

export function bindReviewNote(comparison: TextComparison, addNote: (pane: TextEditor) => void) {
    return comparison.commands.register({
        id: "review.note", label: "Add note", category: "Review", run: (_, pane) => addNote(pane)
    }, { keys: ["Mod+k Mod+j"] });
}
```

### Linked scrolling and aligned rows

By default each pane scrolls independently. `rowsAligned: true` aligns changed rows and links
vertical scrolling. Add `scrollLinked: false` to align without linking. At runtime,
`setRowsAligned(true)` also enables linking. `setScrollLinked(false)` then decouples scrolling.
Each pane keeps its own horizontal position and selection.

Alignment requires equal measured line heights. Inserted lines on one side add padding on the
other. Rows folded on both sides disappear. A fold on one side can have padding opposite visible
source. Navigating to a hidden change unfolds it. Padding adds no clipboard text. Arrows skip
it, Page keys follow the grid, and a click selects an adjacent source boundary. A minimap in
either pane uses that pane’s projection. [Minimap settings](viewport.md#viewport-settings)

Linking maps vertical positions through the diff and each pane’s folds. Edits that preserve the
visible line structure keep the grid until the new diff is ready. Alignment waits for settled
input and pointer gestures. A ready controller can precede settled panes. Use `getDiagnostics()`
to inspect pending scroll and alignment work.

## Host responsibilities

Choose and retain the baseline. Save or Run targets the explicit working resource, even when
the baseline has focus. Finish tickets and dispose the comparison before releasing retained views.

## Not covered

The host supplies three-way merging and conflict resolution. [Review support](README.md#support-matrix)
