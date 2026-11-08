# Bidirectional text

`resolveBidi(text, direction = "ltr")` resolves Unicode 18 bidi levels and visual order through
rule L2. Directions are `ltr`, `rtl` and `auto`. Results contain frozen UTF-16 `levels`, an
`order` of code-point start offsets, and paragraph ranges with their resolved base levels.
Both halves of a surrogate pair receive the same level. A `null` level denotes a character
removed by X9; the backing text remains intact. CRLF is one paragraph separator. Each paragraph
is treated as one unwrapped line. Shaping, glyph mirroring and grapheme placement belong to
the renderer; wrapped-line reordering requires the paragraph context and actual line breaks.

The implementation handles explicit embeddings/overrides, isolate matching, overflow depth,
isolating run sequences, weak types, canonical bracket pairs, neutral types, implicit levels
and trailing whitespace. The explicit depth limit is 125; resolved levels can reach 126.
The synchronous utility uses the same kernel as `BidiCursor`, then explicitly materializes
full metadata arrays. Its work and memory remain proportional to the requested text.

`new BidiCursor(bufferOrString, { from?, to?, direction? })` performs no initial text read.
`next(workBudget = 4096)` advances scanning, resolution or publication, with checkpoints at
roughly 256 algorithmic work units. Reads use 256-unit slices plus a possible surrogate seam.
Snapshots report `scannedUnits`, `readUnits`, `workUnits`, phase and status. Reads cover the
entire requested range over time. No partial index is published, and no whole-text export is
needed. Allocation and garbage collection can exceed a CPU scheduling threshold; the work
budget is not a hard realtime limit.

The ready `BidiIndex` exposes absolute-source queries: `levelAt`, `offsetAt`, `indexOf` and
`paragraphAt`, with range/length/count metadata. `visualLength` counts the reordered code
points through L2, including retained zero-advance controls; it is not a glyph count.
An interior surrogate position, a removed character or the range end has no visual index.
The immutable query facade avoids copying full arrays at publication. `materialize()` is an
explicit proportional operation returning arrays and paragraph ranges relative to the captured
range. `dispose()` cancels unfinished work and releases the input; previously returned indexes
remain valid immutable values.

Consecutive original strong-LTR characters share one weighted resolution atom. Expansion
preserves code-point boundaries and follows the resolved level's parity, including directional
overrides. Weak separators and bracket characters retain their individual positions. The
full conformance data and long surrogate/override cases cover this optimization.

`createBidiIndexController(workspace, tabId, { direction? })` adds resource ownership and a
stable observable handle. `request({ expectedRevision, from, to })` captures a range and returns
a generation; a stale expected revision returns `null` without retargeting or disturbing work.
The host drives `advance(workBudget)`. Revision changes make the result stale, and tab closure,
replacement or unavailable resources expire it. A fresh request uses a fresh captured revision.
`isCurrent(generation)` guards later consumption. `cancel` clears a pending result; `dispose`
releases subscriptions and the resource lease. The controller changes no selection or text.

The existing project had native local ranges and grapheme segmentation, but no bidi resolver.
StTropez reuses those shaping and lifecycle mechanisms. A generated character table and an
original TypeScript implementation of the normative rules preserve the zero runtime dependency
contract. Unicode property facts and development conformance fixtures use the notice in
[Unicode-3.0.txt](../licenses/Unicode-3.0.txt); no upstream implementation is included.
`scripts/generate-bidi-data.mjs` accepts a reviewed data directory. No Unicode-data download
or generation runs during ordinary builds or consumer restores.

The headless tests check every Unicode code point's bidi class, all 770,241 direction cases
in the type conformance data, and all 91,707 character conformance paragraphs. These suites
cover resolution/reordering through L2; they establish no browser shaping, native-input,
assistive-technology or global layout qualification.

For a mounted row, the browser measures native grapheme ranges and combines them with resolved
levels. A logical boundary can have two visual positions:

| Affinity | Boundary position |
| --- | --- |
| `before` | End of the preceding logical grapheme |
| `after` | Start of the following logical grapheme |

Native collapsed ranges are used when their positions agree with the resolved glyph direction.
Nonempty glyph ranges supply the other edge at ambiguous bidi boundaries. Adjacent visual
clusters share one insertion position, so integer/fractional range rounding cannot introduce an
extra stop. Reconciliation joins their shared edges and preserves the two edges of narrow glyphs.
Zero-advance controls receive stable positions from neighboring visible clusters. Geometry reads
leave styles, document Selection and host DOM untouched. Cache invalidation follows DOM rebuilds,
font/style metrics and row movement. Collapsed selections do not split decorated text nodes.

Left/Right follows physical glyph order on complete rows, with Shift preserving the logical
anchor and its affinity. Non-shift selection collapse uses the selected visual edge. Line-edge
movement follows the paragraph flow, including raw CRLF offsets and empty/control-only rows.
Captured view state retains affinities even though the native textarea cannot represent them.
Set `--st-text-direction` on the supplied host to `ltr` (default) or `rtl` for paragraph flow. The scrolling
container retains LTR coordinates; row text and the native input context carry the chosen
paragraph direction independently. This keeps horizontal view state positive across engines.
Decorations preserve their paragraph's `direction` and `unicode-bidi`; they style the text
without introducing a separate directional protocol.

The browser scenarios cover both paragraph directions, Hebrew/Arabic/numbers, single RTL glyphs,
isolates, overrides, brackets, combining sequences, emoji, pointer affinity, selection reversal,
offscreen coordinates and line boundaries. Complete rows retain their full native shaping
context. Partial long rows still use fragment shaping and estimated global origins; visual
commands fall back to logical grapheme movement there. `partialRows` makes this distinction
observable. Contextual long-line indexing, native-device input and production budgets remain open.

The development paragraph controls exercise full captured-range resolution while navigation,
typing and animation frames continue. Their host scheduler batches up to eight 4,096-unit
advances, stopping sooner after four milliseconds, and clears timers on cancellation, source
changes, expired targets and disposal. Current-line requests retain raw CRLF ranges and use
the primary view's captured selection. This analysis supplies paragraph context for the next
layout stage. Global font shaping and measured window origins remain unqualified; ordinary
rendering continues to expose partial rows and its current geometry limits.

`npm run bench:bidi` records three warmups and twenty measured samples for four headless
workloads and four actual browser key conditions. Kernel elapsed time, capture-to-target-bubble keydown elapsed time and
key-to-frame-ready proxy remain separate. The field named `handlerMs` is the event observation
span; it includes the adapter and synchronous listeners between those endpoints. It is separate
from the adapter's own `lastKeydownMs` and does not measure process CPU time. Guards require complete rows, visual movement,
unchanged text/revision, bounded native context and zero exports. Raw samples and source/display
provenance stay in ignored `artifacts/bench/bidi/`. The long-paragraph kernel case measures the
utility's proportional cost; it does not qualify cooperative browser layout or presentation.

`npm run bench:paragraph` measures four cooperative kernel conditions (three warmups, twenty
measured runs) and two actual browser jobs (three warmups, ten measured runs). It records raw
advance/turn elapsed time, work/read counts, frame progress and overall readiness separately. Post-GC
heap differences retain the final index and raw samples; they are process observations rather
than isolated byte counts or production retention budgets. The browser guards check exact
captured ranges, live frames, unchanged revisions, bounded DOM/native input and zero exports.
