# Native font registration

`createFontAssetController(ownerDocument, fontId)` owns one native `FontFace`. The host supplies
font bytes and decides which editor views use the returned CSS family. Browser APIs decode,
shape and measure the font; the editor has no custom font parser, glyph pipeline or font cascade.

`request(expectedGeneration, bytes)` copies the bytes and returns a generation and settlement
promise, or null if the expected generation is stale. A successful load registers the new face
before replacing the previous owned face. `current` contains only `fontId`, `generation` and
`family`. Invalid binary font data settles as failed through native decoding; the previous
registered face remains current. The snapshot exposes the failure message.

Superseded, cancelled or disposed loads cannot register late faces. `cancel()` preserves an
already registered face. `dispose()` removes the owned face and clears the current snapshot;
foreign faces remain registered. Both operations are explicit host lifecycle decisions.
`isCurrent(generation)` checks the registered face, including after a later load fails.
Hosts should retain a family only while its generation remains current.

The stable observable handles expose immutable snapshots. Requests require a matching expected
generation and disposal is idempotent. Native loading uses `crypto.getRandomValues`, including
on insecure origins; it does not depend on `crypto.randomUUID`.

The earlier research exports (`SfntFont`, advance/glyph indexes, GSUB/GPOS plans and cursors,
normalization/cascade, script itemization and Unicode shaping tables) have been removed from the
core entry. `FontAssetVersion.data`, `createNormalizedGraphemeCursor` and normalized-point
`GraphemeSource` are also removed. String/buffer grapheme segmentation, bidi and the native
font controller remain supported. Consumers using the removed research surface must migrate
to browser layout and keep any independent font processing outside this package.

Browser tests cover copied bytes, generation supersession, failed decoding, foreign-face
preservation, cancellation and disposal. The restored-package check verifies registration,
measurement and release without consumer compilation of editor sources.
