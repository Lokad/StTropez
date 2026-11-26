# Host integration

A host can add syntax colors, notes, structured paste and source-backed forms to an editor.
Keep metadata in the host. Apply text changes through the workspace so users can undo them.

## Use

Mark each `TODO` in the visible fragment with a decoration.

```ts
import type { InlineDecoration, LineDecorator } from "sttropez/browser";

export const markTodo: LineDecorator = line => {
    const decorations: InlineDecoration[] = [];
    for (let at = line.text.indexOf("TODO"); at >= 0; at = line.text.indexOf("TODO", at + 4)) {
        decorations.push({ from: line.from + at, to: line.from + at + 4, className: "host-todo" });
    }
    return decorations;
};
```

Read clipboard formats during the paste event. This handler converts HTML and lets the editor
handle plain text. It bounds the output across all selected ranges before insertion.

```ts
import type { TextEditor } from "sttropez/browser";

export function attachConvertedPaste(
    editor: TextEditor,
    convert: (html: string, signal: AbortSignal) => Promise<string>,
    report: (message: string) => void
): () => void {
    return editor.registerPasteHandler(data => {
        if (!data.types.includes("text/html")) return;
        const html = data.getData("text/html");
        return target => {
            if (html.length > 262_144) {
                target.cancel();
                report("Clipboard HTML exceeds the conversion limit.");
                return;
            }
            void (async () => {
                try {
                    const text = await convert(html, target.signal);
                    if (!target.isCurrent()) return;
                    if (text.length * target.selectionSet.ranges.length > 4_194_304) {
                        report("Converted text exceeds the insertion limit.");
                        return;
                    }
                    target.insert(text);
                } catch (error) {
                    if (!target.signal.aborted) report(String(error));
                } finally {
                    target.cancel();
                }
            })();
        };
    });
}
```

Map a note through every document change, including edits delivered together. Drop it if the
text it refers to is deleted or the document closes. Draw it when its revision matches the editor.

```ts
import { anchoredRange, type AnchoredRange, type DocumentId, type Workspace } from "sttropez";

export function trackNote(workspace: Workspace, documentId: DocumentId, from: number, to: number) {
    const document = workspace.document(documentId);
    const observed = workspace.observeDocument(documentId);
    let revision = document.revision;
    let range: AnchoredRange | undefined = anchoredRange(document.buffer.length, from, to, { onDelete: "invalidate" });
    const stop = workspace.onDocumentChange(documentId, change => {
        range = range && change.previousRevision === revision ? change.mapping.mapRange(range) : undefined;
        revision = change.revision;
    });
    return { getSnapshot: () => observed.getSnapshot()?.revision === revision ? range : undefined, dispose: stop };
}
```

Keep the input-conflict listener through disposal so it can recover uncommitted composition text.

```ts
import { inputConflictEvent } from "sttropez/browser";
import type { TextEditor } from "sttropez/browser";
import type { DocumentId } from "sttropez";

export function ownInputRecovery(
    editor: TextEditor,
    validateAndRetain: (documentId: DocumentId, detail: unknown) => void
): () => void {
    const documentId = editor.view.documentId;
    const listeners = new AbortController();
    editor.element.addEventListener(inputConflictEvent, event => {
        validateAndRetain(documentId, (event as CustomEvent<unknown>).detail);
    }, { signal: listeners.signal });
    return () => {
        try { editor.dispose(); }
        finally { listeners.abort(); }
    };
}
```

Bind toolbar actions to the editor they belong to. Remove the controls on unmount.

```ts
import type { TextEditor } from "sttropez/browser";

export function editingActions(editor: TextEditor) {
    return editor.commands.list()
        .filter(entry => entry.id === "line-comment" || entry.id === "indent")
        .map(entry => ({ ...entry, run: () => editor.commands.run(entry.id) }));
}
```

## Contract

### Captured view requests

