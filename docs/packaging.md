# Packaging

Decision: NuGet is the preferred distribution format. The package contains browser assets
and small MSBuild integration files, with no managed assembly or runtime dependencies.
The TypeScript implementation and browser APIs remain independent of .NET.
Compiled assets and staged consumer output include `UNICODE-LICENSE.txt` for the bundled
Unicode character-property data. Hosts retain that notice when bundling or deploying assets.
StTropez itself is released under the MIT license. `LICENSE.txt` is copied unchanged from the
repository into compiled assets, the NuGet payload, staged consumers and the static demo.
Both notices belong with bundled or deployed assets; NuGet metadata declares `MIT`.

The local evaluation package, minimal consumer and controlled version-transition proofs are
implemented. Release metadata and compatibility across released versions
and broader consumer toolchains remain pending. Nothing is published by these commands.

## Local proof

The restored-consumer gate also copies the staged asset folder into a host-owned local package
mount and resolves all five public exports through its shipped `package.json`. This check uses
neither TypeScript `paths` nor bundler aliases: strict NodeNext declaration checking, browser
bundling and Node asset resolution exercise the actual exports map. Private subpaths must be
rejected. No npm installation or library compilation occurs in that consumer.

Declaration finalization parses module syntax, including `import("…")` types, before rewriting
relative source extensions to JavaScript specifiers. A package check rejects any remaining
relative TypeScript module reference; unrelated string literals and comments are preserved.

Run `npm run test:package` with Node.js 24+, the pinned development tools, Chromium and a
.NET SDK 10+ installation. `npm run pack:nuget` first compiles the assets and creates
`artifacts/nuget/feed/StTropez.Assets.0.0.0-local.nupkg`. The pack project includes no managed
output or package dependencies. The local prerelease ID/version are evaluation metadata.

The default proof also restores fixture versions A→B→A in one isolated cache and generated-stage
parent. A adds a fixture-only optional worker; B has the original payload. Each step checks the
manifest-addressed root, exact file list and every asset hash, strict public declarations and
bundle isolation, visible CSS, actual keyboard editing and undo/redo with complete selections.
Old staged generations, package payloads and a host-owned sentinel stay unchanged. The first A
editor stays usable while later versions are restored. Returning to the original package reuses
B's root because its manifest and payload are identical. Repeating preparation is idempotent.

After packing, `node scripts/test-package.mjs --transitions-only` runs this focused qualification;
add `--browser=firefox` or `--browser=webkit` to select another engine. Reports are recorded in
`artifacts/package/transitions-<browser>.json`. These controlled local fixture versions qualify
the restore/staging mechanism; they do not claim arbitrary released-version compatibility,
native input or display latency. The focused mode records no timing distributions.

The proof inspects the actual ZIP entries and dependency metadata, checks SHA-256 integrity,
copies the package and generic fixture to a fresh OS temporary directory, and restores using
only a local feed and isolated package cache. TypeScript checks the restored declarations
with library checking enabled. esbuild bundles only consumer/restored files; the browser loads
explicit CSS and performs an edit verified against the model. It also applies a range edit
to the restored indexed buffer and checks newline conversion, line lookup and position maps.
The same restored modules mount the bounded input candidate, type through it and undo against
shared history. Its native context width comes from the restored CSS, with no checkout fallback.
It also captures a backward native selection immediately before detach, using the restored
candidate's synchronous view-capture API.
The restored resolver checks bidi levels/order, and actual visual keys traverse an RTL run.
The proof verifies the Unicode notice in the archive, generated stage and served consumer output.
It also advances a compiled `BidiCursor` over a large buffer and queries the immutable result
after disposal. The restored index controller validates expected revisions and releases its lease.
The browser font controller registers copied host-supplied bytes and releases only its owned
face. The consumer measures the registered face and queries compiled grapheme boundaries;
no custom font parser or shaping engine is shipped. See [native font registration](fonts.md).
The consumer also supplies a visible decoration callback and performs literal search/replace
plus undo through the restored find controller. Language service workers remain host-owned.
The restored comparison also uses buffer-based resource creation and exact line alignment,
mounts both panes, reverts a change and advances its captured reference version.
Host-owned compiler/bundler
executables are reused from development tooling; the editor package installs no npm package
and does not compile at consumer restore time. This is a source-isolation proof, not an OS
sandbox. The fixture has no source-checkout imports or runtime fallback.

