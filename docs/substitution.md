# Glyph substitution stages

`SfntFont.substitutionPlan({ script, language, features, normalizedCoordinates })` selects an
OpenType GSUB stage from owned font data. Requested feature tags and numeric values are explicit;
required language features are included. Script selection uses the requested script or `DFLT`;
language selection uses the requested language or that script's default. Selected lookups run
once in font lookup order. Different script-processing stages require separate plans. A shared
lookup with conflicting feature values rejects rather than choosing an implicit alternate.

The original TypeScript reader implements all eight GSUB lookup types: single, multiple,
alternate, ligature, contextual, chained contextual, extension and reverse chained single.
It supports each contextual format, list/range coverage and class definitions, 32-bit extension
offsets, GDEF glyph classes, mark attachment classes and mark filtering sets. Lookup flag
precedence applies independently to each nested lookup. A numeric alternate value is a one-based
choice; an unavailable choice leaves that glyph unchanged. FeatureVariations uses the first
matching supported record and caller-supplied normalized axis coordinates, defaulting to zero.
Axis normalization, variation metrics and outlines are separate work.

`plan.apply(glyphs, limits)` accepts a logical glyph sequence with source spans, or a prior
substitution result's glyphs. It copies source mappings before execution. Every glyph ID belongs
to `plan.font`, an immutable owned font snapshot. Sources use caller-supplied offsets; the caller
retains the corresponding resource/document/revision identity. Outputs preserve component source
spans through one-to-many and many-to-one transformations. Repeated source spans are retained;
component count does not establish the number of characters or legal caret stops.

Ignored marks remain in the sequence. Ligatures record their association with source components;
later ligatures remap those associations. Multiple decomposition clears associations to the
decomposed ligature. Association indices address the returned immutable glyph snapshot. They are
not document offsets, font identities, tab positions or delayed-work targets. Returned glyphs,
components, source spans, associations and selection metadata are frozen. Returned font data and
plans survive native face replacement/disposal; they do not keep an obsolete native face registered.
Layout work must still capture font/style versions together with resource/document/tab generations.

Execution uses a private linked sequence so each ordinary ligature does not shift the remaining
glyph array. Context actions address the sequence after preceding actions. Nested substitutions
can consume beyond a parent's initial input pattern; scan boundaries and active context positions
are updated when that happens. Reverse chaining traverses from the logical end. Matching has
access to the supplied complete context, including arbitrarily distant ignored marks. No fixed
fragment halo is substituted for that context.

This is a synchronous global kernel. Configurable operation, output-glyph and nesting limits
raise `SubstitutionLimitError`; they do not publish a truncated result. The input and plan remain
unchanged on failure. Nesting defaults to 64 and can be configured up to 256. These limits bound
accepted execution work; they are not cooperative time slices or ordinary-edit latency budgets.

The project had no glyph substitution interpreter. Its owned binary reader and observable font
assets are reused. An original implementation preserves the zero runtime dependency requirement.
The [GSUB specification](https://learn.microsoft.com/en-us/typography/opentype/spec/gsub),
[common layout formats](https://learn.microsoft.com/en-us/typography/opentype/spec/chapter2)
and [glyph definitions](https://learn.microsoft.com/en-us/typography/opentype/spec/gdef) define
the data and application rules. No third-party implementation or font data was copied.

## Evidence and limits

Generated original fonts exercise every lookup type, contextual format and filtering policy,
mutable-sequence action indices, feature/language selection, normalized variation conditions,
malformed offsets/glyphs, immutable source maps and execution limits. Native controls caught
and corrected an artificial parent-context boundary in the first implementation. The initial
source, headless result and differing native observations remain archived separately.

Twenty-seven original-font cases per engine retain both interpreter results and actual native
widths. For native GSUB comparisons only, kerning is explicitly disabled to separate positioning
from substitution. The ordinary fixture view keeps kerning enabled: `fi` now compares 60 px
nominal, 50 px after GSUB and 50 px native; `AB` compares 130/130/120/120 px after the separate
[positioning stage](positioning.md). Restored NuGet modules also execute the ligature and preserve its source components.

Native observations have limits. WebKit's one-character widths retain nominal values for the
direct single/multiple/alternate cases; multi-character and marked controls apply the same
substitutions. Emoji-adjacent chained contexts differ in Chromium/WebKit, while Latin-only
controls agree across engines. These are retained observations, not claims that either policy
establishes general shaping correctness. Higher-level itemization is a possible explanation for
the mixed-context difference. The existing variation-sequence/native-validation gaps also remain.

`npm run bench:substitution` records seven conditions, separating plan compilation from execution,
including 200,000 glyphs, multiple/contextual expansion and 100,000 intervening ignored marks.
Inputs/reference counts precede timing; execution includes input ownership and immutable result
publication. Raw heap observations have no stabilized GC or retained/peak-byte qualification.
See [font data](fonts.md), [native observations](shaping.md) and [numeric advances](advances.md).

The separate [Unicode stage](unicode-shaping.md) supplies normalization, character facts and nominal
mapping. This supplied-glyph stage does not implement script itemization/reordering, per-glyph feature
masks, fallback, variable font instances, outline interpretation, ink/caret
geometry or bounded renderer integration. Its supplied ranges are provenance, not certified
Unicode shaping clusters. [Cooperative GSUB execution](substitution-cursor.md) supports owned
logical glyph inputs; cooperative compilation and complete workflow/memory budgets still need
measurement and implementation. No complete font backend, worker or WASM is selected.
