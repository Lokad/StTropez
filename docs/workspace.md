# Workspace

`Workspace` owns resources, document revisions and Undo history. Panes can share a document
while keeping their own selections and folds.

## Use

Open a text file and a settings panel in separate panes.

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

Mount the text tab in the [editor](getting-started.md). Render the panel from its handle and call
`updateResource` with its revision, edit origin and new value. Retain both handles across remounts.

## Contract

### Identities and snapshots

| Handle or value | What it identifies |
| --- | --- |
| `ResourceKey` | Host scope, resource and variant |
| `ResourceId`, `ResourceHandle<T>` | One workspace resource lifetime and its stable observable |
| `DocumentId`, `TextResourceHandle.documentId` | The text model associated with a text resource |
| Document/resource revision | A content version, independent of the saved server version |
| `TabId`, `TabTarget` | A presentation slot and its captured workspace/generation |
| `DocumentView`, `ViewId` | The selections and folds in one view |
| `ResourceTarget` | A captured resource identity in a particular workspace |

`workspace.tabs.getSnapshot()` lists visible tabs. Capture a tab with `tabs.capture(id)` before
awaiting. `tabs.resolve(target)` follows moves and expires on close or replacement.
`captureResource` and `resolveResource` follow the resource across tab closes. Releasing and
reopening the same key creates a new ID. Use `createResourceKey` for a unique variant.

An editor can mount a `DocumentId` directly. `ownsDocumentView(view, target?)` checks workspace
membership and, given a tab target, its document. `allocateIdentity()` gives a request a unique
workspace-local token. Check the view and revision before applying its result.

Observe a handle with `getSnapshot` and `subscribe`. Use `metadata` for status alone.
`document(id)` requires a ready document. `observeDocument(id).getSnapshot()` can return
`undefined`. Read ranges from `buffer`. For serialization call `text()` or the ready resource’s
`value()` explicitly. Both share a lazy full-string export and retain their revision after release.

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

`SnapshotValue` accepts null, booleans, finite numbers, strings, dense arrays and acyclic plain
objects. It copies and deeply freezes their data as `Immutable<T>`. Accessors, functions, class
instances, undefined and inherited array elements are invalid. The host validates its schema.

Set a text resource’s `language` to its URI and language ID. `setDocumentLanguage(id, pair)`
changes the binding and accepts `null` to remove it. Text, revision, views and history survive.
`documentForUri(uri)` returns a document only for one exact, ready, workspace-visible match.

### Inventory visibility

Resources default to `visibility: "workspace"`. For a private comparison or attachment, pass
`"internal"` in the creation options. Tabs inherit visibility from their current resource.

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

Internal entries stay out of visible inventories. Direct lookup, captures, leases and
`diagnostics()` include them. The creator closes their tabs and releases their resources. A tab
change can notify observers even when the visible array keeps its identity.

### Document views

