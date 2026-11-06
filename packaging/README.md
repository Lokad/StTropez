# StTropez browser assets

Local evaluation package. Contains compiled ESM, declarations and scoped CSS, with no managed
assembly or runtime dependency. License and release metadata have not been selected; this
package is not a published release.

Reference `StTropez.Assets` directly from the project owning the frontend. Restore exposes
`StTropezAssetRoot`. Explicitly invoke `StTropezPrepareAssets` with `StTropezStageDirectory`
pointing to a dedicated generated directory; `StTropezPreparedRoot` names its content-addressed
asset folder. No preparation runs automatically during restore/build. The host may instead
resolve the immutable `StTropezAssetRoot` directly.

Configure TypeScript and your bundler to resolve `sttropez` and `sttropez/browser` from that
folder, and explicitly include `editor.css` in the host stylesheet/static-asset pipeline.
Retain `UNICODE-LICENSE.txt` with bundled or deployed assets; it covers the included Unicode data.
NuGet restore does not install an npm package or configure frontend resolution. No TypeScript
compilation or additional installation is performed by this package. The host owns its tools.
