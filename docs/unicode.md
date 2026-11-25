# Unicode

StTropez preserves UTF-16 source text, uses the runtime’s grapheme boundaries and can flag
unusual characters. The browser shapes and measures the text.

## Use

Index a captured buffer in steps. Yield between steps and cancel if the document or selection
changes.

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

Enable character warnings on an editor, then query a range for the text to show in a tooltip.
Pass a permitted character in `allow` when it is intentional in your source.

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

Use `snapshot()` to read progress between calls to `next(workBudget)`. Grapheme and word cursors start
in `running`. In `ready`, read the result even if it is an empty index or offset zero. In `failed`,
the cursor has released unfinished work, recorded a message and thrown the original cause. Call
`dispose()` to release the result and failure and move to `disposed`. Disposal is safe to repeat, and
an index you already hold stays usable. Calling `next()` or `dispose()` from inside an active call
throws. That call can catch the error.

Pass the work budget in the [limits table](#limits). The cursor checks it between operations and can
overshoot. An invalid budget throws before changing state, even after completion or disposal.

### Graphemes and word movement

`createGraphemeCursor(bufferOrString, options)` defers its first read until `next(workBudget)`. Read
`snapshot().result` once scanning finishes. It stays `null` during the scan. If a limit is reached,
`next` throws `GraphemeLimitError` and records a failed snapshot. Only a complete `GraphemeIndex` is
available.

`from` and `to` are absolute UTF-16 offsets. Unpaired surrogates keep their original positions. The
cursor segments the supplied range on its own. For whole-document boundaries, start where you know the
segmentation state. For example, starting between two regional indicators can change how flags are
paired. Rules also cover CRLF, Hangul, combining marks, prepend characters, emoji joiners and Indic
conjuncts. The runtime supplies `Intl.Segmenter`. Its Unicode version can affect caret movement and deletion.

The immutable index records its source, range, cluster count and boundary
count. `boundaryAt` and `clusterAt` query it without materializing all boundaries. `floor`
and `ceil` include an exact boundary; `preceding` and `following` are strict and return `null`
at the corresponding end. `isBoundary` tests a position, and `clusterIndexAt` requires an
offset inside the range. An empty range has one boundary and no clusters. `boundaries()`
explicitly materializes the requested boundary interval. `graphemeBoundaries(text)` runs
the same kernel synchronously for bounded strings.

For movement, the editor first checks local ASCII text. When it needs more context, it indexes the
captured logical line and its LF, including the preceding line for backward movement at a line
start. It caches one buffer/range pair and preserves long clusters and regional-indicator parity.
Word movement uses the same boundaries. At a caret inside a cluster, deletion removes the whole
cluster. A nonempty selection keeps its exact extent. Delayed commands recheck revision, selection,
tab generation, composition and edit permission.

`WordCursor(buffer, offset, direction, options)` supplies code-word endpoints in either direction.
`WordOptions` can bound the source range and disable whitespace skipping. Unicode letters,
numbers and connector punctuation form words; other symbols form runs, and whitespace is
separate. Marks and join controls attach to their preceding base. The default forward scan consumes
the current run and following whitespace; the backward scan skips preceding whitespace and
consumes the preceding run. `skipWhitespace: false` finds run edges for pointer selection.
This is a code-oriented policy, not dictionary segmentation or Unicode word-boundary conformance.

`next(maxWork)` returns `WordStep` progress with status, raw UTF-16 offset, failure and work/read
counts. Work counts scanned UTF-16 units. Reads retain a 256-unit slice plus at most one unit
to complete a surrogate pair. The caller supplies grapheme snapping and
logical-line bounds where needed.

### Browser caret geometry

Rows use left-to-right layout and browser-shaped glyph rectangles. Caret stops follow logical
grapheme boundaries, including combining sequences and emoji. Left and Right cross line breaks and
skip folded rows. Selection endpoints keep their affinities. Hit testing and pointer selection share
row geometry.

### Character warnings

Enable markers with `editor.configure({ characterWarnings: true })` or pass a policy object.
All categories start enabled. Set individual `categories` to false or add permitted characters
to `allow`. Each entry must contain exactly one code point.

| Category | Meaning |
| --- | --- |
| `bidi-control` | Directional marks, embeddings, overrides and isolates |
| `invisible` | Other default-ignorable characters |
| `bom` | U+FEFF after document offset zero |
| `non-breaking-space` | U+00A0, U+2007 or U+202F |
| `unusual-space` | Other classified whitespace, excluding ordinary space, tab, CR and LF |

Ordinary combining marks and letters from other scripts pass without warnings. Decide which joiners
and variation selectors to flag for your source. Use `characterWarningLabel` for the name and
Unicode code point. To continue a limited query, pass its `nextFrom` with the same end offset
while the capture is current.

`editor.settings().characterWarnings` returns the frozen policy or `false` when disabled.
`editor.characterWarnings.query(from, to, limits)` returns
a bounded batch with document/revision and an `isCurrent()` guard, or `null` if unavailable.
Edits, policy changes, view closure and disposal expire that capture. Invalid configuration
preserves the existing policy; configure outside workspace notifications.

Markers inspect only the presented fragments. Each marker covers a grapheme. A query returns the
exact code point. Markers preserve source text, syntax color and selection backgrounds. Style them
with `--st-character-warning-background` and `--st-character-warning-border`.

### Limits

| Operation | Bound or validation |
| --- | --- |
| Grapheme cursor advance | Default 4,096 work units; integer budget at least 256; cooperative checkpoints can overshoot a requested budget |
| Grapheme limits | Positive safe integers; default operations `max(1_000_000, rangeLength * 16)`, clusters `max(1_000_000, rangeLength)` |
| Grapheme publication | Frozen blocks of up to 256 boundaries; no partial index publication |
| Source reads | Grapheme cursors read 256-unit windows with surrogate seam lookahead |
| Synchronous utilities/materialization | Work and arrays proportional to the supplied range; callers bound inputs |
| Character scan | Default 4,096 units and 256 warnings; integer `maxUnits >= 2`, `maxWarnings >= 1`; at most `maxUnits + 5` units read |
| Character marker cache | At most 128 presented fragments |

A checkpoint cannot interrupt allocation, freezing, native calls or garbage collection. Measure time
and memory separately.

## Host responsibilities

Capture identity and revision before scheduling, yield between advances and dispose abandoned
cursors. Recheck the capture before updating a live view. Give each segmentation range enough
context. Use bounded queries when you need only part of the index.

Choose warning policies and font sources. Set the host's CSS variable `--st-font` to the
desired family. For bundled web fonts, use `@font-face`. For fonts supplied as bytes, load
a `FontFace` and add it to the editor document's `fonts` set. The host owns that registration
and removes it when its views have finished using it.

Unicode data and development fixtures carry the [Unicode License V3](../licenses/Unicode-3.0.txt).
The [regeneration workflow](testing.md#unicode-regeneration) uses reviewed local inputs, pins their
hashes and checks outputs offline. Builds and restores use the generated data directly.

## Not covered

Caret geometry uses left-to-right rows. Font rendering on particular devices needs a device check.
[Presentation support](README.md#support-matrix)
