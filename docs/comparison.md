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
    return mountTextComparison(host, workspace, tab, reference, options); // Call destroy() when the review attachment ends.
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
    const render = () => { button.disabled = !review.state.getSnapshot().canRevert; };
    const restore = () => {
        const state = review.state.getSnapshot();
        if (state.selectedHunk !== null) review.revertHunk(state.comparison.generation, state.selectedHunk);
    };
    const stop = review.state.subscribe(render);
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

`TextComparison.state` is a stable observable of immutable `TextComparisonSnapshot` values.
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
read units, line comparisons, line edit count and a failure message. `TextDiff.snapshot()`
reads progress without advancing. Only `ready` publishes completed hunks; an empty array is
a valid completed comparison. Execution failures throw their original cause, record `failed`
and publish no partial hunks. A job can retain one exact text span to avoid repeating a
literal scan during row comparison and hunk trimming; reuse requires the same captured
buffers and alignment. Completion, failure and disposal release temporary line identities
and the retained text span.
`dispose()` clears the cursor's hunks and failure and is idempotent; hunks retained by the caller
stay valid. Reentrant advancement or disposal throws. Terminal `next()` calls validate the
budget and return progress without resuming work.

`DiffReferenceCache` can be passed as the third `TextDiff`
argument to reuse reference metadata, the latest working index and bounded exact equal-row
ranges from a completed comparison. Ranges retain their working capture until replaced;
across edits, only complete rows outside an ownership-proven changed interval are reused.
A comparison can reuse exact ranges it establishes earlier in the same job. These facts
become available to later jobs only when the captured comparison completes successfully.
Cached equality does not choose new partitions. After bounded frontier work, a comparison
can resolve a region directly when all shared exact short-row occurrences pair in order.
Unique common tokens establish this directly. Duplicated tokens require identical complete
sequences after excluding rows absent from the other side; unequal common occurrence counts
or crossed order retain the general alignment. These passes examine at most 65,536 rows per
side and decline rows without short tokens.

An expensive completed comparison can retain its raw line regions and complete reference
alphabet. A later capture reuses that alignment directly when row count is unchanged and every
old/new row in an ownership-proven changed window is absent from the reference. Affected
regions receive fresh character trimming and whitespace classification; untouched later hunks
shift by the exact UTF-16 offset delta. Retention is bounded to 65,536 rows per side and 4,096
regions; verification checks at most 256 changed rows.

A completed ordered-common alignment can also certify a unique matching attaining the global
shared-occurrence bound. Certification adds an optional bounded linear pass to the initial
comparison. It stops when its work exceeds the alignment work already performed by one
cooperative advance, so a small changed region cannot force a full scan of large trimmed spans.
It retains one immutable reference count/first-occurrence index with at most 65,536 entries and
at most 256 nonzero working counts differing from their reference counts. Later edits update
only affected counts. Unchanged tokens with balanced old/new counts anchor a local repair;
each anchor search inspects at most 256 rows, and the changed and local windows contain at most
256 rows per side. A local longest-common-subsequence calculation accepts only a unique matching
attaining the updated global bound, preserving the complete canonical alignment. Its transient
numeric storage is at most 257 × 257 + 2 × 257 unsigned 16-bit cells. Untouched raw regions and
hunks retain their origins, shifting working text and line ranges by the exact deltas.
These indexes and metadata are separate from the frontier/split numeric-storage cap.
Unknown tokens, ambiguous matches, unmet bounds and oversized captures retain the exact general
alignment. Local repair does not relabel older frontier/split proofs with a newer working buffer.

