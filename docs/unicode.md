# Unicode

The editor stores UTF-16 offsets and moves by grapheme. A letter and combining accent take one caret step.
Browser `Intl.Segmenter` boundaries can differ for rare sequences.

## Use

Index a captured buffer in steps. Cancel on selection or revision change.

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

Enable `characterWarnings` and query a range for tooltip text.

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

Advance with `next(budget)` and read `snapshot()` at `ready`, including zero offsets and empty results.
Failed advances record and throw their cause. Invalid budgets preserve progress. `dispose()` releases the
cursor. Held results survive. Reentrant advance or disposal throws.

### Graphemes and word movement

`createGraphemeCursor(source, { from, to })` reads on first advance and segments one string. Its immutable
index uses absolute offsets and preserves unpaired surrogates. Include context at range boundaries. Starting
mid-run can pair regional indicators into different flags.

`boundaryAt` and `clusterAt` take indices. Empty ranges have one boundary and zero clusters. `floor`/`ceil`
include exact matches. `preceding`/`following` exclude them and return `null` past the range.
`clusterIndexAt` requires an offset below `to`, `isBoundary` accepts `to`. `index.boundaries()` materializes
an interval. `graphemeBoundaries(text)` builds the whole array synchronously.

Deletion at a caret removes one cluster, including CRLF. A nonempty selection keeps its exact bounds.
For context-sensitive characters the editor indexes the full logical line and its ending before moving or
deleting. Repeated queries reuse that index until the buffer or line changes.

Word movement groups letters, numbers and connector punctuation. Marks and join controls attach to their
base. Other symbols form runs. Word commands scan within a logical line, stop at its boundaries and snap
the result to a grapheme before moving or deleting.

### Browser caret geometry

Hit tests and selections use browser glyph rectangles on left-to-right rows. Left/Right follow logical stops
across newlines and skip hidden rows.

### Character warnings

`editor.configure({ characterWarnings: true })` enables all categories. Disable individual `categories` or
`allow` one code point per entry.

| Category | Flags |
| --- | --- |
| `bidi-control` | Directional marks, embeddings, overrides and isolates |
| `bom` | U+FEFF after offset zero |
| `non-breaking-space` | U+00A0, U+2007, U+202F |
| `invisible` | Other default ignorables, including joiners and variation selectors |
| `unusual-space` | Other whitespace beyond space, tab, CR and LF |

Markers cover the visible grapheme. `editor.characterWarnings.query(from, to, limits)` identifies the code
point or returns `null` if unavailable. Continue at `nextFrom` with the same `to` while `isCurrent()`.
Edits, policy changes, closure and disposal expire the capture. Style `--st-character-warning-background`
and `--st-character-warning-border`.

### Limits

| Operation | Limit |
| --- | --- |
| Grapheme advance | Default 4,096, minimum 256 work units. Reads use 256-unit slices. Joining and native segmentation can exceed a turn. |
| Grapheme index of length `n` | Defaults to `max(1_000_000, n * 16)` operations and `max(1_000_000, n)` clusters. Positive safe integers. Overflow throws `GraphemeLimitError`. |
| Word scan | 256 units plus one for a surrogate pair. Work counts scanned units. |
| Warning query | Defaults to 4,096 units, 256 warnings. Integer limits require `maxUnits >= 2`, `maxWarnings >= 1`. Reads at most `maxUnits + 5` units. |

## Host responsibilities

Recheck the document before display. Configure warnings outside notifications.
`editor.settings().characterWarnings` returns the frozen policy or `false`. Invalid settings preserve the
old policy.

Set `--st-font` on the host. Use `@font-face` or load a `FontFace` into the editor document’s `fonts` set
and remove it after use. [Unicode license](../licenses/Unicode-3.0.txt) ·
[Regeneration](testing.md#unicode-regeneration)

## Not covered

[Physical keyboard and font checks](README.md#support-matrix)
