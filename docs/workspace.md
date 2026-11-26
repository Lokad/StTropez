# Workspace

`Workspace` holds resources, document revisions and undo history. Views share text and keep
independent selections. Hosts with panes or a tab strip can use `workspace.tabs`. A save ticket captures the resource and revision for a host write.

## Use

Open a text resource and a typed panel in separate panes. A panel can store structured data without
allocating a text document.

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
    return { workspace, source,
        configuration, sourceTab, configurationTab };
}
```

Mount the text tab in the [editor](getting-started.md). Render the panel from its handle and call
`updateResource` with its revision, edit origin and new value. Retain both handles across remounts.

## Contract

`workspace.allocateIdentity()` returns a workspace-local token for a request or attachment. Before
applying a delayed result, also check its view, tab generation and document revision.

### Identities and snapshots

| Handle or value | What it identifies |
| --- | --- |
| `ResourceKey` | Host scope, resource and variant; titles are display text |
| `ResourceId`, `ResourceHandle<T>` | One workspace resource lifetime and its stable observable |
| `DocumentId`, `TextResourceHandle.documentId` | The text model associated with a text resource |
| Document/resource revision | A content version, independent of the saved server version |
| `TabId`, `TabTarget` | A presentation slot and its captured workspace/generation |
| `DocumentView`, `ViewId` | A retained selection/folding state over a document; scroll belongs to the browser/host |
| `ResourceTarget` | A captured resource identity in a particular workspace |

`workspace.tabs` is a stable `WorkspaceTabs` handle. Read visible tabs with `getSnapshot()` or subscribe
to layout changes. To apply a delayed result to one tab, capture it with `tabs.capture(id)` and resolve
it with `tabs.resolve(target)`. Moving preserves the capture. Closing or replacing expires it. For a save
that can outlive its tab, use `captureResource` and `resolveResource`. Reopening the same key gives the
resource a new ID. `createResourceKey` allocates a unique variant.

`ownsDocumentView(view)` checks workspace membership. Pass a captured tab as the second argument to
also check that the tab presents that view’s document. An editor can mount a `DocumentId` directly.

Resource handles expose `getSnapshot`, `subscribe` and `metadata`. `observeDocument(id)` yields a ready
snapshot or `undefined`. `document(id)` requires a ready document. Read ranges from `snapshot.buffer`.
`snapshot.text()` and the ready resource’s `value()` share a lazy full-string export per revision. A
captured reader keeps returning that revision after edits or release, even when called without a receiver.
Call it explicitly for serialization. JSON omits the reader functions.

Pass a URI and language ID in the text resource’s `language` option, or set them later with
`setDocumentLanguage(id, pair)`. Pass `null` to withdraw the binding. Omit the pair for saved copies
and generated output. Changing it preserves text, revision, selections and history.
`documentForUri(uri)` returns the only ready workspace-visible document with that exact URI, or
`undefined` for zero or several matches. Capture its identity and revision before starting delayed work.

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

`SnapshotValue` accepts null, booleans, finite numbers, strings, arrays and acyclic plain objects.
The workspace copies and deeply freezes them as `Immutable<T>`. It rejects accessors, functions,
class instances, undefined, array holes and inherited array elements. Array copying reads own indexed
data without invoking iteration hooks. The host validates its schema and converts typed data to text.

### Inventory visibility

The fifth argument to `createResource`, `createTextResource` and `createTextResourceFromBuffer` sets
`visibility`. It defaults to `"workspace"`. Use `"internal"` for a private comparison or attachment.
An invalid value throws before creation. Visibility stays in `ResourceMetadata` for the resource’s
lifetime. Tabs inherit it from their surface, including when a replacement changes surface.

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

Internal entries stay out of the workspace and tab inventories. Direct lookup, captures, leases and
`diagnostics()` include them. The creator closes internal tabs and releases resources under the usual
ownership and permission rules. An internal change can notify workspace observers. A move, replacement
or close can notify tab observers even when the visible array keeps its identity. Recheck captured targets.

### Document views

Give each pane its own `createDocumentView(documentId, initialSelection?)`. A view retains the resource
until disposal. It keeps its selection set and folds across remounts, including edits made while
detached. Its snapshot’s `selection` is the primary range. The browser editor captures scroll separately.
[Editor view state](editor.md#view-state-activity-and-limits)

`setSelection(revision, selection)` replaces all ranges. `setSelections(revision, ranges, primary?)`
sets several. Both normalize the ranges and reveal hidden targets. A stale revision or unavailable
view returns `false`. A change of selection or visible folds notifies observers and seals the document’s
history group. [Selection direction and affinity](text-model.md#selection-sets)

Pass the initiating view with an edit’s `selection` or `selectionSet`. Undo and Redo restore the
captured selections of surviving views. Views created after the edit map their current selections
through it. During notification, hosts may subscribe, create views and dispose them. Schedule
selection, text and history writes after delivery. [Observables](#observables)

### Transactions and history

Choose the call by the coordinates you have.

| Call | Coordinates and commit |
| --- | --- |
| `edit(request)` | Sorted, non-overlapping UTF-16 ranges in one starting revision. |
| `editDocuments(requests)` | Each document appears once. All share an origin and history policy. The workspace validates all requests before changing any file. |
| `replaceText(id, text, options)` | Whole document. Pass a string or immutable `TextBuffer`, an `origin` and a `history` policy of `"record"` or `"reset"`. Use a `text` request in `editDocuments` for a linked replacement. |
| `transact(id, revision, callback, options)` | Each `tx.edit(ranges)` addresses the staged `tx.buffer` at the start of that step. A refusal skips the callback. A throw or invalid step discards all staged edits. A successful change publishes once. |

Capture `expectedRevision` for delayed writes. Malformed arguments can throw. A refused write
returns `applied: false` with a reason.

| Reason | Host action |
| --- | --- |
| `missing-document`, `missing-resource` | Drop the command for that target. A replacement opened under the same name has its own identity. |
| `stale-revision` | Read the current text and recompute the edit or ask for a fresh review. The old offsets belong to the captured revision. |
| `not-ready` | Wait for the document to load. For saved-text adoption, also let pending saves and reloads finish. |
| `read-only` | Check the edit permission for the initiating origin. |
| `edit-locked` | Pass the matching edit lease for that origin, or wait for its owner to release it. Saved-text adoption requires release. |
| `history-empty` | Disable Undo or Redo for that direction. |
| `history-blocked` | A linked edit must be next in every participating file. For Undo, let the user undo intervening edits in the other file first. |

A content change advances the revision, including Undo and Redo. Equal text keeps the buffer and
revision but may change the initiating selection. `replaceText` reports `changed` and `revision`.
An equal typed-resource value keeps its revision. Typed panels have no text undo stack.

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

Selections and folds map in every retained view before listeners
run. A whole-text write preserves selection direction and endpoints at the start or end of the file.
An empty file starts at zero. Endpoints in unchanged text follow it. Inside the replaced span, each
keeps its relative UTF-16 offset, clamped to the new span and moved back if it splits a surrogate pair
or CRLF. An explicit selection for the initiating view wins. For a stored selection or scroll anchor,
use `change.mapSelections(set)` or `change.mapViewOffset(offset, affinity)`. These rules also apply to
canonical saves, Undo and Redo. Range edits use endpoint affinities.

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

Use origin `human` for user edits, `agent` for automated edits and `host` for application writes.
The origin selects the permission. `EditKind` describes the change, for example `replace` (default
for a host replacement) or `refactor`. An explicit group joins consecutive compatible edits to one
document with the same origin, kind, group, initiating view and set of open views. There is no timer.
Selection movement, Undo, Redo, save capture and acceptance seal that document’s group.
`sealHistory(id)` closes a group without changing its revision or adding an entry.

#### Reset a draft

Pass `history: { kind: "replace", reset: true }` without a group. All requests
in a batch must use the same policy. A reset clears both stacks for each target and every file
connected to it through retained shared history, including their single-file edits. Only the
requested text changes. The baseline and server version stay in place, and dirty state follows
the restored text. Even an empty edit list can clear history without changing the revision.

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

Configure `WorkspaceOptions.history` with nonnegative safe integers. Each document has its own
budget. A multi-file edit costs each file one group and the text and selections changed in that file.

| Option | Default | Bound |
| --- | ---: | --- |
| `maxGroups` | Unlimited | Retained history units per document |
| `maxChanges` | Unlimited | Recorded transactions per document |
| `maxChangedUnits` | 8,388,608 | Inserted plus removed UTF-16 units after no-op filtering |
| `maxSelectionRanges` | 1,000,000 | Captured before/after selection ranges |

Reaching a budget evicts the oldest undo groups. Evicting a shared edit cuts off history through that
edit for each participant. Newer edits survive. Groups split before exceeding the budget. An oversized
edit applies and creates an undo boundary. Set `maxGroups: 0` to disable history.
`diagnostics().history` counts each shared group once. Heap usage also includes buffers, saved baselines,
pending operations and retained snapshots. Persist drafts separately.

### Loading and resource lifetime

Omit an initial value to create a loading resource. Call `workspace.operations.beginLoad(handle)` and
settle with `accept({ value, serverVersion })` or `fail(message)`. A newer load supersedes the old one.
A refresh requires clean, unlocked content, no reserved saves and no lease preventing reload.

- Accepting a text load advances the revision, clears linked history, resets live selections to zero
  and clears folds. Rediscover folds for the loaded text.
- Cancelling a refresh or finishing without a result restores prior content at the same revision and
  current permissions. An initial load without prior content enters `failed` and can be retried.
  Call `finish()` when cancelled work settles to release its lease.
- Closing the last tab leaves the resource in the workspace. Tabs, views, operations and explicit
  `acquire(id)` leases retain it. `releaseResource` requires zero owners and consent to discard dirty
  content. The released handle exposes no value. `releaseResourceWhenUnowned` rechecks ownership
  after delivery. A new unsaved edit cancels release when discard was forbidden.

Use `acquire(id, { preventReload: true })` when reloading would invalidate work. Other leases allow
reload. `ownership(id)` counts leases, tabs and reserved saves. A failed status can coexist with a
queued save. `acquireEditLease(id, owner, origin)` grants exclusive editing. Supply the matching
lease object and origin on writes. Release preserves any permission changes. The service enforces
its own authorization.

<a id="delayed-work-and-presentation"></a>

### Keep a delayed reply on the right tab

Before awaiting, call `workspace.operations.begin(id, lane, presentation?)`. It retains the resource
and captures its identity, generation and revision. A newer request cancels its predecessor in the same
lane. Check `isCurrent()` before applying a resource result and `presentationCurrent()` before changing
a tab. Check the current document revision against `operation.revision` if the result depends on text.

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
        publish(result, target); // Synchronous publication to this captured presentation.
        return true;
    } finally {
        operation.finish();
    }
}
```

