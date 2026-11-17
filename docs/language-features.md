# Language features

Use StTropez's language clients to obtain validated results for captured documents. Completion
and occurrence controllers attach to editor views; the other clients return models for host
controls. The host owns presentation, navigation, target loading and edit decisions. Configure
the shared provider through the [language-server guide](language-server.md).

## Use

Enable each method in the provider's `features` list before connecting. Diagnostics use the
separate `diagnostics` option; workspace-edit capability uses `workspaceEdits`. Incoming edits
and command execution have their own [connection policy](language-server.md#commands-and-edit-decisions).

| Feature | Client or controller | Enabled method |
| --- | --- | --- |
| Completion | `createLspEditor` from `sttropez/browser` | `textDocument/completion` |
| Hover | `createLspHoverClient` | `textDocument/hover` |
| Signature help | `createLspSignatureClient` | `textDocument/signatureHelp` |
| Definition / references | `createLspNavigationClient` | `textDocument/definition` / `textDocument/references` |
| Rename | `createLspRenameClient` | `textDocument/rename` |
| Code actions | `createLspActionClient` | `textDocument/codeAction` |
| Document links | `createLspLinkClient` | `textDocument/documentLink` |
| Document colors | `createLspColorClient` | `textDocument/documentColor` and `textDocument/colorPresentation` |
| Occurrences | `createLspHighlightClient`; browser `createLspHighlightController` | `textDocument/documentHighlight` |
| Folding | [Folding client and discovery controller](folding.md#language-server-discovery) | `textDocument/foldingRange` |

Clients in the table come from `sttropez/protocol` unless marked as browser APIs. Retain one
client per independent feature intent. `run` captures document snapshots; `cancel` expires its
work and published results; `dispose` ends participation. Connection and synchronization
ownership follow the [shared scope contract](language-server.md#workspace-ownership-and-synchronization).
Headless clients do not capture browser selections, focus or host edit permission.

Each headless feature client exposes `state`, `subscribe`, `snapshot`, `isBusy`, `options`,
`cancel` and `dispose`. `isBusy()` covers pending requests and follow-up work; the action client
also includes confirmed command execution. `options(document)` is a
[read-only capability query](language-server.md#feature-capability-queries) for the client's
primary method. Navigation accepts an optional second argument of `textDocument/definition`
(the default) or `textDocument/references`; colors accept `textDocument/documentColor`
(the default) or `textDocument/colorPresentation`. Other methods are rejected. Options queries
and new subscriptions on a disposed client throw; `dispose()` is idempotent.

For a mounted completion controller, retain the published list ID in each host action. This
prevents a delayed click from selecting an item in a replacement list:

```ts
import type { LspEditorController } from "sttropez/browser";

export function completionActions(language: LspEditorController) {
    const { choices, completionId } = language.state.getSnapshot();
    return choices.map((label, index) => ({
        label,
        select: () => language.chooseCompletion(index, completionId),
        accept: () => language.chooseCompletion(index, completionId)
            && language.accept("replace", completionId)
    }));
}
```

Render labels as text. Subscribe to the stable `state` handle, rebuild controls from its immutable
snapshot and remove the subscription when the host view ends. The
[editor attachment recipe](language-server.md#use) covers creation and teardown.

## Contract

### Captures and ranges

A `LspDocumentCapture` identifies the exact URI, resource, document, revision, sent buffer/index,
wire version, connection epoch and registration generation. `isCurrent` must pass again before
publishing or using a delayed result. A sent version establishes synchronization order, not
completed server analysis. Capture host view/selection/authority separately before awaiting work.

`lspRangeOffsets` converts raw UTF-16 positions. Character positions past a valid line's end
clamp to that end; nonexistent lines, negative/noninteger positions and reversed wire ranges
are refused. Clamping does not split CRLF. A position inside a surrogate pair retains its UTF-16
meaning. Feature decoders validate a complete result before publication; diagnostics and folding
have the explicit placement/skip behavior described in their contracts.

Optional `prepare` callbacks run inside the client's captured lifetime and receive the scoped
custom-message API. They do not authorize retargeting a request to newer text. Superseded work
cannot publish even if a host callback finishes late. Handle rejected promises and expire visible
results when host guards change; a stale model does not remove its host-rendered controls itself.

### Diagnostics

`scope.observeDiagnostics(binding)` supplies shared immutable `LspDiagnosticState` with `empty`,
`current`, `pending` and `expired` status. `decodeLspDiagnostics` validates a push against its exact
URI and capture. A supplied version must match the wire version. An omitted version yields
uncertain freshness, with null provider version/revision independently of `snapshotRevision`,
which identifies the buffer used for placement.

Ranges on nonexistent lines retain their message and wire range with null offsets and
`placement: "out-of-bounds"`; they have no marker. Malformed structures or metadata reject the
whole batch, including an invalid final item. Fresh batches replace the result; an empty batch
clears it. Invalid or known-stale pushes preserve the preceding valid batch.

Local transaction maps move placed offsets and mark the result pending. Wholly deleted ranges
disappear; provider version/revision and original wire ranges stay intact. Pending `isCurrent()`
is false. `isPlacementCurrent()` separately guards local display/navigation offsets. Undo cannot
resurrect deleted diagnostics. Missing maps, close/URI reuse and reconnect expire associations.
Unrelated capability registration does not invent an analysis revision or erase valid placement.
Mapping visits retained diagnostics without exporting the full document or requesting analysis.

Metadata includes integer/string `code`, `codeDescription`, `tags`, `relatedInformation` and
opaque JSON `data`. Unknown integer tags survive forwarding; the advertised presentation tags
are unnecessary and deprecated. Related resources are not loaded automatically. Code actions
receive overlapping placed diagnostics only from a matching current provider version. Pending
and unversioned diagnostics provide no version-verified action context.

The browser completion controller exposes `diagnostics`, `diagnosticsPending`,
`diagnosticRevision`, `unversionedDiagnostics` and `selectDiagnostic(index)`. Render pending
analysis and uncertain provider freshness distinctly from current results. Diagnostic messages
are literal text. The host owns list paging, help-link policy and related-location navigation;
none of this metadata grants edit authority.

### Completion

`createLspEditor(workspace, tab, editor, options)` coordinates completion and diagnostics for
one mounted view. It owns capture guards, input listeners, resolution and acceptance; the host
renders its observable choices and status. `destroy()` releases that controller without disposing
the editor or provider. `request()` invokes completion explicitly; `automatic: false` disables
automatic invocation. `canCapture` supplies an additional host readiness guard.

Automatic completion follows ordinary prefix typing and advertised trigger characters after
input settles, with one collapsed caret and no active composition. Ctrl/Cmd+Space invokes it
explicitly. Arrows select, Enter replaces, Tab inserts and Escape dismisses. `chooseCompletion`,
`accept` and `apply` accept an optional `completionId` for retained controls. Each list ID also
changes after prefix filtering. The immutable `choices` array retains identity while its labels
are unchanged, including diagnostic, selection and detail publications.

`decodeLspCompletions` accepts arrays, CompletionList and null, including item defaults for edit
ranges, insertion format/mode, commit characters and opaque data. It validates primary and
additional same-document edits before exposing a choice. An explicit server range takes
precedence over the browser's bounded Unicode word fallback. Choices sort by `sortText`, with
stable provider order for equal keys, filter by a case-insensitive `filterText` prefix and honor
`preselect` when the prior choice is unavailable. Explicit invocation initially shows all choices;
`filterManualCompletions: true` applies the captured edit-prefix filter to manual requests too.

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

`accept(mode, completionId)` can queue acceptance while the selected item resolves; its boolean
reports whether the intent was accepted. `apply` attempts immediate application and returns false
while resolution is pending. Typing, selection changes, blur, cancellation or stale authority
clear queued acceptance. An unresolved commit character follows ordinary input and dismisses
the offer. A ready advertised commit character joins the completion in one transaction and
suppresses duplicate native insertion. Only single-UTF-16-unit commit characters participate.

`lspCompletionPlan(item, mode, commitCharacter?, capturedSelections?)` returns the complete edit
batch and resulting `selectionSet`. With multiple carets, the primary must match the item's
captured offset; all selections must be collapsed and ordered. Translated replacement ranges
must stay on each caret's line and contain the same text as the primary range. Each insertion
uses its own line context; shared additional edits apply once. Overlap or an incompatible caret
rejects the whole plan. Explicit browser requests support multiple collapsed carets; automatic
requests and list rebasing use one. Failed acceptance consumes its completion key instead of
falling through to indentation or Enter.

Primary and additional edits form one workspace transaction and shared undo command. Additional
edits before the primary insertion contribute to its final caret. A zero-width additional edit
may sit at a replacement boundary and precedes the replacement there. Two insertions at the same
position or intersecting replacements reject a completion. Other views receive mapped selections.

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

`createLspHoverClient(provider).run(document, offset, prepare?)` returns `{ result, cancel }`.
The result is null or a captured model with `text`, format-preserving `content`, optional `range`
and `isCurrent`. `decodeLspHover` accepts Hover/null, legacy strings and MarkedString arrays/code
fragments. Legacy strings retain Markdown format; `{ language, value }` fragments retain code
format. A hover does not need a range to be useful. The host owns placement, focus and dismissal.

`mountDocumentation` from `sttropez/browser` renders `DocumentationContent` into its own appended
subtree. `setContent` reuses an unchanged immutable array; `dispose` removes the view and listeners.
The renderer supports plaintext, paragraphs, emphasis/strong emphasis, flat ordered/unordered
lists, inline code, fenced code and inline links. Code language labels are metadata. It creates
text nodes and elements without inserting provider HTML or loading images/embedded content.
Inline parsing stops at nesting depth 16, leaving the remaining text literal. Link destinations
are interpreted only when their raw span is at most 8,192 UTF-16 units, before trimming or unescaping.

Links are buttons with opaque destinations. Without `openLink` they are inert. `canOpenLink` is
checked at rendering and activation, but the host callback must enforce its destination policy
too. Replacing content or disposing the view retires old buttons. This recipe uses explicit host
actions as its destination allowlist:

```ts
import type { DocumentationContent } from "sttropez/protocol";
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

Clear content when its request capture expires; the documentation view does not observe that
capture. The raw Markdown destination span, including whitespace/title, is bounded before parsing;
overlong spans render literally. The renderer never fetches, normalizes or opens a URI itself.
Set `markdownDocumentation: true` on the provider when the host presents this subset. Hover and
signature negotiation then prefers Markdown and declares no allowed HTML tags; default negotiation
is plaintext. Completion documentation uses plaintext independently.

### Signature help

`createLspSignatureClient(provider).run(document, offset, context?, prepare?)` returns a
cancellable call. `options(document)` supplies matching provider options for host trigger policy
through a [read-only capability query](language-server.md#feature-capability-queries).
`LspSignatureContext` carries trigger kind, optional trigger character, retrigger status and
optional `activeSignatureHelp`. Without a context, invocation is explicit and not a retrigger.

`decodeLspSignatureHelp` returns literal labels/documentation plus structured content, UTF-16
parameter offsets, active indices and immutable wire context. String parameter labels must occur
inside the signature label; tuple offsets must fit it. A signature's active parameter overrides
the batch value. Missing or out-of-range nonnegative indices select the first available entry;
zero parameters means no highlighted parameter. Null and empty help yield no useful presentation.

A retrigger without explicit active help can inherit the last accepted wire context after
matching document/resource/URI/language, connection epoch and registration generation. Starting
or superseding a request does not discard it. Empty help, a new non-retrigger invocation, client
cancellation/disposal or provider changes clear it. Explicit host context takes precedence.
Inherited context is omitted if it would exceed the advisory bound. It retains no old buffer and
grants no edit authority; cancelled late replies cannot replace it.

The host owns trigger/retrigger dispatch, input/composition readiness, overload controls, popup
placement and key priority when completion is also visible. Changing the displayed overload does
not edit text. Use [documentation presentation](#hover-and-documentation) for signature and
parameter content, and keep request lifetime independent of formatting.

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

The host owns URI policy, contents and access rights. Loading needs neither an editor view nor
`didOpen` and grants no permission to edit or open an external URL. Connect cancellation to host
loading and check context currentness before publishing loaded resources. Cancellation, disposal,
supersession and provider changes settle pending loading and release retention, including results
arriving late. Successful targets stay retained through the client's result lifetime; server-edit
targets stay through the decision. The complete batch is rechecked after loading.

Capture the source's complete selection set and view state for a host Return command. Pending
view intent can expire when selection/focus changes; published read-only result lists can instead
use resource/provider guards to allow navigation between results. An explicit reveal must use the
captured target, without retargeting to whichever tab is focused later. Read queries do not change
history or comparison baselines. An immutable comparison reference needs no provider binding.

### Rename and workspace edits

`createLspRenameClient(provider).run(project, originId, offset, newName, prepare?)` returns a
captured workspace text-edit plan. Null rename responses become empty plans. Language name rules
belong to the server; host input limits and name-field behavior are host policy.

`decodeLspWorkspaceEdit` accepts `changes` maps and versioned `documentChanges` text edits.
When both are supplied, `documentChanges` takes precedence. Numeric versions must match captured
wire versions; absent/null versions require current captured buffers too. Unknown URIs, repeated
document identities, invalid ranges, overlap or malformed final entries refuse the entire batch.
Edits sort stably in original coordinates, preserving provider order for equal-position inserts.
No newline normalization is performed. There are no extra decoder quotas on document/edit counts
or inserted text; session/transport bounds and direct-call input policy apply.

`previewLspWorkspaceEdit(edit, titleForDocumentId, page)` builds immutable review pages from the
captured buffers. It reports complete edit counts and insertion sizes while materializing only
the visible page's bounded notes. Previewing grants no edit authority. A host must make later
pages available and confirm the complete operation, including off-page edits.

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

The supplied intent guard must cover the captured tab/view, complete selections, input readiness,
name and host authority. Abort when that host intent ends; the review callback must close its UI
and settle on abort. The caller handles rejected promises. Each changed batch is a separate undo
unit across all edited resources,
including retained unmounted targets. Unrelated read-only project resources do not prevent edits
to permitted targets. Locked or unauthorized edited targets reject the atomic operation.

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

`decodeLspResolvedCodeAction` permits only the advertised `edit` property to be added. It preserves
all other attributes and data regardless of JSON object key order. Changed titles, inserted
commands, missing edits or stale captures refuse resolution. Discovery, selection and resolution
do not apply edits or execute commands.

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

Policy runs once per captured enabled command. `supports` takes that command object, not just its
name. A route's `isCurrent` can revoke it; call the client's `cancel()` when host policy changes
during pending work because the guard is not an observable subscription. A denied command makes
the whole edit-plus-command choice unavailable. Decoding a command grants no execution authority.

After explicit host authorization, `execute(action, scope)` uses `LspCommandScope` and the shared
command runner. It does not automatically apply `action.edit`: the host's synchronous `prepare`
phase applies any authorized initial edit and updates its captured snapshots/guards, then the
runner synchronizes those snapshots before dispatch. The lane is reserved before preparation,
so a competing operation cannot leave an initial edit behind. Host routes receive current
snapshots, cancellation and a captured `applyEdit` decision path; unsolicited server edits cannot
inherit a host-only route's authority. There is no script evaluator or automatic command lookup.

Each initial edit and confirmed later batch is a separate atomic undo phase. Refresh host captures
after an applied phase without releasing required retention prematurely. A later failure, refusal
or lost acknowledgement leaves earlier commits applied and undoable. Within the active operation,
receipts retain the first `applied: false` decision, including validation refusals, even if a later
batch succeeds. Command availability, quarantine, exact invocation grants and reconnect behavior
follow the [command lifecycle](language-server.md#commands-and-edit-decisions).

`decodeLspApplyEdit` validates an optional literal label and the entire workspace text-edit batch.
Incoming decisions return `LspApplyEditResult`; decline uses `applied: false` with an optional
failure reason. Protocol cancellation follows the request cancellation path. A successful local
commit cannot guarantee delivery of its acknowledgement on a closed transport. The host owns
review deadlines and reports uncertain outcomes without replaying the transaction.

### Document links

`createLspLinkClient(provider).run(document, prepare?)` returns `{ items, isCurrent, resolve }`.
`decodeLspDocumentLinks` validates source ranges, optional opaque targets, literal tooltips and
data. A missing target can be retained for explicit resolution when matching provider options
advertise it. `resolve(item, prepare?)` requires an item from that captured list.

`decodeLspResolvedDocumentLink` permits changes only to target and tooltip. Range and opaque
identity stay fixed; the same capture and input limits apply. Resolution does not open anything.
The host chooses whether a destination identifies an authorized resource or external action,
rechecks its policy on activation and preserves the captured source for Return. Unknown targets
can be shown without being opened. A late reply must not take focus from a newer host interaction.

### Document colors

`createLspColorClient(provider).run(document, prepare?)` returns `{ items, isCurrent, presentations }`.
`decodeLspDocumentColors` validates every range and RGBA value. `decodeLspColor` requires finite
channels in `[0, 1]`. `presentations(item, rgba, prepare?)` requires an item from the captured list
and returns validated choices for that same source.

`decodeLspColorPresentations` validates complete primary/additional edit plans. A missing primary
edit uses the literal presentation label at the captured color range. An invalid final choice,
overlap or out-of-document edit rejects the batch. Empty choices are unavailable for application.
Labels need not be color literals; the proposed-color input grammar belongs to the host.

The host renders markers, inspects choices and explicitly applies the selected edit batch with
its captured revision, selection mapping, authority and one history command. Retain the client
through preview/application. A changed proposed value or source expires the corresponding intent;
the host cancels it and requests fresh results. An unchanged presentation must preserve text,
revision, history and complete selections according to the workspace no-op contract.

### Occurrences

`createLspHighlightClient(provider).run(document, offset, prepare?)` returns a cancellable call
whose result includes `items`, `isCurrent` and indexed `intersect(from, to)`. The decoder
`decodeLspDocumentHighlights` validates every range and text/read/write kind; an omitted kind
means text. It retains all results within input limits, including overlapping ranges. Visible-row
queries skip unrelated intervals and omit zero-width markers without changing the stored items.

The browser `createLspHighlightController(workspace, tab, editor, { provider, delayMs? })` requests
after a quiet caret interval and waits for queued input/composition. It observes document,
selection, focus, tab and provider identity, clearing obsolete results. Subscribe to `state` to
invalidate the host's viewport decorations and call `intersect` while decorating visible lines.
Host styles distinguish occurrence kinds. `dispose` releases the client and listeners. The
controller changes neither text nor selection and leaves initial connection/retry policy to the host.

### Folding

Provider folds feed the per-view discovery controller with their captured `isCurrent` guard.
The [folding contract](folding.md#language-server-discovery) owns the client API, whole-line
conversion, invalid-range handling and groups. The host chooses discovery and collapse policy;
fold state belongs to a view independently of a language result or another comparison pane.

### Limits

String sizes below use UTF-16 units. [Session, transport and JSON limits](language-server.md#limits-and-failures)
also apply. Pure decoders called directly need host input-size policy; lack of a separate feature
quota is not an allocation bound. Complete list validation precedes host paging.

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

Render literal text or the documented presentation subset, with bounded visible lists and access
to all retained choices. Define shortcuts, popup placement, navigation/Return behavior, link
opening, name/color input policy and review controls. Keep rendering separate from application
state changes and dispose clients, subscriptions and content at their ownership boundaries.

Capture resource, revision, complete selections, tab/view, fold/input state and authority before
delayed work. Revalidate after awaits and before mutation or navigation. Keep provider results and
loaded targets retained until the decision ends. The browser completion/occurrence controllers
own their documented view coordination; headless clients provide protocol captures and leave
host intent guards to the caller. Use atomic workspace edits, preserve independently captured
Save/Run identities, and report applied phases accurately when later command work fails.

## Not covered

See the [support matrix](README.md#support-matrix) for unsupported features and consuming-host or
device qualification. Connection and reconnection policy belong to the language-server guide.
