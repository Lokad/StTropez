# Unicode

StTropez stores UTF-16 text, applies Unicode 18 grapheme and bidirectional rules, and exposes
advisory character warnings. The browser measures and shapes text through native font and
range APIs. These facilities preserve source text; they do not normalize it.

## Use

Index an immutable buffer cooperatively. The host supplies a scheduler that yields to its
event loop and cancels the operation when its captured document or selection expires.

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

For a small, already bounded string, synchronous bidi resolution exposes levels and visual
code-point order. Use the cooperative cursor or workspace controller for large ranges.

```ts
import { resolveBidi } from "sttropez";

const text = "abc \u05d0\u05d1\u05d2 123";
const resolved = resolveBidi(text, "auto");
export const visualOffsets = resolved.order;
// Offsets identify source code points; this is not a sequence of rendered glyphs.
```

Character inspection can consume one bounded batch at a time. Keep the same immutable buffer
and original end offset when resuming at `nextFrom`.

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

Load a host-supplied font through an explicitly owned controller. The caller retains and
disposes the controller with its host view; it also owns the CSS that selects the family.

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

### Graphemes and word movement

`createGraphemeCursor(bufferOrString, options)` captures its source without reading it.
`next(workBudget)` advances scanning and publication; `snapshot()` exposes progress and a
`null` result until completion. Limit exhaustion throws `GraphemeLimitError` and records a
failed snapshot without publishing a partial index. `dispose()` releases unfinished work;
a completed `GraphemeIndex` retained by the caller stays valid.

Positions are absolute UTF-16 offsets, including unpaired surrogates. Optional `from`/`to`
bounds establish an independent segmentation context. The caller must choose a safe restart
boundary when it needs the same result as whole-document segmentation. Rules cover CRLF,
Hangul, combining marks, prepend characters, emoji joiners, regional indicators and Indic
conjuncts. `unicodeGraphemeVersion`, `graphemeBreakProperty`, `indicConjunctBreak`,
`extendedPictographic` and `defaultIgnorable` expose the associated character facts.

The immutable index records its source, range, Unicode version, cluster count and boundary
count. `boundaryAt` and `clusterAt` query it without materializing all boundaries. `floor`
and `ceil` include an exact boundary; `preceding` and `following` are strict and return `null`
at the corresponding end. `isBoundary` tests a position, and `clusterIndexAt` requires an
offset inside the range. An empty range has one boundary and no clusters. `boundaries()`
explicitly materializes the requested boundary interval. `graphemeBoundaries(text)` runs
the same kernel synchronously for bounded strings.

Editor movement first attempts an exact local ASCII query. Uncertain context triggers
cooperative indexing of the captured logical line, including its LF. Backward movement at a
line start includes the preceding line. The cache holds one immutable buffer/range pair;
it does not truncate long clusters or reset regional-indicator parity at a fixed window.
Word destinations use these boundaries. Collapsed deletion from inside a cluster expands
to both boundaries; nonempty selections keep their exact requested extent. Delayed commands
validate revision, selection, tab generation, composition and edit permission before use.

`WordCursor(buffer, offset, direction, options)` supplies code-word endpoints in either direction.
`WordOptions` can bound the source range and disable whitespace skipping. Unicode letters,
numbers and connector punctuation form words; other symbols form runs, and whitespace is
separate. Marks and join controls attach to their preceding base. Forward movement consumes
the current run and following whitespace; backward movement skips preceding whitespace and
consumes the preceding run. `skipWhitespace: false` finds run edges for pointer selection.
This is a code-oriented policy, not dictionary segmentation or Unicode word-boundary conformance.

`next(maxWork)` returns immutable `WordStep` progress with status, raw UTF-16 offset and work/read
counts. The budget is a safe integer of at least 256 (default 4,096); checkpoints can overshoot
it. Reads retain a 256-unit slice plus at most one unit to complete a surrogate pair. `dispose()`
releases unfinished scanning and marks it cancelled. The caller supplies grapheme snapping and
logical-line bounds where needed. `codeWordConstituentPattern` exposes the one-code-point pattern
for host Unicode expressions; it includes marks/joiners as well as word bases.

