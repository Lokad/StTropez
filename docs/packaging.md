# Packaging

StTropez distributes compiled browser modules, declarations, CSS and a regex worker in an
assets-only NuGet package. The package exposes files and an explicit staging target; the
host's frontend pipeline resolves, bundles and deploys them. Browser implementation and
execution are independent of .NET.

## Use

Reference `StTropez.Assets` directly from the project that owns the frontend. This example
uses the producer's local package version; configure a feed containing that exact artifact.
Choose a dedicated generated directory for staging.

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <EnableDefaultItems>false</EnableDefaultItems>
    <StTropezStageDirectory>$(MSBuildProjectDirectory)/obj/sttropez</StTropezStageDirectory>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="StTropez.Assets" Version="[0.0.0-local]" />
  </ItemGroup>
  <Target Name="PrepareFrontend" DependsOnTargets="StTropezPrepareAssets">
    <WriteLinesToFile File="$(MSBuildProjectDirectory)/assets-root.txt"
                      Lines="$(StTropezPreparedRoot)" Overwrite="true" />
  </Target>
</Project>
```

Restore the project, then invoke its explicit preparation target:

```sh
dotnet restore Consumer.csproj
dotnet msbuild Consumer.csproj -target:PrepareFrontend
```

Read the generated `assets-root.txt` in the host build. Either expose that complete folder
as a host-owned local package using its `package.json`, or configure TypeScript declaration
paths and bundler aliases from the entry table below. NuGet restore does not configure
frontend resolution or install an npm package. Application code uses the public entry points:

```ts
export * as model from "sttropez";
export * as browser from "sttropez/browser";
export * as protocol from "sttropez/protocol";
```

Include `editor.css` explicitly in the host stylesheet or static-file pipeline. If the host
serves the asset folder at `./sttropez/`, it can load the stylesheet with:

```html
<link rel="stylesheet" href="./sttropez/editor.css">
```

Deploy `browser/regex-worker.js` at a host-selected URL when enabling regex search and supply
the [search worker factory](search.md#regular-expressions-and-worker-limits). Keep both license notices with bundled
or deployed assets. Continue with [editor embedding](getting-started.md).

## Contract

### Package contents and entry points

The package contains no managed assembly or runtime package dependencies. Compiled modules
target ES2022 and use ESM with shared chunks. Declarations use relative `.js` module
specifiers; consumers need no library source files or consumer-time library compilation.

Paths in this table are relative to the restored `assets/` folder or prepared root:

| Public import | JavaScript/asset | Declaration |
| --- | --- | --- |
| `sttropez` | `index.js` | `index.d.ts` |
| `sttropez/browser` | `browser/index.js` | `browser/index.d.ts` |
| `sttropez/protocol` | `protocol/index.js` | `protocol/index.d.ts` |
| `sttropez/editor.css` | `editor.css` | — |
| `sttropez/regex-worker.js` | `browser/regex-worker.js` | — |

The shipped `package.json` declares these exports, ESM and MIT licensing, with no dependency
installation. Private declaration files support public types; their presence does not expose
private runtime subpaths through the exports map. Keep shared chunks with their importing
modules unless the host bundler rewrites the complete module graph.

| Archive location | Contents |
| --- | --- |
| `assets/` | Compiled `.js`, `.d.ts`, `.css`, `package.json`, `manifest.json`, `LICENSE.txt` and `UNICODE-LICENSE.txt` |
| `build/` | `StTropez.Assets.props` and `StTropez.Assets.targets` |
| Package root/metadata | Package README, NuGet manifest and packaging metadata |

Source implementation, source maps, tests, research and development dependencies are outside
the payload. The regex worker is a standalone compiled module without shared-chunk imports.
Its loading, cancellation and failure behavior belong to the [search contract](search.md).

### Manifest and versions

`manifest.json` has `schemaVersion: 1`, a build version label, an `entries` object and an
`assets` array. Each asset records its relative slash-separated `path`, byte count and SHA-256.
The array includes metadata and both license notices, and excludes the manifest itself.

| Manifest entry | Path |
| --- | --- |
| `core` | `index.js` |
| `browser` | `browser/index.js` |
| `protocol` | `protocol/index.js` |
| `types` | `index.d.ts` |
| `css` | `editor.css` |
| `regexWorker` | `browser/regex-worker.js` |

The NuGet package version identifies the archive selected by the host. The producer defaults
to `StTropez.Assets` version `0.0.0-local`; generated module metadata and the manifest also use
that build label. The embedded label is not a released-version compatibility negotiation.
There is no separately installed npm dependency to keep synchronized.

### MSBuild preparation

Restore exposes `StTropezAssetRoot` through the package's build properties. The root points
to the immutable restored asset directory. The host can resolve it directly or invoke
`StTropezPrepareAssets` with `StTropezStageDirectory` set. Preparation is not attached to
ordinary restore/build targets.

Preparation hashes the manifest bytes with SHA-256, sets `StTropezPreparedRoot` to a
subdirectory named by that hash, and copies the allowlisted file kinds while preserving
their relative paths. Identical manifests select the same root even when package versions
differ. Different manifests select different roots, so a host does not combine generations
by copying every package into one shared folder.

The target skips unchanged copies and never deletes old stages. It does not install packages,
compile TypeScript, access the network or rewrite application source/lockfiles. The host owns
the staging location and any cleanup. The target checks that a stage directory was supplied;
it does not choose or validate a safe application-specific destination for the host.

The directory hash identifies manifest content. Preparation does not compare each copied
payload against the hashes listed in that manifest, and a hash is not an authenticity check.
The producer's package qualification verifies file lists and payload hashes separately.

These files use NuGet's standard `build/` imports; the package supplies no `buildTransitive/`
integration. See [MSBuild properties and targets in NuGet packages](https://learn.microsoft.com/en-us/nuget/concepts/msbuild-props-and-targets)
for restore/import behavior and [NuGet package metadata](https://learn.microsoft.com/en-us/nuget/reference/nuspec)
for archive metadata.

### Producer contract

The producer uses the repository's pinned development packages, Node.js 24 or later and
a .NET SDK able to build its `net10.0` packaging project. These are producer/tooling
requirements; the browser assets have no managed runtime dependency.

`npm run build` clears the library output directory, bundles the public module entries and
standalone regex worker, emits strict declarations, rewrites declaration source specifiers
and generates module metadata plus the asset manifest. Runtime bundling rejects inputs
outside `src/`. StTropez's MIT notice and the Unicode data notice are copied unchanged.

`npm run pack:nuget` builds those assets, restores the packaging project and packs the
allowlisted output. The pack target requires a compiled manifest and excludes managed build
output/dependencies. Local packing creates an archive; registry publication is a separate action.

`npm run test:package` qualifies an actual archive through an isolated restored consumer,
including archive membership/hashes, exports and strict declarations, host bundling, CSS,
worker deployment and browser interactions. It also exercises controlled version/staging
transitions. Within one qualification run, scope-specific checks reuse an immutable archive
and restored root with package-hash checks and an unchanged-source guard.
See [qualification](testing.md) for test ownership.

### Bounds and validation

| Boundary | Enforcement |
| --- | --- |
| Runtime inputs | Library bundling permits only project `src/` inputs; development packages stay outside the graph |
| Public module resolution | The shipped exports map names three module entries and two asset entries |
| Package payload | Explicit file allowlist; no managed output or runtime dependencies |
| Declaration portability | Relative source extensions rewritten as JavaScript module specifiers |
| Preparation destination | Nonempty host-supplied path; host owns containment and cleanup |
| Stage identity | SHA-256 of manifest bytes; payload hash verification is a separate qualification check |
| Worker deployment | One standalone module asset; host supplies URL and worker factory |

## Host responsibilities

Pin a package version and configure its feed. Reference it on the project that owns the
frontend build, choose an isolated generated staging directory and retain one coherent asset
set. Configure both declaration and runtime resolution, include CSS, and deploy the worker
when used. The host owns its compiler, bundler, HTTP serving and cache policy.

Retain `LICENSE.txt` and `UNICODE-LICENSE.txt` with redistributed assets. Validate a consuming
build through its actual output and browser behavior. Package restore alone does not establish
that imports, styles or workers reach the deployed application.

## Not covered

See the [support matrix](README.md#support-matrix) for distribution and consuming-host boundaries.
