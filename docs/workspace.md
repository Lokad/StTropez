# Workspace

`Workspace` owns resources, text revisions, tabs, shared history and captured operations.
`WorkspaceCommands` coordinates host-provided save, Run and acknowledgement callbacks.
Views share document data while retaining independent presentation state; storage, services
and application controls belong to the host.

## Use

Create stable resource handles and open their surfaces in host-defined panes. A typed panel
resource stores structured data without allocating a text document:

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

Pass the source tab to the [editor mount](getting-started.md). The host renders the typed
panel using its resource handle and calls `updateResource` with an expected revision, edit
origin and new value. Keep these handles in the host controller through view attachment
changes; end their ownership explicitly as described below.

## Contract

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

Moving a tab preserves its captured target; replacing or closing it invalidates that
presentation. Resource work can continue after its tab closes. Use `captureTab`/`resolveTab`
and `captureResource`/`resolveResource` for delayed commands, never an array index or later
focus. `createResourceKey` supplies a unique variant when the host needs separate resources.
Recreating a released resource with the same key produces a new resource ID.

Resource handles expose `getSnapshot`, `subscribe` and a separate `metadata` observable.
`observeDocument` returns a ready text snapshot or `undefined` when unavailable; `document`
requires a ready document. `DocumentSnapshot.buffer` supports bounded reads. Call `text()`
on a document snapshot or `value()` on a ready resource snapshot to read its captured content.
For text, these operations share a lazy, cached whole-string export for that revision; bounded
reads through the [text model](text-model.md) avoid that export. Typed resources return their
captured immutable value with stable identity. Readers can be retained or called without a
receiver and keep their captured value after later edits, metadata changes or resource release.
Spreading, assigning or JSON-serializing a snapshot does not read its content. JSON omits the
reader functions; persistence and transport code must explicitly capture the values it needs.

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
functions, class instances, undefined and nonfinite values are rejected. The host owns
schema validation and any conversion between typed data and text.

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

`WorkspaceSnapshot.resources`, `documents` and `tabs`, and `tabState.getSnapshot()` contain
only workspace-visible entries. Direct resource/document lookup, captured tabs and leases
also work for internal entries. `diagnostics()` counts all live resources, tabs and ownership.
Visibility controls inventory membership independently of edit/Save/Run permissions and does
not release a resource automatically. The creating owner closes its tabs and releases its
resource when the attachment ends, subject to outstanding views and leases.

`tabState` notifications cover every tab lifetime, including internal tab moves, replacement
and close. Its visible array retains identity when its entries do not change. A captured owner
must recheck `resolveTab(target)` after notification; an inventory reader may see the same array.
The coarse workspace observable also publishes internal resource changes, while omitting their
entries from its immutable inventory snapshot.

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

View registration/disposal and subscriptions are permitted during notification delivery because
they do not mutate document snapshots. Actual selection, text and history writes are rejected
during delivery; queue those commands. Do not synchronize view state during component rendering.

### Transactions and history

`edit` applies one text transaction; `editDocuments` validates every participant before
committing a shared transaction. Ranges use original-coordinate UTF-16 offsets and must be
sorted and non-overlapping. Each document appears once in a batch, with a common origin
and history policy. Identity, readiness, expected revision, edit capabilities, edit lease,
view ownership and ranges are checked before publication. Check the returned `applied`
flag and rejection reason; malformed arguments can throw.

Text changes prepare mapped selections and fold projections for all retained views before
changing history or document state. Undo/redo, proposals and canonical save responses use
the same preparation boundary. Selection-only participants in a batch prepare their fold
reveals before the batch commits. Observers receive the completed document, view and history
snapshots together.

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
one transaction share its transaction ID. An equal-content result preserves buffer,
revision and history; an explicit selection-only request can update its view.
`updateResource` similarly preserves a typed resource's revision on a no-op, but typed panels
do not acquire text undo history.

