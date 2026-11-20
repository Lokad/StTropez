# Text viewport

`mountTextViewport` renders the visible part of a workspace document. It provides scrolling,
decorations and local text geometry. Use it for a read-only view.

## Use

Give the container a width and height, load the [packaged CSS](getting-started.md), then pass an
open text tab from the same workspace.

```ts
import type { TabId, Workspace } from "sttropez";
import { mountTextViewport } from "sttropez/browser";
import type { TextViewportOptions } from "sttropez/browser";

export function showPreview(host: HTMLElement, workspace: Workspace, tab: TabId) {
    const options: TextViewportOptions = {
        ariaLabel: "Source preview",
        columnRulers: [80, 120],
        minimap: true,
        highlightCurrentLine: true
    };
    const viewport = mountTextViewport(host, workspace, tab, options);
    viewport.revealOffset(0, { horizontal: "nearest", vertical: "nearest" });
    return viewport; // Call dispose() when the host detaches this projection.
}
```

`TextViewport` exposes its `element` and `view`. Pass a `DocumentView` to keep it across mounts. The
viewport disposes views it creates.

## Contract

### Mounting and presentation

Pass a text tab to `mountTextViewport` and set its `TextViewportOptions`. If you supply a view, use
one from the same workspace and document. Replacing the tab clears the old viewport. Mount a new
viewport for the replacement.

| Option | Default and validation |
| --- | --- |
| `ariaLabel` | Document title when omitted |
| `view` | A new independent document view when omitted |
| `decorate`, `lineClass` | No host decoration or row class when omitted |
| `columnRulers` | Empty; at most 128 positive safe integers, copied, sorted and deduplicated |
| `highlightCurrentLine` | `false`; boolean |
| `fontLigatures` | `false`; boolean |
| `minimap` | `false`; boolean |
| `scrollBeyondLastLine` | `false`; boolean |

Use `LineDecorator` to style part of a line. Its `PresentedLine` gives you the document, revision,
source line number, line start, and the range and text of the visible fragment. Return
`InlineDecoration` ranges with CSS classes and absolute UTF-16 offsets. Use `LineClass` to style the
whole row. Keep both callbacks bounded. If your colors change between edits, call `invalidate()` to
repaint.

Each presentation option has a getter and a live setter:

| Getter | Setter | Effect |
| --- | --- | --- |
| `columnRulers()` | `configureColumnRulers(columns)` | Guides at measured monospace cells from the left text origin |
| `currentLineHighlight()` | `configureCurrentLineHighlight(enabled)` | Background for the primary collapsed caret, including a folded header |
| `fontLigatures()` | `configureFontLigatures(enabled)` | Native common/contextual font ligatures; invalidates font and caret measurements |
| `minimap()` | `configureMinimap(enabled)` | A document overview with a draggable visible-region marker |
| `scrollBeyondLastLine()` | `configureScrollBeyondLastLine(enabled)` | Space to scroll the last visible row to the top text padding |

Call setters after workspace notifications finish. Each setter validates its argument before making
changes. Setting the same value schedules no work. After disposal, setters return `false`.

Rulers and line highlights add no text or scroll range. Only a collapsed primary caret gets a line
highlight. Each view has its own settings. Set `--st-column-ruler`, `--st-current-line` and
`--st-current-line-border` in CSS to choose colors. Host `font-feature-settings` can override
individual ligatures.

The minimap draws short files at their miniature height. For long files, it samples line prefixes
across the folded or aligned document to fit the track. `decorate` supplies foreground classes and
`lineClass` supplies row backgrounds, including in read-only views. Folded lines disappear and
alignment gaps stay blank. Call `invalidate()` when colors or decorations change. The previous image
stays visible until its replacement is complete.

Hover for a line number and text. Click outside the marker to center that location, or drag the
marker to scroll. Both preserve focus, horizontal position and all selections. The marker covers a
document that fits and keeps a minimum grab height on long files. Style its edge and fill with
`--st-minimap-border` and `--st-minimap-marker`.

### Scrolling and saved views

`scrollTo({ top, left })` takes logical CSS units. Omit an axis to keep its position. Negative values
clamp to zero and nonfinite values throw. Large logical extents fit bounded physical scrollbars. Use
`revealOffset(offset, RevealOptions)` to expand a hidden target and schedule scrolling. Each axis
accepts `"center"` (default) or `"nearest"`. Nearest keeps a visible caret in place. `affinity` takes
`"before"` or `"after"` (default). Ctrl/Meta-wheel passes through to browser zoom.

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

### Input adapter ownership

If you write your own input adapter, call `bindInput(focus)` once per viewport for a
`ViewportInputBinding`. The [editor](editor.md) already does this. The callback restores source focus
on Escape or when a focused fold control disappears. Binding removes the viewport root from the tab
order and hides its duplicate text from semantic navigation. `setComposing(boolean)` updates
composition styling and guards fold clicks. `setTabEscape(boolean)` controls tab stops on current and
future fold buttons. Changing DOM classes or attributes cannot claim the binding.

The setters return whether they changed the live binding. Call `dispose()` to restore tab stops and
clear composition styling. An expired binding’s setters return `false`, even after a new adapter
binds. Binding twice, or binding a destroyed or replaced viewport, throws. The viewport drops its
focus callback and render listeners on disposal. If the focus callback detaches the mount, rendering
stops there.

### Rendering limits

| Area | Contract or limit |
| --- | --- |
| Document reads | Visible rows plus four surrounding rows per edge; horizontal fragments add 32 UTF-16 units per edge, with short-row and surrogate-boundary adjustments; no whole-document text export |
| Short lines | Lines up to 512 UTF-16 units render with their complete shaping context |
| Long lines | Horizontal windows estimate position from UTF-16 units and measured monospace cell width |
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
