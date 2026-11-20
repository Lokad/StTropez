# Workspace

`Workspace` holds resources, tabs, document revisions and undo history. Views share text and keep
independent selections. `WorkspaceCommands` calls host services to save or run captured inputs.

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
    const sourceTab = workspace.open(
        { kind: "text", documentId: source.documentId }, "main"
    );
    const configurationTab = workspace.open(
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

For delayed work, use `captureTab`/`resolveTab` or `captureResource`/`resolveResource`. Moving a tab
preserves its captured target. Closing or replacing the tab expires that presentation, but resource
work can continue. Use `createResourceKey` for a unique variant. Recreating a released resource
under the same key gives it a new ID.

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

`WorkspaceSnapshot.resources`, `documents`, `tabs` and `tabState.getSnapshot()` list visible
entries. Direct lookup, captures and leases also reach internal entries. `diagnostics()` counts
both. Visibility grants no edit, Save or Run permissions. The creator closes internal tabs and
releases resources once views and leases allow it.

`tabState` notifies on internal tab moves, replacements and closes, even when its visible array
keeps the same identity. Recheck `resolveTab(target)` in the callback. Internal resource changes
also notify workspace observers without adding entries to the inventory.

### Document views

`createDocumentView(documentId, initialSelection?)` creates a stable observable view with an
independent identity and an ownership lease until `dispose()`. The initial value can be one
selection or a complete set. Every document edit maps all retained views, including views
without a DOM mount. A view snapshot's `selection` is its complete set's primary range.

`setSelection(expectedRevision, selection)` deliberately replaces the set with one range;
`setSelections(expectedRevision, ranges, primary?)` replaces the whole set. Stale, unready or
disposed targets return `false`. Valid writes normalize ranges and reveal selected fold targets.
An unchanged set and fold projection publish nothing. A real selection/projection change seals
that document's history group, including when a batch also changes another document.
The [selection primitives](text-model.md#selection-sets) own direction, affinity and normalization.

An edit can supply `selection` or `selectionSet` together with its live initiating view. Undo/redo
restore that view's captured complete set and map other retained views independently. Mapping
deleted positions is lossy; another view does not acquire the initiator's selection history.
Retain the handle when selections/folds must track edits through detach or remount. The
[editor contract](editor.md#view-state-activity-and-limits) owns browser scroll capture and restore.

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

Every changed document advances its revision, including undo/redo. `DocumentChange` records
the preceding revision, transaction ID, origin, kind and position mapping. Participants in
one transaction share its transaction ID. An equal-content result preserves the buffer and
revision. It preserves history by default. A selection-only request can update its view.
`updateResource` similarly preserves a typed resource's revision on a no-op, but typed panels
do not acquire text undo history.

History belongs to the document across tab and view changes. `undo` and `redo` check each
participant’s history boundary and permissions. Later work on another participant yields
`history-blocked`. `observeHistory` depths include blocked entries. Undo restores the initiating
view’s selections and maps other views through the change. See [document views](#document-views).

An omitted history policy creates a standalone `replace` unit. Origins are `human`, `agent`
and `host`; `EditKind` distinguishes typing, deletion, paste, composition, form, refactor,
proposal, live update, replacement and canonical response. An explicit group joins only
consecutive compatible edits with the same document, origin, kind, group and initiating view.
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

Zero disables the corresponding retention capacity. Least recently extended units are
evicted whole. A group rolls over before exceeding its transaction or changed-unit bound.
Oversized edits apply but clear history for affected/linked documents
when the change cannot be retained. `diagnostics().history` reports retention counts.
These are operation/content bounds, not byte-accurate heap limits: live buffers, saved
baselines, pending operations and snapshots retained by the host have separate lifetimes.
History is in memory; persistence and recovery belong to the host.

### Loading and resource lifetime

Omitting an initial value creates a loading resource. `beginLoad(handle)` returns a guarded
load; `accept({ value, serverVersion })` or `fail(message)` settles it. A newer load supersedes
the earlier generation. Refresh is refused for dirty or locked content, reserved saves and
leases acquired with `preventReload: true`.
An accepted text load advances the revision, clears linked history, resets live selections
to the start and clears folds. The host rediscovers folds for the loaded text.

Tabs, document views, operations and explicit `acquire(id)` leases retain resources. Dispose
views and release explicit leases when their owners finish. Closing all tabs does not discard
workspace data. `releaseResource` refuses retained resources and requires an explicit discard
decision for dirty data; released handles become content-free tombstones.
`releaseResourceWhenUnowned` requests release after the final owner leaves. It rechecks
ownership after notification delivery; unsaved changes cancel a request that disallows discard.

An ordinary lease permits reload. Use `acquire(id, { preventReload: true })` when replacing
content would invalidate retained work, and release that lease when the work settles.
`ownership(id)` reports lease, tab and reserved-save counts. A failed visible save status can
coexist with another reserved save; use the ownership count when deciding whether saves settled.

`acquireEditLease(id, owner, origin)` additionally grants exclusive edit ownership. Edits must
provide the matching lease object and satisfy current capabilities; knowing the origin or
owner string is insufficient. Releasing the lease preserves intervening capability changes.
Capabilities enforce local policy, not service authorization.

### Delayed work and presentation

`beginOperation(id, lane, presentation?)` captures resource identity, revision and generation
and retains a lease. A new operation in the same lane cancels its predecessor; other lanes
are independent. `isCurrent` checks ownership and cancellation, **not the content revision**.
`presentationCurrent` also checks the captured tab generation. Validate the content revision
required by the operation after awaiting, even if the service accepts cancellation.

```ts
import type { TabId, TabTarget, TextBuffer, Workspace } from "sttropez";

export async function computeForTab<T>(
    workspace: Workspace, tabId: TabId,
    compute: (buffer: TextBuffer, cancelled: () => boolean) => Promise<T>,
    publish: (result: T, target: TabTarget) => void
) {
    const target = workspace.captureTab(tabId);
    const tab = workspace.resolveTab(target);
    if (tab?.surface.kind !== "text") return false;
    const document = workspace.document(tab.surface.documentId);
    const operation = workspace.beginOperation(document.resourceId, "analysis", target);
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

For an asynchronous dirty-close prompt, use `beginClose(tabId)` and then
`complete("close" | "keep-open")`. Completion validates tab generation and revision and ends
the prompt lease. Finish the operation if the prompt fails. Moving the tab is allowed;
replacement, closure or intervening edits invalidate the decision. `close` records an immediate
host decision; `captureClose` supplies a bare intent without retaining an operation lease.

### Save, conflicts and Run

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

The port returns `saved` with a server version and optional canonical value, or `conflict`
with the competing version. `SaveOutcome` distinguishes saved, conflict and failed results.
Preflight can throw synchronously; service/queued failures invoke the error callback and
return `failed`. The callback cannot prevent lease cleanup. A failed or conflicting save
preserves local content and the previous saved baseline.

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

After conflict review, pass a `SaveReview` with the captured target, reviewed local revision and
remote version. Capture rejects a stale target or revision and a competing save reservation.
Submission rejects a change to the known saved version. The reviewed remote version sets the write
precondition. The saved baseline changes only when the save succeeds. A competing write can cause
another conflict.

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
to the resource, metadata, document, history or `tabState` you display. Use the workspace observable
for the whole inventory.

Subscriptions have independent lifetimes even for the same callback. Delivery captures its
listener list; changes to subscriptions affect later publications. Listener exceptions go
to `WorkspaceOptions.onListenerError` when supplied and cannot stop other listeners or roll
back a committed transaction. Error-reporter exceptions are contained.

`createNotificationScope(onListenerError?)` returns a controller notification scope sharing the
workspace's write guard and, by default, its listener-error policy. Its `batch(action)` defers notifications from the workspace and related
scopes until the outermost synchronous action returns or throws. State commits immediately;
the batch does not roll back writes, combine history transactions or await asynchronous work.
Use `editDocuments` when several document edits must validate and commit as one transaction.

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

- Own schemas, validation, authorization, services, storage and conflict/review decisions.
- Enforce server-version preconditions and any idempotency policy at the service boundary;
  local serialization and atomic edits do not guarantee remote atomic writes or exactly-once delivery.
- Capture immutable command inputs before awaiting. Keep resource, revision, tab generation
  and view identity separate; handle a stale result without redirecting it to later focus.
- Dispose subscriptions/views, close presentation tabs and release operation/retention leases
  when their owners finish. Choose explicitly whether unsaved resources may be discarded.
- Render immutable snapshots through host controllers and register listener cleanup through
  the [hosting lifecycle](getting-started.md#host-responsibilities).

## Not covered

See the [support matrix](README.md#support-matrix).
