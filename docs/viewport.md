# Text viewport

The editor viewport draws visible rows and exposes their geometry. A [read-only editor](editor.md#use)
supports keyboard selection and copying across virtualized rows.

## Use

Size the container and load the [editor stylesheet](getting-started.md#open-the-first-editor).

```ts
import type { DocumentId, Workspace } from "sttropez";
import { mountTextEditor } from "sttropez/browser";

export function showPreview(host: HTMLElement, workspace: Workspace, documentId: DocumentId) {
    const editor = mountTextEditor(host, workspace, documentId, {
        readOnly: true,
        ariaLabel: "Source preview",
        settings: { columnRulers: [80, 120], minimap: true, highlightCurrentLine: true }
    });
    editor.viewport.revealOffset(0, { horizontal: "nearest", vertical: "nearest" });
    return editor; // Dispose the editor when the preview closes.
}
```

## Contract

### Mounting and presentation

Mount by document ID and dispose the viewport when its pane closes. `ariaLabel` defaults to the
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

Changing a class, inline style or `data-theme` on the editor or an ancestor refreshes its measurements
and minimap. Call `invalidate()` when editing stylesheet rules directly.

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
a label. Set `afterLineColumn` to align labels at a zero-based column, leaving room for longer source lines.
`afterLineTitle` supplies a native tooltip. Clipboard text contains only the source. Inline classes accept tokens up to 64
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

### Color lines with a stateful lexer

For a lexer whose state carries across lines, call `attachLineTokenizer` once per pane. Return an
immutable end state and decorations in document offsets. The helper retains rows before an edit and reads
toward a distant viewport or minimap in small tasks. Each call to the host lexer runs synchronously.
The editor disposes the attachment on unmount.

```ts
import { attachLineTokenizer, type TextEditor } from "sttropez/browser";

export function colorFencedBlocks(editor: TextEditor) {
    return attachLineTokenizer(editor, {
        initialState: () => false,
        tokenize(line, inside) {
            const fence = line.text.startsWith("~~~");
            return { endState: fence ? !inside : inside, decorations: inside || fence
                ? [{ from: line.from, to: line.to, className: "host-code-block" }] : [] };
        },
    });
}
```

### Keep an annotation on its text

Map an annotation through each document change. This example hides it if its text is deleted or a reload
replaces the revision it refers to. A host that keeps deleted notes can restore them on Undo.

```ts
import { anchoredRange, type AnchoredRange, type DocumentId, type Workspace } from "sttropez";

export function trackNote(workspace: Workspace, documentId: DocumentId, from: number, to: number) {
    const document = workspace.document(documentId);
    const observed = workspace.observeDocument(documentId);
    let revision = document.revision;
    let range: AnchoredRange | undefined = anchoredRange(document.buffer.length, from, to, { onDelete: "invalidate" });
    const stop = workspace.onDocumentChange(documentId, change => {
        range = range && change.previousRevision === revision ? change.mapping.mapRange(range) : undefined;
        revision = change.revision;
    });
    return { getSnapshot: () => observed.getSnapshot()?.revision === revision ? range : undefined, dispose: stop };
}
```

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
Host elements stay put. Pass a caret or half-open range to `show(anchor, focusTarget?)`.
Placement focuses the target. Clipping, dismissal and another call cancel pending focus.

Overlays follow scrolling, folds and resizing. Clipped anchors can reappear within the same revision.
Placement prefers below. Set `prefer: "above"` to reverse it. Higher `priority` wins space.
With `transient: true`, opening a language or host popup dismisses the previous one with reason `"superseded"`.

`dismissOn` accepts `"focus-leave"` and `"outside-pointerdown"`. `onHide(reason, hadFocus)` reports
dismissal, expiry and clipping. Editor disposal releases overlays and removes detached elements.

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
