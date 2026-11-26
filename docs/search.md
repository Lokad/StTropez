# Find and replace

Attach Find to an editor to search that view and undo replacements through its shared history. Literal
search reads the text buffer. To offer regex, supply a Web Worker for matching and replacement
planning.

## Use

Mount the optional bar in a toolbar container. Attach each searchable pane, including the read-only side
of a comparison. Ctrl/Cmd+F opens Find, Ctrl/Cmd+H opens Replace, and F3 repeats the last search.

```ts
import { mountFindBar, type TextEditor } from "sttropez/browser";

export function mountSearch(toolbar: HTMLElement, pane: TextEditor, workerUrl: URL) {
    const bar = mountFindBar(toolbar, {
        createWorker: () => new Worker(workerUrl, { type: "module" }),
    });
    bar.attach(pane);
    return bar;
}
```

The bar follows focus among attached panes. Use `setTarget(editor)` to choose one from a toolbar.
Omit `createWorker` for literal search only. Customize labels and tooltips with `text`, result
messages with `status` and pane names with `targetLabel`. Disposing a pane detaches it.
Call `bar.dispose()` when you remove the bar.

For custom controls, attach one Find controller per editor.

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

Serve the worker named by `entries.regexWorker` in the package manifest alongside the matching
client. Literal search runs on the main thread. [Package contents](packaging.md)

Subscribe to the controller, update its query and flags from your controls, and enable Replace All
once the snapshot is `ready`. Disposing the editor disposes its controller.

## Contract

### Options, matches and commands

Find holds a lease on the original document. Closing or replacing its tab expires the controller.
Moving focus leaves its command target intact.

`FindControllerOptions` sets the backend and delay. `setFlags(flags)` changes the search.
Set `highlightMatches: false` for a bar that starts closed. `setHighlightMatches(false)` removes
marks and dismisses the preview. Next and Previous use the existing index.

Read the immutable `FindSnapshot` with `getSnapshot()` and observe changes with `subscribe()`.
It includes the query, flags, revision, status, count, scan frontier, document length, current
match, wrap direction, match version, highlight visibility and notice.

| Option or command | Behavior |
| --- | --- |
| `wholeWord` | Defaults to `false`; code-word boundaries when enabled |
| `matchCase` | Defaults to `true`; locale-independent simple folding when disabled in literal mode |
| `regularExpression` | Defaults to `false`; requires a configured `FindBackend` when enabled |
| `setQuery(query)` | Cancels obsolete work and starts a search; an empty query is idle |
| `setQuery(query, { preview: true })` | Shows a match when the search finishes and keeps focus in the Find panel. |
| `setFlags(flags)` | Patches supplied flags and restarts when a value changes. Refreshes an active preview at the same selection. |
| `next(direction?)` | Selects a match in the captured view; direction is `1` by default or `-1` |
| `next(direction, { whenReady: true })` | Accepts one navigation request while the search finishes. The latest direction wins. Changing the query, revision, focus, selection or visible folds cancels the request. |
| `replaceCurrent(text)` | Replaces the selected or previewed match and selects the following one. With neither, it selects and reveals the next match on the first press |
| `replaceAll(text, options?)` | Plans a replacement from a completed index and commits one history command |
| `cancel()` | Clears the index; later typing does not resume the cancelled search |
| `dispose()` | Releases work, subscriptions, focus tracking, backend and resource lease |

Find outlines the current match. Set `--st-search-match`, `--st-search-border` and
`--st-search-current-border` to theme the marks. A point gets a short mark. A character with
no visible width gets a vertical edge. A matched line ending appears at the row end.

Preview keeps the editor selection. It prefers a visible match in search order from the selection,
opens a containing fold if its header is visible, and scrolls to a match if necessary. Next and
Previous advance from the preview, unfold the match and reveal it. A match already in view stays
in place. On close, `acceptPreview()` selects the completed preview or returns `false`. Focus loss,
scrolling or a change to the query, selection, revision or visible folds cancels a pending preview.

After navigation, editing the end of the query adjusts the selected match if its start is unchanged.
`current` is zero-based. Without a preview it identifies the match containing the caret or exactly
covering the selection, or is `null`. `wrappedTo` reports `"start"`, `"end"` or `null`. Moving the
selection clears the wrap notice.

