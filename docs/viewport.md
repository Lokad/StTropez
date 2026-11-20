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

`mountTextViewport` accepts `TextViewportOptions` and requires a tab identifying a text surface.
A supplied view must belong to that document and
workspace. The mount captures the tab generation; replacing the tab clears its projection
instead of redirecting it to the replacement document.

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

`LineDecorator` receives a `PresentedLine`: captured document/revision, source line number,
line start, rendered range and its text. Return `InlineDecoration` ranges in absolute
UTF-16 offsets with CSS class names. `LineClass` supplies a row class. The callbacks receive
only the rendered fragment; keep their work bounded and call `invalidate()` when host
presentation changes without a document edit. Decorations do not alter source text or offsets.

Each presentation option has a getter and a live setter:

| Getter | Setter | Effect |
| --- | --- | --- |
| `columnRulers()` | `configureColumnRulers(columns)` | Guides at measured monospace cells from the left text origin |
| `currentLineHighlight()` | `configureCurrentLineHighlight(enabled)` | Background for the primary collapsed caret, including a folded header |
| `fontLigatures()` | `configureFontLigatures(enabled)` | Native common/contextual font ligatures; invalidates font and caret measurements |
| `minimap()` | `configureMinimap(enabled)` | A document overview with a draggable visible-region marker |
| `scrollBeyondLastLine()` | `configureScrollBeyondLastLine(enabled)` | Space to scroll the last visible row to the top text padding |

Setters validate before mutation, run outside workspace notification callbacks and return
`false` after disposal. Unchanged values schedule no work. Rulers and the current-line
background add no text or scroll extent. A noncollapsed primary selection hides the line
highlight; secondary carets do not add highlights. Each view has independent settings.
Use `--st-column-ruler`, `--st-current-line` and `--st-current-line-border` for their colors.
Host `font-feature-settings` can override individual ligature features.

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

`scrollTo({ top, left })` uses logical CSS-unit scroll coordinates. Omitted axes keep their
position; nonfinite values throw and negative values clamp to zero. Large document extents
map onto bounded physical scrollbars. `revealOffset(offset, RevealOptions)` expands a hidden
fold target and schedules a reveal. Each axis accepts `"center"` (the default) or `"nearest"`;
`affinity` is `"before"` or `"after"` (the default). Nearest reveal preserves a visible caret.
Ctrl/Meta wheel events pass through to browser zoom handling.

`captureView()` returns immutable selection, scrolling and folding state. `restoreView()`
validates scroll/anchor fields before changing the view. Same-revision vertical and horizontal
anchors preserve the local source placement. Fold metadata can initialize a new empty view
of the same document/revision; it does not overwrite a view's newer fold state. Store captures
by document/view identity. [Folding](folding.md) describes projection and selection behavior;
[comparison](comparison.md) owns aligned panes and linked scrolling.

### Geometry and readiness

`coordsAt(offset, affinity?)` and `hitTest(clientX, clientY)` return captured caret geometry;
`rowBounds(line)` returns `RenderedRowBounds`. These APIs use client coordinates, including
inherited CSS zoom. Returned positions carry their document revision. Unmounted ranges and
stale projections can return `undefined`; `coordsAt` snaps a grapheme interior by affinity.
The minimap is outside the text hit area. The viewport snapshot reports the width available
for text. Scrolling uses local CSS units. The [editor](editor.md) owns keyboard navigation, preferred
columns and temporary measurement batches. For explicit host navigation, update the captured
view's selection and use `revealOffset` to reveal it.

`activity()` returns a cached immutable `ViewportActivity` without measuring or flushing layout. It
reports the painted revision, selections, fold/alignment IDs, row generation, pending frame and
disposal. To check readiness, compare painted state with the model and view, even when `pending` is
false. `flush()` paints pending work synchronously. `snapshot()` adds `ViewportSnapshot` dimensions,
work counts and [timings](README.md#glossary).

`onRender(listener)` runs after a paint or scheduled render, even when rows stay the same. An idle
`flush()` is silent. Subscribe before the first frame to observe initial paint. The returned
function unsubscribes. Removal takes effect during delivery, additions on the next notification. The
browser reports exceptions and continues delivery. A listener can change view state, so later
listeners must recheck their captures. Disposal removes all listeners.

### Input adapter ownership

The [editor](editor.md) owns input by default. A low-level adapter can call `bindInput(focus)`
once per viewport to obtain a `ViewportInputBinding`. The callback restores source focus when
a focused fold control disappears or receives Escape. The binding moves the viewport root
out of the tab order and hides its duplicate text projection from semantic navigation.
`setComposing(boolean)` controls composition presentation and guards fold clicks;
`setTabEscape(boolean)` controls existing and subsequently rendered fold tab stops.
These states belong to the binding; CSS classes and DOM attributes do not grant input authority.

Both setters return whether live state changed. `dispose()` releases the
binding, restores viewport/fold tab stops and clears composition presentation. A stale binding
cannot alter a replacement binding. Binding an already bound, destroyed or replaced viewport
throws; setters on expired bindings return `false`. Focus callbacks and render subscriptions
end with the viewport and never redirect to a replacement tab. A focus callback can detach the
viewport; rendering stops when that callback invalidates the mount.

### Rendering limits

| Area | Contract or limit |
| --- | --- |
| Document reads | Visible rows plus four surrounding rows per edge; horizontal fragments add 32 UTF-16 units per edge, with short-row and surrogate-boundary adjustments; no whole-document text export |
| Short lines | Lines up to 512 UTF-16 units render with their complete shaping context |
| Long lines | Horizontal windows estimate position from UTF-16 units and measured monospace cell width |
| Line endings | LF creates a row; CR before LF is omitted from display; lone CR is displayed as a control symbol |
| Geometry | Native text ranges measure mounted fragments; geometry outside those fragments is unavailable |
| Updates | Relevant changes coalesce into animation frames; unchanged row text/classes retain their nodes |

Measured horizontal extent uses the rendered row contents rather than the full-row decoration
box. Full-width line backgrounds do not add horizontal scroll range when the text fits.

A long fragment's local measurement is not a measured global glyph origin. Tabs, combining
sequences and contextual shaping can differ from the horizontal estimate.
Explicit reveal can retain a local caret placement without reading the entire line; manual
scrolling clears that placement. The API does not provide complete contextual long-line
geometry. Read-only projection does not supply an editable input surface.

## Host responsibilities

Supply layout, CSS, fonts and decorations. Put host controls outside the viewport DOM. Keep the view
to preserve selections and folds across mounts, and save scroll state separately. Call `dispose()`
to cancel frames, disconnect observers and remove the viewport. Release host-owned views and
resources when you finish with them.

## Not covered

See the [support matrix](README.md#support-matrix) for unsupported features and device checks.
