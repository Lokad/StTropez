# Cooperative positioning execution

An already compiled positioning plan exposes `createCursor(ownedSubstitutionResult, options)`.
The cursor advances through metrics, lookups, legacy kerning, pen/index construction,
attachment resolution and private glyph publication. The host calls `next(workBudget)` and
chooses when to yield to its event loop. The minimum budget is 256 counted operations; the
default is 4096. Progress snapshots are frozen and expose no partial result. Only `ready`
publishes the complete immutable positions and retained signed advance index.

The synchronous `apply` API drains this same generator kernel. Long searches through ignored
marks, nested contextual actions, cursive graph traversal/rerooting and final glyph publication
can suspend inside their loops. Lookup-pass and legacy-table traversal also count work for empty
or single-glyph streams. Cancellation calls the generator's return path, disposes its
advance builder and clears unpublished state. A completed result retained by a consumer remains
valid after cursor disposal. Operation/depth/cycle failures throw, leave a terminal failed
snapshot and publish no partial geometry. `dispose()` is idempotent.

Cooperative input must be a deeply immutable result produced by this font implementation's
GSUB stage. An internal weak ownership registry makes capture constant work. Those source
glyphs can be reused safely instead of copied again. Structurally supplied or mutable results
remain accepted by synchronous `apply`, which retains its validation/copy path. They are rejected
by `createCursor`. This avoids traversing mutable input while host tasks may run between steps.

Cursor metric overrides use an immutable `AdvanceIndex`, with one font-unit advance per glyph.
The synchronous API also retains its numeric-array overload. Primitive operation/depth options
are captured when the cursor is created. Font replacement or native face disposal does not
change the retained font data, source result or metric index. A host must still check the complete
resource/document revision, tab generation and font/style generation before presenting delayed
layout; the kernel does not infer application identity from focus or an array position.

Variable/device value records are resolved during plan compilation so execution does not hide
long variation-region loops inside a value lookup. Compilation remains synchronous and is
measured separately. [GSUB execution](substitution-cursor.md) now has its own cooperative cursor
and bounded input builder. Unicode/script analysis, per-glyph policies, fallback and complete
variable-font metric/outline instances remain required work.

Budgets count inspected operations and yield in quanta. Small table/index searches are bounded
primitives. Native typed-array allocation, garbage collection and final flat-array freezing are
atomic JavaScript operations; a counted budget is not a hard time deadline. Measurements include
these costs in actual `next` clocks. Complete workflow/retained-memory budgets are not established.

Headless cases preserve every original positioning fixture across different budgets, exercise
long ignored-mark searches and nested stacks, cancel during pens/publication, verify ownership
and metric capture, and retain terminal failure behavior. Browser scenarios use host timers,
real input and animation frames while positioning continues across font replacement. A gated
private-publication case verifies native cancellation without depending on an input race.
Input/plan preparation precedes this scheduled interval; these tests do not claim end-to-end
cooperative text shaping. The existing native pixel controls remain in the positioning suite.

`npm run bench:position-cursor` measures eight conditions with three warmups and twenty trials:
two pair budgets, long cursive/mark chains, RTL legacy kerning, signed metric overrides and
cancellation during pens/publication. It retains raw slice clocks and work deltas. The CPU
benchmark drains without event-loop scheduling; browser tests provide separate scheduling
evidence. Heap samples lack stabilized GC or retained/peak qualification.

The ordinary renderer still uses partial-row shaping and estimated origins. This cursor does
not certify ink, carets, source clusters, complete font selection or visual long-row navigation.
Cooperative compilation, combined layout lifecycle capture, full geometry and actual bounded
renderer integration remain open. No worker, WASM or runtime dependency is selected.
See [horizontal positioning](positioning.md), [substitution](substitution.md) and [advances](advances.md).
