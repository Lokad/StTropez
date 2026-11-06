# Extended grapheme boundaries

The headless core implements the Unicode 18 default extended-grapheme rules in original
TypeScript, with no runtime dependency. Generated, licensed facts pin the result independently
of a browser's Unicode version. Existing normalization and script indexes supply immutable
input and source provenance; the shared cursor driver supplies lifecycle and work budgets.
Native segmentation cannot provide this version contract or yield inside an arbitrarily long
cluster. Adding a third-party implementation would violate the runtime dependency contract.

`createGraphemeCursor(bufferOrString, options)` captures an immutable buffer or string in O(1).
`createNormalizedGraphemeCursor(normalized, options)` requires owned `NormalizedText`. Both
return a cursor with `next(budget)`, `snapshot()` and idempotent `dispose()`. A result remains
null until ready. The default budget is 4096, minimum 256; scanning and boundary publication
yield even inside a million-mark cluster. Operation and cluster limits fail without publishing
a partial index. Disposal releases private work; externally retained completed indexes survive.

Coordinates are absolute UTF-16 offsets for buffer/string sources, and normalized-point offsets
for normalized sources. `index.source.kind` distinguishes them. A normalized point's original
UTF-16 spans remain at `index.source.text.at(point).sources`. Raw unpaired surrogates remain
unchanged. Explicit `from`/`to` subranges are interpreted with independent context: callers must
choose a safe restart boundary when they need the interpretation of a larger text.

The frozen `GraphemeIndex` retains its source, range, Unicode version, `clusterCount` and
`boundaryCount`. Boundaries use frozen blocks of 256. `boundaryAt` and `clusterAt` query indexed
records; `floor`/`ceil` include an exact boundary, `preceding`/`following` are strict and return
null beyond either end. `clusterIndexAt` requires an offset inside the range. `boundaries()`
explicitly materializes an array. An empty range has one anchor boundary and zero clusters.
`graphemeBoundaries(string)` synchronously drains the same kernel for bounded row geometry.

The rules cover CRLF/control separation, Hangul, Extend/ZWJ/SpacingMark/Prepend, contextual
emoji ZWJ sequences, regional-indicator parity and Indic conjuncts. Unicode 18 GB9c uses a
Linker followed by zero or more InCB Extend characters before a Consonant; it does not require
a preceding consonant. This version change is observable in older native segmenters.

Script itemization preserves these complete graphemes by default and can reuse an owned index
for the exact normalized identity and range. Its explicit `clusterMode: "combining"` retains
the earlier base/mark/join/selector policy. Script interpretation is still a separate policy;
grapheme boundaries do not establish orthographic syllables, shaping clusters or glyph carets.

The editing candidate cooperatively scans the entire captured logical line, including its LF
ending, and caches one index by immutable buffer identity and exact range. LF is a safe restart
boundary; backward movement at a line start scans the preceding line. It never estimates RI
parity or truncates a cluster at a fixed context window. Collapsed deletion inside a cluster
expands to both boundaries. Nonempty selections retain their exact requested extent. Word
destinations use the same grapheme indexes. Captured revision, selection identity, tab generation,
composition, disposal and editing permission guard delayed work. Input edits and view changes
cancel pending commands. Complete-row visual movement still uses measured geometry.

Verification covers all 1,114,112 code points for three properties, all 853 official test rows
(2,400 boundary markers) for strings, ropes and normalized points, and NFD source extents for
all 1,547 source clusters. Browser tests repeat the corpus in three engines and retain every
native difference separately (10 cases in Chromium/Firefox and 18 in WebKit). Long editing/deletion, exact undo, RI parity, CRLF, cache reuse
and stale commands exercise the actual candidate. The benchmark retains three warmups and
twenty trials for nine conditions, including cancellation and a million-mark cluster.

The generator accepts reviewed local Unicode data, verifies the version and existing Unicode
License V3 notice, and writes compact facts and compressed test fixtures. Allocation, array
growth, freezing and GC remain atomic; work quanta are not time deadlines or qualified memory
budgets. [Font-aware canonical selection](font-normalization.md) reuses these boundaries.
Language tailoring, system fallback, complete shaping, renderer
origins, native-device IME/accessibility and certified source/ink/caret geometry remain open.