### Bidirectional resolution

`resolveBidi(text, direction)` returns frozen levels, visual order and paragraph base levels
using Unicode 18 bidirectional resolution through L2. Direction is `ltr` by default, `rtl`
or `auto`. Levels address UTF-16 units; both halves of a surrogate pair share a level.
Removed formatting controls have `null` levels. Order entries are code-point start offsets;
CRLF forms one paragraph separator. Resolution leaves the text unchanged.

`BidiCursor(source, { from?, to?, direction? })` captures a buffer or string without an
initial read. `next(workBudget)` exposes scan, resolve and publish progress, read/work counts
and a completed `BidiIndex`. `dispose()` cancels unfinished work; a retained completed index
stays usable. Index coordinates are absolute: `levelAt`, `offsetAt`, `indexOf` and
`paragraphAt` query the captured range. Surrogate interiors, removed controls and the end
offset have no visual index. `visualLength` counts ordered code points, including controls
with zero advance; it is not a glyph count. `materialize()` creates proportional arrays
whose offsets are relative to the captured range.

`createBidiIndexController(workspace, tabId, { direction? })` retains a text resource and
publishes immutable snapshots. `request({ expectedRevision, from, to })` returns a generation;
a stale revision returns `null` without disturbing existing work. The host schedules
`advance(workBudget)`. Edits invalidate the captured result; tab closure/replacement or an
unavailable resource expires it. Check `isCurrent(generation)` before consuming a completed
index. `cancel()` clears work and results; `dispose()` releases listeners and its lease.
It changes no text or selection.

Each paragraph is resolved as one unwrapped line. Shaping, mirroring and placement belong
to the renderer; reordering wrapped lines requires their actual break positions.

### Browser caret geometry

Complete rendered rows combine native grapheme ranges with resolved bidi levels. At an
ambiguous logical boundary, `before` affinity identifies the end of the preceding logical
grapheme and `after` the start of the following one. Shared visual edges are reconciled to
avoid rounding-induced extra stops; zero-advance controls use neighboring visible edges.
Geometry queries preserve host DOM, styles and the browser selection.

Left/Right follows physical glyph order on complete rows. Shift keeps the logical anchor
and its affinity; collapsing a selection uses its visual edge. Line-edge movement follows
paragraph flow, including CRLF and empty/control-only rows. Captured view state retains
affinities separately from the native textarea. Set `--st-text-direction` on the host to
`ltr` or `rtl`; the scroll container keeps LTR coordinates. Decorations preserve paragraph
direction. Partial long rows use fragment shaping and estimated global origins, and their
visual commands fall back to logical grapheme movement. See [viewport geometry](viewport.md)
for presentation state and the `partialRows` distinction.

### Character warnings

`CharacterWarnings` classifies source characters without changing them. All categories in
`characterWarningKinds` are enabled by default. `categories` can disable individual kinds;
`allow` copies a list of exact permitted characters into an immutable `configuration`.
Unknown categories, non-boolean switches and entries containing more than one code point
are rejected. `kind(codePoint, offset)` returns a category or `null`.

| Category | Meaning |
| --- | --- |
| `bidi-control` | Directional marks, embeddings, overrides and isolates |
| `invisible` | Other default-ignorable characters |
| `bom` | U+FEFF after document offset zero |
| `non-breaking-space` | U+00A0, U+2007 or U+202F |
| `unusual-space` | Other classified whitespace, excluding ordinary space, tab, CR and LF |

