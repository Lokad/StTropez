# Versioned text comparison

`createComparisonController` compares an immutable reference buffer/version with a captured
working text tab. `mountTextComparison` displays both through bounded viewports and uses
the experimental input candidate on both sides: editable working text and a read-only reference. `/comparison/` supplies deferred,
synthetic host responses. No retrieval, persistence, execution or application service is
included in the package.

During a working edit, the last review hunks follow that transaction's position mapping and
remain visible while exact alignment is recomputed. `status: "running"` identifies these
provisional hunks: they describe retained presentation, not a current edit plan. Typing at a
change boundary is included; deletion can merge adjacent projected ranges. Progress updates
preserve this capture, and completion replaces it atomically. Reference replacement or a gap
in document revision history clears it. Navigation and reversion require a ready comparison
and its current generation; provisional colors never authorize a stale edit.
Comparison observes the working document, its metadata and tab lifecycle rather than the
workspace-wide store.

The reference version, reference epoch, working resource ID, document revision, tab
generation and view selection have separate meanings. Moving a tab preserves the comparison;
closing or replacing it expires the captured presentation. Baseline display resources have
their own identity and deny editing from every origin, saving and execution. They retain
the existing `TextBuffer` through `createTextResourceFromBuffer`, without a string export.

Browser mounts accept an optional host-owned working `DocumentView`, as the core controller
already does. Destroying such a mount releases its jobs, DOM and reference display resource,
while leaving that view registered for revision-mapped selection updates. The host disposes
the view at its own lifetime boundary. Reference display views remain mount-owned; restoring
their scroll and selection requires the same immutable reference buffer and version. Use
`referenceEditor()` for the current read-only candidate and its `focus`, `captureView`, `restoreView`
and pending-input snapshot; `referenceViewport()` remains available for view geometry. Reference
replacement disposes the old candidate and its pending navigation, pointer and input work. Callers
must resolve the current handle after refresh. Focusing the reference viewport also enters its input.
The stable `reference` observable publishes an immutable `{ editor, target, epoch, version }`
reference-view handle. `target` is the captured tab identity; it is separate from the buffer version,
view and document revision. The observable publishes `undefined` before releasing an old editor or
display resource, then publishes the replacement handle. Subscribers queue attachment and cleanup
after notification delivery, resolve the latest handle, and cancel queued callbacks when the
comparison unmounts. A retired baseline stays readable while a host lease or independent view
owns it; the workspace releases it after that last owner leaves. The comparison still releases
its own controller, editor and DOM immediately. `referenceSubscriptions` in the
comparison work snapshot supports lifecycle diagnostics.


Reference arrows, word/line/page commands, whole-source selection and pointer ranges use real
source coordinates, including beyond the rendered window. Copy reads the explicit selected source
ranges. The native textarea retains bounded context and compresses large selections; ordinary
navigation does not export the reference or render its entire selection. Read-only typing, cut,
paste and history commands cannot mutate the reference or working history. The resource denies
all edit origins, saving and execution independently of its input presentation. Selection and copy
remain available while the working source is read-only or independently edited.

