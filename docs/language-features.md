# Language features

Attach features per pane. A read-only baseline can offer hover and navigation while its working pane offers
fixes. [Provider setup](language-server.md)

## Use

Set the document URI and language ID, then choose controls.

```ts
import { attachEditorLanguage, type EditorLanguageAttachment, type EditorLanguageOptions, type TextEditor } from "sttropez/browser";
import type { LspWorkspace } from "sttropez/protocol";

const controls = {
    completion: { list: true },
    diagnostics: {},
    hover: { popup: true },
    signature: { popup: true },
    rename: { popup: true },
    codeActions: { popup: true },
    colors: { picker: true },
} satisfies EditorLanguageOptions;

export function attachLanguage(editor: TextEditor, provider: LspWorkspace): EditorLanguageAttachment<typeof controls> {
    return attachEditorLanguage(editor, provider, controls);
}
```

Features share a source binding. Each pane owns its requests. Disposing the attachment or editor removes the
controls.

## Contract

### Captures and ranges

Read `getSnapshot()` in `subscribe()` callbacks. Bind buttons to captured choices, which recheck document
and provider on invocation. Discard replies that have gone stale. `cancel()` dismisses the request.
[Command outcomes](README.md#api-conventions)

`lspRangeOffsets` maps UTF-16 positions, clamps long columns and keeps surrogate-half offsets exact. Invalid
lines, positions or reversed ranges fail validation.

### Diagnostics

`diagnostics: {}` paints pushes. `item.select()` reveals, `cancel()` pauses paint and `request()` resumes.
Each `EditorDiagnostic` has UTF-16 offsets `from` and `to`, a message, severity, source and optional code and
tags. Severity 1–4 selects `.st-diagnostic-error`, `.st-diagnostic-warning`, `.st-diagnostic-information`
or `.st-diagnostic-hint`. A missing severity uses the error style. Tag 2 adds `.st-deprecated`.

For problems, read `scope.observeDiagnostics(binding)`. During edits, `lastReport` retains provider messages,
`status` is `pending` and `result` maps surviving ranges. Disconnect or source replacement clears both results.

Versioned pushes must match the synchronized version. Unversioned pushes have null version and revision.
`isPlacementCurrent()` checks offsets and `isCurrent()` checks analysis. Only fresh versioned marks enter
code actions. Malformed or stale pushes leave the report intact. Unplaced items retain their messages.

Build a Problems list from the current marks. Each button retains the diagnostic it was created for.

```ts
import type { DiagnosticSnapshot } from "sttropez/browser";

export function showProblems(list: HTMLElement, snapshot: DiagnosticSnapshot) {
    list.replaceChildren(...snapshot.diagnostics.map(item => {
        const button = document.createElement("button");
        button.textContent = item.message;
        button.onclick = () => item.select();
        return button;
    }));
}
```

### Completion

`completion: { list: true }` mounts the list. For custom rows use `{}`, `snapshot.anchor` and captured
items.

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

Ctrl/Cmd+Space requests suggestions. `filterManualCompletions` enables prefix filtering. Words and trigger
characters open automatic suggestions unless `automatic: false`. Edits filter by `filterText`. `sortText`
orders choices and `preselect` selects the initial row. Use arrows or Page keys to move, Enter to replace
the provider range, Tab to insert preserving the suffix and Escape to dismiss. Left and Right within a word keep
the list visible and request choices at the new caret. Old rows cannot edit while that request is pending.
Custom controls can render feedback from `status`, `reason` and `omittedCompletions`.

An incomplete list stays during refresh. `item.accept()` can succeed while resolve is pending. Typing or
selection changes cancel pending acceptance. Insertion and additional edits apply once in one Undo. Manual
completion accepts a single-line selection or disjoint carets with identical replacement text.
`omittedCompletions` counts unsupported items.

Tab/Shift+Tab visit snippet stops, Alt+Up/Down cycles choices and Tab finishes at `$0`. Edits update linked
occurrences. Multiline text adopts local indentation and endings unless `insertTextMode: 1`.

### Hover and documentation

`hover: { popup: true }` opens on 300 ms dwell or Ctrl+K Ctrl+I (Cmd on Apple). Keyboard hover reveals the
caret and keeps focus. Escape dismisses. `hover.request()` takes the caret or `{ revision, offset }`.
`"reuse"` shares an existing symbol lookup. Diagnostics can appear first. Mapped marks show “Awaiting
recheck”.

`mountDocumentation` renders text, lists, emphasis, code and link buttons. Authorize links at render and
activation. Replacing content expires a button. Completion, hover and signatures default to plaintext. Hover
and signatures accept `markdownDocumentation: true`.

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

`signature: { popup: true }` enables Ctrl/Cmd+Shift+Space in either pane. Triggers use the caret after
pairing. A comma clears the parameter highlight pending refresh. Up/Down cycles overloads unless completion
owns the keys. Typing in the same argument list keeps the chosen overload while the server offers it
and it accepts the active parameter. Escape closes the top popup. Leaving the call, blur or composition dismisses help. Custom
controls read `signature` and `anchor`.

For a custom signature hint, extract the parameter span from the provider’s label.

```ts
import type { SignatureSnapshot } from "sttropez/browser";

export function currentParameter({ signature }: SignatureSnapshot) {
    if (!signature || signature.activeParameter === null) return;
    const range = signature.parameters[signature.activeParameter];
    return range && signature.label.slice(range.from, range.to);
}
```

### Navigation and target loading

Ctrl/Cmd+hover underlines a symbol. In `onDefinition`, `navigation.request("definition", offset)` reuses its
lookup. `request("references", offset, false)` excludes declarations. Use the [location chooser](controls.md) or read `locationAt(index)` up to `count`.
`choice.open(present)` validates the target. `resultLifetime: "view"` expires results on selection or fold changes.

Wire the chooser to your document-opening code for F12 and Shift+F12. It opens one destination directly
and offers a list for multiple results. Its callback receives the captured document and UTF-16 offsets.
Use `from` and `to` for the selection. `targetRange` includes the enclosing symbol when the provider supplies it.

```ts
import { attachEditorLanguage, type TextEditor, type NavigationDestination } from "sttropez/browser";
import type { LspWorkspace } from "sttropez/protocol";

export function attachNavigation(editor: TextEditor, provider: LspWorkspace,
    open: (destination: NavigationDestination) => void) {
    return attachEditorLanguage(editor, provider, { navigation: { chooser: { capture: () => open } } });
}
```

Supply participating snapshots in `documents`. For other URIs, the provider first looks for a unique open
workspace file. Only an unresolved URI reaches `resolveTarget(uri, context)`. Authorize it for the requested
operation and honor cancellation. Return `{ document: workspace.document(id) }` for a
matching workspace file, `{ text, languageId }` for a read-only string or `TextBuffer`, or `undefined` to
decline. Edits require matching version and permission. Supply `release()` for retained targets. Navigation
shares duplicate loads, runs four concurrently and validates the batch before display.

Create `createNavigationHistory(workspace)` and call `history.capture(editor)` before lookup. Pass the clicked
offset for a pointer jump. Wrap the reveal in `origin.visit` and return whether it succeeded. A successful new
jump clears Forward. Read the available counts from `history.getSnapshot().back` and `.forward`.

Call `history.back(current, present)` or `history.forward(current, present)` with the editor being left.
Both restore the saved selection and scroll, mapped through edits. Pass `{ focus: true }` to resume typing.
Return the requested view's editor from `present`. A busy or unavailable presentation can be retried.
Disposed views are skipped. Pass `undefined` for `current` if no editor is open to record a return position.

### Rename and workspace edits

`rename: { popup: true }` opens at the symbol with F2. Enter applies. Ctrl/Cmd+Enter previews. Set
`popup.review` to preview on Enter. Enable custom Apply while `preview.canApply`. Supply `rename.documents` for other files.
`rename.request(name)` applies directly.

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

`preview.readEdits(first, end)` returns paged excerpts and a total, or `undefined` on expiry. Approval
applies full edits. `documentChanges` takes precedence over `changes`. Unknown or duplicate targets, wrong
versions and overlapping edits reject the batch. Same-position inserts keep provider order. Undo from any
changed file reverts all.

### Code actions and commands

`codeActions: { popup: true }` binds Ctrl/Cmd+. to selection fixes. Arrows choose, Enter previews or
applies, Escape closes. `quickfix.show` reuses a diagnostic’s choices. A delayed fix edits its source while
typing stays in the newly focused field.

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

`choice.select()` approves an action. For review, `select({ review: true })`, page
`preview.readEdits(first, end)` and bind Apply to `preview.apply()`. New choices supersede pending
resolution. Clicking a choice applies it. Return false from `popup.quickApply` to require review.
Commands follow host policy.

Supply `documents()` for cross-file edits. Edits commit in one Undo before the command runs. The attachment calls
`reviewCommandEdit(request, context)` for writable targets. Close approval on `context.onCancel`.
Earlier edits stay undoable on later failure.

For a pane menu, attach `commands: {}` and call `attachment.commands.run(name, args)` with an advertised
name. A `done` outcome lists the changed documents. Build menus from `provider.commandNames()`. `codeActions.commandPolicy` receives the exact command and
arguments. Return a revocable server or local route, or `null`. After cancelling a sent command check
`commandRequiresReconnect`. [Command review](language-server.md#commands-and-edit-decisions)

### Document links

`links: { paint: true }` underlines links. `linkAt(offset)` checks the current list before painted ranges.
`links.request()` gives choices with range, tooltip and optional target. Authorize the destination and
cancel navigation if focus leaves its pane.

```ts
import type { DocumentLinkChoice } from "sttropez/browser";

export function openLink(link: DocumentLinkChoice, intent: AbortSignal, visit: (uri: string) => void) {
    return link.open(uri => {
        if (!intent.aborted) visit(uri);
    });
}
```

Resolve updates the row in place. Keep its focus and invoke the updated choice on the next click. Completed
lists survive caret movement. Edits, a new request, revoked authority or disposal expire actions.

### Document colors

`colors: { picker: true }` shows swatches, opacity, formats and edit review. Use `picker: "apply-on-change"`
to apply when the user commits a field or format. Both modes preserve the selection, group the edit into one
Undo and return focus to the editor. Escape dismisses the picker. `swatches: true` paints only. Pass
`colorAt(offset)` or a `colors.request()` choice to `openPicker`.

Custom pickers call `choice.presentations(rgba)` with channels in `[0, 1]`. On a new value,
`dismissPreview()` releases the old approval. `format.select()` applies immediately. For review,
`select({ review: true })`, display `review.notes` and bind Apply to `review.apply()`. `review.edits`
contains full replacements. Read-only panes permit inspection. Source, selection, fold, permission or format
changes expire approval.

A host color button can open the built-in picker at the caret. Read its offset when the button is pressed.

```ts
import type { DocumentColorController } from "sttropez/browser";

export function editColor(colors: DocumentColorController, offset: number) {
    const mark = colors.colorAt(offset);
    return mark ? colors.openPicker(mark) : false;
}
```

### Occurrences

`occurrences: {}` paints settled text, read and write marks. A caret inside a highlighted identifier reuses
the result. Edits, blur or provider changes clear it. Query with `intersect(from, to)`. Style
`.st-occurrence-text`, `.st-occurrence-read` and `.st-occurrence-write`.

To list writes in a selected range, query the current occurrence index.

```ts
import type { LspHighlightController } from "sttropez/browser";

export function writesInRange(occurrences: LspHighlightController, from: number, to: number) {
    return occurrences.intersect(from, to).filter(item => item.kind === "write");
}
```

### Folding

Pass the server’s fold ranges and freshness check to the requesting pane. The folding guide shows the adapter.
[Use provider folds](folding.md#language-server-discovery)

### Limits

Clients validate full replies before paging. Sizes count UTF-16 units.
[Session limits](language-server.md#limits-and-failures)

| Feature | Bound |
| --- | --- |
| Completion | Word fallback 2,048 units per side. Rebase up to 2,048 inserted units. `maxDocumentUnits` bounds snippet and plan. |
| Hover | 64 fragments, 8,192 units each, 128 per language tag, 16,384 combined |
| Documentation links | 8,192 per destination. After 16 nested levels display literal text. |
| Signature | 32 signatures, 64 parameters each. Label 4,096, documentation part 16,384, total 65,536. Advisory context 131,072, trigger 8. |
| Document links | 1,024 links. URI and tooltip 4,096 each, data 8,192, resolve payload 16,384. Display and opaque data each 65,536 total. |
| Colors | 1,024 marks, 64 formats, labels 4,096. Up to 32 additional edits/choice, 1,024 edits total. Insertion 16,384, combined text 65,536. |
| Edit excerpts | Title 128, removed and inserted text 256 each. Apply uses full replacements. |
| Occurrences | Delay 150 ms by default. Pending input wait up to 5 s. Reuse up to 4,096 identifier units. |

Completion `getDiagnostics()` times handlers. [Interaction clocks](README.md#measuring-an-interaction)

## Host responsibilities

Authorize links, target loads and command edits. Bind approval to the reviewed preview. Report files changed
before a command failure and keep Save available.
