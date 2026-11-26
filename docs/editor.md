# Editor

Editors on the same document share text and Undo. Each view has its own carets, folds and scroll.

## Use

Load the stylesheet and give the container a height. Supply a `DocumentView` to keep the selection
and folds across mounts. [First editor](getting-started.md#open-the-first-editor)

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

Save `captureView()` on detach and key it by document and view. Dispose the retained view when
its owner closes.

## Contract

### Mounting and presentation

`mountTextEditor` accepts a document or tab ID. If you omit `view`, the mount owns the view.
Closing or replacing a tab expires pending input. `ariaLabel` defaults to the document title.

Set `readOnly: true` at mount for navigation, copy and Find. Remount the same view to change it.
Update display and editing settings with `configure()` and read them with `settings()`.
[Viewport settings](viewport.md#viewport-settings) · [Character warnings](unicode.md#character-warnings)

`getSnapshot()` and `subscribe()` report focus, composition, disabled state and `readOnlyReason`.
Call `editor.focus()` to resume typing without scrolling the page. A disabled input cannot take focus.

### Reveal a destination

`reveal` accepts a zero-based `{ line, column }`, a directed `{ start, end }` or an ordered UTF-16
range `{ from, to }`. It clamps integer coordinates, opens folds and scrolls to the destination.

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

Type during a long caret move and the text lands at the new caret. A following paste gets its
own Undo step. Escape, composition, a changed selection or an expired view can interrupt the queue.
Keep an `inputConflictEvent` listener on the original editor through disposal to recover unapplied
text. Before Save or Run, check pending input on that pane. [Input recovery](host-integration.md#input-conflict-recovery)

### Selections and history

Typing replaces every selected range. The native input mirrors the primary range. Shift extends
each selection from its anchor. Vertical moves keep each range's preferred column across short lines.
[Selection sets](text-model.md#selection-sets)

Undo works from either editable pane. Typing groups by word across pauses. One space joins the
following word. A longer space run gets its own step. Caret movement, blur, a command, newline,
paste, composition or an edit from another origin breaks the group. A committed dead key takes
one Undo. Undo and Redo reveal an off-screen caret. [Shared history](workspace.md#transactions-and-history)

### Selecting lines in the gutter

Click a number to select the line, its ending and any folded body. Drag for whole lines or
Shift+click to extend. In Changes, each pane shows its own line numbers. Alignment gaps are blank.

### Pointer dwell

`observePointerDwell(editor, listener, options)` reports the painted offset, affinity, document
and revision after a mouse or pen rests for 300 ms by default. Use `onMiss` to clear a hint,
`cancel()` to forget a visit and `dispose()` to stop observing.

### Shortcuts

`Mod` is Cmd on Apple and Ctrl elsewhere. The word modifier is Option on Apple and Ctrl
elsewhere. Query `editor.keymap.getShortcuts(id)` for the current pane, including host bindings.
To display the defaults, use the platform's shortcut table.

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

Go to line calls `requestLine` with one-based `currentLine`, `lineCount` and an abort signal.
Return a line or `undefined`, synchronously or in a promise. A changed selection, revision or
mount expires the prompt. On French AZERTY, `Ctrl+:` toggles line comments and `Ctrl+;` opens fixes.
[Keyboard support](README.md#support-matrix)

Shift+click extends the primary selection. Alt+click toggles a caret and Alt+drag adds a range.
Double-click selects a word, triple-click a line, four clicks the document. Shift+Alt+click
selects a column from the caret. Shift+Alt+drag or middle-drag starts at the press. Visible
rows reaching the nearer edge participate. If all fall short, each gets an end-of-line caret.

### Clipboard and text drag

Copy joins selections in source order with LF. With carets only, it copies distinct whole lines,
including folded bodies and line endings. Cut removes them in one Undo. Pasting editor-marked
lines at a caret inserts them above and keeps the column.

When line and selection counts match, paste distributes one line per selection. Otherwise each
range gets the full text. Endings follow the destination unless `pasteLineEndings` is `"preserve"`.
Read custom clipboard formats during dispatch. [Structured paste](host-integration.md#captured-insertion-and-structured-paste)

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

Build a menu item for a specific pane. Use the same pane and argument when invoking it.
`commands.run` rechecks availability when clicked.

```ts
import type { TextEditor } from "sttropez/browser";

export function undoMenuItem(editor: TextEditor) {
    const undo = editor.commands.get("undo");
    if (!undo) return;
    return { label: undo.label, enabled: undo.enabled, run: () => editor.commands.run(undo.id) };
}
```

`commands.register(command, { keys, priority })` returns a registration whose `dispose()` removes
the command and its bindings. Translate editor commands with `settings.commandLabel(id, fallback)`.
`keymap.bind("Mod+k Mod+i", id)` adds a chord. `keymap.unbind(keys)` clears that sequence.

- Bind a logical key or a physical `Code:BracketLeft`. A matching logical key wins. `Space` and
  `Plus` name literal keys. Higher priorities run first. Returning `false` tries the next choice.
- Duplicate IDs, tied priorities or a single key used as a chord prefix throw. Both chord strokes
  must reach the same control within 1.5 seconds and with the same selection and revision.
- Use `repeat: false` for one activation per press. To share a shortcut with a toolbar, set
  `shared: true` and forward its event to that pane's `keymap.handle`.
  [Host commands](host-integration.md#navigation-commands-and-lifecycle)

For a headless edit, give `planLanguageEdit` the captured buffer, selections and rules. Pass
a fold index to treat folded blocks as lines. Yield between advances and dispose on cancellation.

```ts
import { planLanguageEdit, resolveLanguageConfiguration } from "sttropez";
import type { SelectionSet, TextBuffer } from "sttropez";

export async function planIndent(
    buffer: TextBuffer, selections: SelectionSet,
    yieldTurn: () => Promise<void>, signal: AbortSignal
) {
    const planner = planLanguageEdit(buffer, selections, "indent",
        resolveLanguageConfiguration({ tabSize: 2 }));
    try {
        while (!signal.aborted) {
            const step = planner.next();
            if (step.status === "ready") return step.result!;
            await yieldTurn();
        }
        return undefined;
    } finally {
        planner.dispose();
    }
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

Keep host commands tied to their pane and callbacks bounded. Submit host edits after notifications
in revision-checked transactions. Dispose the editor on detach. [React mounting](getting-started.md#mount-an-editor-in-react)

## Not covered

Device checks for dead keys, AltGr, clipboard and touch are listed in the [support matrix](README.md#support-matrix).
