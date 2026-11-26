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

The attachment captures the originating view, selection and document revision before sending a
request. Keep the returned choice or preview in the control that uses it. If the user switches
documents or the provider reconnects, a delayed click cannot apply to the replacement.

`lspRangeOffsets` converts raw UTF-16 positions. Character positions past a valid line's end
clamp to that end; nonexistent lines, negative/noninteger positions and reversed wire ranges
are refused. Clamping does not split CRLF. A position inside a surrogate pair retains its UTF-16
meaning. Feature decoders validate a complete result before publication; diagnostics and folding
have the explicit placement/skip behavior described in their contracts.

A `prepare` callback receives the scoped custom-message API. A late callback cannot publish for a
superseded request or retarget it to newer text. Handle rejection and dismiss host controls when
their captures expire.

### Diagnostics

Read `scope.observeDiagnostics(binding)` for the shared immutable `LspDiagnosticState` (`empty`,
`current`, `pending` or `expired`). `decodeLspDiagnostics` checks the URI and document capture on each
push. A versioned push must match the wire version. If the server omits the version, the client can
place the diagnostic but cannot tell when the server analyzed the text. `snapshotRevision` names the
buffer used for placement. The provider version and revision are null.

Ranges on nonexistent lines retain their message and wire range with null offsets and
`placement: "out-of-bounds"`; they have no marker. Malformed structures or metadata reject the
whole batch, including an invalid final item. Fresh batches replace the result; an empty batch
clears it. Invalid or known-stale pushes leave the observable snapshot and its markers untouched.

After a local edit, transaction maps move the markers and mark the diagnostics pending. Fully deleted
ranges disappear. Undo cannot bring them back. The provider version, revision and original wire ranges
stay available. Use `isPlacementCurrent()` to check whether a marker points to the right place
locally. A pending result’s `isCurrent()` is false until fresh analysis arrives. A missing map, close,
URI reuse or reconnect expires the association. Unrelated capability registrations leave placements
alone. Mapping these offsets needs neither a full-text export nor another server request.

Diagnostics can carry an integer or string `code`, `codeDescription`, `tags`, `relatedInformation` and
opaque JSON `data`. The client advertises the `unnecessary` and `deprecated` tags and forwards unknown
integer tags. Open related files only when the host requests them. For a code action, the client
forwards overlapping, placed diagnostics only when their provider version is current. A pending or
unversioned diagnostic cannot supply that context.

Enable `diagnostics` on the attachment to paint pushed diagnostics. Hosts that fetch
diagnostics themselves can map their placed ranges through `diagnosticDecoration` and set a decoration
layer. Both paths color marks by severity, strike through deprecated text and draw a triangle for an
empty range. An omitted severity uses the error color. Snapshot items retain the provider's severity,
source, code and tags. Call an item's `select()` to reveal it. An expired item returns `false`.

`cancel()` clears the marks and pauses observation. `request()` resumes with the latest push.
Pass `{ autoConnect: false }` if the host opens the connection. Render messages as text. Your host
pages the list, checks help links and opens related locations.

### Completion

Use `completion: { list: true }` for a caret-anchored list with keyboard and pointer selection.
To translate it, pass `{ label, status, omitted, loadingDetail }` as `list`. Set
`--st-completion-background` and `--st-completion-selected` to style it.

For a custom list, use `completion: {}` and subscribe to the controller. Position the list at
the snapshot’s `anchor` and hide it when the anchor is null. Bind each row to its captured item.
Keep focus in the editor on pointer down so the row can accept the click.

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

Call `item.select()` to highlight a row. Keep the buttons while the `choices` array is the same.
Move the highlight to `choiceIndex` on arrow keys and rebuild the rows when the list changes. A button bound to
an expired item returns `false` from `accept`. When an incomplete list refreshes, its visible
choices remain usable until the replacement arrives.

**Requesting suggestions.** Ctrl/Cmd+Space or `await completion.request()` requests a list.
A `done` outcome carries the snapshot, including an empty result. Superseded requests return
`stale`, unavailable views or connections return `refused`, and provider errors return `failed`.
Set `automatic: false` for manual requests only. `prepareCompletion` runs after the captured
document synchronizes. Use `canCapture` for host readiness checks.

