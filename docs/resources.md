# Resource and command contracts

The common workspace handle represents either text or host-defined typed form data. A resource
has a scoped key and a unique resource ID; a text resource additionally has a distinct document
ID. Tabs and view instances have separate lifetimes. Titles never identify command targets.
The core typecheck runs with ES libraries only, excluding DOM and Node types.

## Ready data and host ownership

`createTextResource` and `createResource<T>` return stable readonly observable handles.
Without an initial value, a handle starts loading. `beginLoad(handle)` creates a guarded load;
its `accept` or `fail` operation transitions to ready or failed and finishes that load's lease.
Retry uses the same resource ID. A superseded response is rejected even if the service ignored
cancellation. An obsolete load retains ownership until its response settles or the host calls
`finish` after settlement. Dirty resources and resources with reserved saves cannot refresh.

The host owns schema, validation, conversion and services. Typed values are finite acyclic
plain objects/arrays and primitive values; functions, accessors, class instances, undefined and
nonfinite numbers are rejected. Values are copied and deeply frozen, and public types expose
nested values as readonly. Mutable host inputs cannot change an executing command's snapshot.
No text document is allocated for a typed resource. A textual view of a typed resource requires
an explicit host conversion policy; this API does not promise lossless conversion by itself.

Use `workspace.updateResource(handle, { expectedRevision, origin, value })` for form transactions
and `workspace.edit({ documentId, expectedRevision, origin, edits })` for text. Every origin
passes through the resource's edit capabilities and any exclusive edit lease. No-op changes
preserve revision and snapshots.
Capabilities are local enforcement; authorization remains the host service's responsibility.

## Observables and publication

Each resource handle supplies stable bound `getSnapshot`/`subscribe` functions, plus a metadata
observable. `observeDocument(id)` publishes ready text snapshots, or undefined while unavailable.
`tabState` publishes tab changes. Metadata excludes the content revision so repeated typing in
an already dirty document does not invalidate unchanged metadata. A coarse workspace observable
is retained for diagnostics; ordinary views subscribe to the narrower handles.

All changed snapshots publish before any listeners run. Unchanged snapshots retain identity.
Each subscription is independent, even when it uses the same callback. The delivery list is
captured at commit; subscription changes affect subsequent commits. A listener exception is
sent to `onListenerError` when configured and does not stop other listeners. A throwing error
reporter is contained as well. Without a reporter, listener errors are ignored. No listener
failure rolls back an already committed transaction or makes a successful edit appear failed.

Commands that mutate the workspace during notification are rejected before changing state.
This lets every listener observe the same committed state. A host that needs a subsequent
write queues it through its own scheduler after delivery. The observable contract supplies
read compatibility, not a writable reactive cell or a promise of host queue completion.

## Leases, presentation and dirty close

Tabs retain their resource, while `acquire(id)` leases retain it for host work. Closing every
view retains the workspace data until explicit release. `releaseResource` refuses live tabs,
pending leases and dirty state without an explicit discard decision. Released handles become
tombstones without content. Reopening the same key after release gets a fresh resource ID.

`beginOperation(id, lane, presentation?)` captures identity, revision and a request generation.
A new operation on the same lane cancels the old generation; different lanes are independent.
`isCurrent` validates the resource operation, while `presentationCurrent` additionally validates
the captured tab generation. Moving a tab preserves presentation; replacement/close expires it.
The presentation must refer to the same resource at capture. After awaiting, check the operation
and the revision required by the workflow even if cancellation was requested. Always `finish`
in a finally block after settlement; cancellation alone does not release ownership.

For an asynchronous dirty prompt use `beginClose(tabId)`, then `complete("close" | "keep-open")`.
Completion checks the captured tab generation and content revision and releases the prompt lease.
A moved tab can close; a replaced, reopened or subsequently edited target cannot. Closing a tab
does not discard its resource. `close` is the immediate host decision API; `captureClose` is a
bare synchronous intent without an operation lease.

## Save and Run ports

`WorkspaceCommands.save(handle, port)` captures content/revision immediately, including when
queued behind another save, and retains ownership through settlement. Before sending, it checks
readiness/save capability again and uses the latest saved server version as the precondition.
`Workspace` also rejects simultaneous write tickets across command coordinators. The host
service must enforce the precondition; serialization within a client is insufficient to guard
against other writers. A transport failure may have an indeterminate remote outcome, so retry
still needs that precondition and any host-owned idempotency policy.

A successful receipt carries the exact submission, saved canonical value and resulting server
version. Canonical content is applied only if the submitted revision is still current and host
edits remain permitted. Otherwise it becomes the saved baseline while later human content stays
untouched and dirty. Dirty compares content with that baseline, not revision numbers. Changing
content back to the saved baseline, including through shared undo/redo, clears dirty.
Conflict/failure preserves the previous baseline and local content. Conflict versions are
returned to the host for an explicit review/refresh decision. Service errors invoke the host
error callback outside notification and return a failed save outcome. Error reporters cannot
prevent lease cleanup. Save preflight failures throw synchronously; a queued failure returns
the failed outcome. Low-level `captureSave` tickets require explicit `finish` in a finally block.

After explicit remote review, pass a `SaveReview` as the third argument to
`WorkspaceCommands.save(handle, port, { target, expectedRevision, expectedServerVersion })`, or the
second argument to `captureSave`. The host asserts which current local revision it reviewed
against that remote version. Capture rejects another resource/workspace target, a stale
revision or another reserved save, and
copies the precondition. Submission also rejects an intervening saved-version change.
Ordinary saves retain their serialized latest-known-version behavior.

A reviewed save sends the captured remote version as its conditional-write precondition. It
does not adopt the remote content or version as a local saved baseline. A further remote change
can produce another conflict; only a successful receipt advances the saved baseline. Later
typing, canonical-reply guards, shared history and proposal acknowledgement identity follow
the same existing save contract. The host owns remote retrieval, comparison, merge choices,
presentation guards and any idempotency policy; there is no automatic merge or forced write.

`run(source, configuration, settings, port)` captures immutable values, variants, revisions and
server versions before awaiting and retains both resource leases through settlement. It checks
Run capability and never saves implicitly. The host selects save-before-run and execution policy.
Run failures reject the returned promise. These ports are callbacks only; core code imports no
network, storage, credential or application-service APIs.

`acquireEditLease(id, owner, origin)` requires matching lease identity on edits; another caller
with the same origin cannot bypass it. Releasing it preserves capability changes made while it
was active. Agent requests use this primitive and capture proposal versions in save receipts.
See [agent review](agent-review.md) for acknowledgement and interrupt/detach ordering.

The native playground demonstrates two views, a typed form, deferred save and Run capture.
`tests/resources.test.ts` covers stale loads, dirty prompts, permissions, exact queued saves,
canonical results, conflicts/failures, target ownership and host error recovery. The browser
fixture also covers typing/movement during a save and read-only transitions during synthetic
composition. The [host adapter fixtures](host-adapter.md) add plain/React controllers, Strict Mode
ref cleanup, queued host-write ordering, error recovery and review/save/acknowledgement scenarios.
Shared text history and mapped views now have [document contracts and executable scenarios](history.md).
Native-device composition, long-session memory and the production renderer remain unqualified.
