# Testing

Choose the cheapest test that observes the failure. A stale save needs a model and a held reply. A misplaced caret needs a browser. Missing deployed assets need a consumer that restores the package.

## Use

Install the locked dependencies and the browsers you need. Pass a filename to run the regression you’re working on.

```sh
npm ci
npm run browsers:install
node --test tests/input-context.test.ts tests/input-target.test.ts
npm run test:browsers -- --project=chromium --project=firefox --project=webkit tests/browser/input-target.spec.ts
```

| Command | What it runs |
| --- | --- |
| `npm run typecheck` | Strict TypeScript projects for the library, fixtures and tools. Add `-- --force` for a clean recheck. |
| `npm run check:docs` | Public index, page sizes, links, prose and examples. |
| `npm test` | Model, host-policy, tooling and process tests. Select `test:models` or `test:integration` for one group. |
| `npm run test:browser` / `test:browsers` | Source fixtures in Chromium / all three engines. |
| `npm run test:ci` | [Selected Chromium workflows](../tests/browser/ci.txt). |
| `npm run check` | Types, docs, models, integration, library build and source Chromium suite. |
| `npm run inspect` | Headless screenshots with editor state. |
| `npm run build:demo`, then `npm run test:demo` | Built demo at its deployment prefix. |
| `npm run test:package` | Restore and run an isolated consumer. |
| `npm run bench` / `bench:all` | Model and editing benchmarks / all four suites. |

Give tests their own server. Source tests default to port 4183 (`STTROPEZ_PORT`). Static tests use `STTROPEZ_DEMO_PORT` locally or `STTROPEZ_DEMO_URL` for a deployment.

## Contract

<a id="documentation-gate"></a>

### What the documentation check catches

After an export changes, regenerate the [API index](api.md) with `npm run check:docs -- --write-api-index`. The check verifies the index, each handwritten page’s LF UTF-8 byte limit, repository links, heading slugs and explicit anchors. It skips external URLs.

API pages link to the support matrix and show a checked example using public imports. Examples compile independently. Add `file=app.js` or the companion filename to fences that build one tutorial. Type errors point to the Markdown line. Keep dates, run counts and commit IDs in research. Review behavior claims against the implementation.

<a id="test-ownership"></a>

### Where to put a regression test

Extend the case that already reaches the failure. For example, a lock refusing Replace All belongs in the Find controller. A wrong result count after clicking Replace All belongs in the host that renders it.

| Workflow | Headless owner | Browser or consumer owner |
| --- | --- | --- |
| Editing and navigation | [Positions](../tests/positions.test.ts), [Undo](../tests/history.test.ts), [key bindings](../tests/editor-keymap.test.ts) | [Typing](../tests/browser/editing.spec.ts), [caret](../tests/browser/navigation.spec.ts), [input target](../tests/browser/input-target.spec.ts) |
| Clipboard | [Edits](../tests/clipboard-edits.test.ts), [table paste](../tests/table-paste.test.ts) | [Clipboard events](../tests/browser/clipboard-delegation.spec.ts), [host routing](../tests/browser/host-keyboard-clipboard.spec.ts) |
| Find | [Permissions](../tests/find-permission.test.ts), [regex replies](../tests/find-regex.test.ts) | [Painted matches](../tests/browser/language-find.spec.ts), [host controls](../tests/browser/reference.spec.ts) |
| Folds and scroll | [Fold mapping](../tests/folding.test.ts) | [Gutter](../tests/browser/folding.spec.ts), [minimap](../tests/browser/viewport-presentation.spec.ts), [scrollbars](../tests/browser/viewport-scrollbars.spec.ts) |
| Review | [Hunks and versions](../tests/comparison.test.ts) | [Row alignment](../tests/browser/comparison-rows.spec.ts), [captured actions](../tests/browser/comparison-ownership.spec.ts) |
| Save and remount | [Conflict](../tests/host-save-conflict.test.ts), [drafts](../tests/host-drafts.test.ts) | [Save retry](../tests/browser/save-conflicts.spec.ts), [draft recovery](../tests/browser/demo-recovery.spec.ts), [attachments](../tests/browser/host-attachment.spec.ts) |
| Language requests | [Stale replies](../tests/document-language-controllers.test.ts), [synchronization](../tests/lsp-workspace.test.ts) | [Completion](../tests/browser/host-lsp.spec.ts), [interoperability](../tests/browser/lsp-interop.spec.ts), [WebSocket](../tests/browser/protocol-websocket.spec.ts) |
| Demo and distribution | [Syntax updates](../tests/demo-syntax.test.ts) | [Demo controls](../tests/browser/demo-interface.spec.ts), [static walkthrough](../tests/browser/static-demo.spec.ts), [package smoke](../scripts/test-package.mjs) |

For a race, hold the reply, change or close its target, then release it. Assert which document changed, which selection survived and whether a fresh action works. For Save, also check the stored revision and later dirty edits. [Held LSP replies](../tests/helpers/lsp-replies.ts)

Use the plain host for shared behavior. Use React for attachment, Strict Mode or render isolation, and a shadow root for event retargeting. Integration tests run real services on temporary loopback ports.

### Fixtures and test hooks

Read source text through a fixture range when the assertion needs it. For layout or color, inspect painted rows. Keep demo-only probes beside the scenario. Declare direct source imports once per suite through the [fixture bundler](../tests/helpers/fixture-modules.ts). [Editing](../tests/fixtures/editing/main.ts) · [Viewport](../tests/fixtures/viewport/main.ts) · [Comparison](../tests/fixtures/comparison/main.ts) · [Protocol](../tests/fixtures/protocol/main.ts) · [Host](../tests/fixtures/hosts/harness.ts)

