# Find and replace

`createFindController` searches a captured editor view and applies replacements through shared
workspace history. Hosts render the controls and choose keyboard bindings. Literal search
works directly over the text buffer; regular expressions use an optional dedicated worker.

## Use

Create one controller for an editor attachment. This example enables both search modes:

```ts
import type { TabId, Workspace } from "sttropez";
import { createFindController, createRegexFindBackend } from "sttropez/browser";
import type { EditingCandidate } from "sttropez/browser";

export function attachFind(
    workspace: Workspace, tab: TabId, editor: EditingCandidate, workerUrl: URL
) {
    const clock = editor.element.ownerDocument.defaultView;
    if (!clock) throw new Error("The editor needs an attached browser window.");
    return createFindController(workspace, tab, editor, {
        regularExpression: createRegexFindBackend({
            clock,
            createWorker: () => new Worker(workerUrl, { type: "module" })
        })
    });
}
```

Resolve `workerUrl` to the packaged `browser/regex-worker.js` asset, identified by
`manifest.json`'s `entries.regexWorker`. Serve the worker from the same package version as the
client. The [packaging contract](packaging.md) describes asset staging. Literal-only hosts can
omit the configuration; literal mode starts no worker.

Subscribe to `FindController.state` to render progress, match counts and failures. Call
`setQuery("name")`, `setOptions({ wholeWord: true })` and `next()` from host controls.
Call `replaceAll("newName")` after the state becomes `ready`. Destroy the controller before
destroying its editor.

## Contract

### Options, matches and commands

`createFindController` requires the workspace, tab and editor to identify the same live text view. It captures
the tab generation and retains a resource lease; focus changes never redirect its commands.
`FindSnapshot` is immutable and includes query/options, revision, status, count, scan frontier,
source length, current match index, match version, reason, message and component timings.

| Option or command | Behavior |
| --- | --- |
| `wholeWord` | Defaults to `false`; code-word boundaries when enabled |
| `matchCase` | Defaults to `true`; locale-independent simple folding when disabled in literal mode |
| `regularExpression` | Defaults to `false`; requires a configured `FindBackend` when enabled |
| `setQuery(query)` | Cancels obsolete work and starts a search; an empty query is idle |
| `setOptions(options)` | Patches only supplied flags; unchanged options do not restart work |
| `next(direction?)` | Selects a match in the captured view; direction is `1` by default or `-1` |
| `replaceCurrent(text)` | Replaces an eligible current selection, or selects the next match |
| `replaceAll(text)` | Plans a replacement from a completed index and commits one history command |
| `cancel()` | Clears the index; later typing does not resume the cancelled search |
| `destroy()` | Releases work, subscriptions, focus tracking, backend and resource lease |

`matchesIn(from, to, capture?)` returns frozen UTF-16 match ranges intersecting `[from, to)`.
It includes matches crossing either boundary without clipping their offsets. Point matches
are included at `from` but excluded at `to`; an empty interval returns only a point match at
that offset, including end of document. Hosts can omit point matches when painting text spans.
Bounds must be ordered, nonnegative safe integers within the current document.

Range queries search the paged index and visit only intersecting matches, with no prefix cap
or full-document paint scan. Index memory grows with match count. Pass the `FindSnapshot`
captured by the presentation callback to reject obsolete results: a changed revision or
`matchesVersion`, unavailable view, or a document revision not yet observed by find returns
an empty array. Returned arrays remain immutable after further work. Subscribe to state and
invalidate presentation when revision or `matchesVersion` changes; navigation and scan-only
progress do not change the match version. Query changes, resets, repairs and new matches do.

A completed index wraps. During literal repair,
`status: "searching"` with `retained: true` exposes a confirmed prefix: counts and range results are
partial, navigation cannot wrap or skip an unsearched region, and current replacement can use
only confirmed matches. Initial and regular-expression searches wait for completion.

