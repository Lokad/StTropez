# Editor

Mount an editor for a document to type, select and undo. Two editors on the same document share text
and history. Each view keeps its own selection. Your application supplies the tabs, layout and
language rules.

## Use

Load the [stylesheet](getting-started.md) and give the container a height. This example restores
scroll on remount and keeps the view’s current selections, including changes made while detached.

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

On detach, store `editor.captureView()` by document and view ID, then call `editor.dispose()`. Dispose
a supplied view when its owner closes.

## Contract

### Mounting and presentation

Pass a `DocumentId` or `TabId` from the workspace to `mountTextEditor`. A document mount works without an open tab.
A tab mount also captures the tab generation, so replacing or closing that tab expires pending input.
Supply a view to keep its selections and folds across mounts. Otherwise the editor owns its view.
`editor.workspace` and `editor.view.documentId` identify the document. `editor.tab` holds the optional
tab capture. `editor.signal` aborts when the mount is disposed.

`editor.getSnapshot()` reports whether the text input has focus, including inside a shadow root
(`focused`), or is composing (`composing`). `readOnlyReason` is `null` when human edits are permitted,
`"read-only"` for a read-only view or resource, and `"edit-locked"` during an edit lease. A
`disabled` editor cannot receive input. `editor.subscribe(listener)` observes changes to these
fields. The frozen snapshot keeps its identity between changes. Disposal disables the editor,
clears focus and composition, and releases its listeners.

| Option | Behavior |
| --- | --- |
| `view` | Retained host view, or a new independent view when omitted |
| `ariaLabel` | Input label; defaults to the document title |
| `readOnly` | `false` by default; captured for this mount |
| `settings` | Initial editor settings. Change individual fields with `editor.configure(changes)`. Read the resolved, immutable values with `editor.settings()`. |

