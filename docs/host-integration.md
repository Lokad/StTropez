# Host integration

Hosts extend StTropez through captured operations, source decorations, mapped annotations
and application controls. The editor owns its DOM subtree and input/history pipeline; the
host owns parsing policy, resource routing, storage and services. These extension points
do not require a language server.

## Use

A decorator receives a bounded presented fragment. This example marks literal `TODO` text
within that fragment; a language tokenizer supplies its own revision-aware lexical context.

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

Attach conversion only while the user selects that paste mode. Copy clipboard formats during
the event, then convert against a retained insertion target. The size limits below are example
host policy; the converter also needs its own structural limits and cooperative scheduler.

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

Track host metadata through consecutive transaction maps. This example drops a note when its
range is deleted or an intervening map is unavailable. It does not write during notification
delivery; the host reads the returned snapshot when rendering its own controls.

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

Input recovery receives unknown event data and passes it to host validation. Keep the listener
through editor destruction, because destruction can emit uncommitted composition recovery.

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

Command discovery is a host-owned catalogue of labels, shortcuts and actions. Retain the
intended editor in each action; detach the catalogue's controls with that editor's host view.

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

`captureViewRequest(workspace, target, view, options?)` retains one tab/view/resource context.
Obtain the target with `workspace.captureTab(tabId)`. The frozen handle exposes the captured
document, complete selection set and folding snapshot, plus `isCurrent()`, `signal`,
`cancel()` and `commit(operation)`. Foreign views, mismatched tabs and unavailable documents
cannot be captured. Capturing does not read the complete document text.

Omit `editOrigin` for read requests, including read-only sources. An origin requires its edit
capability and no edit lock; it grants no authority to a later transaction. The optional
`available` callback is a synchronous read-only host readiness guard. Cancel explicitly when
unobserved host state changes; a temporary interruption between checks cannot be inferred.

Revision, selection, visible fold projection and resource edit-authority changes latch
invalidation. Returning to an earlier state does not revive a capture. Expanded fold metadata,
save permissions and focus elsewhere alone do not invalidate it. Observer invalidation makes
the handle stale immediately, then releases its lease and aborts its signal in a microtask.
Call explicit cancellation outside workspace observer delivery.

`commit(operation)` checks currentness, consumes the capture and removes its observers before
calling one synchronous boolean-returning operation with the resource retained. Stale or
consumed captures return `false` without invoking it. Retention is released and the signal
aborted even if the callback throws. The callback must use normal workspace revision,
permission and history checks. It is not a transaction wrapper: arbitrary callback effects
are not rolled back, and returning a promise is rejected after invocation. Keep a capture
while displayed results depend on it; cancel on dismissal or disposal.

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

Parsing and import policy belong to the host. Copy all clipboard formats synchronously;
never retain the event for asynchronous reads. Validate the complete converted result before
insertion, including aggregate size across selections. Cooperative parsing does not preempt
native clipboard retrieval, native HTML parsing, final string assembly or atomic model commits.
See the [table conversion example](examples.md#table-conversion) for one bounded host format policy.

### Tokenization, annotations and forms

Treat semantic-provider attachment as an optional host service boundary. A rejected attachment
must retain local editing, review and Find, expose its reason, and offer an explicit retry for
the captured view. Release partial provider scopes and document leases before reporting failure;
the retry owns its subscriptions until that view detaches. Keep provider resource limits intact.

Use the [viewport decoration contract](viewport.md#mounting-and-presentation) for source-offset classes on
presented fragments. Cache lexical results by document identity and revision, bound requested
source reads, and invalidate presentation when host results change. A fragment boundary is not
a language boundary. A reference pane needs the syntax context of its own immutable snapshot;
working-document offsets cannot color a different reference. Configure editor language rules
through the [editing API](editor.md), folding through its [controller](folding.md),
and character warnings through [Unicode policy](unicode.md#character-warnings).

Use [anchored ranges and transaction maps](text-model.md#position-maps-and-anchors) for
source-linked host metadata. Check `previousRevision` before mapping; clear or recompute on
a gap. Surviving ranges follow undo/redo maps. A host that discards deleted metadata must
implement its own restoration policy if undo should resurrect it.

Render annotations or source-backed forms in a host-owned sibling overlay or reserved lane.
Use [viewport geometry](viewport.md#geometry-and-readiness) to position visible controls; recompute after
render, folding, scrolling and resize. Folded positions can project to a header, while
`rowBounds` can report no rendered row. Label or hide those states deliberately. Do not cache
coordinates across movement or insert controls into editor-owned rows.

A source-backed form parses a captured range and patches validated source spans through the
same workspace transactions/history. Separate typed settings retain their own identity and
revision. Copying values into them requires a captured destination and explicit operation;
it does not make the form a second source authority or imply Save/Run. See the
[source-backed form example](examples.md#source-backed-transfer-form).

### Navigation, commands and lifecycle

Host buttons capture resource/tab identities, document revision and the intended view before
asynchronous routing. Revalidate them before opening or applying a location; focus or tab
array position cannot identify delayed work. A Back stack can retain complete view state,
including selections, affinities, scroll and folds. After edits, use mapped live selections
instead of replaying offsets from an old revision. Resource loading and retention follow
the [workspace lifecycle](workspace.md#loading-and-resource-lifetime).

Use a host catalogue for command discovery and presentation. Buttons and keyboard listeners
call the retained editor's commands or insertion captures. Let their return values determine
whether an action applied. Avoid claiming shortcuts during composition, editable host fields
or AltGraph text entry; only prevent the browser default when the host owns that action.
Surrounding controls and their subscriptions belong to the host, including disposal.

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

Draft persistence is a host pattern, not an editor storage API. A host implementing it:

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

Own surrounding controls, styles, command catalogues, routing and service policy. Retain exact
identities before awaiting work and cancel abandoned captures. Keep workspace observers
read-only; schedule commands after notification delivery. Dispose view listeners/overlays on
detach and resource services at the end of their longer lifetime.

Supply bounded parsing and revision-aware lexical context. Keep application libraries,
reactivity and storage in the host. Reuse editor transactions and public controllers so
custom interactions share selection, authority and undo/redo behavior. Measure complete
presentation readiness separately from the [input and provider clocks](README.md#glossary).

## Not covered

See the [support matrix](README.md#support-matrix) for import, persistence and native-device boundaries.
