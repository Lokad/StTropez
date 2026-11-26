# Text viewport

`mountTextViewport` renders visible rows and exposes their text geometry. For keyboard selection and copying across virtualized rows, use a [read-only editor](editor.md#use).

## Use

Give the container a width and height and load the [editor stylesheet](getting-started.md#open-the-first-editor).

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

Mount by document ID for an independent preview, or by tab ID to clear the viewport when that tab is replaced. The document title supplies the default `ariaLabel`. To keep selections and folds across mounts, pass a `view` from the same workspace and document. The viewport disposes views it creates.

### Theme the editor

Set CSS properties on the host element. A comparison host passes them to both panes.

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

Call `invalidate()` after a font or theme change to refresh text measurements and the minimap.

### Decoration layers

Add a layer to `editor.decorations` or `viewport.decorations`. Use absolute UTF-16 offsets from the revision you inspected.

```ts
import type { TextEditor } from "sttropez/browser";

export function markColor(editor: TextEditor, revision: number, from: number, to: number) {
    const layer = editor.decorations.add({ order: 32 });
    layer.set(revision, [{ from, to, className: "color-literal", before: "color-swatch",
        properties: { "--swatch-color": "#7494ad" }, afterLine: "Accent color" }]);
    return layer;
}
```

Style `.color-swatch` with a size and `background: var(--swatch-color)`. A point marks a caret stop. `afterLine` places plain text at the line end. Markers and labels add no copied text. Inline classes accept space-separated tokens of up to 64 characters each, 256 in total.

`set(revision, ranges)` copies its input, rejects a stale revision or retired view with `false`, and throws for out-of-bounds offsets. Edits map surviving marks. Deleting across a point removes it and its label. A boundary point survives. Republish removed marks after Undo. `clear()` empties the layer and `dispose()` retires it.

Use `addProvider({ order, provide, lineClass })` for syntax. `provide(line)` receives a mounted fragment with absolute offsets. `lineClass` styles the row. Invalidate a zero-based, half-open line interval with `invalidate(fromLine, toLine)`, or omit both bounds for a new token stream.

| Paint order | Layers |
| --- | --- |
| 10 / 20 / 25 | Comparison / occurrences / snippet fields |
| 30 / 35 / 40 | Document links / color swatches / diagnostics |
| 60 / 100 / 110 | Find / matching brackets / character warnings and definition links |

A later layer can override an earlier custom property. Ties follow registration order. CSS decides class precedence.

### Viewport settings

Read per-view settings with `settings()`. Apply changes together with `configure({ columnRulers: [80], minimap: true })`. Invalid input preserves prior settings.

| Setting | Default | Effect |
| --- | --- | --- |
| `columnRulers` | `[]` | Guides at up to 128 positive, safe-integer monospace columns. |
| `gutter` | `true` | Shows line numbers and fold buttons. Hiding it preserves folds. |
| `foldLabels` | `{}` | Translates [fold actions and summaries](folding.md#use). |
| `highlightCurrentLine` | `false` | Marks selection heads in the gutter and the collapsed primary caret’s row. |
| `fontLigatures` | `false` | Enables common and contextual ligatures. |
| `scrollBeyondLastLine` | `false` | Lets the last row scroll to the top. |
| `minimap` | `false` | Shows miniature text and the visible region. |
| `minimapLabel` | Built-in label | Formats a one-based line number or `null` for a comparison gap. |

Click outside the minimap marker to center a line, drag it to scroll, or hover to preview the source. These gestures preserve focus, horizontal position and selections. Long files use sampled line prefixes, folded lines disappear and alignment gaps stay blank. The previous image stays visible during redraw. Set `minimap: false` on a decoration layer to omit it.

Use `--st-minimap-marker` and `--st-minimap-border` for the marker, `--st-column-ruler` for rulers, and `--st-current-line` and `--st-current-line-border` for the active line.

### Scrolling and saved views

Pass logical CSS pixels to `scrollTo({ top, left })`. Omit an axis to keep its position. Scrollbar gestures preserve focus. Typing brings the edited caret back into view.

`revealOffset(offset, options)` opens enclosing folds. Both axes default to `"center"`. Use `"nearest"` for minimal movement or vertical `"center-if-outside"` to center a clipped row. Affinity defaults to `"after"`.

`revealRange(from, to, align?)` opens folds across a half-open range and keeps the selection. Its default `"center-if-outside"` preserves visible rows and exposes the start of an oversized range. Multiline ranges use the starting column. Other vertical choices are `"start"`, `"center"` and `"nearest"`.

Store `captureView()` per document and view. `restoreView(state)` cancels pending reveal and restores scroll and selection together. It returns `null` for a closed mount or another document. The result reports how it restored the selection.

| Result | How the view placed the endpoints |
| --- | --- |
| `"captured"` | Reused the saved ranges and primary caret. |
| `"current"` | Kept a retained view’s selections after an edit, or honored `{ selection: "current" }`. |
| `"mapped"` | Applied the last edit to a fresh view’s saved endpoints. |
| `"clamped"` | Brought an older capture’s out-of-bounds endpoints into the document. |

`horizontalAnchorRestored` and `verticalAnchorRestored` report which text anchors survived. Missing anchors fall back to the saved scroll position. `foldsRestored` records whether a fresh view took folds from the same revision. [Folding](folding.md) · [Aligned review panes](comparison.md#linked-scrolling-and-aligned-rows)

### Geometry and readiness

Use `coordsAt(offset, affinity?)`, `rowBounds(line)` and `hitTest(clientX, clientY)` for client coordinates including CSS zoom. Check the returned revision and handle `undefined` for unmounted text. Affinity chooses a grapheme edge. The minimap lies outside the text hit area.

| Question | What to read |
| --- | --- |
| Which rows are on screen? | `getSnapshot()` gives painted geometry in local CSS pixels. `[lineFrom, lineTo)` includes partial rows and excludes overscan. It is empty before paint, over padding alone and after disposal. |
| Has the viewport painted this revision? | Compare `activity().revision` with the model and the painted selections, folds and alignment with the view. An idle frame alone cannot establish this. To locate the edit on screen, also check its row and text geometry. |
| When should a popup move? | `subscribe()` reports geometry changes. `onRender()` also sees paints with unchanged geometry. Register before the first frame for initial paint. Both return an unsubscribe function. |
| What did rendering cost? | `getDiagnostics()` reports mounted rows, buffer reads and render duration. [Interaction clocks](README.md#measuring-an-interaction) |

`flush()` paints pending work synchronously. An idle flush sends no render notification.

### Anchored popups

Pass a detached element to `mountAnchoredOverlay(editor, element)` to inherit editor styles in the browser top layer. A popup mounted in a host container stays there. Call `show({ revision, offset })` for a caret (optional `affinity`) or `show({ revision, from, to })` for a half-open range. A range anchors at its first visible row, even with both endpoints offscreen.

Scrolling, folding and resizing update placement. A clipped popup can reappear. A new revision expires the anchor. The popup prefers space below the row. Choose `prefer: "above"` to reverse this. Higher `priority` gets first choice of space. Content scrolls when space is tight.

Use `dismissOn` with `"focus-leave"` or `"outside-pointerdown"` to dismiss outside both popup and editor. `onHide(reason, hadFocus)` distinguishes clipping from expiration or dismissal. Disposing the overlay removes a supplied detached element. Disposing the editor releases its overlays.

### Input adapter ownership

The editor binds its own input adapter. On a standalone viewport, `bindInput(focus)` redirects focus from the gutter back to the input and takes the root out of the tab order. Call `setComposing(active)` to guard fold clicks during composition. Dispose the binding before attaching another one.

### Rendering limits

The viewport renders visible rows plus four rows per edge. Lines up to 512 UTF-16 units keep their full shaping context. Longer rows render horizontal fragments with 32 extra units per edge and surrogate-boundary adjustments. Tabs, combining marks and contextual shaping can shift the estimated horizontal position. A reveal can pin the caret until manual scrolling.

LF starts a row, CR before LF is hidden, and lone CR displays as a control symbol. Text sets the horizontal extent. Updates share animation frames and reuse unchanged rows.

## Host responsibilities

Supply layout, fonts and CSS. Keep host controls outside the viewport subtree. Store scroll captures separately for each view. Dispose the mount on detach and release any view or resource you retained.

## Not covered

Rows use left-to-right geometry without word wrapping. [Layout and device support](README.md#support-matrix)