`matchesIn(from, to, capture?)` returns frozen, unclipped UTF-16 ranges intersecting `[from, to)`.
Point matches count at `from` and are excluded at `to`. An empty interval returns a point match at
that offset, including EOF. Use ordered, nonnegative safe integers within the document.

Pass the `FindSnapshot` you’re painting to `matchesIn`. It queries the paged index for that interval
and returns an empty array if the view expired, the revision or `matchesVersion` changed, or Find
hasn’t observed the new revision yet. Redraw on revision or match-version changes. The version changes
for new matches, resets, new queries and repairs. Moving to another match or scanning without finding
one keeps it stable.

After a complete scan, Next wraps from the last match to the first. While literal search repairs its
index (`searching` with `retained: true`), unchanged matches before the edit stay available.
For a single-line query, an unchanged line break also proves the matches on the lines after it.
The count and highlights include those matches. Next and Previous stay within the confirmed region
until the search verifies the intervening text. Replace Current can act on a confirmed selection.
Replace All, initial searches and regex navigation wait for a complete scan.

`status` is `idle`, `searching`, `ready`, `replacing`, `failed`, `cancelled`, `expired` or `disposed`.
A missing backend or failed worker sets a message. Expired or disposed controllers cannot target
replacement tabs. Disposing Find delivers its final snapshot and releases its listeners.
Subscribing to that snapshot later returns an inert disposer.

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
| `read-only` | The view is read-only or the resource disallows human edits |
| `edit-locked` | Another edit holds the resource. Retry after the lock is released. |
| `not-ready` | The resource is unavailable for editing |
| `composition-active` | Navigation/replacement is refused, or queued replacement is cancelled, for composition |
| `backend-unavailable` | Regular-expression mode has no configured backend |
| `search-failed` | Search construction, matching or result validation failed. For invalid regex syntax, the worker reports the engine's reason in the message. |
| `replacement-failed` | Replacement planning or plan validation failed |
| `view-unavailable` | The captured target or editor view is unavailable |
| `cancelled` | The host cancelled Find, or a new selection, edit, query, flag change or teardown interrupted replacement planning |
| `replaced` | `replacedCount` gives the number of matches in the accepted replacement, including matches whose text stayed the same. `count` tracks the current search results. |
| An `EditResult` refusal reason | The workspace rejected the final transaction; its reason is forwarded unchanged |

Use `reason` for decisions. A backend can send the same error text for a failed search and a failed
replacement. Starting another replacement or navigating to a match clears the notice. Changing a query
or disposing Find clears it unless that action interrupts a replacement. Scan progress and unchanged flags leave it in place. If you
cancel and then edit, the cancellation notice stays. Late replies to obsolete requests cannot change
it. When another notice takes its place or the notice clears, `replacedCount` returns to zero.

```ts
import type { FindSnapshot } from "sttropez/browser";

export function findNotice(state: FindSnapshot): string {
    if (state.reason === "replaced") return `Matches replaced: ${state.replacedCount.toLocaleString()}`;
    if (state.reason === "composition-active") return "Finish text composition first.";
    if (state.reason === "edit-locked") return "Try again after the other edit finishes.";
    return state.message || `${state.count} matches`;
}
```

### Literal matching and scheduling

Use `LiteralSearch(buffer, query, options?)` for headless literal search. `LiteralSearchOptions`
accepts `from` (default 0), `to` (default `buffer.length`), `wholeWord` and `matchCase`. Pass an
options object if supplied. Bounds and `SearchMatch` ranges use original UTF-16 offsets, with an
exclusive end. Matches cannot overlap. An empty query has no matches.

The kernel matches line endings exactly by default. With `lineEndings: "equivalent"`, as in
browser Find, an LF or CRLF in a literal query matches either ending, including in
mixed files. The range includes both units of a matched CRLF. A bare CR stays literal.

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
Setup, publication and paint take additional time. Regex search reads the worker's result in local steps.

Case-insensitive literal matching uses Unicode simple folding over code points. It does not
expand `ß` to `ss`, normalize combining sequences or apply locale-specific casing. Whole-word
constituents are Unicode letters, numbers, connector punctuation, combining marks and join
controls U+200C/U+200D. Both neighbors must be non-constituents or document edges; a match cannot
split a surrogate pair. Boundary checks can inspect context outside the requested bounds.

