# Native paragraph shaping experiment

`/shaping/` is a development oracle for the remaining long-line layout work. It compares native
HTML ranges in a complete unwrapped paragraph with independently shaped fragments and canvas
prefix widths. It deliberately retains all paragraph text in the DOM. Its initial layout and
one-unit native replacement can perform paragraph-sized synchronous work. The experiment lives
in `experiments/native-shaping.ts`, outside the production source graph and compiled assets.

The project already has native row geometry, a cooperative bidi index and captured resource
lifecycles. Those remain the reusable foundations. It has no exact global font-advance index.
The experiment uses browser APIs to establish reference observations and measure candidate
costs before choosing that implementation. No font engine, runtime dependency, worker or WASM
has been introduced. A fast bidi kernel does not establish font-shaping performance.

The primary references are [CSS boundary shaping](https://www.w3.org/TR/css-text-3/#boundary-shaping)
and the [canvas text preparation algorithm](https://html.spec.whatwg.org/multipage/canvas.html#text-preparation-algorithm).
Formatting boundaries can affect shaping; an arbitrary fragment does not acquire the omitted
context. Canvas normalizes ASCII whitespace, so its tab measurement differs from preserved
HTML tab stops. A complete prefix width also need not be the origin of a fragment shaped in
the original paragraph: kerning, joining, ligatures and bidi order matter.

The browser fixtures reproduce these disagreements for kerning, Arabic joining, tabs, a
2,048-mark Arabic sequence and a distant directional override. The long mark sequence defeats
512 units of context on the declared Windows/browser matrix. Full-context comparisons include
proportional italic text, ligatures, combining marks, emoji and distant isolates. Comparisons
stay within one engine and font; they do not require identical glyph metrics across engines.

Raw range boxes are not certified caret positions or per-glyph advances. Ligatures and controls
can expose zero-width or overlapping native boxes, and very large native coordinates can
saturate. Whole-context identity checks prove that the probe reproduces those observations,
not that every native range is a suitable editor coordinate. Full bidi context, grapheme and
shaping-cluster mappings, tab positions and coordinate scaling still need explicit treatment.

The probe reconstructs its canvas font from computed style, weight, pixel size and family.
A computed `font` shorthand may be empty; silently accepting it would retain canvas's default
font and invalidate comparisons. The fixtures check the effective font size and a small
whole-width comparison. Normal stretch and capitals are required. Unsupported canvas ligature
controls and letter-spacing support remain visible in metadata. The oracle releases its text
and DOM on disposal, rejects stale native replacements and changes no surrounding selection
or input. It is a synchronous measurement tool, not a scheduled editing engine.

`npm run bench:shaping` runs Chromium, Firefox and WebKit sequentially. Each engine measures
eight conditions with three warmups and twenty retained samples: kerning, tabs, transparent
marks, a distant override, 10,000/200,000/2,400,000-unit LTR paragraphs and a 200,000-unit mixed
paragraph. Source generation precedes the kernel clock. The report separates DOM preparation,
initial native layout, canvas measurement, sparse complete-context queries, prefix measurement,
native replacement/readback and its subsequent layout. The synchronous batch and next-frame
proxy are also recorded. Replacement/readback handles full native text; it does not measure
the indexed model or claim zero exports. DOM text-unit counters expose proportional retention
even when the complete paragraph occupies only one text node.

Raw samples, computed fonts, effective canvas settings, viewport, browser versions, machine
metadata and source hashes are retained in `artifacts/bench/shaping/latest.json`. Warm native
measurements are diagnostic; the next-frame value is not physical presentation, and text-unit
counts are not heap-byte or long-session memory budgets. `npm run inspect` captures the visible
comparison. The ordinary viewport still reports partial rows, fragment shaping, estimated
global origins and logical long-row navigation. Exact retained advances, global shaping,
renderer integration and production/native-device qualification remain open.

The [retained advance index](advances.md) now exercises copied native range-left observations
after probe disposal, including negative deltas from bidi text and multiple rectangles from
emoji. It retains raw rectangles and captured probe generation/revision. This establishes
storage/query behavior; the sparse observations do not complete shaping, ink/caret mappings
or bounded long-line rendering.

[Owned font data and native assets](fonts.md) now provide copied SFNT mappings/nominal metrics
and explicit load generations. The original fixture retains kerning and ligatures to show why
those nominal metrics cannot replace full-context shaping. Native variation and malformed-font
acceptance differences remain recorded qualification gaps.

The [glyph substitution stage](substitution.md) now compares original font programs with native
widths, retaining single-character and mixed-context differences and their matching controls.
It preserves source components through actual ligatures. Positioning, complete script shaping,
ink/carets, cooperative scheduling and renderer consumption remain open.

The separate [horizontal positioning stage](positioning.md) reuses owned GSUB provenance,
implements explicit GPOS/legacy policies and publishes retained signed pen advances.
