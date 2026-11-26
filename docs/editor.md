# Editor

Editors on the same document share text and Undo history. Each view keeps its own selection,
folds and scroll position.

## Use

Give the container a height and load the [stylesheet](getting-started.md). Retain the view to
keep its selections and folds when you remount it.

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

Save `editor.captureView()` by document and view on detach. Dispose the supplied view when its
owner closes.

## Contract

### Mounting and presentation

Mount by document or tab ID. Tab replacement or closure expires pending input. Without a
supplied `view`, the editor creates and owns one. `ariaLabel` defaults to the document title.

Set `readOnly: true` for navigation, selection, copy and Find. To change it, remount with the
same view. Set initial options in `settings`, update with `configure` and read back with
`settings()`. [Viewport settings](viewport.md#viewport-settings) · [Character warnings](unicode.md#character-warnings)

Use `getSnapshot()` and `subscribe()` for focus, composition, disabled state and
`readOnlyReason` (`null`, `"read-only"` or `"edit-locked"`). A disabled input cannot take focus.
`editor.focus()` returns typing to the selection without scrolling the page. To replace text
from the host, submit a revision-checked workspace transaction.
[Edit refusal and recovery](host-integration.md#input-conflict-recovery)

### Reveal a destination

`editor.reveal` opens enclosing folds and scrolls the pane. Use zero-based `{ line, column }`,
two positions `{ start, end }` in either order, or ascending half-open offsets `{ from, to }`.
Safe integer coordinates clamp at document boundaries.

```ts
import type { TextEditor } from "sttropez/browser";

export function openProblem(editor: TextEditor, revision: number, line: number, first: number, last: number) {
    const start = { line, column: first }, end = { line, column: last };
    return editor.reveal({ start, end }, { expectedRevision: revision, select: true, focus: true });
}
```

`select` and `focus` default to false and work in read-only panes. Align with `"nearest"`,
`"center-if-outside"`, `"start"` or `"center"`. Success returns the offsets. Busy, stale or
unavailable targets return `null`. [Capturing a delayed request](host-integration.md#captured-view-requests)

### What happens when you type during a command

Type during a long caret move and the queued text lands at the destination. Paste follows the
queued typing in a separate Undo step. A changed revision, selection, permission or mount can
invalidate the queue. Escape, composition and clipboard gestures can interrupt it.

Keep an `inputConflictEvent` listener on the original editor through disposal to recover
unapplied text. A failed command reports `command-failed` with its cause.
[Input recovery](host-integration.md#input-conflict-recovery)

### Selections and history

Typing replaces every range, even outside the native input window. Identical text can collapse
a selection without changing revision. Deletion merges overlaps. The input mirrors the primary
range. Shift extends from each anchor. Vertical motion retains each range’s column across short
lines. [Selection sets](text-model.md#selection-sets)

Undo from either editable pane. Typing groups by word across pauses. One space joins the next
word. Two or more form a separate step. Consecutive deletes in one direction can group. Moving
the caret, blur, a command, paste, composition, newline or an edit from another origin breaks
the group. Undo and Redo center an off-screen caret. [Shared history](workspace.md#transactions-and-history)

A dead key previews at the selection start. Commit takes one Undo step. Cancel keeps the text.
[Device qualification](README.md#support-matrix)

### Selecting lines in the gutter

Click a number to select the line and its ending, including a folded body. Drag across numbers
for whole lines or Shift+click to extend. Focus stays in the editor. In Changes each pane numbers
its own source lines and leaves alignment gaps blank.

### Pointer dwell

`observePointerDwell(editor, listener, options)` reports document, revision, offset and affinity
under a resting mouse or pen (default 300 ms). It rechecks the painted position before delivery.
Use `enabled` to suspend, `onMiss` to clear a hint, `cancel()` to forget a visit and `dispose()`
to detach.

### Shortcuts

`Mod` means Cmd on Apple keyboards and Ctrl elsewhere. The word modifier is Ctrl, or Option on
Apple. `defaultEditorShortcuts` lists the base editor bindings. After features attach or a host
changes bindings, read `editor.keymap.getShortcuts(id)` for the current pane.

```ts
import { defaultEditorShortcuts, type TextEditorCommand } from "sttropez/browser";

export function defaultKeys(command: TextEditorCommand, platform: keyof typeof defaultEditorShortcuts) {
    return defaultEditorShortcuts[platform].filter(([, id]) => id === command).map(([keys]) => keys);
}
```

| Navigation and selection | Action |
| --- | --- |
| Left / Right, word modifier + Left / Right | Move by grapheme or word. Shift extends. |
| Up / Down, PageUp / PageDown | Move a visible row or page at the retained column. |
| Home / End | First nonblank or line end. Repeated Home goes to line start. |
| Mod+Home / End | Document endpoints. On Apple, Cmd+Left / Right goes to line endpoints, Cmd+Up / Down to document endpoints. |
| Mod+A / Mod+L | Select all / select touched lines with endings. Repeat Mod+L to extend. |
| Mod+D / Mod+Shift+L | Next matching occurrence (wraps) / all occurrences. Matches selected text exactly or the word touching the caret. |
| Mod+Alt+Up / Down | Copy each caret or selection to the adjacent visible row. |
| Mod+U | Undo this view’s selection change. Editing resets caret history. |
| Mod+G / Mod+Shift+Backslash | Go to line (requires `requestLine`) / jump to bracket. |
| Ctrl+Up / Down, Alt+PageUp / PageDown | Scroll one row or page, keeping the selection. |

| Editing | Action |
| --- | --- |
| Backspace / Delete | Delete the selection or adjacent grapheme. Backspace in indentation goes to the previous tab stop. The word modifier deletes a word or whitespace run. |
| Mod+Z / Mod+Shift+Z or Ctrl+Y | Undo / Redo. |
| Tab / Shift+Tab | Indent / outdent. Read-only views traverse focus. |
| Enter or Shift+Enter | Contextual newline. |
| Mod+/ or Shift+Alt+A | Toggle a line or block comment. Mod+K then Mod+C adds a line marker, Mod+K then Mod+U removes one. |
| Mod+] / Mod+[ | Indent / outdent touched lines. |
| Alt+Up / Down | Move lines. Add Shift to copy and select the copies. |
| Mod+Shift+K | Delete lines. Keep the column on the next line or the preceding one at EOF, up to its end. |
| Mod+Enter / Mod+Shift+Enter | Insert a line below / above at its indentation. |
| Escape then Tab / Shift+Tab | Leave for the next / previous control. With multiple ranges, Escape first keeps the primary range. Press Escape again to arm Tab. |

An armed Tab exit shows a dashed outline and `data-st-tab-escape`. A pointer press, selection
change or intervening key cancels it. Escape also cancels pending commands. `requestLine` takes
one-based `currentLine`, `lineCount` and an abort signal. Return a line, a promise or `undefined`.
A new prompt, edit, selection change, composition or disposal expires it.

**Pointer.** Shift+click extends the primary range. Alt+click adds or removes a caret, Alt+drag
adds a range. Double-click selects by word and triple-click by line, including its ending.
Drag to extend either. Four clicks select all. [Word boundaries](unicode.md#graphemes-and-word-movement)

Shift+Alt+click selects a column from the caret. Shift+Alt+drag or middle-drag starts at the
press. Only visible source rows reaching the nearer edge participate. If all fall short, each
gets an end-of-line caret. The last participating row is primary. Scrollbar gestures preserve selection.

### Clipboard and text drag

Copy joins nonempty selections in source order with LF. With carets only, it copies each distinct
visible line with its ending, including folded text and a terminator for the final line.
Cut removes the same text in one Undo. Pasting an editor-marked line at a caret inserts it
above and retains the column.

Paste distributes one line per selection when the counts match. A trailing break may end the
last line or add an empty one. Otherwise each range gets the full text. Line endings follow
each destination unless `pasteLineEndings: "preserve"`. Empty or nontext data preserves the
selection and queued commands. For a custom format read the clipboard during dispatch.
[Structured paste](host-integration.md#captured-insertion-and-structured-paste)

Dragging between editable documents in one workspace moves text. Ctrl (Option on Apple), a
read-only source or another workspace copies. Move requires the original transfer token, source
view and revision, and accepted target and revision. Remounting the source expires it. Drop
selects the inserted text. Undo restores a cross-document move in one step. External text
inserts literally. File drops do not navigate.

### Language configuration

`editor.configure({ language })` replaces the editing rules for one view and cancels pending
commands. It returns `false` during composition or after disposal. Read the resolved, immutable
configuration from `editor.settings().language`.

| Field | Contract |
| --- | --- |
| `tabSize`, `insertSpaces` | Tab width 1–256, default four. Spaces by default. |
| `lineComment`, `blockComment` | Nonempty delimiters without CR or LF. Supply `{ open, close }` for block comments. |
| `pairs` | One UTF-16 unit per delimiter, no line endings, unique openings. Defaults to parentheses, brackets and braces. An empty array disables pairing. |
| `allowPair` | Receives the buffer, range, pair and operation (`open`, `close` or `surround`). Use it to exclude delimiters in strings or comments. |
| `enter` | Omit for a plain newline. `"keep"` copies indentation. A callback can remove, keep or add one unit and request a split. |

**Indentation.** Tab advances to the next stop, replacing a partial single-line selection.
On a blank line it can fill indentation from the preceding Enter rule. Whole-line indent/outdent
uses the adjacent stop, skipping blank lines in a multiline selection and a last line touched
only at its start. Line indentation and line comments include folded text.

**Comments.** Toggle removes a marker when every selected nonblank line is commented.
Otherwise it adds markers at common indentation. Add always inserts one. Remove strips one
and an optional space. Block comments pad the selection. Toggle inside a complete comment
removes its delimiters and padding in one Undo.

**Pairs and Enter.** An opener inserts its closer or surrounds the selection. Typing a tracked
closer steps over it once. Backspace between untouched delimiters removes both. Enter uses the
local line ending, the preceding ending at EOF, or LF. A subsequent edit can trim indentation
supplied by Enter on a blank line. Composition and noncancellable input use literal text.

### Running and binding commands

Build menus from `commands.get(id, argument)` or `commands.list()`. Dispatch to the same editor
and pass the same argument. `run` rechecks availability.

```ts
import type { TextEditor } from "sttropez/browser";

export function undoMenuItem(editor: TextEditor) {
    const undo = editor.commands.get("undo");
    if (!undo) return;
    return { label: undo.label, enabled: undo.enabled, run: () => editor.commands.run(undo.id) };
}
```

Set `settings.commandLabel(id, fallback)` to translate labels. Return `undefined` for the
fallback and configure `commandLabel: null` to reset. Undo and Redo need an editable pane and
history. Editing also requires any language rule the command uses.

`commands.register({ id, label, run, enabled }, { keys, priority })` installs a command and its
shortcuts together. Duplicate IDs and conflicting bindings throw. Dispose the registration to
remove both. `keymap.bind("Mod+k Mod+i", id)` binds a chord. `keymap.unbind(keys)` removes all
bindings on that sequence.

- Use `Ctrl`, `Meta`, `Shift` and `Alt` with `KeyboardEvent.key` or a physical `Code:BracketLeft`.
  Use `Space` and `Plus` for those keys. A matching logical binding takes precedence.
- Higher priority runs first. A disabled command or a `false` return tries the next binding.
  Equal priorities and single keys conflicting with chord prefixes throw. `repeat: false`
  consumes repeats until release.
- A chord expires after 1.5 seconds or a change of focus, revision or selection. Both strokes
  must reach the same control. A bound second stroke is consumed even when declined.
- For toolbars, set `shared: true` and forward keydowns to the owning `keymap.handle(event)`.
  Composition, AltGr and cancelled events bypass dispatch.
  [Host commands](host-integration.md#navigation-commands-and-lifecycle)

French AZERTY uses `Ctrl+:` for line comments and `Ctrl+;` for quick fixes. Bracket-key
positions control indentation and folding. On Apple, Option+Shift on physical A toggles block comments.
[Keyboard qualification](README.md#support-matrix)

**Headless edits.** `planLanguageEdit` takes a buffer, selections, command and resolved
configuration. Supply a fold index to treat collapsed blocks as lines. For a typed closer,
`canOvertype(offset)` marks where to skip an existing delimiter.

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

`next()` captures and validates the ranges on its first call. Keep configuration immutable.
Before applying the full plan, preserve its `lineMove` markers and recheck revision, selections,
target and permissions. [Transactions](workspace.md#transactions-and-history)

### Edit transforms

`registerEditTransform` takes one synchronous transform and returns its removal function.
An occupied slot or disposed editor throws. Return `undefined` to keep the proposed edits and
selection set, or return replacements in original coordinates. `complete(applied)` runs after
the commit attempt and notifications. A callback error leaves committed text in place.
Undo, Redo, external transactions and text drops bypass the slot.
[Snippet mirroring](language-features.md#completion)

### Bracket matching

`jump-to-bracket` tries the bracket at the caret, then the preceding one. Inside a pair it
seeks the innermost enclosing closer. Outside it seeks the next eligible bracket. A mismatch
or exhausted budget leaves the caret in place.

Enable paint with `bracketMatching: true`. `editor.bracketMatching.getSnapshot()` reports the
primary collapsed caret’s result, including `limited`. Call `refresh()` outside notifications
when lexical rules change. Use each comparison pane’s own snapshot to classify delimiters.

### View state, activity and limits

`captureView()` synchronizes the native selection and saves an immutable `ViewState`.
When remounting a retained view, `restoreView(saved, { selection: "current" })` restores scroll
and keeps the live carets. [Restoring scroll, selection and folds](viewport.md#scrolling-and-saved-views)

`activity()` reports pending input, command, caret and scroll work without forcing layout.
Check painted revision and selections separately. Colors and provider replies can arrive later.
`getDiagnostics()` reports handler times. Check the event count before using `lastInputMs`,
since cancelling `beforeinput` can suppress `input`. [Interaction clocks](README.md#measuring-an-interaction) ·
[Visible readiness](testing.md#readiness-and-visible-continuity)

| Area | Bound |
| --- | --- |
| Settled native input | Up to 256 UTF-16 units on each side and 2,048 selected units. Composition and noncancellable input may exceed this window until commit. |
| Ordered input | 256 actions and 65,536 UTF-16 units. Overflow offers unapplied text to recovery. |
| Language planner | `next(workBudget)` accepts at least 256 units, default 4,096. Commit cost scales with changed content. |
| Bracket scan | Defaults to 100,000 work units and 1,024 nesting levels. Limits must be positive safe integers. |

## Host responsibilities

Dispose the editor on detach. Bound callbacks, write after notifications and check pending input
on the captured view before Save or Run.
[React mounting](getting-started.md#host-responsibilities)

## Not covered

Verify dead keys, AltGr and touch selection on your target devices.
[Editing and clipboard support](README.md#support-matrix)
