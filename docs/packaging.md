# Packaging

Decision: NuGet is the preferred distribution format. The package contains browser assets
and small MSBuild integration files, with no managed assembly or runtime dependencies.
The TypeScript implementation and browser APIs remain independent of .NET.

This is the packaging contract. The scaffold currently builds `dist/`; NuGet packing and
consumer integration are planned work, not implemented or validated yet.

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
