# StTropez

A standalone TypeScript foundation for a browser workspace combining source editing,
structured configuration, review and data operations. Production code has **zero
third-party dependencies**. React, editor libraries and compiler runtimes are not
required by the package.

Try the [browser-only TypeScript demo](https://lokad.github.io/StTropez/). Editing, language
tools, comparison and browser-local saving run without a backend. The [static demo build](docs/demo-static.md)
uses the normal compiled library assets and keeps compiler/provider code in the example.

The M3 editor/review pilot supports actual typing, selection/navigation, shared undo/redo,
comparison and hunk reversion, captured saves/conflicts, recovery and explicit host lifecycle.
The plain and React development hosts combine these with typed configuration, synthetic
deferred services and captured Run/agent decisions through stable controllers and refs.
Try the [integrated editor/review pilot](docs/m3-pilot.md#try-the-integrated-pilot) for direct
host links and a walkthrough of editing, comparison, captured saves, conflicts and remount.
Documents use an immutable indexed piece tree, bounded shared undo/redo, mapped view selections,
atomic multi-document edits and explicit newline conversion. The bounded input adapter and
viewport provide editing and measured local caret geometry; the native textarea remains a
control. Literal find/replace and the public LSP route support host integration. The separate
worker protocol is an internal fixture. Native IME, OS clipboard and physical-display checks
remain unverified; full contextual long-line geometry and production adoption remain scoped
qualification gaps.

The [LSP provider route](docs/m3-pilot.md#try-the-lsp-provider-route) adds actual captured protocol
workflows and explicit command/server-edit decisions. [Qualification limits](docs/m3-pilot.md#qualification-scope)
keep native, performance and adoption claims scoped.

## Run

Requires Node.js 24 or newer.

```sh
npm ci
npm run demo
```

Open `http://127.0.0.1:4173` for the TypeScript editor demo. Edit the shopping cart, switch to
`pricing.ts`, inspect generated JavaScript, find/replace text, compare changes and save locally.
Save locally stores all files of that sample in this browser; another page's saved copy is
protected by a version check. Samples retain their edits while you switch between them.
Reset restores the sample through undoable edits. After a short pause, a recovery draft captures
the committed contents of all changed files. On reload, explicitly restore or download that draft,
or keep the current files. Restore is one undoable operation and expires if the files change
while it is pending. Recovery status shows when the captured draft is stored; the latest keystrokes
can still be pending, and abrupt browser termination is not a guarantee of recovery.
Unsaved work prompts before leaving the page. If another page saves the same sample,
review its saved copy before explicitly saving your version, or download your local changes.
TypeScript 5.9.3 runs in a development worker for syntax colors and JavaScript emission.
A local TypeScript language server supplies live type checking and contextual language tools.
Open Problems to select an error, use Ctrl+Space for completion, or hover over a symbol for its
type. Signature help follows function arguments; Ctrl+Shift+Space requests it explicitly.
F12 follows a definition, Shift+F12 lists references, and F2 previews a rename. Rename the
function at its definition to update both files; imported aliases can have a local rename.
The Code menu exposes these commands. Enter or a click accepts a resolved completion; Escape
dismisses popups. Provider failure leaves editing and saves available, with a separate retry action.
Use Ctrl+. or Code → Quick fix to review a provider fix before applying it. The spelling fix
for a mistyped known name is supported and undoable. See the [demo language integration](docs/demo-language.md) for its
supported subset and ownership. [Demo qualification](docs/demo-qualification.md) records the
restored-package workflow, integrated normal/100k measurements and remaining device checks.
The server binds to loopback only and does not open a browser window.

`npm run dev` is an alias for the same server. The older mixed-surface workspace fixture is
at `/workspace/`; the technical host/editor routes remain available for qualification.
Install the test browsers with `npm run browsers:install` before running browser checks.
It serves the last completed build while source watching compiles updates. Reload after a build
finishes to use those updates; asset requests do not start compilation or delay worker startup.
An unsuccessful build returns a development error until the source is corrected.
Browser qualification uses up to four workers and a 30-minute suite limit; individual test and
assertion limits are separate. Pass `--workers=1` to Playwright for a serial focused control.

```sh
npm run check          # Type checking, model tests, build, Chromium tests
npm run test:ci        # Representative Chromium owner journeys used in CI
npm run test:browsers  # Chromium, Firefox and WebKit
npm run inspect        # Screenshot and machine-readable state
npm run bench          # Representative model and bounded-editor timing samples
npm run bench:pilot    # Explicit integrated input/review/save measurements
npm run bench:all      # Explicit broader performance inventory
npm run bench:trace    # Separate layout/paint attribution diagnostic
npm run bench:storage  # Flat/chunk/piece comparison, separate from browser timing
npm run bench:viewport # Bounded read-only rendering and programmatic edits
npm run bench:editing  # Actual keyboard input through the bounded candidate
npm run bench:services # Piece search, atomic replacement and a real worker result
npm run bench:bulk     # Isolated multi-range construction and traversal
npm run test:package   # One pack/restore, then full, LSP and React consumers (.NET SDK 10+)
```

Generated evidence is in `artifacts/`; failed browser tests also retain traces in
`test-results/`. Missing browsers, missing readiness, uncaught page errors, `console.error`
and missing tests cause failures. Browser specs use the shared automatic context guard in
`tests/browser/fixtures.ts`; it includes secondary tabs. Standalone restored-demo journeys use
the same error policy. An injected network failure may permit one exact console diagnostic
for its URL; other errors fail. [Qualification ownership](docs/qualification.md) separates focused changes,
broad boundaries and performance runs. Input-handler time, frame readiness and complete
scripted action latency are different clocks; none establishes physical input/display latency.
See [runtime ownership](docs/editor-ownership.md) for composition, caret and delayed work.

Pushes to the main branches and pull requests run all model tests, strict type checking,
the library build, `test:ci` and the Chromium static-demo suite. Pages publishes the same
qualified static output from main-branch runs. Multi-engine and package qualification stay
explicit checkpoint commands. Set `STTROPEZ_PORT` for development/browser tests and
`STTROPEZ_DEMO_PORT` for static preview/demo tests when their default ports (4173/4174)
are occupied; both the launcher and test configuration use those environment values.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/core` | Documents, resource keys, tab lifetimes, transactions; no DOM |
| `src/browser` | Explicitly mounted and disposed browser views |
| `examples/demo` | TypeScript editor demo and development-only compiler worker |
| `examples/playground` | Technical mixed-surface workspace fixture at `/workspace/` |
| `experiments` | Development storage comparisons; excluded from the runtime and package |
| `tests` | Model invariants and real browser interactions |
| `scripts` | Build, local server, screenshots and benchmark runner |
| `docs` | Architecture, integration boundaries and performance guidance |
| `external` | Ignored reference checkouts; not part of build or package |

`npm run build` emits ESM, declaration files and CSS to `dist/`, checks that the runtime
dependency graph contains only `src/`, and records compressed JavaScript sizes. The
package allowlist contains only `dist/`. StTropez is released under the MIT license
(`LICENSE.txt`). The package stays private until release metadata is deliberately selected.

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
The optional [LSP protocol layer](docs/lsp.md) supplies JSON-RPC/WebSocket transport, captured
sessions and shared Workspace provider ownership, validated [diagnostic/completion](docs/lsp-editor.md), [hover/navigation](docs/lsp-navigation.md)
and [rename/workspace-text-edit](docs/lsp-rename.md) host adapters, plus
[code-action choices and resolve](docs/lsp-code-actions.md) and
[workspace commands with server-edit decisions](docs/lsp-server-edits.md), plus
[signature help, resolvable links and color presentations](docs/lsp-language.md).
Its supported-subset matrix states the remaining protocol boundaries.
The [public integration APIs](docs/lsp-integration.md) serve both hosts and an isolated consumer;
`npm run test:package:lsp` qualifies that minimal restored-package boundary.
The [find controller](docs/search.md) and [provider/presentation fixture](docs/providers.md)
add revision-checked workflows to that view, with explicit scope and scheduling limits.
The [comparison controller](docs/comparison.md) and `/comparison/` fixture add an immutable
baseline, editable working side, undoable hunk reversion and captured refresh/acceptance.
The [host workflows](docs/host-workflows.md) run proposal/correction/save/acknowledgement and
captured Run through both editor modes in the plain and React hosts, including input recovery.
The [bidi resolver and caret geometry](docs/bidi.md) combine Unicode conformance tests with
native shaping on complete bounded rows; contextual long-line layout remains open.
The editor preserves [Unicode 18 graphemes](docs/graphemes.md) and cooperatively indexes long
logical lines for whole-cluster commands. [Native font registration](docs/fonts.md) owns loaded
faces and generations; text shaping and measurement use browser APIs.
