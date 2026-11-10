# Script interpretation and glyph partitions

`createScriptItemizationCursor(normalized, options)` interprets Unicode 18 script facts into
logical runs over an owned immutable `NormalizedText`. `itemizeScripts` synchronously drains the
same kernel. Both preserve normalized points and original document provenance. They do not edit
the document or choose a normalization form, language, font, bidi level or complete shaping policy.

Character script facts alone do not define a unique layout partition. This stage implements an
explicit contextual policy using the existing licensed script, extension, category and bracket
facts. Its implementation is original TypeScript: an external runtime dependency would conflict
with the package contract and would still require lifecycle/provenance/scheduling integration.

| Input | Interpretation |
| --- | --- |
| Explicit script and shared script extensions | Intersect compatible candidate sets to extend a run; retain a compatible first explicit preference, otherwise choose the first sorted candidate. |
| Common/Inherited with no specific extensions | Extend the preceding run. Leading neutral text acquires the following compatible context; entirely neutral text resolves to `Zyyy`. |
| Extended grapheme | Keep the complete Unicode 18 cluster intact. The first explicit script supplies candidates; shared extensions remain available when no explicit preference exists. Foreign marks, Prepend, emoji ZWJ and conjunct sequences do not split the cluster. |
| Paired brackets | Bind openings to enclosing text and matched closings to the same run interpretation. Leading pairs can acquire the inner context. This contextual binding takes precedence over the brackets' own script/extension facts. |
| Unknown, private-use, noncharacter or raw surrogate within a cluster | Keep the entire cluster in an explicit `Zzzz` run and reset bracket context. |
| Paragraph separators, line separator U+2028, CRLF | Publish a separate `separator` run and reset contextual interpretation. CRLF stays one separator unit. |

Bracket matching uses the existing paired-bracket data, including the canonical equivalence of
the angle-bracket pairs. Language-dependent quotation marks are not guessed. A close-key map and
linked opening stacks avoid rescanning deep stacks for repeated unmatched closings. Each opening
is unwound at most once. Sorted extension intersections can yield inside comparisons.

Full [extended graphemes](graphemes.md) are the default. `clusterMode: "combining"` explicitly retains the earlier base/mark/join/selector policy. An optional `graphemes` index must be owned and match the exact normalized identity and point range; it avoids repeated segmentation. Neither policy supplies orthographic syllables.
The index is independent of bidi: hosts must intersect appropriate directional/style/font
boundaries before general shaping. Script aliases such as `Hira` are not OpenType tags; even
registered legacy/modern tags do not imply that their script-processing model is implemented.
Font/language tailoring and complete complex-script policies remain separate work.

The ready `ScriptIndex` retains `text`, its normalized-point `from`/`to` range, `runCount`,
`clusterCount` and `unicodeVersion`. `runAt(i)` returns a frozen `{ from, to, script, candidates,
kind }`; `clusterAt(i)` returns a frozen `{ from, to, runIndex }`. `runIndexAt`, `clusterIndexAt`
and `scriptAt` query a normalized point using indexed searches. Original UTF-16 spans remain at
`text.at(point).sources`; a normalized-point index is never substituted for a source offset.
Explicit subranges are interpreted independently, without silently widening to an external base.

Progress exposes `grapheme`, `cluster`, `resolve` and `publish` phases, counted work, scan/run/publication
counts and paired/unmatched bracket counts. Results remain null until ready. The default work
budget is 4096, with a minimum of 256. Options are copied at capture. Operation/run limits and a
default maximum bracket depth of 1024 fail without returning partial interpretation. Disposal
is idempotent, releases private work and leaves externally retained completed indexes valid.
Private working arrays grow with grapheme clusters/runs; published records use frozen blocks
of 256. Native allocation, array growth, freezing and garbage collection remain atomic costs,
so a counted budget is not a time deadline or a qualified memory budget.

`createScriptGlyphCursor(mapping, scripts)` requires owned values for the exact same normalized
text. It publishes one `ScriptGlyphPart` per run, including runs with no mapped glyphs. Its
`ScriptGlyphIndex` retains `mapping`, `scripts`, `length` and `at(i)`. Each part supplies the run,
`fromGlyph`, `toGlyph` and an owned glyph view suitable for GSUB. Mapping-only omissions and
cmap variation pairs keep their normalized-point associations. A selected boundary that bisects
a mapped glyph fails explicitly. Ranges are located by search, then partitioned cooperatively;
no partial partition escapes. Capture, options, operation limits and disposal follow the same rules.

`GlyphRun<T>.slice(from, to)` creates a constant-work immutable view with the same font identity,
records and original source coordinates. Nested slices accumulate an offset into the existing
blocks; they do not copy or chain per-glyph lookups. Nominal builder runs preserve their default
type, while mapped slices retain source components. A small view retains its backing blocks;
there is no implicit compact copy or retained-memory qualification.

The shaping host now schedules normalization → script interpretation → nominal mapping → glyph
partitioning → GSUB/positioning for each part. It charges a minimum quantum per transition so
many tiny or empty runs cannot monopolize a callback. Compiled plans are cached for the captured
font within the job. The diagnostic explicitly selects `Latn/latn`, `Grek/grek`, `Hebr/hebr` and
otherwise `DFLT`, using supplied `liga`/`test` features and legacy kerning. It displays script runs,
grapheme clusters and feature totals. This is a fixture policy, not a general script-tag or
language resolver. Direction remains the supplied positioning default. The host expires work
on local source/style/active-font changes and removes all listeners/timers/cursors on disposal.
Its lifecycle is still separate from the editor's full resource/document/tab ownership.

An original rectangle font assigns the same nominal glyph to Latin, Greek and Hebrew letters,
then gives each script a conflicting feature. A deliberately wrong whole-run default feature
can form a cross-script ligature. Tests prove that owned script partitions select distinct
features and preserve source spans. Eight native width controls per engine retain every result:
Chromium/Firefox match all eight; WebKit retains two single-character context differences.
These observations do not certify complete script, bidi, ink or caret geometry. Tests also cover
all 65 bracket pairs in outer/leading contexts, 172 represented scripts and 1,044 extension
contexts, raw surrogates, foreign marks, deep malformed stacks, selected ranges and every private
cancellation phase. The restored NuGet consumer executes the compiled partition/slice/feature path.

`npm run bench:scripts` retains nine conditions, three warmups and twenty measurements, including
200,000 ASCII points, 180,000 points with nested scripts, a 90,000-mark sequence, shared-script
intersections, deep malformed brackets, 150,000 glyph partitions, a 30,000-run feature pipeline
and resolve/publication cancellation. Raw call clocks/work deltas and maximum-call ending phases
are retained. The CPU pipeline consumes positions into totals; it does not retain a complete
renderer layout. Source construction, explicit normalization, nominal mapping and compiled plans
precede these clocks. `--verify` checks every condition once with clocks disabled and emits no
measurement report. Browser cases separately exercise scheduled feature dispatch alongside real
native typing and active font replacement. Heap observations do not establish stabilized retained
or peak memory limits.

[Font-aware canonical selection](font-normalization.md) now supplies captured closed font cascades.
System discovery, full script/language-specific masks/reordering, variable metrics/outlines,
certified source/cluster/ink/caret geometry, combined workspace capture, cooperative compilation,
exact bounded rendering/visual navigation and native-device input remain required. No complete
font backend, third-party runtime, worker or WASM is selected. See [Unicode layout text](unicode-shaping.md),
[substitution](substitution-cursor.md) and [positioning](position-cursor.md).
