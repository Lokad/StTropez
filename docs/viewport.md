# Text viewport

`mountTextViewport` renders a read-only projection of a workspace text document. It owns
bounded DOM rows, scrolling, decorations and local text geometry. For text input, use the
[editor](editor.md); both mounts use the same viewport contract.

## Use

Load the packaged CSS and give the host element a bounded height and width, as described in
[Getting started](getting-started.md). Pass an open text tab from the same workspace:

```ts
import type { TabId, Workspace } from "sttropez";
import { mountTextViewport } from "sttropez/browser";
import type { TextViewportOptions } from "sttropez/browser";

export function showPreview(host: HTMLElement, workspace: Workspace, tab: TabId) {
    const options: TextViewportOptions = {
        ariaLabel: "Source preview",
        columnRulers: [80, 120],
        highlightCurrentLine: true
    };
    const viewport = mountTextViewport(host, workspace, tab, options);
    viewport.revealOffset(0, { horizontal: "nearest", vertical: "nearest" });
    return viewport; // Call dispose() when the host detaches this projection.
}
```

The returned `TextViewport` exposes its `element` and `view`. Supply `view` in the mount
options to reuse a host-owned `DocumentView` across DOM attachments. Destroying that mount
does not dispose the supplied view; a view created by the mount is disposed with it.

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
| `scrollBeyondLastLine()` | `configureScrollBeyondLastLine(enabled)` | Space to scroll the last visible row to the top text padding |

Setters validate before mutation, run outside workspace notification callbacks and return
`false` after disposal. Unchanged values schedule no work. Rulers and the current-line
background add no text or scroll extent. A noncollapsed primary selection hides the line
highlight; secondary carets do not add highlights. Each view has independent settings.
Use `--st-column-ruler`, `--st-current-line` and `--st-current-line-border` for their colors.
Host `font-feature-settings` can override individual ligature features.

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
Scrolling uses local CSS units. The [editor](editor.md) owns keyboard navigation, preferred
columns and temporary measurement batches. For explicit host navigation, update the captured
view's selection and use `revealOffset` to reveal it.

`activity()` returns a reused immutable `ViewportActivity` containing painted revision,
selection set, fold/alignment identities, row generation, pending-frame state and disposal.
It performs no layout measurement or flush. Compare painted identities with the current model
and view before treating a projection as settled; `pending: false` alone is insufficient.
`flush()` explicitly paints pending work for synchronous operations. `snapshot()` adds
`ViewportSnapshot` dimensions, work counts and component timings; use the [clock glossary](README.md#glossary)
when interpreting them.

`onRender(listener)` observes a completed paint or consumed scheduled render, including one
that leaves the painted rows unchanged. An idle synchronous `flush()` emits no notification.
Subscribe before the first frame to observe the initial paint. The returned function removes
that registration; destroying the viewport removes all registrations. Removing a listener
during delivery prevents its later call in that delivery; newly added listeners wait for a
later notification. Callbacks can schedule work or change model/view state, so later callbacks
must recheck captured identities. Exceptions are reported by the browser and do not prevent
other callbacks. A notification is not proof of complete interaction readiness or display.

### Input adapter ownership

The [editor](editor.md) owns input by default. A low-level adapter can call `bindInput(focus)`
once per viewport to obtain a `ViewportInputBinding`. The callback restores source focus when
a focused fold control disappears or receives Escape. The binding moves the viewport root
out of the tab order and hides its duplicate text projection from semantic navigation.
`setComposing(boolean)` controls composition presentation and guards fold clicks;
`setTabEscape(boolean)` controls existing and subsequently rendered fold tab stops.
These states belong to the binding; CSS classes and DOM attributes do not grant input authority.

Both setters validate booleans and return whether live state changed. `dispose()` releases the
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
sequences and bidirectional/contextual shaping can differ from the horizontal estimate.
Explicit reveal can retain a local caret placement without reading the entire line; manual
scrolling clears that placement. The API does not provide complete contextual long-line
geometry. Read-only projection does not supply an editable input surface.

## Host responsibilities

Own the surrounding layout, CSS, fonts, resource lifetime and decoration policy. Keep DOM
owned by the viewport separate from host controls. Reuse a supplied view when its selections
and folds should outlive a DOM mount; retain scroll captures separately. Call `dispose()` to
cancel frames, disconnect observers, release subscriptions/listeners and remove viewport DOM,
then release any host-owned view and resource when their lifetimes end.

## Not covered

See the [support matrix](README.md#support-matrix) for unsupported features and device checks.
