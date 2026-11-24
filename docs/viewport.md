# Text viewport

`mountTextViewport` renders the visible part of a workspace document. It provides scrolling,
decorations and local text geometry. For keyboard navigation, text selection and copying across
virtualized rows, use a [read-only editor](editor.md) with `readOnly: true`.

## Use

Give the container a width and height, load the [packaged CSS](getting-started.md), then pass an
existing document or text tab from the same workspace.

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

`TextViewport` exposes its `element` and `view`. Pass a `DocumentView` to keep it across mounts. The
viewport disposes views it creates.

## Contract

### Mounting and presentation

`mountTextViewport` accepts a document or a tab. A document mount works without an open tab. A tab mount clears its viewport when the tab is
replaced. Mount a new viewport for the replacement. Any supplied view must belong to the same
workspace and document.

| Option | Default and validation |
| --- | --- |
| `ariaLabel` | Document title when omitted |
| `view` | A new independent document view when omitted |
| `settings` | Initial presentation settings, all optional |

| Setting | Default and validation |
| --- | --- |
| `columnRulers` | Empty; at most 128 positive safe integers, copied, sorted and deduplicated |
| `highlightCurrentLine` | `false`; boolean |
| `gutter` | `true`; boolean |
| `fontLigatures` | `false`; boolean |
| `minimap` | `false`; boolean |
| `scrollBeyondLastLine` | `false`; boolean |

### Decoration layers

Editors and viewports expose the same `decorations` handle. Use a retained layer for diagnostics,
color swatches or annotations. Publish absolute UTF-16 offsets against the revision that supplied them.

```ts
import type { TextEditor } from "sttropez/browser";

export function markColor(editor: TextEditor, revision: number, from: number, to: number) {
    const layer = editor.decorations.add({ name: "colors", order: 30 });
    layer.set(revision, [{ from, to, className: "color-literal", before: "color-swatch",
        properties: { "--swatch-color": "#7494ad" }, afterLine: "Accent color" }]);
    return layer;
}
```

Style the marker with a host CSS class. For example, give `.color-swatch` a width, height and
`background: var(--swatch-color)`. Labels render as plain text after the line. Markers and labels
contribute no characters to selections or copied source. A point range paints a short mark at the caret stop.
Within a row, the selection background runs continuously across syntax tokens and inline decorations.

`set(revision, ranges)` copies its input and returns `false` for a stale revision or a retired view.
Offsets outside the revision throw. Edits move surviving ranges until the layer receives a replacement.
A deletion or replacement removes a point mark and its label when the point falls strictly inside
the edited range. Points at either boundary survive. Undo restores the text. The host can publish
the mark again against the restored revision.
`clear()` removes its marks. `dispose()` retires the layer. The view disposes all its layers on teardown.

For syntax, call `decorations.addProvider({ name, order, provide, lineClass })`.
`provide(line)` receives a bounded `PresentedLine` fragment with absolute offsets.
The optional `lineClass(line)` styles the whole row. To repaint changed lines, call the provider's
`invalidate(fromLine, toLine)` with zero-based lines and an exclusive end. Omit the bounds for a new
token stream. Layers apply in ascending order, with registration order breaking ties. A later layer
can override an earlier CSS custom property. The stylesheet controls precedence between classes.

### Viewport settings

Call `viewport.configure({ columnRulers: [80], minimap: true })` to change several settings together.
`viewport.settings()` returns their immutable values. Invalid settings leave the previous values intact.
An unchanged viewport setting schedules no paint. Configuration returns `false` after disposal.

| Setting | Effect |
| --- | --- |
| `columnRulers` | Guides at measured monospace cells from the left text origin |
| `gutter` | Shows line numbers and fold controls. Turning it off gives their width back to the text. |
| `highlightCurrentLine` | Highlights the primary caret’s row and emphasizes its line number, including on a folded header |
| `fontLigatures` | Native common and contextual font ligatures. Changes invalidate font and caret measurements. |
| `minimap` | A document overview with a draggable visible-region marker |
| `scrollBeyondLastLine` | Space to scroll the last visible row to the top text padding |

The gutter reserves four digits and grows for longer line numbers, up to a third of the viewport width.
Both comparison panes size their gutters for the longer document. Hiding the gutter preserves folds and keyboard commands.

Rulers and line highlights add no text or scroll range. Only a collapsed primary caret gets a line
highlight. Each view has its own settings. Set `--st-column-ruler`, `--st-current-line` and
`--st-current-line-border` in CSS to choose colors. Host `font-feature-settings` can override
individual ligatures.
In forced colors, a dotted outline identifies the current line.

