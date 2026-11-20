# Language features

A completion list, hover or rename result belongs to the revision that produced it. Attach the browser
controllers for completion and occurrence highlights. For other results, your host draws the UI, opens
files and decides which edits to apply. [Connect a provider](language-server.md)

## Use

Before connecting, list the methods you use in `features`. Set `diagnostics` and `workspaceEdits`
separately. Incoming edits and command execution have their own
[connection policy](language-server.md#commands-and-edit-decisions).

| Feature | Client or controller | Enabled method |
| --- | --- | --- |
| Completion | `createLspCompletionClient`; browser `createLspEditor` | `textDocument/completion` |
| Hover | `createLspHoverClient` | `textDocument/hover` |
| Signature help | `createLspSignatureClient` | `textDocument/signatureHelp` |
| Definition / references | `createLspNavigationClient` | `textDocument/definition` / `textDocument/references` |
| Rename | `createLspRenameClient` | `textDocument/rename` |
| Code actions | `createLspActionClient` | `textDocument/codeAction` |
| Document links | `createLspLinkClient` | `textDocument/documentLink` |
| Document colors | `createLspColorClient` | `textDocument/documentColor` and `textDocument/colorPresentation` |
| Occurrences | `createLspHighlightClient`; browser `createLspHighlightController` | `textDocument/documentHighlight` |
| Folding | [Folding client and discovery controller](folding.md#language-server-discovery) | `textDocument/foldingRange` |

Import headless clients from `sttropez/protocol`. Use a separate client for each independent request.
`run` captures the documents, `cancel` expires the work and results, and `dispose` ends participation.
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
import type { LspEditorController } from "sttropez/browser";

export function completionActions(language: LspEditorController) {
    const { choices, completionId } = language.getSnapshot();
    return choices.map((label, index) => ({
        label,
        select: () => language.chooseCompletion(index, completionId),
        accept: () => language.chooseCompletion(index, completionId)
            && language.accept("replace", completionId)
    }));
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

Read `diagnostics`, `diagnosticsPending`, `diagnosticRevision` and `unversionedDiagnostics` on the
browser controller. Use `selectDiagnostic(index)` to jump. Distinguish a pending recheck from a push
of unknown age. Render messages as text. Your host pages the list, checks help links and opens related
locations.

### Completion

`createLspCompletionClient(provider)` owns headless completion requests, decoding, resolution
and retained choice batches. `run(document, offset, options?, prepare?)` returns `{ result,
cancel }`; its result is an immutable `LspCompletionBatch` with `items`, `omitted`, `incomplete`,
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
        const batch = await client.run(document, offset).result;
        return batch.isCurrent() ? batch.items.map(item => item.label) : [];
    } finally {
        client.dispose();
    }
}
```

`createLspEditor(workspace, tab, editor, options)` attaches completion and diagnostics to one view.
The controller handles input, selection checks and acceptance. The host renders choices and status.
`request()` invokes completion. Set `automatic: false` to require explicit requests. Supply
`canCapture` for additional readiness checks.

Completion and diagnostics share one binding and lease but have separate scopes. `prepareCompletion`
receives the completion scope after synchronization. Cancellation skips pending preparation or
discards a late result. Dispose the attachment, editor and provider separately.

Automatic completion waits for input to settle after prefix typing or an advertised trigger character.
It needs one collapsed caret and no composition. Press Ctrl/Cmd+Space to request suggestions yourself.
Arrows select, Enter replaces, Tab inserts and Escape dismisses the choices or active snippet. When
neither is visible, Escape cancels pending requests and reaches the editor. Escape then Tab or
Shift+Tab leaves the view.

Save the `completionId` with a rendered control and pass it to `chooseCompletion`, `accept` or
`apply`. Filtering a prefix gives the list a new ID. Unchanged labels keep the same immutable
`choices` array across diagnostics, selection and detail updates.

`decodeLspCompletions` accepts arrays, CompletionList or null, including defaults for edit ranges,
insertion format/mode, commit characters and opaque data. It checks the primary and additional
same-document edits. A server-supplied range overrides the browser’s bounded Unicode word range.
Choices sort stably by `sortText` and filter by case-insensitive `filterText` prefix. If the prior
choice disappears, `preselect` applies. Manual requests initially show all choices. Set
`filterManualCompletions: true` to filter them by the captured prefix too.

`rebaseLspCompletion` accepts only a single human typing insertion proved by Core batch metadata
inside the primary insert range. The browser additionally requires matching selections, fold
generation, authority, URI, binding and language configuration. Mapped primary/additional ranges
are validated again.
Undo, replacements, host edits, unknown/composed changes or incompatible navigation expire the
offer. Incomplete lists retrigger with context kind 3 while compatible choices stay visible.
`completionIncomplete` preserves provider partial-list status independently of client filtering.

When the provider advertises resolution, the selected item can resolve `detail`, `documentation`,
`additionalTextEdits`, `insertText` and `textEdit`. `decodeLspResolvedCompletion` requires the exact
captured snapshot and preserves label, filtering/sorting fields, format and opaque identity.
Primary content may change only within the captured insertion/replacement ranges. Additional
ranges belong to the resolve request's snapshot. Failed or malformed resolution dismisses the
offer. Completion documentation is literal text.

Use `accept(mode, completionId)` when the user chooses an item that may be resolving. A `true`
return means the controller accepted the request. `apply` requires an item it can insert immediately
and returns false during resolution. Typing, selection changes, blur, cancellation or lost permission
clears queued acceptance. Typing an advertised commit character while the item is unresolved inserts
the character normally and closes the list. Once ready, the item and its commit character form one
transaction, with no duplicate native insertion. Commit characters must be one UTF-16 unit.

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
to tab size 4 and spaces; the browser captures the editor's `languageConfiguration()`. Additional
edits keep their supplied text. Resolution, rebasing and commit characters rebuild from raw
provider text, so indentation is applied once. A configuration change expires pending acceptance.

Snippet acceptance selects every occurrence of the first numbered field. Typing, deletion, paste
and composition commit use the existing input/history paths to mirror fields. Tab/Shift+Tab
traverse fields; Alt+Up/Down cycles choices. `moveSnippet` and `chooseSnippet` take the published
snippet ID. Escape ends the session while keeping text and the primary selection; `$0` ends it
at the final carets. Focus loss, selections outside the field, changed authority, external edits,
undo or redo end the session. Undo/redo restore text/selections without recreating it. Ready
commit-character acceptance inserts expanded text plus the character without starting a session.

### Hover and documentation

`createLspHoverClient(provider).run(document, offset, prepare?)` returns `{ result, cancel }`. A
non-null reply has `text`, formatted `content`, optional `range` and `isCurrent`. `decodeLspHover`
accepts Hover/null and legacy strings, MarkedString arrays and code fragments. Legacy strings use
Markdown. `{ language, value }` preserves code. Your host places and dismisses the popup, even when
the range is absent.

Use `mountDocumentation` from `sttropez/browser` to append a documentation view. `setContent` reuses
an unchanged immutable array. `dispose` removes the view and listeners. All three entries (`sttropez`,
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

`createLspSignatureClient(provider).run(document, offset, context?, prepare?)` returns a cancellable
call. Read `options(document)` for [provider triggers](language-server.md#feature-capability-queries).
`LspSignatureContext` carries the trigger kind, optional character, retrigger flag and optional
`activeSignatureHelp`. Omit it for explicit invocation.

`decodeLspSignatureHelp` returns literal labels/documentation plus structured content, UTF-16
parameter offsets, active indices and immutable wire context. String parameter labels must occur
inside the signature label; tuple offsets must fit it. A signature's active parameter overrides
the batch value. Missing or out-of-range nonnegative indices select the first available entry;
zero parameters means no highlighted parameter. Null and empty help yield no useful presentation.

On a retrigger, you can omit `activeSignatureHelp` to reuse the last accepted wire context. The
document, resource, URI, language, connection epoch and registration generation must match.
Starting a replacement request retains that context. An empty result, a new explicit non-retrigger
invocation, `cancel`, disposal or a provider change clears it. Context you supply takes precedence. If
the inherited context exceeds the advisory size limit, the client omits it. It keeps no old text
buffer and grants no editing rights. A late cancelled reply cannot replace it.

Choose when to request signature help, which popup gets a key and how to display overloads. Wait for
input and composition as needed. Switching overloads leaves source text intact. Render signature and
parameter content with the [documentation view](#hover-and-documentation).

### Navigation and target loading

`createLspNavigationClient(provider).run(project, originId, offset, kind, includeDeclaration?,
prepare?)` returns a promise of `{ locations, isCurrent }`, with `kind` equal to `"definition"`
or `"references"`. `includeDeclaration` defaults to true and is sent for references. Standard
reference locations contain no declaration flag, so the client does not infer one. Valid positions
reach the server without requiring a local word match.

`decodeLspLocations` accepts Location, Location[] or LocationLink[] for definitions and
Location[] for references; null yields an empty result. Mixed location/link arrays are refused.
Every target URI must resolve to an exact captured buffer/index/resource/document/revision.
Unknown targets reject the whole batch. A LocationLink selection must fit its target range after
position conversion; its optional origin range uses the source capture. Results retain all
validated locations within the host's input limits. The host owns paging and explicit reveal.

Navigation, rename, actions and incoming edits share `LspWorkspaceOptions.resolveTarget(uri,
context)` for missing targets. Wire structure is validated before loading. `LspTargetContext`
identifies navigation/editing, the captured source (null for server edits), source/provider
currentness and cancellation. Return `LspResolvedTarget` containing an exact `LspEditTarget` and
idempotent `release`, or undefined for an unavailable URI. The target's line index must use its
captured buffer, with an independent currentness guard. A closed target has `version: null`;
its local revision must not substitute for an unknown wire version.

Authorize each URI before loading its contents. You can load a definition target without mounting a
view or sending `didOpen`. Reading the file grants no permission to edit it or follow a link. Cancel
the loader with the request and release a late target even if loading finished after cancellation,
replacement, disposal or a provider change. Keep accepted targets until the result or server-edit
decision ends. Recheck the whole batch once loading finishes.

For Return, save the original view state and all selections. A focus or selection change can expire
a pending navigation. Once a read-only list is visible, resource and provider checks can keep it
available as users move between results. Reveal the captured target. Reads preserve history and
comparison baselines. An immutable comparison reference needs no provider binding.

### Rename and workspace edits

Call `createLspRenameClient(provider).run(project, originId, offset, newName, prepare?)` for a
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
Retain those guards and the provider client through the decision:

```ts
import type { DocumentSnapshot, DocumentView, Workspace } from "sttropez";
import {
    applyLspWorkspaceEdit,
    createLspRenameClient,
    previewLspWorkspaceEdit,
    type LspWorkspace,
    type LspWorkspaceEditPreview
} from "sttropez/protocol";

export async function reviewRename(
    workspace: Workspace,
    provider: LspWorkspace,
    project: readonly DocumentSnapshot[],
    view: DocumentView,
    offset: number,
    newName: string,
    signal: AbortSignal,
    isIntentCurrent: () => boolean,
    title: (documentId: string) => string,
    review: (
        page: (index: number) => LspWorkspaceEditPreview,
        signal: AbortSignal
    ) => Promise<boolean>
) {
    if (signal.aborted || !isIntentCurrent()) return false;
    const client = createLspRenameClient(provider);
    const cancel = () => client.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    try {
        const edit = await client.run(project, view.documentId, offset, newName);
        if (signal.aborted || !isIntentCurrent() || !edit.isCurrent()) return false;
        const approved = await review(
            index => previewLspWorkspaceEdit(edit, title, index), signal
        );
        if (!approved || signal.aborted || !isIntentCurrent() || !edit.isCurrent()) return false;
        const changed = applyLspWorkspaceEdit(workspace, edit, {
            origin: "host", requiredOrigins: ["human"], view, historyKind: "refactor"
        });
        return changed.length > 0;
    } finally {
        signal.removeEventListener("abort", cancel);
        client.dispose();
    }
}
```

Guard the tab, view, all selections, input readiness, name and permissions. If the user dismisses the
review, abort it, close the UI and settle the callback. Handle promise rejection. Each approved batch
adds one undo step across its changed files, including unmounted ones. Only a locked or unauthorized
edit target blocks the batch. An unrelated read-only file can stay in the project.

### Code actions and commands

`createLspActionClient(provider, options).run(project, originId, from, to, prepare?)` returns
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

`createLspLinkClient(provider).run(document, prepare?)` returns `{ items, isCurrent, resolve }`.
`decodeLspDocumentLinks` validates source ranges, optional opaque targets, literal tooltips and
data. A missing target can be retained for explicit resolution when matching provider options
advertise it. `resolve(item, prepare?)` requires an item from that captured list.

Resolving a link can change its target and tooltip. `decodeLspResolvedDocumentLink` keeps the range,
opaque identity, capture and size limits fixed. When the user clicks, check the destination against
your current policy and keep the source location for Return. You can display an unknown target as
text. Receiving a late reply should never open a link or move focus.

### Document colors

`createLspColorClient(provider).run(document, prepare?)` returns `{ items, isCurrent, presentations }`.
`decodeLspDocumentColors` validates every range and RGBA value. `decodeLspColor` requires finite
channels in `[0, 1]`. `presentations(item, rgba, prepare?)` requires an item from the captured list
and returns validated choices for that same source.

`decodeLspColorPresentations` validates complete primary/additional edit plans. A missing primary
edit uses the literal presentation label at the captured color range. An invalid final choice,
overlap or out-of-document edit rejects the batch. Empty choices are unavailable for application.
Labels need not be color literals; the proposed-color input grammar belongs to the host.

Keep the color client alive while the user previews swatches. When they choose a presentation, check
the captured revision and permission, map the selections and apply its edits in one undo step. If the
proposed color or source changes, cancel and ask for new choices. Applying the current color without
changing the text preserves revision, history and selections.

### Occurrences

`createLspHighlightClient(provider).run(document, offset, prepare?)` returns a cancellable call
whose result includes `items`, `isCurrent` and indexed `intersect(from, to)`. The decoder
`decodeLspDocumentHighlights` validates every range and text/read/write kind; an omitted kind
means text. It retains all results within input limits, including overlapping ranges. Visible-row
queries skip unrelated intervals and omit zero-width markers without changing the stored items.

Attach `createLspHighlightController(workspace, tab, editor, { provider, delayMs? })` to request
occurrences when the caret settles and queued input or composition finishes. It clears stale results
on document, selection, focus, tab or provider changes. Subscribe to invalidate your decorations, then
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
