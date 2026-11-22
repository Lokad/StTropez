# Find and replace

Attach Find to an editor to search that view and undo replacements through its shared history. Literal
search reads the text buffer. To offer regex, supply a Web Worker for matching and replacement
planning.

## Use

To enable both modes, attach one controller per editor.

```ts
import { createFindController, createRegexFindBackend } from "sttropez/browser";
import type { TextEditor } from "sttropez/browser";

export function attachFind(
    editor: TextEditor, workerUrl: URL
) {
    const clock = editor.element.ownerDocument.defaultView;
    if (!clock) throw new Error("The editor needs an attached browser window.");
    return createFindController(editor, {
        regularExpressionBackend: createRegexFindBackend({
            clock,
            createWorker: () => new Worker(workerUrl, { type: "module" })
        })
    });
}
```

Use `manifest.json`’s `entries.regexWorker` to locate `browser/regex-worker.js`. Serve the worker
from the same package version as the client. Literal search starts no worker. See
[packaging](packaging.md).

Subscribe to progress, counts and errors. Set the query and flags from your controls, call `next()`
to navigate and wait for `ready` before calling `replaceAll(replacement)`. Disposing the editor also disposes its Find controller.

## Contract

### Options, matches and commands

Pass the mounted editor to `createFindController`. Its lease keeps the document available. Commands stay with the
original view after focus moves. When mounted by tab, closing or replacing that tab expires Find.

Pass the backend and delay in `FindControllerOptions`. Change `FindFlags` with `setFlags(flags)`.
Set `highlightMatches: false` for navigation with a closed Find bar. The controller builds the
index and selects on request. It skips match decorations and query previews.
`getSnapshot()` and `subscribe()` expose an immutable `FindSnapshot` with the query, flags,
revision, status, count, scan frontier, source length, current match index, navigation wrap, match version and
notice.

| Option or command | Behavior |
| --- | --- |
| `wholeWord` | Defaults to `false`; code-word boundaries when enabled |
| `matchCase` | Defaults to `true`; locale-independent simple folding when disabled in literal mode |
| `regularExpression` | Defaults to `false`; requires a configured `FindBackend` when enabled |
| `setQuery(query)` | Cancels obsolete work and starts a search; an empty query is idle |
| `setQuery(query, { preview: true })` | Once the search finishes, marks a visible match or reveals the next one from the source selection. Preserves focus and the selection. |
| `setFlags(flags)` | Patches supplied flags and restarts only when a value changes |
| `next(direction?)` | Selects a match in the captured view; direction is `1` by default or `-1` |
| `next(direction, { whenReady: true })` | Accepts one navigation request while the search finishes. The latest direction wins. Changing the query, revision, focus, selection or visible folds cancels the request. |
| `replaceCurrent(text)` | Replaces the selected match, or the next match if none is selected, then selects the following match |
| `replaceAll(text, options?)` | Plans a replacement from a completed index and commits one history command |
| `cancel()` | Clears the index; later typing does not resume the cancelled search |
| `dispose()` | Releases work, subscriptions, focus tracking, backend and resource lease |

Find paints matches on its editor and outlines the current match. Style them with
`--st-search-match`, `--st-search-border` and `--st-search-current-border`. A zero-width match
has a short mark at its offset. A matched character with no visible width has a vertical edge.
Next and Previous leave a visible match in place. An offscreen match scrolls into view and a
match inside a fold opens that fold.
Preview prefers a painted match at or after the start of the selection, then any other painted
match. If all matches are offscreen, it reveals the next one and wraps at the end of the file.
The next forward navigation selects the preview. Losing focus, scrolling, starting a new query
or changing the selection, document or visible folds abandons a pending preview. After explicit navigation,
`wrappedTo` reports `"start"`, `"end"` or `null`. The `current` index starts at zero.
A match inside a line ending appears at the end of the row and keeps its original UTF-16 offsets.
`matchesIn(from, to, capture?)` returns frozen, unclipped UTF-16 ranges intersecting `[from, to)`.
Point matches count at `from` and are excluded at `to`. An empty interval returns a point match at
that offset, including EOF. Use ordered, nonnegative safe integers within the document.

Pass the `FindSnapshot` you’re painting to `matchesIn`. It queries the paged index for that interval
and returns an empty array if the view expired, the revision or `matchesVersion` changed, or Find
hasn’t observed the new revision yet. Redraw on revision or match-version changes. The version changes
for new matches, resets, new queries and repairs. Moving to another match or scanning without finding
one keeps it stable.

