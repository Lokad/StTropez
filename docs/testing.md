# Testing

A stale save can be reproduced in a model test. A misplaced caret needs a browser. A missing
worker in a deployment needs a frontend built from the restored NuGet package. Run the focused
test while editing, then run the broader suites for the changes you're shipping.

## Use

Install the locked dependencies and the browsers you need. To run a single regression, name its test
file.

```sh
npm ci
npm run browsers:install
node --test tests/input-context.test.ts tests/input-target.test.ts
npm run test:browsers -- --project=chromium --project=firefox --project=webkit tests/browser/input-target.spec.ts
```

| Command | Scope |
| --- | --- |
| `npm run typecheck` | Strict TypeScript checks for core, protocol, browser and development tools |
| `npm run check:docs` | Page structure, links, anchors, prose and compilation of JavaScript, TypeScript and TSX examples. |
| `npm test` | All model, host-policy, tooling and server/process integration tests |
| `npm run test:models` | Headless model, host-policy and tooling checks without live servers or provider/compiler processes |
| `npm run test:integration` | Real HTTP/WebSocket, provider, compiler and child-process lifecycle checks |
| `npm run test:browser` | Source browser suite in Chromium |
| `npm run test:browsers` | Source browser suite in Chromium, Firefox and WebKit. The scrollbar tests enable visible native tracks in their own fixture. |
| `npm run test:ci` | Chromium suites and individual workflows in the [CI test list](../tests/browser/ci.txt) |
| `npm run check` | Type checks, documentation checks, model and integration tests, library build and Chromium tests against the source |
| `npm run inspect` | Check editor behavior in headless Chromium and capture screenshots with the corresponding state |
| `npm run build:demo` then `npm run test:demo` | Built static demo in the configured engines |
| `npm run test:package` | Build, pack and run the isolated consumer smoke test |
| `npm run bench` | Seeded model work and actual bounded-editor keyboard insertion |
| `npm run bench:all` | Run the larger set of benchmarks, or list them with `-- --list` |

Source tests default to port 4183. Set `STTROPEZ_PORT` to override it. Static tests use `STTROPEZ_DEMO_PORT` locally or
`STTROPEZ_DEMO_URL` for a deployed site. Give tests their own port on a shared desktop.

Run `npm run typecheck` after checkout, or add `-- --force` for a clean recheck. Each source file
belongs to one TypeScript project. Core and protocol use ES types, browser code adds DOM types, and
development tools can use Node types. See [tsconfig.json](../tsconfig.json) for the checked tools
and fixtures. Incremental output goes to `artifacts/types`. Package declarations go to `dist`.

CI checks types, documentation and models, runs the package smoke test, then exercises selected source
workflows and the built demo in Chromium. Use `npm run test:browsers` for the three-engine suite.

## Contract

<a id="documentation-gate"></a>

### What the documentation check catches

`scripts/check-docs.mjs` checks subject pages, both READMEs and contributor instructions. Relative
links, images and reference definitions must resolve to non-ignored paths. The checker recognizes
rendered heading slugs, duplicate-heading suffixes, explicit HTML anchors and source-line links. It
rejects other raw HTML. It skips external URLs and paths written as inline code.

Each API page includes a checked example and links to the support matrix. Headings follow the subject.
Examples import StTropez through its public entries. By default each code example compiles on its own.
For a multi-file tutorial, mark fences with `file=app.js` or the companion filename. The checker joins
sections of the same file and resolves imports such as `./checklist.js` within that page. Errors point
to the corresponding Markdown line.

Keep dates, commit IDs, milestone labels and test-run counts in research notes. The vocabulary check
covers prose. Contributor instructions are exempt, but their links and examples are checked.
Reviewers check the accuracy of the contracts.

<a id="test-ownership"></a>

### Where to put a regression test

Start with the test that can reproduce the failure. For example, a replacement refused by an edit
lock belongs in the Find controller test. A result banner showing the wrong total after clicking
Replace All belongs in the demo. Extend the existing case when it already performs the action.

