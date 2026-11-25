# Packaging

Restore `StTropez.Assets` with NuGet to get the JavaScript modules, TypeScript declarations,
stylesheet and regex worker for your frontend. The browser runs the compiled JavaScript.

## Use

Add a direct package reference to the project that builds your frontend. The example expects
`0.0.0-local` in your NuGet feed and stages the assets under `obj/sttropez`. Use the exact
version you intend to deploy and a directory reserved for generated files.

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

Restore the project, then run `PrepareFrontend` to write the staged directory to `assets-root.txt`.

```sh
dotnet restore Consumer.csproj
dotnet msbuild Consumer.csproj -target:PrepareFrontend
```

Point the frontend build at the directory in `assets-root.txt`. Its `package.json` resolves
the following imports. If you configure TypeScript paths and bundler aliases by hand, use the
same [entry points](#package-contents-and-entry-points) for both.

```ts
export * as model from "sttropez";
export * as browser from "sttropez/browser";
export * as protocol from "sttropez/protocol";
export * as kernels from "sttropez/kernels";
```

Include `editor.css` in your stylesheet bundle or serve it directly. For an asset folder
at `./sttropez/`, add this to the page.

```html
<link rel="stylesheet" href="./sttropez/editor.css">
```

If you enable regex search, deploy `browser/regex-worker.js` and pass its URL to your
[worker factory](search.md#regular-expressions-and-worker-limits). Once the page can import
the modules and load the CSS, [mount your first editor](getting-started.md#open-the-first-editor).

## Contract

### Package contents and entry points

The package contains ES2022 modules with shared chunks. Its declarations import relative
`.js` paths. Your frontend can use them without compiling StTropez or installing any library
dependencies. The package has no managed assembly and the browser needs no .NET runtime.

Paths are relative to the restored `assets/` folder or the staged directory.

| Public import | JavaScript/asset | Declaration |
| --- | --- | --- |
| `sttropez` | `index.js` | `index.d.ts` |
| `sttropez/browser` | `browser/index.js` | `browser/index.d.ts` |
| `sttropez/protocol` | `protocol/index.js` | `protocol/index.d.ts` |
| `sttropez/kernels` | `kernels/index.js` | `kernels/index.d.ts` |
| `sttropez/editor.css` | `editor.css` | — |
| `sttropez/regex-worker.js` | `browser/regex-worker.js` | — |

Use `sttropez/kernels` for standalone text algorithms, position maps, JSON-RPC connections, LSP sessions and diagnostic decoding. The editor and language clients load their own implementations.

The package declares these exports, the ESM module format and the MIT license in `package.json`.
Private `.d.ts` files describe types used by the public API. Only the paths in the exports map
are public imports. If you serve the modules directly, keep the shared chunks beside them. A
bundler can relocate chunks if it also rewrites the imports.

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
| `kernels` | `kernels/index.js` |
| `types` | `index.d.ts` |
| `css` | `editor.css` |
| `regexWorker` | `browser/regex-worker.js` |

Select the archive by its NuGet version. Local builds default to `StTropez.Assets` version
`0.0.0-local`. The manifest and module metadata record the build label. There is no runtime
version negotiation.

### MSBuild preparation

After restore, `StTropezAssetRoot` points to the immutable assets directory in the NuGet cache.
Use that directory directly, or set `StTropezStageDirectory` and call `StTropezPrepareAssets`
to copy the files into your build.

`StTropezPreparedRoot` is a subdirectory named for the SHA-256 hash of the manifest bytes. The
target copies allowed file types there, preserving relative paths. Packages with identical manifests
share a stage. Different manifests get separate directories.

Staging runs offline and skips unchanged files. It only copies assets. Your build owns the
staging path and cleanup of old directories. The directory hash identifies the manifest. To
verify a staged file, compute its SHA-256 and compare it with the hash recorded for that file.
Staging doesn't authenticate the package.

These files use NuGet's standard `build/` imports; the package supplies no `buildTransitive/`
integration. See [MSBuild properties and targets in NuGet packages](https://learn.microsoft.com/en-us/nuget/concepts/msbuild-props-and-targets)
for restore/import behavior and [NuGet package metadata](https://learn.microsoft.com/en-us/nuget/reference/nuspec)
for archive metadata.

<a id="producer-contract"></a>

### Building the NuGet package

Building the package requires the pinned development packages, Node.js 24 or later and a .NET SDK
that supports `net10.0`.

`npm run build` clears library output, bundles the public entries and worker, emits strict
declarations, rewrites declaration specifiers and generates metadata and the manifest. The bundler
accepts runtime inputs only from `src/`. The build copies both license notices unchanged.

`npm run pack:nuget` builds the assets, restores the packaging project and packs the allowed files
into a local archive. Packing requires the compiled manifest and excludes managed build output and
dependencies. Publishing is separate.

The CI smoke test restores the package outside the checkout, checks its manifest and exports, and compiles
the reference host against the shipped declarations. Chromium loads the stylesheet, a host-supplied font and the
regex worker, then types into the mounted editor. [Run the smoke test](testing.md#package-qualification)

<a id="bounds-and-validation"></a>

### Troubleshooting a restored build

If a restored build fails, the failing step narrows down what to inspect.

| Failure | Check |
| --- | --- |
| The compiler finds the types but the browser cannot import a module. | Check that your bundler resolves the same public entry as TypeScript and that the deployed module can load its shared chunks. |
| `StTropezPrepareAssets` has no destination. | Set `StTropezStageDirectory` to a nonempty path inside the directory your build owns. |
| You see files from another version. | Read `StTropezPreparedRoot` after running the target. Different manifests have different subdirectories. |
| Regex search fails after deployment. | Check that the worker URL serves `browser/regex-worker.js` from the same package as the client. |

## Host responsibilities

Pin the feed and version in the project that builds the frontend. Your application supplies the
compiler or bundler it uses, the HTTP server and the cache policy. Ship `LICENSE.txt` and
`UNICODE-LICENSE.txt` with the assets. Test imports, styles and any worker from the deployed
layout, where URLs can differ from the development server.

## Not covered

Check the asset URLs in your production deployment. The [distribution row in the support
matrix](README.md#support-matrix) distinguishes the package contents from what each host must verify.
