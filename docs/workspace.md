# Workspace

`Workspace` holds resources, document revisions and undo history. Views share text and keep
independent selections. Hosts with panes or a tab strip can use `workspace.tabs`. `WorkspaceCommands` calls host services to save or run captured inputs.

## Use

Open a text resource and a typed panel in separate panes. A panel can store structured data without
allocating a text document.

```ts
import { Workspace, WorkspaceCommands } from "sttropez";

export function createWorkset() {
    const workspace = new Workspace();
    const source = workspace.createTextResource(
        { scope: "project", resource: "source.ts", variant: "working" },
        "Source", { value: "const value = 1;\n", serverVersion: "source-v1" }
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
    return { workspace, commands: new WorkspaceCommands(workspace), source,
        configuration, sourceTab, configurationTab };
}
```

Pass the text tab to the [editor mount](getting-started.md). Render the panel from its handle. To
change it, call `updateResource` with the revision, edit origin and new value. Keep both handles in
the host controller across view remounts.

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

`workspace.tabs` returns one `WorkspaceTabs` handle on first use. Read the visible tabs with
`getSnapshot()` and observe layout changes with `subscribe()`. A document-only editor can mount
its `DocumentId` directly. Use `tabs.capture(id)` and `tabs.resolve(target)` for a close prompt. Moving the
tab keeps the prompt valid. Closing or replacing it expires the target. If the work belongs to a
resource, use `captureResource` and `resolveResource` instead. A save can outlive its tab. Use
`createResourceKey` for a unique variant. Recreating a released resource under the same key gives it a
new ID.

Resource handles expose `getSnapshot`, `subscribe` and `metadata`. `observeDocument` yields a ready
text snapshot or `undefined`. `document` requires a ready document. Read ranges from
`DocumentSnapshot.buffer`. Calling `text()` on the snapshot or `value()` on the ready resource
shares one lazy whole-string export per revision. Typed resources return their immutable value.

You can keep a reader and call it without a receiver, even after edits, metadata changes or release.
Copying or serializing a snapshot does not read its content. JSON omits reader functions. Call the
reader explicitly to save or send the value.

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

Typed values follow `SnapshotValue`: null, booleans, finite numbers, strings, arrays and
acyclic plain objects. Inputs are copied and deeply frozen as `Immutable<T>`. Accessors,
functions, class instances, undefined and nonfinite values are rejected. Arrays copy their
own indexed data elements without consulting iteration hooks; holes and inherited elements
are rejected. The host owns schema validation and any conversion between typed data and text.

### Inventory visibility

`createResource`, `createTextResource` and `createTextResourceFromBuffer` accept a fifth
`ResourceOptions` argument. Its `visibility` is `"workspace"` by default or `"internal"` for
presentation resources owned by an attachment. Invalid values throw before resource creation.
The fixed value appears in `ResourceMetadata.visibility`; every `TabSnapshot` inherits its
surface resource's visibility. Moving a tab preserves it; replacement adopts the new resource's
visibility and invalidates the previous captured generation.

```ts
import { TextBuffer } from "sttropez";
import type { ResourceOptions, Workspace } from "sttropez";

export function createReference(workspace: Workspace, buffer: TextBuffer) {
    const options: ResourceOptions = { visibility: "internal" };
    return workspace.createTextResourceFromBuffer(
        workspace.createResourceKey("review", "reference"), "Reference", { buffer },
        { edit: [], save: false, run: false }, options
    );
}
```

The workspace snapshot lists visible resources and documents. The tab handle lists visible tabs. Direct lookup, captures and leases also reach internal entries. `diagnostics()` counts
both. Visibility grants no edit, Save or Run permissions. The creator closes internal tabs and
releases resources once views and leases allow it.

`workspace.tabs.subscribe()` notifies on internal tab moves, replacements and closes, even when its visible array
keeps the same identity. Recheck `tabs.resolve(target)` in the callback. Internal resource changes
also notify workspace observers without adding entries to the inventory.

### Document views

Call `createDocumentView(documentId, initialSelection?)` for each pane that needs its own selections
and folds. Pass one selection or a complete set. The view retains the resource until `dispose()`.
Edits map selections in every retained view, including panes that aren’t mounted. Read `selection`
from the view snapshot for the primary range.

