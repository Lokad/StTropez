# Text comparison

`mountTextComparison` shows a baseline beside a working document. Revert restores baseline text in the
draft. Accept advances the baseline.

## Use

Size the container, load the [stylesheet](getting-started.md#open-the-first-editor) and supply a baseline.

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

Pass the working `DocumentView` as `view` to retain selection and folds. The mount disposes views it
creates. `settings` applies to both panes. Use `configure` on one. `strings` translates controls and
previews. A formatter returning `undefined` selects English. Use `controls: false` for a
[custom toolbar](../tests/fixtures/comparison/controls.ts).

## Contract

### Identity and comparison state

Mount by working document or tab ID. Moving the tab keeps the review. Closing or replacing it expires the
target. A `{ buffer, version }` baseline creates a private read-only document. A `DocumentId` baseline
follows that workspace document and uses its decimal revision as version.

Read `getSnapshot()` or `subscribe()`. A `ready` result has exact hunks for its `generation`. During a new
diff, both panes show mapped provisional markers when history permits. A new baseline clears them.

The mount reports `selectedHunk`, `canNavigate` and `canRevert`. The last focused caret selects a changed
line or exact point offset. An unchanged line or pending diff yields `null`. Run toolbar commands after
notification delivery. Disposal publishes a final snapshot with actions disabled.

### Exact text and scheduling

`TextDiff` compares lines including endings, then trims equal UTF-16 edges. Hunk text and line bounds are
half-open. `whitespaceOnly` and `lineEndingOnly` classify changes. Paired rows up to 4,096 units highlight
changed characters. Uneven or longer rows use line tints. Revert restores whole hunks.

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

Schedule turns until `ready`. A failed advance records `failed` and throws. `dispose()` releases the
retained result. Held snapshots survive.

<a id="hunk-commands-and-host-tickets"></a>

### Reverting a change or accepting a version

F7/Shift+F7 or `navigateHunk(1)`/`navigateHunk(-1)` wrap from the active caret and reveal both ranges.
Capture the snapshot on press. `revertSelectedHunk(shown)` on release focuses the working pane and refuses a
changed selection or result.

Bind a row to `hunkAt(index)`. `select()` unfolds both sides. `revert()` restores one hunk in one Undo and
places the working caret at its start. Invalid indices and pending diffs yield no handle. Editing either
side or closing expires it. Commands check composition, and revert requires write access.

| Ticket | When to use it |
| --- | --- |
| `beginRefresh()` | Before fetching an external baseline. Complete with its buffer and version. |
| `beginAcceptance()` | Complete with the captured working buffer and a version. Later edits remain visible. |
| `beginReversion()` | Before confirming reversion of all reviewed hunks in one transaction. |

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

New refreshes supersede refreshes, acceptances supersede acceptances, and a new baseline epoch expires older
tickets. Acceptance checks edit permission at capture and completion. Refresh and acceptance leave
persistence, dirty state and Undo alone.

Reversion captures both versions, generation, working selections and edit authority. Renew confirmation if
any change, even if a temporary lock has since cleared. A new baseline request or target replacement also
expires it. Empty reversion adds no history.

Unavailable capture can throw. Stale completion returns `false`. Complete, cancel or `finish()` each ticket.
`finish()` is idempotent. Cancel host fetches separately.

### Baseline views and decoration

Attach colors, folds and Find to `panes.reference` and `panes.working` using each pane’s revision. Refresh
preserves the reference editor, reruns Find and maps surviving folds. The private baseline omits Save, tabs
and public inventory. [Decorations](viewport.md#decoration-layers)

Only changed source rows get tinted. Insertions and deletions mark a point on the empty side. Theme
backgrounds with `--st-comparison-baseline-line` and `--st-comparison-working-line`, gutters with the
corresponding `-bar` variables and spans with `--st-comparison-removed` and `--st-comparison-added`.

`activePane()` tracks focus and starts on working. Register a shared command once. Shortcuts pass the
originating editor. Toolbar `commands.run` uses the active pane. Each pane has a keymap. Refresh expires
unfinished chords.

```ts
import type { TextComparison, TextEditor } from "sttropez/browser";

export function bindReviewNote(comparison: TextComparison, addNote: (pane: TextEditor) => void) {
    return comparison.commands.register({
        id: "review.note", label: "Add note", category: "Review", run: (_, pane) => addNote(pane)
    }, { keys: ["Mod+k Mod+j"] });
}
```

### Linked scrolling and aligned rows

Scrolling defaults to independent. `rowsAligned: true` aligns rows and links vertical scroll.
`scrollLinked: false` keeps alignment alone. `setRowsAligned(true)` enables linking again. Disable with
`setScrollLinked(false)`. Horizontal scroll and selections stay independent.

Alignment needs equal measured line heights. Padding fills insertions and one-sided folds. Rows folded on
both sides disappear. Navigating to a hidden change unfolds it. Padding contributes no copied text. Arrows
skip it, Page keys follow the grid and clicks select an adjacent source boundary. Each
[minimap](viewport.md#viewport-settings) follows its pane.

Linking maps through the diff and folds. Edits preserving visible line structure retain the grid during
recompute. Alignment waits for input and gestures to settle. A ready diff can precede settled panes.
`getDiagnostics()` reports pending scroll and alignment.

## Host responsibilities

Retain the baseline. Target Save and Run at the working resource regardless of focus. Finish tickets and
dispose the comparison before releasing retained views.

## Not covered

The host supplies three-way merging and conflict resolution. [Review support](README.md#support-matrix)
