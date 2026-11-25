# Language features

A completion list, hover or rename result belongs to the revision that produced it. Attach the browser
controllers for completion, diagnostics and occurrence highlights. For other results, your host draws the UI, opens
files and decides which edits to apply. [Connect a provider](language-server.md)

## Use

Set the document's language ID and URI before calling `attachEditorLanguage`. A plain-text pane
can use the editor and navigation history on their own. Pass an options object for each language feature you need.
Panels attached to the same editor and provider share one scope and document binding. The last
attachment to close releases both. Hover uses diagnostics from its attachment unless you supply
another source.

```ts
import { attachEditorLanguage, type TextEditor } from "sttropez/browser";
import type { LspWorkspace } from "sttropez/protocol";

export function attachLanguage(editor: TextEditor, provider: LspWorkspace) {
    const language = attachEditorLanguage(editor, provider, { completion: {}, diagnostics: {}, hover: {} });
    return { requestCompletion: language.completion.request, dispose: language.dispose };
}
```

Each feature cancels its own requests. Disposing the attachment or the editor cancels pending work
and releases the binding. Other mounted views keep their requests.

Connect before or after mounting a feature. The client advertises every supported request method by default.
Use `features` to restrict methods,
`diagnostics: false` to disable pushed diagnostics and `workspaceEdits` to enable edit support. Incoming edits and command execution have their own
[connection policy](language-server.md#commands-and-edit-decisions).

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

Keep each completion choice with the row that displays it. Its actions expire when another list replaces it.

```ts
import type { CompletionController } from "sttropez/browser";

export function completionActions(language: CompletionController) {
    const state = language.getSnapshot();
    return state.choices.map((label, index) => {
        const item = state.completionAt(index)!;
        return { label, select: item.select, accept: () => item.accept("replace") };
    });
}
```

Render labels as text. Read the snapshot on change and unsubscribe on detach.
[Attachment and teardown](language-server.md#use)

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
clears it. Invalid or known-stale pushes preserve the preceding valid batch.

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

Enable `completion` on the attachment for suggestions and snippets in that view.
The controller handles input, selection checks and acceptance. The host renders choices and status.
When the shared provider disconnects, completion clears its choices and reports the loss of service.
Local editing stays available. Reconnecting from another feature updates completion in the same view.
`request()` invokes completion. Set `automatic: false` to require explicit requests. Supply
`canCapture` for additional readiness checks. `getDiagnostics()` reports completion counts,
`lastCompletionBeforeInputMs` for the input listener and `lastCompletionCommandMs` for the most
recent registered completion or snippet command. Both clocks stop on return.

`prepareCompletion` receives request-scoped access after the document synchronizes. Cancelling
completion leaves diagnostic updates active. Dispose the attachment, editor and provider separately.

Automatic completion uses the text the editor accepted, including committed composition and advertised trigger characters. It waits for input to settle at the resulting revision and selection. Moving the caret cancels that request, even if you move back before the next frame.
The controller registers `completion.request`, `completion.dismiss`, `completion.previous`,
`completion.next`, `completion.page-previous`, `completion.page-next`, `completion.insert` and
`completion.replace` on the owning editor at shortcut priority 30. Snippet choice commands
(`snippet.choice-previous` and `snippet.choice-next`) also use 30. Placeholder navigation
(`snippet.previous` and `snippet.next`) uses 40 so Tab advances an active snippet first.
Automatic completion follows one caret or the linked carets in a snippet field. Ctrl/Cmd+Space also
works with a single-line selection or multiple collapsed carets. For a selection, the request uses
its higher offset in either direction. Accepting uses the provider's edit range when supplied and
otherwise replaces the selected text. Undo restores the original selection.

`await completion.request()` returns `done` with the list snapshot, including an empty list.
Choosing an item can trigger a separate request for its details. A cancelled or superseded list returns `stale`.
An unavailable view, unsupported selection or disconnected provider returns `refused`.
A provider or preparation error returns `failed`.
Typing decimal digits alone keeps automatic completion closed. Digits in an identifier can
request suggestions, and a provider's advertised trigger character always takes precedence.
Up and Down select one choice. PageUp and PageDown move a page and stop at the first or last choice.
Supply `getPageSize` to report the number of visible rows, or zero while the list is hidden.
The default is ten rows. Home and End dismiss the list and navigate the source.
Enter replaces and Tab inserts. Escape dismisses the list. Outside a snippet, Escape on an
invisible request also reaches the editor. Escape then Tab or Shift+Tab leaves the view.

Inside a snippet, Tab and Shift+Tab move between fields even with the list open. Enter accepts
a suggestion in all mirrors. An import or other disjoint edit applies once in the same undo step.
A suggestion that expands to a template inserts its default text and keeps the outer Tab order.
Escape dismisses a field's suggestions first. With no request or list, Escape ends the snippet.
Other editable fields have a dotted outline,
including a small marker for an empty field. The final caret stop has no marker. Set
`--st-snippet-field-border` to change the outline color.

Position a completion list with the snapshot's `anchor`. It spans the selected item's edit prefix
up to the caret at that revision and is `null` when the list is empty.
Read `completionAt(index)` from the snapshot that supplied the labels. Only rendered choices
need handles. `select()` and `accept(mode)` act on that item. Filtering the list expires its
handles. Diagnostics, selection and detail updates retain the same `choices` array.

Completion accepts arrays, CompletionList or null, including defaults for edit ranges,
insertion format/mode, commit characters and opaque data. It checks the primary and additional
same-document edits. A server-supplied range overrides the browser’s bounded Unicode word range.
Choices sort stably by `sortText` and filter by case-insensitive `filterText` prefix. If the prior
choice disappears, `preselect` applies. Manual requests initially show all choices. Set
`filterManualCompletions: true` to filter them by the captured prefix too.

`rebaseLspCompletion` maps an item across a single typing insertion or backward deletion inside
its primary insert range. Core supplies the exact edit. With automatic completion enabled, Backspace
refilters an open list and keeps the selected item when it matches the shorter word. Erasing the word
prefix dismisses the list. Deleting past the provider's original request position with a word prefix
remaining requests fresh choices. The browser requires matching selections, fold
generation, authority, URI, binding and language configuration. Mapped primary/additional ranges
are validated again.
Undo, replacements, host edits, unknown/composed changes or incompatible navigation expire the
offer. When the editor input loses focus, it dismisses the list and cancels pending completion work.
Keep focus in the editor on pointer-down in a suggestion so its click can accept the item.
Incomplete lists retrigger with context kind 3 while compatible choices stay visible.
`completionIncomplete` preserves provider partial-list status independently of client filtering.

When the provider advertises resolution, the selected item can resolve `detail`, `documentation`,
`additionalTextEdits`, `insertText` and `textEdit`. Resolution requires the exact
captured snapshot and preserves label, filtering/sorting fields, format and opaque identity.
Primary content may change only within the captured insertion/replacement ranges. Additional
ranges belong to the resolve request's snapshot. Failed or malformed resolution dismisses the
offer. Completion documentation is literal text.

Use `item.accept(mode)` when the user chooses an item that may be resolving. A `true`
return means the controller accepted the request. Typing, selection changes, blur, cancellation or lost permission
clears queued acceptance. If the editor is busy or the host declines the capture when a resolve
reply arrives, the list closes. The user can request completions again once the editor is ready.
Typing an advertised commit character while the item is unresolved inserts
the character normally and closes the list. Once ready, the item and its commit character form one
transaction. If the provider also advertises the character as a completion trigger, automatic
completion requests the next list at the resulting caret. Commit characters must be one UTF-16 unit.

`lspCompletionPlan(item, mode, commitCharacter?, capturedSelections?)` returns edits and the resulting
`selectionSet`. For multiple carets, each selection must be collapsed and ordered. The primary must
match the captured offset. Each mapped replacement must fit its caret’s line and cover the same text
as the primary. Insertions use local line context, and additional edits apply once. Overlap or one
incompatible caret rejects the batch. Request completion explicitly for multiple carets. Automatic
completion and rebasing need one. A rejected acceptance consumes the key, so Enter or Tab cannot
insert a newline or indent.

Primary and additional edits share one undo step. Edits before the primary insertion shift its final
caret. A zero-width edit on a replacement boundary goes first. Two insertions at the same offset or
intersecting replacements invalidate the completion. Other views’ selections follow the edit.

Completion uses the [snippet grammar and planners](text-model.md#snippet-planning). Unsupported
snippet choices and choices requiring a follow-up command are omitted individually, with reasons
in `omittedCompletions` (`omitted` in the pure decoder). Their edits and command data are validated
first, so malformed data cannot hide behind an omission. Lazy unsupported snippets report
`UnsupportedLspSnippetError`. Completion acceptance never executes a command.

`insertTextMode: 1` preserves supplied text; mode 2 adjusts subsequent lines to the insertion
line's indentation and newline convention. Mode 2 is the default. Decoder indentation defaults
to tab size 4 and spaces; the browser captures the editor's `settings().language`. Additional
edits keep their supplied text. Resolution, rebasing and commit characters rebuild from raw
provider text, so indentation is applied once. A configuration change expires pending acceptance.

Snippet acceptance selects every occurrence of the first numbered field. Typing, deletion, paste
and composition commit use the existing input/history paths to mirror fields. Tab/Shift+Tab
traverse fields; Alt+Up/Down cycles choices. The current field exposes `move(direction)`, `choose(index)` and
`finish()`. An expired field rejects all three actions. Escape ends the session while keeping text and the primary selection; `$0` ends it
at the final carets. Focus loss, selections outside the field, changed authority, external edits,
undo or redo end the session. Undo/redo restore text/selections without recreating it. Ready
commit-character acceptance inserts expanded text plus the character without starting a session.

### Hover and documentation

Enable `hover: {}` on the language attachment. Call `hover.request()` to inspect the caret or pass a
captured `{ revision, offset }` from the [pointer dwell observer](editor.md#pointer-dwell). It shows diagnostics at that offset as soon as
they are available. Symbol documentation joins them when the hover request completes.
`await hover.request()` returns `done` with the combined snapshot, including `empty` when
neither source has content. A replaced or cancelled lookup returns `stale`. An unavailable
view or hidden or invalid position returns `refused`. A provider failure or timeout returns
`failed`. Overlapping diagnostics stay visible. A mapped diagnostic reads “Awaiting recheck”
until fresh analysis arrives.

Subscribe to the controller and render the ready snapshot’s `content` with `mountDocumentation`.
The snapshot’s `range` identifies where the same information applies. A point diagnostic matches
its exact offset. For pointer dwell, call `request(point, "reuse")` to track the new position.
Requests for the same pending position in reuse mode share the lookup.
Inside a current provider range, the controller reuses the symbol reply and shows diagnostics
for the latest offset as they arrive. The default `request(point)` refreshes the lookup.
The controller preserves focus and selection. Editing, changing the selection or
fold projection, and replacing the tab expire the result. `cancel()` dismisses it and `dispose()`
releases the controller. For a separate analysis service, pass its observable `diagnostics` and
`diagnosticRevision` snapshot through the `diagnostics` option. The lookup uses the painted revision.

A provider can return Markdown, plaintext or a code block with a language tag. The host
places the hover card, including when the reply omits a range.

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

Enable `signature: {}` on the language attachment. Its `signature` controller follows the primary caret.
Await `signature.request()` for a `done` result with the displayed signature or an `empty`
snapshot. A dismissed or superseded request returns `stale`, an unavailable view returns
`refused`, and a provider error or timeout returns `failed`.
Call `request()` or press Ctrl/Cmd+Shift+Space to show parameter help, including in a read-only
view. In a focused editor, an explicit request brings the caret into view. If the caret is
already visible, the page keeps its scroll position. An accepted trigger such as `(` requests
help at the resulting caret, including when the editor supplies the closing parenthesis.
An intercepted key leaves help closed. Up and Down
cycle through overloads. Escape closes the topmost popup. A higher-priority completion list gets
these keys first.

Subscribe to the controller and render `getSnapshot().signature`. Its label and parameter offsets
describe the highlighted text. Use the snapshot's `anchor` to position the popup. While you type
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

In the examples, Up and Down cycle through overloads while signature help is visible. An open
completion list takes those keys first. Escape dismisses one visible popup per press and keeps
the caret in the editor.

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
Dispose the history with its host.
[Restoring a view after edits](viewport.md#scrolling-and-saved-views)

### Rename and workspace edits

Enable `rename` on the editor attachment. Supply a `documents` callback for other open files
that the provider can rename. `await language.rename.request(name)` applies the edit at the
captured caret. On success, `value` lists the changed documents. Undo from any one of those
documents restores the whole rename.

Pass `{ review: true }` to inspect the rename first. Use `preview.readEdits(first, end)` to read
the notes in that half-open range and the total number of changed edits. Replacements that
already match the source are omitted. Bind Apply to the captured preview and call
`rename.cancel()` when the user changes the name or dismisses the request.

```ts
import type { RenameController } from "sttropez/browser";

export async function renameButton(rename: RenameController, name: string) {
    const result = await rename.request(name, { review: true });
    if (result.status !== "done") return;
    const preview = result.value;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Apply rename";
    button.disabled = !preview.canApply;
    button.onclick = () => preview.apply();
    return button;
}
```

Direct rename and a preview's synchronous `apply()` check every original target. Both return
`done` with the changed files, `stale` for an expired capture, or `failed` with the error.
A `refused` result gives the reason `not-writable` for a locked or read-only target and
`no-changes` for an empty or text-identical edit. A request can also refuse `empty-name` or
`unavailable-view`. Once a preview expires, `readEdits(first, end)` returns `undefined`.

The server checks language naming rules. The host sets the name field’s input limits.

Workspace edits accept `changes` maps and versioned `documentChanges` text edits.
When both are supplied, `documentChanges` takes precedence. Numeric versions must match captured
wire versions; absent/null versions require current captured buffers too. Unknown URIs, repeated
document identities, invalid ranges, overlap or malformed final entries refuse the entire batch.
Edits sort stably in original coordinates, preserving provider order for equal-position inserts.
No newline normalization is performed. There are no extra decoder quotas on document/edit counts
or inserted text; session/transport bounds and direct-call input policy apply.

Use `readLspEditNotes(edit, titleForDocumentId, first, end)` to read `notes` in provider order.
The bounds are zero-based edit ordinals. Each note contains a bounded excerpt and the full
insertion length. `total` counts edits across all files. An empty range reads no excerpts.
The host chooses its page size and asks for approval of the full edit.

`applyLspWorkspaceEdit(workspace, edit, options)` rechecks captures and applies one atomic shared
history transaction. `origin` is required; `requiredOrigins` adds host permission requirements;
`view` carries the originating view; `historyKind` defaults to `"replace"`. The helper returns
only changed document snapshots and throws on refusal. An empty or text-identical batch adds no
revision/history entry. It owns no leases, selection/lifecycle capture or approval controls.
When applying an edit directly, retain its documents and recheck host approval before confirmation.
The browser controller owns these lifetimes for a mounted editor.

### Code actions and commands

Enable `codeActions` on the attachment to request actions for the editor’s primary
selection. The origin document is always included. Supply `documents` to include other project files.
`await actions.request()` returns `done` with the same choices as `getSnapshot().choices`.
An empty list means the provider found no actions. Cancellation, supersession and a changed
capture return `stale`. An unavailable view returns `refused` with reason `unavailable-view`.
A provider error or timeout returns `failed` with the error.
Call `await choice.select()` to resolve and apply the action. The result contains the changed
documents. An edit-only action has one Undo step across its files. Pass `{ review: true }` to
receive a preview with `readEdits(first, end)` and `apply()`. Read an empty range for the total alone.
Choosing another action retires the pending choice. Repeated selections of the same pending
action share its provider request. Only the latest selection can apply or return a preview.

```ts
import { attachEditorLanguage, type TextEditor } from "sttropez/browser";
import type { LspWorkspace } from "sttropez/protocol";

export function attachFixes(editor: TextEditor, provider: LspWorkspace) {
    const { codeActions: actions, dispose } = attachEditorLanguage(editor, provider, { codeActions: {} });
    const stop = actions.subscribe(() => {
        const { choices, preview } = actions.getSnapshot();
        // Bind each button to this choice or preview, including across a later render.
        renderFixes(choices.map(choice => ({ title: choice.title, select: () => choice.select({ review: true }) })),
            preview?.readEdits(0, 0)?.total ?? 0, preview?.canApply ? preview.apply : undefined);
    });
    return { request: actions.request, dispose() { stop(); dispose(); } };
}

declare function renderFixes(choices: { title: string; select(): void }[], edits: number, confirm?: () => void): void;
```

A change to the captured selection, fold projection, document revision or edit authority expires
the preview. Choices and Apply buttons also expire when their editor is replaced.
Approve incoming server edits with `reviewCommandEdit(request, context, writable)`.
Use `writable` to disable Apply when a file is locked or read-only.
For a dialog, use `context.onCancel` to close it when the request expires. The attachment applies
the action’s initial edit before sending the command. It validates each approved edit against the
originating view and captured documents. Each changed batch has one Undo step across its files.

`await preview.apply()` returns `done` with a list of `ChangedDocument` values, `stale` if the view or request
expired, `refused` for a denied action or edit, or `failed` for an error. Earlier edits stay undoable
if a later step fails. Use `canRunCommand` to withhold execution while another host operation is
active. A busy command returns `refused("command-unavailable")` and leaves the preview available.

`commands.run(name, args)` runs an advertised command on a connected provider. Supply
`commands.documents` for additional project files and `commands.reviewCommandEdit` to approve
edits. The command keeps its originating view through approval and returns the same outcomes as
`preview.apply()`. Its snapshot lists the files changed by the running or last command, including
edits committed before a lost acknowledgement. A command that makes no edits preserves an open
action preview. After cancellation, check `provider.getSnapshot().commandRequiresReconnect`
before offering another command.

Action requests include the selected range and overlapping diagnostics for the captured revision.
The provider can resolve a choice after the user selects it.

The code-action controller accepts a complete array or null, including CodeAction and Command literals,
disabled reasons, preferred flags, open kind strings, workspace edits and opaque data. Titles and
reasons are literal text. Disabled choices also undergo full metadata/target validation. Malformed
final items and partial-list envelopes reject the batch. An unresolved choice without an edit or
command can resolve when matching provider options advertise `resolveProvider`.

Resolving an action accepts only the advertised addition of `edit`. All other attributes and
data must match, irrespective of JSON key order. A changed title, new command, missing edit or stale
capture rejects the reply. Browsing and resolving actions leave the files untouched.

By default command support requires static/dynamic advertisement. `codeActions.commandPolicy`
can authorize an exact immutable invocation, including arguments, and return a server route, local
host route or null. This example permits only the host-selected command with no arguments:

```ts
import type { LspCommandPolicy } from "sttropez/protocol";

export function commandPolicy(
    allowedCommand: string,
    isAuthorized: () => boolean
): LspCommandPolicy {
    return invocation => {
        if (!isAuthorized() || invocation.command !== allowedCommand
            || invocation.arguments.length !== 0) return null;
        return { kind: "server", isCurrent: isAuthorized };
    };
}
```

The policy receives the command and its arguments. A route’s `isCurrent` can revoke it. If
host policy changes during a request, call `codeActions.cancel()`. Denying a command disables
the entire choice, including its initial edit. Earlier approved batches remain undoable if a
later batch fails. [Command permissions and reconnect](language-server.md#commands-and-edit-decisions)

An incoming edit request checks the optional literal label and every text edit. Return an
`LspApplyEditResult` for each decision. To decline, return `applied: false` and an optional failure
reason. Cancellation uses the usual request path. Set a review deadline. If the connection closes
after commit, report the uncertain delivery and leave the edit in history.

### Document links

Use the attachment's `links` option to discover links in the mounted document. Pass a `documents`
callback for any project documents whose revision or edit permissions affect your URI mapping.
`await links.request()` returns `done` with the list published to `getSnapshot().links`,
`stale` if the request expires, `refused` for an unavailable view, or `failed` with the error.
Each choice carries its range, tooltip, optional target and an `open` action.

Use `attachEditorLanguage(editor, provider, { links: { paint: true } })` to underline links
as the document changes. Panes showing the same document share a scan and refresh after reconnect. Use `setPaint(false)`
to hide the marks, or `setPaint(true)` to resume. `linkAt(offset)` returns the first matching
choice in the current explicit result, then checks the painted ranges. Both use UTF-16
offsets and exclude the end of the range. Pass a choice's `open(visit)` action to your menu
or modifier-click handler. A lazy link resolves on the clicked pane even if a sibling closes.

```ts
import type { DocumentLinkChoice } from "sttropez/browser";

export function linkButton(link: DocumentLinkChoice, visit: (uri: string) => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = link.tooltip || link.target || "Open link";
    button.disabled = link.target === null && !link.canResolve;
    button.onclick = () => link.open(visit);
    return button;
}
```

`open(visit)` resolves a missing target when the provider supports resolution. After `visit(uri)`
returns, the outcome is `done` with that URI. A refusal gives the reason `no-target`, `resolving`
or `unavailable-view`. A provider or presentation error returns `failed` with the error.
The host decides which URIs to open, where to show them and how to return. If the user clicks elsewhere during resolution, keep focus there. Read the updated
link from the snapshot for a fresh click.

Caret movement cancels an explicit lookup or pending navigation. The automatic scan and completed list survive caret movement.
An edit or authority change in a captured document, a new request, cancellation or editor
disposal invalidates its actions. An expired action returns `stale`. The controller checks each range and bounds the URI, tooltip and opaque data. A resolved link
may change its target and tooltip. Its range and identity must match the original link.

### Document colors

With `colors: {}` on the attachment, `await language.colors.request()` returns an `Outcome` containing the
captured color choices on success. Call `choice.presentations(rgba)` for the provider's list of formats.
An empty list is a successful reply. Invalid RGBA channels return `refused` with reason `invalid-color`.
A superseded request returns `stale`.

Pass `colors: { swatches: true }` to `attachEditorLanguage` to paint provider colors automatically.
Views of the same document share one scan. Edits move the painted ranges while fresh colors
are pending. `colorAt(offset)` returns a color only for the current revision. To open a picker
without moving the caret, pass an activation callback as `swatches`. Use `setSwatches(false)`
to hide the marks and `setSwatches(true)` to resume scanning.

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
requests. The host owns the provider connection.

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
| Edit previews | 64 edits/page; 128-unit titles; 256 units of deletion/insertion text, with full insertion size; deletion context bounded independently of deletion length |
| Occurrence controller | 150 ms default quiet interval, configurable nonnegative `delayMs`; at most five seconds waiting for queued input |

## Host responsibilities

Choose shortcuts, popup placement, Return behavior and allowed links. Page long lists so the user can
reach every result. Release controls, clients and subscriptions on detach.

Keep Save independent of editing and report any earlier edits if a later command fails.
When your host holds an approval dialog open, bind it to the captured preview and close it on cancellation.

## Not covered

Formatting, semantic tokens and completion follow-up commands are outside the
[supported language features](README.md#support-matrix).
