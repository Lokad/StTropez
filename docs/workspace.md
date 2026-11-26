# Workspace

`Workspace` owns text documents, revisions and Undo. Each pane can keep its own selection and folds.

## Use

Create a text resource and pass its document ID to the [editor](getting-started.md#open-the-first-editor).
The host owns its panes and tab list. Retain the document view to restore a pane after remounting.

```ts
import { Workspace } from "sttropez";

export function openFile() {
    const workspace = new Workspace();
    const source = workspace.createTextResource(
        { scope: "project", resource: "source.ts", variant: "working" },
        "Source", {
            value: "const value = 1;\n",
            serverVersion: "source-v1",
            language: { uri: "project:source.ts", languageId: "typescript" },
        }
    );
    return { workspace, source, view: workspace.createDocumentView(source.id) };
}
```

## Contract

### Identities and snapshots

A resource key groups scope, resource and variant. Reopening a released key gives it a new `DocumentId`.
Use the handle’s `id` to edit, read metadata, acquire a lease or release the resource.
Across awaits, capture and resolve a `ResourceTarget`. Views of one document share text and history.
Local revision tracks edits. Server version identifies the saved baseline.

Pass a string or an immutable `TextBuffer` as `value` when creating a document. Omitting `value` leaves it loading.

`ownsDocumentView(view)` checks that the view belongs to this workspace. To target one mount,
capture its editor and check `editor.signal`. Disposing the editor aborts the signal even if the host keeps the view.

Read `getSnapshot()` or subscribe to `metadata`. `document(id)` requires ready text.
`observeDocument(id).getSnapshot()` can return `undefined`. Read ranges through `buffer`.

Snapshots retain their captured text after release. `setDocumentLanguage(id, pair)` binds a URI and language ID, `null` removes
it. `documentForUri(uri)` requires one exact, ready, visible match.

### Inventory visibility

`"internal"` hides a resource from public inventory. Captures, leases, lookup and diagnostics
can reach it. Its creator owns cleanup.

```ts
import { TextBuffer } from "sttropez";
import type { Workspace } from "sttropez";

export function createReference(workspace: Workspace, buffer: TextBuffer) {
    return workspace.createTextResource(
        workspace.createResourceKey("review", "reference"), "Reference", {
            value: buffer,
            capabilities: { edit: [], save: false },
            visibility: "internal",
        }
    );
}
```

### Document views

`createDocumentView` retains the resource and maps selections and folds while detached. `setSelection` and
`setSelections` replace ranges and reveal hidden targets. They return `false` for a stale revision or
unavailable view. Pass the initiating view when an edit specifies selections. Undo restores surviving views
and maps newer selections. [View state](viewport.md#scrolling-and-saved-views)

### Transactions and history

`edit` takes sorted, disjoint UTF-16 ranges in one revision. `editDocuments` commits one request per
document with a shared origin and history policy. `replaceText` accepts a string or `TextBuffer` and
`"record"` or `"reset"`. `transact` addresses the staged buffer at each step and rolls back on error.

Use `setCapabilities` to choose which origins may write (`human`, `host`, `agent`) and whether the resource can be saved.
An edit that returns `applied: false` leaves the target unchanged.

| Reason | When it occurs |
| --- | --- |
| `missing-document` | The target has no live text document. |
| `not-ready` | Loading or failure prevents editing, or a pending save or protected load prevents adopting saved text. |
| `read-only` | The resource denies the requested edit origin. |
| `stale-revision` | The document has changed since the request was prepared. |
| `history-empty` | There is no entry in the requested Undo or Redo direction. |
| `history-blocked` | A participating document has a different history entry or buffer. |

```ts
import type { DocumentId, TextEdit, Workspace } from "sttropez";

export function applyPeerBatches(
    workspace: Workspace, documentId: DocumentId, revision: number, batches: readonly (readonly TextEdit[])[]
) {
    return workspace.transact(documentId, revision, tx => {
        for (const batch of batches) tx.edit(batch);
    }, { origin: "host", source: "peer", history: "record" });
}
```

For delayed writes, pass `expectedRevision`. Origin selects edit permission. On refusal, inspect the reason
before retrying. Equal text keeps its buffer and revision but can move the initiating selection.

#### Selections across replacements

Unchanged text carries its endpoints through a whole-text replacement. Inside a replacement, clamp the
relative UTF-16 offset and back up at a split surrogate or CRLF. Range edits follow affinity. Map stored
positions with `change.mapSelections` or `change.mapViewOffset`.

#### Linked Undo

Shared Undo and Redo check permissions and history order in every participating file. `observeHistory`
includes blocked units. Closing a tab preserves history.

```ts
import type { DocumentId, Workspace } from "sttropez";

export function prependPair(
    workspace: Workspace, left: DocumentId, right: DocumentId, prefix: string
) {
    if (left === right) throw new Error("Choose two different documents.");
    return workspace.editDocuments([left, right].map(documentId => ({
        documentId, expectedRevision: workspace.document(documentId).revision,
        origin: "host" as const, history: { kind: "refactor" as const },
        edits: [{ from: 0, to: 0, insert: prefix }]
    })));
}

export function undoFrom(workspace: Workspace, documentId: DocumentId) {
    return workspace.undo({
        documentId, expectedRevision: workspace.document(documentId).revision
    });
}
```

Consecutive edits can share a group when origin, kind, group and views match. Selection or visible-fold
changes, Undo, Redo, save capture and acceptance seal it.

#### Reset a draft

Confirmed reset clears both stacks throughout linked history. Only targeted text changes. Empty edits can
reset at the same revision.

```ts
import { textDifference, type DocumentId, type Workspace } from "sttropez";

export function reviewRollback(workspace: Workspace, id: DocumentId, draft: string) {
    const reviewed = workspace.document(id);
    const change = textDifference(reviewed.text(), draft);
    return () => workspace.edit({
        documentId: id, expectedRevision: reviewed.revision, origin: "host",
        edits: change ? [change] : [], history: { kind: "replace", reset: true }
    });
}
```

The saved baseline survives reset. To replace it,
[adopt the saved version](#install-an-existing-saved-version).

### History limits

`WorkspaceOptions.history` accepts nonnegative safe integers. `maxGroups` and `maxChanges` default to
unlimited, `maxChangedUnits` to 8,388,608 UTF-16 units and `maxSelectionRanges` to 1,000,000 per document.
Zero groups disables Undo. An oversized edit applies at an Undo boundary. Evicting a shared edit removes
history through it in every participant.

### Loading and resource lifetime

Call `workspace.beginLoad(handle)` before starting a read. Complete it with `accept({ value, serverVersion })`
or `fail(message)`. Call `dispose()` to abandon it and restore the previous state. A superseded read releases
its lease immediately and ignores late replies. Acceptance resets selections, folds and linked history.

Views and leases retain resources. `acquire(id, { preventReload: true })` blocks refresh.
Use `releaseResource` after last use or `releaseResourceWhenUnowned` to defer release. A dirty edit cancels release when discard is forbidden.

<a id="delayed-work-and-presentation"></a>

### Keep a delayed reply on its original editor

Capture the original editor and document. Before displaying a reply, check the editor's lifetime, the
document revision and the host's cancellation signal.

```ts
import type { TextBuffer } from "sttropez";
import type { TextEditor } from "sttropez/browser";

export async function analyze<T>(
    editor: TextEditor, signal: AbortSignal,
    compute: (buffer: TextBuffer, signal: AbortSignal) => Promise<T>,
    display: (result: T) => void
) {
    const document = editor.workspace.observeDocument(editor.view.documentId);
    const source = document.getSnapshot();
    if (!source || signal.aborted || editor.signal.aborted) return;
    const result = await compute(source.buffer, signal);
    if (signal.aborted || editor.signal.aborted || !editor.workspace.ownsDocumentView(editor.view)) return;
    if (document.getSnapshot()?.revision === source.revision) display(result);
}
```

For a delayed close prompt, capture the pane and the document revision. Check both when the user confirms.

### Save and conflicts

Share one saver per resource. Capture text on each press. Start the write after its predecessor finishes so
it uses the latest acknowledged version. Storage must compare versions inside the write.

```ts
import type { SaveResponse, SaveReview, SaveSubmission, TextResourceHandle, Workspace } from "sttropez";

export function createFileSaver(
    workspace: Workspace, source: TextResourceHandle,
    write: (submission: SaveSubmission) => Promise<SaveResponse>
) {
    let previous: Promise<unknown> = Promise.resolve();
    return async function save(review?: SaveReview) {
        const ticket = workspace.captureSave(source, review);
        const result = previous.then(() => ticket.run(write));
        previous = result.catch(() => {});
        return result;
    };
}
```

Capture and submission require save permission. Each press gets its own result.
Failure or conflict leaves both draft and baseline intact. `ticket.run` releases the ticket on every outcome and rethrows storage errors.

#### Retry after review

Show the competing and working copies. On approval, pass `save(review)` the captured resource, revision and
remote version. A stale capture or outstanding save blocks retry. Another storage conflict requires a fresh
review.

Success advances the baseline. The receipt records submission, saved value, version and canonical-text
adoption. Canonical text applies as one Undo step at the captured revision when the host can edit.
Pass `{ applyCanonical: false }` to `ticket.accept` to preserve working text. Later edits stay dirty until they
match the saved value.

#### Install an existing saved version

`adoptSaved` and atomic `adoptSavedDocuments` take text, server version and history policy. After a delayed
read, pass the reviewed revision. A pending save or load or a stale revision blocks adoption. Dirty
text requires host edit permission.

Observers see the baseline, text, clean state and mapped views together. `"record"` preserves equal text’s
buffer and revision. Undo restores changed drafts against the new baselines. `"reset"` clears linked history
even for equal text.

### Observables

Changed snapshots are readable before delivery. Unchanged snapshots retain identity. `onDocumentChange`
reports every revision with edits in prior-revision coordinates. Use `source` to avoid echoing peer writes.

```ts
import type { TextEdit, Workspace } from "sttropez";

export function forwardEdits(workspace: Workspace, uri: string,
    send: (revision: number, edits: readonly TextEdit[]) => void, close: () => void) {
    const document = workspace.documentForUri(uri);
    if (!document) return;
    return workspace.onDocumentChange(document.id, (change, afterDelivery) => {
        if (change.source === "peer") return;
        afterDelivery(() => send(change.previousRevision, change.edits));
    }, afterDelivery => afterDelivery(close));
}
```

`subscribe(after => …)` and document change and release listeners can call `after(work)` to write after
delivery. Unsubscribe to cancel queued work. Follow-up chains allow 256 callbacks.

`createNotificationScope().batch(action)` groups notifications. Writes survive exceptions. Captured
callbacks run once in order. For atomic writes use `editDocuments`.

```ts
import type { DocumentId, Workspace } from "sttropez";

export function restrictPair(workspace: Workspace, first: DocumentId, second: DocumentId): void {
    // Resolve both targets before changing either one.
    workspace.resource(first);
    workspace.resource(second);
    workspace.createNotificationScope().batch(() => {
        workspace.setCapabilities(first, { edit: [], save: true });
        workspace.setCapabilities(second, { edit: [], save: true });
    });
}
```

## Host responsibilities

Validate schemas, enforce permissions and storage preconditions, and confirm draft discard. Release
subscriptions, views and leases on close.

## Not covered

Undo lasts for the workspace session. [Durability limits](README.md#support-matrix)
