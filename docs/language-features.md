# Language features

A completion list, hover or rename result belongs to the revision that produced it. Attach the browser
controllers for completion, diagnostics and occurrence highlights. For other results, your host draws the UI, opens
files and decides which edits to apply. [Connect a provider](language-server.md)

## Use

Connect before or after mounting a feature. Use `features` to restrict request methods,
`diagnostics: false` to disable pushed diagnostics and `workspaceEdits` to enable edit support. Incoming edits and command execution have their own
[connection policy](language-server.md#commands-and-edit-decisions).

| Feature | Client or controller | Enabled method |
| --- | --- | --- |
| Completion | `createLspCompletionClient`; browser `createCompletionController` | `textDocument/completion` |
| Diagnostics | `createDiagnosticController` | `textDocument/publishDiagnostics` |
| Hover | `createHoverController`, `createLspHoverClient` | `textDocument/hover` |
| Signature help | `createSignatureController`, `createLspSignatureClient` | `textDocument/signatureHelp` |
| Definition / references | `createLspNavigationClient` | `textDocument/definition` / `textDocument/references` |
| Rename | `createRenameController`, `createLspRenameClient` | `textDocument/rename` |
| Code actions | `createCodeActionController`, `createLspActionClient` | `textDocument/codeAction` |
| Document links | `createDocumentLinkController`, `createLspLinkClient` | `textDocument/documentLink` |
| Document colors | `createDocumentColorController`, `createLspColorClient` | `textDocument/documentColor` and `textDocument/colorPresentation` |
| Occurrences | `createLspHighlightClient`; browser `createLspHighlightController` | `textDocument/documentHighlight` |
| Folding | [Folding client and discovery controller](folding.md#language-server-discovery) | `textDocument/foldingRange` |

Import the headless client and its type from `sttropez/protocol`, for example
`createLspHoverClient` and `LspHoverClient`. Pass the source snapshot to `run({ document, ... })`.
Offsets are UTF-16 code units in that snapshot. Navigation, rename and code actions also accept a
`project` array containing the same source revision. Omitting it captures the source alone.
An optional `prepare` callback runs after synchronization and before dispatch.
Clients decode their own replies. For custom messages with standard LSP payloads, import the matching decoder, such as `decodeLspDiagnostics`, from `sttropez/kernels`.

Read `call.result` for the decoded reply. `call.cancel()` stops a pending request, including target
loading. After settlement it leaves the reply available. A new request or `client.cancel()` expires
the previous intent and its follow-ups. Use separate clients for concurrent intents and dispose
each client when its owner closes.
The [provider scope](language-server.md#workspace-ownership-and-synchronization) synchronizes files.
Your host tracks view, focus and edit permission.

Headless clients expose `getSnapshot`, `subscribe`, `snapshot`, `isBusy`, `options`, `cancel` and
`dispose`. Read `getSnapshot()` for the scope’s connection state. To update a busy indicator,
subscribe and read `isBusy()`. It covers pending requests and follow-ups, including confirmed actions.
A request on unchanged text sends a notification. The start notification is queued, so
connection changes or cancellation in the same turn can share it.

`options(document)` reads [capabilities](language-server.md#feature-capability-queries) for the
primary method. Navigation accepts `textDocument/definition` (default) or `textDocument/references`.
Colors accept `textDocument/documentColor` (default) or `textDocument/colorPresentation`. Other
methods throw. After disposal, queries and new subscriptions throw. Repeated `dispose()` is safe.

Capture the completion list ID when rendering an item. A delayed click will then expire if another
list replaces it.

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

Check `isCurrent` before showing or using a result. Its `LspDocumentCapture` identifies the URI,
resource, document, revision, sent buffer and index, wire version, connection epoch and registration
generation. Wire versions give send order. Capture the host view, selections and permissions
separately.

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

Use `createDiagnosticController(editor, provider)` to paint diagnostics. The controller underlines
ranges and marks empty ranges at their offset. Read `diagnostics`, `diagnosticsPending`,
`diagnosticRevision` and `unversionedDiagnostics` from its snapshot. Each placed diagnostic has a
`select()` method that reveals its range. An expired item returns `false`.

`cancel()` clears the marks and pauses observation. `request()` resumes with the latest push.
Pass `{ autoConnect: false }` if the host opens the connection. Render messages as text. Your host
pages the list, checks help links and opens related locations.

### Completion

`createLspCompletionClient(provider)` owns headless completion requests, decoding, resolution
and retained choice batches. `run({ document, offset })` resolves through `call.result`
to an immutable `LspCompletionBatch` with `items`, `omitted`, `incomplete`,
the local `document`/`offset`, and separate `isCurrent()` and `isBindingCurrent()` guards.
Items use stable `sortText` order. Options capture indentation, a lazy fallback edit range and
trigger context. `snapshot().received` counts completion-list replies admitted for decoding,
including malformed lists; resolve replies use their separate operation.

Call `resolve(batch, item, prepare?)` with an item from this client’s current batch. The cancellable
operation returns a new `batch`, the resolved `item` and `reason: null`. If a lazy snippet uses
unsupported syntax, the new batch lists the omission and returns `item: null` with a reason. Other
decoding failures reject. When the new batch arrives, retire controls for the old one. Resolving the
item leaves the document untouched.

`rebase(batch, document)` keeps choices only if the current Core change proves one human typing
insertion inside every choice’s primary range. Call it during document notifications without rebinding
or synchronizing. Unknown changes, host edits, skipped revisions and an expired binding return no
batch. Resolving a rebased choice synchronizes the new revision before sending the original wire item.
Your host decides which characters count as a prefix and checks the originating view.

Pass `retain: batch` to `run` to keep its choices while a new list is pending. Cancelling that call
keeps the choices. A new reply replaces them. Client `cancel()` expires all choices. Changing the
binding, URI, registration or connection, or disposing the client, cannot revive them. Diagnostics
use a separate scope.

Read completion labels without mounting a view:

```ts
import { createLspCompletionClient } from "sttropez/protocol";
import type { LspWorkspace } from "sttropez/protocol";
import type { DocumentSnapshot } from "sttropez";

export async function completionLabels(
    provider: LspWorkspace,
    document: DocumentSnapshot,
    offset: number
) {
    const client = createLspCompletionClient(provider);
    try {
        const batch = await client.run({ document, offset }).result;
        return batch.isCurrent() ? batch.items.map(item => item.label) : [];
    } finally {
        client.dispose();
    }
}
```

`createCompletionController(editor, provider, options?)` attaches completion and snippets to one view.
The controller handles input, selection checks and acceptance. The host renders choices and status.
`request()` invokes completion. Set `automatic: false` to require explicit requests. Supply
`canCapture` for additional readiness checks. `getDiagnostics()` reports completion counts,
`lastCompletionBeforeInputMs` for the input listener and `lastCompletionCommandMs` for the most
recent registered completion or snippet command. Both clocks stop on return.

Completion and diagnostics share one binding and lease but have separate scopes. `prepareCompletion`
receives the completion scope after synchronization. Cancellation skips pending preparation or
discards a late result. Dispose the attachment, editor and provider separately.

Automatic completion uses the text the editor accepted, including committed composition and advertised trigger characters. It waits for input to settle at the resulting revision and selection. Moving the caret cancels that request, even if you move back before the next frame.
The controller registers `completion.request`, `completion.dismiss`, `completion.previous`,
`completion.next`, `completion.page-previous`, `completion.page-next`, `completion.insert` and
`completion.replace` on the owning editor at shortcut priority 30. Snippet choice commands
(`snippet.choice-previous` and `snippet.choice-next`) also use 30. Placeholder navigation
(`snippet.previous` and `snippet.next`) uses 40 so Tab advances an active snippet first.
Escape cancels an invisible request and lets the next binding or focus traversal handle the key.
It needs one collapsed caret and no composition. Press Ctrl/Cmd+Space to request suggestions yourself.
Up and Down select one choice. PageUp and PageDown move a page and stop at the first or last choice.
Supply `getPageSize` to report the number of visible rows, or zero while the list is hidden.
The default is ten rows. Home and End dismiss the list and navigate the source.
Enter replaces, Tab inserts and Escape dismisses the choices or active snippet. When
neither is visible, Escape cancels pending requests and reaches the editor. Escape then Tab or
Shift+Tab leaves the view.

During a snippet, Tab selects the next field. Other editable fields have a dotted outline,
including a small marker for an empty field. The final caret stop has no marker. Set
`--st-snippet-field-border` to change the outline color.

Position a completion list with the snapshot's `anchor`. It spans the selected item's edit prefix
up to the caret at that revision and is `null` when the list is empty.
Read `completionAt(index)` from the snapshot that supplied the labels. Only rendered choices
need handles. `select()` and `accept(mode)` act on that item. Filtering the list expires its
handles. Diagnostics, selection and detail updates retain the same `choices` array.

`decodeLspCompletions` accepts arrays, CompletionList or null, including defaults for edit ranges,
insertion format/mode, commit characters and opaque data. It checks the primary and additional
same-document edits. A server-supplied range overrides the browser’s bounded Unicode word range.
Choices sort stably by `sortText` and filter by case-insensitive `filterText` prefix. If the prior
choice disappears, `preselect` applies. Manual requests initially show all choices. Set
`filterManualCompletions: true` to filter them by the captured prefix too.

`rebaseLspCompletion` maps an item across a single typing insertion or backward deletion inside
its primary insert range. Core supplies the exact edit. With automatic completion enabled, Backspace
refilters an open list and keeps the selected item when it matches the shorter word. Deleting past the caret
where the provider returned the list requests fresh choices. The browser requires matching selections, fold
generation, authority, URI, binding and language configuration. Mapped primary/additional ranges
are validated again.
Undo, replacements, host edits, unknown/composed changes or incompatible navigation expire the
offer. When the editor input loses focus, it dismisses the list and cancels pending completion work.
Keep focus in the editor on pointer-down in a suggestion so its click can accept the item.
Incomplete lists retrigger with context kind 3 while compatible choices stay visible.
`completionIncomplete` preserves provider partial-list status independently of client filtering.

When the provider advertises resolution, the selected item can resolve `detail`, `documentation`,
`additionalTextEdits`, `insertText` and `textEdit`. `decodeLspResolvedCompletion` requires the exact
captured snapshot and preserves label, filtering/sorting fields, format and opaque identity.
Primary content may change only within the captured insertion/replacement ranges. Additional
ranges belong to the resolve request's snapshot. Failed or malformed resolution dismisses the
offer. Completion documentation is literal text.

Use `item.accept(mode)` when the user chooses an item that may be resolving. A `true`
return means the controller accepted the request. Typing, selection changes, blur, cancellation or lost permission
clears queued acceptance. Typing an advertised commit character while the item is unresolved inserts
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

`createHoverController(editor, provider)` inspects the caret with `request()` or accepts a
captured `{ revision, offset }` from the [pointer dwell observer](editor.md#pointer-dwell). It shows diagnostics at that offset as soon as
they are available. Symbol documentation joins them when the hover request completes. Messages
remain plain text. A mapped diagnostic reads “Awaiting recheck” until fresh analysis arrives.

Subscribe to the controller and render the ready snapshot’s `content` with `mountDocumentation`.
The snapshot’s `range` identifies where the same information applies. A point diagnostic matches
its exact offset. For pointer dwell, call `request(point, "reuse")` to track the new position.
Inside a current provider range, the controller reuses the symbol reply and shows diagnostics
for the latest offset as they arrive. The default `request(point)` refreshes the lookup.
The controller preserves focus and selection. Editing, changing the selection or
fold projection, and replacing the tab expire the result. `cancel()` dismisses it and `dispose()`
releases the controller. For a separate analysis service, pass its observable `diagnostics` and
`diagnosticRevision` snapshot through the `diagnostics` option. The lookup uses the painted revision.

`createLspHoverClient(provider).run({ document, offset })` returns `{ result, cancel }`. A
non-null reply has `text`, formatted `content`, optional `range` and `isCurrent`. `decodeLspHover`
accepts Hover/null and legacy strings, MarkedString arrays and code fragments. Legacy strings use
Markdown. `{ language, value }` preserves code. Your host places and dismisses the popup, even when
the range is absent.

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

`createSignatureController(editor, provider)` follows the primary caret in one editor.
Call `request()` or press Ctrl/Cmd+Shift+Space to show parameter help, including in a read-only
view. An accepted trigger such as `(` requests help at the resulting caret, including when the
editor supplies the closing parenthesis. An intercepted key leaves help closed. Up and Down
cycle through overloads. Escape closes the topmost popup. A higher-priority completion list gets
these keys first.

Subscribe to the controller and render `getSnapshot().signature`. Its label and parameter offsets
describe the highlighted text. Use the snapshot's `anchor` to position the popup. When you type
an argument name, horizontal whitespace or a comma at the same caret, a `pending` snapshot keeps
the last signature at the new position. A comma clears the previous parameter highlight until the
provider identifies the next one. Moving the caret or opening a nested call clears the previous
signature and requests fresh information. Blur, composition and `cancel()` dismiss help.
Disposing the editor also disposes its controller.

`createLspSignatureClient(provider).run({ document, offset, context })` returns a cancellable
call. Read `options(document)` for [provider triggers](language-server.md#feature-capability-queries).
`LspSignatureContext` carries the trigger kind, optional character, retrigger flag and optional
`activeSignatureHelp`. Omit it for explicit invocation.

`decodeLspSignatureHelp` returns literal labels/documentation plus structured content, UTF-16
parameter offsets, active indices and immutable wire context. String parameter labels must occur
inside the signature label; tuple offsets must fit it. A signature's active parameter overrides
the batch value. Missing or out-of-range nonnegative indices select the first available entry;
zero parameters means no highlighted parameter. Null and empty help yield no useful presentation.

When using the protocol client directly, call `result.selectOverload(signature)` with a signature
from that result to record the user's choice. It returns false for an expired result or a foreign
signature. On a retrigger, omit `activeSignatureHelp` to reuse the last accepted wire context. The
document, resource, URI, language, connection epoch and registration generation must match.
Starting a replacement request retains that context. An empty result, a new explicit non-retrigger
invocation, `cancel`, disposal or a provider change clears it. Context you supply takes precedence. If
the inherited context exceeds the advisory size limit, the client omits it. It keeps no old text
buffer and grants no editing rights. A late cancelled reply cannot replace it.

Render signature and parameter content with the [documentation view](#hover-and-documentation).

In the examples, Up and Down cycle through overloads while signature help is visible. An open
completion list takes those keys first. Escape dismisses one visible popup per press and keeps
the caret in the editor.

### Navigation and target loading

`createNavigationController(editor, provider, options)` handles definition links for one mounted
view. Hold Ctrl or Cmd over a symbol to underline it, including when the editor is mounted in a
shadow root. Hover preserves focus, selections and open tabs. Releasing the modifier clears the
underline. A primary click while the modifier is held
resolves the target even if the lookup is pending. Editing or remounting the source expires
the gesture. Alt+click stays available for multiple carets.

Supply the project with `options.documents`. A host that opens tabs or shows a chooser handles
`options.onDefinition(offset)` by calling `controller.request("definition", offset)` during the
callback. This reuses the hover reply. F12 and reference commands can call the same controller
at the caret. For a single destination use `result.locationAt(index)`. For a list,
`result.pageFor(index)` selects that location and returns its page of up to 64 choices.
The index defaults to zero. An empty result or an invalid index yields `undefined`.

Render `page.locations` and highlight `page.selected`. Each choice has a zero-based result index.
`moveSelection(-1 | 1)` moves one row and wraps at either end. `previousPage` and `nextPage`
are actions, or `null` at the boundary. They keep the selected row within the page. A short last
page selects the nearest available row, and paging back restores the preferred row.
Each move returns a new page. Keep a choice in its row's click handler so later paging preserves
that button's destination. Its `open(present)` calls the host with the captured
document and range while the choice is current. It returns false after cancellation, replacement,
a change to the captured documents or a provider restart. The host opens the destination.
A result list can open several choices as the caret moves. Set
`resultLifetime: "view"` for a popup tied to the original selection and folds.
Without a callback, the controller publishes the result through `getSnapshot()`
and `subscribe()`. Call `cancel()` to dismiss navigation and `dispose()` to detach it.

`createLspNavigationClient(provider).run({ document, project, offset, kind })` provides a call whose
result contains `{ locations, isCurrent }`, with `kind` equal to `"definition"`
or `"references"`. `includeDeclaration` defaults to true and is sent for references. Standard
reference locations contain no declaration flag, so the client does not infer one. Valid positions
reach the server without requiring a local word match.

For a custom pointer UI, `prepareDefinition({ document, project, offset }).result` resolves to a preview with
`hasTargets`, `originRange`, `isCurrent()` and `resolve()`. It validates the reply without
loading a destination. The editor underlines the provider's origin range when supplied and
uses a bounded local word for a plain location. Calling `resolve()` loads the captured targets.

`decodeLspLocations` accepts Location, Location[] or LocationLink[] for definitions and
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

The provider builds the UTF-16 index, checks the resource and its edit permissions, and uses a
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
Reuse the origin for choices
in the same result list to give them one Return point. The history keeps the last 100 origins.
`getSnapshot()` gives the count and `subscribe()` reports count changes.

`history.back(present)` asks the host to present the original `DocumentView`. Return its editor,
`undefined` to skip it, or `"busy"` to keep it for a later attempt. Return skips closed views
and replaced tabs. It restores the selections and scroll and reports `"restored"`, `"empty"` or
`"busy"`. Pass `{ focus: true }` as the second argument to focus the editor on return.
Dispose the history with its host.
[Restoring a view after edits](viewport.md#scrolling-and-saved-views)

### Rename and workspace edits

Use `createRenameController(editor, provider, { documents })` for an editor with a rename form.
Pass `setName(value)` each time the name changes and call `request()` to preview it at the primary
caret. Alternatively, `request(name)` sets the name and requests its preview in one call. F2 opens
the example form. Enter previews a name, then confirms the reviewed edit on the next press.

A ready snapshot contains a `preview` for the captured name and selection. Its `count` covers
all edits. `readPage(index)` reads up to 64. Give each preview its own Apply button and keep
that button while paging. A pointer press started on an older preview then cannot confirm a
replacement on release.

```ts
import type { RenamePreview, ReviewEditResult } from "sttropez/browser";

export function renameButton(preview: RenamePreview, report: (result: ReviewEditResult) => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Apply rename";
    button.disabled = !preview.canApply;
    button.onclick = () => report(preview.confirm());
    return button;
}
```

A successful `confirm()` returns `{ applied: true }` and applies the reviewed pages as one undo
step. The snapshot lists the changed files. On refusal, read `reason`:

- `expired` means the name, capture or request changed, or the editor was disposed. The old
  preview's `readPage()` returns `undefined`.
- `not-writable` means a target in this preview is read-only or locked.
- `no-changes` means the provider supplied no edits.
- `failed` includes a `message` describing the apply error.

Call `createLspRenameClient(provider).run({ document, project, offset, newName }).result` for a
workspace edit plan. A null reply gives an empty plan. The server checks language naming rules. Your
host sets the name field’s input limits.

`decodeLspWorkspaceEdit` accepts `changes` maps and versioned `documentChanges` text edits.
When both are supplied, `documentChanges` takes precedence. Numeric versions must match captured
wire versions; absent/null versions require current captured buffers too. Unknown URIs, repeated
document identities, invalid ranges, overlap or malformed final entries refuse the entire batch.
Edits sort stably in original coordinates, preserving provider order for equal-position inserts.
No newline normalization is performed. There are no extra decoder quotas on document/edit counts
or inserted text; session/transport bounds and direct-call input policy apply.

Use `previewLspWorkspaceEdit(edit, titleForDocumentId, page)` to show a page of proposed changes. It
reads bounded notes for that page from the captured buffers and reports counts and insertion sizes for
the entire edit. Let the user reach every page. Apply only after they approve the full edit, including
files on other pages.

`applyLspWorkspaceEdit(workspace, edit, options)` rechecks captures and applies one atomic shared
history transaction. `origin` is required; `requiredOrigins` adds host permission requirements;
`view` carries the originating view; `historyKind` defaults to `"replace"`. The helper returns
only changed document snapshots and throws on refusal. An empty or text-identical batch adds no
revision/history entry. It owns no leases, selection/lifecycle capture or approval controls.
Direct protocol consumers retain the provider client, captured view and approval through confirmation.
The browser controller owns these lifetimes for a mounted editor.

### Code actions and commands

`createCodeActionController(editor, provider, options?)` requests actions for the editor’s primary
selection. The origin document is always included. Supply `documents` to include other project files.
Render `getSnapshot().choices` and call the chosen item’s `select()` to resolve and preview it.
If the first choice already has an edit, its preview opens with the list. A preview page contains up
to 64 edits. For an edit-only action, `confirm()` applies the full edit across all affected files in
one undo step and returns `{ status: "applied" }`.

```ts
import { createCodeActionController, type TextEditor } from "sttropez/browser";
import type { LspWorkspace } from "sttropez/protocol";

export function attachFixes(editor: TextEditor, provider: LspWorkspace) {
    const actions = createCodeActionController(editor, provider);
    const stop = actions.subscribe(() => {
        const { choices, preview } = actions.getSnapshot();
        // Bind each button to this choice or preview, including across a later render.
        renderFixes(choices.map(choice => ({ title: choice.title, select: () => choice.select() })),
            preview?.readPage()?.count ?? 0, preview?.canApply ? preview.confirm : undefined);
    });
    return { request: actions.request, dispose() { stop(); actions.dispose(); } };
}

declare function renderFixes(choices: { title: string; select(): void }[], edits: number, confirm?: () => void): void;
```

A change to the captured selection, fold projection, document revision or edit authority expires
the preview. Replacing the editor disposes its controller. Old choices and confirmation buttons
cannot edit the replacement. For a direct fix, an explicit choice button can pass a predicate to
`select` that checks the resolved action before confirming it. Commands also require a host
`runCommand` handler that owns authorization and review of any subsequent edits. Return
`undefined` before starting work to decline a command. The caller receives
`{ status: "declined" }` and can retry the same preview while it is current. Returning an
execution handle gives the caller `{ status: "executing" }`. Observe the controller for the
eventual result (`applied`, `executed` or `failed`).

`CodeActionConfirmation` also reports `expired` for a retired preview, `disabled` for an
unavailable action, and `not-writable` when a reviewed edit lacks permission. A read-only view
can preview edits to its source but cannot confirm them, even if another view can edit the file. A synchronous
failure returns `{ status: "failed", message }`.

`createLspActionClient(provider, options).run({ document, project, from, to }).result` resolves to
validated `actions`, currentness guards, `supports(command)`, `resolve(action)` and
`execute(action, scope)`. Requests carry trigger kind Invoked and overlapping current versioned
diagnostics, preserving their metadata. The request range is primary; it does not assert completed
analysis. No automatic trigger, `only` filter or partial-result token is sent.

`decodeLspCodeActions` accepts a complete array or null, including CodeAction and Command literals,
disabled reasons, preferred flags, open kind strings, workspace edits and opaque data. Titles and
reasons are literal text. Disabled choices also undergo full metadata/target validation. Malformed
final items and partial-list envelopes reject the batch. An unresolved choice without an edit or
command can resolve when matching provider options advertise `resolveProvider`.

`decodeLspResolvedCodeAction` accepts only the advertised addition of `edit`. All other attributes and
data must match, irrespective of JSON key order. A changed title, new command, missing edit or stale
capture rejects the reply. Browsing and resolving actions leave the files untouched.

By default command support requires static/dynamic advertisement. `LspActionOptions.commandPolicy`
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

The policy sees each captured, enabled command once. Pass that exact command object to `supports` so
the policy can check arguments as well as the name. A route’s `isCurrent` can revoke it. If your
policy changes while work is pending, call `cancel()` on the client. The guard itself sends no
notification. Denying a command disables the entire choice, including any accompanying edit.

After explicit host authorization, `execute(action, scope)` uses `LspCommandScope` and the shared
command runner. It does not automatically apply `action.edit`: the host's synchronous `prepare`
phase applies any authorized initial edit and updates its captured snapshots/guards, then the
runner synchronizes those snapshots before dispatch. The lane is reserved before preparation,
so a competing operation cannot leave an initial edit behind. Host routes receive current
snapshots, cancellation and a captured `applyEdit` decision path; unsolicited server edits cannot
inherit a host-only route's authority. There is no script evaluator or automatic command lookup.

Each initial edit and each later batch the user approves gets its own undo step. After applying one,
update the host captures and keep the resources leased until the operation ends. If a later step fails
or its acknowledgement is lost, earlier edits remain in history. The receipt retains the first
`applied: false` decision, including a validation refusal, even if a later batch succeeds.
[Command permissions and reconnect](language-server.md#commands-and-edit-decisions)

`decodeLspApplyEdit` checks the optional literal label and every text edit. Return an
`LspApplyEditResult` for each decision. To decline, return `applied: false` and an optional failure
reason. Cancellation uses the usual request path. Set a review deadline. If the connection closes
after commit, report the uncertain delivery and leave the edit in history.

### Document links

`createDocumentLinkController(editor, provider, { documents })` discovers links in the mounted
document. Include any project documents whose revision or edit permissions affect your URI mapping.
Call `request()` and render `getSnapshot().links`. Each link carries its range, literal tooltip,
optional target and an `open` action. Give each choice its own button.

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

`open(visit)` resolves a missing target when the provider supports resolution. Its result has
status `presented` when it calls `visit`, `no-target` when no URI is available, or `resolving`
when a lookup is already running. A provider failure returns `failed` with a message.
The host decides which URIs to open, where to show them and how to return. If the user clicks elsewhere during resolution, keep focus there. Read the updated
link from the snapshot for a fresh click.

Caret movement cancels a pending lookup. After discovery, the list survives caret movement.
An edit or authority change in a captured document, a new request, cancellation or editor
disposal invalidates its actions. An expired action returns `{ status: "expired" }`. The protocol client
`createLspLinkClient` exposes the list and its `resolve` operation. `decodeLspDocumentLinks`
checks ranges and bounds the URI, tooltip and opaque data. `decodeLspResolvedDocumentLink` allows
a new target and tooltip while requiring the original range and identity.

### Document colors

`createDocumentColorController(editor, provider)` discovers colours for a mounted editor.
Call `request()`, choose a reference from `getSnapshot().colors` and call its `preview(rgba)`.
The first returned presentation is selected. Another presentation's `select()` creates a new
review. Give each review its own Apply button as in the rename example. Call `review.apply()`
for that review. It returns `{ applied: true }` on success, or a `ReviewEditResult` with
`reason` set to `expired`, `not-writable` or `failed`.

Use `review.notes` to display the proposed edits. Each note gives the captured range, nearby text,
the first 256 UTF-16 units of the insertion and its full length in `insertUnits`.
`review.edits` contains the complete replacements used by Apply.

Call `dismissPreview()` when the picker value changes. Dismissing a pending provider call ends
discovery. You can reuse a completed list after dismissing its review or moving the caret.
Changing the selected format, source, selection, folds or edit permission invalidates the old
Apply action. Read-only sources allow review. A successful Apply preserves relative carets inside
replaced literals and groups all edits into one Undo. Matching text preserves revision and history.

`createLspColorClient(provider).run({ document }).result` resolves to `{ items, isCurrent, presentations }`.
`decodeLspDocumentColors` validates every range and RGBA value. `decodeLspColor` requires finite
channels in `[0, 1]`. `presentations(item, rgba, prepare?)` requires an item from the captured list
and returns validated choices for that same source.

`decodeLspColorPresentations` validates complete primary/additional edit plans. A missing primary
edit uses the literal presentation label at the captured color range. An invalid final choice,
overlap or out-of-document edit rejects the batch. Empty choices are unavailable for application.
Labels need not be color literals; the proposed-color input grammar belongs to the host.


### Occurrences

`createLspHighlightClient(provider).run({ document, offset })` returns a cancellable call
whose result includes `items`, `isCurrent` and indexed `intersect(from, to)`. The decoder
`decodeLspDocumentHighlights` validates every range and text/read/write kind; an omitted kind
means text. It retains all results within input limits, including overlapping ranges. Visible-row
queries skip unrelated intervals and omit zero-width markers without changing the stored items.

Attach `createLspHighlightController(editor, { provider, delayMs? })` to request
occurrences when the caret settles and queued input or composition finishes. A single caret can move
inside the same highlighted identifier (up to 4,096 UTF-16 units) without clearing its highlights or
starting another request. The range end is exclusive. An overlapping range, a selection or a move
outside the identifier starts a fresh lookup. Edits, focus loss and provider changes clear the result.
Subscribe to invalidate your decorations, then
call `intersect` for each visible line and style by occurrence kind. Highlighting preserves text and
selection. Connect or retry the provider yourself. `dispose` releases the client and listeners.

### Folding

For provider folds, pass the result and its `isCurrent` guard to the view’s discovery controller.
Choose what to discover and collapse in each pane. Expanding a saved reference leaves the working
pane’s folds alone. [Whole-line ranges and provider groups](folding.md#language-server-discovery)

### Limits

Sizes below count UTF-16 units. The client validates the whole list before you page it for display.
Set input limits yourself if you call a decoder directly. Most features rely on the
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

Before applying a delayed edit, check the resource, revision, view, all selections, folds, input state
and permission. Browser controllers check their view. For a headless client, supply that check. Retain
results and target leases through approval. Apply the batch atomically, keep Save and Run independent
and report any earlier edits if a command fails.

## Not covered

Formatting, semantic tokens and completion follow-up commands are outside the
[supported language features](README.md#support-matrix).
