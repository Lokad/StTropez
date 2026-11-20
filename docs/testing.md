# Testing

Use model tests for editing rules, browser tests for interactions and a restored package for
distribution. Run the affected tests as you work. Group broader browser, package and performance
checks once the related changes are ready.

## Use

Install the locked dependencies and the browsers you need. To run a single regression, name its test
file.

```sh
npm ci
npm run browsers:install
node --test tests/input-context.test.ts tests/input-target.test.ts
npm run test:browsers -- --project=chromium --project=firefox --project=webkit tests/browser/input-target.spec.ts
```

Choose the command that exercises your change.

| Command | Scope |
| --- | --- |
| `npm run typecheck` | Referenced strict core, protocol, browser and development type projects |
| `npm run check:docs` | Subject-page structure, repository links/anchors, public value ownership, prose and independently compiled TypeScript examples |
| `npm test` | All model, host-policy, tooling and server/process integration tests |
| `npm run test:models` | Headless model, host-policy and tooling checks without live servers or provider/compiler processes |
| `npm run test:integration` | Real HTTP/WebSocket, provider, compiler and child-process lifecycle checks |
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

Source tests use `STTROPEZ_PORT`. Static tests use `STTROPEZ_DEMO_PORT` locally or
`STTROPEZ_DEMO_URL` for a deployed site. Give tests their own port on a shared desktop.

Run `npm run typecheck` after checkout, or add `-- --force` for a clean recheck. Each source file
belongs to one TypeScript project. Core and protocol use ES types, browser code adds DOM types, and
development tools can use Node types. See [tsconfig.json](../tsconfig.json) for the checked tools
and fixtures. Incremental output goes to `artifacts/types`. Package declarations go to `dist`.

Browser probes use the fixture’s own snapshot and report types. Trace reports omit event arguments
and other content-bearing fields. Restored-package tooling checks its copied fixture separately from
the browser consumer, whose declaration check uses `skipLibCheck: false`. Both record compiler
inputs.

CI runs types, docs, models, the library build, selected Chromium tests and the static demo in
Chromium. Use the three-engine and restored-package commands above for wider coverage.

## Contract

### Documentation gate

`scripts/check-docs.mjs` checks subject pages, both READMEs and contributor instructions. Relative
links, images and reference definitions must resolve to non-ignored paths. The checker recognizes
rendered heading slugs, duplicate-heading suffixes, explicit HTML anchors and source-line links. It
rejects other raw HTML. It skips external URLs and paths written as inline code.

The checker resolves each public runtime export to its declaring module without executing it. Its
owning page, listed in `scripts/documentation-audit.mjs`, must name the export in `Contract` prose.
Examples and comments do not count. Type-only exports are exempt.

API pages need a TypeScript example and a support-matrix link. Their four sections are `Use`,
`Contract`, `Host responsibilities` and `Not covered`, in that order. Each TypeScript or TSX fence compiles
separately against public entries. Private imports and other packages fail with a Markdown file and
line number.

Keep dates, commit IDs, milestone labels and test-run counts in research notes. The vocabulary check
covers prose. Contributor instructions are exempt, but their links and examples are checked.
Reviewers check the accuracy of the contracts.

### Test ownership

Test guard combinations in the model. Use a browser for native events, geometry, rendering and
remounts. Use a restored consumer for packaging and host integration.

| Guarantee | Deterministic owner | Browser or distribution owner |
| --- | --- | --- |
| Text, UTF-16 maps, newline conversion and complete selections | Buffer, positions, UTF-16 ranges and selections models | Editing, raw-CRLF caret and multiple-input journeys |
| Atomic revisions, shared history and detached views | Workspace, history/history-bounds and resources models | Workspace, editing and host lifecycle journeys |
| Save/conflict and canonical replies | Save-review, host-save-conflict/failure models | Save/conflict, composition and complete host journeys |
| Immutable reference, exact hunks and review lifetime | Comparison, comparison rows/scroll/scheduling models | Comparison ownership, lifecycle, reference input/find and aligned-pane journeys |
| Demo recovery and syntax classification | Demo-recovery, demo-syntax and demo-syntax-colors models | Real storage/reload/failure, file/sample switching, save and visible-color journeys |
| Positional LSP captures and invalid responses | LSP clients, workspace, workspace edits and protocol feature models | Focused hover/navigation/rename/action and input/synchronization journeys |
| Wire negotiation, selectors, provider sharing and command ownership | JSON-RPC, protocol session/selector/fixture models | WebSocket/interoperability journeys and the minimal restored LSP consumer |
| Native projection and composition recovery | Input-context and input-target models | Input-target, ordered-input and composition journeys |
| Caret, grapheme boundaries, scroll, focus and drag | Geometry-independent and Unicode models | Viewport/geometry/paint, zoom, grapheme, pointer/drag and shadow-focus suites |
| Host conversion, source annotations and forms | Table-paste, text-transfer and domain policy models | Table-paste, domain and transfer/form journeys |
| Framework mount/disposal and surrounding UI | Host controller/policy models | Plain/React attachment, Strict Mode, queued-work disposal and error recovery |
| Font registration lifetime | Native browser decoder | Font registration/measurement/release owner and a restored-consumer check |
| Compiled assets and installation | Manifest/hash/dependency/export checks | Full restored consumer, version transitions and selected LSP/React/demo routes |

