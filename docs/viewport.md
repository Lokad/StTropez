# Bounded text viewport

Ctrl/Meta wheel events pass through to the browser's zoom handling; the viewport does not
cancel them or apply their deltas as editor scrolling.

`mountTextViewport` is a read-only DOM projection over an indexed workspace document. It is
the first M3 rendering layer, separate from the native `mountTextEditor` control. Per-view
[folding](folding.md) projects visible source rows without changing raw document positions. Local native
text geometry now supplies `coordsAt` and `hitTest`; the separate experimental
[`mountEditingCandidate`](editing-candidate.md) adds bounded input. This component does not
select an input engine.

`activity()` returns an immutable `ViewportActivity` capture, reused while its fields are unchanged.
It reports the last painted revision, selection set, fold generation and comparison alignment,
the row generation, a scheduled-frame flag and disposal. It performs no layout measurement or
flush. A caller checking settlement must also compare the painted identities with the current
view and folds; `pending: false` alone does not establish that native events or services have
finished. `snapshot()` retains these fields alongside dimensions, work counts and timings.

`coordsAt`, `rowBounds` and `hitTest` use client coordinates. Scroll positions, navigation
columns and inline placement use local CSS units. Inherited CSS `zoom` is converted at this
boundary, including caret/input anchors, secondary carets, drop markers and pointer scroll
bounds. The implementation uses the browser's effective zoom, with an ancestor-style fallback;
it adds no runtime dependency. This follows the [CSSOM coordinate and zoom definitions](https://drafts.csswg.org/cssom-view/#dom-element-currentcsszoom).
Normal/100k host scenarios compare against DOM text ranges at 150% and 75% inherited zoom,
including borders, complete selections, pointer ranges, vertical/page navigation, typing/undo,
comparison panes and a 2.4M-unit horizontal window. These checks cover DOM geometry; native
IME placement, browser-toolbar zoom and OS display scaling still need platform qualification.

Set `columnRulers: [80, 120]` on `mountTextViewport` or `mountEditingCandidate` to draw guides
after 80 and 120 measured monospace cells. The default is empty. The viewport copies, sorts and
deduplicates the array; it accepts at most 128 entries, each a positive safe integer.
`viewport.columnRulers()` returns the frozen configuration and `configureColumnRulers(columns)`
replaces it without remounting. Invalid values leave the current configuration intact; an empty
array removes all guides. Configuration must run outside Workspace notifications and returns
false after disposal. No-op configuration keeps the same capture and schedules no work.

Guides follow the existing measured column width, logical horizontal scroll, font and zoom.
They mark measured cells from the left text origin, not UTF-16 offsets or per-line shaped glyph
positions; proportional/variable-width text can cross them differently. Only visible guides are
mounted in the clipped paint layer, behind text. They add no text, hit target or scroll extent,
and changing only the ruler configuration reuses painted rows and their geometry. Customize
their color with `--st-column-ruler`. Each comparison viewport can configure its own rulers.

`highlightCurrentLine: true` enables the current-line background. It is off by default;
`viewport.currentLineHighlight()` reads the setting and `configureCurrentLineHighlight(boolean)`
changes it without remounting. It follows only the primary collapsed caret, including when the
view is unfocused or read-only. A noncollapsed primary selection hides it; secondary carets do
not add highlights. If that caret is folded away, the fold header is highlighted. Comparison
alignment positions it on the source row, never on padding rows. Views configure it independently.

The source row receives `st-current-line` in addition to the host's `lineClass`. A separate inert
background spans the visible width behind rows; top/bottom edges stay visible over opaque host
or comparison backgrounds. Both preserve syntax colors, selection styling, text geometry and
scroll extents. `--st-current-line` and `--st-current-line-border` set their colors. As with
rulers, configuration is validated before mutation, must run outside Workspace notifications,
and returns false after disposal. A matching boolean value schedules no work.

`fontLigatures: true` on either mount enables the font's normal common/contextual ligatures
through native CSS shaping. The default is false (`font-variant-ligatures: none`).
`viewport.fontLigatures()` reads the policy; `configureFontLigatures(boolean)` changes it and
invalidates existing font measurements and native caret/navigation geometry. It preserves the
document, selection and view identity. Validation, notification and disposal rules match the
other presentation settings; a matching value schedules no work.

The selected font must provide the substitutions. Hosts can still override features through
CSS `font-feature-settings`, whose feature-level values take precedence. The setting adds no
font asset or shaping engine. A generated fixture with a known `fi` substitution qualifies
actual glyph-width changes, interior carets, selection, hit testing, typing and undo across
the supported browser engines; native IME/device qualification remains separate.

`scrollBeyondLastLine: true` adds enough empty space below the document to scroll its last
visible row to the top text padding. It defaults to false. Read it with
`viewport.scrollBeyondLastLine()` and change it with `configureScrollBeyondLastLine(boolean)`.
Disabling clamps scrolling to the ordinary document extent; enabling preserves the current
scroll position. Nearest-edge caret reveal still leaves an already visible caret in place.
The extra space follows viewport size, line height, folding and the aligned comparison grid,
including any trailing alignment padding. It adds no source rows or editable text and uses
the same capped physical/logical scroll mapping as large documents. An empty document or
single visible row needs no added extent. Validation, no-op and disposal rules match the
other settings. Each comparison viewport owns its policy.

The display caret follows the measured source position at scroll boundaries, including partly
clipped rows. Its placement is independent of the bounded native input anchor, so keeping that
anchor inside the viewport cannot shift the visible caret away from its character.

Each frame reads the container/font geometry, obtains only visible/overscan lines and bounded
horizontal ranges when its paint capture changes, then writes the DOM. A bounded batch of native row-width reads follows the
writes; extent/reveal corrections schedule another frame. Rows are reused, kept in document order and removed
outside the window. The default overscan is four lines and 32 UTF-16 units per horizontal edge.
Unchanged row text and inline classes retain their text/span nodes, including selection and
provider decorations. Each render still obtains current decorations and updates row offsets
and revision metadata. Changed text, classes or selection segments replace the affected
children; no second document or provider-state cache is retained. Comparison marks can change
when the exact alignment replaces mapped presentation, replacing the affected styled children.
Lines up to 512 UTF-16 units render whole for natural browser shaping; longer lines use bounded
windows. Mounted text and reads scale with viewport dimensions and that per-row cap. Neither
rendering, scroll changes nor metadata updates access `DocumentSnapshot.text` or resource value.
Unrelated resource notifications do not schedule a frame. Multiple changes coalesce into one
animation frame, while each revision's map updates the retained scroll anchor synchronously.

`flush()` reads current container/font metrics synchronously, so CSS changes and reveals do not
wait for ResizeObserver. Matching revision, selection set, fold generation, comparison rows,
scroll, dimensions, typography, extents, placement and invalidation state skip row slicing,
decorator callbacks, DOM writes and row-width reads. A requested reveal still runs, including
partial-row placement and later extent correction. Call `invalidate()` when host decoration
or external style state changes; font completion also invalidates. Consuming a scheduled pass
still emits `sttropez-render` to release caret/comparison listeners, even if no rows needed paint.
An idle synchronous flush emits no event. `renders` counts actual paints; `readUnits` and
`lastRenderMs` describe the last paint. Skipped passes do not replace these measurements.

Native geometry is retained for unchanged mounted rows while the source offset, document
revision and effective line height match. Each measurement checks the row's client bounds and
row/inline typography; movement or typography changes expire the measured rectangles, even when
inline changes leave the outer width unchanged. Changed children, removed rows, font completion
and explicit `invalidate()` calls discard their geometry. Hosts should invalidate after external
style or decoration changes. Geometry owns one reusable native Range; it retains copied rectangle
results, never a Range per character. Coordinate lookup uses the indexed source line, including
CRLF, empty final rows and collapsed-fold projection.

A caret-point query measures its glyph and the visible neighbors needed to reconcile their
facing edges. Invisible clusters inherit corrected logical-neighbor edges before their fallback
is cached. Later full preparation preserves those returned points. Bidi/grapheme ordering still
covers the bounded row, and finding neighbors through a long zero-width run can scan that run;
this is not a constant-work guarantee for arbitrary text. Hit testing, visual navigation and
visual-edge queries still prepare the full bounded row. A single point in the 500-character
plain-row regression needs at most seven native rectangle queries; repeated valid points reuse
the results. No native shaping or affinity rule is replaced.

Inline painting validates and clips decoration ranges once, sorts their boundaries, and sweeps
the active ranges in host-supplied order. Overlapping and duplicate classes retain that order;
selection styling comes last. Changes sharing an endpoint are merged together, so disjoint
decorations do not rescan every range per segment and coincident endpoints do not cause repeated
array insertions/removals. Work after sorting follows the boundaries and emitted class labels;
dense overlaps can still require large output. A bounded cache retains at most 256 validated
class names. The existing child-node comparison preserves unchanged text/span nodes.

`prepareNavigationRows(lines)` accepts at most 64 valid line indices and returns an explicit release
function. It writes complete short command rows before native geometry reads, without revealing them.
Identical painted rows keep the existing single-probe reuse path; long contextual windows also keep
their existing path. The batch belongs to its captured document revision and complete selection set.
Release it after the command or cancellation. A newer batch supersedes the old one; an old release
function cannot clear a newer batch. Document changes and viewport destruction release rows eagerly,
including their native geometry references. These command reads are separate from render `readUnits`.

The buffer now caches raw UTF-16 prefix/suffix/longest-line lengths in its AVL nodes. Immutable
backings also contain a range-maximum index over gaps between LF offsets, so splitting an old
backing can query its longest internal line without scanning its line array. Construction
indexes new backing text; edits update copied paths. `longestLineLength` is constant-time and
preserves raw CRLF semantics (CR counts as a code unit). This small original index extends the
existing zero-dependency store. `BufferRetention.gapEntries` reports its additional logical
index slots; it is not a byte estimate. The earlier M2 selection measurements are frozen before
this augmentation, so their construction/heap numbers do not describe this later version.

Logical scroll extents derive from line count, line height and longest-line units. Physical
scroll dimensions are capped at four million pixels per axis. Scrollbar coordinates map across
the full logical range; wheel and region keyboard scrolling retain logical-pixel steps. This
keeps both the end of a huge line and the last line reachable without a browser-sized giant
element. Geometry is remeasured on resize and font-metric changes. Explicit reveal requests
capture the document revision and map through subsequent edits; tab generations remain guarded.
Font-load completion/failure also invalidates measurements; disposal removes those listeners.
`revealOffset(offset, { horizontal, vertical, affinity })` accepts `center` or `nearest` per axis,
with centered defaults. Nearest reveal keeps visible caret positions in place with a small edge
margin. The snapshot's `partialRows` counts mounted line fragments lacking their full line context;
zero partial rows alone does not establish correct bidi affinity or navigation.

Long-line horizontal layout currently estimates columns from UTF-16 units and measured monospace
`M` width. Short Unicode lines retain natural browser shaping; measured widths can grow their
horizontal extent. Width observations are discarded on a new revision so removed wide text cannot retain an
obsolete extent. Window edges preserve surrogate pairs. Within each mounted row,
`Intl.Segmenter` supplies grapheme boundaries and native text ranges supply caret rectangles.
The [bidi resolver](bidi.md) supplies glyph direction and dual boundary affinities on complete rows.
Hit testing compares visual positions rather than assuming logical bidi order. Coordinates carry
their document revision and stale projections return no hit. `coordsAt` snaps a cluster interior
according to affinity; it returns no coordinate outside mounted ranges. `flush` explicitly renders
pending state for synchronous navigation.

The long-line estimate is not correct global glyph geometry for tabs, CJK, combining sequences,
ZWJ or bidi shaping. A mounted fragment has local native geometry but lacks the shaping context
and measured horizontal origin of the full line. Contextual long-line indexing and navigation,
wrapping and native composition positioning remain qualification work. The longest-line
metadata remains useful independently of that later geometry choice. LF ends rows; a CR before LF
is omitted from display, while an ordinary lone CR is shown as a control symbol.

Explicit reveal keeps the requested caret visible inside a partial row using that fragment's
native geometry. A local translation corrects wide tabs or mixed text without changing the
estimated logical scroll map or reading the whole line. Manual scrolling clears this placement.
`captureView` retains an optional immutable `horizontalAnchor` containing the source revision,
offset, affinity and viewport position; `restoreView` ignores an anchor from another revision.
Invalid scroll positions are rejected before restoring selections or folds, leaving the view
unchanged. Scroll coordinates must be finite; negative coordinates clamp to zero.
This preserves same-revision remounts without claiming a measured global horizontal origin or
complete contextual shaping. Complete rows continue to use their ordinary measured scroll path.
The bounded input adapter also retains a previously visible focused selection head when a host
resize or font-metric change would hide it. It reuses nearest reveal and local fragment placement
without changing text, complete selections or history. A changed revision, selection, fold or
explicit scroll expires that placement decision; inactive views and deliberately offscreen carets
keep their scroll positions. This does not supply the missing global contextual geometry.
A host layout change during a render retains the last valid placement until new geometry is
measured, including when the DOM changes before the resize notification arrives.
The [cooperative paragraph index](bidi.md) can resolve the complete requested range in bounded
advances, with captured revision/tab guards. Its development controls exercise that stage
independently. The renderer still needs exact global font advances and shaping before it can
consume the index as qualified long-line geometry.

Browser-native shaping remains responsible for text layout. Independent fragment measurements
and canvas-prefix origins do not establish general whole-line geometry. No custom font/shaping
pipeline is shipped; [native font registration](fonts.md) only manages host-supplied faces.

The component owns a region beneath the supplied host, subscribes only to its document/view,
metadata and tabs, and schedules bounded animation frames. A supplied `DocumentView` remains
host-owned across DOM remounts; otherwise the component creates/disposes one. Scroll state is
separate from its mapped selection. `destroy` cancels pending frames, disconnects resize
observation, removes listeners/subscriptions and clears its DOM. Expired tab generations disable
and clear that view rather than following a replacement surface.

The `/viewport/` development fixture mounts two independent projections and offers an explicit
native control. Browser tests assert exact bounded row text, first/last positions, scaled physical
scrollbars, logical wheel/keyboard scrolling, font/size changes, batched edit/undo anchors, stale
tabs, no whole-text export, independent views, unrelated 20 Hz traffic and disposal in all engines.
The restored NuGet consumer also renders the compiled viewport with its packaged CSS.
Raw offsets inside CRLF share the preceding painted line edge while retaining their exact
model offset. The same projection supplies navigation columns, so regex zero-width results
can paint a caret, move vertically and accept typing without changing newline data. It reuses
the existing row geometry and reads at most the two newline units for that exceptional point.
The optional [line decorator](providers.md) receives only the rendered fragment and captured
document/revision. It combines syntax/search/diagnostic spans with selection without replacing
the document text. An explicit invalidation schedules changed presentation; token spans remain
compatible with native glyph coordinates. Callbacks must keep visible-range work bounded.

`npm run bench:viewport` records six corpora at start/middle/end, three warmups and twenty measured
programmatic range edits per condition. It fails on a native fallback, incorrect ranges, excessive
reads/rows, missing samples, errors or whole-text export. Per-frame render timings cover container
reads, indexed ranges, DOM writes and bounded row shaping reads. The separate frame-ready value is an animation-frame
scheduling proxy, including polling overhead. It measures no typing, composition, presentation or
physical input latency. `npm run bench` runs this after the native-control/model diagnostics;
`npm run inspect` captures both large-line and many-line projections. Raw samples and source/environment
identity remain in ignored `artifacts/bench/viewport/`; repeated production budgets remain M5 work.
