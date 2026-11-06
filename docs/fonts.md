# Owned font data

`SfntFont.from(bytes, { faceIndex })` copies uncompressed SFNT data and exposes immutable
metadata, character mappings and nominal default-instance horizontal metrics. The core has
no DOM, network, storage or native font API. Glyph IDs belong to that font data snapshot;
they are not source offsets, text revisions, tab identities or advance-index ordinals.

The reader supports single SFNT faces and TTC versions 1 and 2 with absolute table offsets.
It reads `head`, `hhea`, `maxp`, `hmtx` and `cmap`, including compressed repeated horizontal
advances with separate signed side bearings. Character maps support formats 0, 2, 4, 6, 8,
10, 12, 13 and 14. `encodedGlyphIndex` addresses an explicit encoding and raw character code;
`glyphIndex` accepts Unicode scalars and selects a Unicode encoding. A missing mapping yields
glyph zero. `variationGlyphIndex` returns a default/nondefault mapping or `null` for an
unsupported sequence. Encoding metadata makes selection inspectable. A font with only a
legacy encoding requires explicit encoded queries.

Directory spans, metric counts, character-map structures and mapped glyph bounds are checked.
Unknown cmap formats and compressed WOFF/WOFF2 sources are rejected. Checksums, outline
correctness, naming tables, all layout tables and whole-font safety are not certified. Outline
and variable flags report table presence; variation axes and metric deltas are not applied.
This is a nominal data reader, not a whole-font sanitizer or complete OpenType shaper.
An explicit [glyph substitution stage](substitution.md) now interprets GSUB programs over supplied
logical glyphs and source spans. Positioning and script analysis remain separate requirements.

The project had no font-data reader. An original implementation of these table rules preserves
the zero runtime dependency requirement without importing a parser library or a native/WASM
runtime. The public [font-file specification](https://learn.microsoft.com/en-us/typography/opentype/spec/otff),
[character-map specification](https://learn.microsoft.com/en-us/typography/opentype/spec/cmap)
and [horizontal-metric specification](https://learn.microsoft.com/en-us/typography/opentype/spec/hmtx)
define the formats. No reference implementation or third-party font was copied.

## Browser ownership

`createFontAssetController(ownerDocument, fontId)` returns a stable observable controller.
`request(expectedGeneration, bytes)` rejects stale generations with `null` before parsing.
It copies input, reads its data and starts a real native `FontFace` load under a unique private
family name. The operation captures its generation and returns a `settled` promise. Only a
current successful load registers its face and publishes a frozen `FontAssetVersion`. Native
registration currently accepts single SFNT faces; collection face selection is core-only.
The host chooses whether and where to apply the published family. No system font enumeration,
permission prompt, font installation or automatic editor-style change occurs.

The latest request generation and active version generation are distinct. A replacement load
or failure preserves the previous active version. `isCurrent(versionGeneration)` also checks
that its native face remains registered. `cancel()` invalidates pending work and retains the
active face. `dispose()` invalidates pending work and removes only the controller's own face.
Native decoding cannot be aborted by this API; obsolete callbacks cannot publish or register.
Previously captured core data survives native disposal. Expected-generation validation and
parsing errors leave prior state intact. Listener notification rules match the other controllers;
hosts queue mutations requested by a notification listener.

Font generations still need to be captured together with resource/document, style and tab
generations by future layout work. The asset controller alone does not qualify that pipeline.

## Verification and remaining layout work

An original generated rectangle font supplies a small, reproducible test asset. It includes
ordinary and supplementary mappings, a variation mapping, a zero-width mark, actual pair
kerning and a real `fi` ligature substitution. Tests overwrite source bytes after requests,
race two generations on an insecure origin without `randomUUID`, cancel/dispose pending native loads, preserve foreign faces and inject
an explicitly identified failure after real native decoding. A restored assets-only NuGet
consumer uses the compiled APIs and declarations for the same data/native lifetime checks.
The font is host test data; it is not an editor fallback font or a production font backend.

At 100 px, nominal `AB` advances total 130 px while native kerning produces 120 px. Nominal
`fi` totals 60 px while the native ligature occupies 50 px. The fixture preserves those features
to expose the gap. Native variation-sequence widths differ between tested engines, and native
load acceptance differs for malformed outline fixtures. Raw probes retain these differences;
successful `FontFace.load()` is not evidence of complete glyph or shaping correctness.

Nominal values can populate an [advance index](advances.md) for storage experiments. They
cannot supply final shaped advances, clusters, ink boxes or certified caret stops. Full-context
substitution/positioning, fallback, variable-font instances, script coverage, source mappings and
exact bounded renderer consumption remain open. The editor's ordinary font/rendering path is
unchanged. The [native oracle](shaping.md) remains a differential observation tool.

`npm run bench:fonts` separates SFNT/TTC parsing, 200,000 nominal queries plus index construction,
and variation queries, with three warmups and twenty measured samples. Real browser load,
same-turn replacement and cancellation each have three warmups and ten measured samples per
engine. Source/reference generation precedes timing; request clocks and settled-load proxies
are separate. Owned face counts, copied inputs and historical data are checked after disposal.
These are startup/global-operation diagnostics, not ordinary-edit or production memory budgets.

The separate [horizontal positioning stage](positioning.md) reuses owned GSUB provenance,
implements explicit GPOS/legacy policies and publishes retained signed pen advances.
The [Unicode stage](unicode-shaping.md) supplies versioned character facts, normalization with
original source provenance and cooperative nominal mapping into owned GSUB inputs.
The [font-aware canonical stage](font-normalization.md) reuses these facts for aliases, partial
composition and whole-grapheme selection over a host-supplied cascade. This is nominal coverage;
system font discovery and complete script/language/outline/geometry policies remain open.
