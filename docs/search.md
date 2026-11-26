# Find and replace

Find searches one pane. Replacements share its Undo history. Literal search runs on the main thread, regex
in an optional worker.

## Use

Attach searchable panes to the bar. Ctrl/Cmd+F opens Find, Ctrl/Cmd+H opens Replace and F3 repeats.

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

Focus selects the pane, or call `setTarget(editor)`. Customize `text`, `status` and `targetLabel`. For
custom controls attach one controller per editor.

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

For regex, serve `entries.regexWorker` from the matching [package](packaging.md). Omit the backend for
literal search only.

## Contract

### Options, matches and commands

The bar starts case-insensitive, the controller case-sensitive. Both start in literal mode with
`wholeWord: false`. Set the backend and delay at construction. Change search flags with `setFlags`.

`setQuery(query)` starts a search. Empty text clears it. `{ preview: true }` reveals without changing
selection or focus. `acceptPreview()` selects a completed preview. `next(1)` or `next(-1)` unfolds and
selects, wrapping after completion. `{ whenReady: true }` queues the latest direction.
`setHighlightMatches(false)` hides marks but keeps the index. `cancel()` clears it.

Read `getSnapshot()` and `subscribe()` for progress, `count`, zero-based `current` and `wrappedTo`. During
literal repair, navigation uses confirmed `retained` results. `matchesIn(from, to, snapshot)` returns
unclipped matches intersecting `[from, to)`. A stale revision or `matchesVersion` yields none. An empty
interval can return a point match, even at EOF.

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

`replacedCount` includes accepted no-ops. `count` counts current matches. Refusals distinguish permissions,
composition, unavailable pane or backend, cancellation, search and replacement failures. Rejected
transactions forward the workspace reason. Progress can retain an earlier notice.

### Literal matching and scheduling

`LiteralSearch` returns nonoverlapping UTF-16 ranges inside optional half-open bounds. Its line endings
match exactly. Browser Find uses `lineEndings: "equivalent"` for LF/CRLF. Bare CR stays literal.

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

`next(maxUnits?, maxMatches?)` defaults to 32,768 units and 8,192 matches. Both limits must be positive safe
integers. `scanned` gives the absolute offset, `readUnits` includes rereads. Case-insensitive search uses
Unicode simple folding. Whole-word checks include neighboring letters, numbers, connectors, combining marks
and join controls, even beyond the search bounds.

`getDiagnostics()` reports `maxScanStepMs` and `replaceTransactionMs`.
[Clock definitions](README.md#measuring-an-interaction)

<a id="replacement-and-authority"></a>

### When a match can be replaced

Enable Replace All when editable, `status === "ready"` and `count > 0`. Observe `readOnlyReason`. The saved
comparison pane allows navigation only.

`replaceCurrent(text)` replaces a selected or previewed match, otherwise it navigates. Confirmed literal
matches remain replaceable during repair. Literal replacement inserts verbatim. Find advances while view,
selection, focus and folds remain current.

`replaceAll(text)` captures revision, selections and tab generation. Composition or a change to permissions,
selection, query or target can cancel it. The plan commits in one Undo. `{ focusEditor: true }` returns
focus unless another control has taken it.

### Regular expressions and worker limits

Enter a pattern without slashes. Matching is global, Unicode and multiline, with `i` when ignoring case. Row
anchors recognize LF and CRLF. Bare CR, U+2028 and U+2029 stay within rows. `(?:)` matches empty positions.
Replace Current skips the zero-width occurrence it just replaced.

Replacement supports `$$`, `$&`, numbered and named groups, and prefix/suffix substitutions. The bar also
decodes `\n` and `\\` in regex replacements.

| Worker limit | Value |
| --- | --- |
| Pattern / template | 4,096 / 32,768 UTF-16 units |
| Output | `maxOutputUnits` limits total insertion, by default the source length plus 512,000 units. Worker offsets and insertion lengths fit unsigned 32-bit integers. |
| Timing | `regularExpressionDelayMs` defaults to 80 ms (0–1,000). Positive finite `timeoutMs` defaults to 5,000 ms. |

The worker caches by document, revision and buffer. Timeout or cancellation during matching terminates it.
Invalid ranges, excess output or failure discard the plan. Custom `FindBackend` plans need one edit per
indexed match, including no-ops. For a manually selected overlap, replace only an entire selection matching
in context.

## Host responsibilities

Supply the worker, label partial counts and dispose controllers and subscriptions on detach. Bind controls
to the pane and its edit permissions.

## Not covered

The host collects project-wide results. [Support matrix](README.md#support-matrix)
