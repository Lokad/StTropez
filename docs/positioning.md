# Horizontal glyph positioning

`SfntFont.positioningPlan(options)` compiles original TypeScript GPOS lookups over an owned
font. `apply(substitutionResult)` accepts the same font's immutable logical GSUB result and
publishes immutable positions, attachment targets, source components and a signed `AdvanceIndex`.
The browser font asset may be replaced or disposed while these captured values remain valid;
their native font generation still expires. A host must capture document/resource, tab, style
and font generations together before publishing delayed layout.

The kernel supports GPOS1–9: single and pair values, cursive attachment, mark to base/ligature/
mark, contextual/chained rules and extensions. Shared coverage/class and context readers reuse
the substitution stage. Required/optional features, script/language selection, normalized
FeatureVariations, GDEF filtering and mark association are explicit. Feature selection is uniform
within this supplied stage; script analysis and per-glyph feature masks remain separate work.

Values use font units with positive Y upward. Horizontal `yAdvance` is read but ignored. Logical
RTL progression stores negative signed advances; glyph origin accounts for its adjusted advance.
Attachment graphs resolve iteratively and carry later target placement. Cursive baseline flags
and mark-to-ligature source component associations are retained. Component counts do not certify
Unicode clusters or caret counts. Operations, recursive lookup depth and attachment cycles have
explicit failure limits; failures publish no partial result.

Device formats1/2/3 use captured X/Y ppem and convert pixel deltas to font units. VariationIndex
resolves the GDEF ItemVariationStore at supplied normalized coordinates, including long-word
rows. This does not implement variable outline or advance metrics. Anchor format2 uses copied
caller-supplied contour points when available; otherwise the design coordinates remain and the
fallback count is reported. There is no outline decoder or hint interpreter.

Legacy kerning runs only with `legacyKerning: true`. OpenType version0 formats0/2 support
horizontal additive/override and cross-stream values/reset. The caller selects policy to avoid
double-applying GPOS and legacy kerning. Apple containers/state machines, minimum-distance and
other formats are unsupported; vertical positioning is outside this API. Class offsets follow
the OpenType format2 contract. Unsupported data fails explicitly when this stage is requested.

The retained index describes pen intervals. It provides exact bounded numeric queries, including
negative/zero advances and global coordinates beyond native scroll limits. It does not locate
ink overhangs or certify hit testing, carets or selection geometry. Cursive advance/offset
decompositions can differ from native pen APIs while actual fixture pixels agree.

## Native evidence

The browser suite loads34 original rectangle-font cases per engine and records widths and real
SVG screenshots, independently comparing known fixture outlines with positioned glyph origins.
A one-pixel boundary band allows raster antialiasing; every other pixel is checked. Fixed integer
SVG coordinates avoid fractional screenshot cropping. SVG range/character/box APIs describe pen
or line cells in these observations and cannot substitute for actual placement pixels.

Native pixels disproved an earlier RTL implementation that subtracted nominal rather than
adjusted advances; that source and its passing old assumption are retained in ignored research.
Registered Hebrew single/pair/mark and legacy controls now agree in all engines. Cursive controls
agree in Chromium/Firefox; WebKit retains placement differences. DFLT-only RTL fonts retain
nominal native widths until a matching script registration is supplied. WebKit additionally
differs for one-character positioning, some single/contextual/chained Y placement and mark
stacking. Device advances agree in Firefox while Chromium/WebKit retain nominal advances.
Supplied contour-point overrides differ from all native engines; no-point fallback controls
agree. These cases are tested and recorded, with no skips or claims of general native parity.

The visible fixture keeps native kerning enabled: `AB` is130px nominal,130 substituted,
120 positioned and120 native; `fi` is60/50/50/50. The restored assets-only NuGet consumer executes
the same substitution, positioning and retained index after native font disposal.

`npm run bench:positioning` separates compilation from eight global conditions, with3 warmups
and20 samples. Pair and explicit RTL legacy runs reach200k glyphs; mark/cursive chains reach100k.
Raw heap observations do not establish retained/peak budgets. The synchronous API now drains
the shared [cooperative execution cursor](position-cursor.md); hosts may schedule that cursor directly.

The [Unicode stage](unicode-shaping.md) supplies normalization, character facts and nominal mapping.
Script itemization/reordering, per-glyph feature policies, fallback, complete variable
instances, certified source/cluster/outline/ink/caret mappings, combined layout lifecycle capture,
complete-pipeline cooperative scheduling, exact bounded renderer origins and visual long-row navigation remain
required. The ordinary renderer still uses its existing partial-row and estimated-origin path.
No complete font backend, worker, WASM, third-party parser or runtime dependency is selected.
See [font ownership](fonts.md), [substitution](substitution.md), [advances](advances.md) and
[native shaping observations](shaping.md).
