# Bulk text construction and traversal

The same persistent AVL piece tree handles single and multi-range edits. Single-range edits
keep the split/join path. Multi-range edits validate/filter original-coordinate ranges, build
the unchanged `PositionMap`, and consume the source once in ascending order. Whole untouched
subtrees remain shared; partial leaves contribute only their requested ranges. A forest ordered
by height assembles balanced output using the existing join/metadata operations. Same-position
insertions retain array order, and a net no-op returns the original buffer and identity mapping.

Small insertions share backing runs up to 65,536 UTF-16 units; each larger insertion gets its
own backing. The output packs consecutive fragments of at most 64 units into runs capped at
65,536 units. A singleton reuses its leaf/backing instead of copying. Larger ranges and complete
subtrees retain their structure. Small fragments that will be packed do not allocate temporary
leaves or query LF indexes. This reduces dense-edit fragmentation while keeping sparse edits
from copying large unchanged regions. Source text can contain CRLF, unpaired surrogates and
graphemes crossing storage boundaries; storage performs no normalization or shaping.

Packing may copy unchanged units inside a dense edited region and add LF/gap indexes for them.
`changedUnits` still counts semantic deletion/insertion, while `BufferRetention.backingTextUnits`
counts the full retained storage. The two are different measures. Logical counts are not heap
bytes. Retained versions share untouched subtrees and preserve their exact original text;
document-level undo/redo continues to retain roots and independent view selections.

Chunk/range reads and equality walk an explicit stack rather than delegating recursively through
each tree level. Range reads seek to the first leaf and stop at the requested endpoint. A flat
leaf retains its direct substring path. Traversal stack space scales with height, and iteration
visits only the intersecting nodes. Explicit iterator closure releases pending traversal state.

This extends the project's own tree, backing indexes, maps and history. No third-party rope,
worker or compiler is added. The implementation addresses measured batch allocation/traversal
costs while preserving the zero-runtime-dependency boundary.

Tests exercise dense and sparse batches, retained subtree sharing, duplicate insertion order,
empty roots, large insertion/packing boundaries, exact UTF-16/CRLF mapping and line metadata,
net no-ops and shared undo/redo back to saved roots. Seeded differential research also compares
the frozen prior implementation with the current path; that local research stays ignored.

`bench:bulk` starts a fresh Node process per workload and round, with three warmups and ten
measured batches. Five default rounds cover dense 100/10k/100k-line changes, sparse huge-line
changes, a point edit over a fragmented buffer, Unicode, large insertions and repeated
same-position inserts. Construction, traversal
and scanner CPU have separate samples. Full chunk/string, mapping and metadata validation,
explicit GC and structural-retention checks stay outside timed intervals. Runtime selection
is asserted. Browser global replacement remains covered by `bench:services`; the final atomic
transaction is synchronous, so these measurements do not certify input/presentation latency.