`artifacts/package/report.json` records package hash, inspected entries, tool/browser versions,
visible CSS values and the actual result. `consumer.png` shows the restored view. The isolated
consumer directory is retained for inspection. This proof currently covers the pinned
TypeScript/esbuild versions only; it does not claim compatibility with every frontend tool.

The dedicated restored pilot page connects two independent source views and a comparison
to one document. Actual keyboard input continues during captured saves, remote conflict
review, a failed reviewed save and its retry. It checks captured server preconditions,
pending-save remounts, shared undo back to the saved value, redo from the other view, and
a canonical reply arriving after newer typing. Disposal during the final save releases
views and listeners; a late failure retains the exact unsaved source until explicit cleanup.
The host supplies deferred local ports and background activity; no application service is used.

`npm run test:package:pilot` runs the focused semantic proof on normal Unicode/CRLF and
100,000-line sources. `--browser=firefox` or `--browser=webkit` can be passed directly to
`node scripts/test-package.mjs --pilot-only` after packing. Its single sample per corpus
and screenshots are diagnostic evidence, not tail estimates. `npm run bench:package-pilot`
uses three warmups and ten measured workflows per corpus, without screenshots. The reports
retain raw samples and distinguish the input adapter handler, input to full review readiness
(all working views, immutable reference, caret, scans, diff and two animation frames), the
complete point-action automation proxy, and the whole workflow proxy including controls,
local settlement, oracles and cleanup. Workflow timings have no point-action budget.
Native IME/reconversion, OS clipboard and physical display latency
remain separate device checks. Pilot reports and images are under `artifacts/package/`.

The restored hunk scenario keeps a reviewed save pending while actual comparison controls
navigate between two changes and revert one. A later keyboard correction survives the old
receipt. Undo from the other view returns exactly to the captured saved value; redo restores
the correction, and a subsequent captured save remains valid through remount. Normal CRLF
and 100,000-line sources retain independent selections, immutable references, bounded views
and explicit cleanup. `npm run test:package:hunk` runs the focused semantic proof;
`npm run bench:package-hunk` collects three warmups and ten measured workflows per corpus.
Use `--browser=firefox` or `--browser=webkit` with `node scripts/test-package.mjs --hunk-only`
after packing; add `--bench` for repeated measurements. Default `test:package` covers both
coupled scenarios, while `--pilot-only` retains the separate recovery scenario.

Hunk click dispatch observations exclude preceding pointer/focus work and include synchronous
model subscribers between click capture and document bubbling. They are not exact adapter
handlers or complete traced callbacks. Full hunk readiness waits for the same view, caret,
scan, reference and comparison checks plus two frames. Complete action adds automation and
pointer/focus work. Hunk and whole-workflow clocks have no single-keystroke budget; only the
post-revert keyboard point is assessed against the declared typing targets. Initial mount
and initial readiness are outside the workflow clock; range oracles and cleanup are inside.

## Static preview and explicit activation

`npm run test:package:activation` restores an isolated consumer whose initial page shows exact
Unicode/CRLF text without requesting editor JavaScript, CSS or a worker. Its small host module
loads a separate compiled view entry and the packaged CSS only after **Edit** or **Read only**.
Read only can be the first action and mounts with its policy already applied. Keyboard focus
traversal to its control retains the source range. Failed module or
CSS loading retains the snapshot and offers retry with the requested mode. Cancelling activation
invalidates late responses before they can create a model or override a later mode choice.

The host reader keeps the complete source in native DOM text nodes. For longer files it groups
500 lines per block and uses `content-visibility: auto` to defer offscreen layout. A small native
DOM adapter maps text-node and element-boundary selections to raw source offsets, preserving
direction and CRLF boundaries through activation. This uses browser primitives without an
additional runtime dependency. Engines without that CSS optimization still retain the full text.
Native Find and clipboard behavior require device qualification; DOM
selection checks alone do not establish those capabilities. Native selection string serialization
can vary by engine even for a single text node; raw DOM Range text is the source-preservation oracle.

Reader keyboard commands stay inside the source: Ctrl/Meta+A selects its text, Home/End use
the current logical CR/LF line, and Ctrl+Home/End reach the source boundaries. Arrows, word
movement use native selection movement; vertical/Page commands use source rows and native caret
hit testing, retaining the visual column through short rows. Shift extends the range. Word
movement follows browser rules. The adapter normalizes CRLF/surrogate boundaries,
bridges DOM chunk boundaries and reveals the native text geometry in the reader's scroller.
Escape focuses **Edit**; Tab keeps normal host navigation. Deletion/history keys do not change
read-only text. Keyboard/pointer listeners share the host's abort/disposal lifecycle. These checks
cover automated desktop browser behavior, with native input, OS clipboard
still requiring the support records described above.

