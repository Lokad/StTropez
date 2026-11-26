# Packaging

`StTropez.Assets` supplies compiled ES modules, declarations, CSS and the regex worker through NuGet.

## Use

Pin the package in the frontend project. This example stages `0.0.0-local` from a local feed under `obj/`.

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

Pass the directory from `assets-root.txt` to your bundler. Resolve imports via its `package.json` or give
TypeScript and the bundler matching aliases.

```ts
export * as model from "sttropez";
export * as browser from "sttropez/browser";
export * as protocol from "sttropez/protocol";
export * as kernels from "sttropez/kernels";
```

Serve or bundle the matching stylesheet.

```html
<link rel="stylesheet" href="./sttropez/editor.css">
```

For [regex search](search.md#regular-expressions-and-worker-limits), deploy `browser/regex-worker.js` and
pass its URL to the worker factory.

## Contract

### Package contents and entry points

Staged assets have the restored `assets/` layout.

| Public import | Asset | Manifest key |
| --- | --- | --- |
| `sttropez` | `index.js` | `core` |
| `sttropez/browser` | `browser/index.js` | `browser` |
| `sttropez/protocol` | `protocol/index.js` | `protocol` |
| `sttropez/kernels` | `kernels/index.js` | `kernels` |
| `sttropez/editor.css` | `editor.css` | `css` |
| `sttropez/regex-worker.js` | `browser/regex-worker.js` | `regexWorker` |

Each module has a sibling `index.d.ts` with relative `.js` imports. Preserve ES2022 shared-chunk paths. The
regex worker is standalone. Import through the exports map. [API index](api.md)

### Manifest and versions

`manifest.json` records `schemaVersion: 1`, build version, `entries` and `assets`. `entries.types` is
`index.d.ts`. Other files, including both notices, have a relative path, byte count and SHA-256. NuGet
restore selects the version.

### MSBuild preparation

Read `StTropezAssetRoot` directly or set `StTropezStageDirectory` and invoke `StTropezPrepareAssets`. Direct
references import the package’s `build/` props and targets.
[NuGet build imports](https://learn.microsoft.com/en-us/nuget/concepts/msbuild-props-and-targets)

Preparation copies offline and skips unchanged files. `StTropezPreparedRoot` names the staged directory by
the manifest’s SHA-256. Verify individual file hashes against their entries. The host cleans old stages.

<a id="producer-contract"></a>

### Building the NuGet package

With Node.js 24+, locked dev packages and a `net10.0` SDK, run `npm run pack:nuget`. It builds modules and
declarations and creates an archive in `artifacts/nuget/feed/`. `npm run test:package` restores it in a
[reference consumer](testing.md#package-qualification).

<a id="bounds-and-validation"></a>

### Troubleshooting a restored build

| Symptom | Check |
| --- | --- |
| Types resolve, module fails to load | TypeScript and bundler aliases, shared-chunk URL |
| Staging fails | Is `StTropezStageDirectory` reserved for generated output? |
| Host loads an older version | Read `StTropezPreparedRoot` after preparation |
| Regex fails after deploy | Worker URL and client package version |

## Host responsibilities

Pin a trusted feed and version. Ship `LICENSE.txt` and `UNICODE-LICENSE.txt`. Own URLs and caching. Test
imports, CSS and worker at the deployed path.

## Not covered

[Distribution support](README.md#support-matrix)