Call `finish()` in `finally`, including after cancellation or failure. For a dirty-close prompt,
`tabs.beginClose(id)` holds a lease. Call `complete("close" | "keep-open")` when the user decides,
or finish the operation if the prompt fails. A move preserves the prompt. Closing, replacing or
editing the target expires it. Use `tabs.close` for an immediate close or `tabs.captureClose` for an
intent without a lease.

### Save and conflicts

1. At Save, call `captureSave(resource, review?)`. The ticket retains the content and revision the
   user chose, even if typing continues or the tab closes.
2. Serialize writes per resource. After the preceding write finishes, call `ticket.start()` and send
   its submission. Ordinary saves use the last acknowledged server version at submission. Capture
   and start both require save permission and an unlocked resource.
3. On success call `accept(response)`. On a rejected precondition call `conflict()`. On failure call
   `fail()`. Always call `finish()` to release the ticket. Failure before submission leaves save status
   unchanged. Failure or conflict after submission preserves the working text and its saved baseline.

```ts
import type { SaveReview, SaveSubmission, TextResourceHandle, Workspace } from "sttropez";

export async function saveFile(
    workspace: Workspace, source: TextResourceHandle,
    write: (submission: SaveSubmission<string>) => Promise<
        { kind: "saved"; serverVersion: string; canonical?: string } | { kind: "conflict"; serverVersion: string }>,
    review?: SaveReview
) {
    const ticket = workspace.captureSave(source, review);
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
}
```

