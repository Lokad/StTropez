# Text model

StTropez represents text as immutable UTF-16 buffers. Range edits produce a new buffer and a
position map; selections, anchors and snippet plans use those coordinates. These headless
primitives do not own document revisions, persistence or view lifetime. Use the
[workspace](resources.md) to apply them to a live document.

## Use

Read bounded ranges from a captured buffer and apply edits in its original coordinates:

```ts
import { TextBuffer, anchoredRange } from "sttropez";

const original = TextBuffer.from("one\r\ntwo");
const secondWord = anchoredRange(original.length, 5, 8);
const change = original.apply([{ from: 0, to: 3, insert: "first" }]);
export const movedWord = change.mapping.mapRange(secondWord); // [7, 10)
export const secondLine = change.buffer.slice(change.buffer.offsetAt(1), change.buffer.length);
// secondLine is "two"; original contains "one\r\ntwo".
```

Keep the returned buffer and mapping together with the transaction's captured document identity
and revision. Equal lengths or equal text do not establish that a delayed operation is current.

## Contract

### Buffers and coordinates

`TextBuffer.from(text)` preserves exact JavaScript string contents, including BOM, CRLF,
unpaired surrogates and combining sequences. Offsets and half-open ranges count UTF-16 code
units. Storage permits boundaries inside surrogate pairs and grapheme clusters; user-facing
navigation applies the [Unicode boundary rules](graphemes.md).

| Member | Contract |
| --- | --- |
| `length`, `lineCount`, `longestLineLength` | Constant-work metadata; longest line counts raw units excluding LF, including any preceding CR |
| `lineAt(offset)` | Zero-based line containing the position; counts LF characters before the offset |
| `offsetAt(line)` | Start offset of an existing zero-based line |
| `slice(from, to)` | Materializes the requested range |
| `chunks(from?, to?)` | Iterates the requested range; defaults to the whole buffer; chunk boundaries are storage boundaries |
| `text()` | Explicitly materializes the whole buffer |
| `replace(from, to, insert)` | Returns the buffer from a single-edit application |
| `equals(other)` | Exact content equality, skipping shared backing ranges where possible |
| `sharedEdge(other, side, range?)` | Iterates cumulative prefix/suffix lengths proved by immutable storage identity |

An empty document has one line; a trailing LF adds an empty last line. A lone CR is ordinary
text for line indexing. Range endpoints must be safe integers between zero and `length`, in
ascending order. Line indexes must be safe integers below `lineCount`; invalid reads throw.
Line lookup traverses cached tree and backing metadata. Reading or comparing unshared text can
require work proportional to the requested content. Chunks are not guaranteed to end at a
line, code point or grapheme boundary.

The buffer uses a persistent AVL piece tree to share unchanged text across versions. Cached
lengths and LF indexes support local range and line lookup. Single edits split/join the tree;
sorted batches traverse source ranges together and retain untouched subtrees. Small pieces
can be packed into shared backings to limit fragmentation. This balances local edits, range
reads and retained versions without making document-wide reads or comparisons constant work.

### Edits

`TextEdit` is `{ from, to, insert }`, with both offsets in the original buffer. A batch must be
sorted, non-overlapping and in bounds; `insert` must be a string. Same-position insertions retain
array order. `validateTextEdits(length, edits)` validates the complete batch before application.
`applyTextEdits(text, edits)` supplies the corresponding whole-string operation.

`buffer.apply(edits)` returns immutable `BufferChange` with `{ buffer, mapping, changedUnits }`.
Equal-content replacements are filtered before mapping. A net no-op returns the original buffer,
an identity map and zero changed units. Otherwise, `changedUnits` sums deleted and inserted units
of effective edits; it is neither allocation size nor elapsed time. Invalid batches throw without
changing any retained buffer. Construction and final application are synchronous.

`textDifference(before, after)` returns one replacement after trimming exact common UTF-16
prefix/suffix text, or `null` when equal. It accepts whole strings and does not compute separate
changes for distant edits. Use [comparison](comparison.md) for line-oriented review hunks.

### Position maps and anchors

`PositionMap(oldLength, edits)` describes one validated edit batch. `PositionMapping` exposes
`oldLength`, `newLength`, `map`, `mapRange` and `invert`; `MappedPosition` contains an `offset`
and a `deleted` flag. Prefer the map returned by buffer application when equal-content edits
can be filtered out.