Letters from other writing systems and ordinary combining marks are not warnings. Joiners
and variation selectors can be meaningful; warning policy belongs to the host.
`scan(buffer, from, to, limits)` returns immutable exact code-point ranges, including a
surrogate pair clipped by the requested boundary. A limited batch supplies `nextFrom` for
continuation against the same buffer and original end. `scanText(text, absoluteOffset)`
expects an already bounded, complete-code-point fragment. `characterWarningLabel` supplies
a plain-text label. A classification is advisory, not a language-validity or security verdict.

Enable markers with the editor's `characterWarnings: true` or policy options, or call
`editor.characterWarnings.configure(options)`. Markers are off by default; `false` clears
them. `configuration()` returns a frozen policy or `null`. `query(from, to, limits)` returns
a bounded batch with document/revision and an `isCurrent()` guard, or `null` if unavailable.
Edits, policy changes, view closure and disposal expire that capture. Invalid configuration
preserves the existing policy; configure outside workspace notifications.

Markers classify presented fragments without a document scan or background job. Their spans
cover the containing grapheme; query ranges identify the exact code point. Markers preserve
source text, syntax foreground and selection backgrounds. Customize
`--st-character-warning-background` and `--st-character-warning-border`.

### Native font registration

`createFontAssetController(ownerDocument, fontId)` owns one registered `FontFace`. It requires
a nonempty identity and native font-loading APIs. `request(expectedGeneration, bytes)` copies
the bytes and returns `{ generation, settled }`; a stale expected generation returns `null`.
The new face is registered before the controller removes its preceding face. The immutable
snapshot's `current` records `{ fontId, generation, family }`. Failed decoding or registration
preserves the preceding current face and publishes a failure message.

Supersession, cancellation and disposal prevent late registration. `cancel()` preserves a
registered face; `dispose()` removes only this controller's face and clears `current`.
`isCurrent(generation)` tests the registered face, including after a later load fails.
Disposal is idempotent. Browser APIs own decoding, shaping and measurement; the host supplies
font bytes and chooses the views that use the returned CSS family.

### Limits

| Operation | Bound or validation |
| --- | --- |
| Grapheme/bidi cursor advance | Default 4,096 work units; integer budget at least 256; cooperative checkpoints can overshoot a requested budget |
| Grapheme limits | Positive safe integers; default operations `max(1_000_000, rangeLength * 16)`, clusters `max(1_000_000, rangeLength)` |
| Grapheme publication | Frozen blocks of up to 256 boundaries; no partial index publication |
| Source reads | Grapheme/bidi cursors read 256-unit windows with surrogate seam lookahead |
| Bidi depth | Explicit embedding/isolate levels through 125; resolved levels through 126 |
| Synchronous utilities/materialization | Work and arrays proportional to the supplied range; callers bound inputs |
| Character scan | Default 4,096 units and 256 warnings; integer `maxUnits >= 2`, `maxWarnings >= 1`; at most `maxUnits + 5` units read |
| Character marker cache | At most 128 presented fragments |

Work counts are cooperative scheduling units, not time or memory guarantees. Allocation,
freezing, native calls and garbage collection are indivisible from the caller's perspective.

## Host responsibilities

Capture identities and revisions before scheduling work, yield between advances, and dispose
abandoned cursors/controllers. Revalidate captures before applying results to a live view.
Choose segmentation/paragraph ranges with enough context. Use query methods when a bounded
consumer does not need a fully materialized array.

Choose text direction, warning policy, font sources and CSS. Reset host font selection before
disposing a face that its views use. Treat character warnings as contextual advice.
Geometry caches follow DOM, style/font metrics and row movement; use the editor's supported
presentation APIs when changing those inputs.

Unicode data and development fixtures carry the [Unicode License V3](../licenses/Unicode-3.0.txt).
The generators accept reviewed local data; ordinary builds and consumer restores do not
download or regenerate it. The TypeScript kernels use generated facts and native browser
rendering, preserving the library's zero runtime dependencies.

## Not covered

See the [support matrix](README.md#support-matrix) for layout, native rendering and device boundaries.
