# Host integration

Add syntax colors, paste conversion or a form beside the editor without running a language server.
Your host parses and stores the data. Use editor commands for changes that should share typing
history.

## Use

This decorator marks `TODO` in the visible fragment. A tokenizer that needs lexical context must
track it across revisions.

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

Install this listener while converted paste is selected. Copy the clipboard formats during the
event, then convert them against the captured insertion target. Choose size and nesting limits for
the converter and yield during parsing.

```ts
import type { CapturedInsertion, TextEditor } from "sttropez/browser";

type ClipboardText = Readonly<{ text: string; html: string }>;

export function attachConvertedPaste(
    editor: TextEditor,
    convert: (input: ClipboardText, signal: AbortSignal) => Promise<string>,
    report: (message: string) => void
): () => void {
    const events = new AbortController();
    let pending: CapturedInsertion | undefined;
    let disposed = false;

    editor.input.addEventListener("paste", event => {
        if (event.defaultPrevented || !event.clipboardData) return;
        event.preventDefault();
        pending?.cancel();
        const input = Object.freeze({
            text: event.clipboardData.getData("text/plain"),
            html: event.clipboardData.getData("text/html")
        });
        if (input.text.length > 1_048_576 || input.html.length > 262_144) {
            report("Clipboard content exceeds this host's conversion limit.");
            return;
        }
        const capture = editor.captureInsertion("paste");
        if (!capture) { report("The editor cannot accept converted paste."); return; }
        pending = capture;
        void (async () => {
            let applying = false;
            try {
                const text = await convert(input, capture.signal);
                if (!capture.isCurrent()) return;
                const insertedUnits = text.length * capture.selectionSet.ranges.length;
                if (insertedUnits > 4_194_304 || capture.length + insertedUnits > 33_554_432) {
                    report("Converted text exceeds this host's insertion limit.");
                    return;
                }
                applying = true;
                report(capture.insert(text) ? "Converted text inserted." : "No text inserted.");
            } catch (error) {
                if (!disposed && pending === capture && (applying || !capture.signal.aborted)) {
                    report(error instanceof Error ? error.message : "Conversion failed.");
                }
            } finally {
                capture.cancel();
                if (pending === capture) pending = undefined;
            }
        })();
    }, { capture: true, signal: events.signal });

    return () => { disposed = true; events.abort(); pending?.cancel(); pending = undefined; };
}
```

Store a note as an anchored range. After each transaction, map it to the new revision. This example
drops a deleted note or one with a missing map. Read the snapshot to draw it.

```ts
import { anchoredRange } from "sttropez";
import type { AnchoredRange, DocumentId, Workspace } from "sttropez";

export function trackNote(workspace: Workspace, documentId: DocumentId, from: number, to: number) {
    const document = workspace.document(documentId);
    let state: Readonly<{ revision: number; range: AnchoredRange | undefined }> = Object.freeze({
        revision: document.revision,
        range: anchoredRange(document.buffer.length, from, to, { onDelete: "invalidate" })
    });
    const observed = workspace.observeDocument(documentId);
    const stop = observed.subscribe(() => {
        const next = observed.getSnapshot();
        if (next?.revision === state.revision) return;
        const range = state.range && next?.change?.previousRevision === state.revision
            ? next.change.mapping.mapRange(state.range) : undefined;
        state = Object.freeze({ revision: next?.revision ?? -1, range });
    });
    return { getSnapshot: () => state, dispose: stop };
}
```

Validate conflict event data at the host boundary. Keep the listener until disposal finishes so it
can recover uncommitted composition text.

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
    editor.input.addEventListener(inputConflictEvent, event => {
        validateAndRetain(documentId, (event as CustomEvent<unknown>).detail);
    }, { signal: listeners.signal });
    return () => {
        try { editor.dispose(); }
        finally { listeners.abort(); }
    };
}
```

Bind each command to the intended editor. Remove its controls when the view detaches.

```ts
import type { EditingCommand } from "sttropez";
import type { TextEditor } from "sttropez/browser";

