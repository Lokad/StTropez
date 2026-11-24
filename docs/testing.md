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
| `npm run check:docs` | Page structure, links and anchors, public exports and prose. Compiles each TypeScript example separately. |
| `npm test` | All model, host-policy, tooling and server/process integration tests |
| `npm run test:models` | Headless model, host-policy and tooling checks without live servers or provider/compiler processes |
| `npm run test:integration` | Real HTTP/WebSocket, provider, compiler and child-process lifecycle checks |
| `npm run test:browser` | Source browser suite in Chromium |
| `npm run test:browsers` | Source browser suite in Chromium, Firefox and WebKit. The scrollbar tests enable visible native tracks in their own fixture. |
| `npm run test:ci` | Chromium tests selected in `playwright.ci.config.ts` |
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
Each TypeScript or TSX fence compiles separately against public entries. Private imports and other packages fail with a Markdown file and
line number.

Keep dates, commit IDs, milestone labels and test-run counts in research notes. The vocabulary check
covers prose. Contributor instructions are exempt, but their links and examples are checked.
Reviewers check the accuracy of the contracts.

<a id="test-ownership"></a>

### Where to put a regression test

Model tests live in `tests/`. Browser tests in `tests/browser/` add native events, layout and
view remounts. The package smoke test builds a separate application from the NuGet
archive. Add another host or engine when it exercises a different behavior.

| Behavior | Where to test the rule | Where to check the integration |
| --- | --- | --- |
| Text, UTF-16 offsets, newlines and selections | Buffer, [positions](../tests/positions.test.ts), ranges and selections | Type and edit, place the caret in CRLF text, and enter text at multiple selections. |
| Atomic revisions, shared history and detached views | [Workspace](../tests/workspace.test.ts), history, history bounds and resources | Edit in two panes, detach a view and check the document and its history. |
| Save conflicts and server corrections | Save review, [host conflicts](../tests/host-save-conflict.test.ts) and save failures | [Save conflicts](../tests/browser/save-conflicts.spec.ts), captured writes and retry |
| Fixed references, hunks and closing a review | [Comparison](../tests/comparison.test.ts), row alignment, scrolling and scheduling | Close and reopen the review, find text in the reference, and align the two panes. |
| Demo recovery and syntax colors | Demo recovery, [syntax](../tests/demo-syntax.test.ts) and token colors | Save, switch files or samples, reload, and check stored text and visible colors. Exercise storage failures too. |
| Position-based LSP requests and invalid replies | LSP clients, workspace edits and [stale language-controller replies](../tests/document-language-controllers.test.ts) | Check typing in the color field, host alias changes and focus after navigation. |
| Protocol negotiation, selectors, shared providers and command handling | JSON-RPC, sessions, selectors and the protocol fixture | WebSocket fixture and provider interoperability tests |
| Native input and composition recovery | [Input context](../tests/input-context.test.ts) and input targets | Input targeting, queued keystrokes and dead-key composition |
| Caret, grapheme boundaries, scroll, focus and drag | Geometry-independent and Unicode models | Viewport/geometry/paint, zoom, grapheme, pointer/drag and shadow-focus suites |
| Host conversion, source annotations and forms | Table paste, text transfer and host rules | [Table paste](../tests/browser/host-table-paste.spec.ts), domain examples and transfers through the form |
| Framework mount/disposal and surrounding UI | Host controller/policy models | Plain/React attachment, Strict Mode, queued-work disposal and error recovery |
| Font registration lifetime | The browser's font decoder | [Register, measure and release a font](../tests/browser/fonts.spec.ts). |
| Compiled assets and installation | Manifest/hash/dependency/export checks | One restored consumer smoke test in CI |

Tests in `tests/integration/` start real servers and processes on temporary loopback ports. Each
test closes its listeners, stops its processes and removes its files. Keep in-memory peers in
the model suite. To run just the demo provider, use `node --test tests/integration/demo-provider.test.ts`.

Use the plain host for shared editing, language and review workflows. Use React for stable refs,
Strict Mode, render isolation and root-error recovery. Keep separate cases for light- and shadow-DOM
event paths when a focus or input transition depends on the event target.

The editor fixture checks the native textarea's actual value during editing. Viewport tests check
painted rows and selection geometry. Model tests check which operations materialize text.
The host disposal test checks for leaked views, leases and subscriptions. In a save or recovery
test, check the pending write or draft after the editor remounts.

Use `tests/helpers/lsp-replies.ts` to hold a completed reply by connection and request ID. Interrupt
the operation, release the reply, then wait for another reply on that stream to confirm delivery. A
new connection cannot confirm delivery on the old one.

### Behavioral coverage

