# Find and replace

`LiteralSearch` scans an immutable `TextBuffer` without flattening it. Matching defaults to exact,
case-sensitive UTF-16, with non-overlapping ranges and no newline normalization. An empty query
has no matches. Optional original-coordinate `from`/`to` bounds restrict the scan. Each `next`
call accepts text-unit and match-count budgets and returns a frozen step with absolute scan
position, units read, completion flag and frozen matches. The caller supplies scheduling.
`dispose` ends scanning and releases the piece iterator. Pattern preparation is linear in the
query length; scan budgets describe work units, rather than hard elapsed-time deadlines.

Case-sensitive scans use native literal search within a piece, bounded by the remaining
unit budget. Streaming prefix state handles piece seams, short windows and queries larger
than a step. A failed native search leaves its final possible match prefix for streaming;
revisited prefixes/tails count against the read budget. No native call scans an unbounded
backing, and no whole-document string is assembled. `scanned` is the consumed source frontier,
so it can lag the end of a native lookahead window. Whole-word rejection preserves overlapping
candidates; accepted matches remain non-overlapping.

`matchCase: false` enables locale-independent Unicode simple-fold comparison over code points.
For example, `k` matches `K` and `K`, sigma matches final sigma, and supplementary case pairs
match across pieces. It does not expand `ß` to `ss`, normalize combining sequences, or apply
locale-specific casing. Returned bounds always address the original UTF-16 buffer. Paired
surrogates are read together in this mode; a clipped/unpaired surrogate remains literal.

The existing streaming matcher retains bounded read/match budgets. A query-sized ring records
raw starts; navigation and replacement retain actual starts and ends, without assuming folded
characters have the query’s UTF-16 width. Fixed single-code-point native comparisons supply
simple-fold equivalence using the engine’s Unicode case data; there is no general regex execution over document text, new dependency
or copied folding table. Query preprocessing remains synchronous and proportional to query
length. Cancellation/disposal releases the caseless matcher and pending surrogate state.

