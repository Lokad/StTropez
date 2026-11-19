import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import inputs from "./unicode-inputs.json" with { type: "json" };

/** @param {readonly string[]} args */
export function unicodeArguments(args) {
    const [input, mode] = args;
    assert.ok(input && !input.startsWith("--") && args.length <= 2
        && (mode === undefined || mode === "--check"), "Supply a reviewed Unicode data directory followed optionally by --check.");
    return { input, check: mode === "--check" };
}

/**
 * Verify every raw input before generating or writing anything. No network access.
 * @param {"grapheme"} kind
 * @param {string} directory
 */
export async function readUnicodeInputs(kind, directory) {
    /** @type {Record<string, string>} */
    const files = {};
    for (const entry of [...inputs[kind], inputs.license]) {
        const name = `${entry.name}.txt`, data = await readFile(resolve(directory, name));
        assert.equal(createHash("sha256").update(data).digest("hex"), entry.sha256, `Unreviewed Unicode input: ${name}`);
        files[entry.name] = data.toString("utf8");
    }
    assert.equal(files.license?.replaceAll("\r\n", "\n"),
        (await readFile("licenses/Unicode-3.0.txt", "utf8")).replaceAll("\r\n", "\n"), "Unicode license differs from the reviewed notice.");
    return files;
}

/**
 * Text comparisons allow checkout line endings; compressed fixtures compare exact bytes.
 * @param {Readonly<Record<string, string | Uint8Array>>} files
 * @param {boolean} check
 */
export async function emitUnicodeFiles(files, check) {
    for (const [path, expected] of Object.entries(files)) {
        if (check) {
            const actual = await readFile(path);
            const equal = typeof expected === "string"
                ? actual.toString("utf8").replaceAll("\r\n", "\n") === expected.replaceAll("\r\n", "\n")
                : actual.equals(expected);
            assert.ok(equal, `Generated Unicode output differs: ${path}`);
        } else {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, expected);
        }
    }
}
