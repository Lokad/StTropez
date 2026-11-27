# Built-in controls

Find, completion, hover, signature help, rename, quick fixes, locations and the color picker share the editor palette.

Pass `linkPolicy` to `attachEditorLanguage` to handle links in hover, signature help and document navigation.
The `link.open` and `color.edit` commands act on the item under the caret when its control is available.
Each control is optional. Set the palette on a common ancestor of the editor, comparison and Find bar.
The comparison fills a container with a definite height. For a floating Find bar, pass
`placement: "overlay"` to `mountFindBar` and position a common ancestor of its host and the editor
with `position: relative`. Opening Find then keeps the editor's height and scroll position.

## Use

```css
.workbench {
    --st-background: #f7f8fa;
    --st-foreground: #242831;
    --st-selection: #bdd9ff;
}
```

```ts
import { attachEditorLanguage, mountFindBar } from "sttropez/browser";
import type { TextEditor } from "sttropez/browser";
import type { LspWorkspace } from "sttropez/protocol";

export function addControls(toolbar: HTMLElement, editor: TextEditor, provider: LspWorkspace) {
    const find = mountFindBar(toolbar);
    find.attach(editor);
    const language = attachEditorLanguage(editor, provider, {
        completion: { list: true },
        hover: { popup: true },
        codeActions: { popup: true }
    });
    return () => {
        language.dispose();
        find.dispose();
    };
}
```

## Contract

Inside a call, signature help can stay open while you choose a completion. Opening another language
popup dismisses both. Pointer hover waits until the editor has no active popup. Escape dismisses
one popup at a time. The Find bar has its own lifetime.

A hover card offers Code actions at the inspected position, Edit color on a swatch and Open link when
the attachment supplies those controls and a link opener. `hover.popup.actions(point, state)` can
return host buttons with a `label` and a `run` callback. Stale buttons expire with the card.

`navigation.chooser.capture(kind, offset)` captures a destination callback or returns `undefined` to decline.
One result opens directly. For several, the chooser shows file, line and excerpt. Use arrows or Page Up/Down,
Enter to open and Escape to dismiss. `fileLabel` names host URIs. Results expire on focus or selection changes.

Pass the same `ControlStrings` table as `{ strings }` to `mountTextEditor`, `mountTextComparison`
and an external `mountFindBar`. Both review panes inherit it. Use `text(label)` for fixed captions.
Command menus read `commandLabel(id, fallback)` when queried, so the host can update its labels.
Use `reviewChanges(count)` for plural forms, `resultPage(first, last, total)` for page ranges and
`location(file, line, column)` for one-based positions. Find and completion formatters receive
their snapshots. Omitted formatters use English. Source excerpts and provider titles keep their text.

Borders, secondary text, fields and hovered rows derive from the surface and text colors. The selected
row uses the selection color. In forced colors, the current completion, quick fix and pressed Find
toggle use the system highlight and an outline.

| Control | Root and state selectors | Optional overrides |
| --- | --- | --- |
| All | Set on the surrounding host | `--st-background`, `--st-foreground`, `--st-selection`, `--st-font`, `--st-focus-ring` |
| Find | `.st-find-bar`, `.st-find-options [aria-pressed="true"]`, `.st-find-status` | `--st-find-background`, `--st-find-border` |
| Completion | `.st-completion`, `[role="option"][aria-selected="true"]` | `--st-completion-background`, `--st-completion-selected` |
| Locations | `.st-locations`, `[role="option"][aria-selected="true"]` | Completion colors |
| Hover | `.st-hover`, `.st-documentation` | `--st-hover-background` |
| Signature help | `.st-signature`, `mark` | `--st-signature-background`, `--st-signature-parameter-background`, `--st-signature-parameter-text` |
| Rename | `.st-rename`, `del`, `ins` | `--st-rename-removed`, `--st-rename-added` |
| Quick fixes | `.st-code-actions`, `[data-chosen="true"]` | `--st-actions-background`, `--st-actions-selected`, rename excerpt colors |
| Color picker | `.st-color-picker`, `del`, `ins` | `--st-actions-background`, rename excerpt colors |
| Find matches | `.st-search-match`, `.st-search-current` | `--st-search-match`, `--st-search-border`, `--st-search-current`, `--st-search-current-border` |
| Comparison | `.st-comparison`, `.st-comparison-removed`, `.st-comparison-added` | `--st-comparison-baseline-line`, `--st-comparison-working-line`, `--st-comparison-baseline-bar`, `--st-comparison-working-bar`, `--st-comparison-removed`, `--st-comparison-added`, `--st-padding-mark` |
| Gutter, folds and active line | `.st-viewport-gutter`, `.st-fold-summary` | `--st-gutter-foreground`, `--st-fold-summary`, `--st-fold-summary-background`, `--st-current-line`, `--st-current-line-border` |
| Viewport | Set on the surrounding host | `--st-font-size`, `--st-line-height`, `--st-column-ruler`, `--st-minimap-border`, `--st-minimap-marker` |
| Source annotations | Set on the surrounding host | `--st-bracket-background`, `--st-bracket-border`, `--st-snippet-field-border`, `--st-character-warning-background`, `--st-character-warning-border` |
| Language annotations | Set on the surrounding host | `--st-definition-link-color`, `--st-diagnostic-color`, `--st-diagnostic-warning-color`, `--st-diagnostic-information-color`, `--st-diagnostic-hint-color`, `--st-occurrence-text`, `--st-occurrence-read`, `--st-occurrence-border` |

## Host responsibilities

Choose a foreground that is legible on both the background and selection. Give a Find bar mounted
outside the editor the same theme. Set native `color-scheme` on the host for browser-owned UI such as
the select menu. Dispose controls when their host goes away. See [Find](search.md) and
[language features](language-features.md) for command and provider behavior.

## Not covered

See the [support matrix](README.md#support-matrix) for platform qualification.
