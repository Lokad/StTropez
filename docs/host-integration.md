# Host integration

Bind paste, toolbar and dialog actions to the pane where they started.

## Use

Read the clipboard during the paste event. Return a converter for formats the host handles.

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

Call `captureViewRequest(editor, options)` before the first `await`. Omit
`editOrigin` for reads. Edits need permission for the chosen origin. A revision, selection, visible-fold,
or edit-authority change expires the capture. Disposing the editor aborts outstanding requests,
even when a new mount reuses its document view.

`commit(operation)` consumes the capture or returns `false` if stale. Use `available` for host checks.
Cancel on dismissal and release outside notification delivery.
[Analysis example](architecture.md#use)

### Captured insertion and structured paste

`registerPasteHandler` prepares a conversion without editing. A read-only pane refuses paste.
Literal paste uses the current selection. Removing the handler cancels conversion.

`editor.captureInsertion()` returns `undefined` while busy, composing or read-only. Typing, selection
changes, a new capture or disposal can expire the target. Pass its `signal` to the converter. `insert(text)`
replaces all selections in one Undo step. For distinct replacements, pass one string per selection in order.
Empty entries delete their selections. An all-empty result consumes the target and returns `false`. Use
`cancel()` to discard it. [Table conversion](examples.md#table-conversion)

### Tokenization, annotations and forms

Register `markTodo` with `editor.decorations.addProvider({ order: 0, provide: markTodo })`. A fragment can
start mid-line. Cache multiline lexical state by revision, invalidate changed rows and tokenize each
comparison pane from its own buffer. [Decoration layers](viewport.md#decoration-layers)

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

Map notes through edits. Keep deleted notes if Undo should restore them.

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

Use `afterLine` for labels or anchor a host control to the row. Source forms use workspace history. Copying
to versioned settings needs both revisions. [Geometry](viewport.md#geometry-and-readiness) ·
[Form example](examples.md#source-backed-transfer-form)

### Navigation, commands and lifecycle

Bind commands to a specific pane. Save its selections, folds and scroll position for Back.
[View state](viewport.md#scrolling-and-saved-views)

```ts
import type { TextEditor } from "sttropez/browser";

export function editingActions(editor: TextEditor) {
    return editor.commands.list()
        .filter(entry => entry.id === "line-comment" || entry.id === "indent")
        .map(entry => ({ ...entry, run: () => editor.commands.run(entry.id) }));
}
```

Consume handled shortcuts. Leave composition, AltGraph and host fields to their handlers. In a shadow root,
install the editor CSS there. Dispose controls and editor before removing their nodes.

### Edit intent

`editor.onEditIntent(listener, signal?)` reports `beforeinput`, `compositionstart`, `paste` and `cut` before
handling. Use it to dismiss previews. A gesture may emit several events or make no edit. Dispose the
listener or abort its signal.

### Input conflict recovery

Listen on `editor.element` through disposal. Both events bubble within the DOM root.

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

`editRefusedEvent` gives the `documentId` and refusal reason (`read-only`).
`inputConflictEvent` carries the document ID, reason, `expectedRevision` and `attemptedText`.
Prefer `attemptedEdit` for the UTF-16 span. `contextFrom` alone can be zero for a pending insertion.
Validate event data before storage, omit unsuitable `cause` values and recheck the resource and revision
on recovery.

### Save, Run and draft recovery

Share a [save queue](workspace.md#save-and-conflicts) across panes. Capture the persistent key and revision
for a draft. Mark it covered after storage commits. Compare storage tokens on write and discard so a newer
peer draft survives. Notify peer pages.

Show the validated draft beside the loaded file. On confirmation recheck identity, revision, server version
and permission. Restore in one Undo step against the saved baseline. Before close, check uncovered edits,
pending input, composition and unfinished services. Store rejected input separately.
[Draft example](examples.md#draft-checkpoints)

### Bounds and validation

Bound parsed input, annotation count, output across selections and final document size. Choose a storage
partition, schema and retention period.

## Host responsibilities

Own parsers, routing and persistence. Defer writes until observer delivery ends. Dispose controls with their
pane and document services with their resource.

## Not covered

[Native input and clipboard support](README.md#support-matrix)