Text history belongs to documents, independently of tabs and mounts. `undo` and `redo`
validate every participant's current boundary and permissions. A linked unit returns
`history-blocked` if another participant has later work; it does not silently undo that
work. `observeHistory` reports per-document depths, which can include blocked entries.
The initiating view's captured selections are restored, while other retained views are
mapped. See [document views](#document-views).

An omitted history policy creates a standalone `replace` unit. Origins are `human`, `agent`
and `host`; `EditKind` distinguishes typing, deletion, paste, composition, form, refactor,
proposal, live update, replacement and canonical response. An explicit group joins only
consecutive compatible edits with the same document, origin, kind, group and initiating view.
Core grouping has no timer. Selection movement, undo/redo and that document's save
capture/settlement seal its group; unrelated background documents do not split it.
`sealHistory(documentId)` explicitly ends grouping without creating an undo entry or changing
the document revision. Review uses it for accepted proposals that leave text unchanged.
Multi-document transactions form standalone shared units.

Editing after undo invalidates dependent redo units. Reload or release clears the affected
history and linked boundaries; closing a tab, disposing a view or changing capabilities does not. Canonical save
responses and proposals use the same text history as human edits. Undo changes text, not
remote persistence, proposal identities or acknowledgement delivery.

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

Cancellation does not release an operation's ownership. Always call `finish` after settlement,
including stale or failed responses. Load `accept`/`fail` settle their tickets; a `finally`
calling `finish` also handles abandoned paths. Mutating operation methods follow the same
notification rules as edits.

For an asynchronous dirty-close prompt, use `beginClose(tabId)` and then
`complete("close" | "keep-open")`. Completion validates tab generation and revision and ends
the prompt lease. Finish the operation if the prompt fails. Moving the tab is allowed;
replacement, closure or intervening edits invalidate the decision. `close` records an immediate
host decision; `captureClose` supplies a bare intent without retaining an operation lease.

### Save, conflicts and Run

Keep one `WorkspaceCommands` coordinator for related commands. `captureSave(resource, review?)`
captures exact content and revision immediately. Pass that ticket to `commands.save(ticket, port)`,
even when it will queue behind another save. The serialized submission
uses the latest known saved server version as its conditional-write precondition. Workspace
also prevents simultaneous active write tickets from different coordinators.

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

A successful `SaveReceipt` retains the immutable submission, canonical saved value, resulting
server version and whether canonical content was applied. Canonical content replaces the working
value only when the submitted revision, host edit permission and edit lock permit it.
`ticket.accept(response, { applyCanonical: false })` also suppresses replacement while adopting
the returned saved baseline. Otherwise the baseline advances while later local content stays intact.
Dirty means content differs from that baseline; undoing back to it clears dirty even though
the revision increases. Canonical text changes form separate undo units.

After explicit conflict review, pass a `SaveReview` containing the captured resource target,
reviewed local revision and remote server version. Capture rejects stale targets/revisions
or another reserved save; submission also rejects an intervening saved-version change. The
reviewed version is the write precondition, not an adopted baseline. Another remote change
can cause another conflict. The host owns fetching, comparison, merge choices and retry policy.
Low-level `captureSave` exposes `start`, `accept`, `conflict`, `fail` and `finish` for hosts
that implement their own coordinator; always finish its ticket after settlement. The command
coordinator finishes tickets it accepts. A ticket rejected synchronously by a different workspace's
coordinator stays its caller's responsibility. Typed ticket extensions preserve their submission
and receipt types through the same queue.

`WorkspaceCommands.run(source, configuration, settings, port)` captures immutable resource
targets, keys, revisions, values and server versions plus copied settings. It checks Run
capability and retains both resources until settlement. It does not save; Run failures reject
the returned promise. These callbacks perform no built-in networking, storage or execution.

### Agent review

An association, request, proposal and document revision are independent.
`createAgentReview(workspace, source)` returns the same `AgentReview` handle for the same live
text resource. Its observable snapshot exposes association, request, proposal and acknowledgement
queue. `associate(id)` attaches an opaque host ID; a different association requires `detach()` first.
The handle composes public workspace leases, operations, edits and save tickets. Workspace
resource records do not own review state or apply review-specific save/load policy.

`review.beginRequest(context)` requires a ready associated text resource, agent edit permission, settled
saves and no pending request, proposal or acknowledgement. It captures immutable source/context
and an exclusive agent edit lease. Deliver through that request's `accept` method:

```ts
import { createAgentReview } from "sttropez";
import type { AgentInput, ProposedEdits, SnapshotValue,
    TextResourceHandle, Workspace } from "sttropez";

export async function requestProposal<T extends SnapshotValue>(
    workspace: Workspace, source: TextResourceHandle, context: T,
    propose: (input: AgentInput<T>, cancelled: () => boolean) => Promise<ProposedEdits>
) {
    const request = createAgentReview(workspace, source).beginRequest(context);
    try {
        return request.accept(await propose(request.input, request.isCancelled));
    } catch (error) {
        request.fail();
        throw error;
    } finally {
        request.finish();
    }
}
```

Delivery, failure or interruption releases the edit lock. `review.interrupt()` permits human
corrections immediately while cancelled work retains its operation lease until settlement.
Late replies cannot target a newer request or association. For unsolicited versioned updates,
capture `review.captureProposal()` before awaiting and pass that guard to `review.offer`.
Request callbacks must keep their original request ticket. Proposal retirement advances its
generation even when text is unchanged, preventing an old offer from reviving it.

A proposal records its association generation, own generation, opaque ID/revision, base
document revision and resulting document revision. Older/equal versions of that proposal
are rejected. Human corrections use ordinary edits without rewriting proposal identity.
For review-managed source, capture all saves with `review.captureSave(saveReview?)` and pass
the returned ticket to the shared command coordinator. Ordinary `workspace.captureSave` does
not attach proposal policy. `AgentSaveSubmission` includes the captured proposal;
`AgentSaveReceipt` adds its acknowledgement ID. A successful save of proposal/corrections creates
an acknowledgement retaining that exact receipt; later typing or proposals cannot alter it.
An older ticket cannot apply canonical content over a newer proposal, even when the newer
proposal leaves text unchanged. Its returned saved baseline advances.

`review.acknowledge(acknowledgementId, port, onError?)` sends the earliest pending
entry. Failure preserves the save and immutable acknowledgement for retry; retry does not save
again. The host service must make retries idempotent. Acknowledgement retires only a matching
association/proposal generation, ID and revision, and never edits text. An older receipt can
be acknowledged without retiring a newer proposal. Port failures return `failed` and invoke
the optional error callback; callback exceptions cannot prevent ticket cleanup. Hosts with
their own coordinator can use `beginAcknowledgement(id)` and always finish its ticket.

Proposals and acknowledgements retain resources after views close. Detach ends the association
and proposal ownership without discarding text; saved acknowledgements keep their original
recipient and remain retryable. The next request captures current corrected text and the saved
server version once proposals, saves and acknowledgements have settled.

The review handle has no background subscription or lifetime lease of its own. Each caller
owns its subscriptions; request tickets, proposals and saved receipts own their respective
leases. Detach is not a discard of pending acknowledgements. Release the resource only after
those owners settle; a retained review handle then reads an empty snapshot. Review subscribers
also receive source-metadata notifications and may read the same review snapshot on those calls.

### Observables

All changed snapshots publish before listeners run. Unchanged snapshots preserve identity;
metadata excludes content revision so typing need not invalidate unchanged metadata.
Use resource, metadata, document, history, agent and `tabState` observables for their own
concerns. The coarse workspace observable is available for inventory and diagnostics.

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

Reentrant state mutations during notification are rejected. Queue follow-up commands after
delivery through the host scheduler, retaining their captured identities and revalidating
before execution. Observable subscriptions provide reads, not writable reactive state.

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
