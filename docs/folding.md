# Folding

A folded block shows its header and hides its body in one view. Its text, offsets and Undo history
stay available. Two panes of the same document can fold different blocks.

## Use

Attach indentation and region-marker discovery to a mounted editor.

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

`controller.setCollapsed(true, "regions")` collapses that group while preserving focus and logical
selection. Omit the group to act on all folds. Bind a toolbar to `getSnapshot()` and `subscribe()`.
Call `refresh()` when discovery rules change.

Use `settings.foldLabels` to customize gutter buttons and collapsed summaries. This example labels
import groups in French and shows whether hidden lines contain changes.

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

`lineFrom` and `lineTo` are zero-based with an exclusive end. Hidden gutter numbers run from
`lineFrom + 2` through `lineTo`. Return plain text or `undefined` for the default. Use
`foldLabels: {}` to reset both labels. Comparison settings apply to both panes. Configure one
editor to override that pane.

For a host outline, capture the document, view and fold version before starting discovery. Publish
the complete outline to that view. Keep IDs stable and omit `collapsed` to retain the user's choices.

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

A `FoldRange` covers `[from, to)` in UTF-16 offsets. Its first row is the header. Include at least
one body row. Ending at the next line's start leaves that line visible. Folds must nest or stay
disjoint, with one ID per header. Give each a unique nonempty ID of at most 256 units and an
optional nonempty group. New folds default to expanded.

`view.folding.setRanges(expected, ranges)` checks the view's revision and fold generation. A
stale target returns `false`. Invalid ranges throw before publication. `setCollapsed` accepts
one ID or an array. An empty array or unknown ID returns `false` for the whole request.
`{ moveHiddenCarets: true }` gathers hidden carets at their header's end and merges coincident
carets. Nonempty selections keep both endpoints. The view publishes folds and selections together.

`FoldIndex.rowAt` maps a source line to its visible row. `lineAt` maps back, `headerAt` finds a
header and `hiddenBy` finds the block concealing a line. `sameProjection` compares hidden rows.
Reading `snapshot.regions` resolves the full list at the captured revision. Editing a boundary
can expand or invalidate a fold. Folding leaves dirty state and document history unchanged.

### Discovery

`discoverIndentationFolds` groups indented blocks, including interior blank lines and excluding
trailing blank lines. Defaults are tab size 4 (range 1–256) and group `"indentation"`. Marker
prefixes follow indentation and must end at whitespace or line end. Give both markers nonempty,
single-line prefixes. Unclosed markers produce no fold.

`createFoldingController` passes the captured document and an `AbortSignal` to discovery after
`delayMs` (default 100, finite and nonnegative). Return ranges, `{ ranges, isCurrent }`, a cursor
or a promise for any of these. The controller keeps the outer range at a shared header and drops
crossing ranges. `initiallyCollapsed` applies to new folds. A block that grows over a visible
selection endpoint opens. A late reply for an edited document or expired provider cannot replace
the outline. Pending input settles before publication. On failure the mapped folds stay visible.

A discovery cursor supplies `next(budget)`, `snapshot()` and `dispose()`. Keep its options stable
until completion and return the ranges at `ready`. The controller disposes late cursors too.
Indentation discovery defaults to 4,096 work units per advance and accepts safe integers of at
least 256. Reads, row visits and output contribute to the count. Long whitespace scans, native
calls or host callbacks can exceed a turn. [Interaction clocks](README.md#measuring-an-interaction)

### Language-server discovery

Use `createLspFoldingClient(provider)` for `textDocument/foldingRange`. Call `client.run({ document })`,
cancel on abort and pass the resolved batch to the controller with its `isCurrent` guard intact.
Dispose the client with its attachment. [Language server](language-server.md)

The client turns inclusive LSP end lines into exclusive source offsets and uses server kinds as
groups. It ignores character positions, collapsed text and ranges outside the document or with no
body row. Bare CR divides LSP lines, but the editor needs an LF to show a second row. A malformed
reply rejects the batch. An expired capture rejects with RPC code `-32801`.

### Commands and interaction

- **Toggle.** Ctrl/Cmd+Shift+[ collapses at the caret and Ctrl/Cmd+Shift+] expands. The commands
  are `fold.collapse` and `fold.expand`. `fold.collapse-all` and `fold.expand-all` act across the
  view. Pass a group to limit a command, for example `editor.commands.run("fold.collapse-all", "imports")`.
- **Type and navigate.** A gutter click or collapse command moves a hidden insertion caret to
  the header's end. Typing there edits the header. Arrow and Page keys skip hidden rows. Find or
  an explicit reveal opens the target. A host can keep a logical caret inside a fold.
- **Select and move lines.** Selecting the header with the gutter, a triple-click or Ctrl/Cmd+L
  includes its body and following line ending. Moving a folded block carries its folds through
  Undo and Redo. Duplicating it leaves the copy expanded. Undoing Delete Lines restores the block
  and each pane's fold choices.
- **Gutter and review.** Clicking the disclosure returns focus to the editor. A focused button
  handles Enter or Space, and Escape returns to the input. Clicking a hidden-line count opens the
  fold and preserves selection. The count adds no clipboard text. Revealing a hunk opens the target
  in its pane.

## Host responsibilities

Combine outline sources before `setRanges`. Abort superseded work, publish after workspace
notifications and dispose controllers and subscriptions on detach. Retain the `DocumentView`
to keep its folds across remounts. [Restoring a saved view](viewport.md#scrolling-and-saved-views)

## Not covered

See the [support matrix](README.md#support-matrix) for display limits.