Create one view per pane with `createDocumentView(documentId, initialSelection?)`. It retains the
resource until disposal and tracks selections and folds through edits while detached. Its
`selection` is the primary range. The browser editor captures scroll separately.
[Editor view state](editor.md#view-state-activity-and-limits)

`setSelection` replaces every range with one. `setSelections` accepts several ranges and a primary
index. Both require the current revision, normalize ranges and reveal hidden targets. They return
`false` for a stale revision or unavailable view. Changing selection or visible folds seals the
history group and notifies observers. [Selection direction and affinity](text-model.md#selection-sets)

Pass the initiating view with an edit’s `selection` or `selectionSet`. Undo and Redo restore
the selections of surviving views and map the selections of newer views through the edit.

### Transactions and history

| Call | Coordinates and commit |
| --- | --- |
| `edit(request)` | Sorted, non-overlapping UTF-16 ranges in one starting revision. |
| `editDocuments(requests)` | One request per document, with a common origin and history policy. All commit together. |
| `replaceText(id, text, options)` | Whole document as a string or `TextBuffer`. Supply `origin` and `history` (`"record"` or `"reset"`). For linked replacements use `text` in each `editDocuments` request. |
| `transact(id, revision, callback, options)` | Each `tx.edit` addresses the current staged `tx.buffer`. Refusal skips the callback. A throw or invalid step discards the edits. A successful change publishes once. |

Capture `expectedRevision` for delayed writes. Malformed arguments can throw. A refused write
returns `applied: false` with a reason.

| Reason | Host action |
| --- | --- |
| `missing-document`, `missing-resource` | Drop the command. |
| `stale-revision` | Recompute the offsets or obtain a fresh review. |
| `not-ready` | Wait for loading or an outstanding save or reload to finish. |
| `read-only` | Check the initiating origin’s edit permission. |
| `edit-locked` | Supply the matching origin and lease or wait for release. Adopting saved text requires release. |
| `history-empty` | Disable Undo or Redo for that direction. |
| `history-blocked` | Undo intervening edits in the other participating file first. Redo also requires matching history order. |

Content changes, including Undo and Redo, advance the revision. Equal text keeps its buffer and
revision and can move the initiating selection. `replaceText` reports `changed` and `revision`.
An equal panel value also keeps its revision. Typed panels have no text Undo stack.

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

#### Selections across replacements

Selections and folds map before listeners run. Whole-text replacement preserves selection
direction and keeps file endpoints at their respective ends (zero for an empty source).
Endpoints follow unchanged text. Inside a replacement they keep their relative UTF-16 offset,
clamped to the span and backed up at a split surrogate pair or CRLF. An explicit initiating
selection takes precedence. These rules include canonical saves, Undo and Redo. Range edits use
endpoint affinity. Use `change.mapSelections` and `change.mapViewOffset` for stored anchors.

#### Linked Undo

Changes to several documents share a transaction ID and form one undo unit. Undo
or Redo from any participant checks permissions and history order in every file. `observeHistory`
depths include blocked entries. Closing a tab or view preserves that history.

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

Origin selects the permission (`human`, `agent` or `host`). An explicit group joins consecutive
edits on one document with the same origin, kind, group, initiating view and open views. Selection
movement, Undo, Redo, save capture and acceptance seal the group. Use `sealHistory(id)` to end
one explicitly. Groups have no timer.

#### Reset a draft

Pass `history: { kind: "replace", reset: true }` without a group for every request in the batch.
Reset clears both stacks in the targets and every file connected by retained shared history.
Only requested text changes. Dirty state reflects the restored text against its saved baseline.
An empty edit list can reset history at the same revision.

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

Invoke the returned function on approval. Refusal preserves text and history for all participants.
Editing after Undo drops dependent redo entries. Reloading or releasing a document clears its history
and linked boundaries. A permission change preserves history. To replace the baseline as well as the
draft, use [saved-text adoption](#install-an-existing-saved-version).

### History limits

Set per-document limits in `WorkspaceOptions.history` using nonnegative safe integers.
A linked edit charges each file one group and its own changed text and selections.

| Option | Default | Bound |
| --- | ---: | --- |
| `maxGroups` | Unlimited | Retained history units per document |
| `maxChanges` | Unlimited | Recorded transactions per document |
| `maxChangedUnits` | 8,388,608 | Inserted plus removed UTF-16 units after no-op filtering |
| `maxSelectionRanges` | 1,000,000 | Captured before/after selection ranges |

Groups split before exceeding a limit. Eviction removes the oldest groups through the evicted
edit in each participant. An oversized edit applies and creates an Undo boundary.
`maxGroups: 0` disables history. `diagnostics().history` counts each shared group once.

### Loading and resource lifetime

Omit the initial value to create a loading resource. Start with `workspace.operations.beginLoad(handle)`,
settle with `accept({ value, serverVersion })` or `fail(message)`, and call `finish()` when the work
ends, including after cancellation. A newer load supersedes an older one.

- An accepted text load advances the revision, clears linked history and folds, and resets live
  selections to zero. A refresh requires clean, unlocked content with no reserved save or reload-preventing lease.
- A cancelled or unfinished refresh restores prior content at its revision with current permissions.
  An initial load without a result enters `failed` and can be retried.
- Tabs, views, operations and explicit leases retain resources. `releaseResource` requires zero
  owners and permission to discard dirty data. `releaseResourceWhenUnowned` checks again after
  delivery. An unsaved edit cancels release when discard was forbidden.

`ownership(id)` counts leases, tabs and reserved saves. Use `acquire(id, { preventReload: true })`
to keep a resource loaded. For exclusive editing use `acquireEditLease(id, owner, origin)` and
supply its lease and origin on writes. Releasing it preserves permission changes.

<a id="delayed-work-and-presentation"></a>

### Keep a delayed reply on the right tab

Start an operation before awaiting. It retains its resource and captures the generation and
revision. A newer request on the same lane cancels its predecessor. Check `isCurrent()` for a
resource result, `presentationCurrent()` for a tab result, and the revision for text-dependent work.

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

For a dirty-close prompt, `tabs.beginClose(id)` holds a lease until `complete("close" | "keep-open")`
or `finish()`. Moving the tab preserves the prompt. Closing, replacing or editing the target expires
it. Use `tabs.close` for an immediate close and `tabs.captureClose` for an intent without a lease.

### Save and conflicts

Create one saver per resource and share it across panes. Capture a ticket when the user presses
Save. Call `start()` when the preceding write finishes. This sends the chosen text with the
last acknowledged server version, even if the user typed again or closed the tab.

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

Capture and submission both require save permission and an unlocked resource. Each caller gets its
own receipt, conflict or error. Failure before submission leaves save status unchanged. After
submission, a failure or conflict preserves both working text and saved baseline.

#### Retry after review

Show the remote and working copies. After the user chooses to overwrite, pass `save(review)` the
captured resource target, local revision and reviewed remote version. Capture refuses a stale
target or revision and any pending save. Submission checks the acknowledged version again.
The service must condition its write on the reviewed remote version. A further conflict needs
another review.

A receipt records the submission, saved value, server version and whether the working copy
adopted canonical text. Success advances the baseline. Applying canonical text requires the
captured revision, host edit permission and no edit lease. It creates an Undo step. To keep the
working text, pass `{ applyCanonical: false }` to `accept`. Returning to the saved text clears dirty state.

#### Install an existing saved version

Use `adoptSaved` for one file or `adoptSavedDocuments` for an atomic batch. Supply text (a string
or `TextBuffer`), server version and history policy. For a delayed read, include each reviewed
local revision. Adoption refuses a stale revision, unready document, pending save or reload,
or edit lock. A dirty document also needs host edit permission.

Observers see text, server version, clean state and mapped views together. With `"record"`, equal
text keeps its buffer, revision and views. One Undo restores the changed working copies against
their new baselines. After a confirmed discard, `"reset"` clears linked history even for equal text.
[History reset](#reset-a-draft) · [Reload](#loading-and-resource-lifetime)

### Observables

Subscribe to the handle you display, or to the workspace for its inventory. All changed snapshots
are readable before delivery. Unchanged snapshots keep their identity.

`onDocumentChange` delivers every committed revision, including those in a batch. Its edits use
previous-revision offsets. They reconstruct the new text, preserve surrogate pairs and CRLF,
and read insertions lazily. Use `mapping` for positions and `source` to avoid echoing a peer’s edits.

Schedule follow-ups with the listener’s second argument. They run in order in a microtask after
the command and its notifications. Unsubscribing drops pending changes and follow-ups. The
optional release callback gets the same scheduler and runs once, including for unfinished loads.

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

Each initial follow-up can schedule 255 more through subsequent changes. Overflow drops excess
callbacks from that chain and reports one `RangeError` to `onListenerError`. Other chains continue.

For snapshot subscribers, `createNotificationScope(onListenerError?)` shares the workspace write
guard. During `batch(action)`, writes take effect immediately. When the outer synchronous call
returns or throws, each captured callback runs once in first-capture order, even after unsubscribe.
The first capturing scope reports listener errors (default `WorkspaceOptions.onListenerError`,
then `console.error`). Listener failures leave other deliveries intact. Committed writes and Undo
entries survive a thrown action. Use `editDocuments` for an atomic change across files.

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

During delivery you may subscribe, create views and dispose them. Start batches and change text,
selection or history after delivery. Recheck the captured target first.

## Host responsibilities

- Choose schemas, permissions and storage. Enforce version preconditions, atomicity and retry
  policy in the service.
- Capture the resource, revision and any presentation target before awaiting. Drop expired results.
- On close, unsubscribe, dispose views, close tabs and release leases. Confirm before discarding
  dirty data. [Host teardown](getting-started.md#host-responsibilities)

## Not covered

Undo history lasts for the workspace session. See the [support matrix](README.md#support-matrix) for
cross-session recovery and durability limits.