| Behavior | Model or controller test | Browser or consumer test |
| --- | --- | --- |
| Typing, selections and history | [Text buffer](../tests/text-buffer.test.ts), [positions](../tests/positions.test.ts), [undo groups](../tests/history.test.ts) | [Edit using the keyboard](../tests/browser/editing.spec.ts), [move the caret](../tests/browser/navigation.spec.ts) |
| Shortcuts and composition | [Key bindings and layouts](../tests/editor-keymap.test.ts), [input context](../tests/input-context.test.ts) | [Input targeting](../tests/browser/input-target.spec.ts). Physical layout and dead-key checks need a device. |
| Clipboard and conversions | [Clipboard edits](../tests/clipboard-edits.test.ts), [table paste](../tests/table-paste.test.ts) | [Browser clipboard events](../tests/browser/clipboard-delegation.spec.ts), [host keyboard routing](../tests/browser/host-keyboard-clipboard.spec.ts). Cross-application paste needs an OS clipboard. |
| Find and replace | [Match retention and navigation](../tests/find-retention.test.ts), [edit permissions](../tests/find-permission.test.ts), [regex replies](../tests/find-regex.test.ts) | [Keyboard commands and painted matches](../tests/browser/language-find.spec.ts), [reference host result text](../tests/browser/reference.spec.ts) |
| Folds, minimap and scrolling | [Fold ranges and edit mapping](../tests/folding.test.ts) | [Gutter controls](../tests/browser/folding.spec.ts), [minimap gestures and selection](../tests/browser/viewport-presentation.spec.ts), [scrollbar interaction](../tests/browser/viewport-scrollbars.spec.ts) |
| Changes and review | [Hunks and reference versions](../tests/comparison.test.ts) | [Pane alignment](../tests/browser/comparison-rows.spec.ts), [captured review actions](../tests/browser/comparison-ownership.spec.ts) |
| Save, recovery and remount | [Save conflicts](../tests/host-save-conflict.test.ts), [draft restoration](../tests/host-drafts.test.ts) | [Review a conflicting save](../tests/browser/save-conflicts.spec.ts), [demo recovery](../tests/browser/demo-recovery.spec.ts), [host attachment](../tests/browser/host-attachment.spec.ts) |
| Completion and language requests | [Completion items and resolve](../tests/lsp-completion.test.ts), [stale controller replies](../tests/document-language-controllers.test.ts) | [Accept a choice while the list refreshes](../tests/browser/host-lsp.spec.ts), [provider interoperability](../tests/browser/lsp-interop.spec.ts) |
| Protocol and transport | [Workspace requests and synchronization](../tests/lsp-workspace.test.ts), [transport](../tests/websocket-transport.test.ts) | [WebSocket fixture](../tests/browser/protocol-websocket.spec.ts). A consuming host checks its provider against the [supported LSP subset](language-server.md). |
| Demo and distribution | [Syntax after edits](../tests/demo-syntax.test.ts), [color spans](../tests/demo-syntax-colors.test.ts) | [Source demo controls](../tests/browser/demo-interface.spec.ts), [static-site walkthrough](../tests/browser/static-demo.spec.ts), [restored NuGet host](../scripts/test-package.mjs) |

Use the plain host for shared behavior. Add a React case for attachment, Strict Mode, render
isolation or error recovery. Use a shadow root when event retargeting affects the outcome.
For layout, exercise the actual control and inspect the painted row, caret or selection.
For browser tests that import source modules directly, declare the entries once per suite.
The [fixture bundler](../tests/helpers/fixture-modules.ts) builds them on first use and serves them to each test page.

For a race, hold the reply, change or close its target, release it and check the document and
selection that the user sees. For a save, check what was written and whether later edits remain
dirty. The LSP helper can wait for a later reply on the same connection to confirm delivery.
[Held LSP replies](../tests/helpers/lsp-replies.ts)

Tests in `tests/integration/` start real servers and processes on temporary loopback ports and clean
them up on exit. Run just the demo provider with `node --test tests/integration/demo-provider.test.ts`.

### Fixtures and test hooks

The editing, viewport, comparison, protocol and host fixtures declare their browser hooks beside
the code that installs them. Use the fixture for the surface under test. Read a source range
explicitly when the assertion needs text. A demo-specific probe belongs beside its scenario.
[Editing](../tests/fixtures/editing/main.ts) · [Viewport](../tests/fixtures/viewport/main.ts) · [Comparison](../tests/fixtures/comparison/main.ts) · [Protocol](../tests/fixtures/protocol/main.ts) · [Host](../tests/fixtures/hosts/harness.ts)

`npm run inspect` starts a separate server and headless Chromium. Check the editor state before
capturing a screenshot. Playwright retains traces on failure. When a test injects an error,
allow its exact message and source URL. [Browser error checks](../tests/helpers/browser-errors.ts)

<a id="readiness-and-visible-continuity"></a>

### When is the editor ready for an assertion?

Use the fixture helpers in `tests/fixtures/readiness.ts` to wait for the work your assertion depends on.

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

