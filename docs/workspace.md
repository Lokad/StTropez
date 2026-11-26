# Workspace

`Workspace` owns resource lifetimes, document revisions and Undo. Panes sharing a document keep
separate selections and folds.

## Use

Open a file and a settings panel. Mount the text tab with the
[editor](getting-started.md#open-the-first-editor) and write panel values with `updateResource`.

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

| Target | Identity and lifetime |
| --- | --- |
| Resource | A host key groups scope, resource and variant. Reopening a released key gives it a new `ResourceId`. Capture and resolve a `ResourceTarget` across awaits. |
| Document | Views with the same `DocumentId` share text and history. The local revision tracks edits, the server version tracks the saved baseline. |
| Tab | Capture its ID and generation with `tabs.capture(id)`. `tabs.resolve(target)` follows moves and expires on replacement or close. |
| View | One pane’s selections and folds. `ownsDocumentView(view, target?)` checks the workspace and optional tab. |

Read a resource handle with `getSnapshot()` and `subscribe()`, or observe `metadata` alone.
`document(id)` requires ready text. `observeDocument(id).getSnapshot()` can return `undefined`. Read
slices from `buffer`. Export whole values on demand.

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

A snapshot retains its revision after release. Panel values are deeply frozen copies of null,
booleans, finite numbers, strings, dense arrays or acyclic plain objects. The host validates its
schema.

`setDocumentLanguage(id, pair)` binds a URI and language ID. Pass `null` to remove it.
`documentForUri(uri)` resolves one exact, ready, workspace-visible match.

### Inventory visibility

Resources and their tabs appear in the public inventory by default. Use `"internal"` for a private
reference. Captures, leases, direct lookup and diagnostics include it. Its creator owns cleanup.

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

`createDocumentView` retains its resource and maps selections and folds while detached.
`setSelection` replaces all ranges. `setSelections` takes several and a primary index. Both check
the revision, reveal hidden targets and return `false` for a stale revision or unavailable view.
Pass the initiating view with an edit’s selection. Undo restores surviving views and maps newer
selections. [Scroll and view state](viewport.md#scrolling-and-saved-views)

### Transactions and history

| Call | Commit |
| --- | --- |
| `edit` | Sorted, non-overlapping UTF-16 ranges in one starting revision. |
| `editDocuments` | One request per document. A shared origin and history policy. All commit together. |
| `replaceText` | A whole string or `TextBuffer` with `"record"` or `"reset"` history. |
| `transact` | Each step addresses the staged buffer. A throw or invalid step discards the changes. |

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

Pass `expectedRevision` on delayed writes. The origin (`human`, `agent` or `host`) selects edit
permission. For `applied: false`, check the reason. Recompute stale offsets, drop missing targets
and wait for a conflicting lease. Equal text keeps its revision and buffer but can move the
initiating selection. Typed panels keep their own revisions and have no text Undo.

#### Selections across replacements

Whole-text replacements map views before notification. Endpoints follow unchanged text. Within a
replacement they keep their relative UTF-16 offset, clamped to the span and backed up at a split
surrogate or CRLF. Range edits follow affinity. Use `change.mapSelections` and
`change.mapViewOffset` for stored positions.

#### Linked Undo

Undo or Redo of a shared transaction checks permissions and history order in all participating
files. `observeHistory` includes blocked units. Closing a tab preserves history.

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

A group joins consecutive edits with matching origin, kind, group and views. Moving selections,
changing visible folds, Undo, Redo and save capture or acceptance seal it. Use `sealHistory(id)` for
an explicit boundary.

#### Reset a draft

A confirmed reset clears both history stacks in the targets and files linked by shared history. Only
requested text changes. An empty edit list can reset history at the same revision.

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

The callback checks the reviewed revision on approval. Reset keeps the saved baseline. To replace
both draft and baseline, [adopt a saved version](#install-an-existing-saved-version).

### History limits

`WorkspaceOptions.history` takes nonnegative safe integers. `maxGroups` and `maxChanges` default to
unlimited, `maxChangedUnits` to 8,388,608 UTF-16 units and `maxSelectionRanges` to 1,000,000 ranges
per document. Zero groups disables Undo. Evicting a shared edit removes history through that edit in
each file. An oversized edit applies and creates an Undo boundary.

### Loading and resource lifetime

For a resource created without a value, use `operations.beginLoad(handle)`,
`accept({ value, serverVersion })` or `fail(message)`, then `finish()`. A new load supersedes its
predecessor. Accepted text resets selections, folds and linked history. Cancelling a refresh
restores the prior revision.

Tabs, views, operations and leases retain resources. `acquire(id, { preventReload: true })` prevents
refresh. An exclusive writer passes the origin and lease from `acquireEditLease`. Release an unowned
resource with `releaseResource`, or request release on last use with `releaseResourceWhenUnowned`. A
dirty edit cancels a release that forbids discard.

<a id="delayed-work-and-presentation"></a>

### Keep a delayed reply on the right tab

Capture the tab and buffer before awaiting. A new request on the same lane supersedes its
predecessor. Check the operation, tab generation and revision before publishing.

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

`tabs.beginClose(id)` retains the resource through a close prompt. Complete with `"close"` or
`"keep-open"`, or call `finish()`. Moving the tab preserves the prompt. Editing, replacing or
closing its target expires it.

### Save and conflicts

Share one saver per resource. Capture the text at each Save press. Call `start()` when the previous
write finishes to pair that text with the last acknowledged version. The storage provider checks
that version inside the write.

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

Capture and submission require save permission and an unlocked resource. Each press gets its own
result. A failure or conflict preserves the draft and saved baseline. `finish()` releases the
reservation.

#### Retry after review

Show the competing and working copies. On confirmation, pass `save(review)` the resource target,
local revision and remote version the user reviewed. Capture refuses a stale target or revision or
an outstanding save. If storage rejects the reviewed version, show the newer copy before trying
again.

Success advances the baseline. The receipt records the submission, saved value, version and whether
canonical text was applied. Applying canonical text requires the captured revision, host edit
permission and no edit lock. It creates an Undo step. Use `{ applyCanonical: false }` to keep
working text. Later edits stay dirty until they match the saved value.

#### Install an existing saved version

Use `adoptSaved` for one file or `adoptSavedDocuments` for an atomic batch. Pass text, server
version, history policy and, after a delayed read, the reviewed local revision. A pending save or
load, stale revision or edit lock blocks adoption. Dirty text requires host edit permission.

Observers see baseline, text, clean state and mapped views together. With `"record"`, equal text
keeps its revision and buffer. Undo restores changed working copies against their new baselines. A
confirmed `"reset"` clears linked history even for equal text.

### Observables

All changed snapshots are readable before delivery. Unchanged ones keep their identity.
`onDocumentChange` supplies every revision, including batched ones, with edits in previous-revision
coordinates. Use `source` to avoid echoing a peer.

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

Schedule writes with the listener’s second argument. Unsubscribing drops queued follow-ups. A
release callback gets the same scheduler and runs once. Follow-up chains allow 256 callbacks.

`createNotificationScope().batch(action)` groups notifications. Writes take effect immediately and
survive a thrown action. Captured callbacks run once in order. Use `editDocuments` for atomic
writes.

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

Choose schemas, permissions and persistence. Enforce write preconditions in storage. Unsubscribe,
dispose views, close tabs and release leases on close. Confirm before discarding dirty data.

## Not covered

Undo lasts for the workspace session. [Recovery and durability limits](README.md#support-matrix)