#### Retry after review

Compare the remote text with the working copy. Pass a `SaveReview` containing
the captured resource target, the local revision the user reviewed and the remote version they saw.
Capture rejects a stale target, a changed local revision or another pending save. Submission checks
that the acknowledged server version has not changed since capture. The service must compare the reviewed remote version again
when writing. If another write won, show the new conflict and ask for a fresh review.

**Canonical response.** A successful `SaveReceipt` records the submission, saved value, server version
and whether the working copy adopted the canonical value. Success advances the saved baseline.
Canonical replacement requires the captured local revision, host edit permission and no edit lease.
Pass `{ applyCanonical: false }` to `accept` to keep the working text. A canonical text change has its
own undo step. Undoing back to the baseline clears the dirty flag.

#### Install an existing saved version

Call `adoptSaved(resourceId, { text, serverVersion, history,
expectedRevision })` with a string or `TextBuffer`. For related files, pass their versions to
`adoptSavedDocuments(versions, { history })`. Include the reviewed local revision on each delayed
read. An unready document, pending save, reserved reload, stale revision or edit lock refuses the
whole batch. A clean read-only document can adopt saved text. A dirty document requires host edit
permission.

Observers see text, clean state, server version and mapped views together. Under `"record"`, equal
text retains its buffer, revision and views. One Undo restores all changed working copies against their new
baselines. To discard edits after confirmation, use `"reset"`. It clears linked history even for equal
text. [History reset](#reset-a-draft) · [Reloading a clean resource](#loading-and-resource-lifetime)

### Observables

All changed snapshots are readable before delivery. Unchanged snapshots keep their identity. Subscribe
to the resource, metadata, document, history or tab handle you display. Typing can leave metadata
unchanged. Use the workspace observable for inventory.

**Document changes.** `onDocumentChange` delivers every committed revision, including each revision in
a batch. Its edits use previous-revision offsets and reconstruct the new text. They omit untouched
spans and expand or merge where needed to keep surrogate pairs and CRLF intact in both versions.
Each `insert` is read lazily from the new buffer. `mapping` preserves each step’s position semantics.

Use a `source` tag to identify writes from a feature or peer. In its listener, skip its own writes.
Schedule dependent work with the listener’s second argument and keep the revision it depends on.
Follow-ups run in order in a microtask after the command and notifications finish. Unsubscribing drops
pending changes and follow-ups. The optional release callback runs once, even for an unfinished load,
and receives the same scheduler.

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

Each initial follow-up can schedule 255 more through the changes it causes. On overflow, excess
callbacks in that chain are dropped and one `RangeError` reaches `onListenerError`. Other chains continue.

**Snapshot notifications.** Every subscription has its own lifetime. Publication captures the
listeners for that change. Exceptions go to `WorkspaceOptions.onListenerError` (default `console.error`).
Listener or reporter failures leave the commit and other deliveries intact.

`createNotificationScope(onListenerError?)` lets a host controller share the workspace write guard
and, by default, its error policy. During `batch(action)` writes take effect immediately. When the
outer synchronous action returns or throws, the workspace and related scopes deliver each captured
snapshot callback once, in first-capture order, with the first capturing scope’s error policy.
Unsubscribing after capture keeps that delivery. Independent workspaces are unaffected. Returning a
promise does not extend the batch. A throw leaves committed writes and their undo entries in place.
Use `editDocuments` for an atomic write across files.

```ts
import type { ResourceId, Workspace } from "sttropez";

export function restrictPair(workspace: Workspace, first: ResourceId, second: ResourceId): void {
    // Resolve both targets before either write; batching itself provides no rollback.
    workspace.resource(first); workspace.resource(second);
    workspace.createNotificationScope().batch(() => {
        workspace.setCapabilities(first, { edit: [], save: true });
        workspace.setCapabilities(second, { edit: [], save: true });
    });
}
```

Start batches and issue writes after notification delivery. Recheck the captured target before writing.

## Host responsibilities

- Choose schemas, permissions, storage and conflict review. Check version preconditions and
  idempotency at the service. A local atomic edit cannot guarantee atomic or exactly-once remote
  writes.
- Capture the resource, revision, tab generation and view before awaiting. If the target expires, drop
  the result.
- On close, unsubscribe, dispose views, close tabs and release leases. Get a discard decision before
  releasing dirty data.
- Render snapshots from host controllers and
  [clean up listeners on detach](getting-started.md#host-responsibilities).

## Not covered

Undo history lasts for the workspace session. See the [support matrix](README.md#support-matrix) for
cross-session recovery and durability limits.
