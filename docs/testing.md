# Testing

StTropez qualifies model behavior, browser interaction, host integration and distributed assets
at their respective owners. Focused regressions cover changed guarantees; coherent milestones
combine the affected browser, package and measurement checks. Evidence records its source and
scope, and device qualification is separate from automation.

## Use

Install the locked development dependencies and the browser binaries required by the selected
checks. Use explicit files for a focused model or browser regression:

```sh
npm ci
npm run browsers:install
node --test tests/input-context.test.ts tests/input-target.test.ts
npm run test:browsers -- --project=chromium --project=firefox --project=webkit tests/browser/input-target.spec.ts
```

Select the commands relevant to the changed owner:

| Command | Scope |
| --- | --- |
| `npm run typecheck` | Strict project types plus headless core/protocol compilations |
| `npm run check:docs` | Subject-page structure, repository links/anchors, public value ownership, prose and independently compiled TypeScript examples |
| `npm test` | Headless model and host-policy tests |
| `npm run test:browser` | Source browser suite in Chromium |
| `npm run test:browsers` | Source browser suite in Chromium, Firefox and WebKit; explicit paths/projects narrow it |
| `npm run test:ci` | Selected Chromium owner journeys defined in `playwright.ci.config.ts` |
| `npm run check` | Types, documentation gate, models, library build and source Chromium suite |
| `npm run inspect` | Headless behavioral/screenshots inspection with state metadata |
| `npm run build:demo` then `npm run test:demo` | Built static demo in the configured engines |
| `npm run test:package` | One packed/restored asset set across selected consuming hosts |
| `npm run bench` | Seeded model work and actual bounded-editor keyboard insertion |
| `npm run bench:pilot` | Integrated input, comparison and save/conflict workloads |
| `npm run bench:all` | Explicit larger measurement inventory |

Browser configurations own their servers and expose `STTROPEZ_PORT` or `STTROPEZ_DEMO_PORT`
for source/static routes. The static-demo configuration can target a supplied
`STTROPEZ_DEMO_URL`. Keep a test server separate from an interactive demo session.

The CI workflow runs types, the documentation gate, models, library build, the selected
Chromium gate and the static-demo Chromium journey. A passing CI run has that scope;
full multi-engine and package qualification use their separate commands.

## Contract

### Documentation gate

`scripts/check-docs.mjs` checks the subject-page inventory and the root, package and contributor
entry documents. Relative Markdown links, image links and reference definitions must resolve
to non-ignored repository files or directories. Heading anchors use rendered text and duplicate
heading suffixes; explicit HTML anchors and source-line links are supported. Other raw HTML is
refused so embedded URLs cannot bypass the link checks. External URLs are not fetched. Paths
inside inline code, including installed asset examples, are not repository links.

The gate enumerates runtime exports from the public core, browser and protocol entries without
executing them. TypeScript resolves each public name to its declaring module; the ownership map
in `scripts/documentation-audit.mjs` selects its subject page. That page must name the value in
its `Contract` prose, including inline code. A fenced example, private declaration name or comment
does not satisfy ownership. Type-only exports have no runtime-value obligation.

API pages require the `Use`, `Contract`, `Host responsibilities` and `Not covered` sections,
a TypeScript example and a support-matrix link. Every `ts`, `typescript` or `tsx` fence in the
checked documents compiles independently against the public entries; imports of private source
files or other packages are refused. Diagnostics identify the authored Markdown file and line.
Development-only Markdown and heading parsers handle nested examples and formatted headings.

The prose check rejects historical vocabulary, milestone labels, dated delivery notes, commit
references and pass-count narratives. Code keeps real API names and commands. Contributor
instructions are exempt from the prose rule because they describe repository policy; their
links and examples are checked. Review must also verify contract accuracy and useful explanations:
mention coverage and compilation cannot establish either, and the vocabulary rule cannot identify
every historical narrative or measured-run claim.

### Test ownership

Use deterministic models for data/guard combinations and browser tests for native event,
geometry, presentation and lifecycle behavior. An installed-consumer test owns distribution
and integration, rather than repeating every source-model permutation.