The evaluation hosts route Ctrl+S from the current reference input to the captured working source.
The reference is never a save target. Run controls remain host-owned and capture the working
source/configuration. Replacing a reference cannot retarget old input events or save shortcuts.
The evaluation hosts attach Find to this reference lifecycle without creating a language-provider
session. Ctrl+F searches the immutable source, including offscreen text; Ctrl+H opens the same
read-only Find field. These Find/Replace shortcuts and F3/Shift+F3 also work from enabled controls
in the owned language/Find tool region. F3/Shift+F3 and query Enter navigate source ranges, reveal folded matches and
return to the reference input; Escape also returns there. A keyboard navigation request made
while the index is scanning retains its captured source, query/options, revision, complete selections
and focus. Only the latest pending direction is retained; expiry never redirects or refocuses a
later view. Literal, whole-word, match-case and
actual-worker regex search reuse the existing Find controller. Match previews and visible markers
stay bounded. The query/options are host UI preferences; jobs, markers and selections capture their
own reference resource and view. Replacement fields/actions are disabled, and reference commands
reject replacement independently of the UI. Working Replacement Enter can wait for its index
with captured replacement text and edit authority; field input or authority changes expire it. Working Find/replace and Save/Run retain their scope.
Ctrl/Command+S from enabled text fields, options or navigation controls in the evaluation hosts'
owned language/Find tool region uses the same captured save guard as the pane. Reference Find explicitly saves the working source; it never saves the
immutable reference. Stale, detached, unowned, disabled or composing contexts cannot start a
tool save. Disabled ancestors are respected; unrelated host forms are outside this region.
Held-key repeats do not add duplicate saves. The focused control keeps focus while saving;
later typing remains separate from the captured revision.
Reference refresh cancels its old Find/regex work. If Find still targets the reference, fresh field
input targets the replacement view; replacement alone starts no search and moves no focus.
Switching to a working view keeps that owner. Unmount releases jobs and live ownership; compatible
remount restores a dormant logical context for fresh field input, without moving focus or starting
old queries/providers. Working contexts require the same tab generation and document; reference
contexts require the same buffer/version. A replaced target requires explicit selection again.
Late results cannot target a later focused source. Final host disposal clears retained ownership.

Synthetic clipboard/composition checks exercise model guards; native OS/application clipboard,
IME/reconversion/dead-key qualification remains separate.

## Exact alignment and scheduling

`TextDiff` tokenizes LF-inclusive lines, aligns them with shortest-edit bisection, and trims
common UTF-16 boundaries within changed blocks. CRLF, LF, tabs, spaces and final newlines
remain exact. `whitespaceOnly` describes a change; it never suppresses one. Lines of at most
256 UTF-16 units retain exact strings and rejection hashes. Longer lines retain lengths and
use cooperative exact range comparisons when equality is needed; they are not hashed eagerly.
Regions with multiple unmatched lines on both sides compute long-line rejection hashes lazily,
so disjoint large blocks retain linear scanning rather than an unnecessary quadratic search.
These numeric signatures are weakly memoized by immutable line metadata and retain no buffers
on their own. No normalization or hash-only equality is introduced. Adjacent unmatched regions
coalesce before scalar trimming, so optional signatures cannot split a contiguous review hunk.

After 64 frontier distances in a region of at least 64 lines per side, alignment can check for
at most one shared exact short-line token. Its longest common subsequence is precisely the
smaller occurrence count, so greedy matching preserves the minimal line edit distance while
avoiding a large frontier for repeated-row deletion or scattered changes. The optional check
declines after 64 distinct left-side tokens, a long row, or a second shared token, then resumes
general exact bisection. Small-edit searches retain their existing ownership shortcuts. This
addresses a reproduced 100k-line review stall; it introduces no heuristic equality or dependency.

Alignment consumes maximal exact matching line prefixes and suffixes. Immutable node/backing
proofs can skip whole matching spans, including inside bisection searches. Unproved rows still
use exact comparisons, so repeated-line ties do not depend on storage identity. An unterminated
final token does not match if the other buffer extends that line. Within changed blocks, the
same ownership proofs skip equal scalar spans; unrelated storage falls back to bounded exact
reads. Cold character/Enter edits and distant edits after a tail-only warmup therefore need
not index every intervening line. Long equal text with no applicable ownership proof can still
require a linear scan. Short periodic-row candidates can use exact bounded text comparisons
instead of materializing every equal row. Candidate detection never establishes equality;
the subsequent string checks do. String-equal chunks skip the per-unit mismatch search.
Already materialized short-row metadata can prove a bounded run of equal rows directly from
their exact UTF-16 strings and lengths. Each proof stays inside the two existing immutable
metadata leaves, with at most 64 rows, and charges cooperative row work before continuing.
Runs stop at the next ownership checkpoint, including when a partial metadata leaf is traversed
in reverse, so cached strides cannot skip a proof of shared source storage.
It neither materializes missing rows nor reads source text. Hashes alone and long rows cannot
establish this proof; they retain the existing exact fallback. Ownership proofs remain first,
so shared source spans can still skip large interiors without walking every metadata block.
This is a line alignment with trimmed boundaries, rather than a globally minimal character
alignment or moved-block detection. The original TypeScript implementation reuses the
project's buffers; a general diff package would add a runtime dependency.