After a complete scan, Next wraps from the last match to the first. While literal search repairs its
index (`searching` with `retained: true`), the count covers the confirmed prefix. You can navigate or
replace matches there. Next stops at the last confirmed match. Initial searches and regex searches
wait for a complete scan.

`status` is `idle`, `searching`, `ready`, `replacing`, `failed`, `cancelled`, `expired` or `disposed`.
A missing backend or failed worker sets a message. Expired or disposed controllers cannot target
replacement tabs.

Use `getDiagnostics()` for the current search’s `FindDiagnostics.maxScanStepMs` and the last
replacement’s `FindDiagnostics.replaceTransactionMs`, including after disposal. Timing alone leaves
snapshot identity and listeners untouched. [Clock definitions](README.md#glossary)

### Notice reasons

Branch on `FindSnapshot.reason` (`FindReason` or `null`) and show or localize `message`. An ignored
command can leave an earlier notice in place. Read `status` for progress and resource capabilities for
edit permission.

| Reason | Meaning |
| --- | --- |
| `null` | No notice; the message is empty |
| `editing-unavailable` | Replacement is refused or cancelled because the view is read-only or resource authority is unavailable |
| `composition-active` | Navigation/replacement is refused, or queued replacement is cancelled, for composition |
| `backend-unavailable` | Regular-expression mode has no configured backend |
| `search-failed` | Search construction, matching or result validation failed. For invalid regex syntax, the worker reports the engine's reason in the message. |
| `replacement-failed` | Replacement planning or plan validation failed |
| `view-unavailable` | The captured target or editor view is unavailable |
| `cancelled` | The host explicitly cancelled find |
| `replaced` | A replacement transaction was accepted, including a no-op |
| An `EditResult` refusal reason | The workspace rejected the final transaction; its reason is forwarded unchanged |

Use `reason` for decisions. A backend can send the same error text for a failed search and a failed
replacement. A new or restarted query, changed flags, successful navigation, a queued replacement or
disposal clears the notice. Scan progress, completion and unchanged flags leave it in place. If you
cancel and then edit, the cancellation notice stays. Late replies to obsolete requests cannot change
it.

```ts
import type { FindSnapshot } from "sttropez/browser";

export function findNotice(state: FindSnapshot): string {
    if (state.reason === "composition-active") return "Finish text composition first.";
    if (state.reason === "editing-unavailable") return "Editing is unavailable for this view.";
    return state.message || `${state.count} matches`;
}
```

### Literal matching and scheduling

Use `LiteralSearch(buffer, query, options?)` for headless literal search. `LiteralSearchOptions`
accepts `from` (default 0), `to` (default `buffer.length`), `wholeWord` and `matchCase`. Pass an
options object if supplied. Bounds and `SearchMatch` ranges use original UTF-16 offsets, with an
exclusive end. Matches cannot overlap. They preserve raw line endings. An empty query has no matches.

```ts
import { LiteralSearch } from "sttropez/kernels";
import type { SearchMatch, TextBuffer } from "sttropez";

export function* findWords(buffer: TextBuffer, query: string): Generator<readonly SearchMatch[]> {
    const search = new LiteralSearch(buffer, query, { wholeWord: true });
    try {
        for (;;) {
            const step = search.next();
            yield step.matches; // The caller schedules between generator advances.
            if (step.done) return;
        }
    } finally {
        search.dispose();
    }
}
```

Call `next(maxUnits?, maxMatches?)` for a frozen `SearchStep` with matches, completion and `scanned`,
the absolute UTF-16 offset reached. The budgets default to 32,768 units and 8,192 matches and must be
positive safe integers. `readUnits` counts boundary rereads, so a search can read more units than the
file contains. Preparing the query takes synchronous work proportional to its length. Dispose the
cursor or close the generator to stop early.

In the browser, a literal advance stops at 4,096 units or 1,024 matches. A task publishes once after
at most 32 advances, checking its 4 ms target after each advance and index update. The first repair
advance stops at 64 matches to look for a reusable suffix. Repeated patterns can force a full suffix
scan. Missing revision history forces a fresh search. `maxScanStepMs` times one match/index step.
Setup, publication and paint take additional time. Regex search processes one worker reply at a time.

Case-insensitive literal matching uses Unicode simple folding over code points. It does not
expand `ß` to `ss`, normalize combining sequences or apply locale-specific casing. Whole-word
constituents are Unicode letters, numbers, connector punctuation, combining marks and join
controls U+200C/U+200D. Both neighbors must be non-constituents or document edges; a match cannot
split a surrogate pair. Boundary checks can inspect context outside the requested bounds.

<a id="replacement-and-authority"></a>

### When a match can be replaced

Literal replacement inserts its argument literally, including `$&`, `$1` and raw newlines.
Replace Current uses a matching selection (an indexed match for whole-word search), or replaces
the next match in one press. It selects the following match once the updated index is ready,
provided the view, query, selections, visible folds and focus are current. Navigation and replacement refuse active
composition. You can search a read-only view. Replacement also needs edit permission and an unlocked resource.

Find leaves keyboard focus in the control that invoked it. Enter and Shift+Enter can therefore
navigate without leaving the query field. Call the editor’s `focus()` when closing your Find bar.

Replacing one confirmed literal match runs synchronously, even during index repair. If the replacement
leaves the text unchanged, repair continues. For a replacement plan, the planner reuses the captured
index, copies each edit and checks its range against the indexed match. You get the immutable edit
list only when the backend has supplied every match.

Replace All captures the document revision, all selections and any tab generation. Planning yields
every 1,024 edits and checks read-only and composition state at each step. Changing the selection or
query, starting composition, replacing the tab or disposing the editor cancels the plan. Editing
restarts the search. Losing edit permission or acquiring an edit lease cancels the command even if
permission returns before the next step. Retry from the current state.

The final transaction rechecks authority, applies all replacements synchronously and creates one
shared undo step. Its cost grows with the changed ranges. If your Replace All button disables
itself, pass `{ focusEditor: true }` to focus the editor after commit. A control the user focused
while waiting keeps focus.

### Regular expressions and worker limits

Import `FindBackend`, `FindQueryCapture`, `FindSearchCursor`, `FindPlanCursor` and `FindPlanStep`
from `sttropez`. The browser entry supplies `createRegexFindBackend` for hosts that use a worker.
Give each controller its own backend with an idempotent `dispose`. A custom backend searches the
captured revision and returns one edit per indexed match, including no-ops. The controller commits the plan.

Patterns use native Unicode, global, multiline matching (`gmu`, adding `i` when match-case is
cleared). Supply the pattern without slash delimiters. Captures, lookarounds, Unicode properties
and replacement tokens (`$$`, `$&`, prefix/suffix, numbered and named groups) use platform
semantics. Line anchors follow LF rows: `^` matches document start or after LF; `$` matches before
LF or a complete CRLF, or at EOF. Bare CR, U+2028 and U+2029 do not create row boundaries.
Explicit patterns address raw text. Whole-word wrapping uses the same code-word constituents
as literal search and validates the bare pattern first.

To search for empty positions, enter `(?:)`. An empty query clears Find. Next visits distinct matches
and wraps. Replace Current accepts an indexed match or a manually selected nonempty overlap that
matches in full source context. After replacing a zero-width match, the next Replace Current skips
that occurrence. Undo restores all selections.

| Limit or setting | Contract |
| --- | --- |
| Source | At most 32 Mi UTF-16 units; transferred in acknowledged 32,768-unit chunks |
| Pattern | At most 4,096 UTF-16 units |
| Matches | At most 1,000,000; response pages contain at most 512 ranges |
| Replacement template | At most 32,768 UTF-16 units |
| Replacement output | Inserted text bounded by `maxOutputUnits`, an integer from 0 through 32 Mi, default 32 Mi; final document at most 32 Mi |
| Replacement transfer | At most 512 small edits per page; large insertions use 32,768-unit fragments |
| `regularExpressionDelayMs` | Controller query delay: default 80; finite value from 0 through 1,000 |
| `timeoutMs` | Backend exchange timeout: default 5,000; positive finite value |
| Worker protocol | Client and worker require matching version 2 before source transfer |

The worker reuses source for the same document, revision and immutable buffer. A new revision
requires another full transfer. Cancelling an active exchange terminates the worker and drops its
cache. Cancelling before the first message preserves an idle cache. A timeout terminates stalled
native matching.

The client ignores replies to old requests and checks current replies for size, range order and
output limits. A malformed reply, exceeded limit or worker failure discards the entire plan. Final
fragment assembly and the transaction run synchronously.

## Host responsibilities

Build the controls and supply the worker URL. Label partial counts and enable Replace All at `ready`.
Preserve focus if the user switches to another form. Dispose subscriptions and the controller on
detach. Custom backends must respect cancellation, source identity, match order and size limits.

## Not covered

Find searches one attached document at a time. A host that offers project-wide search must choose the
files and collect their results. [Search and review support](README.md#support-matrix)
