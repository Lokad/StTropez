# Unicode layout text and nominal mapping

The headless core supplies Unicode 18.0.0 normalization and character facts without runtime
dependencies or native normalization calls. Licensed data facts are generated offline by
`scripts/generate-unicode-shaping.mjs` from an explicitly supplied, reviewed data directory.
The existing Unicode License V3 notice covers the generated tables and compressed test facts.
The generator checks the final version and exact license before writing output. It imports no
upstream implementation. This original TypeScript kernel preserves cooperative execution and
source provenance while meeting the zero-dependency requirement.

`unicodeScript`, `unicodeScriptExtensions`, `unicodeCategory`, `canonicalCombiningClass`,
`unicodeDefaultIgnorable`, `unicodeVariationSelector`, `unicodeJoinControl` and `unicodeBidiControl`
accept integer code points in 0..10FFFF, including raw surrogate values. Script names use ISO
15924 aliases, such as `Latn`. They are character facts, not resolved script runs or OpenType
feature tags. Script extensions are immutable arrays. `unicodeShapingVersion` identifies the
tables independently of browser or operating-system Unicode versions.

`createNormalizationCursor(buffer, options)` captures an immutable `TextBuffer` and an optional
absolute UTF-16 `from`/`to` range. Forms are `none`, `NFC` (the default), `NFD`, `NFKC` and `NFKD`.
Options and range boundaries are copied at construction. `normalizeText` drains the same kernel
synchronously. Neither API changes document text, revision or undo history. A host explicitly
chooses the layout form; this API does not choose a font-aware normalization policy.

The ready result is opaque immutable `NormalizedText`. Its `source`, `from` and `to` identify the
original buffer/range; `length` counts normalized points and `utf16Length` counts exported UTF-16
units. `at(index)` returns a code point and exact absolute source spans. Reordering retains each
point's origin, decomposition repeats that origin, and composition unions the participating
origins without filling gaps. For example, NFC of `A U+0315 U+0300` yields `À U+0315`; `À` retains
`[0,1)` and `[2,3)`. These spans are provenance, not certified clusters or caret stops.
`text(fromPoint, toPoint)` explicitly exports text; bounded consumers should query points/ranges.

Raw unpaired UTF-16 surrogates survive normalization, including ranges that split a pair. The
shared window decoder checks code-unit bounds explicitly; heated clipped-range tests cover
normalization, grapheme segmentation and bidi under optimized execution. Rope
chunks are read in bounded windows without a whole-buffer export. Recursive decompositions,
algorithmic Hangul and stable combining-class buckets implement normalization. A long canonical
segment uses work proportional to its length instead of quadratic insertion sorting. Such an
unbounded segment still requires proportional temporary storage. Output uses private frozen
blocks of 256 points. Composition provenance is flattened iteratively before publication.

`next(workBudget)` and `snapshot()` publish immutable progress; `result` stays null until ready.
The default budget is 4096 counted units, with a minimum of 256. Scan, decomposition, ordering,
composition and publication can suspend. `maxOperations` and `maxPoints` bound inspected work
and total decomposed points, including intermediate expansion. Terminal limits publish no partial
result. `dispose()` cancels/releases private work, is idempotent and leaves completed values valid.
Counted quanta are not hard time deadlines: native allocation, array growth, freezing and garbage
collection remain atomic costs.

`font.createGlyphMappingCursor(normalized, options)` (also `createGlyphMappingCursor`) requires
owned `NormalizedText`. It maps the captured font's cmap into a frozen `GlyphRun<SubstitutionGlyph>`.
The result retains `font`, `text`, `run` and `pointRangeAt(glyphIndex)`; point ranges address the
normalized sequence, whereas glyph source spans address original UTF-16. Mapping preserves exact
source components, including repeated and disjoint origins. The owned run can feed a compiled
GSUB cursor, whose result can feed a positioning cursor without a bulk copy at those captures.
The existing nominal builder still returns the default `GlyphRun<NominalGlyph>` type.

By default, standard selectors FE00..FE0F and E0100..E01EF resolve adjacent cmap format 14 pairs.
An unsupported pair retains the base mapping and increments `unsupportedVariations`; an isolated
standard selector is skipped and counted. `variationSelectors: "preserve"` leaves selectors in
the supplied sequence. Mongolian selectors are always preserved by the default policy because
script-specific GSUB processing is still required. Other default ignorables and join controls are
preserved. Raw unpaired surrogates use U+FFFD only for glyph lookup and are counted; their source
text remains unchanged. Missing glyph zero is reported, with no hidden fallback. Mark categories
provide a nominal mark class; the font's GDEF can override it during layout.
Mapped glyphs also carry immutable [control properties](glyph-visibility.md) through GSUB.
Positioning can hide unchanged default ignorables without discarding their glyph IDs or origins.

Mapping exposes ready-only progress, operation/glyph limits and disposal with the same lifecycle
rules. It does not resolve script runs, apply per-glyph feature masks, reorder complex scripts or
select fallback fonts. Plain NFC may choose a missing precomposed glyph even when a decomposed
sequence is covered. The separate [font-aware stage](font-normalization.md) selects canonical
representations and whole clusters from captured supplied fonts. Complete script/language
policies, system discovery and qualified glyph geometry remain required.

The [script stage](script-itemization.md) now interprets contextual runs and partitions mapped
glyphs into owned views for separate feature selection. Character facts remain distinct from
that explicit interpretation policy and complete complex-script processing.

The shaping example offers a diagnostic normalization → scripts → mapping → partitions → per-run
GSUB/positioning pipeline.
It captures its own source revision, normalization style, request generation and active font
version. Source/style changes and active font replacement expire delayed or ready results.
Pending font requests preserve the current captured face. Disposal removes listeners/timers and
freezes the diagnostic snapshot. Source creation and font plan compilation remain synchronous.
This host does not implement the editor's combined resource/document/tab/style/font lifecycle.

Tests check all 1,114,112 code points against reviewed property facts, every normalization row
and its twenty invariants, and identity for other assigned scalar values. Browser tests compare
all 80,684 source/form conditions to the Unicode 18 corpus in each engine, independently of native
`String.normalize`. Native results are retained separately: the tested Chromium/Firefox engines
have 400 differences and WebKit has 674. Exact profiles are checked for review when engines change;
native agreement is not substituted for versioned corpus conformance. Other cases cover long
combining segments, split surrogates, provenance, limits, cancellation, typing and font replacement.
The restored NuGet consumer executes the compiled normalization/mapping/GSUB/positioning chain.

`npm run bench:unicode-shaping` records eight conditions with three warmups and twenty trials:
ASCII, mixed compatibility decomposition, a 90,000-mark segment, Hangul composition, nominal
mapping, the four-stage pipeline, and cancellation during normalization composition/mapping
publication. Raw slice clocks/work deltas and maximum-call stage/phase remain separate from
browser scheduling observations. Source construction and compiled plans precede clocks;
mapping-only inputs are already normalized. Heap samples do not establish retained/peak budgets.

Complete script/language/fallback/mask policies, variable metric/outline instances, certified source/cluster/
ink/caret mappings, cooperative compilation, combined workspace lifecycle and exact bounded
renderer consumption remain required. Generated facts currently enter the public module graph;
optional loading and startup/production budgets remain unqualified. The ordinary editor renderer
still uses partial-row shaping and estimated origins. No full font backend, worker or WASM is selected.
See [font ownership](fonts.md), [substitution execution](substitution-cursor.md) and
[positioning execution](position-cursor.md).