<a id="replacement-and-authority"></a>

### When a match can be replaced

Literal replacement inserts the supplied text verbatim, including `$&`, `$1` and raw newlines.
Replace Current acts on a selected or previewed match. With no qualifying selection or preview,
the first press selects the next match and leaves the text alone. A confirmed literal replacement
commits synchronously, even during index repair. An unchanged replacement lets repair continue.

After a replacement, Find selects the following match when the index is ready and the captured view,
selection, focus and visible folds are current. Enter and Shift+Enter work from the query field.
Moving focus between controls cancels waiting navigation, including within a shadow root.
Custom bars can call `editor.focus()` on close.

Replace All captures the revision, selections and tab generation. It checks each edit against the
index and yields every 1,024 edits. A selection, query, flag or target change cancels the plan.
An edit restarts the search. Composition blocks navigation and replacement. A read-only pane,
loss of edit permission or an edit lock blocks replacement, even if permission returns before the
next step.

The complete plan commits synchronously in one shared Undo step after a final authority check.
Pass `{ focusEditor: true }` to return focus from a disabled Replace All button. A control the
user focused while waiting keeps focus.

### Regular expressions and worker limits

Import `FindBackend`, `FindQueryCapture`, `FindSearchCursor`, `FindPlanCursor` and `FindPlanStep`
from `sttropez`. The browser entry supplies `createRegexFindBackend` for hosts that use a worker.
Each controller owns a backend with an idempotent `dispose`. Return one edit per indexed match
in the captured revision, including no-ops. For a manually selected overlap, return one edit if
the entire range matches in context, or finish with zero edits if it misses. The controller
handles navigation and commits replacements.

Patterns use native Unicode, global, multiline matching (`gmu`, adding `i` when match-case is
cleared). Supply the pattern without slash delimiters. Captures, lookarounds, Unicode properties
and replacement tokens (`$$`, `$&`, prefix/suffix, numbered and named groups) use platform
semantics. Line anchors follow LF rows: `^` matches document start or after LF; `$` matches before
LF or a complete CRLF, or at EOF. Bare CR, U+2028 and U+2029 do not create row boundaries.
Explicit patterns address raw text. Whole-word wrapping uses the same code-word constituents
as literal search and validates the bare pattern first.

To search for empty positions, enter `(?:)`. An empty query clears Find. Next visits distinct
matches and wraps. After replacing a zero-width match, Replace Current skips that occurrence.
Undo restores all selections.

| Limit or setting | Contract |
| --- | --- |
| Source | Up to 512,000 UTF-16 units. The first query for a revision sends its text. |
| Pattern | At most 4,096 UTF-16 units |
| Matches | Each match starts at a distinct UTF-16 offset, including a possible empty match at EOF. The browser processes up to 8,192 ranges per step. |
| Replacement template | At most 32,768 UTF-16 units |
| Replacement output | `maxOutputUnits` caps total inserted UTF-16 units (default and maximum 512,000). The resulting document must also fit in 512,000 units. |
| Replacement plan | The browser reads up to 1,024 edits per step and commits the complete plan in one transaction. |
| `regularExpressionDelayMs` | Controller query delay: default 80; finite value from 0 through 1,000 |
| `timeoutMs` | Backend exchange timeout: default 5,000; positive finite value |
| Worker protocol | Each query has one request and one reply. Serve the client and worker from the same package version. |

The worker reuses source for the same document, revision and immutable buffer. A new revision
requires another full transfer. Cancelling an active exchange terminates the worker and drops its
cache. Cancelling before the first message preserves an idle cache. A timeout terminates stalled
native matching.

The client ignores replies to old requests and checks current replies for size, range order and
output limits. The reply transfers the range offsets and, for a replacement, the insertion text.
A malformed reply, exceeded limit or worker failure discards the entire plan.

## Host responsibilities

Supply a worker URL to enable regex. Dispose the bar when its toolbar unmounts. For custom controls,
label partial counts, enable Replace All at `ready` and preserve focus when the user moves to another
form. Dispose the controller and its subscriptions on detach. Custom backends must respect
cancellation, source identity, match order and size limits.

## Not covered

Find searches one attached document at a time. A host that offers project-wide search must choose the
files and collect their results. [Search and review support](README.md#support-matrix)
