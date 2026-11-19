# Text comparison

`mountTextComparison` displays an immutable reference beside an editable working document.
`createComparisonController` supplies the headless comparison and captured commands. Reference
versions, working revisions and saved/server versions are independent; the host owns retrieval,
review decisions and persistence.

## Use

Pass an open working text tab and a captured `ComparisonBaseline`. Load the packaged CSS and
provide a bounded container as described in [Getting started](getting-started.md):

```ts
import type { ComparisonBaseline, TabId, Workspace } from "sttropez";
import { mountTextComparison } from "sttropez/browser";
import type { TextComparisonOptions } from "sttropez/browser";

export function showChanges(
    host: HTMLElement, workspace: Workspace, tab: TabId, reference: ComparisonBaseline
) {
    const options: TextComparisonOptions = {
        ariaLabel: "Review changes",
        rowsAligned: true
    };
    return mountTextComparison(host, workspace, tab, reference, options); // Call dispose() when the review attachment ends.
}
```

The mount accepts `TextComparisonOptions`. The returned `TextComparison` exposes the working
editor, `controller`, reference-view access and presentation commands. Its built-in controls navigate changes, revert a selected change,
link scrolling and align rows. Supply `view` to retain a host-owned working `DocumentView`
across mounts. Destroying the comparison disposes only views it creates.
`ariaLabel` defaults to `"Text comparison"`. Set `controls: false` to mount only the two panes,
without the default toolbar, headings or whitespace preview. Host controls belong outside the
comparison's DOM subtree and use the same observable state and commands as the default controls.

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

`createComparisonController` captures a baseline containing an immutable `TextBuffer` and a
string `version`; versions are opaque host labels. The working tab must identify a live text
document. A supplied view must belong to that
document and workspace. `mountTextComparison` attaches the controller and both browser panes.
The controller retains the resource and captures the tab generation; moving a tab preserves it,
while closing or replacing the target expires it.

`ComparisonController` is an observable with immutable `ComparisonSnapshot` values:

| Field | Meaning |
| --- | --- |
| `status` | `running`, `ready`, `failed`, `expired` or `disposed` |
| `generation` | Identity of this comparison result or in-progress replacement |
| `baseline` | Buffer/version and a separate reference `epoch`, or `null` after expiry/disposal |
| `working` | Captured working document snapshot, or `null` after expiry/disposal |
| `hunks` | Exact when ready; mapped presentation from the preceding comparison while running |
| `progress`, `failure` | Current diff work counters or a failure message |

Working edits start a fresh exact comparison. Prior hunks follow a continuous transaction map
for display while that work runs. An unknown revision gap or reference replacement clears the
provisional hunks. Only a ready result authorizes hunk navigation and reversion. Completion
replaces the provisional presentation atomically; progress alone does not repaint decorations.

`TextComparison` is a stable observable of immutable `TextComparisonSnapshot` values.
Its `comparison` field is the controller's current snapshot; `selectedHunk` is an index into that
snapshot's hunks or `null`. Selection clears as soon as the comparison generation changes.
`canNavigate` and `canRevert` describe current command availability, including pane readiness,
composition and edit authority. `scrollLinked`, `alignment` (`ComparisonAlignmentSnapshot`) and
`disposed` expose presentation state. Repeated reads return the same object until a field changes.
Comparison and permission changes publish synchronously; pane attachment and alignment complete
cooperatively. Alignment work counters are sampled at publications, not published per cursor step.

Notifications permit reading state and updating host UI; queue workspace or comparison commands
until after delivery. Unsubscribe host listeners when the attachment ends. Destruction publishes
a terminal snapshot with no selection and disabled commands. Availability is advisory: commands
revalidate captures and input state when called, including direct changes to the input's
`readOnly` or `disabled` properties, which do not themselves publish comparison state.

### Exact text and scheduling

`TextDiff` compares LF-inclusive lines, then trims equal UTF-16 boundaries within changed blocks.
CRLF, LF, tabs, spaces and final newlines participate in equality. `DiffHunk` contains baseline
and working `DiffRange` values with exclusive text and line ends. `whitespaceOnly` describes a
change without suppressing it. Alignment minimizes line insertions/deletions; it does not
provide a globally minimal character diff or moved-block detection.

For direct headless use, the caller supplies scheduling between cursor steps:

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

`DiffProgress` carries immutable hunks, status (`running`, `ready`, `failed`, `disposed`), work,
read units, line edit count and a failure message. Each cursor compares its two captured buffers.
`snapshot()` reads progress without advancing. `next()` advances by a charged-work budget
(default 32,768). The caller controls when the next step runs. Only `ready` publishes the
completed hunks, including an empty array for equal text. An execution failure throws the
original cause and records `failed` with an empty hunk array.

`dispose()` clears the cursor's hunks and failure and is idempotent. Snapshots already held by callers
stay valid. Reentrant advancement or disposal throws. Terminal `next()` calls
validate the budget and return the current progress.

### Hunk commands and host tickets