`new LiteralSearch(buffer, query, { from, to, wholeWord: true })` restricts matches to whole
code words. The legacy numeric `from, to` arguments remain supported. The option uses the same
constituents as code-word navigation: Unicode letters, numbers, connector punctuation, combining
marks and join controls U+200C/U+200D. Both neighbouring code points must be non-constituents
or document edges. A match cannot split a surrogate pair. Whole-word and match-case options
combine independently; word boundaries do not normalize text or apply dictionary/locale rules. The
[Unicode segmentation guidance](https://www.unicode.org/reports/tr29/#Word_Boundaries) describes
the broader language-dependent boundary choices.

Whole-word checks read at most two UTF-16 units at each endpoint, including context outside
the requested scan bounds. These reads consume the same per-step unit budget; `scanned` remains
the absolute source scan frontier. A check can span multiple steps, even with a one-unit budget.
Rejected matches retain the matcher prefix so that a later overlapping candidate is still
considered. Accepted matches remain non-overlapping. Cancellation releases pending context.

The existing piece iterator, position mappings, versioned transactions and history are reused.
The original prefix matcher and its code-point counterpart carry partial
matches across pieces and scheduling steps; a whole-string platform search would require the
document export this path is intended to avoid. Whole-word filtering reuses the existing matcher
and code-word classification; a whole-string regular expression would bypass the piece/budget
contract. No external search/editor runtime is included.

`createFindController(workspace, tabId, editingCandidate)` supplies browser scheduling and a
stable immutable `state` observable. Literal scans process up to 131,072 units or 8,192 matches
per timer turn, then yield. This amortizes scheduling overhead without changing the headless
cursor's defaults or regex-worker delay. These are work limits, not elapsed-time guarantees.
The next literal timer is queued before a slice runs so its wait overlaps the work. Completion,
query changes, cancellation, expiry and destruction clear unused work; captured generations
prevent an older slice from publishing after replacement. Regex cursors schedule after replies.
Source-transfer acknowledgements and other steps that leave count/scan position unchanged
do not publish a new snapshot. Scan/index timing maxima accumulate privately across those
steps and appear with the next visible progress or terminal state, including cancellation or
failure. `maxScanStepMs` covers completed dispatch/index spans before publication; it is not
an input-handler or complete interaction timer.
The controller retains all matching start/end pairs in 1,024-match pages for binary navigation,
while `preview` exposes only the first 200 ranges for bounded decorations. The preview cap never
limits the count, navigation or replacement. Index memory is proportional to match count and
is released on query changes, cancellation, expiry or destruction. This is explicit global
search work. With an active completed literal query, edits retain a proven prefix and repair
one conservative changed region using the existing matcher. Its first repair step reads up to
4,096 units or 64 matches; unresolved scans then use the ordinary budgets. A freshly accepted
match with identical mapped bounds in the unchanged
suffix proves the same non-overlap state; only then is the remaining suffix reused. Repeated
patterns can change every subsequent match and still require a full suffix scan. Batch edits
use their enclosing change region; unknown revision lineage falls back to a full search.

Completed indexes share sealed offset pages with the next revision. Joining slices copies at
most a page; shifted suffixes reuse their backing arrays. Repair setup/completion traverses
page descriptors, so this cost remains proportional to retained page count, not constant.
Rapid edits accumulate conservative unchanged edges against the last completed capture.
Query/option changes, cancellation and disposal discard that capture. Public previews remain
immutable and reuse their identity when their first 200 coordinates do not change.

`setQuery`, `setOptions({ wholeWord, matchCase, regularExpression })`, `next(1 | -1)`, `replaceCurrent`, `replaceAll`, `cancel` and `destroy` are explicit
commands. `setOptions` patches only supplied choices, preserving other options. Navigation uses
the captured document view. A completed index wraps. During literal repair, `retained: true`
with `status: "searching"` exposes only confirmed matches; count/preview are partial. Navigation
and current replacement may use that confirmed prefix but cannot wrap or skip an unsearched
region. Replace-all waits for completion. Initial searches and regex searches still wait for
a completed index. Host keyboard commands that cannot yet resolve retain their captured
selection/focus/revision guards while waiting.
Replacing a current selection requires a literal match under the current options; otherwise the command selects
the next match. Whole-word replacement additionally requires the selection to be in the current
match index, so selecting a substring inside a larger word does not make it replaceable.
Replacement text is literal, including `$&`, `$1` and raw newline sequences.
Replace-all planning yields every 1,024 edits and checks captured revision, complete selection set and tab
generation. One core transaction applies all ranges, rechecks capabilities and records one
shared undo unit. Edits during planning cancel the old operation and restart search over the
new snapshot. The final transaction remains synchronous and proportional to changed ranges;
yielding planning does not qualify large replace-all latency or memory.

Changing options cancels a queued replacement through the existing generation/timer guards
and scans the unchanged source again. Snapshots expose immutable `wholeWord` and
`matchCase` and `regularExpression` flags. Initial defaults are `wholeWord: false`,
`matchCase: true` and `regularExpression: false`; subsequent patches retain unspecified choices.
Both host find panels and the editing fixture expose **Whole word**, **Match case** and **Regular expression** checkboxes; the host keeps the options
when commands move between source/comparison views and when views remount.

After replace-all finishes, focus returns to its captured editor only if no new element gained
focus since the command began. A scoped focus listener records these changes and is removed
on destruction. Disabling the invoking button can clear browser focus without another element
gaining it. Moving focus to a configuration field while planning keeps later typing in that
field; the replacement still targets its original document and view.

Starting composition cancels a queued replace-all through the existing generation and timer
cancellation path. Immediate composition cancellation cannot revive that older plan. The
unchanged source keeps its valid search index, so a fresh command can run after composition
ends. A new replace-all request during active composition is rejected. Composition can then
commit as its own history unit; stale-context recovery for unrelated edits remains in place.
The controller removes its composition listener on destruction. Synthetic event tests verify
these staging rules and do not qualify native IME behavior.

Next/previous match and current replacement also reject a host command during active
composition, preserving both the staged selection and document revision. Rejection keeps the
search index available. After composition ends, a fresh command can navigate or replace using
the current source. Unrelated external edits retain the existing stale-context recovery rules.
Late replacement calls on a destroyed controller, expired tab or disposed view remain inert,
including while its editor still reports composition; they do not publish new Find state.

The controller retains an explicit resource lease and subscribes only to its document and tab
state. Destroy it before discarding the associated view. Cancellation clears the index and
does not automatically resume on later typing. Disposed or expired controllers cannot address
a replacement tab or whichever editor becomes focused later. State includes content-bearing
query/ranges for a host UI; development telemetry exposes counts and offsets only.

Queued replacement observes edit permission and ownership until it commits. Losing permission
or acquiring an edit lease cancels that command even if editing becomes available again before
its next scheduled step. The cancellation preserves text, complete selections and shared history;
an explicit retry captures a fresh command. This observation is released on completion, no-op,
cancellation and disposal, without adding idle listeners.

`/editing/` renders the host-owned find controls. Ctrl/Command+F focuses Find, Ctrl/Command+H
focuses replacement, Enter/F3 chooses a match and Escape cancels and returns to the editor.
Browser tests cover Unicode/CRLF, wrap, literal replacements, read-only behavior, 100,000-match
counting, stale planning, a 10,000-line atomic replacement/undo and disposal. The isolated NuGet
consumer exercises the compiled controller, worker asset and shared undo.

## Regular expressions

The optional backend reuses the platform's Unicode multiline regular expressions in a dedicated
module worker. The host supplies its worker URL and lifecycle factory; literal mode starts no
regex worker. The assets-only package ships `browser/regex-worker.js` as an independent bundled
module, declared by `manifest.json`'s `entries.regexWorker`. No consumer compilation or extra
runtime dependency is needed. For example:

```ts
const find = createFindController(workspace, tab, editor, {
    regularExpression: createRegexFindBackend({ clock: window,
        createWorker: () => new Worker("/assets/regex-worker.js", { type: "module" }) })
});
find.setOptions({ regularExpression: true, matchCase: false });
find.setQuery("(?<word>sample)");
find.replaceAll("[$<word>]"); // after state.status becomes "ready"
```

Expressions use `gmu`, adding `i` when **Match case** is cleared. Native matching, captures,
lookarounds, Unicode properties and replacement tokens (`$$`, `$&`, prefix/suffix, numbered
and named groups) retain their platform semantics. Search publishes frozen ranges directly,
without making application-owned capture-array or named-group copies. Replacement retains
those captures. Both paths use the same native iterator and boundary validation; native
regex result allocations still occur. No alternative matching runtime is introduced.
Line anchors follow the editor's LF rows:
`^` matches document start or after LF; `$` matches before LF or a complete CRLF, or at EOF.
Neither anchor splits CRLF or treats bare CR, U+2028 or U+2029 as a row boundary. Guards around
native assertions implement these bounds while preserving inline flag groups and captures.
Explicit patterns still address raw UTF-16 units; text and offsets are never normalized.
The bare pattern is validated before whole-word wrapping, which applies the shared code-word
constituent policy so native alternatives and backtracking respect the boundary. An empty query
keeps find idle; use `(?:)` for zero-width matches. Navigation advances between distinct zero-width
matches, including raw CRLF positions for explicit empty patterns, and wraps. Current replacement
accepts an indexed match or a manually selected nonempty overlap validated in full source context;
an unrelated selection navigates to a match without starting replacement work.
The next current command skips a just-replaced zero-width occurrence. Undo restores complete sets.

The separately deployed worker and client exchange protocol version 2 in the start request and
acknowledgement. Missing or incompatible versions fail before source transfer. Execution errors
carry the active request ID and revision and release that capture.

Each controller owns its regex backend and calls its idempotent `dispose()` on expiry or
destruction. Completed searches and replacement plans retain one worker and one source keyed
by document ID, revision and immutable buffer identity. Pattern/options changes and replacement
queries reuse that exact source; a query cancelled before its first message also preserves it.
New source captures transfer up to 32 Mi UTF-16 units in acknowledged 32,768-unit chunks,
joined only inside the worker. This avoids `TextBuffer.text()` exports, but changed revisions
still transfer the complete source. A source token and start acknowledgement prevent reuse
of incomplete or foreign captures. Patterns are limited to 4,096 units and one million
matches. Search pages contain at most 512 ranges; replacement pages contain at most 512 small
edits, with large insertions transferred in acknowledged 32,768-unit fragments. Templates are
limited to 32,768 units; planned inserted text and final document length are each capped at
32 Mi units. Limits and malformed responses fail visibly without committing partial plans.

The controller coalesces regex query changes for 80ms by default. A five-second timeout per
worker exchange terminates the worker when native matching cannot yield; termination/realm
closure is asynchronous. Cancellation, query/revision/selection changes, composition, authority
loss, tab replacement and disposal invalidate captured work. Cancelling an active exchange or
result stream terminates its worker and drops the source cache; retry starts a fresh lane.
Worker failures also drop idle cached sources. Only a complete validated plan can
commit one shared history transaction. Final fragment assembly and model application remain
synchronous bulk work; worker isolation does not qualify their latency or memory use. A missing
backend or failed worker reports unavailability without a fallback matcher.

`maxScanStepMs` for regex covers main-thread dispatch/index spans. It excludes native matching,
later asynchronous transfers/JSON decoding, publication/subscribers and wait time. It is neither
an input-handler duration nor a complete callback or interaction latency. `replaceTransactionMs`
still covers the final model transaction. The services driver's `--regex` mode records index
completion; replacement also waits for the primary viewport. These component clocks include
the pattern delay and worker transfer; they do not cover full host/all-view interaction latency.
Native IME and OS clipboard remain separate qualification requirements.

`bench:services` records repeated search and pilot replacement cases separately from keyboard
input. Scan-step timing covers matching/index accumulation; replacement timing includes the
core transaction and synchronous publication/context refresh. Wall values include scheduling
and readiness polling. The 100,000-line replacement has one diagnostic observation, rather than
a percentile or production budget. No physical input/presentation claim follows.
`node scripts/benchmark-services.mjs --whole-word` uses the same workloads and measurements with
whole-word mode enabled, including a huge-line no-match control. The existing driver retains
observed samples; its omitted raw warmups remain an evidence limitation.
Results live under `artifacts/bench/services/<mode>-<boundary>-<case>/`, for example
`regex-whole-word-ignore-case/`. Each run is retained and only a completed passing run updates
that variant's `latest.json`. Summaries with fewer than 20 observations report `n`, p50 and max.
Readiness polling uses constant-work `TextBuffer.readMetrics()` counters. Full `diagnostics()`
retention/tree validation is explicit and stays outside routine telemetry and timed subscribers.
