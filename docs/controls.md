# Built-in controls

Find, completion, hover, signature help, rename, quick fixes and the color picker share the editor palette.
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

Borders, secondary text, fields and hovered rows derive from the surface and text colors. The selected
row uses the selection color. In forced colors, the current completion, quick fix and pressed Find
toggle use the system highlight and an outline.

| Control | Root and state selectors | Optional overrides |
| --- | --- | --- |
| All | Set on the surrounding host | `--st-background`, `--st-foreground`, `--st-selection`, `--st-font`, `--st-focus-ring` |
| Find | `.st-find-bar`, `.st-find-options [aria-pressed="true"]`, `.st-find-status` | `--st-find-background`, `--st-find-border` |
| Completion | `.st-completion`, `[role="option"][aria-selected="true"]` | `--st-completion-background`, `--st-completion-selected` |
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