The minimap draws short files at their miniature height. For long files, it samples line prefixes
across the folded or aligned document to fit the track. Decoration layers supply glyph colors and
row backgrounds, including in read-only views. Pass `minimap: false` when adding a transient layer
to leave it out of the overview. Folded lines disappear and alignment gaps stay blank. The previous
image stays visible until its replacement is complete. Call `viewport.invalidate()` after changing the theme or layout.

Hover for a line number and text. Click outside the marker to center that location, or drag the
marker to scroll. Both preserve focus, horizontal position and all selections. The marker covers a
document that fits and keeps a minimum grab height on long files. Style its edge and fill with
`--st-minimap-border` and `--st-minimap-marker`.

### Scrolling and saved views

`scrollTo({ top, left })` takes logical CSS units. Omit an axis to keep its position. Negative values
clamp to zero and nonfinite values throw. Large logical extents fit bounded physical scrollbars. Use
`revealOffset(offset, RevealOptions)` to expand a hidden target and schedule scrolling. Each axis
accepts `"center"` (default) or `"nearest"`. Nearest keeps a visible caret in place.
A scrollbar drag or track click preserves keyboard focus. When the editor has focus,
typing brings the edited caret back into view, including during a track animation.
Vertical `"center-if-outside"` keeps a fully visible row in place and centers it when it falls outside the viewport.
`affinity` takes
`"before"` or `"after"` (default). Ctrl/Meta-wheel passes through to browser zoom.

`revealRange(from, to, align?)` reveals a half-open UTF-16 range and opens folds that cover it.
It preserves the scroll position on each axis where the range is visible. Otherwise it centers the range on that
axis. If the range exceeds the viewport, it exposes the start. For multiline ranges it uses
the starting column and the full span of rows. Vertical placement defaults to `"center-if-outside"`.
Pass `"start"`, `"center"` or `"nearest"` to change it. The selection stays in place.

Save `captureView()` by document and view. `restoreView(state, options?)` cancels a pending reveal
and restores the scroll and selection together. A closed mount or a capture from another document returns `null`.

On the captured revision, restore uses the saved selection set, or `anchor` and `head` when the capture holds a single range. After an edit, a retained view keeps its live selections. A fresh view maps the saved
selection through the last edit when it connects the two revisions. Otherwise it clamps the saved
endpoints to the new length. Pass `{ selection: "current" }` to keep the mounted view’s selection
even when the revision is unchanged.

The returned `ViewRestoreResult.selection` is `"captured"`, `"current"`, `"mapped"` or `"clamped"`.
`horizontalAnchorRestored` and `verticalAnchorRestored` report which anchors could be placed.
An anchor can follow the last edit; a horizontal caret anchor can also follow the retained caret.
When an anchor expires, the saved scroll position applies within the viewport’s current bounds.
`foldsRestored` is true when a fresh view takes fold definitions from the same document and revision.
Existing folds stay with their view. [Folding](folding.md) · [Aligned panes and linked scrolling](comparison.md)

### Geometry and readiness

Use `coordsAt(offset, affinity?)` to place a popup at a caret, `hitTest(clientX, clientY)` to find
text under the pointer and `rowBounds(line)` to get `RenderedRowBounds`. These calls use client
coordinates, including inherited CSS zoom. Check the returned revision. A stale or unmounted fragment
can return `undefined`. Inside a grapheme, `coordsAt` uses affinity to choose an edge. The minimap is
outside the text hit area.

`getSnapshot()` returns the last painted geometry in local CSS pixels. `width` measures the text
area. `gutterWidth` measures the strip for line numbers and fold controls. `scrollTop` and
`scrollLeft` use logical document coordinates, including on very large files.

The zero-based interval `[lineFrom, lineTo)` runs from the first source line on screen through the
last, including partially visible rows. Its ends exclude overscan and comparison padding. The
interval is empty before the first paint, when only padding is visible, and after disposal.
`subscribe(listener)` reports geometry changes. A repaint with the same geometry keeps the same
frozen `ViewportSnapshot`. The returned function unsubscribes the listener.