Full-document native selection remains a large-reader responsiveness limit. A registered
100,000-line, 900,044-unit Chromium 156 run recorded Select All p95 readiness of 441.2 ms
against a 250 ms target, a 332.7 ms keydown dispatch span and a 459.7 ms complete keyboard/observer
proxy. The dispatch span measures a navigation event; typing/input-handler and physical-display
clocks are separate. Selecting through reader-element endpoints did not remove the cost in a
bounded control. Functional keyboard and scoped release checks pass; the native snapshot's large
Select All responsiveness remains open. The snapshot remains an evaluation
fallback; native/total-process memory and production editing-engine readiness remain unqualified.

**Read only** mounts or remounts the bounded views with a per-view read-only policy.
Navigation, selection, copying and Find remain available; input, history and replacement commands
cannot mutate through those views. Resource permissions stay unchanged. **Edit** restores editing
with the same retained views, complete selection sets, scroll and shared undo history. This mode
transition makes no new editing-entry or CSS request. In the workspace consumer, both panes and
subsequently opened primary tabs retain the chosen mode.

A prior warm Chromium 156 workspace run used the 100k corpus (900,044 UTF-16 units),
two rendered panes, 100 inactive documents, 20 Hz progress and a pending captured job. Ten
observations after two warmups recorded Read only p95 readiness/action proxies of 82.2/119.4 ms
and Select All proxies of 50.6/54.9 ms. Select All's own navigation-key handler was 0.6 ms and
capture-to-post-target dispatch span 0.7 ms; neither measures a typing input handler or physical
display latency. These development-runner points qualify the bounded mode, not the native
snapshot, cold loads, population percentiles or production hardware.

First Read only activation was measured separately in fresh isolated browser contexts, with
module/CSS loading and model/view creation after the click included. The normal/100k corpus
recorded p95 readiness of 98.7/98.3 ms and complete action proxies of 144.4/135.2 ms, with no
editable focus or frame observed. Initial native snapshot/bootstrap construction was outside
those clocks; browser/server/OS caches were shared. This does not qualify cold process/network
startup, physical display or production devices.

The expanded large corpus contains 2,400,044 units. Existing restored journeys now exercise
beginning, middle and end edits/navigation, undo/redo, Find, mode transitions and captured jobs
at that size across three engines. A separate 12-action first-activation run recorded p95
readiness/action proxies of 97.7/123.0 ms, including requested module/CSS loading and view/model
creation after the click. Normal-corpus observations were retained. Scoped forced-GC Chromium
V8/DOM release checks also pass with large-source history; native/total-process/peak memory,
physical display and production-hardware qualification remain open.

**Show snapshot** explicitly detaches the views and Find controllers and removes the stylesheet,
leaving the native reader and retained model state. A new native range replaces the complete set
on reactivation only while its captured resource, document revision, tab generation, view and model
selection set remain current after asynchronous loading. Otherwise the current model selections
are kept. Composition and queued edits guard both transitions; caret repaint can be cancelled
safely. The regex worker is requested only after opting in
to regular expressions. Worker failure reports an unavailable search while typing and literal
Find remain usable. Final disposal releases models, views, subscriptions and leases and retains
the last committed text in the host preview. Module code already evaluated stays browser-cached.

The consumer uses only public declarations and precompiled restored assets. The report counts
host/bootstrap and editing JavaScript, CSS, worker and WASM bytes separately and retains actual
request paths. Normal and 100,000-line journeys exercise typing, complete selections, undo/redo,
switchback, failure/retry and disposal. Run the existing archive with
`node scripts/test-package.mjs --activation-only --browser=firefox` (or `webkit`) to check another
engine without rebuilding the library. Reports and images are `artifacts/package/activation-*`.
`--activation-only --prepare-only` and `--workspace-only --prepare-only` stop after the strict
isolated consumer build, allowing the same journeys to run under a separate browser lifecycle.
`--corpus=large` or `--corpus=normal` selects the existing journeys for that corpus in either
scenario; the default runs both. The large source contains 2,400,044 UTF-16 units with the same
Unicode/CRLF header, while the 116-unit normal control stays unchanged.
Own input-handler observations are not complete interaction latency or production percentiles.
This local host fixture does not qualify retained heap, native IME/OS clipboard,
durable storage, arbitrary deployment failures or a consuming application's adoption policy.

## Inactive-document workspace