| Guarantee | Deterministic owner | Browser or distribution owner |
| --- | --- | --- |
| Text, UTF-16 maps, newline conversion and complete selections | Buffer, positions, UTF-16 ranges and selections models | Editing, raw-CRLF caret and multiple-input journeys |
| Atomic revisions, shared history and detached views | Workspace, history/history-bounds and resources models | Workspace, editing and host lifecycle journeys |
| Save/conflict, canonical replies and agent decisions | Save-review, host-save-conflict/failure and agent models | Save/conflict, composition and complete host journeys |
| Immutable reference, exact hunks and review lifetime | Comparison, comparison rows/scroll/scheduling models | Comparison ownership, lifecycle, reference input/find and aligned-pane journeys |
| Demo recovery and syntax classification | Demo-recovery, demo-syntax and demo-syntax-colors models | Real storage/reload/failure, file/sample switching, save and visible-color journeys |
| Positional LSP captures and invalid responses | LSP clients, workspace, workspace edits and protocol feature models | Focused hover/navigation/rename/action and input/synchronization journeys |
| Wire negotiation, selectors, provider sharing and command ownership | JSON-RPC, protocol session/selector/fixture models | WebSocket/interoperability journeys and the minimal restored LSP consumer |
| Native projection and composition recovery | Input-context and input-target models | Input-target, ordered-input and composition journeys |
| Caret, bidi/grapheme boundaries, scroll, focus and drag | Geometry-independent and Unicode models | Viewport/geometry/paint, zoom, bidi/grapheme, pointer/drag and shadow-focus suites |
| Host conversion, source annotations and forms | Table-paste, text-transfer and domain policy models | Table-paste, domain and transfer/form journeys |
| Framework mount/disposal and surrounding UI | Host controller/policy models | Plain/React attachment, Strict Mode, queued-work disposal and error recovery |
| Font registration lifetime | Native browser decoder | Font registration/measurement/release owner and a restored-consumer check |
| Compiled assets and installation | Manifest/hash/dependency/export checks | Full restored consumer, version transitions and selected LSP/React/demo routes |

The named source owners live under `tests/` and `tests/browser/`; package journeys live in
`scripts/package-*.mjs` and their consuming fixtures. Select the owning test file when adding
or changing a case. Keep small browser integration checks where model behavior crosses into
input or UI. Add cross-engine dimensions where engine behavior matters. Do not multiply the
same invariant across every host, corpus and distribution route without a distinct purpose.

### Behavioral coverage

