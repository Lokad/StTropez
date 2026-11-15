# Extended grapheme boundaries

The headless core implements the Unicode 18 default extended-grapheme rules in original
TypeScript, with no runtime dependency. Generated, licensed facts pin the result independently
of a browser's Unicode version.

`createGraphemeCursor(bufferOrString, options)` captures an immutable buffer or string in O(1).
It returns a cursor with `next(budget)`, `snapshot()` and idempotent `dispose()`. A result remains
null until ready. The default budget is 4096, minimum 256; scanning and boundary publication
yield even inside a million-mark cluster. Operation and cluster limits fail without publishing
a partial index. Disposal releases private work; externally retained completed indexes survive.

Coordinates are absolute UTF-16 offsets for buffer/string sources. Raw unpaired surrogates remain
unchanged. Explicit `from`/`to` subranges are interpreted with independent context: callers must
choose a safe restart boundary when they need the interpretation of a larger text.

The frozen `GraphemeIndex` retains its source, range, Unicode version, `clusterCount` and
`boundaryCount`. Boundaries use frozen blocks of 256. `boundaryAt` and `clusterAt` query indexed
records; `floor`/`ceil` include an exact boundary, `preceding`/`following` are strict and return
null beyond either end. `clusterIndexAt` requires an offset inside the range. `boundaries()`
explicitly materializes an array. An empty range has one anchor boundary and zero clusters.
`graphemeBoundaries(string)` synchronously drains the same kernel for bounded row geometry.
ASCII properties use direct classification; other code points retain the reviewed table lookup.
Boundary publication uses the cursor's existing suspension points without allocating a nested
generator for each boundary. Work counters, limits and frozen blocks retain their contracts.

The rules cover CRLF/control separation, Hangul, Extend/ZWJ/SpacingMark/Prepend, contextual
emoji ZWJ sequences, regional-indicator parity and Indic conjuncts. Unicode 18 GB9c uses a
Linker followed by zero or more InCB Extend characters before a Consonant; it does not require
a preceding consonant. This version change is observable in older native segmenters.

The editing candidate first checks at most four UTF-16 units around the requested offset.
When this neighborhood contains only ASCII, CR followed by LF is its only joining pair.
The two units on each side prove the containing cluster and strict immediate neighbors,
including document edges and positions inside a CRLF pair. This answers one point; it creates
no clipped-context index and does not cache artificial slice boundaries. Any non-ASCII
neighbor declines the query and retains full-context segmentation.
This deliberately small dependency-free query addresses the measured multi-second pilot
delay for local commands inside a 2.4-million-unit identifier. It reuses the existing full
segmentation kernel for uncertain context, without adding a segmentation library or changing
grapheme definitions. Full-context and native-oracle comparisons cover accepted points beside
Prepend, marks, Indic, emoji/RI, surrogate seams and controls.

For uncertain context the candidate cooperatively scans the entire captured logical line, including its LF
ending, and caches one index by immutable buffer identity and exact range. LF is a safe restart
boundary; backward movement at a line start scans the preceding line. It never estimates RI
parity or truncates a cluster at a fixed context window. Collapsed deletion inside a cluster
expands to both boundaries. Nonempty selections retain their exact requested extent. Word
destinations use the same point query or grapheme indexes. Captured revision, selection identity, tab generation,
composition, disposal and editing permission guard delayed work. Input edits and view changes
cancel pending commands. Complete-row visual movement still uses measured geometry.

Verification covers all 1,114,112 code points for three properties, all 853 official test rows
(2,400 boundary markers) for strings and ropes. Browser tests repeat the corpus in three engines and retain every
native difference separately (10 cases in Chromium/Firefox and 18 in WebKit). Long editing/deletion, exact undo, RI parity, CRLF, cache reuse
and stale commands exercise the actual candidate. The benchmark retains three warmups and
twenty trials for eight conditions, including cancellation and a million-mark cluster.

The generator accepts reviewed local Unicode data, verifies the version and existing Unicode
License V3 notice, and writes compact facts and compressed test fixtures. Allocation, array
growth, freezing and GC remain atomic; work quanta are not time deadlines or qualified memory
budgets.
Language tailoring, system fallback, complete shaping, renderer
origins, native-device IME and certified source/ink/caret geometry remain open.
