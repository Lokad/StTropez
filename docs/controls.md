# Built-in controls

Find, completion, hover, signature help, rename, quick fixes, locations and the color picker share the editor palette.
Each control is optional. Set the palette on an ancestor of both the editor and its Find bar.

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

Each editor shows one language popup. A keyboard or menu command replaces the active popup.
While typing, signature help takes precedence over automatic completion. Pointer hover waits until
the editor has no active popup. Escape dismisses the current popup. The Find bar has its own lifetime.

A hover card offers Code actions at the inspected position, Edit color on a swatch and Open link when
the attachment supplies those controls and a link opener. `hover.popup.actions(point, state)` can
return host buttons with a `label` and a `run` callback. Stale buttons expire with the card.

`navigation.chooser.capture(kind, offset)` captures a destination callback or returns `undefined` to decline.
One result opens directly. For several, the chooser shows file, line and excerpt. Use arrows or Page Up/Down,
Enter to open and Escape to dismiss. `fileLabel` names host URIs. Results expire on focus or selection changes.

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

## Host responsibilities

Choose a foreground that is legible on both the background and selection. Give a Find bar mounted
outside the editor the same theme. Set native `color-scheme` on the host for browser-owned UI such as
the select menu. Dispose controls when their host goes away. See [Find](search.md) and
[language features](language-features.md) for command and provider behavior.

## Not covered

See the [support matrix](README.md#support-matrix) for platform qualification.