Core callers explicitly advance work with a safe integer budget of at least 256 units, shared
with the other work-unit cursors. Invalid budgets throw before changing the comparison or
publishing progress; the active job remains usable. Browser tasks group up to 32 advances of
32,768 work units, stopping after the first advance that reaches four milliseconds. This reduces nested
timer delays while bounding each batch's advances. Reads and comparisons yield within long
lines, and stale revision jobs are
disposed before replacement. The budget is work accounting, not a hard millisecond deadline:
allocation, garbage collection, publication and rendering can still delay a turn. Alignment
uses line metadata and linear search space; difficult repeated-line cases can take quadratic
work. No worker or WASM runtime is required.

Diff progress alone does not invalidate either viewport. A new generation or status redraws
decorations; selection and scrolling retain their viewport-owned invalidation. This avoids
repeated row work while the same captured diff is still running. The scheduling and short-line
identity changes address a reproduced large conflict-review interaction, not a new shaping
feature. Full input-to-review-ready measurements remain separate from elapsed adapter-handler
duration. Comparison advance-loop counters exclude the rest of the scheduled callback and
rendering; complete callback traces and complete interaction readiness are separate measurements.

`DiffReferenceCache` optionally retains one reference index and one most recently completed
working index across `TextDiff` jobs. Pass it as the third constructor argument and dispose it
when its owner ends. Each index captures the full buffer's row coordinates. Unvisited regions
occupy implicit gaps in a persistent sequence; offsets come from the buffer's existing line
index. Metadata blocks of at most 64 rows are built cooperatively when a probe needs them.
Only completed blocks are memoized. This private memoization changes neither source nor public
snapshots. Verified unchanged rows reuse sequence subtrees without copying every suffix offset.
The project already owns the AVL balancing implementation; this original sparse layer adds no
dependency. Exact candidate matches can decline an unnecessary disjoint-region scan. Short
string identities remain exact across jobs, without an accumulating token dictionary or reused
job-local numeric namespace.

Working reuse proves whole-line ownership against the preceding working capture. It also
works when the remote reference has independent backing. There is no working revision chain:
new indices retain only their buffer and needed metadata subtrees. Gap nodes retain no old
buffers. Replacing the reference replaces both cache captures. Partial metadata blocks are
not published, and older concurrent jobs cannot replace a newer job's cache capture. Memoized
reference metadata stays valid for every job using that immutable reference. Active jobs retain
their original captures; disposing the
cache releases future reuse and prevents new jobs from using it. The comparison controller
owns a cache and disposes it on expiration or teardown. Indexing and fallback reads remain
cooperative. Cold input, warm remote-reference input and sustained bursts still require
separate complete-interaction measurements; reduced read counts alone do not prove latency.

Hunks and progress snapshots are immutable. A hunk command carries its comparison generation
and index. Reversion checks that generation and the working revision, then submits one human
replacement transaction with the initiating view. Shared undo restores the preceding text
and selection. A later edit clears the selected hunk; it cannot silently retarget a button.
Large hunk insertion materializes its inserted text and commits synchronously, as other
workspace edits do.

## Host tickets and ownership

`beginRefresh()` captures the reference epoch/version, working snapshot and saved/server
version. Complete it with `{ buffer, version }`. A newer refresh supersedes an older refresh;
any successful reference advancement invalidates tickets against the preceding epoch.
Typing during retrieval is retained because refresh changes only the reference.