The cache can also retain up to eight frontier checkpoints from the first bisection of an
expensive completed comparison. Geometric distances and the latest intermediate multiple of
64, through distance 2048, share the existing storage cap. A later job can resume
a checkpoint when the reference/trimmed region agree and ownership proves that every earlier
move validation and equality probe stays strictly outside the changed rows in both directions.
Each direction can also resume independently when its own dependency proof holds and the
completed region's exact edit distance excludes every earlier possible overlap after the edit.
Overlap checks and new checkpoint capture wait until both directions reach the same wave phase.
This includes row-count changes and new matches; affected decisions are recomputed. Verification
bounds the changed window to 256 rows on each side and captures to 65,536 rows per side. Whole-region
alphabet shortcuts are rechecked after an edit. Unproved or overlapping frontiers restart normally.
Copying retained vectors is charged cooperative work; cache reuse preserves canonical hunk choices.

A complete checkpoint can also project its live wave after one extra working row when every
changed old/new row has no reference match. The reference and trimmed bounds must agree, and
stored dependency extents must exclude boundary overflow. The projected values belong to the
current working capture. They can resume ordinary search, but cannot be projected again until
ordinary search supplies the missing preceding wave. Unknown tokens or unproved bounds decline.

Up to 32 completed bisection splits can also be retained, selected by their original work.
A split is reusable only when both reference bounds match and ownership proves its entire
working region unchanged, with suffix coordinates shifted by the exact row delta. These
splits also record their exact region edit distance. A recursive comparison can reuse a
parent frontier direction when its reference and working anchor match and every earlier
move validation and equality probe fits inside the child's unchanged region on both axes.
Owned intersections with retained split regions bound the new edit distance and exclude
earlier overlaps. A newly selected canonical split also supplies the exact distances of its
two children. The direction resumes from a fresh vector copy; child waves are not retained.
Split records share a 64 KiB numeric-storage cap with frontier vectors; older frontier checkpoints
are dropped to respect that cap. Indexes, text captures and other cache metadata are separate.
Whole-region shortcut results are recomputed. Lookup, storage and copying count as cooperative
work; replay preserves the existing canonical split choices.

A warm child search can also certify its exact split when every reference row whose token
occurs in the working region forms a subsequence of that region. Earliest prefix and latest
suffix matches select the same canonical midpoint as the general search. It reuses the
complete token facts from the preceding alphabet check and only attempts certification when
a conservative scan-cost bound fits the remaining search work proved by known distances.
Speculative child attempts share a budget equal to the work already spent through the normal
first bisection, with at most one cooperative advance of overshoot. A failed or exhausted
attempt falls back to the general search. A successful child certificate preserves the current
root capture's retention eligibility through later edits.

After a changed working window contains a short token present in the reference, an optional
certificate can also resolve one contiguous working-token run of at most 256 rows. It requires
every other matchable reference row, at least two such rows between consecutive optional
reference occurrences, and exactly one optional occurrence that embeds with all required rows.
Ambiguous tokens, separated working runs or unmet embedding/distance bounds decline. Admission
counts only guaranteed remaining work, including interior-cell checks on waves that cannot
reach a document boundary under the known minimum distance. Eligibility uses the captured
changed window and complete reference alphabet.

The root can derive its own exact optimum from the same optional-run certificate. When a
captured matchable edit has a distance lower bound extending beyond the last retained
checkpoint, the existing alphabet scans also collect reference counts and contiguous working
runs. Only complete facts from that region are used. The root first preserves every ordinary
current checkpoint through the final retained distance, then attempts certification if its
reduced scan-cost bound fits the remaining guaranteed search work. Incomplete facts, ambiguous
matches and insufficient remaining work keep the ordinary search.

A captured removal of one complete working row can also admit one omitted matchable reference
row. The certificate requires at least three other matchable rows between optional occurrences,
failure to embed all required rows, and exactly one reference-row omission that permits the
remaining rows to embed. Its prefix/suffix gap is at most 256 working rows, and the optional
occurrence must be unique. The same profile pair is repaired in place; incomplete or
ambiguous proofs decline. Prepared comparison-length sums bound the extra scans without
rereading token metadata. Admission waits for every ordinary root checkpoint and fits
the guaranteed remaining work; retained storage and current-capture publication are unchanged.

