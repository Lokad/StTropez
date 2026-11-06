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

## Exact alignment and scheduling

`TextDiff` tokenizes LF-inclusive lines, aligns them with shortest-edit bisection, and trims
common UTF-16 boundaries within changed blocks. CRLF, LF, tabs, spaces and final newlines
remain exact. `whitespaceOnly` describes a change; it never suppresses one. Hashes can reject
unequal lines or prove disjoint regions. Lines of at most 256 UTF-16 units receive exact
job-local string identities, reused across alignment probes without repeated buffer reads.
Longer matching hashes still require bounded exact text checks. Identity storage is linear;
no normalization or hash-only equality is introduced.
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
feature. Full input-to-review-ready measurements remain separate from handler CPU.

`DiffReferenceCache` optionally reuses one immutable reference index across `TextDiff` jobs.
Pass it as the third constructor argument and explicitly dispose it when its owner ends.
Working-line identities remain job-local, so successive edits do not grow the reference cache.
A different buffer replaces the cached index. Active jobs retain their original captures;
disposing the cache releases future reuse and prevents new jobs from using it. The comparison
controller owns a cache and disposes it on expiration or teardown. Cold indexing remains
cooperative. An identical-buffer fast path can defer indexing until the first edit; that cold
interaction needs separate measurement from edits against an already indexed reference.

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
