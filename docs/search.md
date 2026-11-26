# Find and replace

Find searches one pane’s document. Replacements share its Undo history. Literal search runs
on the main thread. Regex uses an optional worker.

## Use

Attach each searchable pane to the bar. Ctrl/Cmd+F opens Find, Ctrl/Cmd+H opens Replace and
F3 repeats the search.

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

The bar follows pane focus. A toolbar can call `setTarget(editor)`. Use `text`, `status` and
`targetLabel` for host labels and messages. Dispose the bar on detach.
For custom controls, attach a controller to each editor.

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

Omit the backend for literal search only. Serve `entries.regexWorker` from the matching package.
[Package assets](packaging.md)

## Contract

### Options, matches and commands

The bar starts case-insensitive. A standalone controller starts with `matchCase: true`. Both
default to literal search with `wholeWord: false`. Configure the backend and delay at construction.
Use `setFlags` for search options.

- `setQuery(query)` starts a search. Empty text clears it. With `{ preview: true }` Find reveals a
  match without moving focus or selection. `acceptPreview()` selects the completed preview.
- `next(1)` and `next(-1)` select matches and open enclosing folds. Pass `{ whenReady: true }` to
  queue navigation during lookup. The latest direction wins. Completed searches wrap.
- `setHighlightMatches(false)` hides marks and keeps the index. `cancel()` clears the index.

Read `getSnapshot()` and `subscribe()` for progress, `count`, zero-based `current` and `wrappedTo`.
During literal repair, `retained` identifies confirmed results. Navigation stays within them until
the gap is checked. Paint with `matchesIn(from, to, snapshot)` for unclipped matches intersecting
`[from, to)`. A stale revision or `matchesVersion` yields none. An empty interval can return a
point match at its offset, including EOF.

### Notice reasons

Use `reason` for decisions, `message` for display and `status` for progress.

```ts
import type { FindSnapshot } from "sttropez/browser";

export function findNotice(state: FindSnapshot): string {
    if (state.reason === "replaced") return `Matches replaced: ${state.replacedCount.toLocaleString()}`;
    if (state.reason === "composition-active") return "Finish text composition first.";
    if (state.reason === "edit-locked") return "Try again after the other edit finishes.";
    return state.message || `${state.count} matches`;
}
```

`replacedCount` includes accepted no-ops. `count` is the current search count. Permission
refusals use `read-only`, `edit-locked` or `not-ready`. Other causes include `composition-active`,
`view-unavailable`, `backend-unavailable`, `search-failed`, `replacement-failed` and `cancelled`.
A rejected transaction forwards the workspace reason. Progress can leave an earlier notice visible.

### Literal matching and scheduling

`LiteralSearch` returns nonoverlapping UTF-16 ranges within optional half-open `from` and `to`
bounds. It matches line endings exactly. Browser Find uses `lineEndings: "equivalent"` to match
LF and CRLF interchangeably. Bare CR stays literal.

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

`next(maxUnits?, maxMatches?)` defaults to 32,768 units and 8,192 matches. Both must be positive
safe integers. `scanned` is an absolute offset. `readUnits` includes rereads. Case-insensitive
search uses Unicode simple folding. Whole-word boundaries consider letters, numbers, connector
punctuation, combining marks and join controls, including neighbors outside the search bounds.

`getDiagnostics()` exposes `maxScanStepMs` for one match/index step and `replaceTransactionMs`
for commit. [Interaction clocks](README.md#measuring-an-interaction)

<a id="replacement-and-authority"></a>

### When a match can be replaced

Enable Replace All for an editable target with `status === "ready"` and `count > 0`. Observe
the editor’s `readOnlyReason` too. In a saved comparison pane, matches allow navigation only.

`replaceCurrent(text)` replaces a selected or previewed match. Otherwise the first press
navigates. A confirmed literal match can be replaced during index repair. Literal replacements
insert the text verbatim. Find advances if the view, selection, focus and folds remain current.

`replaceAll(text)` plans against the captured revision, selection and tab generation.
Composition, lost edit authority or a changed selection, query or target can cancel it.
The full plan commits in one Undo. `{ focusEditor: true }` returns focus unless the user has
focused another control.

### Regular expressions and worker limits

Enter the pattern without slash delimiters. Matching uses Unicode, global and multiline semantics with
`i` when case is ignored. Row anchors recognize LF and CRLF. Bare CR, U+2028 and U+2029 do
not introduce rows. `(?:)` matches empty positions. Replace Current skips the zero-width
occurrence it just replaced.

Regex replacement supports `$$`, `$&`, numbered and named groups, and prefix/suffix substitutions.
The bar also interprets `\n` as a newline and `\\` as a backslash in regex replacements.

| Worker bound | Limit |
| --- | --- |
| Source / pattern / replacement template | 512,000 / 4,096 / 32,768 UTF-16 units |
| Output | `maxOutputUnits` limits total insertion (default and maximum 512,000). The resulting document must fit 512,000 units. |
| Timing | `regularExpressionDelayMs` defaults to 80 ms (0–1,000). Backend `timeoutMs` defaults to 5,000 ms and must be positive and finite. |

The worker caches text by document, revision and buffer. Cancellation during matching or a timeout
terminates it. Invalid ranges, excess output or failure discard the plan. A custom `FindBackend`
must return one edit per indexed match, including no-ops. For a manually selected overlap,
return an edit only if the entire selection matches in context.

## Host responsibilities

Supply the regex worker, label partial counts and release controllers and subscriptions on detach.
Keep custom controls bound to the chosen pane and its current edit permissions.

## Not covered

The host selects files and collects results for project-wide search. [Support matrix](README.md#support-matrix)