Model tests live in `tests/`, browser tests in `tests/browser/`, and package journeys in
`scripts/package-*.mjs`. Add a host or engine when it exercises a different behavior.

`tests/integration/` owns live servers and processes, uses ephemeral loopback ports and cleans up
listeners, processes and files. In-memory peers belong in model tests. For one provider regression,
run `node --test tests/integration/demo-provider.test.ts`.

The plain host runs every action, server-edit, color-preview and link-discovery case, including
large paging and wide-deletion previews. Both hosts cover navigation, rename, focus, remount,
provider recovery, unmounted targets and captured Save/Run. Use the
[host coverage helper](../tests/browser/host-cases.ts) to select permutations by metadata. Register
cases where they are declared so failures point to the test. Save-failure setup reads the native
projection-cache annotation before opening the host.

React cases cover stable refs, Strict Mode, render isolation, error recovery and focus across
multi-resource reviews. They also cover remounts during commands, lost acknowledgements, held server
edits, changed color values and link attachments. Both hosts exercise completed color previews,
read-only recovery and keyboard traversal (F6 for colors, F4 for links). Large navigation and rename
workloads run on plain in each engine.

`expectUnmountedSourceHost` checks that views detached while the source-provider scope, recovery
subscriptions and project-review observer survived. Declare extra service subscriptions in the
caller. After full disposal, expect zero views, leases and subscriptions.

Use `tests/helpers/lsp-replies.ts` to hold a completed reply by connection and request ID. Interrupt
the operation, release the reply, then wait for another reply on that stream to confirm delivery. A
new connection cannot confirm delivery on the old one.

### Behavioral coverage

