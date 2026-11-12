import { graphemeBoundaries } from "../../../src/index.ts";
import { createFontAssetController } from "../../../src/browser/index.ts";
import { fontFixture } from "../consumer/font-fixture.ts";

const asset = createFontAssetController(document, "native-fixture");
function request(advanceA = 600) {
    const bytes = fontFixture({ advanceA });
    const operation = asset.request(asset.getSnapshot().generation, bytes)!;
    bytes.fill(0);
    return operation;
}
const fixture = Object.freeze({ ready: true, asset, request, graphemes: graphemeBoundaries });
Object.assign(window, { nativeFontFixture: fixture });
declare global { interface Window { nativeFontFixture: typeof fixture } }
