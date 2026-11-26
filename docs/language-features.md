# Language features

Attach language features to each editor that needs them. A read-only review pane can have its own
hover and navigation while the working pane offers edits. [Connect a provider](language-server.md)

## Use

Give the document a URI and language ID. Choose the controls to mount with the editor.

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

The editor and provider share one source binding across these features. Each pane owns its
requests. Dispose the attachment to remove the controls. Disposing the editor also releases it.

## Contract

### Captures and ranges

Render state from `getSnapshot()` and `subscribe()`. Bind a button to the choice the user saw.
Its method checks the document and provider when invoked. Requests return `done`, `stale`,
`refused` with a reason, or `failed` with an error. `cancel()` dismisses a request.

`lspRangeOffsets` maps UTF-16 positions. Long columns clamp at line end. Surrogate-half offsets
stay exact. Invalid lines or positions and reversed ranges fail validation.

### Diagnostics

`diagnostics: {}` paints server pushes. `item.select()` reveals the diagnostic. `cancel()` pauses
painting and `request()` resumes it. Use `scope.observeDiagnostics(binding)` for the underlying
wire version and placement, or `decodeLspDiagnostics` with `diagnosticDecoration` for custom paint.

A versioned push must match the synchronized version. An unversioned push has null provider
version and revision. `snapshotRevision` identifies where marks are placed. Edits map surviving
marks as pending. `isPlacementCurrent()` checks their location and `isCurrent()` checks the
analysis. Only fresh, versioned marks overlapping the selection enter a code-action request.
Stale or malformed pushes preserve existing marks. An out-of-bounds item keeps its message.

### Completion

Use `completion: { list: true }` for the built-in list. For custom rows use `{}`, position them
at `snapshot.anchor` and bind each to its captured item.

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

| Input | Action |
| --- | --- |
| Ctrl/Cmd+Space | Request suggestions. Set `filterManualCompletions` for prefix filtering. |
| Typing or Backspace | Words and trigger characters can open the list. Edits filter by `filterText`. Set `automatic: false` for explicit requests only. |
| Arrows or PageUp/PageDown | Move by row or page. `sortText` orders choices and `preselect` picks the initial row. |
| Enter / Tab | Replace the provider range / insert and keep the suffix. Escape dismisses. |

An incomplete list stays visible during refresh. `item.accept()` can return `true` while resolve
is pending. Typing or changing the selection cancels pending acceptance. Additional edits apply
once with the insertion in one Undo. Manual completion accepts a single-line selection or
nonoverlapping carets with identical replacement text. `omittedCompletions` reports unsupported items.