`beginAcceptance()` captures the exact working buffer/revision. Complete it with that
captured buffer and the host's new reference version. Acceptance advances to the captured
revision even if the human has typed further. Later text remains in the working resource;
its history, saved baseline, dirty state and server version remain intact. Acceptance requires
human edit permission and no edit lock, checked at capture and completion. It is a review
reference advancement. Hosts use the independent save/acknowledgement protocol for persistence.

`beginReversion()` captures a ready comparison's entire change set for a delayed discard
confirmation. `complete()` restores those reviewed changes in one human transaction, using
the existing hunks and history. It preserves raw source bytes outside the hunks and maps
independent views normally; shared undo restores the initiating view's complete selection set.
The reference and saved/server version remain independent. Empty comparisons create no history.
No full-document export or second comparison is needed, although inserted hunk text still
materializes synchronously as it does for an individual hunk reversion.

The confirmation expires after text, initiating selection, reference generation or reference
intent changes, saved-version changes, authorization/lease transitions, agent ownership changes,
tab replacement/close or view/controller disposal. Restoring permission does not revive an old
confirmation. The host additionally guards its own pending variant-selection intent and composition
state. The evaluation hosts expose immutable saved/server/draft/history choices, captured deferred
loads, failure/cancellation and an explicit discard confirmation. Selecting a version changes the
reference; Save and Run keep targeting the working resource. A newer server version does not relabel
an already captured version. These local host ports do not perform application-service integration.

The evaluation hosts share a latest-request guard between version selection and remote conflict
review. An older response cannot replace the reference after a newer request, even if that newer
load fails or is cancelled. A changed reference publication also expires an outstanding remote
review. Starting a new request also expires a completed remote review's save authorization.
Stale results release their leases and cannot authorize a reviewed save; working text,
history and the current reference remain intact. A fresh remote review can authorize saving again.
Closing the review dismisses pending version and remote-review requests, including across a later
reopen. Their late responses cannot replace the reference or reopen the comparison. This keeps a
completed remote review's save authorization intact; hiding an already reviewed version does not
change what was reviewed. Explicit host remounts retain their existing logical presentation lifetime.

Tickets own explicit resource leases until completion, cancellation or `finish()`. Completion
settles even stale or rejected results; finish/cancel are idempotent. Captures remain available
for host recovery. Dispose the controller and release host-held tickets when done. Disposal
cancels jobs/tickets, unsubscribes and releases owned views/leases; supplied views remain
host-owned. Browser teardown also removes timers, listeners and reference display resources.
Commands run outside notification delivery; subscribers render or schedule subsequent work.

## Presentation and evidence

Previous/next navigation selects and reveals both ranges. Row colors include insertion points
and empty rows; a bounded selected-change preview makes spaces, tabs, CR and LF explicit.
Only the selected preview is rendered, even with many hunks. Scrolling is independent by default.
**Link review scrolling** optionally keeps corresponding vertical positions together in either
direction. Hosts can set `scrollLinked` when mounting or call `setScrollLinked(boolean)`;
`snapshot().scrollLinked` and `pendingScroll` expose the preference and queued view work.
The evaluation hosts retain the preference across explicit remounts. Horizontal offsets, focus,
complete selections, source history and the immutable reference remain independent.

The link reuses completed diff ranges and the existing fold/scroll indexes. Unchanged rows retain
their fractional alignment; changed rows interpolate between their captured line coordinates.
Inserted/deleted rows project to the opposite anchor. At a line-start insertion, the after edge
keeps the following unchanged row aligned; an insertion inside a row retains its unchanged prefix.
Raw hunk endpoints preserve the true newline delta, including same-line edits and unterminated
final rows. This original logarithmic projection adds no parser, buffer scan/export or dependency.
Folds project to visible headers without expanding them. Each pane clamps at its own scroll limit,
so positions near unequal document ends can differ. Enable row alignment below to give both panes
the same vertical row grid. Inline merge conflicts and advanced review remain later work.