Assert the observable result of each action. Expected behavior comes from the
[API contracts](README.md#subjects).

| Area | Required observations |
| --- | --- |
| Resource identity and loading | Equal labels in different scopes/variants stay distinct; deferred load/confirmation/save resolves its captured target through move, replacement and closure; pending work retains resources and failed loading recovers |
| Publication and views | Scoped subscribers preserve unchanged identity; listener failures and rejected reentrant writes preserve committed state; two views and typed forms keep independent selections through remount and error recovery |
| Transactions and authority | Invalid/stale multi-resource batches publish nothing; each edit origin obeys capabilities/locks; shared undo/redo restores complete selections and the saved baseline without losing later corrections |
| Editing and navigation | Actual keyboard typing, deletion, arrows/word/line/page/grapheme movement, indentation/comments, pairs, newline, multiple selections, regex/case/whole-word find/replace, clipboard/drag paths and focus escape yield exact text and selection |
| Unicode and geometry | Surrogates, combining sequences, emoji/joiners, CRLF, selection affinities, zoom and fonts preserve source and expected caret/hit targets within the supported geometry contract |
| Save and Run | Queued/captured saves preserve submitted content, server preconditions, retry/canonical/conflict behavior and dirty state while typing continues; Save and Run retain separate source/settings captures |
| Reviewed proposal | The host previews a replacement, checks its captured revision, then corrects and saves the applied edit |
| Comparison | Reference, saved and proposal versions stay distinct; refresh/accept/revert/discard and hunk navigation handle stale decisions, whitespace, edits, delayed loads and takeover without losing history/corrections; both panes show their own source/color/fold state |
| Language features | Visible token classes, completion edits, diagnostics, hover/signatures, navigation, rename/actions, links/colors and explicit command decisions use validated captures; editing works during provider outage |
| Protocol | Initialization/capabilities, dynamic registration, incremental sync, cancellation, diagnostics, server edits, custom messages and reconnect exercise the declared actual transport; internal worker replies do not establish LSP compatibility |
| Host extensions and structured surfaces | Domain folds/notes, structured table paste and imports use captured selections and intended undo units; independent source/settings/run-log resources preserve authority; source-backed forms preserve invalid text, unknown fields and anchors through edit/fold/undo/resize/virtualization; progress invokes neither Save nor Run |
| Recovery and lifecycle | Explicit draft restoration preserves loaded save authority; remount/input-route switches retain view/document state; close/replace/dispose during work releases owned views/listeners/jobs/leases without discarding retained unsaved input; previous-session undo is not implied |
| Large documents and background work | Beginning/middle/end edits and navigation, vertical/horizontal scroll, bulk changes, many inactive documents and concurrent progress preserve exact results with bounded native input/DOM/routine reads |
| Responsiveness and retention | Source/hardware-labelled samples include semantic guards, complete required presentation and raw clocks; repeated mount/dispose checks define the released owner and actual memory scope |
| Distribution | Isolated restore resolves modules and declarations, loads styles/workers and performs actual editing; upgrade/downgrade/stage reuse preserves coherent assets and excludes checkout/private implementation fallback |
| Optional acceleration | Any introduced accelerator proves its actual execution path, equivalent results, cancellation and startup/failure behavior including transfer/allocation costs |

The generic fixture covers the [declared LSP subset](language-server.md). A consuming application
must check its own provider.

### Fixtures and test hooks

Fixture hooks expose test controls. Read text explicitly. Routine snapshots carry IDs, revisions,
activity and bounded counters.

| Hook | Fixture purpose |
| --- | --- |
| `window.sttropez` | Workspace setup/readiness, document/tab metadata and synthetic corpora |
| `window.editingFixture` | Editor/view state, bounded input/viewport activity, explicit source ranges and disposal |
| `window.comparisonFixture` | Reference/working captures, hunk ranges, tickets and view lifetime |
| `window.hostFixture` | Plain/React resources, deferred service decisions, recovery metadata, view attachment and disposal |

`npm run inspect` starts an isolated loopback server and headless Chromium. Assert text, selections,
revisions and ownership across affected panes before capturing screenshots.

`tests/helpers/browser-errors.ts` collects uncaught errors and unexpected console errors across
pages. A fault-injection test can allow one exact message and source URL. Browser suites disable
retries, reject focused-only tests and retain failure traces. Missing binaries, unmet readiness
conditions and empty selections fail the run.

### Readiness and visible continuity

`examples/shared/readiness.ts` owns fixture-only settlement helpers:

- `viewportSettled` checks a live, nonpending presentation against the view's revision,
  complete selection-set identity and fold generation.
- `editorSettled` additionally checks pending input, commands, caret, word/grapheme and drag-scroll
  work. It does not treat an active composition session or provider request as pending editor work.
- `comparisonSettled` requires a ready controller, settled alignment/scroll and both editors;
  aligned rows must share the same alignment identity. Alignment failure throws.

After editor work settles, check the expected text, revision and full selection set, including
direction and affinity. Wait separately for the provider result, decoration, reference version or
service operation the user needs. Fail on terminal errors.

Sample visible rows during thumb drags, wheel scrolling and mid-document edits. Check gutter
alignment, source text and syntax colors in both comparison panes. A final screenshot can miss a
blank row or a color flash. Assert which provider answered. Record editor-frame, service and
whole-action times separately.

Poll cheap activity/snapshot handles. Buffer read counters support bounded-work checks;
full tree diagnostics or retained-structure traversal belong outside readiness polling and
input subscribers. See [text-model diagnostics](text-model.md#conservative-change-spans-and-diagnostics).

### Workloads

`fixtures/workloads.ts` generates the corpora. For deterministic replay, preserve the initial seed,
`nextSeed` draw order and each model’s range mapping and oracle. Model edits can split a surrogate
pair. Browser navigation follows grapheme and geometry rules.

| Corpus | Shape |
| --- | --- |
| `normal` | Small synthetic source |
| `lines-100`, `lines-10000`, `lines-100000` | Repeated 24-unit source line: 2,400 / 240,000 / 2,400,000 UTF-16 units |
| `single-line` | 2,400,000 ASCII units with no newline |
| `unicode` | Tabs, combining marks, emoji/joiners, RTL, CRLF and LF |
| Workspace combinations | 1/10/100 resources, 1/2 active views, annotations and background updates |

Vary line count, text length and token density independently. Exercise cold open, sustained input,
bulk edits, search, folding, comparison, tab switches and disposal. See
[operation costs](architecture.md#performance-invariants-and-cost-boundaries) when interpreting a
result.

### Unicode regeneration

Use the exact Unicode inputs and SHA-256 hashes in
[unicode-inputs.json](../scripts/unicode-inputs.json). Put `<name>.txt` and `license.txt` in the
input directory. Review data and license changes explicitly.

Run from the repository root to verify the generated tables and compressed fixtures:

```sh
node scripts/generate-grapheme-data.mjs /path/to/reviewed/grapheme --check
```

The generator checks every input and the repository notice. `--check` reports missing or different
output without writing files. It normalizes CRLF in text and compares compressed fixtures byte for
byte. Omit the flag to regenerate. Builds and restores use the checked-in outputs.

### Measurement policy

The [suite manifest](../scripts/benchmark-suites.mjs) defines `bench`, `bench:pilot`, `bench:all`
and named suites. Use `--list` to see what a group includes and omits. The native-workspace workload
also exercises the model.

```sh
npm run bench:all -- --list
npm run bench:services -- --regex --whole-word
node scripts/run-benchmarks.mjs --suite=host-drag-scroll --list
```

`--list` shows prerequisites and report locations. Pass workload arguments to a named npm command,
or after `--` on a direct runner call. Groups reject workload arguments. Package suites run through
npm and require a pack step.

The runner executes suites in order. `artifacts/bench/campaigns` contains the manifest and per-step
output. The first failure stops the run and preserves the exit code when available. Later selected
suites are `not-run`. Only a successful run updates its variant’s latest report. Arguments and
declared environment settings distinguish variants such as smoke and full.

Keep source inputs stable. Before and after the run, the runner hashes tracked and non-ignored
untracked files, skipping unstaged deletions. Other read failures reject the capture. Staging alone
preserves the hash. To reuse a retained manifest, every listed file must exist and match. Each
suite’s report supplies its own clocks, samples and readiness checks. The runner adds no retries or
timeouts.

Source browser benchmarks start on `about:blank` with a fixed development bundle
(`development-bundle-no-watch`). Each workload opens its fixture and controls warm-up. Record the
build mode when comparing against the interactive watcher, static site or restored package.

`scripts/host-edit-measurement.mjs` drives Enter and native text input through
`scripts/host-reference-probe.mjs`. For event clocks, `inputEvents` records every dispatch, its
data and handler sample, even if it commits nothing. For inserted units, use the committed text in
transaction `records`. Render observations belong to the committed revision. Measure settlement
from the end of the last input event, including fragments after the commit. Inapplicable clocks are
null. The native probe requires `insertText` intent and accepts WebKit’s `insertParagraph` fragments
within a multiline insertion. It rejects separate paragraph and composition intentions and saves
partial results on failure.

`isReady` requires the expected revision, both working views, reference version, complete
selections, caret, scans, folds, alignment and scroll over two frames. Verify exact text, counters
and undo/redo. `isSourceReady`/`waitSourceReady` also accept native source views (null metrics) or
an unmounted review. Conflict input measurements require a mounted review and `beforeinput` on its
captured input. Missing events and terminal failures release listeners and cancel frame waits.

`scripts/host-scene.mjs` shares mount, readiness and disposal checks across host benchmarks.
`hostTextEquals` compares length and raw UTF-16 chunks outside point and gesture clocks. A workflow
clock can include intermediate checks. Disposal timing ends before teardown diagnostics. The
installed consumer stages the helper against public imports. Individual workloads add their provider
or service conditions.

Input/reference, folding and table-paste reports use `scripts/benchmark-report.mjs`: each variant retains a unique run under
`artifacts/bench/<benchmark>/<variant>/runs/`; only a successful run updates that variant's
`latest.json`. Smoke, full and retention-check results stay separate, as do raw warmups and
measured observations. Failed runs retain completed samples and the active partial observation.

Use the [clock glossary](README.md#glossary). Record the start event, end condition and included
work. Nested intervals and inclusive profile weights overlap.

Validate operation success and expected provider paths before accepting timing samples. Assert
exact text, revisions, selections/history and applicable no-export, bounded-DOM/cache and
unchanged-resource delivery constraints. Bulk planning may yield while final assembly or an
atomic transaction is synchronous; report the longest uninterrupted work separately from total
settlement. Controlled service delays belong in workflow results.

Record source and lockfile identity, corpus and seed, build mode, browser, OS, hardware, viewport,
font, power/load conditions and raw samples. Separate cold and warm runs. Alternate baseline and
editor on the same machine. Capture traces separately. Leave unsupported metrics absent. Correctness
timeouts serve a different purpose from latency budgets.

`scripts/measurement.mjs` reports count, observed maximum and nearest-rank percentiles. Below 20
observations it labels the summary as a maximum. Set budgets for a specific workload and reference
machine after measuring variance. Use a device test for physical display latency.

Keep failed runs and record what is known about the cause. Retry an outlier when a new hypothesis
suggests a bounded experiment. Reuse evidence for unchanged runtime, fixtures and packaging. Store
traces and investigation history outside the API docs.

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

Each route compiles its callers against its own copied fixture and restored public declarations. The
full route also compiles its installation-transition caller. Node and Playwright types belong to the
test harness. The checks record compiler inputs and reject unexpected imports from the checkout.

Each run creates a temporary consumer. Success removes it after the final identity check.
`--keep-consumer` retains it. Failures, standalone preparation, benchmarks and borrowed stages keep
their directories. Cleanup verifies directory identity and skips links to borrowed locations.

Receipts in `artifacts/package/qualification/<consumer-name>/` record the scenarios, retention state
and file bytes before removal. `artifacts/package/qualification/receipt.json` identifies the latest
run. Cleanup writes evidence first and only removes its own directory. A consumer marked removed or
being removed cannot be reused.

Protocol tests start an ephemeral server through `tests/helpers/protocol-fixture.ts`. Register
cleanup with `defer` as soon as you acquire a resource. Cleanup runs in reverse order before the
listener closes.

Package, development and preview servers release partially acquired resources and wait for
outstanding request handlers on close. Repeated closes share completion. Request failures return an
empty 500 before headers or abort a partial response. Teardown collects errors even for completed
responses and attempts every close, without imposing a timeout. Multiple errors list the workload
error first. The static server accepts GET and HEAD only for manifest-listed assets under its
prefix.

See [packaging](packaging.md) for public exports, CSS and installation. Compiler and bundle checks
reject private or checkout imports in restored consumers.

The restored demo exercises editing, review, saving, two-page conflicts, recovery and host
integrations. Source tests use the WebSocket provider. Static tests load the browser worker and
assets under the repository prefix. These suites own individual language and editor feature cases.

### Native-device checklist

Use the [support matrix](README.md#support-matrix) to choose outstanding device checks. Record the
application and engine version. Safari requires its own run.

Synthetic page events exercise retention policy. For a real back/forward-cache check, navigate
through history in an isolated profile and require a trusted persisted `pageshow`, the browser
restoration signal and the original document/editor. Check full rendered text, stored values,
selection, undo and service readiness. Keep the page active inside the headless browser so frames
can run in the background.
[Playwright’s BFCache limits](https://playwright.dev/docs/navigations#backforward-cache-bfcache).

| Environment or path | Exercise |
| --- | --- |
| Windows with US English/French AZERTY hardware keyboards | Typing/navigation, shortcuts, AltGr/dead keys, focus to/from adjacent controls and read-only transitions |
| Windows Japanese IME and Chinese Pinyin | Start/update/commit/cancel, reconversion, selection and IME popup placement at a scroll boundary, permission change during composition |
| OS/application clipboard and browser-menu actions | Copy/cut/paste formats, permissions, large selections, converted/literal paste, source/history restoration and cross-application drag |
| Native page/application lifecycle | Actual navigation/shutdown and browser-history restoration, recovery choices, unsaved inputs and pending services |
| Target fonts, displays and constrained hardware | Caret/ink alignment, fallback fonts, physical display behavior and workload-specific responsiveness |
| Other targeted native platforms | Separate macOS/Safari, Linux and touch/mobile input runs using their actual devices/input methods |

Record OS, browser, input method, keyboard, steps, expected and observed text, selections and
outcome. Leave untested device cases open and continue independent work.

## Contributor responsibilities

Choose the test that owns the behavior. Keep fixtures generic, reuse helpers and assert what the
user can observe. Batch browser and package runs, and measure changed hot paths. Follow the
[shared-desktop and publishing rules](../AGENTS.md).

## Not covered

See the [support matrix](README.md#support-matrix) for feature and native-device boundaries.