`setSelection(expectedRevision, selection)` replaces all selections with one range. For several
ranges, use `setSelections(expectedRevision, ranges, primary?)`. Both return `false` on a stale
revision or an unready or disposed target. They normalize ranges and reveal hidden targets. If
selections and visible folds stay the same, subscribers receive nothing. Changing either seals the
document’s history group, even in a batch that also edits another file.
[Selection direction and affinity](text-model.md#selection-sets)

Pass the initiating view with an edit’s `selection` or `selectionSet`. Undo and redo restore the
complete selections of each surviving view that was open for the edit. Views created later map
their current selections through the change. A whole-file edit preserves matching text at both
ends, so selections and scroll anchors on those lines keep their place. Keep the
`DocumentView` across remounts for selections and folds. The
[editor](editor.md#view-state-activity-and-limits) captures and restores browser scroll.

You can subscribe and register or dispose views during notification. Queue selection, text and
history writes until delivery ends. Keep mutations out of component rendering.

### Transactions and history

`edit` changes one document. `editDocuments` validates every participant before changing any of
them. Name each document once, use a common origin and history policy, and give sorted,
non-overlapping UTF-16 ranges in original coordinates. The workspace checks identity, readiness,
revision, permissions, edit lease, view ownership and ranges. Inspect `applied` and the rejection
reason. Malformed arguments can throw.

Before commit, the workspace maps selections and folds in every retained view, including fold
reveals for selection-only changes. Undo, redo and canonical saves follow the same rule. Listeners
see the completed document, views and history together.

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

Every text change, including undo and redo, advances the revision. `onDocumentChange` delivers
each committed change, including each revision inside a notification batch. Its `edits` use
previous-revision offsets and reproduce the new text. A grouped undo or redo can describe several
steps with one replacement. `mapping` retains the position and selection semantics of every step.
Documents edited together share a transaction ID. An edit that produces the same text keeps the buffer, revision and (by default)
history, though it can change the initiating view’s selection. A no-op `updateResource` also
keeps the revision of a typed resource. Typed panels have no text undo stack.

Pass a `source` string to identify writes from a host feature or peer. Edit permissions use
`origin`. In a change listener, request a follow-up with its second argument. Follow-ups run
in request order in a microtask after listeners and the initiating command finish. Unsubscribing drops that listener’s queued
work. Use the change’s revision when a follow-up depends on the exact text.

```ts
import type { DocumentId, TextEdit, Workspace } from "sttropez";

export function forwardEdits(workspace: Workspace, id: DocumentId,
    send: (revision: number, edits: readonly TextEdit[]) => void) {
    return workspace.onDocumentChange(id, (change, afterDelivery) => {
        if (change.source === "peer") return;
        afterDelivery(() => send(change.previousRevision, change.edits));
    });
}
```

History follows the document across tabs and views. `undo` and `redo` check every participant’s
history boundary and permissions. If later work in another file blocks a shared undo, the result is
`history-blocked`. `observeHistory` depths include blocked entries.
[Which selections undo restores](#document-views)

An omitted history policy creates a standalone `replace` unit. Origins are `human`, `agent`
and `host`; `EditKind` distinguishes typing, deletion, paste, composition, form, refactor,
proposal, live update, replacement and canonical response. An explicit group joins only
consecutive compatible edits with the same document, origin, kind, group, initiating view and set of open views.
Core grouping has no timer. Selection movement, undo/redo and that document's save
capture/settlement seal its group; unrelated background documents do not split it.
`sealHistory(documentId)` explicitly ends grouping without creating an undo entry or changing
the document revision.
Multi-document transactions form standalone shared units.

Use `history: { kind: "replace", reset: true }` to roll back rejected edits to a captured draft.
The transaction maps live views as usual and keeps the resource, tabs, saved baseline and server
version. Dirty status follows the restored text. A successful reset clears **both** stacks for
every target and every document connected to it by retained shared history, including their
single-document entries. Other documents keep their history. Only the requested text changes.
The reset itself adds no undo entry. Even `edits: []` clears history after validation, without a
revision change. Every request in a batch must use the same policy. Omit `group` for a reset.

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

Call the returned function on approval. A stale revision, missing permission, competing edit lock
or failure to validate another target leaves both text and history intact.

Editing after undo invalidates dependent redo units. Reload or release clears the affected
history and linked boundaries; closing a tab, disposing a view or changing capabilities does not. Canonical save
responses and proposals use the same text history as human edits. Remote persistence follows the host save ticket.

### History limits

Configure `WorkspaceOptions.history` with nonnegative safe integers. Shared units count
once across the workspace.

| Option | Default | Bound |
| --- | ---: | --- |
| `maxGroups` | 100 | Retained history units |
| `maxChanges` | 1,000 | Recorded transactions |
| `maxChangedUnits` | 8,388,608 | Inserted plus removed UTF-16 units after no-op filtering |
| `maxSelectionRanges` | 1,000,000 | Captured before/after selection ranges |

A zero limit disables that kind of retention. When history fills, the workspace evicts whole units,
starting with the least recently extended. A group starts a new unit before exceeding its transaction
or changed-unit limit. An oversized edit applies. If it cannot fit in history, the affected and
linked documents lose their history. Use `diagnostics().history` for counts. For heap usage, also
account for live buffers, saved baselines, pending operations and any snapshots you hold. The host
persists drafts separately from in-memory undo.

### Loading and resource lifetime

Omitting an initial value creates a loading resource. `workspace.operations.beginLoad(handle)` returns a guarded
load; `accept({ value, serverVersion })` or `fail(message)` settles it. A newer load supersedes
the earlier generation. Refresh is refused for dirty or locked content, reserved saves and
leases acquired with `preventReload: true`.
An accepted text load advances the revision, clears linked history, resets live selections
to the start and clears folds. The host rediscovers folds for the loaded text.

Closing the last tab keeps the resource in the workspace. Tabs, document views, operations and
`acquire(id)` leases can all retain it. Dispose views and release explicit leases when you finish.
`releaseResource` refuses a resource that has owners. For a dirty resource it also requires an
explicit discard decision. A released handle carries no content. To arrange release when the last
owner leaves, use `releaseResourceWhenUnowned`. It checks again after notifications. Unsaved edits
cancel a request that forbids discard.

Ordinary leases permit reload. Pass `{ preventReload: true }` to `acquire(id, options)` if replacing
the contents would invalidate your work. Release the lease on completion. `ownership(id)` counts
leases, tabs and reserved saves. Check the save count before treating a resource as settled. Another
save can be reserved even when the visible status says failed.

`acquireEditLease(id, owner, origin)` additionally grants exclusive edit ownership. Edits must
provide the matching lease object and satisfy current capabilities; knowing the origin or
owner string is insufficient. Releasing the lease preserves intervening capability changes.
Capabilities enforce local policy, not service authorization.

<a id="delayed-work-and-presentation"></a>

### Keep a delayed reply on the right tab

`workspace.operations` supplies request and load tickets independently of the tab layout.
Use `workspace.operations.begin(id, lane, presentation?)` before starting delayed work. It captures the resource
identity, revision and generation and holds a lease. A new operation in that lane cancels the old one.
Other lanes continue. After `await`, check `isCurrent` for ownership and cancellation, and compare the
content revision yourself. To update a tab, also check `presentationCurrent` for its generation.

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

Call `finish` in `finally`, including after cancellation, failure or a stale reply. Load `accept`
and `fail` also settle their tickets. Operation mutations follow the same notification rules as
edits.

For a dirty-close prompt, call `workspace.tabs.beginClose(tabId)`, then `complete("close" | "keep-open")` when the
user decides. Completion checks the tab generation and revision and releases the prompt lease. If the
prompt fails, finish the operation. A move preserves the decision. Closing, replacing or editing the
target expires it. Use `tabs.close` for an immediate decision or `tabs.captureClose` for an intent without a
lease.

### Save, conflicts and Run

To install text that the host already has on disk or at the server, call `workspace.adoptSaved(resourceId,
{ text, serverVersion, history })`. Supply a string or `TextBuffer`. Listeners see the new revision, clean
state, server version and mapped selections and folds together. `history: "record"` makes a changed
value undoable. `"reset"` clears history. An equal adoption advances the revision and preserves undo
when recording. Pending saves, reload reservations, edit locks and unready documents refuse adoption.
A clean read-only document can receive a saved version. Replacing a dirty document requires host edit permission.

Use one `WorkspaceCommands` coordinator for related saves. `captureSave(resource, review?)` fixes
the content and revision immediately. Pass the ticket to `commands.save(ticket, port)`. A queued
save submits that captured content with the latest known saved server version as its write
precondition. The workspace prevents simultaneous active write tickets across coordinators.

```ts
import { WorkspaceCommands } from "sttropez";
import type { SavePort, SaveReview, TextResourceHandle, Workspace } from "sttropez";

export function bindSave(
    workspace: Workspace, source: TextResourceHandle,
    port: SavePort<string>, onError: (error: unknown) => void
) {
    const commands = new WorkspaceCommands(workspace, onError);
    return {
        save: () => commands.save(workspace.captureSave(source), port),
        saveReviewed: (review: SaveReview) => commands.save(workspace.captureSave(source, review), port)
    };
}
```

Return `saved` with the server version and optional canonical value, or `conflict` with the competing
version. A `SaveOutcome` reports saved, conflict or failed. Initial validation can throw before `save`
returns. A service or queue failure invokes the error callback and returns `failed`. Even if the
callback throws, the workspace releases the lease. Failure or conflict preserves the local text and
previous baseline.

A `SaveReceipt` records the submission, canonical saved value, new server version and whether the
working copy adopted that value. The saved baseline advances on success. Replacing working text
requires a matching revision, host edit permission and no active edit lease. Pass
`{ applyCanonical: false }` to `ticket.accept` to skip replacement. Canonical text edits get a
separate undo unit. Undoing to the baseline clears dirty state even at a later revision.

For a user-confirmed server merge or discard, capture the save ticket before the request, call
`start()` before sending it, and pass the acknowledged `{ canonical, serverVersion }` to
`accept()`. Finish the ticket in `finally`. On success the server reply becomes the saved
baseline. If the user typed, an edit lease is active or the host lacks edit permission, their working
text and undo history survive. An equal canonical value also leaves history intact.

To erase undo only when the discard replaces working text, check `receipt.canonicalApplied`. If true,
submit `edits: []` with `origin: "host"`, `history: { kind: "replace", reset: true }` and
`expectedRevision: ticket.revision + 1`. Keep `accept` and the reset in one synchronous
[notification batch](#observables) if observers must see the two effects together. Do not reset at
a revision read after awaiting another operation.

For a clean, unlocked resource, a [load](#loading-and-resource-lifetime) can install a remote
version without a save. It keeps view handles but resets selections, folds and history. Save
capture and start both require save permission and no edit lock. A dirty or locked resource has
no read-only refresh that adopts a new baseline. Defer until the host can perform the authorized
operation.

After reviewing a conflict, pass `SaveReview` with the target, the local revision the user reviewed
and the remote version they saw. Capture rejects a stale target or revision, or a competing save
reservation. Submission also checks that the known saved version hasn’t changed. The next write uses
the reviewed remote version as its precondition. If someone saves again first, expect another
conflict. The baseline advances only on success.

For a custom coordinator, `captureSave` exposes `start`, `accept`, `conflict`, `fail` and `finish`.
Finish every ticket you take. `WorkspaceCommands` finishes accepted tickets. If another workspace’s
coordinator rejects a ticket synchronously, the caller must finish it. Typed tickets preserve their
submission and receipt types through the queue.

`WorkspaceCommands.run(source, configuration, settings, port)` captures immutable resource
targets, keys, revisions, values and server versions plus copied settings. It checks Run
capability and retains both resources until settlement. It does not save; Run failures reject
the returned promise. These callbacks perform no built-in networking, storage or execution.

### Observables

All changed snapshots are readable before listeners run. Unchanged snapshots keep their identity.
Metadata excludes content revision, so typing alone need not notify a metadata subscriber. Subscribe
to the resource, metadata, document, history or tab handle you display. Use the workspace observable
for the whole inventory.

Each `subscribe` call has its own lifetime, even with the same callback. Delivery uses the listener
list captured at publication. Listener changes apply to later publications. Exceptions go to
`WorkspaceOptions.onListenerError`, if supplied. Neither listeners nor the error reporter can
interrupt delivery or undo a committed edit.

Use `createNotificationScope(onListenerError?)` to notify your controller’s listeners under the
workspace’s write guard. By default it shares the workspace’s error policy. Within `batch(action)`,
writes take effect immediately. The workspace and related scopes defer notifications until the outer
synchronous action returns or throws. A thrown error leaves committed writes in place, each with its
own history. A promise returned by the action doesn’t extend the batch. Use `editDocuments` if several
documents must change atomically.

Each delivery request captures its current listeners. A batch invokes each captured callback
once, in first-capture order, using the error policy of the scope that first captured it.
Later subscription removal does not cancel an already captured callback. Independent workspace
scopes are unaffected. A batch cannot start during notification delivery.

```ts
import type { ResourceId, Workspace } from "sttropez";

export function restrictPair(workspace: Workspace, first: ResourceId, second: ResourceId): void {
    // Resolve both targets before either write; batching itself provides no rollback.
    workspace.resource(first); workspace.resource(second);
    workspace.createNotificationScope().batch(() => {
        workspace.setCapabilities(first, { edit: [], save: true, run: true });
        workspace.setCapabilities(second, { edit: [], save: true, run: true });
    });
}
```

Workspace writes during notification are rejected. Schedule follow-up commands after delivery and
recheck their captured targets.

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
