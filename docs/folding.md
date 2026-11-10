# Per-view folding

`DocumentView.folding` is a stable observable handle. The host supplies raw UTF-16 ranges;
StTropez owns their view state, mapping, visible-row index and disclosure controls. This small
TypeScript implementation reuses the text buffer, position maps and viewport rather than adding
a runtime dependency. It does not parse a language or discover domain folds.
The [host-domain fixture](domain.md) demonstrates captured asynchronous discovery
and annotations outside the runtime. Hosts can call public `createFoldRegions`
to validate a complete response and preserve prior identity/collapse state before
publishing it through the view's fold handle.

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