Poll activity snapshots. Take retention diagnostics after the interaction because they walk
the buffer tree. Tests for bounded reads instrument `slice()` and `text()` on the buffers
under test. [Text-model diagnostics](text-model.md#conservative-change-spans-and-diagnostics)

### Workloads

`tests/fixtures/workloads.ts` generates the corpora. For deterministic replay, preserve the initial seed,
`nextSeed` draw order and each model’s range mapping and oracle. Model edits can split a surrogate
pair. Browser navigation follows grapheme and geometry rules.

| Corpus | Shape |
| --- | --- |
| `normal` | Small synthetic source |
| `lines-100`, `lines-10000` | Repeated 24-unit source line |
| `unicode` | Tabs, combining marks, emoji/joiners and mixed line endings |
| Workspace combinations | 1/10/100 resources, 1/2 active views, annotations and background updates |

Keep qualification documents within the [supported document size](README.md#support-matrix).
Vary line count, text length and token density independently. Exercise cold open, sustained input,
bulk edits, search, folding, comparison, tab switches and disposal. See
[operation costs](architecture.md#performance-invariants-and-cost-boundaries) when interpreting a
result.

### Unicode regeneration

Use the exact Unicode inputs and SHA-256 hashes in
[unicode-inputs.json](../scripts/unicode-inputs.json). Put `<name>.txt` and `license.txt` in the
input directory. Review data and license changes explicitly.

Run from the repository root to verify the default-ignorable character ranges and compressed fixtures.

```sh
node scripts/generate-grapheme-data.mjs /path/to/reviewed/grapheme --check
```

The generator checks every input and the repository notice. `--check` reports missing or different
output without writing files. It normalizes CRLF in text and compares compressed fixtures byte for
byte. Omit the flag to regenerate. Builds and restores use the checked-in outputs.

### Measurement policy

The default benchmarks cover model transactions and editing. The full group adds viewport rendering
and comparison. All four use documents up to 512,000 UTF-8 bytes. [Suite manifest](../scripts/benchmark-suites.mjs)

```sh
npm run bench:all -- --list
npm run bench:comparison
```

`--list` shows prerequisites and report locations. Pass workload arguments to a named npm command,
or after `--` on a direct runner call. Groups reject workload arguments.

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

Use the [clock glossary](README.md#measuring-an-interaction). Record the start event, end condition and included
work. Nested intervals and inclusive profile weights overlap.

Before recording a time, check which provider answered and verify the exact text, revision,
selections and history. Where a workload requires it, check that it avoided full-text export,
kept the DOM and caches within bounds, and skipped notifications for unchanged resources.
Report the longest uninterrupted step alongside the time until the result is ready. A bulk
edit can yield during planning and then apply one synchronous transaction. Include deliberate
service delays in the time for the whole workflow.

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

<a id="retention-and-lifecycle"></a>

### Measuring what stays in memory after disposal

Record a warm baseline, the owner you dispose, anything you keep alive, and when and how you
collect memory readings. Detaching a view leaves its document and controller alive. Closing the
whole host releases more. For each case, count the remaining owners, subscriptions, jobs and
leases. Label readings taken immediately after disposal separately from those taken after a frame.

A lease count tells you how many leases exist. It can't tell you how many heap bytes they use.
Measure V8 heap, DOM nodes and listeners, native buffers, peak process memory and GC pauses
separately in each engine you test. Include pending decisions, remounts, inactive documents
and background jobs alongside an idle editor.

### Package qualification

CI runs `npm run test:package` with the .NET 10 SDK and headless Chromium. A temporary consumer
restores from a local-only feed and stages the assets through MSBuild. The smoke test checks the archive,
manifest, hashes and public exports. It compiles the reference host with strict TypeScript, loads the CSS
and a host-supplied font, runs a regex search in the packaged worker, and types into the editor.
The consumer directory is removed on exit. [Package layout and host setup](packaging.md)

Source demo tests start the WebSocket fixture. Run `npm run demo -- --server-provider` to try it locally.
In that fixture, `?provider=browser` selects the playground's usual worker.
The static suite checks that assets load under the repository prefix, exercises one editing and
review walkthrough, and verifies worker failure and retry.

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
| Windows with French AZERTY (France), US QWERTY and US International | Type characters and exercise every default and example shortcut. Check AltGr, dead-key commit and cancellation, focus traversal and read-only transitions. |
| OS/application clipboard and browser-menu actions | Copy/cut/paste formats, permissions, large selections, converted/literal paste, source/history restoration and cross-application drag |
| Native page/application lifecycle | Actual navigation/shutdown and browser-history restoration, recovery choices, unsaved inputs and pending services |
| Target fonts, displays and constrained hardware | Caret/ink alignment, fallback fonts, physical display behavior and workload-specific responsiveness |
| Other targeted native platforms | Exercise the supported layouts on macOS/Safari and Linux. Check touch selection on the target device. |

Record the OS, browser, keyboard layout and reproduction steps. Include the expected and
observed text and selections. Mark any devices you couldn't test.

## Contributor responsibilities

Use an existing fixture that reproduces the problem and assert what the user can observe.
Group browser and package runs for related changes. If you changed code that runs on each
keystroke or frame, measure that interaction. [Shared-desktop and publishing rules](../AGENTS.md)

## Not covered

The [support matrix](README.md#support-matrix) lists the hardware keyboard, clipboard and
touch interactions that need a run on the target device.
