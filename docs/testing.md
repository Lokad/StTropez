# Testing

Put each regression where its failure is observable. A stale save needs a model and a held reply. A
misplaced caret needs a browser.

## Use

Install the locked dependencies and select the affected suite.

```sh
npm ci
npm run browsers:install
node --test tests/input-context.test.ts tests/input-target.test.ts
npm run test:browsers -- --project=chromium --project=firefox --project=webkit tests/browser/input-target.spec.ts
```

| Command | Coverage |
| --- | --- |
| `npm run format`, `npm run check:format` | Format or check TypeScript and JavaScript in the examples and contributor scripts |
| `npm run typecheck`, `npm run check:docs` | Strict projects, compiled handbook examples, links, prose and public index |
| `npm test` | Models, host policy and integration. Pass the owning test file to `node --test` for a focused run. |
| `npm run test:browser`, `test:browsers` | Full source suite in Chromium (CI) or all three engines |
| `npm run check` | Formatting, types, docs, models, integration and the library build |
| `npm run inspect` | Screenshots of the demo and reference host in `artifacts/inspect/` |
| `npm run build:demo`, `npm run test:demo` | Build and exercise the static deployment |
| `npm run test:package` | Restore and run one consumer |
| `npm run bench`, `bench:all` | Model and editing benchmarks or all four suites |

Use a separate test server. Source tests use `STTROPEZ_PORT` (default 4183). Static tests take
`STTROPEZ_DEMO_PORT` locally or `STTROPEZ_DEMO_URL` for a deployment.

## Contract

<a id="documentation-gate"></a>

### What the documentation check catches

After changing exports, run `npm run check:docs -- --write-api-index`. The check verifies the public index,
local links and anchors. The handbook shares a 14,000-word prose budget across its guides. Tables, code,
and the generated index are excluded. API examples compile against public entries. Use `file=app.js` and
companion filenames to compile a tutorial together. Type errors cite Markdown lines. [Public index](api.md)

