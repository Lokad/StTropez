import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { unicodeArguments, readUnicodeInputs, emitUnicodeFiles } from "./unicode-generation.mjs";

// Input files are obtained and licensed during an explicit data review. No network at build time.
const { input, check } = unicodeArguments(process.argv.slice(2));
const files = await readUnicodeInputs("bidi", input);
const kinds = ["L", "R", "AL", "EN", "ES", "ET", "AN", "CS", "NSM", "BN", "B", "S", "WS", "ON", "LRE", "LRO", "RLE", "RLO", "PDF", "LRI", "RLI", "FSI", "PDI"];
/** @type {Readonly<Record<string, string>>} */
const aliases = { Left_To_Right: "L", Right_To_Left: "R", Arabic_Letter: "AL", European_Terminator: "ET" };
const classes = files.classes, brackets = files.brackets;
assert.ok(classes && brackets, "Reviewed bidi inputs require classes and brackets.");
assert.ok(classes.startsWith("# DerivedBidiClass-18.0.0.txt")); assert.ok(brackets.startsWith("# BidiBrackets-18.0.0.txt"));
const values = new Uint8Array(0x110000);
/** @param {string} range @param {string} name */
const fill = (range, name) => { const [from, to = from] = range.split("..").map(v => parseInt(v, 16)), index = kinds.indexOf(aliases[name] ?? name); assert.ok(index >= 0 && from !== undefined && to !== undefined); values.fill(index, from, to + 1); };
// These regex captures are required and nonempty in every match.
for (const match of classes.matchAll(/@missing:\s*([0-9A-F.]+);\s*(\w+)/g)) fill(/** @type {string} */ (match[1]), /** @type {string} */ (match[2]));
for (const match of classes.matchAll(/^([0-9A-F.]+)\s*;\s*(\w+)/gm)) fill(/** @type {string} */ (match[1]), /** @type {string} */ (match[2]));
const ranges = []; for (let cp = 0; cp < values.length; cp++) if (cp === 0 || values[cp] !== values[cp - 1]) ranges.push(cp, values[cp]);
const pairs = [...brackets.matchAll(/^([0-9A-F]+);\s*([0-9A-F]+);\s*([oc])/gm)].map(m => `[${parseInt(/** @type {string} */ (m[1]),16)}, Object.freeze([${parseInt(/** @type {string} */ (m[2]),16)}, ${m[3] === "o"}] as const)]`);
const lines = []; for (let offset = 0; offset < ranges.length; offset += 24) lines.push("    " + ranges.slice(offset, offset + 24).join(", ") + ",");
const output = `// Generated Unicode 18.0.0 bidi property facts. See licenses/Unicode-3.0.txt.\n// Regenerate with scripts/generate-bidi-data.mjs from reviewed data.\nconst kinds = ${JSON.stringify(kinds)} as const;\nexport type BidiClass = typeof kinds[number];\nconst ranges: readonly number[] = [\n${lines.join("\n")}\n];\nconst brackets = new Map<number, readonly [number, boolean]>([\n${pairs.map(p=>"    "+p+",").join("\n")}\n]);\nexport function bidiClass(codepoint: number): BidiClass {\n    if (!Number.isInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff) throw new RangeError("Invalid Unicode code point.");\n    let low = 0, high = ranges.length / 2;\n    while (low + 1 < high) { const mid = (low + high) >>> 1; if (ranges[mid * 2]! <= codepoint) low = mid; else high = mid; }\n    return kinds[ranges[low * 2 + 1]!]!;\n}\nexport const bidiBracket = (codepoint: number): readonly [number, boolean] | undefined => brackets.get(codepoint);\n`;
/** @type {Record<string, string | Uint8Array>} */ const outputs = { "src/core/bidi-data.ts": output };
for (const name of ["classes", "types", "characters"]) {
    const file = files[name]; assert.ok(file, `Missing reviewed bidi input: ${name}`);
    const data = file.split(/\r?\n/).map(line => name === "classes" && line.includes("@missing:") ? line.slice(line.indexOf("@missing:")) : line.replace(/#.*/, "").trim()).filter(Boolean).join("\n") + "\n";
    outputs[`tests/fixtures/bidi/${name}.txt.gz`] = gzipSync(data, { level: 9 });
}
await emitUnicodeFiles(outputs, check);
console.log(JSON.stringify({ unicode: "18.0.0", check, classRanges: ranges.length / 2, bracketEntries: pairs.length, sourceBytes: output.length }));