`Affinity` is `"before"` or `"after"`. At an insertion or inside a replacement it selects the
corresponding edge of inserted text; `map` defaults to `"after"`. Positions strictly inside
consumed text are marked deleted; boundary positions stay defined. At a replacement's original
end, its inserted text has been crossed, and affinity applies to any following change at that
boundary. Co-located insertions are crossed together.

`anchoredRange(length, from, to, options?)` creates an immutable `AnchoredRange`. Its default
start affinity is `"after"`, end affinity `"before"`, and deletion policy `"collapse"`, excluding
new text inserted at the outside edges. `mapRange` shrinks partially deleted ranges. With
`onDelete: "invalidate"`, fully consumed original content returns `undefined`; a zero-width
anchor is invalidated when its position is deleted. Otherwise the mapped range stays ordered.

`composePositionMaps(...maps)` preserves sequential mapping and invalidation semantics, requiring
at least one map and matching adjacent dimensions. Inversion describes reverse geometry; it
cannot recover distinct interior positions erased by an edit. Built-in maps index batch changes
and summarize composition; independent changes can increase that metadata. Custom mappings
retain their ordered composition when their semantics cannot be inferred.

The optional `createMapper()` returns an independent lookup cursor. Ascending endpoints reuse
progress; backward queries are valid and restart the search. The immutable map stores no cursor
state. The optional `isSingleInsertion(offset, units)` checks exact insertion geometry; custom
mappings need not provide either optimization.

### Selection sets

`Selection` contains `anchor`, `head` and optional endpoint affinities. `SelectionSet` contains
immutable `ranges` and a `primary` index. `createSelectionSet(length, ranges, primary?)` requires
at least one range, validates endpoints, sorts by source range and merges overlaps, duplicate
carets and carets on occupied ranges. Adjacent nonempty ranges stay distinct. A merged range
keeps the primary member's direction/affinities, or the first supplied member's otherwise.

Default affinities exclude insertion at a nonempty selection's outer edges; a collapsed caret
defaults to `"after"` at both endpoints. `mapSelectionSet(mapping, set)` maps every endpoint,
then normalizes any new overlaps. The primary index refers to the normalized array and is not
a durable view or resource identity.

`planSelectionEdits(length, normalizedSet, textOrTexts)` returns a `SelectionEditPlan`: one
original-coordinate replacement per range and the resulting collapsed caret set. Per-range
strings follow normalized range order. Planning changes no buffer or workspace state:

```ts
import { planSelectionEdits } from "sttropez";
import type { SelectionSet, TextBuffer } from "sttropez";

export function replaceSelections(
    buffer: TextBuffer, selections: SelectionSet, replacement: string | readonly string[]
) {
    const plan = planSelectionEdits(buffer.length, selections, replacement);
    const change = buffer.apply(plan.edits);
    return { ...change, selectionSet: plan.selectionSet };
}
```