Check `activity()` for the painted revision, selections, fold/alignment IDs, row generation, pending
frame and disposal. The immutable `ViewportActivity` is cached and reads no layout. Even with
`pending: false`, compare the painted state with the model and view. Call `flush()` to paint pending
work synchronously. `getDiagnostics()` returns `ViewportDiagnostics` with row and buffer-read counts,
overscan bounds and [render timings](README.md#glossary).

Call `onRender(listener)` before the first frame to observe initial paint, and keep its unsubscribe
function. A paint or scheduled render can notify even when rows stay the same. An idle `flush()` is
silent. Removing a listener takes effect during delivery. New listeners start next time. The browser
reports exceptions and continues. Recheck captures if an earlier listener could have changed the view.
Disposal removes all listeners.

### Anchored popups

Append your popup to the document body and pass it to `mountAnchoredOverlay(editor, element)`.
Use `show({ revision, offset })` for a caret, with optional `affinity`. Use
`show({ revision, from, to })` for a half-open UTF-16 range. A range anchors to the left edge of its
first visible text row, even when both endpoints are offscreen. The popup clears the row's full
height. An empty range uses the caret.
Scrolling, resizing and folding update the placement. The popup hides while its anchor is outside
the text viewport and reappears when the source is visible again. A new revision expires the anchor.
If a popup control has focus, `onFocusedAnchorHidden` lets the host return focus before the
popup hides. This applies when the anchor scrolls out of view, folds away or expires on a new revision.

The popup opens below the line by default. Pass `{ prefer: "above" }` to prefer the other side.
The popup keeps its position while its content fits. It can move when it grows or the available
space changes. Set a numeric `priority` when several popups share an editor. A popup
can stack beyond a higher-priority popup to show its full height. When space is tight, it takes
the largest available interval and scrolls its content. The default priority is zero.

Pass `dismissOn: ["focus-leave"]` to close when focus leaves both the editor and the popup.
`"outside-pointerdown"` closes on a pointer press outside both. `onDismiss(reason)` runs once
after the popup closes. The host can cancel a pending request there. Neither event moves focus.
Without `dismissOn`, the host controls dismissal.

`hide()` releases the placement and dismissal listeners. Call `dispose()` when
removing the popup. Disposing the editor also releases the attachment.

### Input adapter ownership

If you write your own input adapter, call `bindInput(focus)` once per viewport for a
`ViewportInputBinding`. The [editor](editor.md) already does this. The callback restores source focus
when the viewport itself receives focus, after a pointer fold toggle, on Escape from a fold button,
or when a focused fold control disappears. Binding removes the viewport root from the tab
order and hides its duplicate text from semantic navigation. `setComposing(boolean)` updates
composition styling and guards fold clicks. Fold controls stay outside the Tab order.

`setComposing` returns whether it changed the live binding. Call `dispose()` to restore the viewport’s tab stop and
clear composition styling. An expired binding returns `false` from `setComposing`, even after a new adapter
binds. Binding twice, or binding a destroyed or replaced viewport, throws. The viewport drops its
focus callback and render listeners on disposal. If the focus callback detaches the mount, rendering
stops there.

### Rendering limits

| Area | Contract or limit |
| --- | --- |
| Document reads | Visible rows plus four surrounding rows per edge; horizontal fragments add 32 UTF-16 units per edge, with short-row and surrogate-boundary adjustments; no whole-document text export |
| Short lines | Lines up to 512 UTF-16 units render with their complete shaping context |
| Long lines | Horizontal windows estimate position from UTF-16 units and the monospace cell’s layout width. The estimate stays stable across native scroll positions. |
| Line endings | LF creates a row; CR before LF is omitted from display; lone CR is displayed as a control symbol |
| Geometry | Native text ranges measure mounted fragments; geometry outside those fragments is unavailable |
| Updates | Relevant changes coalesce into animation frames; unchanged row text/classes retain their nodes |

The rendered text sets the horizontal scroll range. A full-width background can color an entire row
without adding a scrollbar when the text fits.

On a long line, the viewport measures the visible fragment and estimates where it starts. Tabs,
combining marks and contextual shaping can shift that estimate. An explicit reveal can keep the caret
in place without reading the entire line. Manual scrolling clears that placement. For editable input,
mount the [editor](editor.md).

## Host responsibilities

Supply layout, CSS, fonts and decorations. Put host controls outside the viewport DOM. Keep the view
to preserve selections and folds across mounts, and save scroll state separately. Call `dispose()`
to cancel frames, disconnect observers and remove the viewport. Release host-owned views and
resources when you finish with them.

## Not covered

Rows use left-to-right geometry without word wrapping. See the
[support matrix](README.md#support-matrix) for layout and device limits.
