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

Mount by `DocumentId` or `TabId`. A tab mount expires pending input if the tab closes or is replaced.
Supply a `view` to retain its selections and folds across mounts. Otherwise the editor creates and owns the view.

| Mount option | Use |
| --- | --- |
| `ariaLabel` | Label the input. Defaults to the document title. |
| `readOnly` | Defaults to `false`. A read-only pane allows navigation, selection, copy, Find and dragging a copy. Remount with the same view to change this setting. |
| `settings` | Pass initial settings, change fields with `configure(changes)` and read resolved values with `settings()`. |

| Setting | Use |
| --- | --- |
| `language` | [Indentation, comments, pairs and Enter](#language-configuration) |
| `gutter`, `columnRulers`, `highlightCurrentLine`, `fontLigatures`, `scrollBeyondLastLine`, `minimap` | [Viewport settings](viewport.md#viewport-settings) |
| `pasteLineEndings` | `"local"` by default. Use `"preserve"` for verbatim text. |
| `bracketMatching`, `characterWarnings` | Off by default. Pass `true` or a [bracket limit](#bracket-matching) or [warning policy](unicode.md#character-warnings). |

`getSnapshot()` reports `focused` (including in a shadow root), `composing`, `disabled` and `readOnlyReason`.
An editable pane reports `null`, a read-only view or resource reports `"read-only"`, and an edit lease
reports `"edit-locked"`. The root's `data-read-only` carries that reason. Subscribe to state with
`subscribe(listener)` or handle the [edit refusal event](host-integration.md#input-conflict-recovery).
The frozen snapshot keeps its identity between changes. A disabled pane cannot receive input.
Disposal clears focus and composition, disables the pane, releases listeners and aborts `editor.signal`.

Use `editor.workspace`, `editor.view.documentId` and the optional `editor.tab` to identify the target.
`view` owns selections and folds. `viewport` exposes geometry and [decoration layers](viewport.md#decoration-layers).
`element` is the root. `onEditIntent()` observes native editing gestures. `focus()` returns typing to the
current selection without scrolling the page. To replace text, use a revision-checked workspace transaction.

### Reveal a destination

`editor.reveal(target, options)` opens enclosing folds and scrolls to a destination on the next paint.
Pass zero-based `{ line, column }`, a pair of positions `{ start, end }` in either order, or half-open
UTF-16 offsets `{ from, to }` with `from <= to`. Use safe integers. Positions clamp to the document and line.

`align` accepts `"nearest"` (default), `"center-if-outside"`, `"start"` or `"center"`. A range taller
than the viewport aligns by its first row. To reveal the pane on the surrounding page, call
`editor.element.scrollIntoView({ block: "nearest", inline: "nearest" })`.

Pass `select: true` to replace the selection set or `focus: true` to focus the pane. Both default to
false and work in read-only views. The result is the resolved offsets, or `null` for an unavailable
editor, pending input or command, active composition or expired `expectedRevision`.

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

Type while a long word move is running and the text lands at the new caret. Paste follows queued typing
as a separate undo step. Queued keys retain their modifiers and typing groups.

Escape, composition, copy, cut and a host-cancelled clipboard event can interrupt a command. A change of
text, selection, permission or mount can invalidate queued input. Listen for `inputConflictEvent` on the
original editor to recover unapplied text. A failed command supplies `command-failed` and its cause.
[Input recovery](host-integration.md#input-conflict-recovery)

Typing replaces the full selection, including when the textarea holds a placeholder. Identical text can
collapse the selection without changing the revision. A dead key previews at the selection start.
Commit takes one undo step and cancellation preserves the selected text. [Device support](README.md#support-matrix)

### Selections and history

Typing replaces each range. Deletion merges overlapping targets, including carets inside one grapheme.
Movement preserves extension anchors and affinities and reveals the primary destination. Vertical motion
retains each range’s measured column across short lines until another selection, edit or layout change.
[Selection sets](text-model.md#selection-sets) · [Retain a view](workspace.md#document-views)

The textarea tracks the primary range. The focused pane draws each visible caret. Idle carets blink
together and stay steady during selection or with reduced motion. Selected line breaks, including
CRLF and empty lines, occupy one highlight column. Forced-colors mode uses system colors.

Undo from either editable view. Adjacent typing groups by word. One space belongs to the next word,
two or more make a separate step, and a pause mid-word keeps the group open. Consecutive deletes in
one direction can group. A command, newline, composition, paste, replacement, blur, caret move or edit
from another origin starts a step. Undo and Redo center an off-screen caret and preserve a visible
caret row. [Shared history and save boundaries](workspace.md#transactions-and-history)

### Selecting lines in the gutter

Click or double-click a number to select the line and its break, including a folded body. Drag to select
several lines. Shift+click extends to the far edge of the clicked line. Returning to the start restores
the original caret or whole-line selection. Keyboard focus stays in the editor. The gutter scrolls
vertically with the wheel. Comparison panes number their own source rows and leave alignment gaps blank.

### Pointer dwell

`observePointerDwell(editor, listener, options?)` reports document ID, revision, UTF-16 offset and caret
affinity under a resting mouse or pen. Set `delayMs` (default 300) or suspend observation with `enabled`.
Use `onMiss` to dismiss a hint off text, in a comparison gap, with a button pressed or with Ctrl/Cmd held.

The observer rechecks the painted position after the delay. A changed revision, fold or comparison
alignment expires the visit. `isPending()` reports pending work, `cancel()` forgets it, and `dispose()`
detaches. Disposing the editor also detaches the observer. Focus and selection stay in place.

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

After Escape removes extra carets, a second Escape arms Tab to leave the editor. Its outline turns dashed
and the root gains `data-st-tab-escape`. Shift+Tab leaves backward. A pointer press, selection change or
intervening key cancels the exit.

`requestLine` receives the one-based current line, line count and abort signal. Return a line number
or a promise, or return `undefined` to cancel. A new prompt, composition, edit, selection change or
disposal expires it. A valid reply moves the caret and returns focus. Host tools get first chance at
shortcuts. Cancelled events and composition (including keyCode 229) bypass editor bindings.

**Word and page movement.** Double-click selects a grapheme-aligned run within its line. Shift+click
extends from that word, keeping it selected in either direction. A single separator next to an identifier
is skipped toward the identifier. With multiple carets just after the dots in `a.name` and `b.name`,
selecting one word backward selects both dots. Inside an operator such as `?.`, movement stops at its
edge. Beyond the last word, the first move stops at the line boundary. Word Backspace at column one joins
the lines. Word Delete at line end also removes the next line’s indentation. PageUp/Down moves
`max(1, floor(viewportHeight / lineHeight) - 1)` visible rows through folds and comparison alignment.
[Word rules](unicode.md#graphemes-and-word-movement)

**Pointer selection.** Clicks resolve against the current text and folds, including edits awaiting paint.
Right- or middle-click preserves a selection under the pointer or places the caret there. Scrollbar
gestures preserve the selection. Typing reveals the edited row even during a track-click animation.

Column selection includes rows reaching its nearer horizontal edge. If every row falls short, each gets
an end-of-line caret. A vertical drag creates carets. Fold bodies and comparison gaps add no ranges.
The last participating row in the drag direction is primary. Typing replaces the ranges in one undo
step. The same gesture works in read-only panes.

`--st-selection` paints above token and occurrence backgrounds. Dragging outside an edge scrolls up to
three viewport lengths per second per axis in steps capped at 32 ms. Release, lost capture, cancellation
or a source/view change ends the drag. The native input handles the pointer during composition.

### Clipboard and text drag

Copy joins nonempty selections in source order with LF. With carets only, it copies each distinct
visible line with its ending, including a terminator for the final line and the hidden body of a fold.
Cut removes the same text in one step. Paste an editor-marked line at a caret to insert it above the
line and retain the column. External plain text replaces the selection. The browser handles clipboard
shortcuts, including Shift+Delete and Shift+Insert on Windows.

If the clipboard holds one line per selection, Paste distributes the lines. A trailing break can
terminate the last line or supply one more empty line. When neither count matches, each range gets
the full text. Paste retains indentation and converts line endings at each destination unless
`pasteLineEndings` is `"preserve"`. An empty or nontext payload preserves selections and queued commands.
To convert structured text, read the clipboard during dispatch in `registerPasteHandler()`.
[Captured insertion](host-integration.md#captured-insertion-and-structured-paste)

Dragging a selection moves text between editable documents in the same workspace. Control (Option
on Apple) requests a copy. Read-only sources and other workspaces copy. Drop uses a transfer token,
the captured source fragments, revision and view, and the last accepted target offset and revision.
Stripping the token or remounting or closing the source cancels the transfer.

The destination selects the dropped fragments. Same-document moves use original coordinates.
Cross-document moves share an atomic undo step that restores the initiating selections. Dragend
does no deletion. External plain text inserts literally, HTML stays inert and file drops do not navigate.
The preview keeps up to 160 UTF-16 units without splitting a surrogate pair or CRLF. Drop inserts the
full selection. Near a target edge, holding a text drag scrolls the target, including in a shadow root.
Cancellation and disposal clear the preview, drop caret and pending scroll.

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

`commands.list()` returns immutable entries with ID, label, owner, category and enabled state.
Built-ins belong to `"editor"`. Host commands default to `"host"` and `"General"`. Menus should bind by
ID. To translate labels in `get()` and `list()`, set `settings.commandLabel(id, fallback)`. Returning
`undefined` keeps the fallback. Passing `commandLabel: null` to `configure()` restores the defaults.

For a command with an argument, pass it to both `get` and `run`. The callbacks receive the argument
and the target editor. Shortcuts and `list()` pass `undefined`. An unknown ID returns `undefined` from `get`.
Navigation, selection and scrolling work in read-only panes. Undo and Redo require an editable pane
and history. Editing returns `false` during composition, after disposal or for a missing comment rule.
A long command can yield while planning, then commit once at its captured target.

**Register a command.** `commands.register({ id, label, run, enabled }, { keys: ["Escape"], priority: 10 })`
installs a command and its bindings together. A duplicate ID or conflicting binding throws without
changing the registry. Dispose the registration to remove both. Editor disposal retires the registry.

**Bind a shortcut.** `keymap.bind("Mod+k Mod+i", id)` binds a chord. Use a single stroke for an ordinary
shortcut. `Mod` means Meta on Apple and Ctrl elsewhere. Use `Ctrl`, `Meta`, `Shift` and `Alt` with
`KeyboardEvent.key`, and `Space` or `Plus` for those keys. To bind by position, use a code such as
`Ctrl+Shift+Code:BracketLeft`. A matching logical key takes precedence. Symbols and digits can use
Shift to produce the bound character.

On French AZERTY, Ctrl+: toggles line comments and Ctrl+; requests a quick fix. Bracket shortcuts use
`)` and `^`, bracket jump uses `*`, and Shift distinguishes folding from indentation. AltGr stays
available for text entry. On Apple, Option+Shift on the physical US A key toggles block comments
even if it produces an accented letter. [Keyboard qualification](README.md#support-matrix)

- A chord requires both strokes in the same control, including in a shadow root. It expires after
  1.5 seconds or a focus, selection or revision change. A bound second stroke consumes the key even
  if every command declines.
- Higher `priority` runs first (default 0). If a command is disabled or returns `false`, the next binding runs.
  Equal priorities on a sequence, or a single stroke that conflicts with a chord prefix, throw.
  Shortcuts repeat by default. With `repeat: false`, a handled key consumes repeats until release,
  including when the command closes its control.
- `keymap.unbind(keys)` removes every binding for a sequence. Disposing one registration removes just that
  binding. For a menu hint, read `keymap.getShortcuts(id)` when opening the menu. It returns a frozen
  array of distinct configured spellings, empty for unknown or unbound commands.
- A `shared: true` binding also works from controls inside the editor, including the gutter. Forward
  bubbling keydowns from an external toolbar to the owning pane’s `keymap.handle(event)`. A handled
  shortcut prevents the default action. Ordinary field input and composition stay with the field.
  [Host command example](host-integration.md)

**Tab and indentation.** Tab inserts whitespace to the next stop, replacing a partial single-line
selection. On a whitespace-only line with one caret, it first fills indentation from the preceding
Enter rule. Whole-line indent and outdent move to the adjacent stop. At four-column stops, six spaces
become eight or four. A multiline selection skips blank lines, preserves its starting boundary at
column one and excludes a final line touched only at its start. Indent, outdent, Tab and line comments
include the body of a collapsed row.

**Comments.** Add Line Comment adds a marker even to a commented line. Remove strips one marker and
an optional following space. Toggle removes markers when all selected nonblank lines are commented.
Markers align at the least indentation, moving left to a common column if a tab spans it. Blank lines
in a mixed block keep their whitespace. Separate selections act independently unless they share a line.

Block comments wrap a selection with one padding space at each end, or place a caret between the spaces.
Inside a complete comment, Toggle removes the delimiters and up to one space at each end. Carets in
the same comment remove it once. `allowPair` can veto an inferred opener, for example inside a string.
Explicitly selected wrappers toggle directly. The command takes one undo step.

**Pairs and Enter.** An eligible opener inserts its closer or surrounds the selection. Typing the tracked closer
steps over it once. Backspace or word Backspace between untouched delimiters deletes the pair. The
view tracks pairs through edits and Undo until disposal or a delimiter change. A closer typed after
only spaces or tabs takes the matching opener’s indentation. A mismatch, ambiguity, veto or search
limit leaves indentation intact.

Enter uses the row’s LF or CRLF, the preceding ending at EOF, or LF when neither exists. Its callback
can remove, keep or add one indentation unit and split closing text onto a new line. After leaving a
blank line whose whitespace Enter supplied, the next edit in the view removes that whitespace in the
same undo step. Pairing, comments and cancellable line breaks use edit transforms. Composition and
noncancellable input use literal capture.

Unbinding Tab restores focus traversal. Unbinding Enter suppresses the keystroke. Native line-break
and deletion events have separate handling. A noncancellable deletion must match the captured unit,
direction, revision and selections or the editor reports an input conflict.

**Plan a headless edit.** `planLanguageEdit` takes the buffer, selections, command and resolved
language configuration. Pass a fold index as the fifth argument to treat collapsed blocks as lines.
Character commands insert a typed closer unless `canOvertype(offset)` marks it for skipping.

The first `next()` captures the selections and validates raw ranges for bounds, overlap and order.
The caller can then reuse the range array. Keep the configuration immutable until completion.
`snapshot()` exposes status, phase, counts, result and failure. At `ready`, apply the entire batch at
its captured revision, retaining any `lineMove` markers. Errors record their message and rethrow.
`dispose()` releases the cursor and preserves a completed plan. Reentrant `next()` or `dispose()` throws.

`next(workBudget?)` accepts a safe integer of at least 256 (default 4,096). It checks about every
256 work units. Whitespace reads span up to 4,096 UTF-16 units. Delimiter reads, bulk work and host
callbacks can exceed a slice. `readUnits` includes rereads. `workUnits` counts scans, range and edit
visits, pair checks and `bulkWorkUnits`. Bulk charges estimate normalization, mapping, pair lookup,
freezing, large reads and newline construction.

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

`getDiagnostics()` reports input sizes, event counts, conflicts, queue size and command timings.
Use the document revision to detect a committed change from any pane. Check the input event count
before using `lastInputMs`. Cancelling `beforeinput` can suppress the next `input`.
[Clock definitions](README.md#glossary) · [Visible readiness checks](testing.md#readiness-and-visible-continuity)

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
