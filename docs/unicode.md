# Unicode

The editor moves by graphemes and stores UTF-16 offsets. A letter plus a combining accent takes
one caret step. Browsers use their own `Intl.Segmenter`, so rare sequences can have different
boundaries across engines.

## Use

Index a captured buffer in steps. Cancel the work if its result would belong to an old selection
or revision.

```ts
import { createGraphemeCursor } from "sttropez/kernels";
import type { TextBuffer } from "sttropez";
import type { GraphemeIndex } from "sttropez/kernels";

export async function indexGraphemes(
    buffer: TextBuffer,
    signal: AbortSignal,
    yieldToHost: () => Promise<void>
): Promise<GraphemeIndex> {
    const cursor = createGraphemeCursor(buffer);
    try {
        for (;;) {
            signal.throwIfAborted();
            const step = cursor.next(4096);
            if (step.status === "ready" && step.result) return step.result;
            if (step.status !== "running") throw new Error(step.failure ?? "Index unavailable.");
            await yieldToHost();
        }
    } finally {
        cursor.dispose();
    }
}
```

To label a tooltip, enable `characterWarnings` and query the affected range.

```ts
import { characterWarningLabel } from "sttropez";
import type { TextEditor } from "sttropez/browser";

export function warningLabels(editor: TextEditor, from: number, to: number) {
    const batch = editor.characterWarnings.query(from, to);
    return batch?.warnings.map(characterWarningLabel) ?? [];
}
```

## Contract

### Cooperative cursor lifetime

`next(budget)` advances the cursor. `snapshot()` reads its progress. Read the result at `ready`,
including offset zero or an empty index. A failed advance records and throws its cause. Invalid
budgets leave progress intact. Call `dispose()` when finished. A result you hold survives disposal.
Advancing or disposing a cursor during its own advance throws.

### Graphemes and word movement

`createGraphemeCursor(source, { from, to })` reads the range on first advance and segments it as
one string. Its immutable index uses absolute offsets and preserves unpaired surrogates. Choose
range boundaries with context. Starting midway through a run of regional indicators can pair
different characters into flags.

| To find | Use |
| --- | --- |
| A numbered boundary or cluster | `boundaryAt`, `clusterAt`. An empty range has one boundary and zero clusters. |
| A boundary near an offset | `floor` and `ceil` include an exact match. `preceding` and `following` exclude it and return `null` past the range. |
| The cluster containing a unit | `clusterIndexAt` for offsets below `to`. `isBoundary` also accepts `to`. |
| A boundary array | `index.boundaries()` materializes the requested interval. `graphemeBoundaries(text)` builds the whole array synchronously. |

At a collapsed caret, deletion handles a whole cluster, including a CRLF. A nonempty selection
keeps its exact extent. The editor can index a complete logical line and its ending, including
the preceding line when moving back from a line start.

`WordCursor(buffer, offset, direction, options)` groups letters, numbers and connector punctuation
into code words. Marks and join controls attach to their base. Other symbols form runs. Forward
movement consumes a run and following whitespace. Backward movement skips preceding whitespace
and crosses the prior run. Set `skipWhitespace: false` for run edges. `next(maxWork)` reports
a raw UTF-16 offset. Supply line bounds and snap to a grapheme boundary for a visible caret.

### Browser caret geometry

Pointer hits and selections use the browser's glyph rectangles on left-to-right rows.
Left and Right follow logical caret stops across newlines and skip folded rows.

### Character warnings

`editor.configure({ characterWarnings: true })` enables all categories. A policy can turn individual
`categories` off or `allow` specific characters, one code point per entry.

| Category | Flags |
| --- | --- |
| `bidi-control` | Directional marks, embeddings, overrides and isolates |
| `bom` | U+FEFF anywhere after offset zero |
| `non-breaking-space` | U+00A0, U+2007 and U+202F |
| `invisible` | Other default-ignorable characters, including joiners and variation selectors |
| `unusual-space` | Other classified whitespace beyond ordinary space, tab, CR and LF |

A marker covers the visible grapheme. `editor.characterWarnings.query(from, to, limits)` gives
the exact code point. Continue a limited batch at `nextFrom` with the same `to` while `isCurrent()`
is true. Edits, policy changes, closure and disposal expire the capture. An unavailable query
returns `null`. Style markers with `--st-character-warning-background` and `--st-character-warning-border`.

### Limits

| Operation | Limit |
| --- | --- |
| Grapheme advance | Default 4,096 work units, minimum 256. The cursor reads 256 units per slice. Joining slices and the native segmentation call can exceed a scheduling turn. |
| Grapheme index | For a range of length `n`, defaults are `max(1_000_000, n * 16)` operations and `max(1_000_000, n)` clusters. Both take positive safe integers. Exceeding either throws `GraphemeLimitError`. |
| Word scan | Reads 256 units at a time plus one for a surrogate pair. Work counts scanned units. |
| Warning query | Defaults to 4,096 units and 256 warnings. Integer limits require `maxUnits >= 2`, `maxWarnings >= 1`. Reads at most `maxUnits + 5` units. |

## Host responsibilities

Recheck the captured document before displaying results. Configure warnings outside workspace
notifications. `editor.settings().characterWarnings` returns the frozen policy or `false`.
Invalid configuration preserves the prior setting.

Set `--st-font` on the host. Use `@font-face` for bundled fonts. For font bytes, load a `FontFace`,
add it to the editor document's `fonts` set and remove it once the views are finished.
Warning data and grapheme fixtures are covered by the [Unicode license](../licenses/Unicode-3.0.txt).
[Regeneration](testing.md#unicode-regeneration)

## Not covered

Physical keyboard behavior and device font rendering require hands-on checks.
[Support matrix](README.md#support-matrix)
