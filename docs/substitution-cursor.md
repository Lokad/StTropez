# Cooperative glyph substitution

`SfntFont.createGlyphRunBuilder()` creates owned immutable logical input without an unbounded
copy in the execution cursor constructor. Each `append` validates and copies at most 256 nominal
glyph IDs, optional classes and source spans, then commits the batch atomically. A failed batch
leaves the previous snapshot intact. `finish()` publishes an opaque `GlyphRun` with `font`,
`length` and `at(index)`. Blocks and records are frozen; input mutation and builder disposal
cannot change the run. The builder releases its captured font and input state on completion or
disposal. Spans are integer source provenance, not certified Unicode clusters or caret mappings.

An already compiled GSUB plan exposes `createCursor(runOrOwnedResult, limits)`. It accepts a
run or a prior immutable GSUB result from the same font. Capture checks ownership and font
identity in constant work. Plain arrays remain accepted by synchronous `apply`; cooperative
execution requires owned input. `apply` also accepts owned inputs and drains the same generator.

`next(workBudget)` advances private input nodes, associations, cycle validation, lookups,
ordinal mapping and glyph publication. The minimum budget is 256 counted operations; the default
is 4096. Searches through ignored marks, contextual action stacks, multiple expansion, ligature
contraction, attached-mark snapshots/reassociation, active frame updates and source flattening
can suspend inside their loops. Empty inputs still count selected lookup passes. Large sets and
maps are populated incrementally rather than hidden in bulk constructors.

Frozen progress snapshots expose counts and phases, with a null result until `ready`. Glyph
counts describe private work in progress; only the final result is a consumable layout stage.
Operation, glyph-count and depth limits fail without publishing partial data. Cancellation calls
the generator return path, unwinds contextual frames and releases the job. Completed results and
captured inputs remain valid after disposal. A completed GSUB result can feed a positioning cursor
directly, with no synchronous intermediate glyph copy. Both use the same internal cursor driver.

Already owned source component arrays are reused. Newly expanded glyphs may retain repeated
source components; component count is not character or caret count. Ligature contraction keeps
the full supplied context, including nested consumption beyond a parent rule's input and the
association of intervening marks. Later contextual sequence positions follow previous edits.

Work budgets count inspected operations and yield in quanta. Native allocation, array growth,
freezing and garbage collection remain atomic costs; a budget is not a hard time deadline.
Compilation remains synchronous. A separate [Unicode stage](unicode-shaping.md) supplies
normalization, character facts and cooperative nominal mapping into owned runs. [Script interpretation](script-itemization.md)
and cooperative glyph partitions now support distinct feature selections. Complex-script reordering,
language/per-glyph feature policies, fallback and complete variable-font instances
remain required. The host still captures document/resource, tab and font/style
generations together and checks them before presenting delayed results.

Headless cases cover every original native fixture at varied budgets, uneven/invalid input
batches, long ignored-mark searches, expansion and beyond-input contraction, large attached-mark
sets, reused provenance, reverse scans, deep contextual stacks and cancellation in every phase.
Browser cases run bounded preparation, GSUB and positioning alongside native typing and animation
frames while a font is replaced. Private-publication cancellation leaves input reusable. Existing
native GSUB observations compare both execution modes; known policy differences remain visible.

`npm run bench:substitution-cursor` records nine conditions with three warmups and twenty trials:
input construction, two ligature budgets, multiple/contextual expansion, distant marks, reverse
scanning and cancellation during input/publication. Raw slice clocks, work deltas and maximum-call
phase are retained. CPU draining is separate from browser scheduling evidence. Heap samples do
not establish retained/peak memory budgets or long-session behavior.

Cooperative font compilation, complete text analysis/shaping, certified source/cluster/outline/
ink/caret geometry, combined layout lifecycle, exact bounded renderer origins and visual long-row
navigation remain required. The ordinary renderer still uses partial-row shaping and estimated
origins. No complete font backend, runtime dependency, worker or WASM is selected.
See [substitution](substitution.md), [positioning execution](position-cursor.md) and [font ownership](fonts.md).
