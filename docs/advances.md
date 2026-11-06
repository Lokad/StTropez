# Retained advances

`AdvanceIndex` stores supplied advances with prefix coordinates and spatial queries over their
cells. It does not replace the font shaper or source/cluster mapping. An ordinal identifies
a measured entry in this snapshot; it is independent of UTF-16 offsets, glyph identity,
document revision and tab identity.

`AdvanceIndex.from(values)` copies a complete sequence synchronously. For cooperative work,
`createAdvanceBuilder()` accepts `append(values, from?, to?)` slices of at most 256 entries.
Each call copies its inputs and exposes progress metadata without a partial index. `finish()`
publishes an already-built immutable root. Invalid input, overflow or reentrant writes leave
prior progress unchanged. `dispose()` clears builder references; returned indexes remain valid.
The host owns scheduling and validates captured resource/document, font/style revision and
tab generation before publishing layout.

`at(ordinal)` reads an advance; `prefix(end)` returns its preceding cumulative coordinate.
`slice` and `replace` return immutable values sharing unchanged subtrees. Replacement takes
another prepared index, allowing large measured regions to be constructed before an atomic
splice. These operations change no document text and perform no implicit range mapping.

Positive, negative and zero advances are supported. `minimum`, `maximum` and `total` differ:
the final pen coordinate need not be its furthest extent. `window(low, high, limit = 512)`
returns advance cells intersecting a half-open coordinate interval, retaining sequence order.
A nonzero cell covers the interval between its two prefix positions, excluding the upper
edge. A zero cell is a point included at the query's lower edge and excluded at its upper
edge. Results report truncation and exact traversal/read counters. Limits from 1 to 4,096
bound returned entries. Signed subtree bounds and zero-cell endpoint summaries permit
pruning without assuming that coordinates increase monotonically.

An advance cell is not an ink box or certified caret stop. Overhangs, attachments, ligature
interiors, bidi affinities and shaping clusters need separate mappings and geometry. Sparse
observations do not form a complete glyph layout. Coordinates use JavaScript binary64 sums,
including normal rounding; font comparisons need an appropriate numeric tolerance. No fixed
pixel quantization or width estimate is applied. The supplying measurement path defines units.

The AVL join/rotation helper is shared with indexed text storage. Private owned `Float64Array`
leaves hold at most 256 entries and never escape the frozen public facade. Input buffers are
not retained. `diagnostics()` exposes cached logical tree counts; `AdvanceIndex.retained`
explicitly traverses unique nodes/numeric leaves across versions. These representation slots
are distinct from heap bytes and long-session budgets. The project had indexed text storage
but no measured numeric sequence; sharing that implementation and adding an original measure
layer preserves the zero runtime dependency contract.

The [glyph-positioning specification](https://learn.microsoft.com/en-us/typography/opentype/spec/gpos)
distinguishes advance and placement. Character widths alone cannot implement general shaping.
The [native oracle](shaping.md) now retains up to 256 raw range-left observations, preserving
every native rectangle and defining the left edge as their minimum. Probe revision/generation
checks reject stale or replaced source. The retained values survive native probe disposal,
including multi-rectangle emoji observations. The ordinary viewport remains on its existing
partial-row path; these samples do not supply the missing glyph/cluster/ink pipeline.

`npm run bench:advances` measures four precomputed numeric conditions with three warmups and
twenty measured runs. It separates append, seal, prefix/window lookup, persistent splice and
immutable flat-prefix-array update. Input/reference generation precedes timing. Construction
loop clocks include instrumentation. Replacement starts from already measured values and
excludes shaping, source mapping and rendering. Read counters and shared numeric-slot retention
are checked with raw CPU samples and source/environment metadata. Desktop diagnostics and
one-index GC observations do not qualify production or long-session memory.

[Owned font data](fonts.md) can now provide nominal cmap/hmtx values and separately versioned
native font assets. Nominal values exclude substitution and positioning. Full-context shaping,
complete cluster/ink/caret data, captured font/style lifecycles in layout, renderer integration,
native-device acceptance and production budgets remain required.

The separate [horizontal positioning stage](positioning.md) reuses owned GSUB provenance,
implements explicit GPOS/legacy policies and publishes retained signed pen advances.
