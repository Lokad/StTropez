# Host integration

Capture the editor that receives an action. Its paste, dialog or toolbar callback can then finish
against the original pane after focus moves.

## Use

Read clipboard data during the paste event. Return a callback for formats you handle. Here HTML goes
to a converter and plain text goes to the editor.

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

## Contract

### Captured view requests

Call `captureViewRequest(editor.workspace, editor.tab, editor.view, options)` before awaiting a
pane-local result. Omit `editOrigin` for reads. Edits require permission and an unlocked resource.
The capture expires on a change to its revision, selections, visible folds, edit authority or tab
target.

Keep it while showing the result. `commit(operation)` consumes it once or returns `false` if stale.
Use `available` for host-specific checks. Cancel on dismissal, pane disposal or expiry of a host
condition. Release outside workspace notification delivery. [Analysis example](architecture.md#use)

### Captured insertion and structured paste

In `registerPasteHandler`, preparation is read-only. A read-only pane refuses paste. Queued editing
and navigation use literal paste at the eventual selection. Removing the handler cancels its
conversion. [HTML paste example](#use)

For toolbar insertions, `editor.captureInsertion()` returns one target or `undefined` for a busy,
composing or read-only pane. Typing, selection changes, a replacement capture or teardown can expire
it. Pass `signal` to the converter. Check `pendingInput` in `editor.activity()` before acting on
settled text.

Call `insert(text)` for all selections or pass one string per range in selection order. Edit
transforms and Undo apply to the whole change. An empty entry deletes its selection if another
contains text. An all-empty result consumes the target and returns `false`. Call `cancel()` to
discard it. [Table conversion](examples.md#table-conversion)

### Tokenization, annotations and forms

Register `markTodo` with `editor.decorations.addProvider({ order: 0, provide: markTodo })`. A
fragment can start mid-line. For multiline syntax, cache lexical state by revision and invalidate
changed rows. Color each comparison pane from its own buffer.
[Decoration layers](viewport.md#decoration-layers)

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

Map notes through each edit. Retain deleted notes in the host if Undo should restore them.

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

Use `afterLine` for a label or position a host control at the rendered row. Forms that edit source
use workspace history. Capture both resources when copying to separately versioned settings.
[Geometry](viewport.md#geometry-and-readiness) ·
[Form example](examples.md#source-backed-transfer-form)

### Navigation, commands and lifecycle

Bind controls to the pane that owns them. For Back, retain its selections, folds and scroll.
[View state](viewport.md#scrolling-and-saved-views)

```ts
import type { TextEditor } from "sttropez/browser";

export function editingActions(editor: TextEditor) {
    return editor.commands.list()
        .filter(entry => entry.id === "line-comment" || entry.id === "indent")
        .map(entry => ({ ...entry, run: () => editor.commands.run(entry.id) }));
}
```

Consume a shortcut when its command applies. Leave composition, AltGraph and host fields to their
handlers. Mount shadow-DOM editors with their CSS in the same root. Dispose the controls and editor
before removing the nodes. [React mounting](getting-started.md#mount-an-editor-in-react)

### Edit intent

`editor.onEditIntent(listener, signal?)` reports `beforeinput`, `compositionstart`, `paste` and
`cut` before handling. Use it to dismiss a preview. One gesture can send several events or leave the
text untouched. Dispose the registration or abort its signal.

### Input conflict recovery

Listen on `editor.element` through disposal to capture uncommitted input. The events bubble within
the DOM root.

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

`editRefusedEvent` explains a blocked gesture with `documentId` and `"read-only"` or
`"edit-locked"`. `inputConflictEvent` carries `documentId`, `expectedRevision`, `reason` and
`attemptedText`. Use `attemptedEdit` when available for the UTF-16 replacement span. `contextFrom`
alone can be zero for a pending insertion.

Validate event data and identity before storage. The optional `cause` may be unsuitable for
persistence. Recheck the revision when the user chooses to recover.

### Save, Run and draft recovery

Use a shared [save queue and reviewed retry](workspace.md#save-and-conflicts) for persistence. Run
uses host-selected inputs. A recovery draft needs its own storage policy.

- Capture the persistent resource key and revision. Mark the draft covered after storage commits.
- Compare the storage token inside a write or discard. Preserve a newer peer draft and notify other
  pages.
- Show the validated draft alongside the newly loaded file. On confirmation, recheck resource,
  revision, server version and permissions. Restore in one Undo step against the saved baseline.
- Before closing, check for uncovered edits, composition, pending input and unfinished services.
  Keep rejected input separate from committed text. [Draft example](examples.md#draft-checkpoints)

### Bounds and validation

Limit input, parsed structure, aggregate output across selections and final document size. Choose an
annotation budget, storage partition, schema and retention period.

## Host responsibilities

Own parsers, routing and persistence. Schedule writes after observer delivery. Dispose pane captures
and controls with the view and release document services with their resource.

## Not covered

Verify OS clipboard formats, permissions and native input in the target application.
[Support matrix](README.md#support-matrix)
