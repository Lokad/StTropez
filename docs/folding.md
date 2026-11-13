# Per-view folding

`DocumentView.folding` is a stable observable handle. The host supplies raw UTF-16 ranges;
StTropez owns their view state, mapping, visible-row index and disclosure controls. This small
TypeScript implementation reuses the text buffer, position maps and viewport rather than adding
a runtime dependency. Language parsing stays in a provider. The optional indentation/marker
discovery below is a generic host policy over immutable text, with no parser dependency.
The [host-domain fixture](domain.md) demonstrates captured asynchronous discovery
and annotations outside the runtime. Hosts can call public `createFoldRegions`
to validate a complete response and preserve prior identity/collapse state before
publishing it through the view's fold handle.

`discoverIndentationFolds(buffer, options)` is a yielding headless planner. Hosts choose tab
width, indentation group, and paired line-prefix region markers. Nested indentation includes
interior blank lines and excludes trailing blank lines. Unclosed markers remain expanded.
`reconcileFoldRanges` chooses one outer range per header, discards crossing discoveries, and
matches mapped header/group pairs to previous identities. It returns the complete range set;
a host combining several sources must combine them before reconciliation.

`createFoldingController(workspace, tabId, editor, discover, { delayMs })` owns discovery for
one retained view. The callback receives the captured document and an AbortSignal. It may
return ranges, a yielding generator, or `{ ranges, isCurrent }`, synchronously or asynchronously.
Old results cannot publish after editing, target replacement or disposal. Publication waits
for composition and queued editing to settle, and reconciles the latest view choices rather
than the choices at request time. Failures retain mapped folds and expose an explicit status.
Hosts should make synchronous discovery steps bounded; scheduling does not preempt a callback.

```ts
const controller = createFoldingController(workspace, tab, editor, document =>
    discoverIndentationFolds(document.buffer, {
        tabSize: 2, group: "blocks",
        markers: [{ start: "#region", end: "#endregion", group: "regions" }],
    }));
controller.runCommand("collapse-all", "regions");
// On host policy/provider changes: controller.refresh(); on unmount: controller.dispose().
```

Commands are `collapse`, `expand`, `collapse-all` and `expand-all`, optionally restricted to a
group. Ctrl/Cmd+Shift+[ / ] collapses/expands at the caret. Collapse commands move hidden
selection endpoints to their visible header before publication. Explicit disclosure buttons
retain the existing raw-selection behavior below. Groups are optional, nonempty host strings.

`createLspFoldingClient(provider).run(document, prepare?)` supplies a cancellable captured
`textDocument/foldingRange` result with revision, ranges and an `isCurrent` guard. Enable that
feature on the provider. Static/dynamic capability authority and reconnect use the shared
session. The client advertises complete-line folds, converts inclusive LSP end lines to raw
exclusive offsets, ignores out-of-document/degenerate line ranges and rejects malformed
response shapes atomically. Optional character positions and collapsed text are not used.
Provider kinds become groups, including custom kinds; discovery policy remains separate.

The main demo uses TypeScript outlining for both working files and immutable saved snapshots.
The saved snapshot shares the host's syntax-color worker; it never borrows live-document ranges
or a provider version. Each pane keeps independent fold choices, and the working pane retains
the source view's choices when entering/leaving review. Both panes offer the same language-based
controls; alignment gaps reflect hidden rows without implying a source deletion.
**Host outline · indentation folding** demonstrates nested blocks,
blank lines and region groups without requesting a language provider. The Code menu exposes
individual and grouped commands. Find, editing and shared undo use the same fold projection.

```ts
const folds = view.folding;
folds.setRanges(folds.getSnapshot(), [
    { id: "section", from: headerOffset, to: nextSectionOffset, collapsed: true },
]);
folds.setCollapsed(folds.getSnapshot(), "section", false);
```

Commands capture both document `revision` and fold `generation`, scoped to this view handle.
Stale or disposed commands return `false`; invalid ranges throw before publication. Each range
has a unique nonempty identity, a visible header and at least one body row. `from` locates the
header; `to` is exclusive. A range ending at the next row's start leaves that row visible. Ranges
may nest or remain disjoint, with one identity per header; crossing ranges are rejected. Omitting
`collapsed` preserves an existing identity's state. Public snapshots and indexes are immutable.

Folding changes neither text, dirty state nor document history. Views of the same document fold
independently. Raw anchors map through edits and shared undo/redo. Deleted boundaries expand
their region; degenerate, merged or crossing definitions are invalidated. Undo restores text
exactly, but does not recreate invalidated view metadata: the host must supply fresh definitions.

The sparse `FoldIndex` stores outer collapsed intervals. Source-line/visible-row queries use
binary search; it allocates no array proportional to document line count. Mapping and rebuilding
metadata scale with supplied fold count. DOM and native text contexts stay limited to visible
rows and existing input bounds. This is not a claim of constant-time arbitrary fold updates.

Arrow/Page commands and visual-line edge traversal skip hidden rows. An intentionally collapsed
existing raw caret projects onto the visible header without changing its raw offset. Explicit
selections, typing, Find and reveal commands expand hidden targets before acting. Secondary
carets hidden by the same header do not create duplicate painted carets. Comparison panes keep
independent state; hunk navigation expands the entire target hunk, including a hidden body whose
first changed line is the visible header. Raw diff and Save/Run inputs remain unchanged.

Visible headers expose native disclosure buttons with `aria-expanded` and line-range labels.
Collapsed headers also show an inline hidden-line count at the visible end of the header.
This generated presentation is outside source text nodes, clipboard data and caret offsets;
partially rendered long headers show it only when their actual line ending is in the fragment.
Enter/Space toggles; Escape returns to the source. Source Escape followed by Tab or Shift+Tab
leaves the editor for host controls. Buttons capture tab, revision and fold generation, so delayed
clicks cannot act on a new target. Folding is guarded during composition; synthetic checks do
not qualify native IME behavior. Those device checks remain unverified.

Retained view handles preserve folds through remount. `captureView()` includes fold metadata;
`restoreView()` may initialize a new empty view of the same document and revision, and never
overwrites newer fold state. Disposal releases subscriptions, disclosure DOM and queued work.

Both evaluation hosts expose **Fold selected lines**, **Expand all folds** and
Ctrl/Cmd+Shift+[ / ]. Multiline selections create folds; a single-line selection inside an
existing region collapses that region. These are host commands, separate from language parsing.

`npm run bench:host-folding` is the affected interaction experiment: normal/100k-line sources,
one/1,000 folds, one active caret, independent source/review views and background host traffic.
It retains raw warmups and observations. Adapter key/input-handler durations are separate from
key/beforeinput-to-review readiness, complete automation actions and full workflows. Readiness
requires exact complete selections, current fold generations, all working views, immutable
reference/comparison settlement and two animation frames. Later language replies are outside
that gate; a real worker reply is required before each pair of points. No physical-display,
CPU-time, OS input or blanket responsiveness qualification follows from this experiment.

`FoldIndex.sameProjection(other)` compares hidden row intervals, independently of expanded
range metadata. Captured completion, navigation, rename, quick-fix, hover and signature UI use
this distinction: discovery of expanded folds must not dismiss a valid result. Changes to
visible folded rows still expire display captures; document, selection and provider guards
remain separate. Consumers that key display intent to every metadata generation should use
projection equality when adding automatic discovery.
Expanded discovery metadata also preserves continuous typing undo groups; a changed visible
fold projection still seals the current group.