| Setting | Behavior |
| --- | --- |
| `language` | Host indentation, comment, pair and Enter rules; see [language configuration](#language-configuration) |
| `gutter`, `columnRulers`, `highlightCurrentLine`, `fontLigatures`, `scrollBeyondLastLine`, `minimap` | [Viewport settings](viewport.md#viewport-settings) |
| `pasteLineEndings` | `"local"` by default. `"preserve"` inserts clipboard line endings verbatim. |
| `bracketMatching` | Off by default; `true` or explicit matching limits enable it |
| `characterWarnings` | Off by default; `true` or a [character-warning policy](unicode.md#character-warnings) enables it |

`element` is the editor root. Read focus, composition and edit permissions from `getSnapshot()`.
Call `onEditIntent()` to observe native editing gestures and `focus()` to return typing to the pane
without scrolling. When a dialog returns focus to the pane, typing and commands resume at its
current selection. To replace document text, use a revision-checked workspace transaction.
`view` exposes selections and folds. `viewport` controls rendering and geometry.
Attach syntax, diagnostics and annotations through [editor decoration layers](viewport.md#decoration-layers).

A `readOnly` mount supports navigation, selection, copy, Find and dragging a copy. It refuses edits,
cut, paste, drop, undo, redo and replacement. Other views keep their own edit permissions, subject
to resource capabilities and locks. Remount with the same view to change this option.

The root's `data-read-only` attribute carries the reason while editing is unavailable.
Use the [edit refusal event](host-integration.md#input-conflict-recovery) to explain it after a blocked gesture.

### Reveal a destination

Call `editor.reveal(target, options)` to open folds covering a destination and scroll it into view
inside the editor. If a host panel opens a destination elsewhere on the page, call
`editor.element.scrollIntoView({ block: "nearest", inline: "nearest" })` to show the pane.
Pass a zero-based `{ line, column }`, a pair of positions `{ start, end }`, or half-open UTF-16
offsets `{ from, to }`. Use safe integers. Lines clamp to the document and columns to the line.
Position pairs select the span between their endpoints in either order. Offset ranges require
`from <= to` and clamp to the document.

`align` controls vertical placement. The default, `"nearest"`, scrolls just enough to show the range.
`"center-if-outside"` centers an off-screen range and keeps a visible range in place.
Use `"start"` to put the first row at the top or `"center"` to center the range. For a range taller
than the viewport, the first row is the target. Scrolling takes effect on the next viewport paint.

`select: true` replaces the selection set with the resolved range. `focus: true` focuses the editor
and preserves the surrounding page’s scroll position.
Both default to false and work in read-only views. The call returns the resolved offsets or `null`
when the captured editor is unavailable, input or a command is pending, composition is active, or
`expectedRevision` has expired. Keep the destination’s document identity when choosing a mounted editor.

```ts
import type { TextEditor } from "sttropez/browser";

export function openProblem(editor: TextEditor, revision: number, line: number, first: number, last: number) {
    const start = { line, column: first }, end = { line, column: last };
    return editor.reveal({ start, end }, { expectedRevision: revision, select: true, focus: true });
}
```

For delayed host work, retain the original document, revision and selections with a
[captured view request](host-integration.md#captured-view-requests).

### What happens when you type during a command

The textarea holds the selection and nearby text, using LF for native input. A large selection appears
in the textarea as one selected placeholder. Type over it and the editor replaces the full source
range. Enter uses the surrounding line ending. Editing elsewhere preserves the original CRLF.

`beforeinput` captures the intended replacement range, document revision and all selections. On
`input`, the editor uses that range if the native value and caret agree. For other supported rewrites,
it compares the bounded text around the edit. Typing the same text over a selection can collapse it
without changing the revision. When the editor mirrors a selection into the textarea, matching
endpoints keep their affinities.

A dead key can start a composition in the primary input. The editor displays the pending character
at the start of the selection. Committing replaces the selection in one undo step. Cancelling
preserves the selected text. Starting composition cancels queued commands. If the revision,
selection, permission or target changes before commit, the editor sends stale input to host recovery.

Undo and Redo keep a fully visible caret row in place. If the restored caret is off screen, the
editor centers its row vertically so you can read the surrounding code and continue typing there.

Navigation, deletion, word selection and language planning can take several turns. Type during a move
and the text goes at its destination. The editor replays queued input in order, preserving modifiers,
key meaning and event-time undo groups. It checks permission again. Paste and structural commands keep
separate undo steps. Short moves can finish synchronously. A command can return before paint.

Pending input belongs to the captured revision, selections, view and, for a tab mount, its generation. Escape,
composition, copy/cut, host-handled paste, detach or a change in that capture or permission cancels
replay. Only unapplied text goes to [input recovery](host-integration.md#input-conflict-recovery). On
failure the editor releases scans, rows and timers and reports `command-failed` with its cause.

### Selections and history

Type, paste, delete or move with several carets and the command acts on the whole selection set. The
textarea tracks the primary range. A focused editor draws a caret at the active end of each visible
range. Idle insertion carets blink together. They stay steady during selection and when reduced
motion is enabled. A one-column highlight at the end of a row marks a selected line break, including CRLF and
breaks on empty lines. Forced-colors mode uses the system selection and text colors. Use the
[view’s selection setters](workspace.md#document-views) to keep a set across remounts. See
[selection sets](text-model.md#selection-sets) for normalization and endpoint affinities.

Plain typing replaces every range with the same text. Deletion plans all targets before mutation
and merges overlapping deletions, including carets inside one grapheme. Movement preserves
extension anchors and endpoint affinities, then normalizes and publishes the result once. Only the
primary destination is revealed. Vertical commands retain each range's measured horizontal
column across short lines until another selection, edit or layout breaks the sequence.

Undo groups adjacent typing in the same view by word. A single space belongs to the following word.
A run of two or more spaces forms its own step. Pausing mid-word keeps the group open.
Consecutive deletes in the same direction can share a step. A command, newline, composition, paste,
replacement, focus loss, caret movement or an edit from another origin starts a new step. Undo
from either editable view. [Shared history and save boundaries](workspace.md#transactions-and-history)

### Selecting lines in the gutter

Click or double-click a line number to select the line and its line break. On a folded header,
the selection includes the hidden lines. Drag across numbers to select several lines.
Shift+click extends from the original caret to the clicked line's far edge. Returning to the
starting line restores the caret. If you started by selecting a whole line, it stays selected.
The editor keeps keyboard focus. The
gutter scrolls with the wheel and stays in place horizontally. Both comparison panes use their
own source line numbers. Alignment gaps have no number.

### Pointer dwell

`observePointerDwell(editor, listener, options?)` reports the document ID, revision, UTF-16 offset and
caret affinity under a resting mouse or pen. It leaves focus and selection with their current owner.
The default delay is 300 ms. Set `delayMs` to change it or `enabled` to suspend observation while
another control is open. `onMiss` can dismiss a hint when the pointer moves off text, onto a
comparison gap, or with a pressed button or Ctrl/Cmd.

The observer checks the painted position again when the delay ends. A changed revision, fold projection
or aligned comparison expires the pending visit. Use `isPending()` for pending work, `cancel()` to
forget the current visit and `dispose()` to detach. Disposing the editor also detaches it.

### Shortcuts

Ctrl/Cmd means Command on Apple platforms and Control elsewhere. The word modifier is Control
on all platforms. Apple keyboards also accept Option. Shift extends movement from each selection's anchor.

The browser entry exports `defaultEditorShortcuts.standard` and `.apple`. Each is a frozen
list of `[keys, command]` pairs for a newly mounted editor. To show shortcuts after attaching
features or rebinding commands, read `editor.keymap.getShortcuts(id)`.

```ts
import { defaultEditorShortcuts, type TextEditorCommand } from "sttropez/browser";

export function defaultKeys(command: TextEditorCommand, platform: keyof typeof defaultEditorShortcuts) {
    return defaultEditorShortcuts[platform].filter(([, id]) => id === command).map(([keys]) => keys);
}
```

| Input | Command |
| --- | --- |
| Left / Right | Logical grapheme movement; see [Unicode navigation](unicode.md#graphemes-and-word-movement) |
| Word modifier + Left / Right | Previous word start or next word end. Shift selects to that boundary. |
| Up / Down | Previous/next visible line at the retained horizontal column |
| PageUp / PageDown | Move by the viewport's visible page, retaining the column |
| Home / Shift+Home | Move to the first nonblank character, then to the line start on the next press. Shift extends the selection. On a blank line, move to the start. |
| End | Logical line end, excluding CR in CRLF and including a final lone CR |
| Ctrl/Cmd + Home / End | Document start/end |
| Apple Cmd + Left / Right, Up / Down | Line endpoints, document endpoints respectively |
| Backspace / Delete | Delete the selection or the adjacent grapheme. Backspace in leading spaces and tabs deletes to the previous tab stop. |
| Word modifier + Backspace / Delete | Delete the selection, an adjacent run of two or more whitespace characters, or one word toward the key. |
| Ctrl/Cmd + A | One whole-document selection |
| Ctrl/Cmd + L | Select the touched lines with their line breaks. Press again to extend by one line. |
| Ctrl/Cmd + D | Select the word under or touching the caret, then add the next occurrence on each press, wrapping at EOF. Between separators the caret stays put. |
| Ctrl/Cmd + Shift + L | Select all occurrences of the word under or touching the caret. Between separators the caret stays put. An explicit selection searches for its exact, case-sensitive text. |
| Ctrl/Cmd + Alt/Option + Up / Down | Copy each caret or selection one visible row up or down. Both ends keep their visual columns across shorter rows. |
| Ctrl/Cmd + U | Restore this view’s previous selections. A restored word keeps whole-word matching on the next Ctrl/Cmd + D. Editing starts a fresh caret history. |
| Ctrl/Cmd + G | Move to the start of the requested line. An off-screen line appears in the center. Requires `requestLine`. |
| Ctrl/Cmd + Shift + Backslash (physical key) | Jump from each selection's active end to the matching bracket. Uses the configured pairs and scan limits even when highlighting is off. |
| Ctrl + Up / Down, Alt/Option + PageUp / PageDown | Scroll by one visible row or one viewport height. The caret and selections stay in place. |
| Ctrl/Cmd + Z, Ctrl/Cmd + Shift+Z, Ctrl+Y | Undo, redo, redo |
| Tab / Shift+Tab | Indent/outdent; read-only views use normal focus traversal |
| Enter | Contextual newline and configured Enter rule |
| Ctrl/Cmd + / | Toggle the line comment, including when typing / requires Shift |
| Ctrl/Cmd + K, then Ctrl/Cmd + C or U | Add or remove line comments |
| Shift + Alt/Option + A | Toggle the block comment |
| Ctrl/Cmd + BracketRight or BracketLeft (physical keys) | Indent or outdent the touched lines |
| Alt/Option + Up or Down | Move touched lines one row. Add Shift to copy them and move each selection to its copy. |
| Ctrl/Cmd + Shift + K | Delete touched lines. Keep each caret's column on the following line, or the preceding line at EOF, up to its end. |
| Ctrl/Cmd + Enter / Ctrl/Cmd + Shift + Enter | Insert a blank line below / above the selection and place the caret at its indentation. |
| Escape | Cancel pending commands. With multiple carets or selections, keep only the primary range. |
| Escape then Tab / Shift+Tab | With a single range, leave the editor for the next/previous host control. |
| Click / Shift+click | One caret / extend the primary range while retaining secondary ranges |
| Alt+click / Alt+drag / Alt+double-click | Add a caret / range / code-word selection. With several ranges, Alt+click removes the one under the pointer. |
| Shift+Alt+drag / middle-button drag | Select a column of text from the press to the release point, with one range on each visible source line. |
| Shift+Alt+click | Select a column from the primary caret to the click. In comparison padding it ends on the last source line crossed. |
| Double-click | Select the code-word, symbol or whitespace run within the clicked logical line |
| Double-click and drag | Extend the selection by whole words in either direction |
| Triple-click / triple-click and drag | Select a line including its ending / extend by whole lines |
| Four clicks | Select the entire document |

After Escape removes extra carets, Tab indents at the primary range. Press Escape a second time
to arm focus traversal. The focused editor's solid outline becomes dashed and the root gains
the `data-st-tab-escape` attribute. A pointer press, selection change, or intervening key
cancels the exit. Holding Shift for the next Tab moves focus backward.

Set `requestLine` to a `LinePrompt` to enable `go-to-line`. It receives the one-based current line,
line count and an abort signal. Return a line number or a promise for it. Return `undefined` to
cancel. A new prompt, composition, a changed revision or selection, or disposal expires the request.
Only a valid reply from the same view moves the caret and returns focus.

Host tools get first chance at shortcuts. Cancelled events and composition events (including keyCode
229) bypass editor commands. [Example bindings](examples.md)

Double-click selects a run up to a grapheme boundary and excludes the line ending. Shift+click
extends from a double-clicked word and keeps that entire word selected in either direction.
Keyboard word movement follows the [code-word rules](unicode.md#graphemes-and-word-movement).
A single separator next to an identifier is skipped when moving toward that identifier. With
multiple carets, backward word movement stops at the separator. Put carets just after the
dots in `a.name` and `b.name`, then select one word backward to select both dots. Starting
inside an operator such as `?.` stops at its edge in either direction.
Beyond the last word, movement stops at the line boundary. Press again to enter the adjacent
line. Word Backspace at column one deletes the line break. Word Delete at the end of a line
also removes the next line’s indentation.
PageUp and PageDown
move `max(1, floor(viewportHeight / lineHeight) - 1)` visible rows, accounting for folds and
[aligned comparison rows](comparison.md).

Clicking uses the current document and folds, including edits awaiting paint.
It selects source text even where the transparent input overlaps it. Right- or middle-click
places the caret at the pointer, or keeps the selections when you click inside one. Dragging a
scrollbar or clicking its track keeps the selection. Typing brings the edited line back into view,
even during a track-click animation.

A column drag selects lines that reach its nearer horizontal edge. If every line falls short,
it places a caret at the end of each one.
Dragging straight down creates carets. Folded bodies and comparison padding contribute no ranges.
If you release in padding, the rectangle ends on the last source line crossed. The last participating line in the drag direction has the primary range. Typing replaces all ranges
in one undo step. Read-only panes allow the same selection gesture.

`--st-selection` paints above token and occurrence backgrounds. A selection drag ends
on pointer release, lost capture, cancellation or a source/view change. Hold a drag outside an edge to
scroll, up to three viewport lengths per second per axis. Each callback advances at most 32 ms of
movement. During composition the native input handles the pointer.

### Clipboard and text drag

The browser handles clipboard shortcuts, including Shift+Delete for Cut and Shift+Insert for Paste
on Windows. Copy joins nonempty selections in source order with LF. With only carets, it copies each distinct
visible line with its line ending, including a terminator for the last line. A collapsed header
copies its hidden body as well. Cut removes the same text in
one undo step. Pasting an editor-marked line at a caret inserts it above the current line and
preserves the caret’s column. Plain text from other applications inserts at the selection.

When the clipboard has one line per selection, each receives its corresponding line. A final line
break may terminate the last line or represent an empty line for one more selection. If neither count matches,
each selection receives the full text. Paste converts CR, LF and CRLF to the line ending at each destination
and preserves indentation.
Set `settings.pasteLineEndings` to `"preserve"` to insert clipboard text verbatim.
An empty or nontext payload leaves selections and pending commands
alone.

For custom paste, use `editor.registerPasteHandler()`. Read the clipboard during dispatch, then
apply the converted text at the [captured selections](host-integration.md#captured-insertion-and-structured-paste).

Dragging painted selected text captures source fragments, the whole selection set, revision
and tab/view identity. Editable sources in the same workspace move by default; Control
(Option on Apple platforms) requests a copy. Read-only sources and other workspaces copy.
Drop validates an opaque token and the last accepted target revision/model offset independently
of focus. If the browser strips the token, the drop leaves the text unchanged. Closing or
remounting the source pane cancels the transfer, even if the browser delivers the drop afterward.

The destination selects the dropped text, including all fragments of a multiline drop.
Same-document moves use one original-coordinate plan; cross-document moves use shared atomic
history. Undo restores the initiating sets. Dragend does not delete text. External plain text
inserts literally at the accepted offset; HTML is not interpreted and unsupported file drops
do not navigate. The drag preview takes up to 160 UTF-16 units and keeps surrogate pairs and CRLF
together at the cutoff. The drop uses the full selection. Cancellation/disposal removes the
drop caret, preview and edge-scrolling work.

A selection starts scrolling when the pointer leaves the viewport. For a text drop, the pointer enters
a zone inside the edge, including when the destination is mounted in a shadow root. Both use the
same bounded frame step. Each callback checks that the gesture is current, so an old frame cannot
move or cancel a new target.

### Language configuration

`LanguageConfiguration` defines editing rules without requiring a parser or language service.
`editor.configure({ language: configuration })` validates and replaces the view's configuration, updates tab
geometry and cancels pending commands. It returns `false` during composition or after disposal.
`editor.settings().language` returns the resolved snapshot. Arrays and delimiter objects are copied
and frozen; callbacks receive the exact immutable buffer and source endpoints.

| Field | Contract |
| --- | --- |
| `tabSize`, `insertSpaces` | Integer 1–256 (default 4); spaces by default, otherwise a tab |
| `lineComment` | Optional nonempty delimiter without CR/LF |
| `blockComment` | Optional nonempty opening/closing delimiters without CR/LF |
| `pairs` | Single-UTF-16-unit opening/closing delimiters, unique openings, no CR/LF; defaults to `()`, `[]`, `{}`; an empty array disables pairing |
| `allowPair` | Receives `PairingContext` with buffer/range, pair and `open`, `close` or `surround` operation; the host owns lexical eligibility and callback cost |
| `enter` | Omitted: newline without indentation copying. `"keep"`: copy indentation. Callback: return `EnterIndent` with `indent: -1 \| 0 \| 1` and optional `split` |

`EditingPair` describes delimiters; `LanguageEditContext` describes the immutable buffer/range.
`ResolvedLanguageConfiguration` supplies validated defaults.

### Running and binding commands

Use `editor.commands.get(id)` when opening a menu. Its label and enabled state belong to that
pane. `run(id)` checks availability again when the user activates the command.

```ts
import type { TextEditor } from "sttropez/browser";

export function undoMenuItem(editor: TextEditor) {
    const undo = editor.commands.get("undo");
    if (!undo) return;
    return { label: undo.label, enabled: undo.enabled, run: () => editor.commands.run(undo.id) };
}
```

Set `settings.commandLabel(id, fallback)` to translate editor-owned command labels in
`commands.get()` and `commands.list()`. Return `undefined` to use the supplied label.
`editor.configure({ commandLabel: null })` restores the original labels. Bind menus and
shortcuts by command ID.

Navigation, selection and scrolling work in read-only panes. Undo and Redo need an editable
pane and an entry in the document’s shared history. Editing commands return `false` during
composition, after disposal or when the required comment rule is missing. A long edit can
yield while it plans, then commits once if its target is current. [Default shortcuts](#shortcuts)

Unbinding Tab restores focus traversal. Unbinding Enter suppresses that keystroke. Native line
break and deletion events work independently of those bindings. For a non-cancellable deletion, the unit,
direction, revision and selections must match the captured input or the editor reports a conflict.

Add line comment adds one marker to each selected line of code, including existing comments.
Remove peels off one marker and its optional space. Markers align at the indentation of the
least-indented selected line. If a tab spans that column, markers move left to the nearest
column available on every line. Blank lines in a block keep their whitespace. Separate selections act independently
unless they touch the same line.

Toggle block comment wraps selected text with one space inside each delimiter. With an empty
selection, the caret lands between the two spaces. A caret or selection inside a complete comment removes its
delimiters and up to one padding space at each end. Carets in the same comment remove it once.
The editor matches the configured delimiters as text. A host can reject an inferred opener in a
string or other context through `allowPair`. Explicitly selected wrappers toggle directly.
All affected selections share one undo step.

`editor.commands.list()` returns immutable entries with an ID, label, owner, category and
enabled state. Built-ins use owner `"editor"`. Host commands default to owner `"host"` and
category `"General"`. For a command that takes an argument, pass it to both `get` and `run`.
The registered callbacks receive the argument and the receiving editor. Shortcuts and `list()`
use `undefined` for the argument. An unknown ID returns `undefined` from `get`.

`commands.register({ id, label, run, enabled }, { keys: ["Escape"], priority: 10 })` installs
a command and its shortcuts together. A duplicate ID or conflicting binding throws and leaves
the registry unchanged. Disposing the registration removes its bindings. Disposing the editor
retires the registry.

`editor.keymap.bind("Mod+k Mod+i", id)` binds a two-stroke chord. A single stroke uses the
same API. `Mod` means Meta on Apple platforms and Ctrl elsewhere. `Ctrl`, `Meta`, `Shift`
and `Alt` name modifiers on `KeyboardEvent.key`. Use `Space` or `Plus` for those keys.
On French AZERTY, Ctrl+: toggles line comments and Ctrl+; requests a quick fix. The bracket
shortcuts use the `)` and `^` keys, and bracket jump uses `*`. Shift distinguishes folding from indentation.
Use a physical binding such as `Ctrl+Shift+Code:BracketLeft` when the position matters.
A matching logical shortcut takes precedence. Other symbols and digits can use Shift to produce
the character in a binding.
AltGr stays available for text entry. On Apple keyboards, Option+Shift on the physical US A key
can toggle a block comment even when the key produces an accented letter.
Both strokes must come from the same control, including inside a shadow root. A chord expires
after 1.5 seconds or a change of focus, selection or document revision.
Bindings for the same sequence run in descending `priority` (default 0). A disabled command or one
that returns `false` lets the next binding try. A handled command consumes the keystroke.
After a chord prefix, a bound second stroke is consumed even if every eligible command declines.
Bindings repeat by default. Set `repeat: false`
to consume a held shortcut without invoking its enabled command again.
Equal priorities for the same sequence and single strokes that conflict with chord prefixes throw.
`keymap.unbind(keys)` removes all bindings for a sequence. Disposing a binding removes only that registration.
`keymap.getShortcuts(id)` returns a frozen array of the sequences currently bound to that command
on this editor. Each sequence appears once, even if the command has two priorities for it.
The strings retain the configured spelling, including `Mod` and physical key codes. An unbound or
unknown command returns an empty array. Read it when opening a menu so the hint reflects host rebindings.

Editor input dispatches registered shortcuts. A binding marked `{ shared: true }` also works
from controls inside the editor, including the fold gutter. For an external toolbar or form,
forward its bubbling keydown to the owning pane's `keymap.handle(event)`.
It prevents the default action for a handled shortcut. Ordinary field input and composition
stay with the field. [Host command example](host-integration.md)

Tab advances to the next configured tab stop. A partial single-line selection is replaced by that
whitespace. On a whitespace-only line with one caret, Tab first fills missing indentation from the
preceding line’s Enter rule. For whole lines, indent and outdent move the end of the existing
indentation to the next or previous tab stop. With four-column stops, six spaces become eight
on indent or four on outdent. A multiline selection leaves blank and whitespace-only lines
alone. A selection starting at column one keeps that boundary. A selection ending at the start
of the next line excludes that line. On a collapsed row, Tab, indent, outdent and line comments
apply to the header and its folded lines.

Line comments toggle nonblank lines. Block comments wrap or unwrap selections. Typing an opener
can insert its closer or surround a selection. Typing the closer steps over it once if this view
inserted it. Backspace or word Backspace between the two untouched delimiters deletes both.
The view tracks its pairs across edits and undo/redo until disposal or a change of delimiters.
A closing bracket typed after only spaces or tabs takes its matching opener’s indentation.
An unmatched or ambiguous closer, a lexical veto or the bracket search limit leaves the indentation in place.

Enter chooses the current row's LF/CRLF terminator, falling back to the preceding terminator
at EOF and LF when absent. Callback indentation removes/keeps/adds one unit and can split the
closing text onto another line. When Enter supplies all the whitespace on a blank line, the next
edit in the view removes it if the selection has left that line. Undo restores it with the edit.
Pairing, comments and cancellable non-composing line-break input
use the same transaction/transform path. Composition and noncancellable input use literal capture.

For headless planning, use `resolveLanguageConfiguration` and `planLanguageEdit`. Pass the
view’s current fold index as the fifth argument for line commands, including indentation and line comments.
Each collapsed block counts as one line. Pass the full edit batch to the workspace at the captured
revision. A copy keeps the same fold behavior if it preserves the planner's `lineMove` markers.
Omit the index to plan in source lines. A character
command can supply `canOvertype(offset)` to identify closers the caller inserted. Without it,
typing a closer inserts the character. Advance the lazy
cursor with `next(workBudget?)` or inspect it with `snapshot()`. Frozen progress gives `status`
(`running`, `ready`, `failed`, `disposed`), `phase` (`validate`, `plan`, `map`, `publish`), counters,
`result` and `failure`. Only `ready` gives a complete `SelectionEditPlan` to apply. An error records
its message and rethrows. `dispose()` frees unfinished work and the cursor’s result reference. A plan
you already hold stays valid for its capture. Calling `next()` or `dispose()` during an advance
throws.

Use `readUnits` for UTF-16 units the planner reads, including rereads. A host callback’s own reads
fall outside this count. `workUnits` also counts visits to ranges, rows, comment records and output
edits, attempts at pair rules, and `bulkWorkUnits`. Bulk charges estimate the input size for
normalization, position mapping, pair lookup, freezing output arrays, large reads and building newline
strings. They count once toward work. Large reads also count toward reads. The normalizer can reuse an
editor-owned selection set. If you pass raw ranges, supply them in normalized order. The cursor checks
the order as it advances.

Call `next()` with a safe integer of at least 256 work units (default 4,096). It handles validation
through final mapping. The planner checks the budget at scan, range and row boundaries roughly every
256 units. A whitespace read can span 4,096 units. A delimiter read, bulk operation or host callback
can run past the budget. Schedule the next call yourself and keep selections and configuration
immutable between calls. The example releases the planner if you cancel.

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

Before applying a returned plan, validate its captured revision, complete selections, target and
edit authority. The [workspace transaction](workspace.md#transactions-and-history) performs the
final model validation; the host owns any asynchronous selection/lifecycle guards.

### Edit transforms

`registerEditTransform(transform)` installs one `TextEditorEditTransform` and returns its removal
function. A disposed editor or occupied slot throws. `TextEditorEdit` contains `expectedRevision`,
proposed original-coordinate edits, resulting `selectionSet`, history `kind` and optional
`adjustNewlines` when the newline command supplied contextual indentation.

Return `undefined` to keep the proposed edit. To change it, return replacement edits and selections.
The workspace checks ranges and permissions. `complete(applied)` runs after the commit attempt
and its notifications, before the editor refreshes input. A callback error leaves a committed edit in
place. Keep the transform synchronous and bound to its view. Undo, redo, external transactions and
drag and drop bypass it. The [completion controller](language-features.md#completion) uses the same
slot for snippet mirroring.

### Bracket matching

The editor checks the bracket at the caret first, then the preceding character. It matches nested
open and close pairs from the language configuration. Use `allowPair` to exclude delimiters in
strings or comments. Symmetric quotes are pairing and surrounding rules.

`jump-to-bracket` moves to the partner of a bracket touching the caret. From inside a pair,
it moves to the innermost enclosing closing bracket. Outside a pair, it moves to the next
eligible bracket. The searches share one work budget.
The caret stays in place if the scan encounters mismatched brackets or reaches a limit.

Enable highlighting with `editor.configure({ bracketMatching: true })`. Supply `maxWorkUnits` and
`maxDepth` to limit a scan. Read `editor.bracketMatching.getSnapshot()` for the primary collapsed
caret, or subscribe to changes. A `limited` result means the scan exhausted its budget. Changing
the text, selection, configuration or focus invalidates pending work.

Only proven pairs receive decorations, composed with host colors and selections. Style them with
`--st-bracket-background` and `--st-bracket-border`. Call `bracketMatching.refresh()` outside
workspace notification delivery when lexical knowledge changes without a source/configuration
change. Working and reference views require their own snapshot's lexical context.

### View state, activity and limits

`captureView()` first synchronizes the native selection, then returns an immutable `ViewState`.
`restoreView()` uses the complete selection set when present and falls back to anchor and head. If you
retained the view while it was detached, pass `{ selection: "current" }` to restore scroll with its
current carets. After an edit, the viewport scrolls just enough to show the primary caret on both axes. Host
navigation can ask to center it. [Restoring scroll and folds](viewport.md#scrolling-and-saved-views)

`activity()` returns a cached immutable `TextEditorActivity` without layout reads or a flush. It
reports composition, disposal, `pendingInput`, `pendingCommand`, `pendingCaret`, `pendingWord`,
`pendingGrapheme` and `pendingDragScroll`. Focus or blur can schedule a caret frame after a move has
finished. Check the painted revision, full selection set, folds and alignment on the viewport.
Provider replies, bracket highlights and syntax colors can arrive later.

`getDiagnostics()` returns `TextEditorDiagnostics` with input sizes, event and transaction counts,
conflicts, queue size and command timings. Check event counts before using `lastInputMs`: cancelling `beforeinput` can suppress the
next `input`. See [clock definitions](README.md#glossary) and
[visible readiness checks](testing.md#readiness-and-visible-continuity).

| Area | Limit or scheduling policy |
| --- | --- |
| Settled native context | Up to 256 UTF-16 units on each side and 2,048 selected units; at most 2,560 before LF projection |
| Large native insertion | Known cancellable non-composing text that exceeds the context bound commits through the model before native mutation; no synthetic `input` event |
| Composition / missing-data / noncancellable input | Native capture can exceed the settled context bound until commit |
| Ordered input | At most 256 actions and 65,536 UTF-16 units; overflow offers exact unapplied text to recovery |
| Language planning | Yields across 256-range/line batches and bounded whitespace scans; the final transaction scales with the changed content |
| Bracket matching | Default 100,000 total work units and 1,024 nesting levels; positive safe-integer limits; at most 256-unit read windows |
| Bracket cursor advance | Budget at least 256; checkpoint overshoot at most 63 work units; host callback work is separate |
| Browser bracket task | Checks between 256-unit advances; stops after 16 advances, 4 ms or 4,096 work units; one advance/callback can exceed the scheduling target |
| Ordinary reads | Typing, navigation, scrolling and metadata updates do not export the whole document; copying/large edits can require proportional work |

Measure time to visible text and caret separately from these scheduling limits. See
[long-line rendering](viewport.md#rendering-limits) and [grapheme navigation](unicode.md).

## Host responsibilities

Keep decoration and language callbacks bounded. Issue writes after notifications. Capture the view ID
and wait for pending input before saving or running that text.

Keep the recovery listener attached through `dispose()` so it receives uncommitted text. Disposal is
idempotent and releases the mount’s work, listeners, views and DOM. Release host-owned resources
separately. In React, [mount through stable refs](getting-started.md#host-responsibilities).

## Not covered

Verify dead keys, AltGr and touch selection on your target devices.
[Editing and clipboard support](README.md#support-matrix)
