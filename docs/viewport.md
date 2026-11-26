# Text viewport

`mountTextViewport` draws visible rows and exposes their geometry. Use a [read-only editor](editor.md#use)
for keyboard selection and copying across virtualized rows.

## Use

Size the container and load the [editor stylesheet](getting-started.md#open-the-first-editor).

```ts
import type { DocumentId, Workspace } from "sttropez";
import { mountTextViewport } from "sttropez/browser";
import type { TextViewportOptions } from "sttropez/browser";

export function showPreview(host: HTMLElement, workspace: Workspace, documentId: DocumentId) {
    const options: TextViewportOptions = {
        ariaLabel: "Source preview",
        settings: { columnRulers: [80, 120], minimap: true, highlightCurrentLine: true }
    };
    const viewport = mountTextViewport(host, workspace, documentId, options);
    viewport.revealOffset(0, { horizontal: "nearest", vertical: "nearest" });
    return viewport; // Call dispose() when the host detaches this projection.
}
```

## Contract

### Mounting and presentation

Mount by document ID for a preview or tab ID to clear it on tab replacement. `ariaLabel` defaults to the
title. An explicit `view` from the same workspace and document preserves selections and folds across mounts.
The viewport disposes views it creates.

### Theme the editor

Set CSS properties on the host. A comparison passes them to both panes.

```css
.source-pane {
    --st-background: #18212c;
    --st-foreground: #eef2f7;
    --st-gutter-foreground: #abb9c8;
    --st-selection: #345578;
    --st-font: Consolas, monospace;
    --st-font-size: 15px;
    --st-line-height: 24px;
}
```

After changing a font or theme, `invalidate()` refreshes measurements and the minimap.

### Decoration layers

Use absolute UTF-16 offsets from the inspected revision.

```ts
import type { TextEditor } from "sttropez/browser";

export function markColor(editor: TextEditor, revision: number, from: number, to: number) {
    const layer = editor.decorations.add({ order: 32 });
    layer.set(revision, [{ from, to, className: "color-literal", before: "color-swatch",
        properties: { "--swatch-color": "#7494ad" }, afterLine: "Accent color" }]);
    return layer;
}
```

Size `.color-swatch` and set `background: var(--swatch-color)`. A point marks a caret stop. `afterLine` adds
a label. Neither contributes clipboard text. Inline classes accept space-separated tokens up to 64
characters each, 256 total.

`set(revision, ranges)` copies ranges, throws on invalid offsets and returns `false` for a stale revision or
retired view. Edits map marks. A deletion removes points inside it and preserves boundary points. Republish
removed marks after Undo. `clear()` empties the layer, `dispose()` retires it.

For syntax, `addProvider({ order, provide, lineClass })` receives mounted fragments with absolute offsets.
`lineClass` styles the row. `invalidate(fromLine, toLine)` refreshes a zero-based half-open interval. Omit
bounds for all lines.

Paint order is comparison (10), occurrences (20), snippets (25), links (30), swatches (35), diagnostics
(40), Find (60), brackets (100), and character warnings and definition links (110). Ties follow registration
order. Later layers can override custom properties. CSS determines class precedence.

### Viewport settings

Read `settings()` and apply changes together with `configure({ columnRulers: [80], minimap: true })`.
Invalid input preserves prior settings.

| Setting | Default and effect |
| --- | --- |
| `columnRulers` | Empty. Up to 128 positive safe-integer monospace columns. |
| `gutter`, `foldLabels` | Gutter on. Hiding it keeps folds. Override [fold labels](folding.md#use) with a translation. |
| `highlightCurrentLine` | Off. Marks selection heads in the gutter and the collapsed primary caret’s row. |
| `fontLigatures`, `scrollBeyondLastLine` | Off. Enable contextual/common ligatures or let the last row scroll to the top. |
| `minimap`, `minimapLabel` | Map off. Override the label for a one-based line or `null` comparison gap. |

Click outside the minimap marker to center a line, drag it to scroll, or hover to preview. Focus, horizontal
position and selection stay put. Long files sample line prefixes. Folds disappear and alignment gaps stay
blank. The old image stays during redraw. Opt a decoration layer out with `minimap: false`.

Theme the marker with `--st-minimap-marker` and `--st-minimap-border`, rulers with `--st-column-ruler`, and
the active row with `--st-current-line` and `--st-current-line-border`.

### Scrolling and saved views

`scrollTo({ top, left })` uses logical CSS pixels and keeps omitted axes. Scrollbars preserve focus. Typing
reveals the edited caret.

`revealOffset(offset, options)` unfolds the target. Both axes default to `"center"` and accept `"nearest"`.
Vertical `"center-if-outside"` centers a clipped row. Default affinity is `"after"`.
`revealRange(from, to, align?)` unfolds a half-open range without moving selection. Default
`"center-if-outside"` preserves visible rows or shows the start of an oversized range. Multiline ranges use
the starting column. Other alignments are `"start"`, `"center"` and `"nearest"`.

Save `captureView()` per document and view. `restoreView(state)` cancels pending reveal and restores
selection and scroll together. A closed mount or other document returns `null`. The selection result is
`"captured"` for saved ranges, `"current"` for retained edits or an explicit current selection, `"mapped"`
for a fresh view after one edit, or `"clamped"` for older endpoints brought into bounds.

If the primary caret is visible at capture, a narrower pane keeps it in view. Check `horizontalAnchorRestored`,
`verticalAnchorRestored` and `foldsRestored` to see which anchors and folds survived.
[Aligned panes](comparison.md#linked-scrolling-and-aligned-rows)

### Geometry and readiness

`coordsAt(offset, affinity?)`, `rowBounds(line)` and `hitTest(clientX, clientY)` use client coordinates
including CSS zoom. Check the revision and handle `undefined` for unmounted text. Affinity chooses a
grapheme edge. Text hit tests exclude the minimap.

`getSnapshot()` reports painted geometry in local CSS pixels. `[lineFrom, lineTo)` includes partial rows,
excludes overscan and is empty before paint, over padding alone and after disposal. For readiness, match
`activity().revision`, painted selections, folds and alignment to the model. Check the actual row and
geometry for visible edits.

`subscribe()` reports geometry changes. `onRender()` includes paints with unchanged geometry. Subscribe
before the first frame to observe it. Both return an unsubscribe function. `flush()` paints pending work. An
idle flush sends no notification. `getDiagnostics()` reports rows, buffer reads and render duration.
[Clocks](README.md#measuring-an-interaction)

### Anchored popups

`mountAnchoredOverlay(editor, element)` mounts detached elements in the top layer with editor styles.
Host elements stay put. Call `show({ revision, offset, affinity? }, focusTarget?)` for a caret
or pass `{ revision, from, to }` for the first visible row of a half-open range. Placement focuses the
field or button. Clipping, dismissal or another call cancels pending focus.

Popups follow scrolling, folds and resizing. Clipped anchors can reappear until the revision changes.
Placement defaults to below. Use `prefer: "above"` to reverse it. Higher `priority` wins space.
Overflow scrolls.

`dismissOn` accepts `"focus-leave"` or `"outside-pointerdown"` outside editor and popup.
`onHide(reason, hadFocus)` reports clipping, expiry or dismissal. Disposal removes detached elements.
Disposing the editor releases all its overlays.

### Input adapter ownership

A standalone viewport’s `bindInput(focus)` returns gutter focus to the input and removes the root tab stop.
`setComposing(active)` guards fold clicks. Dispose the binding before replacing it. Editors bind their own
adapter.

### Rendering limits

Paint covers visible rows plus four at each edge. Lines up to 512 UTF-16 units keep full shaping context.
Longer lines use horizontal fragments with 32 extra units per edge and surrogate-boundary adjustments. Tabs,
combining marks and contextual shaping can shift horizontal estimates. Reveal can pin the caret until manual
scroll.

LF starts a row, CR before LF is hidden and lone CR displays a control symbol. Text sets horizontal extent.
Frames reuse unchanged rows.

## Host responsibilities

Size and style the host. Keep controls outside the viewport subtree. Dispose the mount on detach and release
retained views and resources.

## Not covered

Rows use unwrapped, left-to-right geometry. [Layout and device support](README.md#support-matrix)
