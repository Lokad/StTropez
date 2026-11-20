# Host integration

Extend the editor with decorations, annotations and host controls. StTropez owns its DOM, input and
history. The host chooses how to parse, route and store resources. These extensions work without a
language server.

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

Map a note after each transaction. This example drops the note if its range was deleted or a map is
missing. The host reads the snapshot when rendering its controls.

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

Omit `editOrigin` for read requests, including read-only sources. An origin requires its edit
capability and no edit lock; it grants no authority to a later transaction. The optional
`available` callback is a synchronous read-only host readiness guard. Cancel explicitly when
unobserved host state changes; a temporary interruption between checks cannot be inferred.

A change to revision, selection, visible folds or edit authority permanently invalidates the
capture. Expanded fold metadata, save permissions and focus elsewhere leave it valid. Invalidation
takes effect immediately. A microtask then releases the lease and aborts the signal. Call `cancel()`
outside workspace observer delivery.

`commit(operation)` returns `false` for a stale or consumed capture. Otherwise it consumes the
capture, detaches observers and calls the operation with the resource retained. It releases the
resource and aborts the signal even if the operation throws. The callback must return a boolean
synchronously and use the usual revision, permission and history checks. Returning a promise raises
an error after invocation. Callback effects survive failure. Keep the capture while its results are
on screen and cancel it on dismissal or disposal.

### Captured insertion and structured paste

`editor.captureInsertion(kind)` returns a `CapturedInsertion`, or `undefined` when the view
is unavailable, read-only, composing or finishing ordered input/navigation. The history kind
is `paste` by default or `replace`. One capture can be pending per editor. It exposes the
document identity, revision, length, complete selection set, signal and currentness guard.

The capture retains the view, tab generation, resource authority, revision, directed selection
set and visible fold projection. Edits, selections, projection/authority changes, composition,
later editing/navigation keys, language reconfiguration, another capture and view disposal
invalidate it. Moving focus to surrounding host controls alone does not retarget it.
Observer-triggered abort/lease release is deferred as for captured view requests. The signal
also aborts on normal completion; it is a lifetime signal, not a failure indicator.

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

If a semantic provider fails to attach, release its subscriptions and document leases, show the
reason and offer a retry for that view. Local editing, review and Find stay available. Keep the
provider’s resource limits on retry and release its subscriptions when the view detaches.

Use the [viewport decoration contract](viewport.md#mounting-and-presentation) for source-offset classes on
presented fragments. Cache lexical results by document identity and revision, bound requested
source reads, and invalidate presentation when host results change. A fragment boundary is not
a language boundary. A reference pane needs the syntax context of its own immutable snapshot;
working-document offsets cannot color a different reference. Configure editor language rules
through the [editing API](editor.md), folding through its [controller](folding.md),
and character warnings through [Unicode policy](unicode.md#character-warnings).

Map source-linked metadata through
[anchored ranges and transaction maps](text-model.md#position-maps-and-anchors). Check
`previousRevision` and clear or recompute on a gap. Undo and redo map surviving ranges. To restore
deleted metadata on undo, retain it in the host.

Put annotations and forms beside the editor in an overlay or reserved lane. Read
[viewport geometry](viewport.md#geometry-and-readiness) after render, folding, scrolling or resize.
A folded position may project to its header, and `rowBounds` may find no rendered row. Hide or label
controls in those cases.

A source-backed form parses a captured range and applies validated edits through workspace history.
To copy a value into separately versioned settings, capture the destination and perform an explicit
transfer. Save and Run are separate actions. See the
[source-backed form example](examples.md#source-backed-transfer-form).

### Navigation, commands and lifecycle

Capture the resource, tab, revision and view before asynchronous navigation. Check them again before
opening a location. A Back stack can retain selections, affinities, scroll and folds. After edits,
restore the mapped live selections. See
[resource loading and lifetime](workspace.md#loading-and-resource-lifetime).

Bind host buttons and shortcuts to the captured editor’s commands or insertion handles. Check the
return value to see whether the action applied. Leave composition, AltGraph text entry and editable
host fields to their input handlers. Prevent the browser default only for shortcuts the host
handles.

For a shadow-root host, mount inside the root and provide editor CSS in that root. Input,
caret and focus-dependent controllers use the input's own focus tree, including nested or
closed roots. Destroy dependent controllers and the editor before removing their host nodes.
Keep document/recovery services alive across view remounts when the host retains the project.
See [embedding and React lifecycle](getting-started.md) for mount ownership.

### Input conflict recovery

`inputConflictEvent` names `sttropez-conflict`. Both editor mounts dispatch it on their native
input when an input/history/command attempt cannot apply. It bubbles within its root, is not
cancelable and does not cross a shadow boundary. Subscribe through `editor.input`, or the
native baseline's `editor.element`, including inside closed roots.

`InputConflictDetail` contains `documentId`, `expectedRevision`, `reason` and `attemptedText`,
with optional `contextFrom`, `attemptedEdit` and `cause`. Offsets refer to UTF-16 model units
at the captured revision. Attempted text can be a complete native value, a bounded context
or pending insertion text. Insertion recovery can use `contextFrom: 0`; this does not imply
a replacement at zero. Inspect an available attempted edit rather than inferring an edit
from text alone. The detail and edit are frozen; `cause` may be mutable or nonserializable.

The type describes editor emissions and does not validate arbitrary DOM events. Validate
unknown fields and captured document identity, then copy accepted recovery data into host
storage. Retaining it must not alter text/history. Old revisions supply recovery context,
not authority to edit a newer document. A later recovery action needs fresh validation and
an explicit user choice. Keep the subscription through destruction, then remove host nodes.

### Save, Run and draft recovery

Use the [workspace save/conflict and Run contracts](workspace.md#save-conflicts-and-run).
Hosts choose service endpoints, review policy, error presentation and conditional-write
preconditions. Input recovery and persistence conflicts are different records. A draft
checkpoint neither saves to the service nor executes Run.

A host that persists drafts takes these steps.

- Gives each resource a stable recovery key independent of transient document, tab and view IDs.
- Compares immutable buffer/value identities during ordinary edits; serialization and storage
  happen in an explicit or scheduled checkpoint operation, with a captured version per resource.
- Reports coverage only after the storage transaction commits. Later edits are not covered by
  an older capture. Failed/stale writes, peer changes and storage rechecks invalidate cached coverage.
- Validates format, resource identity, sizes and stored values before offering recovery. It
  offers a stored draft separately from the freshly loaded resources, without applying it.
- Captures destination revision, server version, authority and resource generation for each
  confirmed restore. Revalidates after storage reads and restores as a new undoable transaction,
  preserving the loaded saved baseline and server precondition. Stored versions are context.
- Uses a storage token checked within the write/discard transaction so delayed work cannot
  replace a newer copy. Notifications invalidate other pages' cached coverage.
- Keeps rejected input/preedit separate from committed document captures. Uncommitted
  composition blocks capture/restore; previous-session history and service requests are not replayed.

Navigation protection considers uncovered input, composition, pending editing and unsettled
host services. Full host disposal releases storage, observers and navigation listeners;
view disposal releases only view-owned work. The [draft example](examples.md#draft-checkpoints) demonstrates
independent source/settings restores and a temporary loaded-resource slot.

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

See the [support matrix](README.md#support-matrix) for import, persistence and native-device boundaries.
