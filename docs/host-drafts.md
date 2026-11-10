# Host draft recovery

The evaluation hosts provide an explicit recovery checkpoint for the working source,
connection configuration, transfer settings and already rejected input. This is host code: the editor package does not open
storage, install navigation handlers or choose persistence policy for an application.

Choose **Keep recovery draft** and wait for the completed checkpoint message. The browser
adapter uses an IndexedDB transaction; completion is reported after the transaction commits.
Large sources are supported without the small string quota of a local-storage record. A failed
open, clone, write or transaction retains current inputs; native transactions do not partially
replace stored data. A peer may already have replaced the previously covered copy, even before
its notification arrives. Failed or stale actions invalidate local checkpoint coverage; recheck
storage before relying on a stored copy. There is no memory-only fallback advertised as durable storage.

Ordinary edits only compare immutable buffer/value handles and readiness flags. They do not
export, serialize or write the document. Full source transfer belongs to the explicit checkpoint
action, after publishing progress and yielding. Typing may continue while storage completes; the checkpoint keeps the captured versions,
and later changes remain unprotected until another checkpoint. Replacing an existing checkpoint
requires confirmation. A storage recheck invalidates local coverage until a new checkpoint or
restore establishes it again.

After reload, the stored draft is offered without changing the freshly loaded resources.
**Restore source draft**, **Restore configuration draft** and **Restore transfer draft** have independent confirmations and
revision checks. A source restore is one new undoable edit; it does not deserialize the previous
session's undo stack. It preserves the loaded saved baseline, server precondition and immutable
comparison reference. The stored server version is context for the choice, never authority to
replace the loaded version. Configuration changes do not retarget source restoration, and source
changes do not invalidate an otherwise current configuration restore.

Transfer restoration is independent too. It preserves raw invalid batch input and unknown
fields, and a later transfer Save receipt expires a pending transfer restore. New checkpoints
use format 2 with a transfer capture. Format 1 source/configuration checkpoints remain readable;
they do not invent a transfer copy, and transfer restore stays disabled for those records.
Run/log session history is separate from the input checkpoint.

Each confirmation captures current resource targets, affected revisions, server versions and
edit authority. Restoration revalidates after storage reads; permission revoke/restore also
expires an old intent. A token checked inside the storage transaction prevents a delayed write
or discard from replacing a newer stored copy. Cross-page store notifications invalidate cached
coverage. The example uses one app-scoped source/configuration/transfer slot; consuming hosts supply their
own resource routes, storage partitioning, retention and compatibility policy.

**Discard stored draft** affects the persisted copy, without discarding current inputs.
**Inspect stored draft** renders bounded text previews. Malformed, unsupported or foreign-resource
data is never restored. Rejected/preedit recovery is stored separately with its old revision and
context and is never automatically replayed into a new document. Uncommitted composition blocks
checkpoint capture and both restore choices; finish it or keep the page open rather than treating native preedit as a
committed source snapshot.

The host installs a `beforeunload` guard when current inputs lack checkpoint coverage, composition
or input is pending, or host requests/acknowledgements remain unsettled. Browser confirmation can
keep the page open so the user can checkpoint, finish or cancel the work. A checkpoint does not
save or run inputs, replay service requests or persist the synthetic server. Browser unload
prompts are not a crash/power-loss guarantee and require the consuming host's declared browser
and device checks. The draft service outlives view unmounts; full host disposal releases its
observers, navigation listeners and storage connection. Native IME/reconversion, OS clipboard, screen readers, mobile termination and
physical display behavior remain unverified. The baseline adapter remains available for bounded
switchback evaluation; portable undo and production adoption are separate gates.