After changing a default binding, run `node scripts/editor-shortcuts.mjs --write`. It reads the command
registries on a mounted editor and comparison in headless Chromium with each platform setting.
Omit `--write` to compare the handbook with the current bindings. [Keyboard reference](editor.md#default-key-bindings)

<a id="test-ownership"></a>

### Where to put a regression test

Extend the case that already reaches the failure. Model tests own text, history, fold mapping, permissions
and revision checks. Browser tests own native-event routing, focus, geometry and paint. The plain host owns
shared workflows, React owns attachment and render isolation, and a shadow root exercises event retargeting.

| Feature | Model owner | Browser owner |
| --- | --- | --- |
| Typing and Undo | [Input targets](../tests/input-target.test.ts), [history](../tests/history.test.ts) | [Input events](../tests/browser/input-target.spec.ts), [editing](../tests/browser/editing.spec.ts) |
| Find and replace | [Match retention](../tests/find-retention.test.ts), [regex](../tests/find-regex.test.ts) | [Search in an editor](../tests/browser/language-find.spec.ts) |
| Shortcuts, completion and navigation | [Keymap](../tests/editor-keymap.test.ts), [completion](../tests/completion-controller.test.ts), [navigation](../tests/navigation-controller.test.ts) | [Controls](../tests/browser/editor-controls.spec.ts), [pane attachments](../tests/browser/editor-language-attachment.spec.ts) |
| Folding and minimap | [Fold projection](../tests/folding.test.ts), [discovery](../tests/fold-discovery.test.ts) | [Disclosure and Undo](../tests/browser/folding.spec.ts), [minimap gestures and review](../tests/browser/minimap.spec.ts) |
| Pane lifetime and scroll | [Navigation history](../tests/navigation-history.test.ts) | [Remount and reveal](../tests/browser/editor-view-state.spec.ts), [viewport paint](../tests/browser/viewport-presentation.spec.ts) |
| Save and conflicts | [Review and adoption](../tests/save-review.test.ts) | [Competing reference-host tabs](../tests/browser/reference.spec.ts) |
| Comparison | [Baselines and reversion](../tests/comparison.test.ts) | [Review panes](../tests/browser/comparison.spec.ts) |
| Rename and code actions | [Rename](../tests/provider-rename.test.ts), [action reviews](../tests/provider-actions.test.ts) | [Controls](../tests/browser/editor-controls.spec.ts) |
| Hover | [Inspection](../tests/hover-controller.test.ts) | [Hover actions](../tests/browser/editor-controls.spec.ts) |
| Clipboard | [Copy and paste edits](../tests/clipboard-edits.test.ts) | [Event delegation](../tests/browser/clipboard-delegation.spec.ts) |

CI runs the full Chromium suite. Firefox and WebKit also exercise input routing, pointer capture, text
geometry and page-local clipboard events. CI checks the shortcut table against the mounted commands.

```sh
npm run test:input-browsers
```

For a race, [hold the reply](../tests/helpers/lsp-replies.ts), edit or close its target, then release it.
Assert the resulting document, selection and whether a fresh action works. For Save, check stored text and
later dirty edits. [Save retries](../tests/browser/save-conflicts.spec.ts) ·
[Remount](../tests/browser/host-attachment.spec.ts) ·
[WebSocket](../tests/browser/protocol-websocket.spec.ts)

### Fixtures and test hooks

Read text from a fixture range. Inspect rendered rows for layout or color. Keep demo probes with their
scenario. Use the [fixture bundler](../tests/helpers/fixture-modules.ts) for direct source imports.
Playwright retains failure traces. Match injected errors by message and source URL.
[Browser error checks](../tests/helpers/browser-errors.ts)

<a id="readiness-and-visible-continuity"></a>

### When is the editor ready for an assertion?

Use the [readiness helper](../tests/fixtures/readiness.ts) for the surface under test.

| Helper | Waits for |
| --- | --- |
| `viewportSettled` | Live viewport, no pending frame, painted revision, selections and fold generation match the view |
| `editorSettled` | Settled viewport, no captured host insertion, and finished caret and drag-scroll frames |
| `comparisonSettled` | Ready diff, settled editors and finished scroll/alignment with matching IDs when aligned. Alignment failure throws. |

Assert the actual text, selection direction and affinity. Wait separately for a required service reply,
decoration or baseline. During a thumb drag or middle edit, sample visible text beside its gutter number and
syntax on each pane. A final screenshot misses transient blanks and color flashes. Poll activity during
timing. Read retention diagnostics afterward.

### Workloads

Replay [seeded workloads](../tests/fixtures/workloads.ts) with the same draw order, range mapping and
oracle. Vary rows, line length and token density within the [document limit](README.md#support-matrix).
`normal` supplies small source, `lines-100` and `lines-10000` repeat 24-unit lines, and `unicode` mixes
tabs, graphemes and line endings. Vary open views and background updates for workspace tests.

At milestones, run `node scripts/benchmark-editing.mjs --commands-only` on an idle machine. The full editing
benchmark includes the same check. Each command gets five fresh Chromium pages with syntax, 40 collapsed folds
and the minimap. The 14,413-line source is 512,000 bytes with spaces and 490,382 bytes with tabs.
Growing edits start with shorter comments so their results also fit the limit. Whole-document indentation,
comment toggles, Undo/Redo, line movement, multi-caret word deletion and vertical navigation
must reach the model within a 25 ms median and the first matching editor render within 33 ms. The report
keeps individual samples in `artifacts/bench/editing/commands.json`. Capture-to-bubble dispatch also includes
other listeners. Physical display needs a device measurement.

### Unicode regeneration

Verify `<name>.txt` and `license.txt` against the [pinned inputs](../scripts/unicode-inputs.json).

```sh
node scripts/generate-unicode-fixtures.mjs /path/to/reviewed/grapheme --check
```

Omit `--check` to regenerate the character-warning ranges and compressed test fixtures. Builds use the checked-in
output.

### Measurement policy

Choose a model, editing, viewport or comparison [suite](../scripts/benchmark-suites.mjs).

```sh
npm run bench:all -- --list
node scripts/run-benchmarks.mjs --suite=viewport --list
npm run bench:comparison
```

Pass workload arguments to one suite. The group runner records its inputs and output in
`artifacts/bench/campaigns` and stops on failure. Only success updates the latest report. Reuse it when
inputs and configuration match.

Name the start event and readiness condition. For typing, report handler time, time through painted text and
selection, and the full action. For bulk edits, include the longest uninterrupted step. Include required
service delays. A display measurement requires a device.
[Clock definitions](README.md#measuring-an-interaction)

Check the result before timing. Record source, lockfile, build mode, seed, corpus, machine, OS, browser,
viewport, font, load, power and raw samples. Separate cold and warm runs. Alternate comparisons on the same
machine and trace separately. Nested intervals can overlap. Report counts, maxima and nearest-rank
percentiles. Below 20 samples, label the maximum. Retain failures. Retry only with a new hypothesis and
bounded experiment.

<a id="retention-and-lifecycle"></a>

### Measuring what stays in memory after disposal

Record the warm baseline, owners disposed and retained, and sampling time. Count surviving jobs,
subscriptions and leases immediately and after a frame. A detached pane can leave a document alive. To
measure bytes, sample heap, DOM, native buffers or process memory and record GC.

### Package qualification

The .NET 10/Chromium smoke restores a local package, stages assets with MSBuild, checks hashes and exports,
and compiles the reference host. The consumer loads CSS and a font, types and runs the packaged regex
worker. [Package setup](packaging.md)

The source and deployed demos use the same browser language worker. The static walkthrough checks asset
paths, editing, review and worker retry. A separate integration test starts the Node language server and
exercises its WebSocket bridge. [Bridge interop](../tests/integration/demo-provider.test.ts)

### Native-device checklist

Record OS, browser, keyboard layout, exact action, expected text and selection, and visible result. Keep
unavailable checks pending. [Support matrix](README.md#support-matrix)

| Equipment | Checks |
| --- | --- |
| French AZERTY, US QWERTY, US International | Typing, shortcuts, AltGr, dead-key commit/cancel, focus and read-only transitions |
| OS clipboard and menus | Cross-application formats, permissions, history, cut, copy, paste and native drag |
| Browser lifecycle | Navigation, shutdown and draft recovery. For back/forward cache, require a trusted persisted `pageshow`, the browser restoration signal and the original editor/document. Verify selection, text, Undo and services. |
| Devices and displays | Caret, fallback fonts, touch, scaling and responsiveness. Use Safari for Safari checks. |

Run browser-history tests in an isolated profile. Keep the page active inside the headless browser so frames
run. [Playwright navigation](https://playwright.dev/docs/navigations#backforward-cache-bfcache)

## Contributor responsibilities

Run focused regressions while editing. Batch broad browser and consumer qualification. Measure changes on
the keystroke or frame path. [Contributor rules](../AGENTS.md)

[Physical input and display support](README.md#support-matrix)
