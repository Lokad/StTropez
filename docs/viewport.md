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

`set(revision, ranges)` copies its input and returns `false` for a stale revision or a retired view.
Offsets outside the revision throw. Edits move surviving ranges until the layer receives a replacement.
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
| `highlightCurrentLine` | Background for the primary collapsed caret, including a folded header |
| `fontLigatures` | Native common and contextual font ligatures. Changes invalidate font and caret measurements. |
| `minimap` | A document overview with a draggable visible-region marker |
| `scrollBeyondLastLine` | Space to scroll the last visible row to the top text padding |

Rulers and line highlights add no text or scroll range. Only a collapsed primary caret gets a line
highlight. Each view has its own settings. Set `--st-column-ruler`, `--st-current-line` and
`--st-current-line-border` in CSS to choose colors. Host `font-feature-settings` can override
individual ligatures.

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
Vertical `"center-if-outside"` keeps a fully visible row in place and centers it when it falls outside the viewport.
`affinity` takes
`"before"` or `"after"` (default). Ctrl/Meta-wheel passes through to browser zoom.

`revealRange(from, to)` reveals a half-open UTF-16 range and opens folds that cover it.
It preserves the scroll position on each axis where the range is visible. Otherwise it centers the range on that
axis. If the range exceeds the viewport, it exposes the start. For multiline ranges it uses
the starting column and the full span of rows. The selection stays in place.

Save `captureView()` by document and view ID to restore selections, scroll and folds. `restoreView()`
checks scroll and anchor values before changing anything. On the same revision, its anchors keep the
same text in place on both axes. A new, empty view of that document and revision can take the captured
folds. A view with newer folds keeps them. [Folding](folding.md) ·
[Aligned panes and linked scrolling](comparison.md)

### Geometry and readiness

Use `coordsAt(offset, affinity?)` to place a popup at a caret, `hitTest(clientX, clientY)` to find
text under the pointer and `rowBounds(line)` to get `RenderedRowBounds`. These calls use client
coordinates, including inherited CSS zoom. Check the returned revision. A stale or unmounted fragment
can return `undefined`. Inside a grapheme, `coordsAt` uses affinity to choose an edge. The minimap is
outside the text hit area.

Read the viewport snapshot for the available text width. Scroll in local CSS units. To navigate from a
host control, set the captured view’s selection and call `revealOffset`. The [editor](editor.md)
handles keyboard movement, preferred columns and temporary measurement batches.

`snapshot().width` measures the text area. `gutterWidth` measures the fixed strip for line numbers and fold controls, in CSS pixels. The gutter omits folded lines and comparison padding rows.

Check `activity()` for the painted revision, selections, fold/alignment IDs, row generation, pending
frame and disposal. The immutable `ViewportActivity` is cached and reads no layout. Even with
`pending: false`, compare the painted state with the model and view. Call `flush()` to paint pending
work synchronously. `snapshot()` adds `ViewportSnapshot` dimensions, counts and
[timings](README.md#glossary).

Call `onRender(listener)` before the first frame to observe initial paint, and keep its unsubscribe
function. A paint or scheduled render can notify even when rows stay the same. An idle `flush()` is
silent. Removing a listener takes effect during delivery. New listeners start next time. The browser
reports exceptions and continues. Recheck captures if an earlier listener could have changed the view.
Disposal removes all listeners.

### Anchored popups

Append your popup to the document body and pass it to `mountAnchoredOverlay(editor, element)`.
Call `show({ revision, offset, affinity? })` with a position from that editor. The popup follows
the text through scrolling and resizing. It hides while its anchor is folded or offscreen and
reappears when that position is visible again. A new document revision expires the anchor.
If the popup contains a focused control, `onFocusedAnchorHidden` lets the host return focus
before an offscreen or folded anchor hides that control.

The popup opens below the line by default. Pass `{ prefer: "above" }` to prefer the other side.
If it cannot fit there, it uses the side with more room and limits its height. The host supplies
content and styling. Set a numeric `priority` when several popups share an editor. Each leaves
room for visible popups with a higher priority. The default is zero.

`hide()` releases the scroll and resize listeners. Call `dispose()` when
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