`npm run test:package:workspace` extends the deferred activation host with two active panes,
100 initially inactive 1,000-line documents, and 20 Hz synthetic background activity. Normal
and 100,000-line active sources use the same restored public assets. All documents share one
workspace; resource, tab and view identities remain separate. Visited tabs retain lightweight
model-owned selection/view state, with no inactive editor DOM or observable subscriptions.

The primary document selector changes its captured tab while the peer stays usable. Shared
documents retain shared undo with independent complete selection sets. Find follows the newly
presented document. **Close primary tab** preserves its document/history; **Reopen closed tab**
creates a new tab identity and restores the retained view. **Discard closed document** captures
resource revision and close/reopen generation for explicit confirmation. Later edits or reopening
expire that request. Captured jobs retain their own immutable input and ownership until finish;
waiting for a job does not discard the saved view state. Final disposal stops background work
and releases models, views, listeners and leases. Durable handling of all owned documents remains
a consuming-host responsibility.

`node scripts/test-package.mjs --workspace-only --browser=firefox` (or `webkit`) reuses a packed
artifact. `artifacts/package/workspace-*` records ten switches, typing/shared undo, Find routing,
close/reopen and stale/delayed discard journeys, with DOM/resource/subscription bounds. Individual
handler observations are separate from full interaction and cold activation latency. These
counts do not prove retained heap bytes; native input and release qualification
remain open.

A separate fixed-budget experiment before the fragmented native reader, in Chromium
156.0.8078.4 on Windows build 26200, an i7-14700KF
and 28 logical CPUs checked retained V8 heap and DOM counters. Module code was warmed without
models; the host preview kept its text. Each corpus retained three forced-GC observations at
baseline, after warming two visited documents, after ten typing/undo switches and captured-job
close/reopen, and after disposal: 24 observations in total. No sample or failure was retried.

| Active corpus | Maximum post-disposal V8 increase | DOM node change | DOM listener change |
| --- | ---: | ---: | ---: |
| Normal | 1,781,704 bytes | +1 | −7 |
| 100,000 lines | 1,780,600 bytes | +1 | −7 |

Both passed the predefined 4 MiB V8 increase, 32 extra nodes and no extra listeners limits.
Workspace resource/document/tab/view/lease/subscription counts all returned to zero; those
logical subscriptions are separate from the browser's DOM listener counter. Backing-storage
and embedder heap fields were recorded without a pass criterion. The large read-only baseline
alone reported about 95.2 MB of embedder heap before any editor models existed. These results
therefore do not qualify total process, native-layout or peak memory, GC pauses, other engines,
or interaction latency. Production scope and native input gates remain open.

## Build bridge

Restore imports `build/StTropez.Assets.props` and `.targets` and exposes `StTropezAssetRoot`.
No staging target runs automatically. The host can resolve that immutable root directly, or
explicitly invoke `StTropezPrepareAssets` with `StTropezStageDirectory` set to a dedicated
generated directory. `StTropezPreparedRoot` then identifies a subdirectory addressed by the
asset manifest hash. This prevents differently built versions from mixing stale chunks;
the target copies allowlisted extensions and never deletes files. Old stages are owned and
cleaned by the host. The generic consumer's `PrepareFrontend` target demonstrates this API.

The host configures TypeScript paths and bundler aliases for `sttropez` and `sttropez/browser`
from the selected root, then includes `editor.css` explicitly. The package metadata also
declares ESM entry points. The manifest records entry points, sizes and SHA-256 per asset.
Declaration specifiers use `.js`, allowing ordinary consumer resolution without source `.ts`
files or consumer-time editor compilation.

## Artifact contents

Use one versioned `.nupkg` with an explicit file allowlist:

| Content | Purpose |
| --- | --- |
| `assets/` JavaScript ES modules | Headless model and browser view entry points |
| `assets/` TypeScript declarations | Compile-time API for frontend consumers |
| `assets/` scoped CSS | Editor styling, incorporated through the host stylesheet pipeline |
| `assets/` module metadata and manifest | Entry points, asset versions and integrity information |
| `build/` MSBuild properties/targets | Expose the restored asset root and an explicit preparation target |
| Package metadata, README and selected license | Versioning and distribution terms |

The optional regex backend ships a standalone compiled `assets/browser/regex-worker.js` module;
`entries.regexWorker` identifies it. The host deploys that asset and supplies its URL through
`createRegexFindBackend`. Literal find starts no regex worker. Missing or failed regex workers
report unavailability and leave ordinary editing usable; there is no main-thread regex fallback.
The restored consumer proves actual worker matching, capture replacement, complete-set undo,
raw zero-width navigation and cleanup on a 100,000-line captured source.

