# Text model

`TextBuffer` holds immutable UTF-16 text. A position map follows offsets through an edit. The
[workspace](workspace.md) supplies document identity and revision.

## Use

Capture the range and buffer together. Replacing `one` with `first` moves `two` two units right.

```ts
import { TextBuffer, anchoredRange } from "sttropez";

const original = TextBuffer.from("one\r\ntwo");
const secondWord = anchoredRange(original.length, 5, 8);
const change = original.apply([{ from: 0, to: 3, insert: "first" }]);
export const movedWord = change.mapping.mapRange(secondWord); // [7, 10)
export const secondLine = change.buffer.line(1).text;
// secondLine is "two"; original contains "one\r\ntwo".
```

## Contract

### Buffers and coordinates

`TextBuffer.from(text)` preserves all code units, including a BOM and unpaired surrogates. Half-open offsets
may split a [grapheme](unicode.md#graphemes-and-word-movement). Lines start at zero. Each LF starts a line,
even at EOF. An empty buffer has one line. Lone CR is content. In `"one\r\ntwo"`, offsets 3 and 4 both map
to line 0, column 3, which maps back to offset 3.

`length`, `lineCount` and `longestLineLength` are cached. Longest line includes CR and excludes LF.
`lineAt(offset)` counts preceding LFs. `positionAt(offset)` adds the UTF-16 column. `offsetAt(line)` returns
the start. `offsetAt({ line, column })` clamps long columns to content end.

`line(n)` gives `from` and `to` excluding LF or CRLF. Its `.text`, `slice(from, to)` and `text()` copy the
requested text. `chunks(from?, to?)` streams pieces that may split a line, code point or grapheme. Invalid
coordinates throw a `RangeError`. For example, an out-of-bounds slice carries the code
`invalid-utf-16-range`. Use safe integer offsets in `[0, length]`, ordered endpoints, existing lines and
nonnegative columns. Versions share unchanged storage. `equals` can scan all unshared text.

### Edits

`{ from, to, insert }` edits use starting-buffer coordinates. Sort by position, use disjoint ranges and
string insertions. Same-offset insertions follow array order.

`apply(edits)` returns `{ buffer, mapping, changedUnits }`. Equal replacements drop out. A no-op returns the
original buffer, identity map and zero changed units. Otherwise it counts removed plus inserted units.
Invalid batches throw. `replace(from, to, insert)` returns just the buffer. Both are synchronous.

`textDifference(before, after)` trims common string edges and returns one replacement or `null`. Use
[comparison](comparison.md) for review hunks.

### Position maps and anchors

`mapping.map(offset, affinity)` returns `{ offset, deleted }`. At insertion, `"after"` (default) follows the
new text, `"before"` stays. Inside a replacement, affinity selects start or end and `deleted` is true. The
old end maps past the replacement, subject to another edit there.

`anchoredRange(length, from, to)` excludes insertions at either edge. `mapRange` shrinks partly deleted
ranges and keeps endpoints ordered. `onDelete: "invalidate"` yields `undefined` when all original content
disappears or a point position is deleted.

The map from `apply` describes effective edits. `composePositionMaps(...maps)` joins one or more in revision order with matching lengths. `invert()`
maps surviving positions back. Optional `createMapper()` reuses traversal for ordered lookups and restarts
on backward ones.

### Selection sets

`view.setSelections(revision, ranges, primary?)` takes directed `{ anchor, head }` ranges. Read sorted
ranges and primary index from `view.getSnapshot().selectionSet`. Overlaps, duplicate carets and carets
touching a range merge. Adjacent nonempty ranges stay separate. Merging keeps the primary member’s direction
and affinities, otherwise the first supplied member’s.

Carets default to `"after"`. Nonempty ranges exclude edge insertions. The view maps its carets and selections
through every document edit. [Document views](workspace.md#document-views)

### Conservative change spans and diagnostics

Use `bufferDifference(before, after)` from `sttropez/kernels` to find storage shared at both ends.
Replace `[from, to)` with `after.chunks(insertFrom, insertTo)` to reconstruct the newer buffer.
Separately stored equal text can yield a whole-document replacement.

`sharedEdge(other, "start" | "end", range?)` yields cumulative proven lengths, possibly repeated. An empty
range yields nothing. Close abandoned iterators. `diagnostics()` walks a tree and
`TextBuffer.retained(versions)` counts shared storage. Run both outside handlers.

## Host responsibilities

Keep document ID and revision with captured text. Check both and edit permission before applying a result.
Bound batches, schedule cursor advances and release unused versions.
