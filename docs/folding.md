# Folding

Folding hides a block’s body in one pane. Its text, offsets and Undo history stay available.

## Use

Attach indentation and region-marker discovery to an editor.

```ts
import { discoverIndentationFolds } from "sttropez";
import { createFoldingController } from "sttropez/browser";
import type { FoldingController, TextEditor } from "sttropez/browser";

export function attachFolding(editor: TextEditor): FoldingController {
    return createFoldingController(editor, document =>
        discoverIndentationFolds(document.buffer, {
            tabSize: 2,
            group: "blocks",
            markers: [{ start: "#region", end: "#endregion", group: "regions" }]
        }));
}
```

`controller.setCollapsed(true, "regions")` collapses a group, preserving focus and logical selection. Omit
the group for all folds. Bind controls to `getSnapshot()` and `subscribe()`. Call `refresh()` after changing
discovery rules.

Customize gutter buttons and summaries with `settings.foldLabels`.

```ts
import type { FoldLabels } from "sttropez/browser";

export const frenchFolds: FoldLabels = {
    action: fold => fold.group === "imports" ? (fold.collapsed ? "Ouvrir les imports" : "Replier les imports") : undefined,
    summary: (fold, changed) => {
        const count = fold.lineTo - fold.lineFrom - 1;
        return `… ${count} ${count === 1 ? "ligne masquée" : "lignes masquées"}${changed ? " · avec modifications" : ""}`;
    },
};
```

`[lineFrom, lineTo)` is zero-based. Hidden gutter numbers run from `lineFrom + 2` through `lineTo`. Return
text or `undefined` for the default. `foldLabels: {}` resets both. Comparison settings apply to both panes
unless overridden on one editor.

Capture document, view and fold version before asynchronous discovery. Publish a complete outline with
stable IDs. Omit `collapsed` to retain user choices.

```ts
import type { DocumentView, FoldVersion } from "sttropez";

export function publishSection(
    view: DocumentView, expected: FoldVersion, from: number, to: number
) {
    return view.folding.setRanges(expected, [
        { id: "section", from, to, group: "sections" }
    ]);
}
```

## Contract

<a id="ranges-versions-and-projection"></a>

### How fold ranges map to visible rows

A `FoldRange` spans `[from, to)` UTF-16 units with a header and at least one body row. Ending at a line
start leaves that line visible. Folds must nest or stay disjoint, one per header. IDs are unique, nonempty
and at most 256 units. Optional groups must be nonempty. New folds start expanded.

`view.folding.setRanges(expected, ranges)` returns `false` on stale revision or generation. Invalid ranges
throw before publication. `setCollapsed` accepts one ID or an array. An empty array or any unknown ID
refuses the whole request. `{ moveHiddenCarets: true }` gathers hidden carets at header ends and merges
duplicates. Nonempty selections retain both endpoints. Folds and selections publish together.

`FoldIndex.rowAt` maps source to visible row, `lineAt` maps back, `headerAt` finds a header, and `hiddenBy`
identifies its containing fold. `sameProjection` compares hidden rows. `snapshot.regions` resolves all
ranges at that revision. Boundary edits may expand or remove folds. Folding preserves dirty state and
history.

### Discovery

`discoverIndentationFolds` includes interior blanks and excludes trailing blanks. Tab size defaults to 4
(1–256), group to `"indentation"`. Both marker prefixes must be nonempty and single-line. They follow
indentation and end at whitespace or line end. Unclosed markers yield no fold.

`createFoldingController` supplies a captured document and `AbortSignal` after `delayMs` (default 100,
finite and nonnegative). Return ranges, `{ ranges, isCurrent }`, a cursor or a promise for any. The
controller retains the outer range at a shared header and drops crossings. `initiallyCollapsed` affects new
folds. A block growing over a visible selection endpoint opens. Pending input settles before publication.
Stale replies expire and failure leaves mapped folds visible.

A cursor returns ranges at `ready` via `next(budget)` and `snapshot()`. Keep options stable. The controller
calls `dispose()` even for late cursors. Indentation discovery budgets visits, reads and output. Default
4,096 units, minimum 256, safe integers. Whitespace scans, native calls and host callbacks can exceed a
turn.

### Language-server discovery

`createLspFoldingClient(provider)` requests `textDocument/foldingRange` via `client.run({ document })`.
Cancel on abort, pass its `isCurrent` guard to the controller and dispose with the attachment.
[Language server](language-server.md)

Inclusive LSP end lines become exclusive offsets. Server kinds become groups. Character positions, collapsed
text, out-of-document ranges and ranges without body rows are ignored. Bare CR divides LSP lines, while the
editor needs LF for a second row. Malformed replies reject the batch. Expired captures reject with RPC code
`-32801`.

### Commands and interaction

Ctrl/Cmd+Shift+[ and Ctrl/Cmd+Shift+] run `fold.collapse` and `fold.expand` at the caret.
`fold.collapse-all` and `fold.expand-all` take an optional group, e.g.
`editor.commands.run("fold.collapse-all", "imports")`.

Gutter and command collapse move a hidden caret to the header end, where typing edits the header. Arrows and
Page keys skip hidden rows. Find, hunk navigation and explicit reveal open their target. A host may retain a
logical caret inside a fold.

Gutter line selection, triple-click and Ctrl/Cmd+L include the body and following ending. Moving a block
retains folds through Undo/Redo. A duplicate starts expanded. Undoing Delete Lines restores each pane’s fold
choices.

Clicking the disclosure returns editor focus. A focused disclosure handles Enter or Space. Escape returns to
the input. Clicking the hidden-line count expands while preserving selection. Counts add no clipboard text.

## Host responsibilities

Combine outline sources before `setRanges`. Abort superseded work. Publish after workspace notifications and
dispose subscriptions and controllers on detach. Retain the `DocumentView` for remount.
[View restoration](viewport.md#scrolling-and-saved-views)

## Not covered

[Display limits](README.md#support-matrix)
