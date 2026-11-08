# Document transactions, history and views

Reviewed 2026-11-08. Workspace documents use the immutable `TextBuffer` piece tree. A document
owns its text, revision, saved baseline and bounded history. Each `DocumentView` owns a separate
selection; the browser or host owns its scroll position. Tabs and view mounts do not own history.

## Reading and changing a document

`DocumentSnapshot.buffer` supports indexed line lookup and bounded range reads. The `text`
property and a ready text resource's `value` remain string export boundaries for native views
and host services. Their getter is lazy and shared within that revision's snapshots. Metadata
commits preserve the getter without invoking it. History holds buffers, not snapshot getters
or their optional exported strings. The native projection cache uses weak values so retained
undo buffers do not keep every rendered whole-text string alive.

`edit` checks document identity, expected revision, edit capability and exclusive lease, then
validates every original-coordinate range before committing. `editDocuments` performs the same
checks for every participant before any publication. Each document appears once, and the batch
has one origin and history kind/group policy. Edits are sorted, non-overlapping UTF-16 ranges.
Equal-content edits, including a batch whose combined result is unchanged, publish nothing and
preserve buffer/revision/history identity. A selection-only request can still update its view.

Each changed document advances its revision monotonically, including undo/redo. Its `change`
records the preceding revision, transaction ID, origin, kind and position map. All documents in
one transaction share the transaction ID. Subscribers see all text, metadata, history and view
snapshots after publication, even when listening to the first participant. A stale revision,
missing target, permission change, lock, invalid view, malformed range or invalid second
document cannot partially apply an edit. Local atomicity does not promise remote atomic saves.

```ts
const current = workspace.document(source.documentId);
workspace.edit({
    documentId: source.documentId, expectedRevision: current.revision, origin: "human",
    edits: [{ from: 10, to: 10, insert: "text" }],
    history: { kind: "typing", group: "one-contiguous-action" },
});
```

## History policy and bounds

Every content edit is undoable within the configured limits. Origins remain `human`, `agent`
or `host`; history kinds distinguish typing, deletion, paste, composition, form generation,
refactoring, proposals, live updates, replacement and canonical responses. An omitted policy
creates a standalone `replace` unit. Proposals and canonical replies enter the same document
history and remain separate units. Typed non-text resources retain their own host data contract;
this text history does not fabricate a buffer for them.

An explicit group joins only consecutive edits in its document with the same origin, kind,
group and initiating view. Core grouping has no hidden clock. Selection movement, undo/redo
and that document's save capture/settlement seal a group; a later command cannot reopen it by reusing its name.
Independent background documents do not split a typing group.
Multi-document edits always form one standalone shared unit. Form/refactor/paste/live commands
are standalone by default; a host can explicitly group consecutive steps of one logical command.

The native adapter groups adjacent ordinary typing or same-direction deletion within one
second. Newlines, composition, paste/replacement, focus loss, selection movement, another edit
origin in the same document and save boundaries separate those actions. The group belongs to the document and
initiating view, independently of which view invokes undo later.

`undo` and `redo` take a document ID and expected current revision. `observeHistory` exposes
immutable per-document undo/redo depths. A depth counts entries; a linked entry may be blocked.
Undo/redo validate every participating document and capability before moving the shared unit.
If another participant has a later edit, the command returns `history-blocked`; undo that edit
first. Each participant must have the same shared unit at the top of its corresponding stack.
Undo/redo never choose a focused document or silently cascade through unrelated work.

Editing after undo invalidates redo for that document and every dependent linked redo unit.
Reload and explicit release clear history for the affected document and all documents connected
through retained shared units, preserving consistent boundaries in those participants. Closing/moving/replacing a
tab or detaching a view leaves document history intact. Capability changes do not erase it.

Workspace history defaults to at most 100 distinct groups, 1,000 recorded transactions and
8,388,608 changed UTF-16 units (inserted plus removed content after no-op filtering). A separate
`maxSelectionRanges` limit defaults to 1,000,000 ranges across captured before/after view sets.
It bounds selection metadata even when a command changes little text. Shared
units count once across the workspace. Set `WorkspaceOptions.history` to change these limits;
zero disables the corresponding capacity. Least recently extended units are evicted as a whole. A group rolls
over before exceeding a per-group change/unit limit. An oversized transaction still applies,
but clears undo/redo for its affected/linked documents because it cannot be retained safely;
unrelated document histories remain. `diagnostics().history` reports groups, transactions and
changed units without content.

These are operation/text-unit bounds, not a byte-accurate heap limit. A surviving piece can
reference a larger backing; current content, saved baselines, pending operations and snapshots
retained by a host have their own lifetimes. Long-session compaction, GC/DOM measurements and
host recovery remain qualification work. History is in memory, not persisted across reloads
of the browser or transferred into a different editing implementation.

## Saved content and review

Dirty state compares the current buffer with the exact saved buffer, skipping shared ranges
without materializing text. Undo to saved content clears dirty even though the document revision
has increased. A save captures its buffer/string/revision at invocation, then its server version
precondition at serialized submission. Later typing, undo or redo cannot alter that capture.
An older successful receipt updates the saved baseline without overwriting newer content.

A canonical response applies only under the existing revision, capability, lock and proposal
guards. Its minimal range change is a separate history unit. Undoing canonicalization becomes
dirty; redoing it returns to the saved content. Acknowledgement still uses the immutable save
receipt and proposal identity. Undoing text does not resurrect or retire proposal protocol state,
undo a remote save, or repeat an acknowledgement. Core and browser fixtures exercise exact
proposal/correction/save/undo/redo/acknowledgement/next-request contents.

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
primary range object, preserving single-selection readers. `createSelectionSet(length, ranges,
primary?)` clones/freezes inputs, sorts by source range and merges overlaps, duplicate carets
and carets on an occupied range. Adjacent nonempty ranges stay distinct. A merged range keeps
the primary member's direction/affinities, or the first supplied member's if it is secondary.
`primary` is an index into that immutable normalized set, not a durable identity for later work.
Capture the view, revision and whole set when scheduling a command.

`createDocumentView` accepts a single selection or a set. `setSelections(revision, ranges,
primary?)` updates all ranges together; `setSelection` deliberately collapses to one range.
Identical normalized sets publish nothing. A selection-only change seals that document's group,
including inside a batch that changes another document. Mapping uses every range's affinities
and coalesces ranges that overlap after an edit. Mapping deleted positions is lossy; other views
do not acquire the initiating view's captured selection history.

`planSelectionEdits(length, normalizedSet, textOrTexts)` returns frozen original-coordinate
edits and resulting caret positions. Per-range replacement text follows normalized range order.
Apply both through `edit({ ...capturedTarget, view, ...plan })`; planning alone changes nothing.
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

The native textarea displays LF and maps its selection/replacement coordinates back to raw
model text. Editing an unrelated range preserves CRLF; deleting a displayed CRLF newline removes
both model units, and undo restores them. New native line breaks use LF; the host can explicitly
convert on import/export. Selection capture during `beforeinput` avoids DOM writes that can
disrupt a pending native replacement. When moving/focusing a native control, focus before
restoring its captured view state. `textDifference` derives a minimal single replacement at this whole
text boundary. It and native rendering still require document-sized work; bounded rendering,
native-device composition and accessibility qualification remain M0/M3 work.