States are `idle`, `searching`, `ready`, `replacing`, `failed`, `cancelled`, `expired` and
`disposed`. A missing backend or failed worker produces an explicit message. Expired or destroyed
controllers cannot address a replacement tab. See the [clock glossary](README.md#glossary) for
the boundaries of `maxScanStepMs` and `replaceTransactionMs`.

### Notice reasons

`FindSnapshot.reason` is a `FindReason` or `null`. Use it for programmatic decisions and
localization; `message` supplies default display text. The two fields are published together.
Reasons describe the last published notice. Read `status` for progress and resource capabilities
for current editing permissions. An ignored command can leave the previous notice intact.

| Reason | Meaning |
| --- | --- |
| `null` | No notice; the message is empty |
| `editing-unavailable` | Replacement is refused or cancelled because the view is read-only or resource authority is unavailable |
| `composition-active` | Navigation/replacement is refused, or queued replacement is cancelled, for composition |
| `backend-unavailable` | Regular-expression mode has no configured backend |
| `search-failed` | Search construction, matching or result validation failed |
| `replacement-failed` | Replacement planning or plan validation failed |
| `view-unavailable` | The captured target or editor view is unavailable |
| `cancelled` | The host explicitly cancelled find |
| `replaced` | A replacement transaction was accepted, including a no-op |
| An `EditResult` refusal reason | The workspace rejected the final transaction; its reason is forwarded unchanged |

Starting/restarting a query, changing options, successful navigation, starting a queued
replacement and destruction clear the notice. Unchanged options do not clear it. Scan progress,
completion and timing-only publications preserve it; edits while cancelled preserve the
cancellation notice. Obsolete asynchronous replies cannot overwrite it. Backend error text is
display data: identical text can have different reasons depending on which operation failed.

```ts
import type { FindSnapshot } from "sttropez/browser";

export function findNotice(state: FindSnapshot): string {
    if (state.reason === "composition-active") return "Finish text composition first.";
    if (state.reason === "editing-unavailable") return "Editing is unavailable for this view.";
    return state.message || `${state.count} matches`;
}
```

### Literal matching and scheduling

`LiteralSearch(buffer, query, options?)` is the headless cursor underlying literal find. It accepts
an immutable buffer, a query and an optional `LiteralSearchOptions` object with `from`, `to`,
`wholeWord` and `matchCase`. Bounds default to `0` and `buffer.length`; options must be an object.
Bounds and returned `SearchMatch` ranges use original UTF-16 offsets; `to` is exclusive.
Matching is non-overlapping and preserves raw line endings. An empty query has no matches.

```ts
import { LiteralSearch } from "sttropez";
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

`next(maxUnits?, maxMatches?)` returns a frozen `SearchStep` with completion, absolute scan
frontier, units read and matches. Budgets default to 32,768 units and 8,192 matches and must be
positive safe integers. Dispose or close the generator when abandoning a scan. Preparation
is synchronous and proportional to query length; work budgets are not elapsed-time deadlines.
The browser controller advances literal scans by at most 4,096 read units/1,024 matches.
A task batches at most 32 advances, checking its cooperative 4 ms target after each advance
and index update, then publishes progress once. Its first repair advance permits 64 matches
to find a nearby reusable suffix. Repeated patterns can require a full suffix scan; unknown
revision lineage requires a full search. These limits bound scan work, not query preparation,
publication, rendering or a hard callback deadline. `maxScanStepMs` measures an individual
matching/index span, not the complete batched task. Regex backends retain one request in
flight and schedule the next step only after its result is processed.

Case-insensitive literal matching uses Unicode simple folding over code points. It does not
expand `ß` to `ss`, normalize combining sequences or apply locale-specific casing. Whole-word
constituents are Unicode letters, numbers, connector punctuation, combining marks and join
controls U+200C/U+200D. Both neighbors must be non-constituents or document edges; a match cannot
split a surrogate pair. Boundary checks can inspect context outside the requested bounds.

### Replacement and authority

Literal replacement inserts its argument literally, including `$&`, `$1` and raw newline
sequences. Current replacement requires a matching selection; whole-word replacement also
requires membership in the index. Otherwise the command selects the next match. Navigation
and replacement reject active composition. Read-only state, edit capabilities and edit leases
guard replacement independently of search availability.

Literal current-match replacement completes synchronously, including while confirmed matches
remain available during repair. A no-op replacement leaves that repair running. Literal planning
reuses the captured match index; it neither rescans the source nor builds another index.
Headless plan assembly copies each accepted edit, validates its exact captured match range
and exposes a complete immutable edit list only after the backend supplies every match.

Replace-all planning yields every 1,024 edits and captures document revision, the complete
selection set and tab generation. Each plan step rechecks the editor's read-only state and
composition state. One atomic transaction rechecks authority and creates one
shared undo unit. Editing restarts search; selection/query changes, composition, tab replacement
and disposal invalidate queued replacement. Losing edit permission or acquiring an edit lease
cancels a queued command even if permission returns before its next step. Retry explicitly with
a fresh capture. Focus returns to the captured editor only if no new element gains focus during
planning. The final transaction is synchronous and proportional to the changed ranges.

### Regular expressions and worker limits

`createRegexFindBackend(RegexFindBackendOptions)` implements `FindBackend`. One controller owns
one backend through expiry or destruction; its `dispose` must be idempotent. Custom backends
supply `FindSearchCursor` and `FindPlanCursor` results for the exact `FindQueryCapture`; they
produce plans, while the controller owns the transaction. Each plan includes one edit per
indexed match, including no-ops.

Patterns use native Unicode, global, multiline matching (`gmu`, adding `i` when match-case is
cleared). Supply the pattern without slash delimiters. Captures, lookarounds, Unicode properties
and replacement tokens (`$$`, `$&`, prefix/suffix, numbered and named groups) use platform
semantics. Line anchors follow LF rows: `^` matches document start or after LF; `$` matches before
LF or a complete CRLF, or at EOF. Bare CR, U+2028 and U+2029 do not create row boundaries.
Explicit patterns address raw text. Whole-word wrapping uses the same code-word constituents
as literal search and validates the bare pattern first.

Use `(?:)` for zero-width matches; an empty query is idle. Navigation advances between distinct
matches and wraps. Current replacement accepts an indexed match or a manually selected nonempty
overlap validated in full source context. The next current command skips a just-replaced
zero-width occurrence. Undo restores complete selections.

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

Completed searches and plans retain a worker/source cache keyed by document, revision and
immutable buffer identity. Query changes can reuse that source. Changed revisions transfer the
complete source again. Cancelling active exchanges or result streams terminates the worker and
drops the cache; a query cancelled before its first message preserves an idle cache. A timeout
terminates a worker stuck in native matching. Limits, malformed replies and worker failures
reject incomplete plans without partial edits. Identified replies for older requests are ignored.
Current replies pass bounded message validation before captured raw-range, ordering and output checks.
Final fragment assembly and model application
are synchronous bulk work.

## Host responsibilities

Own find/replacement controls, keyboard bindings, option persistence, messages and worker URLs.
Render partial counts as partial, wait for readiness before replace-all, and preserve exact
view identity across asynchronous UI work. Subscribe and unsubscribe with the attachment;
call `destroy()` before releasing its view. Keep surrounding form focus independent of delayed
editor commands. If supplying a backend, honor cursor cancellation, captured source identity,
validated match order, replacement bounds and explicit disposal.

## Not covered

See the [support matrix](README.md#support-matrix) for unsupported features and device checks.
