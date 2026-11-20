# Packaging

`StTropez.Assets` is an assets-only NuGet package. It supplies compiled modules, TypeScript
declarations, CSS and a regex worker. The host bundles and serves them. The browser needs no .NET
runtime.

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

Read `assets-root.txt` in the frontend build. Use that directory as a local package via its
`package.json`, or configure TypeScript paths and bundler aliases from the entry table below. The
host resolves the public imports after restore.

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

For regex search, deploy `browser/regex-worker.js` and pass its URL to the host’s
[worker factory](search.md#regular-expressions-and-worker-limits). Ship both license notices with
the assets. See [editor embedding](getting-started.md) for the next step.

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

The archive excludes source, source maps, tests, research and development dependencies. The
[regex worker](search.md) is a standalone module with no shared-chunk imports.

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

Select the archive by its NuGet version. Local builds default to `StTropez.Assets` version
`0.0.0-local`. The manifest and module metadata record the build label. There is no runtime
version negotiation.

### MSBuild preparation

After restore, `StTropezAssetRoot` points to the immutable assets directory. Use it directly or set
`StTropezStageDirectory` and invoke `StTropezPrepareAssets`. Staging requires an explicit call.

`StTropezPreparedRoot` is a subdirectory named for the SHA-256 hash of the manifest bytes. The
target copies allowed file types there, preserving relative paths. Packages with identical manifests
share a stage. Different manifests get separate directories.

The target requires a staging path. The host chooses a safe location and cleans up old stages.
Preparation skips unchanged files and runs offline, without installing packages, compiling
TypeScript or rewriting source and lockfiles.

The staging hash identifies the manifest. The producer’s package checks verify the file list and
individual payload hashes. Staging itself provides no payload verification or authenticity check.

These files use NuGet's standard `build/` imports; the package supplies no `buildTransitive/`
integration. See [MSBuild properties and targets in NuGet packages](https://learn.microsoft.com/en-us/nuget/concepts/msbuild-props-and-targets)
for restore/import behavior and [NuGet package metadata](https://learn.microsoft.com/en-us/nuget/reference/nuspec)
for archive metadata.

### Producer contract

Building the package requires the pinned development packages, Node.js 24 or later and a .NET SDK
that supports `net10.0`.

`npm run build` clears library output, bundles the public entries and worker, emits strict
declarations, rewrites declaration specifiers and generates metadata and the manifest. The bundler
accepts runtime inputs only from `src/`. The build copies both license notices unchanged.

`npm run pack:nuget` builds the assets, restores the packaging project and packs the allowed files
into a local archive. Packing requires the compiled manifest and excludes managed build output and
dependencies. Publishing is separate.

`npm run test:package` restores the archive into an isolated consumer and checks membership, hashes,
exports, declarations, bundling, CSS, worker deployment and browser behavior. It also exercises
version and staging changes. Checks within a run reuse the archive and restored root after verifying
the package hash and unchanged source. See [qualification](testing.md).

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

Pin the package and feed in the frontend build project. Stage one asset set, configure declaration
and runtime resolution, include the CSS and deploy the worker if used. The host supplies the
compiler, bundler, HTTP server and cache policy.

Redistribute `LICENSE.txt` and `UNICODE-LICENSE.txt`. Test imports, styles and workers from the
consuming application’s built output.

## Not covered

See the [support matrix](README.md#support-matrix) for distribution and consuming-host boundaries.
