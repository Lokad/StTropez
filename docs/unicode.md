# Unicode

StTropez preserves UTF-16 source text, uses Unicode 18 rules for grapheme boundaries and can flag
unusual characters. The browser shapes and measures the text.

## Use

Index a captured buffer in steps. Yield between steps and cancel if the document or selection
changes.

```ts
import { createGraphemeCursor } from "sttropez";
import type { GraphemeIndex, TextBuffer } from "sttropez";

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

Resume a warning scan at `nextFrom` with the same buffer and original end offset.

```ts
import { CharacterWarnings, characterWarningLabel } from "sttropez";
import type { TextBuffer } from "sttropez";

const warnings = new CharacterWarnings({ allow: ["\u200d"] });

export function inspectCharacters(buffer: TextBuffer, from: number, to: number) {
    const batch = warnings.scan(buffer, from, to, { maxUnits: 4096, maxWarnings: 64 });
    return {
        complete: batch.complete,
        nextFrom: batch.nextFrom,
        items: batch.warnings.map(warning => ({
            from: warning.from, to: warning.to, label: characterWarningLabel(warning)
        }))
    };
}
```

The host loads the font, selects its family in CSS and disposes the controller with the view.

```ts
import { createFontAssetController } from "sttropez/browser";

export function hostFont(owner: Document, applyFamily: (family: string) => void) {
    const asset = createFontAssetController(owner, "editor-font");
    return {
        async load(bytes: Uint8Array): Promise<boolean> {
            const operation = asset.request(asset.getSnapshot().generation, bytes);
            if (!operation) return false;
            const result = await operation.settled;
            if (result.status !== "ready" || !asset.isCurrent(result.generation)) return false;
            const current = asset.getSnapshot().current;
            if (!current) return false;
            applyFamily(current.family);
            return true;
        },
        cancel: () => asset.cancel(),
        dispose: () => asset.dispose()
    };
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
conjuncts. Read `unicodeGraphemeVersion` for the data version.

The immutable index records its source, range, Unicode version, cluster count and boundary
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

`CharacterWarnings` classifies source characters without changing them. All categories in
`characterWarningKinds` are enabled by default. `categories` can disable individual kinds;
`allow` copies a list of exact permitted characters into an immutable `configuration`.
Each allow-list entry must contain exactly one code point. `kind(codePoint, offset)` returns a category or `null`.

| Category | Meaning |
| --- | --- |
| `bidi-control` | Directional marks, embeddings, overrides and isolates |
| `invisible` | Other default-ignorable characters |
| `bom` | U+FEFF after document offset zero |
| `non-breaking-space` | U+00A0, U+2007 or U+202F |
| `unusual-space` | Other classified whitespace, excluding ordinary space, tab, CR and LF |

Ordinary combining marks and letters from other scripts pass without warnings. Decide which joiners
and variation selectors to flag for your source. `scan(buffer, from, to, limits)` returns exact
code-point ranges, even for a surrogate pair that straddles a requested boundary. To continue a
limited scan, pass `nextFrom` with the same buffer and end. If you already have a bounded fragment of
complete code points, use `scanText(text, absoluteOffset)`. Show the plain-text description from
`characterWarningLabel`. A warning identifies the character and leaves its interpretation to the
reader.

Enable markers with the editor's `characterWarnings: true` or policy options, or call
`editor.characterWarnings.configure(options)`. Markers are off by default; `false` clears
them. `configuration()` returns a frozen policy or `null`. `query(from, to, limits)` returns
a bounded batch with document/revision and an `isCurrent()` guard, or `null` if unavailable.
Edits, policy changes, view closure and disposal expire that capture. Invalid configuration
preserves the existing policy; configure outside workspace notifications.

Markers inspect only the presented fragments. Each marker covers a grapheme. A query returns the
exact code point. Markers preserve source text, syntax color and selection backgrounds. Style them
with `--st-character-warning-background` and `--st-character-warning-border`.

### Native font registration

`createFontAssetController(ownerDocument, fontId)` owns one registered `FontFace`. It requires
a nonempty identity and native font-loading APIs. `request(expectedGeneration, bytes)` copies
the bytes and returns `{ generation, settled }`; a stale expected generation returns `null`.
The new face is registered before the controller removes its preceding face. The immutable
snapshot's `current` records `{ fontId, generation, family }`. Failed decoding or registration
preserves the preceding current face and publishes a failure message.

If a second request supersedes the first, the old font cannot register later. Cancellation and
disposal also stop late registration. `cancel()` keeps the current face. `dispose()` removes the
controller’s face, clears `current` and is safe to repeat. Use `isCurrent(generation)` to check which
face is registered, including after a later load fails. You supply the bytes and choose which views
use the returned CSS family. The browser decodes, shapes and measures the font.

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

Choose warning policies, font sources and CSS. Reset the selected font before disposing its face.
Use the editor’s presentation APIs when changing styles or fonts so cached geometry follows the
change.

Unicode data and development fixtures carry the [Unicode License V3](../licenses/Unicode-3.0.txt).
The [regeneration workflow](testing.md#unicode-regeneration) uses reviewed local inputs, pins their
hashes and checks outputs offline. Builds and restores use the generated data directly.

## Not covered

Caret geometry uses left-to-right rows. Font rendering on particular devices needs a device check.
[Presentation support](README.md#support-matrix)
