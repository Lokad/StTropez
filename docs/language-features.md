# Language features

Attach a provider to inspect symbols, follow definitions and review edits at the caret.
[Connect a provider](language-server.md)

## Use

Set the document’s language ID and URI, then attach features to its editor.

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

Call `dispose()` on detach. Editor disposal also cancels requests. Attachments on one editor
and provider share the source binding and scope. Each pane owns its requests. The provider can
connect before or after attachment. [Capabilities and supported methods](language-server.md#capabilities-and-supported-subset)

## Contract

### Captures and ranges

Use `getSnapshot()` and `subscribe()` for state. Bind buttons to the choices returned for the initiating view,
selection and revision. Replacing the document or connection expires them. `cancel()` dismisses
a request. An `Outcome` is `done`, `stale`, `refused` with a reason or `failed` with an error.

`lspRangeOffsets` converts UTF-16 positions. Long columns clamp before the line ending.
Surrogate-half offsets stay exact. Invalid lines, negative or fractional positions and reversed
ranges fail validation.

### Diagnostics

`diagnostics: {}` paints pushed diagnostics. Severity defaults to error. Empty ranges get a
triangle and deprecated text gets a strike-through. `item.select()` reveals a current item.
`cancel()` pauses painting and `request()` resumes. For custom results, validate with
`decodeLspDiagnostics` from `sttropez/kernels` and paint with `diagnosticDecoration`.

`scope.observeDiagnostics(binding)` reports wire versions and placement. Versioned pushes must
match the wire version. Unversioned pushes have null provider version and revision.
`snapshotRevision` identifies the placement buffer. Fresh batches replace all items. Stale or
malformed pushes leave marks alone. Out-of-bounds items keep their message with null offsets.

Edits map surviving marks as `pending`. Fully deleted marks stay gone through Undo.
`isPlacementCurrent()` checks placement. `isCurrent()` requires fresh analysis. Only fresh,
versioned diagnostics overlapping the selection enter code-action requests.

### Completion

Enable `completion: { list: true }` or use `completion: {}` for custom rows. Position the list
at the snapshot’s `anchor` and hide it when null. Reuse rows while `choices` is unchanged.

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

| Input | Result |
| --- | --- |
| Ctrl/Cmd+Space or `completion.request()` | Explicit list. Enable `filterManualCompletions` to filter by prefix. |
| Type or backspace | Words and provider triggers open suggestions unless `automatic: false`. Prefix edits filter by `filterText`. Erasing the prefix closes the list. |
| Up/Down or PageUp/PageDown | Move by row or page. `sortText` orders rows and `preselect` sets the initial choice. |
| Enter / Tab | Replace the provider range / insert and keep the suffix. The fallback covers the selection or word. Escape dismisses. |

Incomplete lists keep their choices until replaced. `omittedCompletions` lists unsupported snippets
and follow-up commands. `item.accept()` returns `false` when stale. A `true` result may await
resolution. Typing, selection or permission changes cancel pending acceptance. A commit character
typed meanwhile enters as ordinary text. Acceptance and additional edits share one Undo.

Manual completion accepts a single-line selection or multiple insertion carets with identical
replacement text and nonoverlapping ranges. Additional edits apply once. Automatic completion
uses one caret or linked snippet fields.

**Snippets.** Tab and Shift+Tab visit fields. Typing or completion updates linked occurrences.
Alt+Up/Down cycles choices. Escape closes suggestions before the snippet. Tab finishes at `$0`.
Multiline inserts inherit local indentation and line endings unless `insertTextMode: 1` requests
literal insertion. [Snippet grammar](text-model.md#snippet-planning)

`completion.getDiagnostics()` exposes `lastCompletionBeforeInputMs` and `lastCompletionCommandMs`.
Both stop at handler return. [Interaction clocks](README.md#measuring-an-interaction)

### Hover and documentation

With `hover: { popup: true }`, dwell for 300 ms or press Ctrl+K Ctrl+I (Cmd on macOS).
Keyboard inspection reveals the caret and keeps focus and selection. Escape closes the card.

`hover.request()` inspects the caret, or pass `{ revision, offset }` for a pointer.
`"reuse"` shares a pending lookup or reuses the current symbol range. Read `content`, `range`
and diagnostics from the snapshot. Diagnostics can precede a symbol or outlive its failure.
Mapped marks read “Awaiting recheck”. Hover uses the same attachment’s diagnostics by default.
[Pointer dwell](editor.md#pointer-dwell)

`mountDocumentation` renders text, lists, emphasis, code and links as DOM nodes. It loads no
embedded media. Authorize link buttons at render and activation. Replacing content expires them.

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

Hover and signature help default to plaintext. Set `markdownDocumentation: true` for Markdown.
Completion uses plaintext.

### Signature help

Press Ctrl/Cmd+Shift+Space or call `signature.request()` with `signature: { popup: true }`.
This works in read-only views. Triggers such as `(` request help at the post-pairing caret.
Moving away before dispatch cancels the trigger.

Up/Down cycles overloads unless completion owns the keys. Escape closes the top popup.
For custom UI read the snapshot’s `signature` and `anchor`. Argument edits keep the label
during refresh. A comma clears the parameter highlight. Leaving the call, blur or composition
dismisses help. Retriggers keep the chosen overload. Explicit requests reset it. Parameter
offsets are UTF-16 and must fit the label.

### Navigation and target loading

Ctrl/Cmd+hover underlines a symbol. A click follows it even while lookup is pending.
Use `navigation.request("definition", offset)` in `onDefinition` to reuse that lookup.
`request("references", offset, false)` excludes declarations. `linkAt(offset)` can return a
range and `open()` to give document links precedence.

Supply project snapshots in `documents`. Page with `count` and `locationAt(index)`.
`choice.open(present)` reveals the captured range. Expired choices return `false`.
`resultLifetime: "view"` expires a list on selection or fold changes. The default survives
caret moves. A null reply is empty. Mixed location types, unknown targets or invalid ranges
reject the batch.

**Missing files.** Navigation, rename, code actions and incoming edits call
`LspWorkspaceOptions.resolveTarget(uri, context)`. Authorize the URI before loading it.
The context identifies the operation, source and cancellation.

| Return | Effect |
| --- | --- |
| `{ document: workspace.document(id) }` | Loads a workspace document with the requested URI. Edits require matching version and permissions. |
| `{ text, languageId }` | Supplies a read-only navigation target from a string or `TextBuffer`. |
| `undefined` | Declines the lookup and releases its other targets. |

Return `release()` for retained loads. Honor cancellation. Navigation shares repeated loads,
runs up to four at once and rechecks the batch afterwards. [Provider limits](language-server.md#limits-and-failures)

**Back.** Use `createNavigationHistory(workspace)` and `history.capture(editor)` before lookup.
Pass the clicked offset for a pointer jump. Capture can refuse a busy or retired view.
Call `origin.visit(() => …)` around a successful reveal. One origin gives a result list one Back
entry. A source edit before the visit expires it.

For `history.back(present)`, return the editor showing the original view, `undefined` to skip or
`"busy"` to defer. Back maps selection and scroll through edits and returns `"restored"`,
`"empty"` or `"busy"`. Pass `{ focus: true }` to focus it. Dispose history on teardown.
[View restoration](viewport.md#scrolling-and-saved-views)

### Rename and workspace edits

`rename: { popup: true }` enables F2 and `rename.start`. Enter previews, then Enter or **Apply
rename** commits. Escape returns to the editor. The popup pages 64 edits. Editing or changing
selection expires the preview.

Pass other project files in `rename.documents`. `rename.request(name)` applies directly.
Enable Apply when the preview’s `canApply` is true.

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

On success Apply returns the changed files. Cancel a pending rename when the name changes.
Refusal reasons include `empty-name`, `unavailable-view`, `not-writable` and `no-changes`.

**Workspace edits.** `documentChanges` takes precedence over `changes`. Unknown or repeated
documents, mismatched wire versions, invalid ranges and overlaps reject the whole batch.
Equal-position inserts keep provider order and inserted text keeps its line endings.
Rename skips identical replacements. One Undo from any changed file reverts the batch.

`preview.readEdits(first, end)` returns excerpts and a total, or `undefined` when expired.
An empty interval reads the total. Excerpts preserve surrogate pairs and CRLF. Apply uses full
text. For headless review, use `readLspEditNotes` and `applyLspWorkspaceEdit` from
`sttropez/kernels`. Recheck targets and permissions. Apply returns changed snapshots or throws
on refusal. Empty edits create no Undo entry.

### Code actions and commands

With `codeActions: { popup: true }`, Ctrl/Cmd+. opens fixes at the caret. Arrows select, Enter
previews or applies, and Escape closes. Pass a diagnostic’s choices to
`editor.commands.run("quickfix.show", choices)` to reuse them. `popup.quickApply` can approve
edit-only fixes. Commands need confirmation. A delayed fix leaves focus where the user moved it.
A custom toolbar can call `editor.focus()` to return to the source.

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

Supply `documents()` for cross-file edits. `select()` resolves and applies. To review first,
use `select({ review: true })`, show `preview.readEdits(first, end)` and call `preview.apply()`.
Repeated selections share a pending request. Another choice supersedes it. Resolution may
add an advertised edit. A changed title, command or opaque data invalidates it.

The initial edit commits as one Undo before any command runs. For each incoming edit use
`reviewCommandEdit(request, context, writable)`. Disable Apply for unwritable targets and
close approvals on `context.onCancel`. Earlier edits remain undoable on failure.

Build menus from `provider.commandNames()`. `commands.run(name, args)` records changed files
even if acknowledgement fails. Check `commandRequiresReconnect` after cancellation.
`codeActions.commandPolicy` receives the exact command and arguments. Return a server or local
route with revocable `isCurrent`, or `null` to disable it. Cancel requests on policy changes.
[Command approval and reconnect](language-server.md#commands-and-edit-decisions)

### Document links

`links.request()` returns the current list. Each choice has a range, tooltip, optional target
and `open(visit)`. Use `documents()` for cross-file mapping. `links: { paint: true }` underlines results.
`setPaint` toggles the shared scan. `linkAt(offset)` checks listed links before painted ranges.
Range ends are exclusive.

Authorize destinations in the host. For delayed navigation, abort the initiating gesture on
focus loss, another action or pane closure.

```ts
import type { DocumentLinkChoice } from "sttropez/browser";

export function openLink(link: DocumentLinkChoice, intent: AbortSignal, visit: (uri: string) => void) {
    return link.open(uri => {
        if (!intent.aborted) visit(uri);
    });
}
```

Resolution replaces the choice at the same list position and range. In a persistent list,
keep focus on the row, refresh its label and open its current choice on the next activation.
Caret movement cancels a pending navigation or lookup. Completed lists survive caret moves.
Edits, authority changes, a fresh request or disposal expire their actions.
[Reference host](../examples/reference/language.ts)

### Document colors

`colors: { picker: true }` enables swatches, color and opacity input, provider formats and
edit review. Opening keeps selection. Apply commits one Undo and returns focus to the editor.
Escape closes the picker. `picker.text` translates labels. To open from a menu, pass a current
`colorAt(offset)` mark or `colors.request()` choice to `openPicker`.

Use `swatches: true` for paint alone. A swatch callback overrides the picker. `setSwatches`
toggles the shared scan. `colorAt` returns only current marks.

For a custom picker call `choice.presentations(rgba)`. Channels must be finite and within
`[0, 1]`. On value change call `dismissPreview()` to expire the old Apply action.
`format.select()` applies directly. For review use `select({ review: true })`, display
`review.notes` and bind Apply to `review.apply()`. Notes hold excerpts and full `insertUnits`.
`review.edits` holds full replacements. Source, selection, fold, permission or format changes
expire approval. Read-only files allow review and refuse Apply.

The batch must contain valid nonoverlapping ranges. Without a primary edit the label replaces
the literal. Relative carets are preserved inside it. Identical text keeps revision and history.

### Occurrences

`occurrences: {}` paints text, read and write marks when input settles. A caret inside one
highlighted identifier reuses the result. Selections and overlapping ranges trigger a new
lookup. Blur, edits and provider changes clear the marks. Use `intersect(from, to)` for ranges
and `.st-occurrence-text`, `.st-occurrence-read` and `.st-occurrence-write` for styling.

### Folding

Pass the result and its `isCurrent` guard to each pane’s controller.
[Provider folds](folding.md#language-server-discovery)

### Limits

Text sizes below count UTF-16 units. Clients validate complete batches before display paging.
Diagnostics, completion, navigation, workspace edits, actions and occurrences use the shared
[session and transport limits](language-server.md#limits-and-failures).

| Feature | Bound |
| --- | --- |
| Completion | Word fallback 2,048 units each side. Rebase up to 2,048 inserted units. `maxDocumentUnits` bounds snippet expansion and the full plan. |
| Hover | 64 fragments, 8,192 units each, 128 per code language tag, 16,384 combined. |
| Documentation links | 8,192 units per raw destination. Nesting at depth 16 displays literally. |
| Signature | 32 signatures, 64 parameters each. Label 4,096, documentation part 16,384, total 65,536. Serialized advisory context 131,072, trigger 8. |
| Links | 1,024 items, URI/tooltip 4,096 each. Per item, 8,192 serialized data and 16,384 resolve payload. Display and opaque data each get 65,536 total. Both data and resolve payload count as opaque. |
| Colors | 1,024 marks, 64 presentations, labels 4,096. Up to 32 additional edits per choice, 1,024 edits total. Insertion 16,384, combined labels and insertions 65,536. |
| Edit excerpts | Title 128, removed and inserted text 256 each, with the full insertion length. Host sets page size. |
| Occurrences | `delayMs` defaults to 150 ms. Waits up to five seconds for queued input. Identifier reuse spans at most 4,096 units, end exclusive. |

## Host responsibilities

Authorize links and commands. Bind approval to the preview shown and close it on cancellation.
Keep Save available and show which edits committed if a later command fails.

## Not covered

Formatting, semantic tokens and completion follow-up commands are outside the
[supported language features](README.md#support-matrix).