For a live document, submit the edits and resulting selections through one captured workspace
transaction. [View history](history.md#multiple-selection-model) defines undo and other-view mapping.

### Explicit newline conversion

`importText(text, policy)` requires `"preserve"` or `"lf"`. Its `ImportedText` result contains
`text`, detected endings (`"lf"`, `"crlf"`, `"cr"`, `"mixed"` or `"none"`) and a conversion map.
`exportText(text, ending)` accepts a `LineEnding` (`"lf"`, `"crlf"`, `"cr"`) or `"preserve"` and
returns text with its map. Conversion recognizes CRLF as one ending and preserves all other
units. It scans whole strings; buffer creation never implicitly converts line endings.

```ts
import { composePositionMaps, exportText, importText, TextBuffer } from "sttropez";

const imported = importText("a\r\nb\rc\n", "lf");
const buffer = TextBuffer.from(imported.text);
const exported = exportText(buffer.text(), "crlf"); // Explicit whole-text export boundary.
export const originalToExported = composePositionMaps(imported.mapping, exported.mapping);
```

### Snippet planning

`parseSnippet(source, maxExpandedUnits?)` returns `SnippetParseResult`: either a `snippet` or
a rejection `reason`. It supports numbered stops (`$1`, `${1}`), literal defaults
(`${1:value}`), choices (`${2|draft,ready|}`), escapes, repeated occurrences and final `$0`.
A missing `$0` is placed at the expansion end. Forward references share their definition;
conflicting explicit definitions are rejected. Variables, nested placeholders and transforms
return a reason. Invalid argument types or limits throw.

`Snippet` has expanded `text` and ordered `stops`. Each `SnippetStop` has its source stop number,
choices and `SnippetOccurrence` ranges; positive stop numbers ascend and zero comes last.
`offsetSnippetStops(stops, offset)` translates those ranges to insertion coordinates. Callers
provide a valid offset and retain the matching buffer and revision.

`planSnippetEdit` mirrors compatible edits through occurrences of the active stop and returns
`SnippetEditPlan` with edits, selections and updated stops. `active` indexes the stop array.
An incompatible selection/edit batch returns `undefined`, allowing the editor to end snippet
mode and apply ordinary input. Per-occurrence insertion contexts preserve different indentation
and newline lengths; paste/composition text stays literal. `adjustNewlines` opts into contextual
editor-generated newline transfer.

`planSnippetChoice` formats the chosen value at every occurrence, preserves the requested primary
occurrence and checks the aggregate document limit. `snippetChoiceText` computes one occurrence's
display value, including its captured indentation. Invalid/unavailable choices return no plan
or value; exceeded limits throw. Hosts apply the complete plan atomically:

```ts
import { parseSnippet, planSnippetChoice, TextBuffer } from "sttropez";

const parsed = parseSnippet("call(${1:value}, $1, ${2|draft,ready|})$0", 4096);
if (!parsed.snippet) throw new Error(parsed.reason);
const buffer = TextBuffer.from(parsed.snippet.text);
const active = parsed.snippet.stops.findIndex(stop => stop.index === 2);
const plan = planSnippetChoice(buffer, parsed.snippet.stops, active, 1, 0, 4096);
export const chosen = plan ? buffer.apply(plan.edits).buffer : buffer;
```

### Conservative change spans and diagnostics

`BufferChangeCursor(before, after)` finds one `BufferChangeSpan` with `{ from, to, insertFrom,
insertTo }`: replace the old interval with the new buffer's insertion interval. It proves shared
edges by storage identity without reading text. Unproved text stays inside the span, so equal
independent buffers or distant edits can require a wide replacement. This is not a minimal diff.
Stream the insertion through `after.chunks(insertFrom, insertTo)` with host-defined chunk limits.

```ts
import { BufferChangeCursor } from "sttropez";
import type { BufferChangeSpan, TextBuffer } from "sttropez";

export function* planTransfer(before: TextBuffer, after: TextBuffer): Generator<void, BufferChangeSpan> {
    const cursor = new BufferChangeCursor(before, after);
    try {
        for (;;) {
            const step = cursor.next(64);
            if (step.done && step.result) return step.result;
            yield; // The caller schedules the next advance.
        }
    } finally {
        cursor.dispose();
    }
}
```

`sharedEdge` accepts `"start"` or `"end"` and optional `{ from, to, otherFrom, otherTo }` ranges.
Equal text without shared storage need not yield a proof. Close an interrupted iterator and
dispose an abandoned change cursor to release captured buffers. These proofs do not authorize
updates to a live resource.

`readMetrics()` returns immutable `BufferReadMetrics` counters for explicit text exports and
requested slice units. It does not count callers reading every chunk or measure all text work.
`diagnostics()` and `TextBuffer.retained(versions)` traverse retained structure; `BufferRetention`
counts shared nodes, backings and indexed units across versions. Logical units are not heap bytes.
Keep those traversals outside input handlers and routine readiness polls.

| Limit | Contract |
| --- | --- |
| Buffer size and edits | Host supplies document/transaction limits; strings and allocations obey engine limits |
| Change-cursor `next(budget)` | Safe integer from 1 to 1,024; default 64 generator advances; `next` after disposal throws |
| Snippet expansion/choice limits | Nonnegative safe integers; defaults to `Number.MAX_SAFE_INTEGER`; hosts should pass explicit bounds |
| Shared-edge iteration | Advances traverse tree paths; no fixed text chunk size or elapsed-time guarantee |
| Retained versions | Old buffers retain shared backing text until every owning reference is released |

## Host responsibilities

Choose document, batch and snippet limits; schedule cooperative cursors; retain only needed
versions. Bind asynchronous work to captured resource identity, revision, authority and lifetime.
Choose newline policy at import/export boundaries. Use bounded reads for rendering and service
requests, and explicit whole-text exports for services that require them. Apply selection and
snippet plans with their text changes in the same workspace transaction.

## Not covered

See the [support matrix](README.md#support-matrix) for editor, language-service and device scope.
