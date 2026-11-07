# Versioned text comparison

`createComparisonController` compares an immutable reference buffer/version with a captured
working text tab. `mountTextComparison` displays both through bounded viewports and uses
the experimental input candidate on the working side. `/comparison/` supplies deferred,
synthetic host responses. No retrieval, persistence, execution or application service is
included in the package.

The reference version, reference epoch, working resource ID, document revision, tab
generation and view selection have separate meanings. Moving a tab preserves the comparison;
closing or replacing it expires the captured presentation. Baseline display resources have
their own identity and deny editing from every origin, saving and execution. They retain
the existing `TextBuffer` through `createTextResourceFromBuffer`, without a string export.

Browser mounts accept an optional host-owned working `DocumentView`, as the core controller
already does. Destroying such a mount releases its jobs, DOM and reference display resource,
while leaving that view registered for revision-mapped selection updates. The host disposes
the view at its own lifetime boundary. Reference display views remain mount-owned; restoring
their scroll and selection requires the same immutable reference buffer and version.

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

Core callers explicitly advance work. Browser tasks group up to 32 advances of 32,768 work
units, stopping after the first advance that reaches four milliseconds. This reduces nested
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

Tickets own explicit resource leases until completion, cancellation or `finish()`. Completion
settles even stale or rejected results; finish/cancel are idempotent. Captures remain available
for host recovery. Dispose the controller and release host-held tickets when done. Disposal
cancels jobs/tickets, unsubscribes and releases owned views/leases; supplied views remain
host-owned. Browser teardown also removes timers, listeners and reference display resources.
Commands run outside notification delivery; subscribers render or schedule subsequent work.

## Presentation and evidence

Previous/next navigation selects and reveals both ranges. Row colors include insertion points
and empty rows; a bounded selected-change preview makes spaces, tabs, CR and LF explicit.
Only the selected preview is rendered, even with many hunks. Scrolling remains independent;
aligned filler rows, synchronized scrolling, inline merge conflicts and advanced review are
outside this slice. The host owns refresh/acceptance controls and transport errors.

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
single diagnostic observations. These checks do not qualify native-device IME, assistive
technology, full contextual long-line shaping, physical presentation latency or production
performance budgets.
