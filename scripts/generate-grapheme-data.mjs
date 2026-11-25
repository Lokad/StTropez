import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import inputs from "./unicode-inputs.json" with { type: "json" };

const [input, mode, ...extra] = process.argv.slice(2);
assert.ok(input && !input.startsWith("--") && extra.length === 0 && (mode === undefined || mode === "--check"),
    "Supply a reviewed Unicode data directory followed optionally by --check.");
const check = mode === "--check";
/** @type {Record<string, string>} */
const files = {};
for (const entry of [...inputs.grapheme, inputs.license]) {
    const name = `${entry.name}.txt`;
    /** @type {Buffer} */
    const data = await readFile(resolve(input, name));
    assert.equal(createHash("sha256").update(data).digest("hex"), entry.sha256, `Unreviewed Unicode input: ${name}`);
    files[entry.name] = data.toString("utf8");
}
assert.equal(files.license?.replaceAll("\r\n", "\n"),
    (await readFile("licenses/Unicode-3.0.txt", "utf8")).replaceAll("\r\n", "\n"), "Unicode license differs from the reviewed notice.");
assert.ok(files.ReadMe?.includes("final data files for version 18.0.0"));
for (const name of ["GraphemeBreakTest", "DerivedCoreProperties"]) assert.ok(files[name]?.startsWith(`# ${name}-18.0.0.txt`));
/** @type {[number, number][]} */
const ranges = [];
for (const line of (files.DerivedCoreProperties ?? "").split(/\r?\n/)) {
    const [interval, property] = (line.split("#")[0] ?? "").split(";").map(s => s.trim());
    if (property !== "Default_Ignorable_Code_Point" || !interval) continue;
    const [from, to = from] = interval.split("..").map(s => parseInt(s, 16));
    assert.ok(from !== undefined && to !== undefined);
    const previous = ranges.at(-1);
    if (previous && previous[1] + 1 === from) previous[1] = to;
    else ranges.push([from, to]);
}
const source = `// Default_Ignorable_Code_Point from Unicode 18. See licenses/Unicode-3.0.txt.
const ranges = [
${ranges.map(([from, to]) => "    [0x" + from.toString(16) + ", 0x" + to.toString(16) + "],").join("\n")}
] as const;

export function defaultIgnorable(cp: number): boolean {
    if (cp < 0xad) return false;
    for (const [from, to] of ranges) {
        if (cp <= to) return cp >= from;
    }
    return false;
}
`;
/** @type {Record<string, string | Uint8Array>} */
const outputs = { "src/core/default-ignorable.ts": source };
for (const { name } of inputs.grapheme) {
    if (name === "ReadMe") continue;
    const file = files[name]; assert.ok(file, `Missing reviewed grapheme input: ${name}`);
    const text = file.split(/\r?\n/).map(line => line.replace(/#.*/, "").trim()).filter(Boolean).join("\n") + "\n";
    outputs[`tests/fixtures/graphemes/${name}.txt.gz`] = gzipSync(text, { level: 9 });
}
for (const [path, expected] of Object.entries(outputs)) {
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
console.log(JSON.stringify({ unicode: "18.0.0", check, intervalRecords: ranges.length, sourceBytes: Buffer.byteLength(source), copiedImplementation: false }));
