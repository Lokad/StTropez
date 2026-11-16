# Editor selections and view lifetime

[Workspace](workspace.md#transactions-and-history) defines document transactions, shared history
and persistence contracts. This page describes retained view state and editor selection commands.

## Typing groups

The editor groups adjacent ordinary typing or same-direction deletion within one second.
Newlines, composition, paste/replacement, focus loss, selection movement and other-origin
edits separate those actions. The workspace's save and undo boundaries also seal groups.
The group belongs to the document and initiating view, independently of which view invokes undo.

## Selection and view lifetime

`createDocumentView(documentId, initialSelection?)` returns a stable observable handle. Its ID
is distinct from resource/document/tab IDs. `setSelection(expectedRevision, selection)` rejects
stale or disposed targets. Selections preserve anchor/head direction and explicit affinities;
defaults exclude insertions at either end of a nonempty selection, with a collapsed caret moving
after inserted text. Each edit maps every retained view of the affected document. A transaction
can supply its initiating view and resulting selection; undo/redo restore that view's captured
selection and map other views independently.

A view holds an ownership lease until explicitly disposed. Keep that handle across DOM detach,
move or remount when selection must survive and track background edits. `mountTextEditor` accepts
it through `options.view`; destroying the DOM mount releases subscriptions/listeners, while the
host retains that supplied handle. Without one, the mount creates/disposes its own view. A new
view starts a new selection. The plain and React fixtures retain handles per view/document,
cache scroll separately and dispose all handles at final host disposal.

Registering/disposal of views, like adding/removing subscriptions, is allowed during host view
attachment in notification delivery; it changes no document snapshot. Actual selection writes
and text/history mutations are rejected during delivery. Callers must queue such commands.
An unchanged selection is a no-op. Never synchronize editor state in React effects or render.

### Multiple-selection model

Each view snapshot also contains `selectionSet: { ranges, primary }`. `selection` is the exact
primary range object, preserving single-selection readers. The
[selection-set primitives](text-model.md#selection-sets) define normalization, direction and affinities.
`primary` is an index into that immutable normalized set, not a durable identity for later work.
Capture the view, revision and whole set when scheduling a command.

`createDocumentView` accepts a single selection or a set. `setSelections(revision, ranges,
primary?)` updates all ranges together; `setSelection` deliberately collapses to one range.
Identical normalized sets publish nothing. A selection-only change seals that document's group,
including inside a batch that changes another document. Mapping uses every range's affinities
and coalesces ranges that overlap after an edit. Mapping deleted positions is lossy; other views
do not acquire the initiating view's captured selection history.

Apply a [selection edit plan](text-model.md#selection-sets) through
`edit({ ...capturedTarget, view, ...plan })`; planning alone changes nothing.
An edit may supply `selectionSet` or `selection`, with a live initiating view. Every document,
range and result set is validated before a multi-document transaction publishes. Undo/redo
restore the initiating view's complete captured set and map other retained views independently.

Browser `captureView()` includes the immutable `selectionSet`. `restoreView()` restores it when
present; legacy states without it restore a single range from `anchor`/`head`. With a set, those
legacy fields are only a compatibility copy; the set determines the primary range. Hosts that
retain mapped document views during detach must use the retained **whole set** when restoring
cached scroll state. Restoring stale cached secondary ranges would overwrite detached edits.
Viewport snapshots identify the complete set that was painted. Highlights intersect every range
with bounded rows; the editing candidate paints visible secondary carets using its existing native
row geometry ([native range rectangles](https://www.w3.org/TR/cssom-view/#extensions-to-the-range-interface)).
Painting offscreen ranges creates no DOM nodes or text reads. Native textareas project only
the primary range. The bounded candidate now captures the complete set, revision and native context
for `beforeinput` and composition. An exact primary selection replacement supplies literal text for
one original-coordinate edit plan across every range. Adjacent typing/deletion groups require the
same complete resulting set and revision. Composition stages in the primary textarea and commits
once; cancellation publishes no edit. A stale set/revision or a native rewrite outside the selected
primary range is rejected with recovery text. This does not qualify IME reconversion or native devices.

Backspace/Delete and word deletion plan every target before publishing, use existing bounded Unicode
cursors, and merge overlapping targets (including carets inside one grapheme). Large sets yield
between planning turns; changing any captured range, revision, capability or composition invalidates
the plan. Clipboard copy joins nonempty selected fragments in source order with LF; cut removes them
in one transaction. Plain paste replicates the same literal text at every range, preserving supplied
CRLF. It does not distribute lines among carets. Real OS/menu clipboard remains unverified.

Tab inserts four spaces at every collapsed caret. With any nonempty range, indentation/outdent
operates on the union of touched lines once, including lines with secondary carets; a range ending at
the next line's start excludes that next line. Bracket pairing/skipping considers each collapsed
caret's following character and preserves the resulting complete set in one transaction.
Alt+click adds a caret; Alt+drag adds a range; Alt+double-click adds a word. Shift+click extends the
primary range while retaining the others. Ordinary click starts one selection. Escape keeps only
the primary range and cancels pending commands; Escape followed by Tab or Shift+Tab still leaves
the editor. Captured dragging belongs to its complete set, revision and mounted tab.

Arrow, word, line/document and page commands operate on every range, retaining extension anchors
and bidi affinities. End excludes CR from a CRLF line ending; a literal CR at EOF remains reachable
content. Vertical movement remembers each range's measured pixel column across short
lines, until another selection, edit or layout breaks that sequence. Targets are normalized and
published once; coalesced ranges inherit their owner's column. Large sets yield between planning
turns and expire after captured-set, revision, layout or lifecycle changes. Only the primary target
is revealed. Multi-range commands capture their complete set/revision before yielding viewport
preparation. Planning writes up to 64 complete short rows before reading their existing native
geometry, retaining the batch across bounded planning turns. Identical painted rows keep the
single-row geometry reuse path; contextual long rows keep their existing fallback. Batches are
released on completion, cancellation, document change and destruction. `navigationBatches`,
`navigationPreparedRows` and `maxNavigationBatchRows` expose allocation bounds; `navigationRows`
and `navigationReadUnits` count command work separately from render `readUnits`.
`columnAt` and `caretAtColumn` expose logical pixel columns independent of scrolling. Contextual
long-line origin and shaping limits remain those described in [viewport.md](viewport.md).

`navigationTurns`, `maxNavigationTurnMs` and `navigationWorkMs` measure synchronous navigation
initialization and complete scheduled navigation callbacks, including timer housekeeping, validation,
row preparation, scanning and final publication. Nested work is counted once. The separate
`navigationPreparationMs` is only the initial viewport/primary-geometry preparation substage.
`lastKeydownMs` measures the key handler; yielding continuations run later. These elapsed clocks
exclude later caret/render frames except synchronous flushes inside a measured callback. Readiness
and complete automation/action proxies include that later work. None measures CPU or display latency.
The native textarea baseline continues to edit only its primary range.
The native text-control [selection API](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#textFieldSelection)
supplies the primary input projection. The project model reuses its own mappings, transactions
and history to represent the additional ranges without an editor/runtime dependency.

Dragging a painted selection captures its source tab generation, document revision, complete
selection set and raw selected fragments. A plain click still collapses the selection; Alt/Shift
gestures keep their existing selection behavior. The bounded candidate supplies plain text and an
opaque transfer token using the [HTML drag data store](https://html.spec.whatwg.org/multipage/dnd.html#the-drag-data-store).
Protected dragover inspects types only. Drop validates the token and the last accepted target
view/revision/model offset, independently of focus and the target's current selection. A transport
that loses the token during an active internal drag is refused, preserving the captured source.
The current automated WebKit transport exhibits that loss; its native token-preserving move remains
unverified. Synthetic event guards do not qualify that native path or OS/application transfers.

Same-workspace editable sources move by default; Ctrl (Option on Apple platforms) requests a copy.
Read-only sources and other workspaces copy. Selected fragments retain raw text and join with LF,
as in the plain clipboard policy. Same-document moves use one original-coordinate edit plan;
cross-document moves reuse linked atomic workspace history. Undo restores the complete initiating
sets. There is no deletion on dragend. External text inserts literally at the accepted model offset;
HTML is never interpreted and unsupported file drops do not navigate the editor. Preview text is
capped at 160 units; the separate drop caret and bounded edge-scroll frame are removed on cancellation,
revision/lifecycle invalidation and disposal. These browser-owned protocols add no runtime dependency.

The native textarea displays LF and maps its selection/replacement coordinates back to raw
model text. Editing an unrelated range preserves CRLF; deleting a displayed CRLF newline removes
both model units, and undo restores them. New native line breaks use LF; the host can explicitly
convert on import/export. Selection capture during `beforeinput` avoids DOM writes that can
disrupt a pending native replacement. When moving/focusing a native control, focus before
restoring its captured view state. `textDifference` derives a minimal single replacement at this whole
text boundary. It and native rendering still require document-sized work; bounded rendering,
native-device composition qualification remains M0/M3 work.
