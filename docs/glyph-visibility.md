# Glyph properties and visibility

Nominal mapping attaches immutable `GlyphProperties` to each glyph. The properties identify
default ignorables, ZWJ, ZWNJ and variation selectors in the mapped input point. They describe
that point independently of UTF-16 source spans: normalization can split one source character
into several points, reorder them, or combine noncontiguous origins. A consumed standard
variation selector contributes provenance to its base glyph without turning that base into
an ignorable glyph.

All substitution lookup types preserve these properties. A successful substitution sets
`substituted`, including an identity substitution. Expansion copies the lineage to every
output. Ligatures combine the contributing flags and set `ligated`; `defaultIgnorable` remains
true only when every consumed input has that property. An input without metadata counts as
unknown and prevents the combined result from being classified as wholly ignorable. Later
substitutions retain the lineage flags. Ignored marks retain their own properties and exact
component associations. Shared property values are frozen, interned fixed-size records.
This small TypeScript stage uses the existing Unicode facts and layout kernels. Depending on
an external shaping runtime would conflict with the browser foundation's zero-dependency contract.

Positioning plans capture `defaultIgnorables: "hide" | "preserve"`, defaulting to `"hide"`.
An ignorable glyph that has undergone no substitution or ligation is hidden. Its initial
advance is zero before positioning computes distances; after positioning and optional legacy
kerning, its advance, offsets and outgoing attachment are zeroed before pen and attachment
resolution. The record remains in the result with `hidden: true`, its original glyph ID and
provenance. `hiddenGlyphs` reports the count without rescanning the result. Consumers must omit
its ink. Other glyphs may still use it as positioning context.
An explicit substituted result remains visible. The preserve policy retains nominal metrics
and positioning for diagnostics. Manually supplied glyphs without properties retain their
existing visible behavior; the engine never infers Unicode properties from glyph IDs or spans.

The builder and synchronous unowned-input paths validate and copy properties. Owned runs,
constant-work slices, substitution results and positioning cursors retain immutable captures.
Visibility and publication yield through the existing cooperative cursor protocol and expose
no partial result. Disposal releases the cursor's result; previously retained results survive.

The `/shaping/` cascade fixture measures unused join controls, formatting characters, tags,
soft hyphens, Mongolian selectors and non-ignorable controls against native fonts. Original
fixture widths and differences remain evidence, not a normative shaping oracle. The closed
cascade emoji example now has zero joiner advance. The NuGet consumer exercises the same
mapped/substituted/positioned metadata through compiled modules and declarations.

This is a glyph visibility policy, not a complete script shaper or a character validation
policy. Standard-selector mapping still follows the explicit font `cmap` contract: assigned
variation-sequence validation, Unicode 18 variation-base restrictions and visible diagnostics
for misplaced selectors remain open. Mongolian orthographic interpretation and shaping masks,
Hangul fillers, contextual soft-hyphen realization at line breaks, script-specific control
filtering, feature masks, native glyph appearance, ink/caret geometry and renderer integration
require separate work. Preserving source text does not certify those behaviors.

`npm run bench:glyph-visibility` records mapping, substitutions, ligatures, hide/preserve
positioning and cancellation with raw work and timing samples. Counted work does not provide
a time deadline or certify retained/peak memory budgets.