export function editingActions(editor: TextEditor) {
    const entries: readonly Readonly<{ label: string; command: EditingCommand }>[] = [
        { label: "Toggle line comment", command: "line-comment" },
        { label: "Indent selection", command: "indent" }
    ];
    return entries.map(entry => ({ label: entry.label, run: () => editor.runCommand(entry.command) }));
}
```

## Contract

### Captured view requests

Use `workspace.captureTab(tabId)` to get the target for
`captureViewRequest(workspace, target, view, options?)`. The frozen handle retains the document,
selection set and folding snapshot. It exposes `isCurrent()`, `signal`, `cancel()` and
`commit(operation)`. Capture rejects foreign views, mismatched tabs and unavailable documents. It
needs no full-text read.

For reads, omit `editOrigin`. This works in read-only views. For edits, supplying an origin requires
the matching capability and an unlocked resource. The later transaction checks permission again. Use
`available` for a synchronous, read-only check of host state. If host state changes between checks,
cancel the capture yourself.

A change to revision, selection, visible folds or edit authority permanently invalidates the
capture. Expanded fold metadata, save permissions and focus elsewhere leave it valid. Invalidation
takes effect immediately. A microtask then releases the lease and aborts the signal. Call `cancel()`
outside workspace observer delivery.

Use `commit(operation)` when the user accepts a result. It returns `false` if the capture expired or
was already used. Otherwise it consumes the capture, detaches its observers and keeps the resource
alive while your callback runs. Return a boolean synchronously and check revision, permission and
history as usual. Even if the callback throws, `commit` releases the resource and aborts the signal.
Returning a promise throws after the callback has run. Any edits it already made survive. While a
result stays on screen, retain its capture. Cancel on dismissal or disposal.

### Captured insertion and structured paste

`editor.captureInsertion(kind)` returns a `CapturedInsertion`, or `undefined` when the view
is unavailable, read-only, composing or finishing ordered input/navigation. The history kind
is `paste` by default or `replace`. One capture can be pending per editor. It exposes the
document identity, revision, length, complete selection set, signal and currentness guard.

The insertion belongs to the captured view, tab generation, resource permissions, revision, directed
selections and visible folds. Editing, changing selections, folds or permissions, starting
composition, typing a navigation or editing key, reconfiguring the language, taking another capture or
disposing the view expires it. Clicking a toolbar control alone keeps the original target. If an
observer invalidates the capture, a microtask releases its lease and aborts the signal. Successful
insertion also aborts the signal when it finishes.

`insert(text)` consumes the capture once and replaces every captured selection with that text.
It returns whether the edit applied and uses the existing edit transform, snippet mirroring,
workspace validation and shared history. Empty text consumes the capture without deleting
selected text. `cancel()` is idempotent. Pending conversion participates in the editor's input
activity; later editing cancels conversion and proceeds. Capturing needs no full-text export.

For different indentation at each caret, a host that owns the [edit transform](editor.md#edit-transforms)
can use `planSelectionEdits` with one string per normalized selection and return its edits and
selection set. The editor has one transform slot, also used for LSP snippet mirroring.
`CapturedInsertion` has no per-selection overload.

Copy clipboard data during the event. Before inserting, validate the converted text and its total
size across selections. A cooperative parser can yield between steps. Clipboard retrieval, native
HTML parsing, final string assembly and the model commit each run to completion. See the
[table conversion example](examples.md#table-conversion).

### Tokenization, annotations and forms

If a provider fails to attach, release its subscriptions and leases, show the reason and offer Retry.
Keep the same resource limits when retrying. Editing, review and Find stay available. Release the
attachment on detach.

A visible fragment might start inside a string or block comment. Cache lexical state by document and
revision, limit source reads, and call `invalidate()` when new tokens are ready. Use absolute source
offsets for [viewport decorations](viewport.md#mounting-and-presentation). Tokenize the saved side of
a comparison against its own immutable text. Configure [editing rules](editor.md),
[fold discovery](folding.md) and [character warnings](unicode.md#character-warnings) separately.

Map source-linked metadata through
[anchored ranges and transaction maps](text-model.md#position-maps-and-anchors). Check
`previousRevision` and clear or recompute on a gap. Undo and redo map surviving ranges. To restore
deleted metadata on undo, retain it in the host.

Put annotations and forms beside the editor in an overlay or reserved lane. Read
[viewport geometry](viewport.md#geometry-and-readiness) after render, folding, scrolling or resize.
A folded position may project to its header, and `rowBounds` may find no rendered row. Hide or label
controls in those cases.

For a form that edits a source line, parse its captured range and submit the field change through
workspace history. To copy a field into separately versioned settings, capture the destination too.
The user can then save or run those settings separately.
[Source-backed form example](examples.md#source-backed-transfer-form)

### Navigation, commands and lifecycle

Before following an asynchronous navigation result, recheck its resource, tab, revision and view. Save
selections, affinities, scroll and folds for Back. After edits, restore the mapped live selections.
[Retaining a loaded resource](workspace.md#loading-and-resource-lifetime)

Bind host buttons and shortcuts to the captured editor’s commands or insertion handles. Check the
return value to see whether the action applied. Leave composition, AltGraph text entry and editable
host fields to their input handlers. Prevent the browser default only for shortcuts the host
handles.

In a shadow root, mount both the editor and its CSS inside that root. Input and caret handling use the
local focus tree, even in nested or closed roots. Dispose dependent controllers, then the editor,
before removing their nodes. Keep project-level document and recovery services across view remounts.
[Mounting in React](getting-started.md#host-responsibilities)

### Input conflict recovery

Listen for `inputConflictEvent` (`sttropez-conflict`) on `editor.input` when the editor cannot apply
input, history or a command. The development textarea fixture dispatches the same event on
`editor.element`. The event bubbles within its root, cannot be cancelled and stops at a shadow
boundary. Attaching to the input works even in a closed shadow root.

`InputConflictDetail` contains `documentId`, `expectedRevision`, `reason` and `attemptedText`,
with optional `contextFrom`, `attemptedEdit` and `cause`. Offsets refer to UTF-16 model units
at the captured revision. Attempted text can be a complete native value, a bounded context
or pending insertion text. Insertion recovery can use `contextFrom: 0`; this does not imply
a replacement at zero. Inspect an available attempted edit rather than inferring an edit
from text alone. The detail and edit are frozen; `cause` may be mutable or nonserializable.

A script can dispatch a DOM event with the same name. Check its fields and document identity before
copying recovery data to storage. Keep the original text and history until the user chooses to
recover. At that point, validate against the current revision. Keep listening through disposal to
catch any final uncommitted input.

### Save, Run and draft recovery

Use [workspace save, conflict and Run](workspace.md#save-conflicts-and-run) to call host services.
Choose your endpoints and conditional-write checks, and decide how users review a conflict. Keep
rejected editor input separate from a storage conflict. Writing a recovery draft leaves the service
and Run untouched.

For drafts that survive a reload, use a persistent key and a version check.

- Give each resource a recovery key that survives new document, tab and view IDs.
- On edits, compare immutable buffers or values. During a scheduled or explicit checkpoint, capture
  each resource’s version, then serialize and store it.
- Mark a version covered only after the storage write commits. Later edits need another checkpoint.
  Failed or stale writes, peer changes and storage rechecks invalidate cached coverage.
- Check format, identity, sizes and values on read. Offer the stored draft alongside the freshly
  loaded file and let the user choose.
- On restore, capture the destination revision, server version, permissions and resource generation.
  Recheck them after reading storage, then restore in a new undo step. Keep the loaded saved baseline
  and server precondition. Stored versions describe the draft.
- Check the storage token inside each write or discard. If another page has replaced the draft, leave
  the newer copy alone. Notify other pages when their cached coverage expires.
- Keep rejected input and preedit text separate from committed drafts. Wait for composition to finish
  before capturing or restoring. Leave previous-session undo and service requests in their original
  session.

Before navigating away, check for input missing from a checkpoint, active composition, pending edits
and unfinished services. Closing one view releases its work. Closing the host also releases storage,
observers and navigation listeners. The [draft example](examples.md#draft-checkpoints) restores
source, settings and a temporarily loaded file independently.

### Bounds and validation

| Extension | Boundary |
| --- | --- |
| Captured view | One retained context; synchronous boolean commit; no implicit transaction or asynchronous callback |
| Captured insertion | One pending capture per editor; one consumption; `paste` or `replace`; empty insertion does not delete |
| Source decorations | Presented fragments and absolute source offsets; tokenization cost/limits belong to the host |
| Conversion/import | Host-defined input, structural, aggregate output and resulting-document limits |
| Notes/forms | Host-defined count, text and parsing bounds; consecutive revision maps or recomputation |
| Recovery records | Host-defined schema, size, storage partition, retention and compare-and-swap policy |

## Host responsibilities

Keep workspace observers read-only and schedule commands after notification. Cancel abandoned
captures. Release controls, overlays and view listeners on detach and resource services when the
resource closes.

Keep parsers, lexical context, routing, storage and application state in the host. Apply edits
through public controllers so custom commands share the editor’s selection, permission and history
rules. Measure presentation readiness separately from [input and provider time](README.md#glossary).

## Not covered

Check clipboard formats and permissions on the target OS and application.
[Clipboard, drag and recovery support](README.md#support-matrix)
