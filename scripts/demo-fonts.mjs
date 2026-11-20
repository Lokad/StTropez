import { copyFile } from "node:fs/promises";
import { join } from "node:path";

// The demo hosts serve the unmodified Fira Code 6.2 face and its accompanying license.
export const demoFontFiles = ["FiraCode-Regular.woff2", "FiraCode-LICENSE.txt"];

/** @param {string} directory */
export async function stageDemoFonts(directory) {
    for (const name of demoFontFiles) {
        await copyFile(new URL(`../examples/demo/fonts/${name}`, import.meta.url), join(directory, name));
    }
}