An integration qualification asserts the resulting state, not only that an action completed.
Use the owning [API contracts](README.md#subjects) to define expected behavior:

| Area | Required observations |
| --- | --- |
| Resource identity and loading | Equal labels in different scopes/variants stay distinct; deferred load/confirmation/save resolves its captured target through move, replacement and closure; pending work retains resources and failed loading recovers |
| Publication and views | Scoped subscribers preserve unchanged identity; listener failures and rejected reentrant writes preserve committed state; two views and typed forms keep independent selections through remount and error recovery |
| Transactions and authority | Invalid/stale multi-resource batches publish nothing; each edit origin obeys capabilities/locks; shared undo/redo restores complete selections and the saved baseline without losing later corrections |
| Editing and navigation | Actual keyboard typing, deletion, arrows/word/line/page/grapheme movement, indentation/comments, pairs, newline, multiple selections, regex/case/whole-word find/replace, clipboard/drag paths and focus escape yield exact text and selection |
| Unicode and geometry | Surrogates, combining sequences, emoji/joiners, CRLF, bidi affinities, zoom and fonts preserve source and expected caret/hit targets within the supported geometry contract |
| Save and Run | Queued/captured saves preserve submitted content, server preconditions, retry/canonical/conflict behavior and dirty state while typing continues; Save and Run retain separate source/settings captures |
| Agent review | Request, proposal, correction, interruption, save and acknowledgement-only retry retain their captured versions; an older saved proposal cannot retire a newer one |
| Comparison | Reference, saved and proposal versions stay distinct; refresh/accept/revert/discard and hunk navigation handle stale decisions, whitespace, edits, delayed loads and takeover without losing history/corrections; both panes show their own source/color/fold state |
| Language features | Visible token classes, completion edits, diagnostics, hover/signatures, navigation, rename/actions, links/colors and explicit command decisions use validated captures; editing works during provider outage |
| Protocol | Initialization/capabilities, dynamic registration, incremental sync, cancellation, diagnostics, server edits, custom messages and reconnect exercise the declared actual transport; internal worker replies do not establish LSP compatibility |
| Host extensions and structured surfaces | Domain folds/notes, structured table paste and imports use captured selections and intended undo units; independent source/settings/run-log resources preserve authority; source-backed forms preserve invalid text, unknown fields and anchors through edit/fold/undo/resize/virtualization; progress invokes neither Save nor Run |
| Recovery and lifecycle | Explicit draft restoration preserves loaded save authority; remount/input-route switches retain view/document state; close/replace/dispose during work releases owned views/listeners/jobs/leases without discarding retained unsaved input; previous-session undo is not implied |
| Large documents and background work | Beginning/middle/end edits and navigation, vertical/horizontal scroll, bulk changes, many inactive documents and concurrent progress preserve exact results with bounded native input/DOM/routine reads |
| Responsiveness and retention | Source/hardware-labelled samples include semantic guards, complete required presentation and raw clocks; repeated mount/dispose checks define the released owner and actual memory scope |
| Distribution | Isolated restore resolves modules and declarations, loads styles/workers and performs actual editing; upgrade/downgrade/stage reuse preserves coherent assets and excludes checkout/private implementation fallback |
| Optional acceleration | Any introduced accelerator proves its actual execution path, equivalent results, cancellation and startup/failure behavior including transfer/allocation costs |

The generic protocol fixture qualifies the [declared LSP subset](language-server.md) without
requiring a production language provider. Compatibility with a consuming host's provider is
a separate integration exercise. Native cases use the checklist below and the support matrix.

### Fixtures and test hooks

Development hooks expose controlled state and actions for assertions. They are not global
APIs of the distributed library. Keep text-bearing reads explicit and routine snapshots
limited to identities, revisions, activity and bounded counters.

| Hook | Fixture purpose |
| --- | --- |
| `window.sttropez` | Workspace setup/readiness, document/tab metadata and synthetic corpora |
| `window.editingFixture` | Editor/view state, bounded input/viewport activity, explicit source ranges and disposal |
| `window.comparisonFixture` | Reference/working captures, hunk ranges, tickets and view lifetime |
| `window.hostFixture` | Plain/React resources, deferred service decisions, recovery metadata, view attachment and disposal |

Inspection uses an isolated loopback server and headless Chromium and checks semantic results
before recording screenshots/state. Screenshots help review rendering; exact text, selection,
revision and ownership assertions establish behavior. Include both mounted views and any
comparison or host surfaces affected by the action.

Use `tests/helpers/browser-errors.ts` for context-wide error collection, including secondary
pages. Unexpected console errors and uncaught page errors fail its assertion. Fault injection
can allow one exact console message at its source URL; it cannot suppress other errors.
Browser configurations use no retries, reject focused-only tests and retain failure traces.
Missing browser binaries, missing readiness and empty test selection are failures, not passes.

### Readiness and visible continuity

`examples/shared/readiness.ts` owns fixture-only settlement helpers:

- `viewportSettled` checks a live, nonpending presentation against the view's revision,
  complete selection-set identity and fold generation.
- `editorSettled` additionally checks pending input, commands, caret, word/grapheme and drag-scroll
  work. It does not treat an active composition session or provider request as pending editor work.
- `comparisonSettled` requires a ready controller, settled alignment/scroll and both editors;
  aligned rows must share the same alignment identity. Alignment failure throws.

Those checks describe editor work. Add exact expected text/revision/selection checks and the
provider, decoration, saved/reference-version or host-service conditions required by the
particular interaction. Handle terminal failures explicitly. A fixed delay or one idle/frame
flag cannot replace those conditions. Preserve the full selection set where multiple ranges
or backward/affinity state is part of the guarantee.

For visible continuity, sample the required text and decorations throughout scrolling/editing,
not only after final settlement. Drag the scrollbar as well as using wheel/key routes; exercise
middle-of-document edits and both comparison panes. A painted gutter does not prove source
text is visible, and eventual syntax recovery does not prove the absence of a color flash.
Require the selected provider/worker path when that path is under test; a fallback cannot make
its test pass. Keep editor-frame, service-ready and whole-action observations distinct.

Poll cheap activity/snapshot handles. Buffer read counters support bounded-work checks;
full tree diagnostics or retained-structure traversal belong outside readiness polling and
input subscribers. See [text-model diagnostics](text-model.md#conservative-change-spans-and-diagnostics).

### Workloads

`fixtures/workloads.ts` owns locally generated deterministic corpora and seeded edit logs.
Model replay deliberately uses raw UTF-16 offsets, including surrogate interiors; browser
navigation applies the editor's grapheme/geometry rules instead.

| Corpus | Shape |
| --- | --- |
| `normal` | Small synthetic source |
| `lines-100`, `lines-10000`, `lines-100000` | Repeated 24-unit source line: 2,400 / 240,000 / 2,400,000 UTF-16 units |
| `single-line` | 2,400,000 ASCII units with no newline |
| `unicode` | Tabs, combining marks, emoji/joiners, RTL, CRLF and LF |
| Workspace combinations | 1/10/100 resources, 1/2 active views, annotations and background updates |

Vary line count independently from text length and token density. Include cold open, sustained
input, large paste/delete, search, fold, comparison, rapid tab switch and repeated disposal.
A completed corpus or correctness journey does not establish a production size or latency budget.
The [architecture constraints](architecture.md#performance-invariants-and-cost-boundaries) identify
bounded work and operations that can retain proportional/global costs.

### Measurement policy

Source browser benchmarks use a fixed development bundle with the compiler watcher disposed
before browser launch (`buildMode: development-bundle-no-watch`). The shared harness starts
on `about:blank`; each caller navigates directly to its fixture and owns readiness and deliberate
warm-up. This mode is distinct from the watched interactive server and restored-package or
static-demo builds. Historical reports retain their original build conditions.

Host input/reference benchmarks share `scripts/host-reference-probe.mjs` and the Node-side
driver in `scripts/host-edit-measurement.mjs`. They observe actual Enter commands and native
text input with the distinct [clock definitions](README.md#glossary).
Inapplicable command/input clocks are null. Full review readiness includes pending input and
commands, working/reference views, caret/scans and comparison settlement over two frames.
Exact text, transaction counts and undo/redo are checked independently of inserted UTF-16 units.
The probe retains partial observations on failure. Its `isReady` predicate composes the same
live-owner `settled` checks used by browser specs, plus the expected working views, source
revision and displayed reference version. Folding, navigation, table-paste and language
measurements also use this predicate; provider and host-service gates remain operation-specific.
Complete selection sets, fold generations, reference input, alignment and scroll must settle;
phase render observations remain narrower. Terminal alignment failure rejects the wait.
Generic host and save/conflict workflows use `isSourceReady`/`waitSourceReady` before review
is mounted and with native textarea source views. They require two settled source views and,
when present, the complete settled comparison and displayed reference version. Native source
metrics are null; they do not satisfy the full `isReady` predicate. Conflict input points
require a review, capture `beforeinput` on the intended input, and check exact revision, text and
selection over two frames. Missing origins and terminal failures reject with listener/frame cleanup.
Reference, pointer, drag-scroll, word-selection, generic host and save/conflict measurements
share `scripts/host-scene.mjs` for mounting, readiness, disposal counters and complete
source/reference text checks. Its `sourceReady` permits native source views and optional
review; `ready` requires editor metrics and a complete review. A disposal observer can close the
caller-owned automation clock after fixture disposal and before teardown diagnostics. Text
checks compare lengths and raw UTF-16 chunks outside point and gesture clocks. Combined
workflow proxies can include intermediate checks. Each caller retains its review preparation,
captured identities, gesture release and operation-specific assertions.
The standalone installed consumer stages the same fixture helper with public package imports;
its strict consumer compile and isolation checks exclude library source.

Input/reference, folding and table-paste reports use `scripts/benchmark-report.mjs`: each variant retains a unique run under
`artifacts/bench/<benchmark>/<variant>/runs/`; only a successful run updates that variant's
`latest.json`. Smoke, full and retention-check results stay separate, as do raw warmups and
measured observations. Failed runs retain completed samples and the active partial observation.

The [glossary](README.md#glossary) owns clock definitions. Record exact start/end events and
included work for each metric; preserve those definitions when comparing results. In particular,
an adapter handler, capture-to-bubble observation, cooperative advance, editor-frame readiness,
provider completion and complete automated action are different spans. None is process CPU time.
Nested trace intervals and inclusive profile weights cannot be added as independent phases.

Validate operation success and expected provider paths before accepting timing samples. Assert
exact text, revisions, selections/history and applicable no-export, bounded-DOM/cache and
unchanged-resource delivery constraints. Bulk planning may yield while final assembly or an
atomic transaction is synchronous; report the longest uninterrupted work separately from total
settlement. Controlled service delays belong in workflow results.

Record source/dirty-state identity, lockfile, corpus/seed, build mode, browser/OS/hardware,
viewport/font, power/load conditions and raw samples. Separate cold/warm and baseline/editor
paths. Alternate conditions on the same machine and repeat independent runs before making a
regression claim. Detailed traces are separate diagnostics because they change the workload.
Unsupported metrics are absent, not zero. A correctness timeout is not a latency threshold.

Use the shared distribution helper in `scripts/measurement.mjs`. It reports count and observed
maximum with nearest-rank percentiles; batches below 20 label their summary as a maximum.
Small samples do not establish production tails. Set absolute and relative budgets only for
a declared workload/reference environment with measured variance. Do not compare changing CI
machines as if they were the same device. Browser paint/readiness estimates do not establish
physical input-to-display latency.

Retain failed runs and their attribution limits. Revisit an unreproduced outlier only with a
new hypothesis and a bounded experiment; unresolved attribution does not block unrelated
implementation. Reuse passing evidence whose runtime, fixture and packaging inputs are unchanged.
Keep reports and detailed investigation history outside the active API documentation.

### Retention and lifecycle

A retention check names its warm baseline, live owner, teardown boundary, settlement steps and
collection method. Assert final model ownership, subscriptions, jobs and leases independently
of memory readings. Retaining the document/controller while detaching a view is a different
boundary from releasing the embedding owner. Immediate and frame-settled collection results
must keep distinct labels.

Runtime counters are not heap-byte estimates. V8 used heap, DOM nodes/listeners, native/backing
memory, process/peak memory and GC pauses have different scopes. A bounded observation in one
scope/engine cannot qualify the others. Exercise pending decisions, remount, inactive documents
and background work as well as an idle empty editor.

### Package qualification

`npm run test:package` builds/packs once, restores outside the checkout, then runs the selected
consumers against that same immutable archive and asset root. The default routes are full,
LSP and React. Select `--scenarios=full,lsp,react`; available routes also include
`pilot,hunk,activation,workspace,demo`. The full route owns installation/version transitions;
the coordinator checks source and package identity through the run.

When an unchanged qualified archive exists, `--existing` reuses it. `--skip-transitions` reuses
applicable installation evidence when packaging inputs are unchanged. Rebuild after runtime,
declarations or packaging changes. Host/fixture path changes require the affected staging
route even if library bytes match, because runtime and erased type imports must remain isolated.
The lower-level `--reuse-consumer=<metadata>` option checks the package hash and staged root.
Lower-level `--*-only` workload flags are mutually exclusive; use the coordinator's
`--scenarios` option to qualify multiple workloads against one restored artifact.

Each consuming route has its own integration purpose: public exports/declarations and CSS,
wire protocol, framework lifetime, review, deferred activation or the actual demo host. Its
compiler/bundle graphs reject checkout/private library fallback. The host owns its compiler,
framework and language provider. See [packaging](packaging.md) for the artifact/build contract.

### Native-device checklist

The [support matrix](README.md#support-matrix) records support and unverified boundaries.
Choose and record the actual application platform before native qualification. Automated
Chromium/Firefox/WebKit identify their engine revisions; headless WebKit is not Safari evidence.

| Environment or path | Exercise |
| --- | --- |
| Windows with US English/French AZERTY hardware keyboards | Typing/navigation, shortcuts, AltGr/dead keys, focus to/from adjacent controls and read-only transitions |
| Windows Japanese IME and Chinese Pinyin | Start/update/commit/cancel, reconversion, selection and IME popup placement at a scroll boundary, permission change during composition |
| OS/application clipboard and browser-menu actions | Copy/cut/paste formats, permissions, large selections, converted/literal paste, source/history restoration and cross-application drag |
| Native page/application lifecycle | Actual navigation/shutdown and browser-history restoration, recovery choices, unsaved inputs and pending services |
| Target fonts, displays and constrained hardware | Caret/ink alignment, fallback fonts, physical display behavior and workload-specific responsiveness |
| Other targeted native platforms | Separate macOS/Safari, Linux and touch/mobile input runs using their actual devices/input methods |

Record OS/browser/input-method versions, keyboard, steps, expected/actual text and complete
selection, and the result for each condition. Synthetic/CDP composition, synthetic persisted
page events, screenshots and model counts cannot fill a missing native result. Continue
independent implementation when device evidence is unavailable.

## Contributor responsibilities

Name the changed guarantee and its owner before adding a regression. Reuse existing helpers
and keep expectations semantic. Batch broad browser/package/inspection checks at coherent
milestones, and run measurements relevant to a changed hot path. Do not hide faults with
blanket timeout increases, retries or overlapping suites.

Use the shared-machine and publishing rules in [AGENTS.md](../AGENTS.md) when operating tools. Keep test
fixtures generic, source-labelled and separate from library runtime dependencies. Report
qualified scope and limitations together; a passing narrow check is not a broader support claim.

## Not covered

See the [support matrix](README.md#support-matrix) for feature and native-device boundaries.