Typing in a word or entering an advertised trigger character can open the list. Decimal digits
on their own leave it closed unless the provider advertises a matching trigger. Typing or
backspacing within a prefix filters the choices and keeps the selected item when it matches.
Erasing the prefix dismisses the list. Backspacing past the original query requests suggestions
for the shorter word. Undo, unrelated edits, blur or moving the caret dismiss the offer.

The provider controls sorting with `sortText`, case-insensitive prefix matching with `filterText`,
and the initial choice with `preselect`. Manual requests show all candidates unless
`filterManualCompletions` is true. `completionIncomplete` reports the provider’s partial-list
flag. Render details and documentation as text. Unsupported snippets
and items requiring a follow-up command are listed in `omittedCompletions`.

**Accepting a choice.** Enter replaces the provider's replacement range. Tab inserts using
its narrower insert range, preserving any suffix. Without an explicit range, completion uses
the selected text or the word at the caret. Up/Down selects a row. PageUp/PageDown moves by the
visible row count. For custom controls, `getPageSize` supplies the count and defaults to ten. Escape dismisses the list. Home and End return to the source.

Acceptance can wait for item resolution. A `true` return means the controller took the request.
Typing, a selection change or a loss of edit permission cancels queued acceptance. A commit
character typed before resolution enters ordinary text. Once the choice is ready, the character,
completion and additional edits such as an import share one Undo step. Resolution can fill in
details or edits. The primary edit must stay within its captured ranges. Additional edits use
the revision sent for resolution. Changing the item’s label or identity invalidates the reply.

Explicit completion also accepts one single-line selection or several collapsed carets. For
multiple carets each replacement must fit on its line and cover the same text. Additional edits
apply once. An overlap or incompatible caret refuses the batch. Automatic completion works with
one caret or the linked fields of an active snippet.

