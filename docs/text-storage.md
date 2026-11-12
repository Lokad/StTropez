# Text storage and position contracts

Reviewed 2026-11-05. `TextBuffer` is the selected immutable piece tree. Flat strings and a
chunked tree remain development probes under `experiments/`; neither is an alternate runtime
store. Workspace documents now use this buffer with lazy exports, bounded shared history and
mapped per-view selections. See [document transactions and history](history.md) for integration.

## Storage decision

The repository had range-string edits but no indexed, persistent text store. Public research
on text sequences informed the comparison; no upstream implementation was imported or copied.
A small original TypeScript implementation keeps the zero-dependency runtime boundary while
allowing the actual algorithms to be measured and checked against a simple string oracle.

The three candidates preserve arbitrary UTF-16 and immutable snapshots. The flat probe uses
strings with a lazy LF index; the chunk probe uses an immutable balanced tree with string
chunks bounded at 2,048 code units. The selected piece tree indexes immutable original/insert
backings and splits descriptors without copying their text. Its AVL branches cache length,
LF count and height. Edits copy affected paths; unchanged nodes and backings are shared.

Backing LF offsets and longest-line gap indexes use owned `Float64Array` storage, following
other immutable numeric indexes. They never escape the private tree and are never changed after
construction; public buffers and descriptors remain frozen. Float64 preserves the numeric
range of the previous arrays. This avoids a measured bulk-review stall caused by freezing
hundreds of thousands of numeric properties in one browser engine. No runtime dependency or
public storage contract is added. Full-hunk reversion tests retain exact source, bounded
history, later typing and immutable reference checks; kernel timings remain separate from
complete interaction readiness and automation timings.

The selection campaign ran on Linux x64, four AMD EPYC 9V45 virtual CPUs, 15.6 GiB RAM and
official Node 24.17.0. Current preflight and postflight samples reported 100% idle, excluding
vmstat's since-boot average. The postflight load average includes the campaign itself.
There were five rounds with rotating candidate order, six pinned corpora and five actions
(start/middle/end insertion, seeded random replacement and alternating paste/delete).
Each of the 450 cases used a fresh process, ten warmup edits and ninety measured edits.
Every case checked line/offset lookups, local text and a final UTF-16 checksum against the
oracle. The piece adapter called the selected `TextBuffer`, including transaction map
allocation; the other two candidates are development implementations.

The following are medians of five round p95 values for random edits, in milliseconds.
They are not pooled percentiles. The combined boundary includes edit, first line/offset
lookup after the edit, retaining a snapshot reference and reading a small local slice.

| Corpus | Flat combined | Chunk combined | Piece combined | Piece edit | Piece lookup |
| --- | ---: | ---: | ---: | ---: | ---: |
| Normal source | 0.0031 | 0.0135 | 0.0202 | 0.0122 | 0.0021 |
| 100 lines | 0.0085 | 0.0151 | 0.0191 | 0.0143 | 0.0014 |
| 10,000 lines | 0.3847 | 0.0201 | 0.0230 | 0.0170 | 0.0021 |
| 100,000 lines | 4.8345 | 0.0166 | 0.0181 | 0.0138 | 0.0010 |
| 2.4 million units, one line | 1.7708 | 0.0153 | 0.0205 | 0.0123 | 0.0021 |
| Unicode source | 0.0170 | 0.0148 | 0.0171 | 0.0120 | 0.0010 |

Snapshot retention is a reference push for all candidates; its observed p95 medians were
below 0.001 ms, where timer and loop overhead matter. Flat edit-only numbers benefit from
deferred string work. The first lookup after each edit exposes flattening/index rebuilding;
warm lookups alone would conceal that cost.

Additional GC heap with 101 version references, relative to the pre-construction baseline,
was as follows (median MiB). The initial corpus and oracle plan were already present at that
baseline. These values are incremental process measurements, not total document byte sizes.

| Corpus | Flat | Chunk | Piece |
| --- | ---: | ---: | ---: |
| 10,000 lines | 53.32 | 0.55 | 0.35 |
| 100,000 lines | 543.72 | 2.15 | 1.14 |
| Huge single line | 400.59 | 0.76 | 0.24 |

For the 100,000-line replay, the piece tree retained 1,326 distinct nodes and 2,400,126
backing code units across the 101 references. Chunks retained 4,525 nodes and 2,600,451
backing units. These logical counts are reproducible; engine object sizes and hidden shared
string allocations are not inferred from them. After dropping history, the flat heap delta
fell to 5.84 MiB. Small tree heap samples sometimes increased after that drop because code,
allocator and GC effects exceed the small released structures; they are not exact retained
byte accounting.

The piece tree trades a little local-operation overhead for lower retained structures and
backing text. On the huge single line its construction plus first lookup median was 0.24 ms,
against 0.93 ms for chunks. On 100,000 lines the corresponding medians were 2.14 and 2.27 ms.
Flat strings are faster for small documents; chunks are often faster for the measured local
operations. The choice favors large-document history and indexing without maintaining several
runtime stores. It does not claim the piece tree is universally fastest.

Whole-text export remains linear. On 100,000 lines, export plus UTF-16 checksum medians were
3.14 ms flat, 4.45 ms chunk and 4.39 ms piece. This boundary includes checksum encoding/work;
it is not pure export time. None of these results measure a renderer, input latency, bounded
undo retention, provider traffic or long-session compaction.

