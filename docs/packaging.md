# Packaging

Decision: NuGet is the preferred distribution format. The package contains browser assets
and small MSBuild integration files, with no managed assembly or runtime dependencies.
The TypeScript implementation and browser APIs remain independent of .NET.
Compiled assets and staged consumer output include `UNICODE-LICENSE.txt` for the bundled
Unicode character-property data. Hosts retain that notice when bundling or deploying assets.
The project-wide release license remains a separate decision.

The local evaluation package and minimal consumer proof are implemented. Release metadata,
license selection, version upgrade/downgrade qualification and broad consumer compatibility
remain pending. Nothing is published by these commands.

## Local proof

Run `npm run test:package` with Node.js 24+, the pinned development tools, Chromium and a
.NET SDK 10+ installation. `npm run pack:nuget` first compiles the assets and creates
`artifacts/nuget/feed/StTropez.Assets.0.0.0-local.nupkg`. The pack project includes no managed
output or package dependencies. The local prerelease ID/version are evaluation metadata.

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
The compiled advance builder also constructs 2.4 million numeric entries, releases its input,
queries beyond native coordinate limits and splices while retaining the old root. Its windows
check bounded traversal, negative/zero cells and shared numeric leaves. This tests measured-value
storage; the consumer does not claim a complete font shaper or global glyph projection.
The compiled font-data reader also maps an original host-generated font, reads nominal metrics
and variation glyphs, and constructs an advance index. The browser font controller loads those
same copied bytes, verifies native kerning/ligature widths and releases its owned native face
while captured core metrics survive. The fixture supplies its own font bytes; no font asset or
third-party font dependency is added to the editor package. These checks do not qualify complete
shaping or global layout; see [owned font data](fonts.md).
The restored GSUB plan also forms the fixture's actual ligature, verifies its nominal advance
against the native width and retains both source components. This proves compiled substitution
data/application and declarations; it does not qualify a complete script/positioning engine.
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
Native IME/reconversion, OS clipboard, assistive technology and physical display latency
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

Optional workers and WASM, if later justified, travel in the same versioned asset set. The
manifest must identify them so the host can deploy and resolve their URLs. They remain lazy
features with tested fallbacks. Source maps, when supplied, contain only project-owned paths
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

Package ID, feed and license are release metadata decisions. No package publication or
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
establish physical display latency, native IME, platform clipboard or assistive-technology
behavior. A prepared consumer alone is not a completed runtime qualification.

The separate [horizontal positioning stage](positioning.md) reuses owned GSUB provenance,
implements explicit GPOS/legacy policies and publishes retained signed pen advances.
The clean consumer also exercises the compiled [Unicode pipeline](unicode-shaping.md), including
compatibility decomposition, nominal mapping and repeated original source components through a ligature.
It also exercises compiled contextual script interpretation, cooperative glyph partitions and owned
subrun views feeding separate feature plans.
