# Literal find and replace

`LiteralSearch` scans an immutable `TextBuffer` without flattening it. Matching defaults to exact,
case-sensitive UTF-16, with non-overlapping ranges and no newline normalization. An empty query
has no matches. Optional original-coordinate `from`/`to` bounds restrict the scan. Each `next`
call accepts text-unit and match-count budgets and returns a frozen step with absolute scan
position, units read, completion flag and frozen matches. The caller supplies scheduling.
`dispose` ends scanning and releases the piece iterator. Pattern preparation is linear in the
query length; scan budgets describe work units, rather than hard elapsed-time deadlines.

`new LiteralSearch(buffer, query, { from, to, wholeWord: true })` restricts matches to whole
code words. The legacy numeric `from, to` arguments remain supported. The option uses the same
constituents as code-word navigation: Unicode letters, numbers, connector punctuation, combining
marks and join controls U+200C/U+200D. Both neighbouring code points must be non-constituents
or document edges. A match cannot split a surrogate pair. This is case-sensitive and does not
normalize text or apply dictionary/locale word rules. The
[Unicode segmentation guidance](https://www.unicode.org/reports/tr29/#Word_Boundaries) describes
the broader language-dependent boundary choices.

Whole-word checks read at most two UTF-16 units at each endpoint, including context outside
the requested scan bounds. These reads consume the same per-step unit budget; `scanned` remains
the absolute source scan frontier. A check can span multiple steps, even with a one-unit budget.
Rejected matches retain the matcher prefix so that a later overlapping candidate is still
considered. Accepted matches remain non-overlapping. Cancellation releases pending context.

The existing piece iterator, position mappings, versioned transactions and history are reused.
There was no project matcher to reuse. The small original prefix matcher carries partial
matches across pieces and scheduling steps; a whole-string platform search would require the
document export this path is intended to avoid. Whole-word filtering reuses the existing matcher
and code-word classification; a whole-string regular expression would bypass the piece/budget
contract. No external search/editor runtime is included.

`createFindController(workspace, tabId, editingCandidate)` supplies browser scheduling and a
stable immutable `state` observable. It scans up to 32,768 units or 8,192 matches per timer turn.
The controller retains all matching start offsets in 1,024-entry pages for binary navigation,
while `preview` exposes only the first 200 ranges for bounded decorations. The preview cap never
limits the count, navigation or replacement. Index memory is proportional to match count and
is released on query changes, cancellation, expiry or destruction. This is explicit global
search work, outside the ordinary editing path.

`setQuery`, `setOptions({ wholeWord })`, `next(1 | -1)`, `replaceCurrent`, `replaceAll`, `cancel` and `destroy` are explicit
commands. Navigation waits for a completed index, wraps, and uses the captured document view.
Replacing a current selection requires an exact literal match; otherwise the command selects
the next match. Whole-word replacement additionally requires the selection to be in the current
match index, so selecting a substring inside a larger word does not make it replaceable.
Replacement text is literal, including `$&`, `$1` and raw newline sequences.
Replace-all planning yields every 1,024 edits and checks captured revision, selection and tab
generation. One core transaction applies all ranges, rechecks capabilities and records one
shared undo unit. Edits during planning cancel the old operation and restart search over the
new snapshot. The final transaction remains synchronous and proportional to changed ranges;
yielding planning does not qualify large replace-all latency or memory.

Changing options cancels a queued replacement through the existing generation/timer guards
and scans the unchanged source again. Snapshots expose an immutable `wholeWord` flag. Both host
find panels and the editing fixture expose a **Whole word** checkbox; the host keeps the option
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

`/editing/` renders the host-owned find controls. Ctrl/Command+F focuses Find, Ctrl/Command+H
focuses replacement, Enter/F3 chooses a match and Escape cancels and returns to the editor.
Browser tests cover Unicode/CRLF, wrap, literal replacements, read-only behavior, 100,000-match
counting, stale planning, a 10,000-line atomic replacement/undo and disposal. The isolated NuGet
consumer exercises the compiled controller and shared undo. Regex and case folding remain M4 work.

`bench:services` records repeated search and pilot replacement cases separately from keyboard
input. Scan-step timing covers matching/index accumulation; replacement timing includes the
core transaction and synchronous publication/context refresh. Wall values include scheduling
and readiness polling. The 100,000-line replacement has one diagnostic observation, rather than
a percentile or production budget. No physical input/presentation claim follows.
`node scripts/benchmark-services.mjs --whole-word` uses the same workloads and measurements with
whole-word mode enabled, including a huge-line no-match control. The existing driver retains
observed samples; its omitted raw warmups remain an evidence limitation.
Readiness polling uses constant-work `TextBuffer.readMetrics()` counters. Full `diagnostics()`
retention/tree validation is explicit and stays outside routine telemetry and timed subscribers.
