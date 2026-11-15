# LSP rename and workspace text edits

Both `?editor=candidate&language=lsp` hosts use actual `textDocument/rename` WebSocket requests.
F2 selects a local name hint in the host field without applying an edit. Enter a new name and press
Enter or **Prepare rename preview** to request its provider edits. Review the captured targets,
then choose **Apply captured rename**. Changing the name invalidates its response and requires a
fresh request. Escape returns to the captured source with its complete selection set unchanged.
The actual source position reaches the provider even when there is no local word hint. Language
name rules belong to the provider; the host bounds names to 256 UTF-16 units without control text.
Optional `prepareRename` is not advertised or implemented in this subset.

`decodeLspWorkspaceEdit` validates a whole response before publishing any target. `changes` maps
and versioned `documentChanges` text edits are supported. When both are supplied, `documentChanges`
takes precedence as specified by LSP 3.17. Numeric versions must match captured wire versions,
which remain separate from Workspace revisions. Unversioned maps and null versions still require
exact captured current working buffers; they do not authorize disk reads or bypass host revisions.
An empty edit or null rename response makes no applicable preview and adds no history.

Every opaque URI resolves through a host callback. Unknown URIs, repeated document identities,
nonexistent lines, reversed ranges, overlapping edits and malformed final entries refuse the entire batch.
The decoder sorts original-coordinate edits stably and retains equal-position insertion order.
Raw surrogate units and CRLF/LF/bare-CR text are preserved. Character positions beyond a valid
line's end clamp to that end under LSP 3.17. Overlap checks run on those normalized offsets.
There are no extra decoder quotas on document/edit counts or inserted text. The existing session
document limits and transport message/JSON limits remain host-configurable. Direct decoder
callers own input-size policy. File creation/rename/deletion and change annotations are explicitly unsupported.
No server URI is fetched, launched or retargeted to another resource.

Public rename, code-action and server-edit clients share the optional asynchronous
[`resolveTarget` host contract](lsp-navigation.md). Missing targets are retained through complete
validation and host application. Closed null-version targets need no prior synchronization;
explicit numeric versions still require matching captured wire versions. The demo's exported
`LabelOptions` rename exercises an initially unregistered module, preview, atomic undo/redo and
save/reload. Read-only targets cannot acquire editing permission by being resolved.

The host uses a feature scope on the shared provider connection and keeps its captured source revision, complete selection
set, fold generation, tab/view identity and every working resource's revision/edit authority.
Pending input/composition/table conversion prevents capture. Editing, changed selections/folds,
name changes, authority changes, remount and expired session/capability generations cancel or
expire the preview. Idle disconnection makes a fresh reconnect available; it never applies or
automatically replays a rename. Cancellation during initial synchronization also releases its work.

The preview shows each provider range and its actual old/new text, including additional edits that
are not identifier replacements. Display text is abbreviated after 256 units with its full length;
context is bounded independently of deletion length. Paging keeps 64 edits visible. Application
uses the exact validated edits, then rechecks human/host permissions, locks and captured revisions
before one existing `Workspace.editDocuments` transaction. Undo/redo from a participating view
restores every affected resource, including unmounted targets, and the source's complete selections.
Later typing is a separate history command. Immutable comparison baselines and primary Save/Run
identities stay independent of the preview and whichever target later receives focus.

The development fixture reuses StTropez's lexical scanner behind the pinned reference protocol peer.
It replaces matching code tokens across captured working documents and adds a source comment to
exercise additional provider edits; quoted/comment matches remain unchanged. This is a protocol/
host fixture, not general scope/type resolution. Its model/browser checks use malformed final
targets, changed authority, cancellation, reconnect, comparison, history and 100k-line documents.

Sessions that declare `workspaceEdits` advertise versioned text edits, transactional failure handling,
no resource operations and no newline normalization. They do not advertise `workspace.applyEdit`;
server-originated edits and provider command execution remain required. Code-action literal/resolve
[previews](lsp-code-actions.md) use the same edit validator. Native IME/dead keys, OS clipboard
and display checks remain unverified. Large-document checks establish correctness and bounded
input, with no new latency-tail or heap claim. Existing source-labelled performance evidence remains
separate from automation/IPC/polling and physical-display clocks.
