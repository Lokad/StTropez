# Font-aware canonical layout

`FontCascade.from(fonts)` captures an ordered list of immutable `SfntFont` instances with Unicode
cmaps. It copies the host's list and exposes frozen identity plus `length` and `at(index)`.
The host supplies loaded faces and ordering; the headless core performs no font discovery,
network request, family/style matching or application-service integration.

`createFontNormalizationCursor(original, cascade, options)` requires owned `NormalizedText`
whose form is `none`. It captures original points before normalization can detach a variation
selector from its base. Capture is O(1). Input, document text and font instances stay unchanged.
Options use original-point `from`/`to` coordinates and accept an owned grapheme index for the
exact identity and range. Otherwise the shared Unicode 18 grapheme cursor constructs one.
Explicit subranges use independent boundary context.

Each complete grapheme chooses one supplied font. Fonts are tried in host order; a covering
canonical representation in an earlier font takes priority over a later font's preferred form.
The `composed` preference first tries NFC and then recomposes only available font glyphs. The
`decomposed` preference first tries NFD and then composes to cover otherwise missing subsequent
characters. If these fail, a canonical-equivalence search covers aliases, partially composed
forms, composition exclusions and algorithmic Hangul. Compatibility decomposition is not used:
changing a ligature, superscript or presentation form into compatibility text is a separate policy.

The search uses licensed canonical facts for 2,081 mappings and algorithmic Hangul. A state
tracks starter order and consumption of equal-combining-class queues. Different combining
classes may interleave; equal-class order remains fixed. Each edge consumes the complete NFD
expansion of a font-covered character, including singleton aliases and excluded compositions.
The finite search therefore tests canonical equivalence without guessing a missing intermediate
glyph. Failed states are memoized, and the stack is explicit. An operation or search-state limit
fails the job; it never silently skips an untested earlier font. Native Unicode normalization
cannot supply pinned facts, font coverage, exact provenance or cancellation. An original
TypeScript implementation reuses the existing normalizer, graphemes, font reader and cursor
driver to preserve the zero-runtime-dependency contract.

Base/variation-selector pairs stay unchanged through canonical normalization. All supplied fonts
are tried for full standard-selector cmap14 support before any base-only retry. The fallback
keeps the selector in layout text and reports `variation-fallback`. A nondefault glyph zero is
uncovered. These queries recognize Unicode selector ranges and font-declared mappings; they
do not validate every registered variation sequence or discover installed fonts. Tests include
a registered heart sequence and explicitly artificial mappings. Mongolian selectors remain
paired and reported separately; their script-specific shaping is not implemented here.

Default ignorables and structural tab/newline controls remain in layout text and do not require
nominal cmap glyphs for coverage. Raw surrogates remain unchanged and use replacement-character
coverage queries, matching the existing nominal mapper. If no supplied font covers the complete
cluster, the primary face receives an explicit `missing` result and canonical layout text. The
cluster is never silently split across fonts. Nominal coverage does not establish script support,
emoji composition, glyph appearance or correct advances for default ignorables.
The following [glyph visibility stage](glyph-visibility.md) preserves control properties through
substitution and suppresses unchanged ignorable advances during positioning. Selector validity
and script-specific interpretation remain separate requirements.

The ready `FontNormalizationIndex` retains `input`, `text`, `cascade`, the original-point
`graphemes`, `clusterCount` and `runCount`. `text.form` is `font`, deliberately separate from
Unicode normalization forms; `NormalizationForm` options still accept only the five original
values. `LayoutNormalizationForm` describes the expanded result metadata. Cluster records
separate input points, original UTF-16 spans and output points, and report font index, coverage,
missing glyphs and unsupported variants. Adjacent selections of the same font form frozen runs
over output-point ranges. Exact source spans survive decomposition, reordering and composition.
Published data uses frozen blocks of 256 and remains usable after cursor disposal.

Ranged nominal mapping accepts `from`/`to` output points and retains absolute point coordinates.
It rejects cuts through a consumed variation pair. Script glyph partitioning requires its script
range to be inside the mapped font range and to share the exact owned text identity. This allows
one font run to dispatch separate script plans without remapping the complete text for each font.

Progress reports grapheme, preparation, normalization, coverage, search and publication phases,
work, font attempts, search states and diagnostic counts. No partial result escapes. Options and
font lists are captured; disposal closes nested cursors and clears private work. Operation,
point-expansion/output, cluster and search-state limits are explicit. Constructors, work quanta
and time budgets do not bound native allocation, array growth, freezing or GC. No production
frame or retained/peak memory budget follows from this implementation.

The shaping fixture schedules original-point construction through font selection, per-font script
itemization, ranged mapping, owned glyph partitions, ccmp/locl/ligature features and positioning.
It captures source revision, preference, request generation and both native font generations.
Replacement, typing, cancellation and disposal expire scheduled work; retained immutable results
keep the old font data. This diagnostic uses explicit Latn/Grek/Hebr/DFLT plans and default
language. Complete language models, feature masks, script-specific transformations, variants,
outlines, ink/caret geometry and combined Workspace resource/document/font/style/tab capture
remain separate requirements.

Tests cover every canonical mapping and Hangul syllable, all 853 official grapheme rows and
1,547 source-cluster extents, limits, cancellation, exact origins and per-font/script dispatch.
Shared bounded UTF-16 decoding also preserves clipped surrogate ranges in normalization,
graphemes and bidi, with heated headless and three-engine checks. A 105,689-case interpreted
replay against the prior checkpoint preserves existing normalization records and counters;
optimized input/coordinate checks use an explicit code-unit oracle.
An independent exhaustive concatenation oracle checks 6,000 small cases. Browser controls retain
all 16 original-font comparisons and native differences (4/6/10 in the declared Chromium/Firefox/WebKit environment); native output is not the canonical
coverage oracle. `npm run bench:font-normalization` records eleven conditions with three warmups
and twenty trials, including a million-mark cluster, 30,000 font/script parts, reused graphemes
and private-phase cancellation. Its clock-free `--verify` mode checks all assertions first.
