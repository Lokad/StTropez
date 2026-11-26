# Text model

`TextBuffer` holds an immutable version of a document. Use its position map to follow text
through an edit. The workspace ties each version to a document and revision. [Workspace](workspace.md)

## Use

Capture the range and the buffer together. Replacing `one` with `first` moves `two` two units to the right.

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

`TextBuffer.from(text)` preserves every UTF-16 code unit, including a BOM or an unpaired surrogate.
Offsets count code units. Ranges include `from` and exclude `to`. A raw offset can fall inside a
grapheme. For caret stops, see [Unicode](unicode.md#graphemes-and-word-movement).

Lines start at zero. LF starts a new line, even at EOF. An empty buffer has one line. A lone CR
is content. In `"one\r\ntwo"`, offsets 3 and 4 both give `{ line: 0, column: 3 }`, which maps
back to offset 3. Line 1 starts at offset 5.

| To read | Use |
| --- | --- |
| Length, line count or longest line | `length`, `lineCount`, `longestLineLength` are cached. The longest-line count includes CR and excludes LF. |
| Line and column | `lineAt(offset)` counts preceding LFs. `positionAt(offset)` also returns the UTF-16 column. `offsetAt(line)` returns the line start. `offsetAt({ line, column })` clamps a long column to the content end. |
| Line contents | `line(n)` gives `from` and `to` excluding the LF or CRLF ending. Reading `.text` copies that range. |
| Exact text | `slice(from, to)` copies a range. `text()` copies the document. `chunks(from?, to?)` streams storage pieces which can split a line, code point or grapheme. |

Use safe integer offsets from zero through `length`, ordered endpoints, existing lines and
nonnegative columns. Invalid coordinates throw. Versions share unchanged tree nodes and backing
text. `equals(other)` compares exact contents and can scan all unshared text.

### Edits

Every `{ from, to, insert }` in a batch addresses the original buffer. Sort edits by position, keep
ranges disjoint and supply a string for `insert`. Insertions at the same offset follow array order.
Providers can check a batch with `validateTextEdits(length, edits)` from `sttropez/kernels`.

`buffer.apply(edits)` returns `{ buffer, mapping, changedUnits }`. Equal replacements drop out.
An unchanged result returns the original buffer, an identity map and zero changed units. Otherwise
`changedUnits` sums removals and insertions. Invalid batches throw before publication.
`replace(from, to, insert)` returns just the new buffer. Both operations are synchronous.

`textDifference(before, after)` trims a common prefix and suffix from two strings and returns one
replacement, or `null` for equal text. For review hunks use [comparison](comparison.md).

### Position maps and anchors

`mapping.map(offset, affinity)` returns `{ offset, deleted }`. An insertion at the offset moves
`"after"` positions past the inserted text and leaves `"before"` positions in place. The default
is `"after"`. Inside a replacement, affinity chooses its start or end and `deleted` is true.
The old end maps past the replacement. Affinity governs another edit starting there.

`anchoredRange(length, from, to)` gives the start `"after"` affinity and the end `"before"`,
excluding new text at either edge. `mapping.mapRange(range)` shrinks a partly deleted range.
The default deletion policy keeps the mapped endpoints in order. With `onDelete: "invalidate"`, the result
is `undefined` if all original content disappears or a zero-width anchor's position is deleted.

Use the map from `apply` for effective edits. `new PositionMap(oldLength, edits)` describes the
supplied batch. `composePositionMaps(...maps)` takes one or more maps in revision order with
matching output and input lengths. `invert()` maps back surviving positions. For many ordered
lookups, `createMapper()` reuses its place and restarts on a backward lookup. Custom maps may omit it.

### Selection sets

`view.setSelections(revision, ranges, primary?)` takes one or more directed `{ anchor, head }`
ranges. Read the sorted result and its primary index from `view.getSnapshot().selectionSet`.
Overlaps, duplicate carets and carets on a selected range merge. Adjacent nonempty ranges stay
separate. A merge keeps the primary member's direction and affinities, or the first supplied
member's if the primary lies elsewhere.

Carets default to `"after"` at both ends. Nonempty selections exclude insertions at the outer
edges. `mapSelectionSet(mapping, set)` maps both ends, merges overlaps and returns an immutable set.

Pass `planSelectionEdits` one string for all selections or one per normalized range. It returns
the batch and resulting carets. Submit both in the same transaction for shared Undo.
[Document views](workspace.md#document-views)

```ts
import { planSelectionEdits } from "sttropez/kernels";
import type { SelectionSet, TextBuffer } from "sttropez";

export function replaceSelections(
    buffer: TextBuffer, selections: SelectionSet, replacement: string | readonly string[]
) {
    const plan = planSelectionEdits(buffer.length, selections, replacement);
    const change = buffer.apply(plan.edits);
    return { ...change, selectionSet: plan.selectionSet };
}
```

### Explicit newline conversion

`importText` reports `detected` as `"lf"`, `"crlf"`, `"cr"`, `"mixed"` or `"none"`.
Choose `"preserve"` to keep the source or `"lf"` to normalize all three endings. `exportText`
accepts `"preserve"` or a target ending. Both functions operate on whole strings and return
the offset map. Here the input has mixed endings and the export has three CRLFs.

```ts
import { exportText, importText, TextBuffer } from "sttropez";
import { composePositionMaps } from "sttropez/kernels";

const imported = importText("a\r\nb\rc\n", "lf");
const buffer = TextBuffer.from(imported.text);
const exported = exportText(buffer.text(), "crlf"); // Explicit whole-text export boundary.
export const originalToExported = composePositionMaps(imported.mapping, exported.mapping);
```

### Snippet planning

`parseSnippet` expands numbered stops, literal defaults, mirrors, choices and escapes. A forward
reference shares its field's definition. Positive stops sort by number. `$0` comes last and defaults
to EOF. Conflicting defaults, variables, nested fields and transforms return a rejection `reason`.

In the example, `$1` repeats `value`. Choosing entry 1 of stop 2 produces `call(value, value, ready)`.

```ts
import { TextBuffer } from "sttropez";
import { parseSnippet, planSnippetChoice } from "sttropez/kernels";

const parsed = parseSnippet("call(${1:value}, $1, ${2|draft,ready|})$0", 4096);
if (!parsed.snippet) throw new Error(parsed.reason);
const buffer = TextBuffer.from(parsed.snippet.text);
const active = parsed.snippet.stops.findIndex(stop => stop.index === 2);
const plan = planSnippetChoice(buffer, parsed.snippet.stops, active, 1, 0, 4096);
export const chosen = plan ? buffer.apply(plan.edits).buffer : buffer;
```

`offsetSnippetStops` shifts occurrence ranges to the insertion site. Pass `planSnippetEdit` the
active stop's array index. It returns edits, selections and updated stops for all occurrences.
Each keeps its indentation and newline length. Use `adjustNewlines` for editor-generated newlines.
Paste and composition supply literal text. An unsupported edit returns `undefined`. End the snippet
session and handle ordinary input.

`snippetChoiceText` gives the formatted value at one occurrence. `planSnippetChoice` updates them
all and retains the primary occurrence. Supply an explicit expansion or document limit as a
nonnegative safe integer. The default is `Number.MAX_SAFE_INTEGER`. A missing choice gives no plan.

### Conservative change spans and diagnostics

`BufferChangeCursor` finds a common prefix and suffix by shared storage. To reconstruct `after`,
replace the old range `[from, to)` with `after.chunks(insertFrom, insertTo)`. Equal text held separately
can yield a whole-document replacement.

```ts
import { BufferChangeCursor } from "sttropez/kernels";
import type { BufferChangeSpan, TextBuffer } from "sttropez";

export function* planTransfer(before: TextBuffer, after: TextBuffer): Generator<void, BufferChangeSpan> {
    const cursor = new BufferChangeCursor(before, after);
    try {
        for (;;) {
            const step = cursor.next(256);
            if (step.status === "ready" && step.result) return step.result;
            yield; // The caller schedules the next advance.
        }
    } finally {
        cursor.dispose();
    }
}
```

`snapshot()` reports status, work, result and failure. Read the span at `ready`. A failed advance
records and throws its cause. `dispose()` closes the iterators and releases the result. `next()`
takes a safe integer budget of at least 256, the default. Each unit compares two tree nodes.
Checks every 256 units can overshoot by 255.

`sharedEdge(other, "start" | "end", range?)` yields the cumulative proven length. Counts can
repeat and an empty range yields nothing. Close the iterator if you stop early. `diagnostics()`
walks one tree. `TextBuffer.retained(versions)` counts shared storage across versions. Run these
outside input handlers.

## Host responsibilities

Capture document identity and revision with each buffer. Check both and edit permission before
applying delayed results. Bound batches, schedule cursor advances and release old versions when
Undo, review or pending work has finished with them.

## Not covered

Device input and visual layout have separate limits. [Support matrix](README.md#support-matrix)
