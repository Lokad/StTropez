# Captured workspace provider commands

The default route below uses the internal worker fixture. The optional `language=lsp` route
instead qualifies [actual LSP workspace commands and captured server-edit decisions](language-features.md#code-actions-and-commands)
over WebSocket. Worker protocol v1 does not establish LSP compatibility.

The example owns one project backend through the shared provider lifecycle. Both existing
clients expose the same command request/result contract, while retaining synchronous worker
acceptance and scoped asynchronous LSP review. Provider currentness belongs to the captured
backend. LSP captures renew after each applied phase; worker commands retain their resource
guards and permit selection movement. Actions handed to the project reviewer keep their
external backend ownership and cancellation, independent of the project-owned connection.
This adapter adds no runtime dependency or public library API.

The plain and React candidate hosts expose a local **Workspace provider** fixture. Focus a
source or comparison working pane, then choose **Register provider review command**. The
worker requests registration and receives an explicit host acknowledgement. **Unregister
provider review command** removes the capability for that connection. **Request provider
workspace status** exercises a bounded custom message without changing text.

**Request provider review edits** asks the worker to add a comment header/footer to every
captured ready working resource, including unmounted resources. Existing marker pairs produce
no edit. This small review fixture demonstrates a server-originated edit request; its comments
are not a language formatter or semantic review. Saved, historical and comparison references
are excluded. Save and Run keep their primary working resource and captured inputs.

The host validates the entire response before applying anything: exact request/capability,
captured document identities and revisions, unique targets, sorted non-overlapping ranges,
at most 256 edits and 16,384 inserted UTF-16 units. Resource authority and pending input are
checked again immediately before mutation. Every edit target must allow human and host edits
without an edit lock. A malformed final target or one refused resource changes no document.

Accepted edits use the existing atomic workspace batch transaction. All affected documents
share one undo command, independent view selections map normally, and the origin's complete
selection set is retained in history. Later human typing forms a separate command. Undo/redo
from a participating source view restores all participating resources, including unmounted ones.
Use a **Last applied provider edits** button to open a captured changed resource, including an
initially unmounted target. Reveal uses its stable resource identity and preserves primary
Save/Run identity. Undo/redo belongs to participating resources: when the focused source was
already marked and only another resource changed, open that resource to undo the batch.
No-op requests add no history. The provider does not guess the host's next revision; accepted
text is synchronized back before the next command.

The command owner reuses the versioned client described in [project synchronization](project-sync.md).
Navigation and workspace commands own separate connections using the same implementation.
Each connection independently limits its project to 100 documents/16 Mi UTF-16 units, streams
16,384-unit chunks and retains only one acknowledged buffer per document. Synchronization and
change planning happen on requests; ordinary typing performs no transport work. Marker discovery
reads bounded document edges, including in 100k-line sources, rather than exporting/scanning text.
The two lanes can coexist; their retained projects and temporary staging are separate limits.

Every pending command retains captured resource leases and the origin tab/view identity. Typing,
composition, authority/revision changes, origin removal, cancellation, disconnect and disposal
expire pending work. Table conversion and yielded input must finish before capture/application.
Selection movement and independent form focus do not retarget a captured document-relative edit.
Successful application does not steal host focus. Full remount, idle connection failure and disconnect
clear registration; a fresh connection requires registration again and current snapshots.

The worker waits for an applied/rejected acknowledgement before processing another operation.
Per-reply/whole-command deadlines are 5/30 seconds. If acknowledgement fails after local application,
the valid edit stays committed and undoable; the host reports that state and drops the uncertain
connection. It never rolls back later typing or automatically repeats the edit. Reconnecting and
requesting the same fixture again is a no-op when its markers are already present.

This narrow local protocol covers registration, server requests and custom-message lifecycles.
Full external-protocol compatibility, selectors/negotiation, position encodings, resource operations
and general language edits remain required separately. The fixture uses raw UTF-16 offsets and
does not claim an external wire format. Native IME, OS/application clipboard and
physical-display responsiveness remain unverified. Command dispatch, complete readiness and
input-handler durations are separate clocks; functional deadlines establish no latency tail.