The archived selection source SHA-256 is
`18f3530bf4c5ee5b3fc64e9fa96d2adf5fb1f00b748145b9b788cf6f45fbca53`.
Its source archive, per-file manifest, raw samples and load checks are in ignored
`artifacts/bench/storage/selected-vm/`. Subsequent validation, net no-op filtering, changed-unit
counts and workspace/history integration are outside that frozen campaign; it is algorithm
selection evidence, not a final-source gate.
The earlier prototype campaign is retained separately in `reference-vm/`.

Reproduce locally with `npm run bench:storage`; the default is five rounds. Run
`node scripts/summarize-storage.mjs <report.json>` to obtain the table's aggregation.
`STTROPEZ_SOURCE_MANIFEST` optionally points to a per-file source manifest; all listed hashes
are verified before its identity is accepted. Keep machine-specific access details outside
project files. Do not overlap timing with builds, installations or another campaign.

## Buffer reads and transactions

`TextBuffer.from(text)` preserves exact UTF-16. `length` and `lineCount` are constant-time;
`lineAt(offset)` counts LF characters before a position and `offsetAt(line)` returns a
zero-based line start. Both traverse cached tree metadata and the backing's LF index.
An empty document has one line; a trailing LF creates an empty last line. Raw CRLF is two
code units, with the LF determining the next line. A lone CR remains an ordinary code unit
unless the caller explicitly converts newlines.

`slice(from, to)` and `chunks(from, to)` read a requested range. `text()` explicitly exports
the whole document. Routine consumers should keep the buffer reference and read bounded
ranges. Diagnostics count explicit `text()` calls and requested slice units; these counters
do not account for callers iterating every chunk or asking for a whole-document slice.
`readMetrics()` returns a frozen counter snapshot in constant work, without traversing retained
structure. Full `diagnostics()` includes retention validation/counting and belongs outside a
hot input path or readiness poll. Keeping these separate avoids instrumentation amplification
after a transaction creates many pieces.

`apply(edits)` validates a sorted, non-overlapping batch in original UTF-16 coordinates,
then returns a frozen `{ buffer, mapping, changedUnits }`. Equal-content replacements are removed
before mapping; a combined result equal to the original also preserves buffer identity with an
identity map and zero changed units. Insertions at the same offset
retain array order. An invalid batch returns no result and cannot mutate the old buffer.
The [bulk path](bulk-edits.md) streams sorted edits over retained source subtrees, shares bounded
insertion backings and packs dense small fragments. Mapping records remain separate from packed
storage boundaries. Large unchanged ranges retain their backing/subtrees. Iterative traversal
avoids nested generator delegation; singleton edits retain their split/join implementation.
`equals` compares exact content, skipping shared backing ranges; unrelated buffers may need
a linear comparison. There is no probabilistic content hash or implicit text export.

`sharedEdge(other, side, range?)` iterates cumulative equal edge lengths proved by immutable
node or backing identity, for `"start"` or `"end"`. Optional `{ from, to, otherFrom, otherTo }`
captures raw UTF-16 ranges. It reads no text, exposes no backing objects and stops at the first
unproved span. Equal text in independent storage may therefore yield no proof. Each advance
walks bounded tree paths and the caller can stop iteration to release its captures. The
comparison kernel uses these proofs inside its cooperative budget, with exact bounded reads
where a textual equality decision is needed. Ownership proofs do not replace document revision,
resource identity or lifecycle checks.

## Affinity, anchors and newlines

`PositionMap` maps one batch's old coordinate space to its new space. A position's `before`
or `after` affinity chooses the corresponding edge of inserted/replacement text. At an
original replacement end, preceding replacement text has already been crossed; affinity
then applies to any following change at that boundary. Multiple co-located insertions are
crossed together. Positions strictly inside a consumed range have `deleted: true`; boundary
positions remain defined. Inversion maps the reverse geometry but cannot restore a distinct
interior position lost by a replacement. Composition follows each map in sequence and rejects
incompatible lengths. A map's dimensions do not establish document identity or revision;
the transaction owner must still check both before using delayed work.

`anchoredRange` defaults to excluding new insertions at its boundaries (`after` at the start,
`before` at the end). The deletion policy either collapses the range or invalidates it when
its original content is fully consumed. Partially deleted ranges shrink. This is a geometry
primitive; view selection direction, scroll, undo ownership and asynchronous anchors still
need document-level lifecycle integration.

`importText(text, "preserve" | "lf")` requires an explicit policy and reports detected
LF/CRLF/CR/mixed/no line endings. `exportText(text, ending)` likewise requires an explicit
preservation or conversion choice. Both return position maps for conversions. Surrogates,
combining sequences and ZWJ text are preserved verbatim. Storage accepts positions within
surrogate pairs and grapheme clusters; user navigation must later impose grapheme-aware
boundaries. The native view maps its LF coordinates back to raw model ranges, preserving
untouched CRLF; the host still chooses explicit import/export conversion.

Randomized tests compare all candidates and the selected buffer with a flat string oracle,
including retained roots, multi-range batches, AVL balance, empty/trailing lines, CRLF,
unpaired surrogates, combining text and ZWJ sequences. These tests establish storage and
mapping invariants. Workspace/browser history scenarios additionally cover stale transaction
rejection, saved-content undo, linked edits and independent retained view mapping.
