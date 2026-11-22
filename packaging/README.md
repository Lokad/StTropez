# StTropez browser assets

Local evaluation package. Contains compiled ESM, declarations and scoped CSS, with no managed
assembly or runtime dependency. StTropez is released under the MIT license. Release metadata
has not been selected; this package is not a published release.

Reference `StTropez.Assets` directly from the project owning the frontend. Restore exposes
`StTropezAssetRoot`. Explicitly invoke `StTropezPrepareAssets` with `StTropezStageDirectory`
pointing to a dedicated generated directory; `StTropezPreparedRoot` names its content-addressed
asset folder. No preparation runs automatically during restore/build. The host may instead
resolve the immutable `StTropezAssetRoot` directly.

Configure the host's frontend resolution against that folder. Its `package.json` exports are:

| Import | Asset | Purpose |
| --- | --- | --- |
| `sttropez` | `index.js`, `index.d.ts` | Headless workspace and text model |
| `sttropez/browser` | `browser/index.js`, `browser/index.d.ts` | Browser editor and controllers |
| `sttropez/protocol` | `protocol/index.js`, `protocol/index.d.ts` | JSON-RPC and LSP integration |
| `sttropez/kernels` | `kernels/index.js`, `kernels/index.d.ts` | Text, diff and selection algorithms, JSON-RPC sessions and LSP decoders |
| `sttropez/editor.css` | `editor.css` | Scoped editor styles |
| `sttropez/regex-worker.js` | `browser/regex-worker.js` | Standalone module worker for regex find |

The host may mount the staged folder as a local package, or configure its TypeScript paths and
bundler aliases explicitly. Include the CSS in its stylesheet/static-asset pipeline. Serve the
regex worker at a host-selected URL and supply a worker factory when enabling regex find.
Retain `LICENSE.txt` (StTropez MIT) and `UNICODE-LICENSE.txt` (included Unicode data) with
bundled or deployed assets. Both notices are included in the package and staged folder.
NuGet restore does not install an npm package or configure frontend resolution. No TypeScript
compilation or additional installation is performed by this package. The host owns its tools.
