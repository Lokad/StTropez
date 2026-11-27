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

Mount by document ID. The editor owns the view it creates. Dispose the editor when its pane closes or
switches documents. Disposal expires pending input. `ariaLabel` defaults to the document title.

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
`"center-if-outside"`, `"start"` or `"center"`. A `done` outcome carries the clamped range. A changed revision or closed view returns `stale`. During composition or another active input operation, the view returns `refused` with reason `unavailable-view`.

### Input and host commands

Keyboard moves and column selections finish before the next input. A following paste has its own Undo step.
Before saving or running a draft, check that each editing pane reports `activity().input === "idle"`.
Listen for `inputConflictEvent` to recover text rejected by an edit or host transform.
[Host example](getting-started.md#add-features-to-a-browser-ide)

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
`editor.keymap.getShortcuts(id)` lists the active shortcuts, including host bindings.

The [default bindings](#default-key-bindings) list the keys installed by each control. In a writable pane,
Tab indents selected lines and Backspace in indentation removes a tab stop. In a read-only pane Tab moves
focus. Escape followed by Tab or Shift+Tab leaves the editor. With several selections the first Escape
keeps the primary range.

Up and Down retain the caret’s visual column across visible rows. Home alternates between the first
nonblank character and line start. Select Line includes the ending and extends on a second press.
Select Next Occurrence and Select All Occurrences resolve an empty selection to the word at the caret.
Scrolling by command leaves selections in place. Undo Caret restores the previous selection until the
next edit.

Move Line keeps the selection with its text. Copy Line selects the copy. Delete Lines keeps the caret’s
column where the surviving line allows it. Inserting a sibling of a collapsed block uses the header’s
indentation. The language’s Enter rule can indent the new line inside a block before its closing delimiter.

Go to line passes `requestLine` one-based `currentLine`, `lineCount` and an abort signal.
Return a line or `undefined`, directly or in a promise. Selection, revision or mount changes expire it. On French AZERTY, `Ctrl+:` toggles line comments and `Ctrl+;` opens fixes.
[Keyboard support](README.md#support-matrix)

Shift+click extends the primary selection. Alt+click toggles a caret and Alt+drag adds a range.
Double-click selects a word, triple-click a line, four clicks the document. Shift+Alt+click
selects a column from the caret. Further Shift+Alt+clicks move the opposite corner.
Shift+Alt+drag or middle-drag starts at the press. Visible
rows reaching the nearer edge participate. If all fall short, each gets an end-of-line caret.

### Clipboard and text drag

Copy joins selections in order with LF. Carets alone copy distinct whole lines, including folded bodies
and endings. Cut takes one Undo. Paste editor-marked lines at a caret to insert above and keep its column.

Matching line and selection counts distribute one line per range. Otherwise each gets the full text.
Endings follow the destination unless `pasteLineEndings` is `"preserve"`.

A drag between writable documents in the same workspace moves the text in one Undo. Ctrl
(Option on Apple), a read-only source or another workspace copies. Moves require the original
token, views and revisions. A drop selects the inserted text.

### Convert a structured paste

`registerPasteHandler` prepares a conversion without editing. A read-only pane refuses paste.
Literal paste uses the current selection. Removing the handler cancels conversion.

`editor.captureInsertion()` returns `undefined` while busy, composing or read-only. Typing, selection
changes, a new capture or disposal can expire the target. Pass its `signal` to the converter. `insert(text)`
replaces all selections in one Undo step. For distinct replacements, pass one string per selection in order.
Empty entries delete their selections. An all-empty result consumes the target and returns `false`. Use
`cancel()` to discard it. [Table conversion](examples.md#table-conversion)

Read the custom format inside the paste event. Capture the insertion before starting an asynchronous conversion.

```ts
import type { TextEditor } from "sttropez/browser";

export function attachConvertedPaste(
    editor: TextEditor,
    convert: (html: string, signal: AbortSignal) => Promise<string>,
    report: (message: string) => void
): () => void {
    return editor.registerPasteHandler(data => {
        if (!data.types.includes("text/html")) return;
        const html = data.getData("text/html");
        return target => {
            if (html.length > 262_144) {
                target.cancel();
                report("Clipboard HTML exceeds the conversion limit.");
                return;
            }
            void (async () => {
                try {
                    const text = await convert(html, target.signal);
                    if (!target.isCurrent()) return;
                    if (text.length * target.selectionSet.ranges.length > 4_194_304) {
                        report("Converted text exceeds the insertion limit.");
                        return;
                    }
                    target.insert(text);
                } catch (error) {
                    if (!target.signal.aborted) report(String(error));
                } finally {
                    target.cancel();
                }
            })();
        };
    });
}
```

### Language configuration

`configure({ language })` replaces one view's editing rules. It returns
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
Translate with `strings.commandLabel(id, fallback)`. For a host chord, choose a free sequence such as `editor.keymap.bind("Mod+k Mod+y", id)`.
`keymap.unbind(keys)` clears those keys.

- The keymap checks the normalized character first, then the physical binding such as `Code:BracketLeft`.
  Ctrl and Command punctuation use the key's layout mapping. For a symbol produced with Shift, an explicit
  physical binding takes precedence over dropping Shift. `Space` and `Plus` are literals.
- Host priority defaults to 0, above built-ins. Highest wins, newest wins ties. Disabled or declined
  commands (`false`) fall through.
- Duplicate IDs and single-key/chord-prefix conflicts throw. Both strokes need the same control,
  selection and revision within 1.5 seconds.
- Use `repeat: false` for one activation per press. To share a shortcut with a toolbar, set
  `shared: true` and forward its event to that pane's `keymap.handle`.


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

### Edit intent and input recovery

`editor.onEditIntent(listener, signal?)` reports `beforeinput`, `compositionstart`, `paste` and `cut` before
handling. Use it to dismiss previews. A gesture may emit several events or make no edit. Dispose the
listener or abort its signal.

The editor reports refused edits and input conflicts on `editor.element`. Keep the listener through disposal to capture unfinished input. Both events bubble within the DOM root.

```ts
import { inputConflictEvent } from "sttropez/browser";
import type { TextEditor } from "sttropez/browser";
import type { DocumentId } from "sttropez";

export function ownInputRecovery(
    editor: TextEditor,
    validateAndRetain: (documentId: DocumentId, detail: unknown) => void
): () => void {
    const documentId = editor.view.documentId;
    const listeners = new AbortController();
    editor.element.addEventListener(inputConflictEvent, event => {
        validateAndRetain(documentId, (event as CustomEvent<unknown>).detail);
    }, { signal: listeners.signal });
    return () => {
        try { editor.dispose(); }
        finally { listeners.abort(); }
    };
}
```

`editRefusedEvent` gives the `documentId` and refusal reason (`read-only`).
`inputConflictEvent` carries the document ID, reason, `expectedRevision` and `attemptedText`.
Prefer `attemptedEdit` for the UTF-16 span. `contextFrom` alone can be zero for a pending insertion.
Validate event data before storage, omit unsuitable `cause` values and recheck the resource and revision
on recovery.

### Edit transforms

`registerEditTransform` installs one synchronous transform and returns its removal function.
Return `undefined` to keep the proposed edit or replace it in original coordinates. An occupied
slot throws. `complete(applied)` runs after the commit attempt and notifications. Undo, Redo,
external writes and drops bypass the transform. [Snippet mirroring](language-features.md#completion)

### Bracket matching

`jump-to-bracket` checks at the caret, then just before it. Inside a pair it seeks the enclosing
closer, otherwise the next eligible bracket. A mismatch or exhausted budget leaves the caret in
place. Multi-caret jumps can share the result of `allowPair` for a delimiter during the command.
`bracketMatching: true` paints the match. Read `editor.bracketMatching.getSnapshot()` for
the primary caret and call `refresh()` when lexical rules change.

### View state, activity and limits

`restoreView(saved, { selection: "current" })` restores scroll on remount and keeps the live
selection. `activity().input` is `"composing"` during native composition and `"host-insertion"` while a host owns a captured insertion. For visible readiness check that the
new text, colors and carets are painted. `getDiagnostics()` times input handlers. A cancelled
`beforeinput` can suppress `input`, so check its event count before using `lastInputMs`.
[View restoration](viewport.md#scrolling-and-saved-views) · [Interaction clocks](README.md#measuring-an-interaction)

| Operation | Bound |
| --- | --- |
| Settled input window | 256 UTF-16 units per side and 2,048 selected units. Composition and noncancellable input can exceed it until commit. |
| Language planner | Default budget 4,096 work units, minimum 256. |
| Bracket scan | Defaults to 100,000 work units and 1,024 nesting levels. Both limits take positive safe integers. |

### Default key bindings

Each command below has the registry owner `editor`. A space between strokes denotes a chord. Features
install their bindings when attached. Popup commands act while their control is active. Hosts can rebind them.

<!-- default shortcuts -->

| Category | Command | Keys | Platform |
| --- | --- | --- | --- |
| Code actions | `quickfix.apply` | `Enter` | All |
| Code actions | `quickfix.dismiss` | `Escape` | All |
| Code actions | `quickfix.next` | `ArrowDown` | All |
| Code actions | `quickfix.previous` | `ArrowUp` | All |
| Code actions | `quickfix.show` | `Mod+.` | All |
| Comparison | `comparison.nextChange` | `F7` | All |
| Comparison | `comparison.previousChange` | `Shift+F7` | All |
| Completion | `completion.dismiss` | `Escape` | All |
| Completion | `completion.insert` | `Tab` | All |
| Completion | `completion.move-left` | `ArrowLeft` | All |
| Completion | `completion.move-right` | `ArrowRight` | All |
| Completion | `completion.next` | `ArrowDown` | All |
| Completion | `completion.page-next` | `PageDown` | All |
| Completion | `completion.page-previous` | `PageUp` | All |
| Completion | `completion.previous` | `ArrowUp` | All |
| Completion | `completion.replace` | `Enter`, `Alt+Enter` | All |
| Completion | `completion.request` | `Mod+Code:Space` | All |
| Completion | `snippet.choice-next` | `Alt+ArrowDown`, `Alt+Shift+ArrowDown` | All |
| Completion | `snippet.choice-previous` | `Alt+ArrowUp`, `Alt+Shift+ArrowUp` | All |
| Completion | `snippet.next` | `Tab` | All |
| Completion | `snippet.previous` | `Shift+Tab` | All |
| Editing | `add-caret-above` | `Mod+Alt+ArrowUp` | All |
| Editing | `add-caret-below` | `Mod+Alt+ArrowDown` | All |
| Editing | `add-line-comment` | `Mod+k Mod+c` | All |
| Editing | `block-comment` | `Alt+Shift+a` | All |
| Editing | `block-comment` | `Alt+Shift+Code:KeyA` | Apple |
| Editing | `copy-line-down` | `Alt+Shift+ArrowDown` | All |
| Editing | `copy-line-up` | `Alt+Shift+ArrowUp` | All |
| Editing | `delete-backward` | `Backspace`, `Shift+Backspace` | All |
| Editing | `delete-forward` | `Delete` | All |
| Editing | `delete-lines` | `Mod+Shift+k` | All |
| Editing | `delete-word-backward` | `Ctrl+Backspace`, `Ctrl+Shift+Backspace` | All |
| Editing | `delete-word-backward` | `Alt+Backspace`, `Alt+Shift+Backspace` | Apple |
| Editing | `delete-word-forward` | `Ctrl+Delete`, `Ctrl+Shift+Delete` | All |
| Editing | `delete-word-forward` | `Alt+Delete`, `Alt+Shift+Delete` | Apple |
| Editing | `go-to-line` | `Mod+g` | All |
| Editing | `indent` | `Tab` | All |
| Editing | `indent-lines` | `Mod+]` | All |
| Editing | `insert-line-above` | `Mod+Shift+Enter` | All |
| Editing | `insert-line-below` | `Mod+Enter` | All |
| Editing | `jump-to-bracket` | `Mod+Shift+\` | All |
| Editing | `line-comment` | `Mod+/` | All |
| Editing | `move-down` | `ArrowDown` | All |
| Editing | `move-left` | `ArrowLeft` | All |
| Editing | `move-line-down` | `Alt+ArrowDown` | All |
| Editing | `move-line-up` | `Alt+ArrowUp` | All |
| Editing | `move-page-down` | `PageDown` | All |
| Editing | `move-page-up` | `PageUp` | All |
| Editing | `move-right` | `ArrowRight` | All |
| Editing | `move-to-document-end` | `Mod+End` | All |
| Editing | `move-to-document-end` | `Meta+ArrowDown` | Apple |
| Editing | `move-to-document-start` | `Mod+Home` | All |
| Editing | `move-to-document-start` | `Meta+ArrowUp` | Apple |
| Editing | `move-to-line-end` | `End` | All |
| Editing | `move-to-line-end` | `Meta+ArrowRight` | Apple |
| Editing | `move-to-line-start` | `Home` | All |
| Editing | `move-to-line-start` | `Meta+ArrowLeft` | Apple |
| Editing | `move-up` | `ArrowUp` | All |
| Editing | `move-word-backward` | `Ctrl+ArrowLeft` | All |
| Editing | `move-word-backward` | `Alt+ArrowLeft` | Apple |
| Editing | `move-word-forward` | `Ctrl+ArrowRight` | All |
| Editing | `move-word-forward` | `Alt+ArrowRight` | Apple |
| Editing | `newline` | `Enter`, `Shift+Enter` | All |
| Editing | `outdent` | `Shift+Tab`, `Mod+[` | All |
| Editing | `redo` | `Mod+Shift+z`, `Ctrl+y` | All |
| Editing | `remove-line-comment` | `Mod+k Mod+u` | All |
| Editing | `scroll-line-down` | `Ctrl+ArrowDown` | All |
| Editing | `scroll-line-up` | `Ctrl+ArrowUp` | All |
| Editing | `scroll-page-down` | `Alt+PageDown` | All |
| Editing | `scroll-page-up` | `Alt+PageUp` | All |
| Editing | `select-all` | `Mod+a` | All |
| Editing | `select-all-occurrences` | `Mod+Shift+l` | All |
| Editing | `select-down` | `Shift+ArrowDown` | All |
| Editing | `select-left` | `Shift+ArrowLeft` | All |
| Editing | `select-line` | `Mod+l` | All |
| Editing | `select-next-occurrence` | `Mod+d` | All |
| Editing | `select-page-down` | `Shift+PageDown` | All |
| Editing | `select-page-up` | `Shift+PageUp` | All |
| Editing | `select-right` | `Shift+ArrowRight` | All |
| Editing | `select-to-document-end` | `Mod+Shift+End` | All |
| Editing | `select-to-document-end` | `Meta+Shift+ArrowDown` | Apple |
| Editing | `select-to-document-start` | `Mod+Shift+Home` | All |
| Editing | `select-to-document-start` | `Meta+Shift+ArrowUp` | Apple |
| Editing | `select-to-line-end` | `Shift+End` | All |
| Editing | `select-to-line-end` | `Meta+Shift+ArrowRight` | Apple |
| Editing | `select-to-line-start` | `Shift+Home` | All |
| Editing | `select-to-line-start` | `Meta+Shift+ArrowLeft` | Apple |
| Editing | `select-up` | `Shift+ArrowUp` | All |
| Editing | `select-word-backward` | `Ctrl+Shift+ArrowLeft` | All |
| Editing | `select-word-backward` | `Alt+Shift+ArrowLeft` | Apple |
| Editing | `select-word-forward` | `Ctrl+Shift+ArrowRight` | All |
| Editing | `select-word-forward` | `Alt+Shift+ArrowRight` | Apple |
| Editing | `undo` | `Mod+z` | All |
| Editing | `undo-caret` | `Mod+u` | All |
| Find | `find.close` | `Escape` | All |
| Find | `find.insertLineBreak` | `Mod+Enter` | All |
| Find | `find.next` | `F3` | All |
| Find | `find.open` | `Mod+f` | All |
| Find | `find.previous` | `Shift+F3` | All |
| Find | `find.query.next` | `Enter` | All |
| Find | `find.query.previous` | `Shift+Enter` | All |
| Find | `find.replace` | `Mod+h` | All |
| Find | `find.replaceAll` | `Ctrl+Alt+Enter` | All |
| Find | `find.replaceCurrent` | `Enter` | All |
| Find | `find.toolbar.close` | `Escape` | All |
| Folding | `fold.collapse` | `Mod+Shift+[` | All |
| Folding | `fold.expand` | `Mod+Shift+]` | All |
| General | `locations.definition` | `F12` | All |
| General | `locations.dismiss` | `Escape` | All |
| General | `locations.next` | `ArrowDown` | All |
| General | `locations.open` | `Enter` | All |
| General | `locations.pageDown` | `PageDown` | All |
| General | `locations.pageUp` | `PageUp` | All |
| General | `locations.previous` | `ArrowUp` | All |
| General | `locations.references` | `Shift+F12` | All |
| Hover | `hover.dismiss` | `Escape` | All |
| Hover | `hover.inspect` | `Mod+k Mod+i` | All |
| Rename | `rename.dismiss` | `Escape` | All |
| Rename | `rename.preview` | `Mod+Enter` | All |
| Rename | `rename.start` | `F2` | All |
| Rename | `rename.submit` | `Enter` | All |
| Signature help | `signature.dismiss` | `Escape` | All |
| Signature help | `signature.next` | `ArrowDown` | All |
| Signature help | `signature.previous` | `ArrowUp` | All |
| Signature help | `signature.request` | `Mod+Shift+Space` | All |

<!-- end default shortcuts -->

## Host responsibilities

Bind commands to their pane. Submit revision-checked edits after notifications. Dispose the editor
on detach. [React mounting](getting-started.md#mount-an-editor-in-react)

## Not covered

[Dead keys, AltGr, clipboard and touch](README.md#support-matrix)
