# Language features

Attach a language provider to an editor to show suggestions, inspect symbols and review changes
at the caret. StTropez supplies optional controls for these tasks. The host opens files and
decides which server commands may run. [Connect a provider](language-server.md)

## Use

Set the document’s language ID and URI, then attach the features its provider supports.
This example enables the editor controls and paints pushed diagnostics.

```ts
import { attachEditorLanguage, type TextEditor } from "sttropez/browser";
import type { LspWorkspace } from "sttropez/protocol";

export function attachLanguage(editor: TextEditor, provider: LspWorkspace) {
    return attachEditorLanguage(editor, provider, {
        completion: { list: true },
        diagnostics: {},
        hover: { popup: true },
        signature: { popup: true },
        rename: { popup: true },
        codeActions: { popup: true },
        colors: { picker: true },
    });
}
```

Call `dispose()` when detaching these features. Editor disposal also cancels their requests.
Attachments on the same editor and provider share a document binding and scope until the last
attachment closes. Each pane owns its requests. Hover includes diagnostics from the same
attachment unless you supply another source.

The provider can connect before or after attachment. Its default configuration advertises every
supported request method. Restrict that set with `features`, disable pushed diagnostics with
`diagnostics: false` or enable workspace edits with `workspaceEdits: true`.
[Incoming edits and command approval](language-server.md#commands-and-edit-decisions)

| Feature | Attachment option or folding client | LSP method |
| --- | --- | --- |
| Completion | `completion` | `textDocument/completion` |
| Diagnostics | `diagnostics` | `textDocument/publishDiagnostics` |
| Hover | `hover` | `textDocument/hover` |
| Signature help | `signature` | `textDocument/signatureHelp` |
| Definition / references | `navigation` | `textDocument/definition` / `textDocument/references` |
| Rename | `rename` | `textDocument/rename` |
| Server commands | `commands` | `workspace/executeCommand` |
| Code actions | `codeActions` | `textDocument/codeAction` |
| Document links | `links` | `textDocument/documentLink` |
| Document colors | `colors` | `textDocument/documentColor` and `textDocument/colorPresentation` |
| Occurrences | `occurrences` | `textDocument/documentHighlight` |
| Folding | [Folding client and discovery controller](folding.md#language-server-discovery) | `textDocument/foldingRange` |

The [provider scope](language-server.md#workspace-ownership-and-synchronization) synchronizes
documents. When the host sends custom messages that return diagnostics in LSP format, use
`decodeLspDiagnostics` from `sttropez/kernels` to validate the reply.

## Contract

### Captures and ranges

A request belongs to the view, selection and document revision that started it. Keep each returned
choice or preview in its button’s handler. Replacing the document or reconnecting the provider expires
old actions. Use `getSnapshot()` and `subscribe()` to follow a controller, `cancel()` to dismiss its
request and `dispose()` to detach it.

A request returning `Outcome` reports `done` with its value, `stale` for a superseded request,
`refused` with a reason such as `unavailable-view`, or `failed` with the error. An empty list can be
a successful result. A `prepare` callback can send scoped custom messages before the request.

`lspRangeOffsets` converts UTF-16 positions. Columns beyond a line clamp to its end, before CRLF.
An offset between surrogate halves stays there. Invalid lines, negative or fractional positions,
or a reversed range fail validation. Decoders validate the whole result. Diagnostics and folds
can retain or skip individual ranges as described below.

### Diagnostics

Enable `diagnostics: {}` to paint pushes. Marks use the provider’s severity (error by default),
strike through deprecated text and draw a triangle at empty ranges. Call an item’s `select()`
to reveal it. An expired item returns `false`. `cancel()` pauses painting and `request()` resumes
from the latest push. Use `autoConnect: false` when the host opens the connection. For diagnostics
fetched by the host, use `diagnosticDecoration` in a decoration layer.

`scope.observeDiagnostics(binding)` exposes `LspDiagnosticState`. A versioned push must match
the wire version. An unversioned push has null provider version and revision. Its
`snapshotRevision` identifies the buffer used for placement. A fresh batch replaces the old one,
including an empty batch. A malformed or known-stale push leaves existing marks alone.
A diagnostic on a nonexistent line keeps its message and wire range, with null offsets and
`placement: "out-of-bounds"`.

Local edits map surviving ranges and mark them `pending`. A fully deleted range stays gone through
Undo. `isPlacementCurrent()` checks the local marker. `isCurrent()` requires fresh analysis.
A missing transaction map, close, URI reuse or reconnect expires the result.
Only overlapping, placed diagnostics with a current provider version enter a code-action request.

Items retain severity, source, string or integer `code`, `codeDescription`, integer `tags`
(including unrecognized tags), `relatedInformation` and opaque `data`. Render messages as text.
The host controls list paging, help links and opening related files.

### Completion

`completion: { list: true }` shows suggestions at the caret. Pass `label`, `status`, `omitted` and
`loadingDetail` in the `list` options to translate the popup. Style it with
`--st-completion-background` and `--st-completion-selected`.

For a custom list, enable `completion: {}` and subscribe to the controller. Position it at the
snapshot’s `anchor` and hide it when the anchor is null. Bind each row to the item it displays.

```ts
import type { CompletionSnapshot } from "sttropez/browser";

export function completionButton(list: CompletionSnapshot, index: number) {
    const item = list.completionAt(index);
    if (!item) return;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    button.onpointerdown = event => event.preventDefault();
    button.onclick = () => item.accept("replace");
    return button;
}
```

Reuse the rows while `choices` stays the same. `item.select()` changes the highlight at
`choiceIndex`. An expired item returns `false` from `accept`. An incomplete list’s existing rows
remain usable until its replacement arrives.

**Request and filter.** Ctrl/Cmd+Space or `completion.request()` requests suggestions. Set
`automatic: false` for manual requests only. `canCapture` checks host readiness.
`prepareCompletion` runs after the captured document synchronizes. Typing a word or an advertised
trigger can open the list. A number alone needs a matching trigger. Typing or backspacing in the
prefix filters the list and retains a matching selection. Erasing the prefix dismisses it.
Backspacing past the original query requests the shorter word. Undo, unrelated edits, blur or a
caret move dismiss the offer.

`sortText` sets the order, `filterText` supplies the case-insensitive prefix and `preselect`
chooses the initial item. Manual requests show all candidates unless `filterManualCompletions`
is true. `completionIncomplete` records a partial list. Render details and documentation as
text. `omittedCompletions` lists unsupported snippets and items that require a follow-up command.

**Select and accept.** Up/Down changes the selection. PageUp/PageDown moves by the visible row
count (`getPageSize` for custom lists, ten by default). Escape dismisses suggestions. Home and
End return to the source. Enter uses the provider’s replacement range. Tab uses its insert range,
preserving the suffix. Without a supplied range, the edit covers the selection or word at the caret.

`accept` can return `true` before item resolution finishes. Typing, a selection change or losing edit
permission cancels queued acceptance. A commit character typed while waiting enters as ordinary text.
Once ready, the completion, commit character and additional edits share one Undo. Resolution can
supply details and edits, keeping the original item identity, label and primary range bounds.
Additional edits must match the revision sent for resolution.

Manual completion accepts a single-line selection or multiple collapsed carets. Each caret’s
replacement must cover identical text on its own line. Additional edits apply once. An overlap or
incompatible caret refuses the batch. Automatic completion uses one caret or linked snippet fields.

**Snippets.** Tab and Shift+Tab visit numbered fields even with suggestions open. Edits and
completions update each occurrence of the field. Alt+Up/Down cycles choices. Escape closes
suggestions first, then the snippet. Tab ends at `$0`. Undo and Redo restore text and selections.
`--st-snippet-field-border` styles inactive fields. Multiline inserts follow the insertion line’s
indentation and newline style unless `insertTextMode: 1` preserves the supplied text.
[Snippet grammar](text-model.md#snippet-planning)

`completion.getDiagnostics()` reports `lastCompletionBeforeInputMs` and `lastCompletionCommandMs`.
Both stop at handler return. [Interaction clocks](README.md#measuring-an-interaction)

### Hover and documentation

Enable `hover: { popup: true }`. Dwell over source for 300 ms or press Ctrl+K Ctrl+I
(Cmd+K Cmd+I on macOS) to inspect the caret. Keyboard inspection reveals the caret and preserves
focus and selection. Escape closes the card. Popup options include `closeHint`, link handling
and `beforeInspect` for declining a lookup.

For a custom card, use `hover: {}`. A toolbar can call `hover.request()` at the caret or pass
a captured `{ revision, offset }` from pointer dwell. `request(point)` refreshes the lookup.
`request(point, "reuse")` shares a pending lookup at that point or reuses the symbol inside a
current provider range. Overlapping diagnostics follow the latest offset. A missing provider
range anchors the card at the inspected position. [Pointer dwell](editor.md#pointer-dwell)

The snapshot carries `content`, its `range` and diagnostics in provider order. Each diagnostic
has `from`, `to` and `message`. A point diagnostic matches its exact offset. Diagnostics can
arrive before symbol documentation and remain visible if the lookup fails. Mapped marks read
“Awaiting recheck”. To include another analysis service, supply its observable `diagnostics` and
`diagnosticRevision`. Editing, changing the selection or folds, or replacing the tab expires the
card. Hidden or invalid positions are refused.

`mountDocumentation` renders plaintext, paragraphs, emphasis, flat lists, inline and fenced code,
and links. It builds DOM nodes without inserting provider HTML or loading images or embeds.
Code language tags are metadata. Deep nesting and oversized destinations display literally.
The host entries export `DocumentationContent` and `DocumentationPart`. `setContent` reuses an
unchanged immutable array, and `dispose` removes the view and listeners.

Links render as buttons. Supply `openLink` to handle activation. `canOpenLink` is checked at
render and on click. Check the destination in the host action too. Old buttons expire when
content changes or the view closes.

```ts
import type { DocumentationContent } from "sttropez";
import { mountDocumentation } from "sttropez/browser";

export function createHelpView(
    container: HTMLElement,
    actions: ReadonlyMap<string, () => void>
) {
    const view = mountDocumentation(container, {
        canOpenLink: target => actions.has(target),
        openLink: target => actions.get(target)?.()
    });
    return {
        show: (content: DocumentationContent) => view.setContent(content),
        clear: () => view.setContent([]),
        dispose: () => view.dispose()
    };
}
```

Use `markdownDocumentation: true` to request Markdown for hover and signature help. Otherwise
the client requests plaintext. Completion always uses plaintext.

### Signature help

`signature: { popup: true }` shows the active parameter and its documentation. Press
Ctrl/Cmd+Shift+Space or call `signature.request()`, including in a read-only view. An explicit
request in a focused editor brings the caret into view. A provider trigger such as `(` requests
help at the resulting caret, including after automatic bracket pairing. Typing an argument can
share that lookup. Moving elsewhere before dispatch cancels the trigger.

Up/Down cycles overloads. Escape dismisses the topmost popup. A higher-priority completion list
gets those keys first. Pass `SignaturePopupOptions` to translate labels, handle links or set
`overloadControls: false` for a host-owned toolbar.

For a custom popup, enable `signature: {}`, subscribe to its controller and read `getSnapshot().signature` and `anchor`.
While the provider refreshes, editing or moving within an argument name or number retains the
label. A comma clears the parameter highlight. Crossing a call boundary or jumping elsewhere
clears the old signature. Blur, composition or cancellation dismisses help. A retrigger retains
the selected overload for the same document and registration. A fresh explicit request resets it.

The result includes literal labels, documentation, UTF-16 parameter offsets, active indices and
immutable wire context. A string parameter must occur in the label and tuple offsets must fit.
A signature’s active parameter overrides the batch value. Missing or out-of-range nonnegative
indices select the first available entry. Empty help has no signature and zero parameters have
no highlight. [Rendering documentation](#hover-and-documentation)

### Navigation and target loading

Enable `navigation` on the attachment. Ctrl/Cmd+hover underlines a symbol without changing the
selection or opening a tab. A primary click follows it, even if lookup is pending. Releasing the
modifier clears the underline. Dragging inside a selection starts a text drag. Alt+click
adds a caret. Editing or remounting expires the gesture.

**Following a definition.** In `onDefinition(offset)`, call `navigation.request("definition", offset)`
to reuse the hover reply. F12 can request the definition at the caret. For references, call
`request("references", offset)`. Pass `false` as the third argument to exclude declarations.
To give a document link precedence, return its UTF-16 range and `open()` action from the
synchronous `linkAt(offset)` callback. A click released over the same range and revision invokes
the captured action. Returning `undefined` falls back to symbol lookup.

Supply current project snapshots in `documents`. Successive requests reuse unchanged files on
the server. Dismissing the lookup releases its project files. The source stays bound to the
editor’s shared provider scope. If the scope limit is reached, attachment can be retried after
a scope is released.

**Showing results.** Use `result.count` and `result.locationAt(index)` to render visible rows
in provider order. An invalid index gives `undefined`. Keep the choice in its row and call
`choice.open(present)` to reveal the captured document and range. An expired choice returns
`false`. The list can open several locations as the caret moves. Set `resultLifetime: "view"`
to tie it to the original selection and folds.

Definitions accept `Location`, `Location[]` or `LocationLink[]`. References accept `Location[]`.
A null reply is empty. A mixed list, unknown target or invalid range rejects the whole reply.
A link’s selection must fit its target range, and its optional origin refers to the captured source.

**Loading missing files.** Navigation, rename, code actions and incoming edits use
`LspWorkspaceOptions.resolveTarget(uri, context)`. Authorize the URI before reading it.
`context` identifies the operation, its source (null for server edits), currentness and cancellation.

| Loader result | Use |
| --- | --- |
| `{ document: workspace.document(id) }` | A project file loaded into this workspace with the requested URI. Editing also requires current permissions and a matching version. |
| `{ text, languageId }` | A read-only navigation target. Supply a string or `TextBuffer`. The workspace retains it while a result or opened view needs it. |
| `undefined` | Decline the target. The lookup fails and releases its other targets. |

Navigation loads up to four distinct URIs at once. Repeated locations share a load. The loader
can return `release()` with either result. Honor cancellation, including results that arrive
late. A lookup can read a definition without mounting a view or sending `didOpen`. The client
checks the complete batch against the captured documents after loading.
[Synchronization and index budgets](language-server.md#limits-and-failures)

**Returning from a jump.** Before lookup, save an origin with `createNavigationHistory(workspace)`
and `history.capture(editor)`. Busy, detached and foreign views return `undefined`. For a pointer
jump, pass the clicked offset as a second argument. A single caret returns there, while selected
ranges and multiple carets retain their positions.

Open the destination inside `origin.visit(() => …)` and return true on successful reveal. A change to
the source revision before the visit expires it. Reuse the origin for choices in one list to give
them one Back entry. `origin.viewState` is available to hosts reopening a view. History retains
up to 100 origins and publishes their count.

`history.back(present)` asks the host for the editor showing the original `DocumentView`. Return
`undefined` to skip an entry or `"busy"` to keep it for later. Back skips closed views and replaced
tabs, maps saved selections and scroll anchors through subsequent edits, and reports `"restored"`,
`"empty"` or `"busy"`. Pass `{ focus: true }` to focus the restored editor. Dispose history with
the host. [Selection mapping](workspace.md#selections-across-replacements) · [View restoration](viewport.md#scrolling-and-saved-views)

### Rename and workspace edits

With `rename: { popup: true }`, F2 or `editor.commands.run("rename.start")` opens the name
field and selects the symbol. Enter previews the changes, then Enter or **Apply rename** commits
them. Escape returns to the editor. The preview pages 64 edits at a time and stays open while
scrolling. Editing the source or changing its selection expires the target.

Pass `beforeOpen`, `onNotice` and `text` in the popup options to coordinate controls, report
refusals and translate labels. For a custom UI use `rename: {}`. Supply other open project files
in `rename.documents`. `rename.request(name)` applies directly. One Undo from any changed file
restores the whole rename. To review first, bind Apply to the preview the user saw and enable it
when `canApply` is true.

```ts
import type { RenameController, RenamePreview } from "sttropez/browser";

export async function reviewRename(
    rename: RenameController, name: string, approve: (preview: RenamePreview) => Promise<boolean>
) {
    const result = await rename.request(name, { review: true });
    if (result.status !== "done") return result;
    const preview = result.value;
    if (await approve(preview)) return preview.apply();
    if (rename.getSnapshot().preview === preview) rename.cancel();
    return undefined;
}
```

The example returns `undefined` on dismissal. On `done`, `value` lists changed files. Refusal reasons
include `empty-name`, `unavailable-view`, `not-writable` and `no-changes`. Limit field length in
the host, leave naming rules to the provider and cancel a pending rename when the name changes.
[Reference host](../examples/reference/language.ts)

**Workspace text edits.** `documentChanges` takes precedence over `changes`. Every URI must
resolve to a captured current document, and numeric versions must match its wire version. An
unknown or repeated document, invalid range or overlap rejects the batch. Equal-position inserts
keep provider order and inserted text retains its line endings. Rename omits identical replacements.

`preview.readEdits(first, end)` returns excerpts for `[first, end)` and a total across files.
An empty range reads only the total. Excerpts keep surrogate pairs and CRLF together and report
the full insertion length. Apply uses the complete original text. An expired preview returns
`undefined`. [Preview limits](#limits)

For headless review, use `readLspEditNotes` and `applyLspWorkspaceEdit` from `sttropez/kernels`.
Recheck targets and permissions before applying. Options include origin, required origins, view
and history kind (default `"replace"`). Apply returns changed snapshots or throws on refusal.
An empty edit creates no Undo entry.

### Code actions and commands

`codeActions: { popup: true }` enables Ctrl+. (Cmd+. on macOS) and the `quickfix.show` command.
Both reveal the caret and open the list. Arrows select a fix. Enter previews a fix that needs
resolution, then applies a ready preview. During lookup, arrows and Enter preserve the selection.
If no fix is available, the editor handles those keys normally. Hover over a disabled fix for its
reason. Escape closes the list.

`actions.request()` sends the primary selection and its overlapping current diagnostics. Supply
current project snapshots in `documents()` for cross-file edits. Pass the returned choices to
`editor.commands.run("quickfix.show", choices)` to reuse a diagnostic’s list. `popup.beforeOpen`
can decline to open it and `popup.text` translates labels. `popup.quickApply(choice, preview)`
can approve edits on click. Commands always require confirmation.

```ts
import type { CodeActionChoice, CodeActionController } from "sttropez/browser";

export async function chooseFix(
    actions: CodeActionController,
    choose: (items: readonly CodeActionChoice[]) => Promise<CodeActionChoice | undefined>
) {
    const list = await actions.request();
    if (list.status !== "done") return list;
    const choice = await choose(list.value);
    return choice?.select();
}
```

In a custom menu, bind each row to its returned choice. `choice.select()` resolves and applies
it. To ask for approval, use `select({ review: true })`, show `preview.readEdits(first, end)` and
call `preview.apply()`. Dismissal in the example returns `undefined`. Selecting the same pending
choice shares its request. Choosing another supersedes it. Resolution can add an advertised edit.
Changing the title, command or opaque data invalidates the reply. The client validates every
choice, including disabled ones. Render provider text literally.

An action’s initial edit commits as one Undo across its files, before any command runs.
Use `reviewCommandEdit(request, context, writable)` for each incoming edit. Disable Apply for
unwritable targets and close the dialog on `context.onCancel`. A later failure leaves earlier
edits undoable. `canRunCommand` can defer a command with `command-unavailable` and keep its
preview open.

Populate menus from `provider.commandNames()` and call `commands.run(name, args)`. Its snapshot
records changed files even if acknowledgement fails. A command with no edits preserves an open
action preview. Check `commandRequiresReconnect` after cancellation. For host-authorized actions,
`codeActions.commandPolicy` receives the exact command and arguments. Return a server or local
route with a revocable `isCurrent`, or `null` to disable the action. Cancel open requests on a
policy change. [Command permissions, approval and reconnect](language-server.md#commands-and-edit-decisions)

### Document links

`links.request()` returns choices with a range, tooltip, optional target and `open(visit)`.
Read the list from `getSnapshot().links`. Supply `documents()` for cross-file URI mapping.
A stale project snapshot expires the request before dispatch.

`links: { paint: true }` underlines links. Panes share a scan that refreshes on reconnect.
`setPaint` toggles the marks. `linkAt(offset)` checks the explicit result before painted ranges.
Range ends are exclusive. A lazy link resolves on the clicked pane even if a sibling closes.
Abort `intent` on focus loss, another action or pane closure.

```ts
import type { DocumentLinkChoice } from "sttropez/browser";

export function openLink(link: DocumentLinkChoice, intent: AbortSignal, visit: (uri: string) => void) {
    return link.open(uri => {
        if (!intent.aborted) visit(uri);
    });
}
```

`open(visit)` can resolve a missing target and returns the URI after `visit` succeeds.
Refusal reasons include `no-target`, `resolving` and `unavailable-view`. Check URI permissions
before navigation. Resolution replaces the choice at the same range and list position. For a
persistent list, keep keyboard focus on the row, refresh its label and open its current choice
on the next click. [Reference host](../examples/reference/language.ts)

Caret movement cancels an explicit lookup or pending navigation. The automatic scan and
completed list survive it. Edits or authority changes in a captured file, another request,
cancellation and disposal invalidate its actions.

### Document colors

`colors: { picker: true }` makes swatches clickable. Choose a color, opacity and provider
format, then review its edits. Apply commits them together and returns focus to the editor.
Escape closes the picker. Opening it preserves the source selection. From a menu, pass a mark
from `colorAt(offset)` or a choice from `colors.request()` to `colors.openPicker(mark)`.
An expired mark or unavailable picker returns `false`. Use `picker: { text: translate }`
for labels.

`colors: { swatches: true }` just paints the marks. A `swatches` activation callback opens a
custom picker and takes precedence over `picker`. `setSwatches(false)` hides marks and
`setSwatches(true)` resumes scanning. Panes share a scan. Edits move existing marks until the
provider replies, but `colorAt` only returns current colors. A failed format request preserves
the swatches.

For a custom picker, call `choice.presentations(rgba)` on a choice from `colors.request()`.
RGBA channels must be finite and within `[0, 1]`, or the call returns `refused` with
`invalid-color`. An empty format list is a successful result. Call `dismissPreview()` when the
value changes to cancel the old request and disable its Apply action. The same color choice can
request formats again.

`format.select()` applies directly. For review, call `select({ review: true })`, display
`review.notes` and bind Apply to `review.apply()`. The notes contain bounded excerpts and the
full `insertUnits`. `review.edits` contains the full replacements. Changing format, source,
selection, folds or permissions expires the old approval. A read-only or locked file allows
review and refuses Apply with `not-writable`.

The controller validates the whole batch, including additional edits. Missing primary edits
use the presentation label at the captured color range. Overlap or an out-of-document edit
rejects the batch. Labels can be arbitrary text. Apply preserves relative carets inside
replaced literals and records one Undo. Identical text keeps its revision and history and
returns an empty changes list.

### Occurrences

Enable `occurrences: {}` to paint text, read and write occurrences in the focused pane once
input and composition settle. `delayMs` sets the debounce. A single caret can move inside one
highlighted identifier (up to 4,096 UTF-16 units, end exclusive) without refreshing it.
Overlapping ranges, a selection or leaving the identifier trigger a new lookup. Edits, blur
and provider changes clear the marks.

`occurrences.intersect(from, to)` reads the ranges. An omitted kind means text. The editor skips zero-width ranges when painting. Style marks with `.st-occurrence-text`, `.st-occurrence-read` and
`.st-occurrence-write`. Each pane owns its requests. You can read its final snapshot after
disposal. Subscribe to the new controller on remount.

### Folding

For provider folds, pass the result and its `isCurrent` guard to the view’s discovery controller.
Choose what to discover and collapse in each pane. Expanding a saved reference leaves the working
pane’s folds alone. [Whole-line ranges and provider groups](folding.md#language-server-discovery)

### Limits

Sizes below count UTF-16 units. The client validates the whole list before you page it for display.
Most features rely on the
[session, transport and JSON limits](language-server.md#limits-and-failures) to bound incoming data.

| Feature boundary | Limit or policy |
| --- | --- |
| Diagnostics, completion, locations, workspace edits, actions, occurrences | No extra result-count or aggregate text/edit quota; use session/transport limits and host presentation policy |
| Completion fallback / rebasing | Browser word window: 2,048 units each side; compatible single typing insertion: at most 2,048 units |
| Completion expansion | Captured `maxDocumentUnits`, checked before repeated snippet expansion and for the complete plan; direct capture builders supply this bound |
| Hover | 64 fragments, 8,192 units/value, 128-unit code language label, 16,384 combined display units |
| Documentation links | 8,192-unit raw destination span; inline rendering at depth 16 becomes literal text |
| Signature help | 32 signatures, 64 parameters/signature, 4,096-unit labels, 16,384-unit documentation part, 65,536 aggregate display units |
| Signature advisory context | 131,072 serialized units; trigger character at most 8 units |
| Document links | 1,024 items; 4,096-unit URI/tooltip; 8,192-unit serialized data/item; 16,384-unit captured resolve payload/item; separate 65,536 display and opaque budgets, with data and captured resolve payload both charged to the opaque budget |
| Color discovery | 1,024 items |
| Color presentations | 64 choices; 4,096-unit labels; 32 additional edits/choice; 1,024 total edits; 16,384 units/insertion; 65,536 aggregate label/insertion units |
| Edit previews | The host chooses the page size. Titles use up to 128 units. Excerpts show up to 256 units of removed and inserted text each, plus the full insertion length. |
| Occurrence controller | 150 ms default quiet interval, configurable nonnegative `delayMs`; at most five seconds waiting for queued input |

## Host responsibilities

For custom controls, position the popup, bind actions to the displayed choices and unsubscribe
on detach. Choose which links and server commands the application can open or run.

Keep Save independent of editing and report any earlier edits if a later command fails.
When your host holds an approval dialog open, bind it to the captured preview and close it on cancellation.

## Not covered

Formatting, semantic tokens and completion follow-up commands are outside the
[supported language features](README.md#support-matrix).
