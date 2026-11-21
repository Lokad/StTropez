# Text comparison

To review unsaved edits, pass the last saved text to `mountTextComparison`. It displays that
reference beside the editable document and keeps it fixed as the user types. Use
`createComparisonController` if you only need the diff. Your application fetches versions,
chooses which changes to accept and saves the result.

## Use

Pass the working document and its `ComparisonBaseline`. Give the container a height and load the
editor stylesheet. [Page setup](getting-started.md#open-the-first-editor)

```ts
import type { ComparisonBaseline, DocumentId, Workspace } from "sttropez";
import { mountTextComparison } from "sttropez/browser";
import type { TextComparisonOptions } from "sttropez/browser";

export function showChanges(
    host: HTMLElement, workspace: Workspace, documentId: DocumentId, reference: ComparisonBaseline
) {
    const options: TextComparisonOptions = {
        ariaLabel: "Review changes",
        rowsAligned: true
    };
    return mountTextComparison(host, workspace, documentId, reference, options); // Call dispose() when the review attachment ends.
}
```

The toolbar lets you navigate changes, revert one, link scrolling and align rows. The
`ariaLabel` option defaults to `"Text comparison"`. Pass your working `DocumentView` through `view` to keep
its selection and folds when you close the comparison. The mount disposes only views it creates.

For your own toolbar, set `controls: false`. This gives you just the two panes. Put your controls
outside their DOM subtree. The returned `TextComparison` exposes the working editor, reference
view, `controller` and the same commands the built-in toolbar uses.

```ts
import type { TextComparison } from "sttropez/browser";

export function bindRestoreButton(button: HTMLButtonElement, review: TextComparison) {
    const render = () => { button.disabled = !review.getSnapshot().canRevert; };
    const restore = () => {
        const state = review.getSnapshot();
        if (state.selectedHunk !== null) review.revertHunk(state.comparison.generation, state.selectedHunk);
    };
    const stop = review.subscribe(render);
    button.addEventListener("click", restore); render();
    return () => { stop(); button.removeEventListener("click", restore); };
}
```

## Contract

### Identity and comparison state

Pass a working document or text tab to `createComparisonController`. A supplied view must belong
to that workspace and document. Moving a tab preserves the comparison. Closing or replacing a
captured tab expires it.

For an external reference, supply a `TextBuffer` and opaque `version`. Alternatively, pass the
reference’s `DocumentId`. The headless controller retains both documents, follows each reference
revision, and uses its decimal revision as the baseline version. Editing either document expires
old hunk commands. Refresh and acceptance tickets apply to external references.
`mountTextComparison` attaches the controller and panes for a browser review.

`ComparisonController` is an observable with immutable `ComparisonSnapshot` values:

| Field | Meaning |
| --- | --- |
| `status` | `running`, `ready`, `failed`, `expired` or `disposed` |
| `generation` | Identity of this comparison result or in-progress replacement |
| `baseline` | Buffer/version and a separate reference `epoch`, or `null` after expiry/disposal |
| `working` | Captured working document snapshot, or `null` after expiry/disposal |
| `hunks` | Exact when ready; mapped presentation from the preceding comparison while running |
| `progress`, `failure` | Current diff work counters or a failure message |

Each edit starts a new diff. You may see old change markers move with the text while StTropez
recomputes the hunks. A gap in revision history or a new reference clears those markers.
When the diff is ready, StTropez replaces them all at once and enables navigation and reversion.
A change to the progress count alone doesn't repaint the panes.

Subscribe to `TextComparison` for a `TextComparisonSnapshot`. Repeated reads return the same
immutable object until a field changes. Its `comparison` field holds the controller snapshot.
`selectedHunk` indexes that snapshot's hunks, or is `null`. A new generation clears the selection.
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
Alignment minimizes line insertions/deletions; it does not
provide a globally minimal character diff or moved-block detection.

If you use `TextDiff` directly, your caller decides when to take the next step.

```ts
import { TextDiff } from "sttropez";
import type { DiffProgress, TextBuffer } from "sttropez";

export function* compareText(reference: TextBuffer, working: TextBuffer): Generator<DiffProgress> {
    const diff = new TextDiff(reference, working);
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

`selectHunk(generation, index)` reveals and selects both ranges, unfolding them if needed. It
returns `false` for a stale, unavailable or composing target. In browser UI, use
`revertHunk(generation, index)`. It also checks disabled and read-only inputs before calling
`controller.revert(generation, index)`. The controller checks readiness, generation, revision and
edit permission, then restores the baseline range in one human history transaction. Undo restores
the text and selection. The built-in **Use baseline** button focuses the working editor so you can
undo or type there immediately. A working edit clears the hunk selection.

Take a ticket before fetching a reference or asking the user to confirm a change.

| Command | Capture and completion |
| --- | --- |
| `beginRefresh()` | Capture reference epoch/version, working snapshot and server version; complete with a fetched baseline |
| `beginAcceptance()` | Capture the working snapshot; complete with that exact buffer object and a host reference version |
| `beginReversion()` | Capture a ready result, tab, complete selection set and authority for confirmation; `complete()` reverts all reviewed hunks in one transaction |

`ComparisonTicket` exposes `capture`, `isCurrent`, `complete`, `cancel` and `finish`. Its
`ComparisonCapture` records the reference identity, the working snapshot and the server version
separately. Starting a refresh supersedes an earlier refresh. The same rule applies to two
acceptances. When the reference advances, all tickets for its previous epoch expire.

If a user types another line while acceptance is pending, that line stays in the working pane
as an edit. The new reference is the revision the ticket captured. Refresh also changes only
the reference. Acceptance requires user edit permission and an unlocked document both when you
take the ticket and when you complete it. The dirty flag, undo history and server version
keep their values. To persist the text, save it separately.

```ts
import type { ComparisonBaseline, ComparisonCapture, ComparisonController } from "sttropez";

export async function refreshReference(
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
permissions or edit lock changed, even if the user regained permission. A new reference
request, replacement tab, disposed view or newer confirmation also expires the ticket.
An empty comparison succeeds without adding an undo step. Otherwise the other views map
their selections through the same transaction.

Tickets hold a resource lease until `complete`, `cancel` or `finish()`. Capture throws when a
command is unavailable. Completing a stale ticket returns `false` and releases it. Finish and cancel
are idempotent. `isCurrent()` checks lifetime. Completion also checks edit authority. Cancel the
host fetch separately if needed.

### Reference views and decoration

The reference pane reads directly from the captured immutable buffer. Select, navigate and copy
using the same source coordinates as the [editor](editor.md). Its internal resource rejects
every edit origin, Save and Run. Workspace inventories omit that resource, its document and tab.
You can inspect a captured reference handle and the diagnostic ownership counts.
[Inventory visibility](workspace.md#inventory-visibility)

`referenceEditor()` and `referenceViewport()` resolve the current attachment. The stable
`reference` observable publishes `ComparisonReferenceView` with `{ editor, target, epoch, version }`.
It publishes `undefined` before releasing an old attachment, then publishes its replacement.
Queue host attachment/cleanup after notification delivery, resolve the latest handle, and cancel
queued callbacks on unmount. Refresh disposes the old editor and pending input/navigation work.
A retired reference resource stays readable while an independent view or host lease owns it.

Apply [viewport settings](viewport.md#mounting-and-presentation) such as rulers, ligatures and
current-line highlighting to `comparison.working.viewport` and the current reference editor’s
viewport. Reapply them when `comparison.reference` publishes a replacement. The comparison mount
accepts `TextComparisonOptions`. It does not forward arbitrary source-editor construction options.

Keep saved reference view state with its immutable buffer/version; working view state belongs
to the working document/view. [Viewport](viewport.md#scrolling-and-saved-views) describes captures.
Each pane owns its change colors. Add [decoration layers](viewport.md#decoration-layers) to
`working.decorations` and to the editor in the current `reference` snapshot. Attach fresh layers
when the reference changes and publish ranges against that reference document's revision.

### Linked scrolling and aligned rows

Pass `settings: { minimap: true }` to show the [viewport minimap](viewport.md#mounting-and-presentation)
in both panes, including each replacement baseline. Each pane follows its own row projection.

With the default options, the panes scroll independently. Pass `rowsAligned: true` to line up
changes and link scrolling, or add `scrollLinked: false` to keep scrolling independent. After
mounting, turning alignment on with `setRowsAligned(true)` also links scrolling. Call `setScrollLinked(false)`
to turn linking off while keeping the rows aligned.
The comparison mount owns row publication for its captured working and reference panes.

Linked scrolling projects vertical positions through the completed diff and each pane's folds.
Unchanged rows keep their fractional position; changed rows interpolate between captured bounds,
and insertions/deletions map to opposite anchors. Each pane clamps to its own extent. Horizontal
scroll, focus, selection, history and reference identity are independent.

Aligned panes use the same measured line height. If you insert three lines on the right, the
grid adds three lines of padding on the left using the completed diff. Each pane keeps its own
folds. A row folded on one side leaves padding there. A row folded on both sides disappears
from the grid. Padding contributes nothing to copied text and contains no focusable control.
Click it to select an adjacent source boundary. Arrows skip it and Page commands follow the grid.

Alignment charges one work unit per collapsed-fold boundary, comparison hunk or processed
span. Unchanged and padded spans stay compact regardless of their row count; expanded folds
and hidden nested folds require no alignment traversal. Progress exposes cumulative work.
Both panes use the completed grid; partial row indexes are not installed.

Both features wait for current comparison/view captures and settled input/navigation. Alignment
also waits for pointer gestures. Edits, reference/fold changes, disable and disposal cancel stale
work. Disabling either feature releases its subscriptions and pending work independently.
The active features share pane render/fold observation; disabling both releases that optional
observation. Reference replacement detaches the old pane before disposal and binds the new pane
once. Composition and reference focus handling follow the pane's lifetime.
Only the visible row window creates DOM. `getDiagnostics()` exposes `scrollLinked`, `pendingScroll`, `rowsAligned`
and alignment phase/work/failure; controller readiness alone does not establish settled panes.

## Host responsibilities

Fetch and retain the reference, attach search or language clients and store view state. Capture the
working resource explicitly for Save or Run from the reference pane. On confirmation, check
composition and whether the user chose another version. Handle transport failures in the host.
Finish or cancel tickets and call `dispose()` on the mount or headless controller before releasing
host-owned views.

## Not covered

The comparison works with a reference and a working document. If users need a three-way merge
or a conflict-resolution UI, the host supplies it. [Search and review support](README.md#support-matrix)
