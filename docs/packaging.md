# Packaging

Restore `StTropez.Assets` with NuGet to get the compiled editor, declarations, CSS and regex
worker. Your frontend loads the ES modules directly.

## Use

Pin the package in the project that builds the frontend. This example uses a local feed containing
`0.0.0-local` and stages assets in a dedicated directory under `obj/`.

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

```sh
dotnet restore Consumer.csproj
dotnet msbuild Consumer.csproj -target:PrepareFrontend
```

`assets-root.txt` gives the directory to pass to your bundler. Resolve these imports through its
`package.json`. If you use aliases, point TypeScript and the bundler at the same entries.

```ts
export * as model from "sttropez";
export * as browser from "sttropez/browser";
export * as protocol from "sttropez/protocol";
export * as kernels from "sttropez/kernels";
```

Serve the stylesheet from the same build or include it in the host's stylesheet bundle.

```html
<link rel="stylesheet" href="./sttropez/editor.css">
```

For regex search, deploy `browser/regex-worker.js` and supply its URL to the worker factory.
[Regex search](search.md#regular-expressions-and-worker-limits) · [Mount the editor](getting-started.md#open-the-first-editor)

## Contract

### Package contents and entry points

Public imports resolve under `assets/` in the restored package. The staged copy uses the same layout.

| Public import | Asset | Manifest key |
| --- | --- | --- |
| `sttropez` | `index.js` | `core` |
| `sttropez/browser` | `browser/index.js` | `browser` |
| `sttropez/protocol` | `protocol/index.js` | `protocol` |
| `sttropez/kernels` | `kernels/index.js` | `kernels` |
| `sttropez/editor.css` | `editor.css` | `css` |
| `sttropez/regex-worker.js` | `browser/regex-worker.js` | `regexWorker` |

Each of the four module entries has a sibling `index.d.ts`. Declarations use relative `.js` imports.
The ES2022 modules share chunks. Preserve their relative paths when serving them directly.
The regex worker is a standalone module. Import only paths in the exports map. [API index](api.md)

### Manifest and versions

`manifest.json` records `schemaVersion: 1`, the build version label, `entries` and `assets`.
`entries.types` points to `index.d.ts`. Each file under `assets/` except the manifest itself has
a relative path, byte count and SHA-256, including both license notices. Resolve the version
at NuGet restore time.

### MSBuild preparation

`StTropezAssetRoot` points to the restored `assets/` directory. Read it directly or invoke
`StTropezPrepareAssets` with `StTropezStageDirectory` set. The package supplies `.props` and
`.targets` under `build/` for direct references. [NuGet build imports](https://learn.microsoft.com/en-us/nuget/concepts/msbuild-props-and-targets)

The target copies assets offline, skips unchanged files and sets `StTropezPreparedRoot` to a
subdirectory named for the SHA-256 of the manifest bytes. Different manifests get separate
directories. To verify a file, compare its own hash with the manifest entry. Your build owns
cleanup of old stages.

<a id="producer-contract"></a>

### Building the NuGet package

From the checkout, use Node.js 24 or later, the pinned development packages and an SDK supporting
`net10.0`. `npm run pack:nuget` builds the modules and declarations, restores the packaging
project and creates the archive in `artifacts/nuget/feed/`. `npm run test:package` restores it
in a separate consumer and exercises the reference host. [Package smoke test](testing.md#package-qualification)

<a id="bounds-and-validation"></a>

### Troubleshooting a restored build

| Symptom | Check |
| --- | --- |
| Types resolve but a module fails to load | Compare bundler and TypeScript aliases and check the shared-chunk URL. |
| Staging fails before copying files | Set `StTropezStageDirectory` to a directory reserved for generated output. |
| The host loads an older version | Read `StTropezPreparedRoot` after the preparation target runs. |
| Regex search fails after deployment | Check that the worker URL serves `browser/regex-worker.js` from the client package. |

## Host responsibilities

Select a trusted feed and package version. Ship `LICENSE.txt` and `UNICODE-LICENSE.txt` with
the assets. Own the server, URLs and cache policy. Test the imports, stylesheet and worker at
the deployed path.

## Not covered

See the distribution row in the [support matrix](README.md#support-matrix).
