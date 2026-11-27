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

Use `bar.setTarget(editor)` when opening Find from a menu. `bar.open()` focuses Find and `bar.open(true)` opens Replace.
`bar.close()` returns focus to the target. `bar.element` is the toolbar root. Focusing an attached editor also selects it. Ctrl+Alt+Enter replaces all and keeps Replace focused.
Find starts with a single-line selection or the word at the caret. A multiline selection keeps the last query.
Paste multiline text or use Ctrl/Cmd+Enter to insert a line break. In Replace, Tab moves from the query to
the replacement. Ctrl/Cmd+F returns to the query and keeps both fields open.

Customize `strings.findStatus`, `strings.text` and `targetLabel`. A custom toolbar can use the same shortcuts.
Forward keydown to `editor.keymap.handle` and supply callbacks for the actions it owns. Set
`toolbarFocused` with the close action so Escape dismisses Find first when the toolbar has focus.

```ts
import { bindFindCommands, createFindController, createRegexFindBackend } from "sttropez/browser";
import type { FindCommandOptions, TextEditor } from "sttropez/browser";

export function attachFind(editor: TextEditor, workerUrl: URL, fields: Omit<FindCommandOptions, "navigate">) {
    const find = createFindController(editor, { regularExpressionBackend: createRegexFindBackend({
        clock: editor.element.ownerDocument.defaultView!,
        createWorker: () => new Worker(workerUrl, { type: "module" })
    }) });
    const keys = bindFindCommands(editor, { ...fields, navigate: direction => find.next(direction).status === "done" });
    return { find, dispose() { keys.dispose(); find.dispose(); } };
}
```

Use `entries.regexWorker` from the matching [package](packaging.md). Omit the backend for literal search.

## Contract

### Options, matches and commands

Navigation, accepting a preview and replacement return an outcome. A successful command reports
`selected`, `replaced` or `queued` in `value`. Read the eventual replacement count or failure from the
subscribed snapshot. A disposed target returns `stale`. A refusal has a reason such as `no-match`,
`read-only` or `composition-active`.

The bar starts case-insensitive, the controller case-sensitive. Both start in literal mode with
`wholeWord: false`. Set the backend and delay at construction. Change search flags with `setFlags`.

`setQuery(query)` starts a search. Empty text clears it. `{ preview: true }` reveals without changing
selection or focus. `acceptPreview()` selects a completed preview. `next(1)` or `next(-1)` unfolds and
selects, wrapping once the index is complete. With `{ whenReady: true }`, a literal command finishes the search
and selects immediately. A pending regex search remembers the latest direction.
`setHighlightMatches(false)` hides marks but keeps the index. `cancel()` clears it.

Read `getSnapshot()` and `subscribe()` for progress, `count`, zero-based `current` and `wrappedTo`. During
literal repair, navigation uses confirmed `retained` results. `matchesIn(from, to, snapshot)` returns
unclipped matches intersecting `[from, to)`. A stale revision or `matchesVersion` yields none. An empty
interval can return a point match, even at EOF.

Use `reason` for decisions, `message` for display and `status` for progress.
`replacedCount` includes accepted no-ops. `count` counts current matches. Refusals distinguish permissions,
composition, unavailable pane or backend, cancellation, invalid regex syntax and other search or replacement failures. Rejected
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

`replaceAll(text)` commits indexed literal matches before returning. Regex waits for the worker and cancels
on composition or a change of revision, selection, permissions, query or target. Both use one Undo entry.
`{ focusEditor: true }` respects later focus changes.

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

Supply the worker, label partial counts and bind controls to the pane and its edit permissions. Dispose
controllers and subscriptions on detach. A disposed controller exposes its last snapshot and rejects new subscriptions.

## Not covered

The host collects project-wide results. [Support matrix](README.md#support-matrix)
