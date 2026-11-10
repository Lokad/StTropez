# Host draft recovery

The evaluation hosts provide an explicit recovery checkpoint for the working source,
connection configuration, transfer settings, dirty temporary loaded source and already rejected input. This is host code: the editor package does not open
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
use format 3 with an optional loaded-source capture. Formats 1 and 2 remain readable;
they do not invent a transfer copy, and transfer restore stays disabled for those records.
Run/log session history is separate from the input checkpoint.

**Restore loaded-source draft** independently recovers the host's temporary loaded-source slot.
It is disabled for checkpoints without that copy. An absent slot gets a new resource with the
fixture's current loaded baseline; stored server versions never become save authority. Existing
loaded text keeps its current baseline and history. Restore is one undoable edit, with a captured
view preserving complete selection history. A later edit, resource replacement, load or authority
change expires the confirmation. Resource generations prevent an empty-to-loaded-to-empty slot
from accepting an older intent. Choose **Reopen loaded source** to inspect it; restoration leaves
the original source, configuration, transfer, comparison, Save and Run targets unchanged.

Loaded text participates in checkpoint coverage through its immutable buffer and resource
identity. Later typing needs another checkpoint; failed writes and peer changes invalidate
coverage. Ordinary typing never exports the loaded document. The stored recovery identity
names this host's temporary-source slot, independently of transient tab, resource and view IDs.
This fixture does not supply a general resource router or persist the previous session's undo.

Each confirmation captures current resource targets, affected revisions, server versions and
edit authority. Restoration revalidates after storage reads; permission revoke/restore also
expires an old intent. A token checked inside the storage transaction prevents a delayed write
or discard from replacing a newer stored copy. Cross-page store notifications invalidate cached
coverage. The example uses one app-scoped checkpoint slot; consuming hosts supply their
own resource routes, storage partitioning, retention and compatibility policy.

**Discard stored draft** affects the persisted copy, without discarding current inputs.
**Inspect stored draft** renders bounded text previews. Malformed, unsupported or foreign-resource
data is never restored. Rejected/preedit recovery is stored separately with its old revision and
context and is never automatically replayed into a new document. Uncommitted composition blocks
checkpoint capture and all restore choices; finish it or keep the page open rather than treating native preedit as a
committed source snapshot.

The host installs a `beforeunload` guard when current inputs lack checkpoint coverage, composition
or input is pending, or host requests/acknowledgements remain unsettled. Browser confirmation can
keep the page open so the user can checkpoint, finish or cancel the work. A checkpoint does not
save or run inputs, replay service requests or persist the synthetic server. Browser unload
prompts are not a crash/power-loss guarantee and require the consuming host's declared browser
and device checks. The draft service outlives view unmounts; full host disposal releases its
observers, navigation listeners and storage connection. Native IME/reconversion, OS clipboard, mobile termination and
physical display behavior remain unverified. The baseline adapter remains available for bounded
switchback evaluation; portable undo and production adoption are separate gates.