Pass `editor.workspace`, `editor.tab` and `editor.view` to `captureViewRequest`. A tab mount supplies
its tab generation. A document mount supplies `undefined`. The capture retains the document,
directed selections and folding snapshot. Foreign views, mismatched tabs and unavailable documents
are refused. For a pane-owned request, cancel on `editor.signal`. [Analysis example](architecture.md#use)

Omit `editOrigin` for reads, including in a read-only pane. For edits, the origin needs permission
and an unlocked resource. A change to the revision, selection, visible folds or edit authority
expires the capture immediately. Changes to focus, expanded fold metadata or save permission alone
preserve it. Use `available` for a synchronous, read-only host check. Cancel when an unobserved host
condition changes.

Keep the capture while showing a result. On acceptance, `commit(operation)` consumes it once or
returns `false` if it expired. The callback runs synchronously, returns a boolean and applies any
transaction under the usual revision, permission and history checks. Its lease lasts until the
callback returns or throws. On dismissal call `cancel()` outside workspace notification delivery.
Invalidation from an observer releases the lease and aborts the signal in a microtask.

### Captured insertion and structured paste

`editor.registerPasteHandler(prepare)` installs a handler for the mount. In `prepare(data)`,
read the clipboard while the event is live. Workspace state is read-only here. Return `undefined`
for literal paste or a callback that receives a single-use insertion. Removing the handler cancels
its pending insertion. Read-only panes reject paste before preparation. During ordered input or
navigation the editor queues literal paste at the eventual selection. Composition and cancelled
paste bypass conversion.

For a toolbar insertion, use `editor.captureInsertion(kind)`. The default history kind is `paste`,
with `replace` also available. An unavailable, read-only, composing or busy view returns `undefined`.
The handle captures the document ID, revision, length, selections and visible folds. It exposes
`isCurrent()` and an abort signal. Only one insertion can be pending in a pane.

| Action | Effect |
| --- | --- |
| `insert(text)` | Inserts one string at every selection. Edit transforms, snippet mirrors and Undo apply to the whole change. |
| `insert(strings)` | Replaces each range in `selectionSet.ranges` order. Supply one string per range. An empty entry deletes that range if another entry has text. An entirely empty result consumes the capture and returns `false`. |
| `cancel()` | Discards the insertion. Repeated calls are safe. |

A toolbar click preserves the target. Editing, navigation input, composition, changed selections,
visible folds or permissions, language reconfiguration, a replacement capture or disposal expire it.
Later typing cancels conversion and proceeds. Check `editor.activity().pendingInput` before a
command that needs settled text. Completion or cancellation aborts the signal. Observer-triggered
cleanup runs in a microtask.

Limit source size, parsed structure, aggregate replacement size and final document length.
Cooperative conversion can yield between steps. Clipboard reads, native HTML parsing, final
string assembly and the edit commit run synchronously. [Table conversion](examples.md#table-conversion)

### Tokenization, annotations and forms

A visible fragment can start inside a string or comment. Cache lexical context by document and
revision, bound source reads and invalidate the provider when tokens are ready. Tokenize the saved
side of a comparison from its own buffer. A failed attachment releases its subscriptions and leases.
Offer Retry with the same limits while the user edits, reviews or searches.
[Decoration layers](viewport.md#decoration-layers) · [Editing rules](editor.md) · [Folding](folding.md) · [Character warnings](unicode.md#character-warnings)

Use `onDocumentChange` for anchored metadata that must follow each edit. Map surviving ranges on
Undo and Redo. To restore a deleted note with Undo, the host must retain it. Use `afterLine` for
a text annotation. Place interactive controls in host UI and update their geometry after scrolling,
folding, layout or resize. A folded range can project to its header. Hide or label a control if
`rowBounds` has no rendered row. [Anchored ranges](text-model.md#position-maps-and-anchors) · [Viewport geometry](viewport.md#geometry-and-readiness)

For a source-backed form, parse the captured range and write the field through workspace history.
To copy into separately versioned settings, capture the destination too. [Source-backed form](examples.md#source-backed-transfer-form)

### Navigation, commands and lifecycle

Before following a delayed result, recheck its resource, tab, revision and view. For Back, save the
selections with their affinities, scroll position and folds. Use the mapped selections after edits.
[Retaining a loaded resource](workspace.md#loading-and-resource-lifetime)

Route shortcuts to the intended pane and check whether its command applied. Leave composition,
AltGraph text and editable host fields to their own handlers. Prevent the browser default only for
handled shortcuts.

Mount shadow-DOM editors and their CSS in the same root. Dispose dependent controllers, then the
editor, before removing their nodes. Document and recovery services can outlive a remount.
[Mounting in React](getting-started.md#mount-an-editor-in-react)

### Edit intent

`editor.onEditIntent(listener, signal?)` reports `beforeinput`, `compositionstart`, `paste` or
`cut` before the pane handles it. Use it to dismiss a preview. One gesture can send several events
or leave the text unchanged. Dispose the registration or abort its signal to unsubscribe.
Editor disposal also removes it.

### Input conflict recovery

Listen on `editor.element`. Both events bubble within the DOM root, including a closed shadow root.

| Event | Host action |
| --- | --- |
| `editRefusedEvent` | Explain a blocked keystroke, cut or paste. `EditRefusedDetail` gives the document ID and reason. A read-only mount or missing human edit permission reports `"read-only"`. An edit lease on an otherwise editable view reports `"edit-locked"`. |
| `inputConflictEvent` (`sttropez-conflict`) | Retain input that could not be applied, including input pending when permission changed. `InputConflictDetail` gives `documentId`, `expectedRevision`, `reason` and `attemptedText`. It can also carry `contextFrom`, `attemptedEdit` and `cause`. |

Offsets count UTF-16 units at the captured revision. Attempted text can be a native value, a context
slice or pending insertion text. Insertion recovery can report `contextFrom: 0`. Use `attemptedEdit`
when available to locate the change. The detail and edit are frozen. A cause can be mutable or
unsuitable for storage.

Scripts can dispatch events with the same name. Validate the fields and document identity before
storing recovery data. Preserve source and history until the user chooses to recover, then check the
current revision.

### Save, Run and draft recovery

Write the captured save ticket through the host's storage service. Enforce its version precondition
at the write and let the user review a competing save. Run uses the inputs and permissions the host
chooses. A local recovery checkpoint only stores the draft. [Save and conflicts](workspace.md#save-and-conflicts) · [Retry after review](workspace.md#retry-after-review)

| Draft operation | Host responsibility |
| --- | --- |
| Checkpoint | Use a persistent resource key. Capture the version before serializing and mark it covered only after the write commits. A failed write, later edit or peer change requires a fresh coverage check. |
| Write or discard | Compare the storage token inside the write. Preserve a newer peer draft and notify other open pages when their cached coverage expires. |
| Restore | Validate record format, identity, bounds and value. Show the stored draft alongside the freshly loaded file. After the read, recheck destination revision, server version, generation and permissions. Restore the confirmed draft in one Undo step, retaining the current saved baseline and server precondition. |
| Close or reload | Check for edits missing from the checkpoint, active composition, pending input and unfinished services. Wait for composition before checkpoint or restore. Keep rejected input and preedit separate from committed text. |

Use fresh history and service requests for the new session. Close storage, observers and navigation
listeners when the host closes. [Draft example](examples.md#draft-checkpoints)

### Bounds and validation

Hosts set parser, annotation and storage budgets. Cap note count and text length, validate imported
structures before constructing output, and choose a recovery schema, storage partition and retention
policy. The clipboard example caps both input and output across selections.

## Host responsibilities

Keep workspace observers read-only and schedule mutations after delivery. Dispose captures and controls
with their view and release resource services with the resource. Parsers, routing, persistence and
application state belong to the host. Measure presentation separately from input handling and provider
time. [Measurement glossary](README.md#glossary)

## Not covered

Check OS clipboard formats, permissions and physical input in the target application.
[Support matrix](README.md#support-matrix)