If a user switches tabs during a save, check which file the host wrote and whether subsequent
edits are dirty. Choose assertions from the relevant [API contract](README.md#subjects).

| Area | Required observations |
| --- | --- |
| Resource identity and loading | Give two resources the same label in different scopes or variants. While a load, confirmation or save is pending, move, replace or close the tab and check its captured target. Check that pending work keeps the resource alive and a failed load can recover. |
| Publication and views | Check that an unchanged field keeps its snapshot. Throw in a listener or attempt a reentrant write and check the committed state. Remount two views and typed forms after an error and check their independent selections. |
| Transactions and authority | Check that a stale or invalid batch affecting several resources publishes nothing. Test each edit origin against its permissions and locks. Undo and redo must restore the full selections and saved baseline without losing later corrections. |
| Editing and navigation | Assert the exact text and selection after typing, deleting, moving by arrow/word/line/page/grapheme, indenting, commenting, inserting pairs or newlines, and editing multiple selections. Exercise find/replace (regex, case and whole word), clipboard, drag and moving focus out of the editor. |
| Unicode and geometry | Check text, caret placement and pointer hits for surrogates, combining sequences, emoji with joiners and CRLF. Vary selection affinity, zoom and font within the supported geometry. |
| Save and Run | Queue a save, type more text, then deliver a server correction or conflict. Check the submitted text, server precondition, retry and dirty flag. Check the source and settings each Save or Run captured. |
| Reviewed proposal | The host previews a replacement, checks its captured revision, then corrects and saves the applied edit |
| Comparison | Give the reference, saved copy and proposal different versions. Refresh, accept, revert, discard and navigate hunks with whitespace changes, later edits, delayed loads or a takeover pending. Check each pane's text, colors and folds, and that stale decisions preserve history and corrections. |
| Language features | Change the target while a completion, diagnostic, hover, signature, navigation, rename, action, link or color request is pending. Check the visible result, token classes, edits and command decisions. Disconnect the provider and keep typing. |
| Protocol | Run initialization, capability negotiation and dynamic registration, incremental sync, cancellation, diagnostics, server edits, custom messages and reconnect over the transport you ship. Internal worker replies alone can't test LSP compatibility. |
| Host extensions and forms | Check the target selection and undo step for domain folds, notes, table paste and imports. Source, settings and run logs keep separate permissions. Edit, fold, undo, resize or scroll a form out of view and back. Check invalid text, unknown fields and anchors. A progress update alone must leave Save and Run idle. |
| Recovery and lifecycle | Restore a draft and check its save permissions against the loaded resource. Switch input routes or remount a view and check its state. Close, replace or dispose during pending work and check for leftover views, listeners, jobs or leases and for lost drafts. Previous-session undo is outside the recovery contract. |
| Large documents and background work | Edit and navigate at the start, middle and end of the file. Scroll both axes and make bulk edits while inactive documents and background jobs exist. Check the result, native input size, DOM size and routine reads. |
| Responsiveness and retention | Record the build, hardware and raw timings. Check that the correct text and selection reached the screen. For repeated mounts, record which object you disposed and which memory you measured. |
| Distribution | Restore outside the checkout. Compile against the public declarations, load the CSS and worker, and edit text. Check the manifest and public exports against the restored files. |
| Optional acceleration | Verify that the accelerator ran and produced the same result. Exercise startup, failure and cancellation, and include transfer and allocation in its timings. |

The generic fixture covers the [declared LSP subset](language-server.md). A consuming application
must check its own provider.

### Fixtures and test hooks

Fixture hooks expose test controls. Read text explicitly. Routine snapshots carry IDs, revisions,
activity and bounded counters.

| Hook | Fixture purpose |
| --- | --- |
| `window.editingFixture` | Editor/view state, bounded input/viewport activity, explicit source ranges and disposal |
| `window.comparisonFixture` | Reference/working captures, hunk ranges, tickets and view lifetime |
| `window.hostFixture` | Plain/React resources, deferred service decisions, recovery metadata, view attachment and disposal |

`npm run inspect` starts an isolated loopback server and headless Chromium. Assert text, selections,
revisions and ownership across affected panes before capturing screenshots.

`tests/helpers/browser-errors.ts` collects uncaught errors and unexpected console errors across
pages. A fault-injection test can allow one exact message and source URL. Browser suites disable
retries, reject focused-only tests and retain failure traces. Missing binaries, unmet readiness
conditions and empty selections fail the run.

<a id="readiness-and-visible-continuity"></a>

### When is the editor ready for an assertion?

Use the fixture helpers in `examples/shared/readiness.ts` to wait for the work your assertion depends on.

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

`fixtures/workloads.ts` generates the corpora. For deterministic replay, preserve the initial seed,
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

Run from the repository root to verify the generated tables and compressed fixtures:

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
manifest, hashes and public exports. It compiles the consumer with strict TypeScript, loads the CSS and a
host-supplied font, runs a regex search in the packaged worker, and types one character in the editor.
The consumer directory is removed on exit. [Package layout and host setup](packaging.md)

Demo feature tests run on the development server with the WebSocket or browser provider.
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