**Snippets.** Tab and Shift+Tab move between numbered fields, including when the list is open.
Typing or accepting a suggestion updates all occurrences of that field. Alt+Up/Down cycles
field choices. Escape closes suggestions first, then ends the snippet. Tab navigation ends at
the final `$0` caret position. Undo and Redo restore text and selections. Use
`--st-snippet-field-border` for the inactive field outline. Multiline inserts use the insertion
line’s indentation and newline style by default. `insertTextMode: 1` preserves the supplied text.
[Snippet grammar and planning](text-model.md#snippet-planning)

Read `connected`, `pending` and the current `choices` from `completion.getSnapshot()`.
`completion.getDiagnostics()` exposes `lastCompletionBeforeInputMs` for the input
listener and `lastCompletionCommandMs` for a registered completion or snippet command. Both
stop when the handler returns. Provider replies and visible rendering have separate clocks.
[Measurement boundaries](README.md#measuring-an-interaction)

### Hover and documentation

Enable `hover: { popup: true }` on the language attachment. Hold the pointer over source text
for 300 ms or press Ctrl+K Ctrl+I (Cmd+K Cmd+I on macOS) to inspect the caret. The card opens
at the source without moving focus. Keyboard inspection scrolls only far enough to reveal
the caret. Escape dismisses the card. A toolbar can call `hover.request()`.
Pass a popup options object to set `closeHint`, control links or decline a pointer or keyboard
lookup through `beforeInspect`.

For a custom view, enable `hover: {}` and subscribe to the controller. Call `hover.request()`
at the caret or pass a captured `{ revision, offset }` from the [pointer dwell observer](editor.md#pointer-dwell).
Diagnostics appear as they become available. Symbol documentation joins them when the request completes.
`await hover.request()` returns `done` with the combined snapshot, including `empty` when
neither source has content. A replaced or cancelled lookup returns `stale`. An unavailable
view or hidden or invalid position returns `refused`. A provider failure or timeout returns
`failed`. Overlapping diagnostics stay visible. A mapped diagnostic reads “Awaiting recheck”
until fresh analysis arrives.

Render the ready snapshot’s `content` with `mountDocumentation`. Its `diagnostics` array contains
the `from`, `to` and `message` of each diagnostic at the inspected offset, in the order supplied.
Use it to offer Code actions. A point diagnostic matches its exact offset.
The snapshot’s `range` identifies where the same information applies.
For pointer dwell, call `request(point, "reuse")` to track the new position.
Requests for the same pending position in reuse mode share the lookup.
Inside a current provider range, the controller reuses the symbol reply and shows diagnostics
for the latest offset as they arrive. The default `request(point)` refreshes the lookup.
The controller preserves focus and selection. Editing, changing the selection or
fold projection, and replacing the tab expire the result. `cancel()` dismisses it and `dispose()`
releases the controller. For a separate analysis service, pass its observable `diagnostics` and
`diagnosticRevision` snapshot through the `diagnostics` option. The lookup uses the painted revision.

A provider can return Markdown, plaintext or a code block with a language tag. When it omits
a range, the built-in card stays at the inspected position.

Use `mountDocumentation` from `sttropez/browser` to append a `DocumentationView`. `setContent` reuses
an unchanged immutable array. `dispose` removes the view and listeners. The host entries (`sttropez`,
`sttropez/browser`, `sttropez/protocol`) export the headless `DocumentationContent` and
`DocumentationPart` types.

The view renders plaintext, paragraphs, emphasis, strong emphasis, flat ordered and unordered lists,
inline or fenced code and inline links. Code language labels are metadata. The view builds its own
elements and text nodes. It never inserts provider HTML or loads an image or embed. At nesting
depth 16, inline content stays literal. Link destinations longer than 8,192 UTF-16 units before
trimming or unescaping also stay literal.

Links render as buttons. Without `openLink`, clicking does nothing. The view checks `canOpenLink` when
it renders and again on click. Check the destination in your own action too. Replacing the content or
disposing the view disables old buttons. The example accepts only destinations with a registered host
action.

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

Clear the popup when its capture expires. For an overlong Markdown destination, including whitespace
and title, the view shows literal text. Your callback handles any fetching, normalization or opening.
Set `markdownDocumentation: true` to request Markdown for hover and signature help, with no allowed
HTML tags. Otherwise the client requests plaintext. Completion documentation always uses plaintext.

### Signature help

Set `signature: { popup: true }` on the language attachment to show help at the primary caret.
The popup highlights the active parameter and shows its documentation. For translated labels, link
handling or a host-owned overload toolbar, pass `SignaturePopupOptions` in `popup`. Set
`overloadControls: false` to hide the popup's overload buttons.
Await `signature.request()` for a `done` result with the displayed signature or an `empty`
snapshot. A dismissed or superseded request returns `stale`, an unavailable view returns
`refused`, and a provider error or timeout returns `failed`.
Call `request()` or press Ctrl/Cmd+Shift+Space to show parameter help, including in a read-only
view. In a focused editor, an explicit request brings the caret into view. If the caret is
already visible, the page keeps its scroll position. An accepted trigger such as `(` requests
help at the resulting caret, including when the editor supplies the closing parenthesis.
Typing more of the argument can share that request. Moving elsewhere before the first
request goes out discards the trigger.
An intercepted key leaves help closed. Up and Down
cycle through overloads. Escape closes the topmost popup. A higher-priority completion list gets
these keys first.

For a custom view, use `signature: {}`, subscribe to the controller and render `getSnapshot().signature`.
Its label and parameter offsets describe the highlighted text. Use the snapshot's `anchor` to position the popup. While you type
an argument expression such as `item.price` at the same caret, a `pending` snapshot keeps the last
signature at the new position. A comma clears the previous parameter highlight until the provider
identifies the next one. Left, Right, Backspace and Delete also preserve the label within an
argument name or number. Crossing a call boundary or jumping elsewhere clears it while the
provider refreshes. Blur, composition and `cancel()` dismiss help. A host
can move focus to its own field while rendering a signature. Disposing the editor also disposes
the controller. If attachment fails, the host can retry with a live provider on the same editor.

Signature help returns literal labels and documentation plus structured content, UTF-16
parameter offsets, active indices and immutable wire context. String parameter labels must occur
inside the signature label; tuple offsets must fit it. A signature's active parameter overrides
the batch value. Missing or out-of-range nonnegative indices select the first available entry;
zero parameters means no highlighted parameter. Null and empty help yield no useful presentation.

On a provider retrigger, signature help preserves the selected overload for the same document
and provider registration. Starting an explicit request or cancelling clears it.

Render signature and parameter content with the [documentation view](#hover-and-documentation).

### Navigation and target loading

`attachEditorLanguage(editor, provider, { navigation: options })` handles definition links for one mounted
view. Hold Ctrl or Cmd over a symbol to underline it, including when the editor is mounted in a
shadow root. Hover preserves focus, selections and open tabs. Releasing the modifier clears the
underline. A primary click while the modifier is held resolves the target even if the lookup
is pending. A drag starting inside selected text uses the editor’s text transfer.
Editing or remounting the source expires the gesture. Alt+click stays available for multiple carets.

The first attachment for an editor reserves its provider scope at mount. If the provider has
reached its limit, mounting throws and the host can retry after a scope is released. Hover and
explicit lookups use that reserved scope.

Use `options.linkAt(offset)` to handle a document link under the pointer. Return its UTF-16
range and an `open()` action. Ctrl/Cmd hover underlines the whole range, including punctuation.
Releasing the pointer over the same range and revision invokes the action captured on press.
Return `undefined` to use symbol lookup. Keep `linkAt` synchronous and defer opening to the action.

Supply the project with `options.documents`. Moving between symbols with the modifier held keeps
unchanged project files open on the server. A new request on the same controller also reuses
those files and checks the current project list. Dismissing the lookup releases its project files.
The attached source stays bound until the last panel for that editor and provider closes.
A host that opens tabs or shows a chooser handles
`options.onDefinition(offset)` by calling `controller.request("definition", offset)` during the
callback. This reuses the hover reply. F12 and reference commands can call the same controller
at the caret. A completed request returns `done` with the published result, even when it has zero
locations. A cancelled or superseded request returns `stale`. An unavailable view returns
`refused` with reason `unavailable-view`. Use `result.count` to size your list and
`result.locationAt(index)` to read a visible row. An invalid zero-based index yields `undefined`.
Keep each choice in its row's click handler. Its `open(present)` calls the host with the captured
document and range while the choice is current. It returns false after cancellation, replacement,
a change to the captured documents or a provider restart. The host opens the destination.
A result list can open several choices as the caret moves. Set
`resultLifetime: "view"` for a popup tied to the original selection and folds.
Without a callback, the controller publishes the result through `getSnapshot()`
and `subscribe()`. Call `cancel()` to dismiss navigation and `dispose()` to detach it.

A references request includes declarations by default. Pass `false` as the third argument to
`navigation.request("references", offset, false)` to exclude them. A definition hover can
underline the source before opening any target file.

Navigation loads up to four distinct missing URIs at once and returns locations in the provider's
original order. Repeated locations share a load. If the host declines a URI, the lookup fails and
releases the other targets, including any that finish after cancellation.

Navigation accepts Location, Location[] or LocationLink[] for definitions and
Location[] for references; null yields an empty result. Mixed location/link arrays are refused.
Every target URI must resolve to an exact captured buffer/index/resource/document/revision.
Unknown targets reject the whole batch. A LocationLink selection must fit its target range after
position conversion; its optional origin range uses the source capture. Results retain all
validated locations within the host's input limits. The navigation controller pages these locations. The host decides when to reveal one.

Navigation, rename, actions and incoming edits share `LspWorkspaceOptions.resolveTarget(uri,
context)` for missing targets. Wire structure is validated before loading. `LspTargetContext`
identifies navigation/editing, the captured source (null for server edits), source/provider
currentness and cancellation. Return `undefined` to decline. For project files return
`{ document: workspace.document(id) }` after loading the text or buffer. The snapshot must
belong to this workspace and carry the requested URI. For a read-only navigation target, return
`{ text, languageId }`, where `text` is a string or a `TextBuffer`. The workspace retains these
contents in an internal read-only resource while the result or an opened view needs them.

The provider builds the UTF-16 index with the [synchronization budget](language-server.md#limits-and-failures),
checks the resource and its edit permissions, and uses a
wire version only for a matching synchronized document. Either form accepts an optional
`release()` callback for host-owned I/O resources.

Authorize each URI before loading its contents. You can load a definition target without mounting a
view or sending `didOpen`. Reading the file grants no permission to edit it or follow a link. Cancel
the loader with the request and release a late target even if loading finished after cancellation,
replacement, disposal or a provider change. Keep accepted targets until the result or server-edit
decision ends. Recheck the whole batch once loading finishes.

Use `createNavigationHistory(workspace)` to let users retrace jumps across editors.
`history.capture(editor)` saves an origin before a jump or lookup. It returns `undefined` for
a busy, detached or foreign view. Wrap the code that opens a destination in `origin.visit(() => …)`
and return true after the reveal succeeds. A changed source revision expires the visit.
For a pointer jump, pass the clicked UTF-16 offset to `history.capture(editor, offset)`.
A single caret returns to that offset. A selected range or multiple carets retain their places.
Capturing leaves the editor untouched. `origin.viewState` holds the same selections and scroll
position for hosts that reopen a replaced source view.
Reuse the origin for choices
in the same result list to give them one Return point. The history keeps the last 100 origins.
`getSnapshot()` gives the count and `subscribe()` reports count changes.

`history.back(present)` asks the host to present the original `DocumentView`. Return its editor,
`undefined` to skip it, or `"busy"` to keep it for a later attempt. Return skips closed views
and replaced tabs. Edits after a jump move the saved selections and scroll anchors with the source.
Back restores them and reports `"restored"`, `"empty"` or
`"busy"`. Pass `{ focus: true }` as the second argument to focus the editor on return.
Dispose the history with its host. Canonical saves follow the workspace's selection rules.
[Whole-text writes](workspace.md#transactions-and-history)
[Restoring a view after edits](viewport.md#scrolling-and-saved-views)

### Rename and workspace edits

Enable `rename: { popup: true }` on the editor attachment for a rename field in the working pane.
F2 brings the field into view and selects the current symbol’s name. Type a new name and press Enter to
preview the edits. Click Apply rename or press Enter again to apply and return to the editor.
Escape returns to the editor without applying. A toolbar can run
`editor.commands.run("rename.start")`. The preview shows up to 64 edits per page and stays
open while the user scrolls. Changing the source or selection expires the captured target.

Pass `popup: { beforeOpen, onNotice, text }` to coordinate other controls, report a rejected
target in the host UI or translate labels. For a custom interface, use `rename: {}`.
Pass other open project files through `rename.documents`.
`await rename.request(name)` renames the symbol at the caret. Undo from any changed file restores
the whole rename.

To ask for approval, request a preview. Let the dialog page through `preview.readEdits(first, end)`
and enable Apply when `canApply` is true. Keep the preview the user saw while the dialog was open.

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

Here `undefined` means the user dismissed the dialog. On `done`, report the changed files in
`value`. On `stale`, close the old preview. For `refused`, check `reason` (`empty-name`,
`unavailable-view`, `not-writable` or `no-changes`). On `failed`, report `error`. The host sets
name-field limits and the server checks naming rules. Cancel the pending rename if the user
edits the proposed name. [Working host example](../examples/reference/language.ts)

**Workspace text edits.** The client accepts a `changes` map or `documentChanges`. If both are present,
it uses `documentChanges`. Each URI must resolve to a current, captured document. Numeric versions
must match its wire version. An unknown URI, repeated document, invalid range or overlap rejects the
whole batch. Equal-position inserts preserve provider order and inserted text keeps its line endings.

A preview page contains edits with ordinals in `[first, end)` and the total across all files.
An empty range returns the total alone. Notes include bounded excerpts and the full insertion length.
The display cutoff keeps surrogate pairs and CRLF together. The edit retains its original UTF-16
offsets and text.
Rename omits text-identical replacements. Reading an expired preview returns `undefined`.
[Preview limits](#limits)

For a headless approval callback, retain the targets and recheck permission before calling
`applyLspWorkspaceEdit` from `sttropez/kernels`. It accepts the edit origin, optional required
origins, view and history kind (default `"replace"`). It returns the changed snapshots or throws
on refusal. An empty edit creates no Undo entry. Use `readLspEditNotes` to show the same excerpts.

### Code actions and commands

Enable `codeActions` on the attachment. `actions.request()` sends the primary selection and
its overlapping diagnostics to the provider. Supply current snapshots in `documents()` for edits
to other project files. A superseded snapshot returns `stale` before discovery starts.
Set `codeActions: { popup: true }` for an anchored review. Ctrl+. (Cmd+. on macOS) and
`editor.commands.run("quickfix.show")` bring the caret into view and open the list. Arrow keys choose an action.
Enter requests a preview if the first available fix needs resolution. Press Enter on a ready preview to apply it.
While the list is loading, arrows and Enter preserve the source selection. Escape closes the list.
Hover over a disabled choice to see its reason.
Pass the choices returned by `request()` as the command argument to open a diagnostic's
current list without another request.

The popup asks for confirmation by default. Supply `popup.quickApply(choice, preview)` to
apply selected edits on click. Commands always require confirmation. `popup.beforeOpen` can
dismiss competing controls or return false to keep the list closed. `popup.text` supplies labels.
For a custom menu, bind each button to its returned choice so a later edit cannot redirect it.

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

An empty list means the provider found no actions. In this example dismissal returns `undefined`.
`choice.select()` resolves and applies the action. To review it first, call
`choice.select({ review: true })`, display the returned preview’s `readEdits(first, end)`, then
call `await preview.apply()` on approval. Repeated selection of the same pending choice shares one
request. Choosing another supersedes it. Wire replies can add the advertised edit on resolve.
A changed title, command or opaque data invalidates the reply. The client validates the whole
list, including disabled choices. Render titles and reasons as text.

An applied edit creates one Undo step across its files. If the action includes a command,
the initial edit commits first. Use `reviewCommandEdit(request, context, writable)` to approve
each server edit. Disable Apply for unwritable files and close the dialog on `context.onCancel`.
A later failure leaves earlier edits undoable. The result uses the same outcomes as rename.
`canRunCommand` lets the host defer execution while busy. A `command-unavailable` refusal keeps
the preview open.

Build a command menu from `provider.commandNames()` and run the user's choice with
`commands.run(name, args)`. The controller's snapshot lists files changed even
if the acknowledgement is lost. A command that makes no edits preserves any open action preview.
After cancellation, check `provider.getSnapshot().commandRequiresReconnect` before retrying.

For host-authorized commands, `codeActions.commandPolicy` receives the exact command and arguments.
Return a server or local route with a revocable `isCurrent`, or `null` to disable the whole action.
Cancel an open request if host policy changes. [Command permissions, review deadlines and reconnect](language-server.md#commands-and-edit-decisions)

### Document links

Use the attachment's `links` option to discover links in the mounted document. If URI mapping
depends on other documents, return their current snapshots from `documents()`. An outdated
snapshot returns `stale` before the provider is contacted. A request that expires in flight
also returns `stale`. On success, `await links.request()` returns `done` with the list published
to `getSnapshot().links`. An unavailable view returns `refused`, and errors return `failed`.
Each choice carries its range, tooltip, optional target and an `open` action.

Use `attachEditorLanguage(editor, provider, { links: { paint: true } })` to underline links
as the document changes. Panes showing the same document share a scan and refresh after reconnect. Use `setPaint(false)`
to hide the marks, or `setPaint(true)` to resume. `linkAt(offset)` returns the first matching
choice in the current explicit result, then checks the painted ranges. Both use UTF-16
offsets and exclude the end of the range. Pass a choice's `open(visit)` action to your menu
or modifier-click handler. A lazy link resolves on the clicked pane even if a sibling closes.
When opening a tab, keep the visit tied to the click that requested it. Here the host aborts
`intent` when focus leaves, another action starts, or the pane closes.

```ts
import type { DocumentLinkChoice } from "sttropez/browser";

export function openLink(link: DocumentLinkChoice, intent: AbortSignal, visit: (uri: string) => void) {
    return link.open(uri => {
        if (!intent.aborted) visit(uri);
    });
}
```

`open(visit)` resolves a missing target when the provider supports resolution. After `visit(uri)`
returns, the outcome is `done` with that URI. A refusal gives the reason `no-target`, `resolving`
or `unavailable-view`. A provider or presentation error returns `failed` with the error.
The host chooses permitted URIs, their destination and how to return. Read the updated link
from the snapshot for a fresh click.

Caret movement cancels an explicit lookup or pending navigation. The automatic scan and completed list survive caret movement.
An edit or authority change in a captured document, a new request, cancellation or editor
disposal invalidates its actions. An expired action returns `stale`. The controller checks each range and bounds the URI, tooltip and opaque data. A resolved link
may change its target and tooltip. Its range and identity must match the original link.

### Document colors

With `colors: {}` on the attachment, `await language.colors.request()` returns an `Outcome` containing the
captured color choices on success. Call `choice.presentations(rgba)` for the provider's list of formats.
An empty list is a successful reply. Invalid RGBA channels return `refused` with reason `invalid-color`.
A superseded request returns `stale`.

Pass `colors: { picker: true }` to `attachEditorLanguage` to make provider swatches clickable.
Click a swatch to change its color or opacity, choose a provider format and review its edits.
Apply writes the changes together and returns focus to the editor. Escape closes the picker.
Opening it preserves the source selection. For a menu or hover button, keep the mark returned
by `colors.colorAt(offset)` and pass it to `colors.openPicker(mark)` on activation. A choice
from `colors.request()` also works. The call returns false if the mark has expired or the
built-in picker is unavailable. Moving the selection or editing the document expires an open
review. Pass `picker: { text: translate }` to translate control labels.

Use `colors: { swatches: true }` for painted swatches alone.
Views of the same document share one scan. Edits move the painted ranges while fresh colors
are pending. `colorAt(offset)` returns a color only for the current revision. To open a picker
of your own, pass an activation callback as `swatches`. It takes precedence over `picker`. Use `setSwatches(false)`
to hide the marks and `setSwatches(true)` to resume scanning. If a color format request fails,
the current swatches stay available in every pane.

Call a format's `select()` to apply its edits. For a picker with an Apply button, call
`select({ review: true })` and bind the button to the returned review's `apply()`. Both edit
paths return `done` with the changed file, or an empty list when its text already matches.
An expired choice returns `stale`. A read-only or locked target returns `refused("not-writable")`.

Use `review.notes` to display the proposed edits. Each note gives the captured range, nearby text,
the first 256 UTF-16 units of the insertion and its full length in `insertUnits`.
`review.edits` contains the complete replacements used by Apply.

Call `dismissPreview()` when the picker value changes. It cancels the pending presentation
and clears its Apply action. The same color list can preview the new value immediately.
Changing the selected format, source, selection, folds or edit permission invalidates the old
Apply action. Read-only sources allow review. A successful Apply preserves relative carets inside
replaced literals and groups all edits into one Undo. Matching text preserves revision and history.

Color discovery validates every range and requires finite RGBA channels in `[0, 1]`.

The color controller validates complete primary/additional edit plans. A missing primary
edit uses the literal presentation label at the captured color range. An invalid final choice,
overlap or out-of-document edit rejects the batch. Empty choices are unavailable for application.
Labels need not be color literals; the proposed-color input grammar belongs to the host.


### Occurrences

Occurrences can overlap and carry a text, read or write kind. An omitted kind means text.
The editor skips zero-width ranges when painting.

Enable `occurrences: {}` to paint occurrences in the focused pane once the caret settles and
queued input or composition finishes. Use `delayMs` to set the debounce. A single caret can move
inside the same highlighted identifier (up to 4,096 UTF-16 units) without clearing its highlights or
starting another request. The range end is exclusive. An overlapping range, a selection or a move
outside the identifier starts a fresh lookup. Edits, focus loss and provider changes clear the result.
Style the marks with `.st-occurrence-text`, `.st-occurrence-read` and `.st-occurrence-write`.
Use `occurrences.intersect(from, to)` to read the same ranges. Each pane owns its caret and
requests. After disposal you can read the final snapshot. Subscribe to the replacement pane’s
controller when remounting. The host owns the provider connection.

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