`selectHunk(generation, index)` on the browser mount selects and reveals both captured ranges,
including folded bodies. It returns `false` for stale, unavailable or composing targets.
`revertHunk(generation, index)` also rejects composing, disabled or read-only browser input,
then delegates to `controller.revert(generation, index)`. Use this browser command for host UI.
The headless controller replaces that working range with its baseline text in one human
history transaction. It checks readiness, generation, revision and edit authority;
shared undo restores text and selection. A working edit clears the selected hunk.

Hosts use explicit tickets for delayed operations:

| Command | Capture and completion |
| --- | --- |
| `beginRefresh()` | Capture reference epoch/version, working snapshot and server version; complete with a fetched baseline |
| `beginAcceptance()` | Capture the working snapshot; complete with that exact buffer object and a host reference version |
| `beginReversion()` | Capture a ready result, tab, complete selection set and authority for confirmation; `complete()` reverts all reviewed hunks in one transaction |

`ComparisonTicket` exposes `capture`, `isCurrent`, `complete`, `cancel` and `finish`.
`ComparisonCapture` keeps reference identity separate from the working snapshot and captured server
version. Each newer refresh supersedes earlier refreshes; each newer acceptance supersedes
earlier acceptances. Any successful reference advancement expires tickets for the preceding
epoch. Typing during retrieval or acceptance is retained: refresh changes only the reference,
and acceptance advances it to the captured working revision. Acceptance requires human edit
permission and no edit lock at capture and completion. It does not save or alter dirty state,
history or server version.

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

`ComparisonReversion` additionally captures generation and complete initiating selections. It
expires after text/selection changes, a new reference intent, server-version or permission
transitions, edit-lock changes, tab replacement, view disposal or superseding
confirmation. Restoring permission does not revive it. An empty comparison succeeds without
adding history. Other views map through the single transaction normally.

Tickets retain resource leases until completion, cancellation or `finish()`. Completion settles
even rejected or stale results. Finish/cancel are idempotent. An unavailable command throws at
capture; a stale completion returns `false`. `isCurrent()` checks captured lifetime but does not
replace completion's validation and authority checks. Host transport cancellation and error UI
belong to the host; ending a ticket does not abort a host request automatically.

### Reference views and decoration

The reference display has its own internal read-only resource, tab and view. Its resource denies all edit
origins, Save and Run. The resource, document and tab are omitted from workspace inventories;
captured reference handles and diagnostic ownership counts remain available under the
[inventory visibility contract](workspace.md#inventory-visibility).
It shares the captured immutable buffer without exporting it. Selection,
navigation and explicit copy operate on source coordinates through the [editor](editor.md).

`referenceEditor()` and `referenceViewport()` resolve the current attachment. The stable
`reference` observable publishes `ComparisonReferenceView` with `{ editor, target, epoch, version }`.
It publishes `undefined` before releasing an old attachment, then publishes its replacement.
Queue host attachment/cleanup after notification delivery, resolve the latest handle, and cancel
queued callbacks on unmount. Refresh disposes the old editor and pending input/navigation work.
A retired reference resource stays readable while an independent view or host lease owns it.

Keep saved reference view state with its immutable buffer/version; working view state belongs
to the working document/view. [Viewport](viewport.md#scrolling-and-saved-views) describes captures.
`workingDecorate` and `baselineDecorate` receive bounded `PresentedLine` fragments and compose
with change colors. The host owns syntax/search state and calls the appropriate viewport's
`invalidate()` when it changes. Reference decorations must use the captured reference text.

### Linked scrolling and aligned rows

Pass `minimap: true` to show the [viewport minimap](viewport.md#mounting-and-presentation)
in both panes, including each replacement baseline. Each pane follows its own row projection.

`scrollLinked` and `rowsAligned` are boolean mount options. Both default to `false`; when
`rowsAligned` is true and `scrollLinked` is omitted, scrolling is linked. Use
`setScrollLinked(boolean)` and `setRowsAligned(boolean)` to change them. Enabling alignment
also enables linking; linking can then be disabled independently.
The comparison mount owns row publication for its captured working and reference panes.

Linked scrolling projects vertical positions through the completed diff and each pane's folds.
Unchanged rows keep their fractional position; changed rows interpolate between captured bounds,
and insertions/deletions map to opposite anchors. Each pane clamps to its own extent. Horizontal
scroll, focus, selection, history and reference identity are independent.

Aligned rows add empty padding to the shorter side of changed blocks, using a common measured
line height. The grid reuses the completed diff and does not perform another text search. Folds
stay independent: a row hidden on one side becomes padding there; a row hidden on both is omitted.
Padding contains no source text, clipboard content or focusable controls. Clicking it selects
an adjacent source boundary; arrows skip it and Page commands follow the visual grid.

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

Own reference retrieval, acceptance/discard confirmation, transport failures, Save/Run policy,
provider/search attachments and view-state storage. Guard host composition and any newer version
selection intent across delayed confirmations. Capture the working resource explicitly for host
commands invoked from the reference or surrounding controls. Dispose subscriptions and tickets
with their owners. Call `dispose()` for a browser comparison or `dispose()` for a headless
controller; then release host-owned views/resources at their own lifetime boundary.

## Not covered

See the [support matrix](README.md#support-matrix) for unsupported features and device checks.
