# Editor

Editors on the same document share text and Undo. Each view has its own carets, folds and scroll.

## Use

Load the stylesheet, size the container and supply a `DocumentView` to retain selections and folds.
[First editor](getting-started.md#open-the-first-editor)

```ts
import type { DocumentId, DocumentView, Workspace } from "sttropez";
import { mountTextEditor } from "sttropez/browser";
import type { ViewState } from "sttropez/browser";

export function attachSource(
    host: HTMLElement, workspace: Workspace, documentId: DocumentId,
    view: DocumentView, saved?: ViewState
) {
    const editor = mountTextEditor(host, workspace, documentId, {
        view, ariaLabel: "Source",
        settings: {
            language: { tabSize: 4, insertSpaces: true, lineComment: "//",
                blockComment: { open: "/*", close: "*/" }, enter: "keep" },
            bracketMatching: true, columnRulers: [80], highlightCurrentLine: true
        }
    });
    try {
        if (saved) editor.restoreView(saved, { selection: "current" });
        return editor;
    } catch (error) {
        editor.dispose();
        throw error;
    }
}
```

On detach, store `captureView()` by document and view. Dispose the view when its owner closes.

## Contract

### Mounting and presentation

Mount by document or tab ID. Omitting `view` gives the mount ownership. Closing or replacing the tab
expires pending input. `ariaLabel` defaults to the document title.

Set `readOnly: true` at mount for navigation, copy and Find. Remount to change it. Use `configure()`
and `settings()` for display and editing options.
[Viewport settings](viewport.md#viewport-settings) · [Character warnings](unicode.md#character-warnings)

`getSnapshot()` and `subscribe()` report focus, composition, disabled state and `readOnlyReason`.
`editor.focus()` resumes typing without scrolling. Disabled input cannot take focus.

### Reveal a destination

`reveal` takes zero-based `{ line, column }`, directed `{ start, end }` or ordered `{ from, to }`
UTF-16 coordinates. It clamps integers, opens folds and scrolls.

```ts
import type { TextEditor } from "sttropez/browser";

export function openProblem(editor: TextEditor, revision: number, line: number, first: number, last: number) {
    const start = { line, column: first }, end = { line, column: last };
    return editor.reveal({ start, end }, { expectedRevision: revision, select: true, focus: true });
}
```

Select and focus are opt-in, including in read-only panes. `align` accepts `"nearest"`,
`"center-if-outside"`, `"start"` or `"center"`. A busy, stale or closed view returns `null`.

### What happens when you type during a command

Typing during a long move lands at the new caret. A following paste has its own Undo step.
Escape, composition, selection changes or a closed view can interrupt the queue. Listen for
`inputConflictEvent` through disposal to recover unapplied text. Before saving or running the
current draft, check composition, pending input and pending commands in every pane that can
edit it. [Runnable checklist](getting-started.md#add-features-to-a-browser-ide)

### Selections and history

Typing replaces every selection. Native input mirrors the primary range. Shift extends from each anchor.
Vertical moves retain preferred columns across short lines.
[Selection sets](text-model.md#selection-sets)

Undo from either editable pane. Typing groups by word across pauses. One space joins the next word,
longer runs get their own step. Moving the caret, blur, commands, newline, paste, composition and
other edit origins break the group. One Undo removes a committed dead key. Undo/Redo reveal the caret.
[Shared history](workspace.md#transactions-and-history)

### Selecting lines in the gutter

Click a number to select the line, ending and folded body. Drag for whole lines, Shift+click to extend.
Each comparison pane numbers its own lines and leaves alignment gaps blank.

### Pointer dwell

`observePointerDwell(editor, listener, options)` reports offset, affinity, document and painted revision
after a mouse or pen rests (default 300 ms). Keys cancel dwell until the pointer moves.
`onMiss` clears hints.

### Shortcuts

`Mod` is Cmd on Apple and Ctrl elsewhere. The word modifier is Option on Apple and Ctrl elsewhere.
`editor.keymap.getShortcuts(id)` includes host bindings. For defaults, use the platform table.

```ts
import { defaultEditorShortcuts, type TextEditorCommand } from "sttropez/browser";

export function defaultKeys(command: TextEditorCommand, platform: keyof typeof defaultEditorShortcuts) {
    return defaultEditorShortcuts[platform].filter(([, id]) => id === command).map(([keys]) => keys);
}
```

| Navigation and selection | Action |
| --- | --- |
| Left / Right | Move by grapheme. Add the word modifier for words, Shift to extend. |
| Up / Down, PageUp / PageDown | Move a visible row or page at the retained column. |
| Home / End | First nonblank or line end. Press Home again for line start. |
| Mod+Home / End | Document start / end. On Apple, Cmd+Left / Right reaches line ends and Cmd+Up / Down reaches document ends. |
| Mod+A / Mod+L | Select all / touched lines with endings. Repeat Mod+L to extend. |
| Mod+D / Mod+Shift+L | Select the next / all occurrences of the selection or current word. |
| Mod+Alt+Up / Down | Copy carets or selections to the adjacent visible row. |
| Mod+U | Undo this view’s last selection change. An edit resets selection history. |
| Mod+G / Mod+Shift+Backslash | Go to line / jump to bracket. |
| Ctrl+Up / Down, Alt+PageUp / PageDown | Scroll a row or page while keeping the selection. |

| Editing | Action |
| --- | --- |
| Backspace / Delete | Delete the selection or adjacent grapheme. The word modifier deletes a run. Backspace in indentation uses tab stops. |
| Mod+Z / Mod+Shift+Z or Ctrl+Y | Undo / Redo. |
| Tab / Shift+Tab | Indent / outdent. In read-only views, move focus. |
| Enter or Shift+Enter | Insert a contextual newline. |
| Mod+/ or Shift+Alt+A | Toggle line or block comment. Mod+K then Mod+C adds a line marker, Mod+K then Mod+U removes one. |
| Mod+] / Mod+[ | Indent / outdent touched lines. |
| Alt+Up / Down | Move lines. Add Shift to copy them and select the copies. |
| Mod+Shift+K | Delete lines and keep the column on the surviving line, up to its end. |
| Mod+Enter / Mod+Shift+Enter | Insert a line below / above with its indentation. |
| Escape then Tab / Shift+Tab | Leave the editor forward / backward. With multiple ranges, the first Escape keeps the primary range. |

Go to line passes `requestLine` one-based `currentLine`, `lineCount` and an abort signal.
Return a line or `undefined`, directly or in a promise. Selection, revision or mount changes expire it. On French AZERTY, `Ctrl+:` toggles line comments and `Ctrl+;` opens fixes.
[Keyboard support](README.md#support-matrix)

Shift+click extends the primary selection. Alt+click toggles a caret and Alt+drag adds a range.
Double-click selects a word, triple-click a line, four clicks the document. Shift+Alt+click
selects a column from the caret. Shift+Alt+drag or middle-drag starts at the press. Visible
rows reaching the nearer edge participate. If all fall short, each gets an end-of-line caret.

### Clipboard and text drag

Copy joins selections in order with LF. Carets alone copy distinct whole lines, including folded bodies
and endings. Cut takes one Undo. Paste editor-marked lines at a caret to insert above and keep its column.

Matching line and selection counts distribute one line per range. Otherwise each gets the full text.
Endings follow the destination unless `pasteLineEndings` is `"preserve"`. Read custom formats during
[the paste event](host-integration.md#captured-insertion-and-structured-paste).

A drag between writable documents in the same workspace moves the text in one Undo. Ctrl
(Option on Apple), a read-only source or another workspace copies. Moves require the original
token, views and revisions. A drop selects the inserted text.

### Language configuration

`configure({ language })` replaces one view's rules and cancels pending commands. It returns
`false` during composition or after disposal. Read resolved rules from `editor.settings().language`.

| Setting | Behavior |
| --- | --- |
| `tabSize`, `insertSpaces` | Width 1–256. Defaults to four spaces. Tab uses the next stop. Multiline indentation skips blank rows and includes folded text. |
| `lineComment`, `blockComment` | Supply a single-line marker or `{ open, close }`. Toggle removes one marker if every nonblank line has one, otherwise it inserts at common indentation. |
| `pairs`, `allowPair` | Default pairs are parentheses, brackets and braces. Supply distinct single-unit openings, or `[]` to disable. `allowPair` can exclude strings and comments. |
| `enter` | Omit for a plain newline, use `"keep"` to copy indentation or supply a rule to add, remove or split indentation. The ending follows the local line, then the preceding line at EOF, then LF. |

An opener surrounds a selection or inserts its closer. Typing the tracked closer steps over it
once. Backspace between untouched delimiters removes both. Composition inserts literal text.

### Running and binding commands

Bind menu items to their pane and argument. `commands.run` rechecks availability.

```ts
import type { TextEditor } from "sttropez/browser";

export function undoMenuItem(editor: TextEditor) {
    const undo = editor.commands.get("undo");
    if (!undo) return;
    return { label: undo.label, enabled: undo.enabled, run: () => editor.commands.run(undo.id) };
}
```

`commands.register(command, { keys, priority })` installs both until disposal.
Translate with `strings.commandLabel(id, fallback)`. Bind chords with `keymap.bind("Mod+k Mod+i", id)`.
`keymap.unbind(keys)` clears those keys.

- Logical keys win over physical keys such as `Code:BracketLeft`. `Space` and `Plus` are literals.
- Host priority defaults to 0, above built-ins. Highest wins, newest wins ties. Disabled or declined
  commands (`false`) fall through.
- Duplicate IDs and single-key/chord-prefix conflicts throw. Both strokes need the same control,
  selection and revision within 1.5 seconds.
- Use `repeat: false` for one activation per press. To share a shortcut with a toolbar, set
  `shared: true` and forward its event to that pane's `keymap.handle`.
  [Host commands](host-integration.md#navigation-commands-and-lifecycle)

`planLanguageEdit` plans against captured text, selections and folds. The editor commits inside the key handler.
The result contains the edits and final selections. Invalid input or a failing host rule throws.

```ts
import { planLanguageEdit, resolveLanguageConfiguration } from "sttropez";
import type { SelectionSet, TextBuffer } from "sttropez";

export function planIndent(buffer: TextBuffer, selections: SelectionSet) {
    return planLanguageEdit(buffer, selections, "indent", resolveLanguageConfiguration({ tabSize: 2 }));
}
```

Before applying the plan check the target, revision, selections and permissions. Preserve its
`lineMove` information. [Transactions](workspace.md#transactions-and-history)

### Edit transforms

`registerEditTransform` installs one synchronous transform and returns its removal function.
Return `undefined` to keep the proposed edit or replace it in original coordinates. An occupied
slot throws. `complete(applied)` runs after the commit attempt and notifications. Undo, Redo,
external writes and drops bypass the transform. [Snippet mirroring](language-features.md#completion)

### Bracket matching

`jump-to-bracket` checks at the caret, then just before it. Inside a pair it seeks the enclosing
closer, otherwise the next eligible bracket. A mismatch or exhausted budget leaves the caret in
place. `bracketMatching: true` paints the match. Read `editor.bracketMatching.getSnapshot()` for
the primary caret and call `refresh()` when lexical rules change.

### View state, activity and limits

`restoreView(saved, { selection: "current" })` restores scroll on remount and keeps the live
selection. `activity()` reports pending work without layout. For visible readiness check that the
new text, colors and carets are painted. `getDiagnostics()` times input handlers. A cancelled
`beforeinput` can suppress `input`, so check its event count before using `lastInputMs`.
[View restoration](viewport.md#scrolling-and-saved-views) · [Interaction clocks](README.md#measuring-an-interaction)

| Operation | Bound |
| --- | --- |
| Settled input window | 256 UTF-16 units per side and 2,048 selected units. Composition and noncancellable input can exceed it until commit. |
| Ordered input | 256 actions and 65,536 units. Overflow reports unapplied text. |
| Language planner | Default budget 4,096 work units, minimum 256. |
| Bracket scan | Defaults to 100,000 work units and 1,024 nesting levels. Both limits take positive safe integers. |

## Host responsibilities

Bind commands to their pane. Submit revision-checked edits after notifications. Dispose the editor
on detach. [React mounting](getting-started.md#mount-an-editor-in-react)

## Not covered

[Dead keys, AltGr, clipboard and touch](README.md#support-matrix)
