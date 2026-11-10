# StTropez

A standalone TypeScript foundation for a browser workspace combining source editing,
structured configuration, review and data operations. Production code has **zero
third-party dependencies**. React, editor libraries and compiler runtimes are not
required by the package.

This is an early scaffold. It contains headless text and typed resource lifecycles,
revision-checked edits, scoped observables, ownership leases, save receipts and captured Run
ports. The playground mounts two native text views and an independent typed configuration form,
with synthetic deferred saves and an explicit preview command.
The plain and React development hosts add exclusive agent requests, human correction, exact
save/acknowledgement receipts and retry, stable refs and controller-preserving error recovery.
Try the [integrated editor/review pilot](docs/m3-pilot.md#try-the-integrated-pilot) for direct
host links and a walkthrough of editing, comparison, captured saves, conflicts and remount.
Documents use an immutable indexed piece tree, bounded shared undo/redo, mapped view selections,
atomic multi-document edits and explicit newline conversion. The textarea remains an input and
instrumentation baseline. A bounded viewport and experimental bounded-input candidate provide
local glyph coordinates and document/history editing. Literal find/replace and a host-owned
worker fixture add incremental visible highlighting, completion and scoped diagnostics.
Full contextual-line geometry, language-protocol support and recovery
remain roadmap work.

## Run

Requires Node.js 24 or newer.

```sh
npm ci
npm run browsers:install
npm run dev
```

Open `http://127.0.0.1:4173`. The playground uses synthetic data and makes no application
service requests. The development server binds to loopback only.
It serves the last completed build while source watching compiles updates. Reload after a build
finishes to use those updates; asset requests do not start compilation or delay worker startup.
An unsuccessful build returns a development error until the source is corrected.
Browser qualification uses up to four workers and a 30-minute suite limit; individual test and
assertion limits are separate. Pass `--workers=1` to Playwright for a serial focused control.

```sh
npm run check          # Type checking, model tests, build, Chromium tests
npm run test:browsers  # Chromium, Firefox and WebKit
npm run inspect        # Screenshot and machine-readable state
npm run bench          # Browser timing samples and machine metadata
npm run bench:trace    # Separate layout/paint attribution diagnostic
npm run bench:storage  # Flat/chunk/piece comparison, separate from browser timing
npm run bench:viewport # Bounded read-only rendering and programmatic edits
npm run bench:editing  # Actual keyboard input through the bounded candidate
npm run bench:services # Piece search, atomic replacement and a real worker result
npm run bench:bulk     # Isolated multi-range construction and traversal
npm run test:package   # Local NuGet pack, isolated restore and browser edit (.NET SDK 10+)
```

Generated evidence is in `artifacts/`; failed browser tests also retain traces in
`test-results/`. Missing browsers, missing readiness, page errors and missing tests
cause failures. Separate benchmarks cover the native-input baseline, bounded viewport and
experimental input candidate. Their frame timing is a scheduling proxy, not measured physical paint.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/core` | Documents, resource keys, tab lifetimes, transactions; no DOM |
| `src/browser` | Explicitly mounted and disposed browser views |
| `examples/playground` | Synthetic mixed-surface host and development-only agent hooks |
| `experiments` | Development storage comparisons; excluded from the runtime and package |
| `tests` | Model invariants and real browser interactions |
| `scripts` | Build, local server, screenshots and benchmark runner |
| `docs` | Architecture, integration boundaries and performance guidance |
| `external` | Ignored reference checkouts; not part of build or package |

`npm run build` emits ESM, declaration files and CSS to `dist/`, checks that the runtime
dependency graph contains only `src/`, and records compressed JavaScript sizes. The
package allowlist contains only `dist/`. The package is private until release metadata
and a license are deliberately selected.

The preferred distribution is a NuGet package containing the browser assets and MSBuild
integration files. `npm run pack:nuget` builds a local evaluation package under
`artifacts/nuget/feed/`. No package is published. `npm run test:package` checks its actual
contents and restores an isolated consumer with an explicit frontend resolution bridge.
See [packaging](docs/packaging.md) for the artifact and consumer build contract.
The development hosts are `/hosts/plain/` and `/hosts/react/`; their
[adapter contract](docs/host-adapter.md) and [agent protocol](docs/agent-review.md) describe the
synthetic fixtures and the consuming host's remaining integration responsibilities.

The [acceptance inventory](docs/acceptance.md) defines pilot/replacement workflows, workload
sizes and the proposed input matrix. `/probes/` on the development server
compares native input candidates and exercises highlighting, completion and diagnostics
through a real development worker. These experiments do not select or qualify a production
renderer or language client; native IME checks remain pending.

See [the architecture](docs/architecture.md), [performance assessment](docs/performance.md), and
[instrumentation guide](docs/instrumentation.md). [Text storage](docs/text-storage.md) records
the measured storage choice and mapping/newline contracts. The local roadmap is `PLAN.md`.
See [document history and view lifetime](docs/history.md) for transaction, grouping and undo policy.
The [viewport layer](docs/viewport.md) and `/viewport/` fixture record bounded-rendering evidence.
The [editing candidate](docs/editing-candidate.md) and `/editing/` fixture exercise bounded native
context, measured pointer selection, shared history and composition guards. Long contextual-line
layout and native-device input remain qualification gates.
The [find controller](docs/search.md) and [provider/presentation fixture](docs/providers.md)
add revision-checked workflows to that view, with explicit scope and scheduling limits.
The [comparison controller](docs/comparison.md) and `/comparison/` fixture add an immutable
baseline, editable working side, undoable hunk reversion and captured refresh/acceptance.
The [host workflows](docs/host-workflows.md) run proposal/correction/save/acknowledgement and
captured Run through both editor modes in the plain and React hosts, including input recovery.
The [bidi resolver and caret geometry](docs/bidi.md) combine Unicode conformance tests with
native shaping on complete bounded rows; contextual long-line layout remains open.
The [Unicode layout stage](docs/unicode-shaping.md) supplies versioned normalization with exact
source provenance and cooperative nominal mapping into the glyph substitution/positioning pipeline.
The [script stage](docs/script-itemization.md) resolves contextual runs and partitions owned glyphs
for independent feature selection without copying their records, preserving complete
[Unicode 18 graphemes](docs/graphemes.md). The editing candidate indexes long logical lines
cooperatively for whole-cluster commands.
The [font-aware stage](docs/font-normalization.md) selects canonical representations and complete
graphemes from a captured host font cascade, preserving original spans and variation pairs.
Nominal coverage and explicit fixture feature dispatch do not qualify complete language shaping.
The [glyph visibility stage](docs/glyph-visibility.md) carries control properties through
substitution and suppresses uninterpreted default-ignorable ink and advances during positioning.
