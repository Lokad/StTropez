# Workspace

`Workspace` owns resources, revisions and Undo. Each pane can keep its own selection and folds.

## Use

Open a file and a settings panel. Mount the text tab with the
[editor](getting-started.md#open-the-first-editor). Change panel values with `updateResource`.

```ts
import { Workspace } from "sttropez";

export function createWorkset() {
    const workspace = new Workspace();
    const source = workspace.createTextResource(
        { scope: "project", resource: "source.ts", variant: "working" },
        "Source", { value: "const value = 1;\n", serverVersion: "source-v1" }, undefined,
        { language: { uri: "project:source.ts", languageId: "typescript" } }
    );
    const configuration = workspace.createResource(
        { scope: "project", resource: "configuration", variant: "working" },
        "Configuration", { value: { limit: 100 }, serverVersion: "config-v1" }
    );
    const sourceTab = workspace.tabs.open(
        { kind: "text", documentId: source.documentId }, "main"
    );
    const configurationTab = workspace.tabs.open(
        { kind: "panel", resourceId: configuration.id, panelType: "configuration" }, "side"
    );
    return { workspace, source, configuration, sourceTab, configurationTab };
}
```

## Contract

### Identities and snapshots

A resource key groups scope, resource and variant. Reopening a released key gives it a new `ResourceId`.
Across awaits, capture and resolve a `ResourceTarget`. Views of one `DocumentId` share text and history.
Local revision tracks edits. Server version identifies the saved baseline.

Use `tabs.capture(id)` before a delay and `tabs.resolve(target)` afterward. Moves preserve the target. Close
or replacement expires it. `ownsDocumentView(view, target?)` checks workspace and optional tab.

Read `getSnapshot()` or subscribe to `metadata`. `document(id)` requires ready text.
`observeDocument(id).getSnapshot()` can return `undefined`. Read ranges through `buffer`.

```ts
import type { DocumentSnapshot, ResourceSnapshot } from "sttropez";

export function serializeCapturedInputs(
    source: DocumentSnapshot, settings: ResourceSnapshot<{ limit: number }>
) {
    if (settings.state !== "ready") return null;
    return JSON.stringify({ source: { revision: source.revision, text: source.text() },
        settings: { revision: settings.revision, value: settings.value() } });
}
```

Snapshots survive release. Panel values are frozen copies of null, booleans, finite numbers, strings, dense
arrays or acyclic plain objects. `setDocumentLanguage(id, pair)` binds a URI and language ID, `null` removes
it. `documentForUri(uri)` requires one exact, ready, visible match.

### Inventory visibility

`"internal"` hides a resource and its tabs from public inventory. Captures, leases, lookup and diagnostics
can reach it. Its creator owns cleanup.

```ts
import { TextBuffer } from "sttropez";
import type { ResourceOptions, Workspace } from "sttropez";

export function createReference(workspace: Workspace, buffer: TextBuffer) {
    const options: ResourceOptions = { visibility: "internal" };
    return workspace.createTextResourceFromBuffer(
        workspace.createResourceKey("review", "reference"), "Reference", { buffer },
        { edit: [], save: false }, options
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
before retrying. Equal text keeps its buffer and revision but can move the initiating selection. Panel
values have revisions and no text Undo.

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
changes, Undo, Redo, save capture and acceptance seal it. Use `sealHistory(id)` for an explicit boundary.

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

Load through `operations.beginLoad(handle)`. Call `accept({ value, serverVersion })` or `fail(message)`,
then `finish()`. A newer load supersedes the old one. Acceptance resets selections, folds and linked
history. Cancelling a refresh restores the prior revision.

Tabs, views, operations and leases retain resources. `acquire(id, { preventReload: true })` blocks refresh.
Exclusive writers pass their origin and edit lease. Use `releaseResource` after last use or
`releaseResourceWhenUnowned` to defer release. A dirty edit cancels release when discard is forbidden.

<a id="delayed-work-and-presentation"></a>

### Keep a delayed reply on the right tab

Capture the tab and buffer first. A newer operation on its lane supersedes it. Check operation, generation
and revision before publishing.

```ts
import type { TabId, TabTarget, TextBuffer, Workspace } from "sttropez";

export async function computeForTab<T>(
    workspace: Workspace, tabId: TabId,
    compute: (buffer: TextBuffer, cancelled: () => boolean) => Promise<T>,
    publish: (result: T, target: TabTarget) => void
) {
    const target = workspace.tabs.capture(tabId);
    const tab = workspace.tabs.resolve(target);
    if (tab?.surface.kind !== "text") return false;
    const document = workspace.document(tab.surface.documentId);
    const operation = workspace.operations.begin(document.resourceId, "analysis", target);
    try {
        const result = await compute(document.buffer, operation.isCancelled);
        if (!operation.presentationCurrent() ||
            workspace.observeDocument(document.id).getSnapshot()?.revision !== operation.revision)
            return false;
        publish(result, target);
        return true;
    } finally {
        operation.finish();
    }
}
```

`tabs.beginClose(id)` retains the resource for the prompt. Complete with `"close"` or `"keep-open"`, or
`finish()`. Moving the tab preserves the decision. Editing, replacing or closing its target expires it.

### Save and conflicts

Share one saver per resource. Capture text on each press. Start the write after its predecessor finishes so
it uses the latest acknowledged version. Storage must compare versions inside the write.

```ts
import type { SaveReview, SaveSubmission, TextResourceHandle, Workspace } from "sttropez";

export function createFileSaver(
    workspace: Workspace, source: TextResourceHandle,
    write: (submission: SaveSubmission<string>) => Promise<
        { kind: "saved"; serverVersion: string; canonical?: string } | { kind: "conflict"; serverVersion: string }>
) {
    let previous: Promise<unknown> = Promise.resolve();
    return async function save(review?: SaveReview) {
        const ticket = workspace.captureSave(source, review);
        const result = previous.then(async () => {
            try {
                const response = await write(ticket.start());
                if (response.kind === "saved") return ticket.accept(response);
                ticket.conflict();
                return response;
            } catch (error) {
                ticket.fail();
                throw error;
            } finally {
                ticket.finish();
            }
        });
        previous = result.catch(() => {});
        return result;
    };
}
```

Capture and submission require save permission and an unlocked resource. Each press gets its own result.
Failure or conflict leaves both draft and baseline intact. `finish()` releases the reservation.

#### Retry after review

Show the competing and working copies. On approval, pass `save(review)` the captured resource, revision and
remote version. A stale capture or outstanding save blocks retry. Another storage conflict requires a fresh
review.

Success advances the baseline. The receipt records submission, saved value, version and canonical-text
adoption. Canonical text applies as one Undo step only at the captured revision, with host edit permission
and no lock. Pass `{ applyCanonical: false }` to preserve working text. Later edits stay dirty until they
match the saved value.

#### Install an existing saved version

`adoptSaved` and atomic `adoptSavedDocuments` take text, server version and history policy. After a delayed
read, pass the reviewed revision. A pending save or load, stale revision or edit lock blocks adoption. Dirty
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
import type { ResourceId, Workspace } from "sttropez";

export function restrictPair(workspace: Workspace, first: ResourceId, second: ResourceId): void {
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
subscriptions, views, tabs and leases on close.

## Not covered

Undo lasts for the workspace session. [Durability limits](README.md#support-matrix)