`npm run inspect` uses a separate server and headless Chromium. Playwright retains failure traces. When injecting an error, allow its exact message and source URL. [Browser error checks](../tests/helpers/browser-errors.ts)

<a id="readiness-and-visible-continuity"></a>

### When is the editor ready for an assertion?

Use the [readiness helpers](../tests/fixtures/readiness.ts) for the surface being tested.

| Helper | Ready condition |
| --- | --- |
| `viewportSettled` | Live viewport, no pending frame, painted revision, selection set and fold generation match the view. |
| `editorSettled` | Settled viewport and no pending input, command, caret, word, grapheme or drag-scroll work. |
| `comparisonSettled` | Ready diff, both editors settled, scroll and alignment finished, matching alignment IDs when aligned. Alignment failure throws. |

Then assert the expected text, selection direction and affinity. Wait separately for a required provider reply, decoration or baseline version. Poll activity during the interaction. Take retention diagnostics afterward because they walk the buffer tree.

For a thumb drag or middle edit, sample painted rows **during** the gesture and recovery. Check that text appears alongside its gutter number and that the expected syntax colors survive on each visible side. A settled screenshot misses a transient blank row or color flash. Report handler, frame readiness, service and whole-action durations separately.

### Workloads

Use the [seeded workloads](../tests/fixtures/workloads.ts). Keep the seed, draw order, range mapping and oracle so a model run can be replayed. Browser navigation follows grapheme boundaries. Vary row count, line length and token density independently within the [document limit](README.md#support-matrix).

`normal` supplies small source. `lines-100` and `lines-10000` repeat 24-unit lines. `unicode` includes tabs, combining marks, emoji and mixed line endings. Workspace combinations vary resources, active views and background updates. [Operation costs](architecture.md#performance-invariants-and-cost-boundaries)

### Unicode regeneration

Verify the reviewed `<name>.txt` files and `license.txt` against the [pinned inputs](../scripts/unicode-inputs.json).

```sh
node scripts/generate-grapheme-data.mjs /path/to/reviewed/grapheme --check
```

`--check` compares the ignorable-character ranges, compressed fixtures and repository notice. Omit it to regenerate. Builds use the checked-in output.

### Measurement policy

Use the [suite manifest](../scripts/benchmark-suites.mjs) to select model, editing, viewport or comparison. List prerequisites and report paths before running a named suite.

```sh
npm run bench:all -- --list
npm run bench:comparison
```

Pass workload arguments to a single suite. The group runner records its manifest and output under `artifacts/bench/campaigns` and stops at the first failure. Only successful runs update the latest report for that variant. Reuse a manifest when its recorded inputs and configuration match. Source browser suites use the fixed development bundle. Record build mode when comparing against the interactive demo or restored package.

Define the start event and readiness condition. For typing, measure the handler, time until the expected text and selection are painted, and the full automation action. For bulk edits, include the longest uninterrupted step as well as completion. Include service delays in any workflow that waits for them. A physical display measurement needs a device. [Clock definitions](README.md#measuring-an-interaction)

Check the result before recording a time. Record source and lockfile, corpus and seed, browser, OS, hardware, viewport, font, power/load and raw samples. Separate cold and warm runs, alternate comparisons on the same machine and capture traces separately. Nested intervals can overlap. The reporter gives the count, maximum and nearest-rank percentiles, labeling samples below 20 as a maximum.

Keep failed runs with what is known about their cause. Retry an outlier only for a new hypothesis and bounded experiment. Reuse evidence for unchanged inputs.

<a id="retention-and-lifecycle"></a>

### Measuring what stays in memory after disposal

Record the warm baseline, what you dispose, which owners stay alive and when you sample. A detached view can leave a document and controller alive. Count surviving jobs, subscriptions and leases. Distinguish immediate readings from the next frame. Measure heap, DOM, native buffers, process peaks and GC separately when needed. Object counts alone cannot give their byte cost.

### Package qualification

CI uses .NET 10 and headless Chromium. The smoke restores from a local feed, stages assets through MSBuild, verifies archive hashes and public exports, and compiles the reference host with strict TypeScript. The consumer loads CSS and a host font, types in the mounted editor and runs a regex in the packaged worker. [Package setup](packaging.md)

Source demo tests can use the WebSocket fixture (`npm run demo -- --server-provider`) or its browser worker (`?provider=browser`). The static walkthrough covers the deployment prefix, editing and review, and worker failure and retry.

### Native-device checklist

Record the OS, browser version, keyboard layout, exact actions, expected text and selection, and what you saw. Mark unavailable checks as pending. [Support matrix](README.md#support-matrix)

| Equipment | What to try |
| --- | --- |
| French AZERTY, US QWERTY and US International keyboards | Character entry, shortcuts, AltGr, dead-key commit and cancel, focus and read-only transitions. |
| OS clipboard and application menus | Copy, cut and paste between applications. Check formats, permissions, history and native drag. |
| Browser lifecycle | Real navigation, shutdown, unsaved edits and draft recovery. For back/forward cache, require a trusted persisted `pageshow`, the browser restoration signal and the original document and editor. Verify text, selections, Undo and services after return. |
| Target devices and displays | Caret alignment, fallback fonts, touch, display scaling and responsiveness. Test Safari on Safari. |

Use an isolated profile for browser-history checks and keep the tested page active inside the headless browser so frames run. [Back/forward cache in Playwright](https://playwright.dev/docs/navigations#backforward-cache-bfcache)

## Contributor responsibilities

Run the owner regression while editing. Batch browser and package qualification at a coherent milestone. Measure changes that run on each keystroke or frame. [Contributor rules](../AGENTS.md)

## Not covered

Physical input, clipboard and display checks require the target device. [Support matrix](README.md#support-matrix)