Tab and Shift+Tab visit snippet fields, Alt+Up/Down cycles choices, and Tab finishes at `$0`.
Edits follow linked occurrences. Multiline inserts adopt local indentation and endings unless
`insertTextMode: 1` requests literal text. [Snippet planning](text-model.md#snippet-planning)

### Hover and documentation

With `hover: { popup: true }`, dwell for 300 ms or press Ctrl+K Ctrl+I (Cmd on Apple). Keyboard
hover reveals the caret and keeps focus. Escape closes the card. `hover.request()` uses the
caret or a supplied `{ revision, offset }`. Pass `"reuse"` to share a lookup at the same symbol.
Diagnostics can appear before a symbol reply. Mapped marks show “Awaiting recheck”.

`mountDocumentation` renders text, lists, emphasis, code and link buttons. Authorize a link at
render and activation. Replacing content expires the button. Hover and signature help accept
`markdownDocumentation: true`. Both default to plaintext, as does completion.

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

### Signature help

`signature: { popup: true }` enables Ctrl/Cmd+Shift+Space, including in read-only views.
Provider triggers use the caret after pairing. A comma clears the parameter highlight while
the call refreshes. Up/Down cycles overloads unless completion owns the keys. Escape closes
the top popup. Leaving the call, blur or composition dismisses help. Custom UI reads
`signature` and `anchor` from the snapshot.

### Navigation and target loading

Ctrl/Cmd+hover underlines the symbol. In `onDefinition`, call
`navigation.request("definition", offset)` to reuse the lookup when clicked. Use `request("references", offset, false)` to exclude
declarations. Page results with `count` and `locationAt(index)`. `choice.open(present)` checks the
captured target before revealing it. The default result survives caret movement. Set
`resultLifetime: "view"` to expire results when selections or folds change.

Supply open project snapshots in `documents`. For a missing URI, `resolveTarget(uri, context)`
receives the requesting operation and source. Authorize the URI, honor cancellation and return
one of the following.

| Return | Target |
| --- | --- |
| `{ document: workspace.document(id) }` | A workspace document with that URI. Edits require matching version and permissions. |
| `{ text, languageId }` | A read-only navigation destination. Text can be a string or `TextBuffer`. |
| `undefined` | Decline the lookup. |

Supply `release()` with a retained target. Navigation shares duplicate loads, runs up to four
at once and validates the batch before display. [Provider limits](language-server.md#limits-and-failures)

For Back, use `createNavigationHistory(workspace)`. Capture the origin with `history.capture(editor)`
before the lookup, passing the clicked offset for a pointer jump. Wrap a successful reveal in
`origin.visit`. `history.back(present)` asks for the editor showing the original view. Return
`"busy"` to defer or `undefined` to skip it. Back restores mapped selection and scroll. Set
`focus: true` to resume typing there. [View restoration](viewport.md#scrolling-and-saved-views)

### Rename and workspace edits

`rename: { popup: true }` binds F2. Enter previews the name, then Enter applies. Escape returns
to the editor. For a custom review, enable Apply only while `preview.canApply`. Pass other
project files in `rename.documents`. `rename.request(name)` applies directly.

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

`preview.readEdits(first, end)` pages excerpts and gives a total. An expired preview returns
`undefined`. Approval applies full edits. `documentChanges` takes precedence over `changes`.
Unknown or repeated targets, mismatched versions or overlapping edits reject the batch.
Same-position inserts keep provider order. One Undo from a changed file reverts the batch.
[Workspace edits](language-server.md)

### Code actions and commands

With `codeActions: { popup: true }`, Ctrl/Cmd+. shows fixes for the selection. Arrows choose,
Enter previews or applies, and Escape closes. `quickfix.show` can reuse a diagnostic's captured
choices. A delayed fix applies to its source and leaves typing in the field the user moved to.

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

Use `choice.select()` for an approved action. To show a review first, call `select({ review: true })`,
page `preview.readEdits(first, end)` and bind Apply to `preview.apply()`. A new choice supersedes
pending resolution. `popup.quickApply` can approve edit-only fixes. Commands need confirmation.
A custom toolbar can explicitly focus its editor after Apply.

Supply `documents()` for cross-file edits. A fix's edits commit in one Undo before its command
runs. Use `reviewCommandEdit(request, context, writable)` for each incoming edit and close the
approval on `context.onCancel`. Earlier edits stay undoable if a later step fails.

Build command menus from `provider.commandNames()`. `codeActions.commandPolicy` receives the
exact command and arguments. Return a revocable server or local route, or `null` to decline.
After cancelling a sent command, check `commandRequiresReconnect` before another request.
[Command approval and reconnect](language-server.md#commands-and-edit-decisions)

### Document links

`links: { paint: true }` underlines links. `linkAt(offset)` checks the current list before painted
ranges. `links.request()` returns choices with a range, tooltip and optional target. Authorize
the destination in the host and cancel the navigation gesture if focus leaves its pane.

```ts
import type { DocumentLinkChoice } from "sttropez/browser";

export function openLink(link: DocumentLinkChoice, intent: AbortSignal, visit: (uri: string) => void) {
    return link.open(uri => {
        if (!intent.aborted) visit(uri);
    });
}
```

Resolution updates a choice in place in the list. Keep focus on the row and use its new choice
on the next click. A completed list survives caret movement. Edits, a new request, revoked
authority or disposal expire its actions. [Reference host](../examples/reference/language.ts)

### Document colors

`colors: { picker: true }` enables swatches, opacity, provider formats and edit review. Opening
preserves the selection. Apply takes one Undo and returns focus to the editor. Escape closes.
Use `swatches: true` for paint alone. From a menu pass a current `colorAt(offset)` mark or
`colors.request()` choice to `openPicker`.

For a custom picker, call `choice.presentations(rgba)` with channels in `[0, 1]`. On a new value,
call `dismissPreview()` to release the old Apply action. `format.select()` applies immediately.
To review, use `select({ review: true })`, show `review.notes` and bind to `review.apply()`.
`review.edits` holds full replacements. Read-only panes let the user inspect the edit.
A change to the source, selection, folds, permission or format expires approval.

### Occurrences

`occurrences: {}` paints text, read and write marks after input settles. A caret inside a
highlighted identifier reuses the result. Edits, blur and provider changes clear the marks.
Query ranges with `intersect(from, to)`. Style them with `.st-occurrence-text`,
`.st-occurrence-read` and `.st-occurrence-write`.

### Folding

Pass the provider result and its `isCurrent` guard to the controller for the pane that requested
it. [Provider folds](folding.md#language-server-discovery)

### Limits

Clients validate the complete reply before paging results. Text sizes count UTF-16 units.
[Session and transport limits](language-server.md#limits-and-failures)

| Feature | Bound |
| --- | --- |
| Completion | Word fallback 2,048 units on either side. Rebase up to 2,048 inserted units. `maxDocumentUnits` bounds the snippet and plan. |
| Hover | 64 fragments, 8,192 units each, 128 per code language tag, 16,384 combined. |
| Documentation links | 8,192 per destination. After 16 nested levels, content displays literally. |
| Signature | 32 signatures, 64 parameters each. Label 4,096, documentation part 16,384, total 65,536. Advisory context 131,072, trigger 8. |
| Document links | 1,024 links. URI and tooltip 4,096 each, data 8,192, resolve payload 16,384. Display and opaque data each get 65,536 total. |
| Colors | 1,024 marks, 64 formats, labels 4,096. Up to 32 additional edits per choice, 1,024 edits total. Insertion 16,384, combined text 65,536. |
| Edit excerpts | Title 128, removed and inserted text 256 each. The workspace edit uses the full replacements. |
| Occurrences | Default delay 150 ms. Waits up to five seconds for pending input. Identifier reuse spans up to 4,096 units. |

Completion timings from `getDiagnostics()` stop at handler return. [Interaction clocks](README.md#measuring-an-interaction)

## Host responsibilities

Authorize external links, target loads and command edits. Bind each approval to the preview the
user reviewed. Report which files changed if a later command fails, and keep Save available.

## Not covered

Formatting, semantic tokens and completion follow-up commands are outside the
[supported language features](README.md#support-matrix).