When no optional run is eligible, a captured removal can instead certify one uniquely omitted
row among all matchable reference rows. Failure to embed the full sequence and a unique feasible
omission establish the exact optimum. This path shares the same profile repair, bounded gap,
root checkpoints and admission budget; ambiguous optional candidates retain ordinary search.

Certificates examine at most 65,536 rows per side. A temporary profile set contains at most
65,536 byte flags and two 65,537-entry unsigned 32-bit vectors, plus bounded token references
and alphabet metadata. This temporary state is not published in the cache and is separate
from its retained frontier/split cap. Shortcuts that return a complete alignment retain their
precedence; this certificate does not make unproved partial hunks authoritative.

The root can also certify all required reference matches when a projected current checkpoint plan is available
and conservative scan/copy costs fit the proved remaining search work. Its matchable reference
row count must agree with the independently known optimum. A successful root disables speculative
child attempts. Either a certified root or child keeps its one profile pair through its subtree.
Each sufficiently expensive descendant inherits one profile and recomputes the other inside its bounds; shared boundary slots
are restored for the queued sibling. Saved exact splits retain their points while preparing
the inherited profile, and cheap subtrees use ordinary search. The same numeric profile bound
applies throughout the job. Profiles never enter the retained cache; completed splits and
ordinary or projected checkpoints retain their actual current capture and the shared 64 KiB cap.

Failed or cancelled jobs cannot publish a retained plan. Complex comparisons can require full
alignment work. Dispose the cache
when its owner ends. Reference replacement resets retained captures; active jobs keep their own
captures, and late jobs cannot replace a newer cache result. The controller owns its cache.
A disposed cache cannot start a new diff job.

| Limit or setting | Contract |
| --- | --- |
| `TextDiff.next`, controller `advance` | Default budget 32,768; safe integer at least 256; invalid budgets throw before progress changes |
| Browser `workBudget` | Default 4,096; validates the same range, then caps each advance at 4,096 |
| Browser diff scheduling | Up to 32 advances per task, stopping after an advance reaches the cooperative 4 ms target |
| Browser row alignment | 256 charged units per advance; at most 4,096 per task, checking the cooperative 4 ms target after each advance |
| Source reads | Bounded chunks and reusable immutable line metadata; no whole-document string export for comparison |
| Worst-case work | Difficult repeated-line inputs can require quadratic alignment work; unproved equal spans can require linear reads |
| Reversion | Inserted hunk text is materialized and the final workspace transaction runs synchronously |
| Selected-change preview | At most 160 source UTF-16 units per side, with visible whitespace markers and truncation |

Shared-storage edge proofs charge one work unit per node-pair decision, including branch
descents and unproved leaves. Text reads and line alignment retain their separate work charges.
Cached first-row lengths or known hashes can reject equality before an edge proof; each probe
charges one work unit. Matching hashes never establish text equality.
Work budgets bound cooperative work units, not elapsed time. Allocation, publication, rendering
and individual batches can exceed a scheduling target. Browser `snapshot()` exposes work and
presentation state; the [clock glossary](README.md#glossary) defines its advance-loop timings.
A headless controller requires explicit `advance()` calls until ready; the browser mount
schedules them automatically. Mutating commands run outside workspace notification callbacks.

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
transitions, edit-lock/agent-ownership changes, tab replacement, view disposal or superseding
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
Only the visible row window creates DOM. `snapshot()` exposes `scrollLinked`, `pendingScroll`, `rowsAligned`
and alignment phase/work/failure; controller readiness alone does not establish settled panes.

## Host responsibilities

Own reference retrieval, acceptance/discard confirmation, transport failures, Save/Run policy,
provider/search attachments and view-state storage. Guard host composition and any newer version
selection intent across delayed confirmations. Capture the working resource explicitly for host
commands invoked from the reference or surrounding controls. Dispose subscriptions and tickets
with their owners. Call `destroy()` for a browser comparison or `dispose()` for a headless
controller; then release host-owned views/resources at their own lifetime boundary.

## Not covered

See the [support matrix](README.md#support-matrix) for unsupported features and device checks.