Any later workers or justified WASM must travel in the same versioned asset set and have
manifest entries for host deployment. Source maps, when supplied, contain only project-owned paths
and sources. Research, roadmap, tests, development dependencies and local artifacts are excluded.

NuGet supports arbitrary packaged files and build properties/targets; it does not require
this component to become a .NET library. See the [package format reference](https://learn.microsoft.com/en-us/nuget/reference/nuspec)
and [MSBuild package integration](https://learn.microsoft.com/en-us/nuget/concepts/msbuild-props-and-targets).

## Consumer build contract

1. The consuming build pins one package version and restores it through its NuGet feed.
2. Package properties expose the immutable restored asset root. A preparation target may
   stage an allowlisted asset set into a dedicated generated directory chosen by the host.
   It never edits frontend source, the package cache, package-manager stores or lockfiles.
3. The host configures TypeScript and its bundler to resolve the module entry points from
   that location. CSS is explicitly included in the stylesheet build or static-asset output.
4. The ordinary application pipeline bundles/deploys the browser assets. No browser request
   to a package registry, install-time compiler or editor-specific server runtime is required.

The frontend resolution bridge is necessary: NuGet restore alone does not make JavaScript
imports or TypeScript declarations resolvable, and a build may deliberately ignore CSS imports.
Demonstrate both code and styles in a clean consumer fixture before claiming integration.
Prefer an explicit package reference on the project owning the frontend build; enable transitive
build behavior only for a consumer that needs it. The staging target must not perform network
access or invoke a second package installation.

The NuGet version is the authority for the delivered assets. There is no separately versioned
npm dependency to keep synchronized. `package.json` remains useful for development tooling
and module metadata; publishing to an npm registry is unnecessary. An ASP.NET-specific static
asset wrapper can be considered for another consumer later, but is not the core delivery model.

## Producer build and qualification

- Build JavaScript, declarations and CSS from the repository's pinned development tools.
  Pack that output with NuGet tooling; do not rebuild TypeScript during consumer restore.
- Keep development Node/TypeScript requirements distinct from consumer compatibility. Test
  declarations with the declared consumer compiler versions and modules with their bundlers.
- Inspect the actual `.nupkg` against the allowlist, including dependency metadata and imports.
  A JavaScript package dry run is useful evidence for `dist/`, not proof of NuGet contents.
- Restore an exact package into a clean fixture with no access to the source checkout or
  ignored research. Typecheck, bundle, load CSS and perform an actual browser edit from it.
- Test incremental rebuild, version upgrade/downgrade and stale-file handling only within the
  dedicated generated asset directory. Never delete a computed path without validating it.
- Keep all asset versions coherent, including any optional worker/WASM files. Validate both
  development and production builds, and distinguish local packing from publishing a release.

Package ID and feed are release metadata decisions; the license is MIT. No package publication or
application-specific build change is implied by this document.

`npm run test:package:react` runs the existing React development host against a locally
restored package. It copies only project-owned host fixtures into the temporary consumer,
rewrites their public editor imports, and checks declarations with strict TypeScript and
`skipLibCheck: false`. The bundle accepts restored compiled editor modules and the host's
already installed React packages; it neither compiles editor implementation sources nor
installs another dependency. React stays outside the editor assets.
The compiler's actual input list is retained and checked against the consumer directory and
the host's compiler, React and CSS declaration packages, so type imports cannot fall back
to checkout editor sources.

The coupled scenario covers keyboard navigation/backward selection, proposal correction,
shared undo/redo, save failure and retry,
remote conflict review, actual hunk reversion, typing during captured saves, canonical
replies, captured Run/configuration, retained-view remount and explicit disposal. It uses
Unicode/CRLF and 100,000-line inputs under development Strict Mode.
Automated non-ASCII input retains the browser's input/composition event sequence and requires
one exact document/history commit; this does not qualify a native IME.
Select another installed engine with `node scripts/test-package.mjs --react-only --browser=firefox` or `--browser=webkit`
after packing. `--prepare-only` checks declarations and bundling without starting a browser.

`npm run bench:package-react` retains three warmup and ten measured workflows per corpus.
Only the isolated point keystroke has handler, all-pane readiness and complete automation
action targets. Setup and the full workflow have separate elapsed clocks; workflow time
includes controls, assertions and local service settlement. These measurements do not
establish physical display latency, native IME, platform clipboard
behavior. A prepared consumer alone is not a completed runtime qualification.