Coordination waits for a ready comparison and current viewport revisions/folds. A queued frame
captures the comparison snapshot and reference view; edits, reference replacement, changed folds,
disable and disposal invalidate it. Pending input/navigation or composition in either pane pauses coordination.
Rendered logical positions are observed as well as native scroll notifications. A scroll consumed
while navigation is pending retains its initiating pane and resumes when input/viewport work settle. The clamped logical target suppresses delayed programmatic feedback. Resize and
fold changes reuse bounded frame scheduling; horizontal scrolling does not move the other pane.
The host owns refresh/acceptance controls and transport errors. Native IME and
physical-display qualification remain separate; scroll callback work is not complete interaction
latency.

**Align review rows** optionally adds empty visual padding beside inserted/deleted rows.
Hosts can pass `rowsAligned` or call `setRowsAligned(boolean)`; `snapshot().rowsAligned` retains
the preference and `snapshot().alignment` reports preparation, pending work, run count or failure.
Enabling alignment also enables linked scrolling. Hosts may subsequently disable linking while
keeping the shared grid. Both preferences survive the evaluation hosts' stable-ref remounts.

The grid reuses the completed exact diff. It zips source rows within each changed block and pads
its shorter side; it does not search again for matching line bodies. Line terminators remain part
of equality, including a body moved to an unterminated final row. Scalar-trimmed hunk endpoints
expand to whole rows on both sides when either end lies inside a row. Empty documents, line-start
insertions, deleted newlines and EOF boundaries retain real source coordinates. Collapsed folds
remain independent: a row hidden on one side becomes padding there, and rows hidden on both sides
are omitted. A common pitch uses the larger measured natural line height; this adds no shaping.

Sparse runs contain source/visual coordinates, with work proportional to diff and fold boundaries
rather than document or padding row count. A cooperative cursor publishes both layouts together
against captured reference, working revision and fold snapshots. Edits, refresh, fold changes,
disable and disposal cancel stale work. Publication waits for pending input, navigation, pointer
gestures and composition in either pane to settle. Pending state reflects stale captures immediately. Only the
visible row window creates DOM; padding is empty and nonfocusable.

Padding contains no source characters. Clicking it chooses the adjacent source boundary or visible
fold header; ordinary arrows skip padding and Page commands use the visual grid with real-source
destinations. Exact text, complete selections, shared history and Save/Run targets remain source
owned. View snapshots expose `visualRows`, `paddingRows`, `aligned`, `alignmentId`, `rowGeneration`
and `naturalLineHeight`; `visibleLines` continues to count genuine fold-visible source rows.
Versioned `verticalAnchor` view state preserves source position across layout changes and rapid
ref remounts, including before the first paint. Its source-row pixel remainder retains positions
inside padding; the optional `aligned: true` marker defers restoration until the shared grid
exists, so provisional source-only paints cannot consume it. Explicit reveal/scroll overrides it. `setComparisonRows` rejects mismatched document,
revision or fold captures. Hosts should normally use the comparison's alignment API instead.

Hosts may supply independent `workingDecorate` and `baselineDecorate` callbacks for bounded
visible fragments. Their decorations compose with changed ranges, preserving both classes
where they overlap. The host owns provider/search state and invalidates its working viewport
when that state changes. Reference presentation stays independent of mutable working state.
The restored consumer verifies this composition using the compiled API and declarations.

Tests check exact reconstruction, a seeded dynamic-programming edit-distance oracle, hash
collisions, cooperative long-line work, undo, late typing, out-of-order and cross-lane results,
permission changes, presentation expiry and disposal. Browser tests exercise actual keyboard
input, virtualized large comparisons and stable working-view identity. The restored NuGet
consumer also uses the compiled comparison modules, declarations and styles.

`npm run bench:comparison` records headless total/step time separately from browser step and
readiness proxies, with source/environment metadata and raw samples. Large browser cases are
single diagnostic observations. These checks do not qualify native-device IME,
full contextual long-line shaping, physical presentation latency or production
performance budgets.
