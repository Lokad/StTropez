import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const input = process.argv[2]; if (!input) throw new Error("Supply a reviewed Unicode18 grapheme data directory.");
const names = ["ReadMe", "GraphemeBreakProperty", "GraphemeBreakTest", "DerivedCoreProperties", "emoji-data"], files = {};
for (const name of names) files[name] = await readFile(resolve(input, `${name}.txt`), "utf8");
assert.ok(files.ReadMe.includes("final data files for version 18.0.0"));
for (const name of ["GraphemeBreakProperty", "GraphemeBreakTest", "DerivedCoreProperties"]) assert.ok(files[name].startsWith(`# ${name}-18.0.0.txt`));
assert.ok(files["emoji-data"].includes("# Version: 18.0.0"));
assert.equal((await readFile(resolve(input, "license.txt"), "utf8")).replaceAll("\r\n", "\n"), (await readFile("licenses/Unicode-3.0.txt", "utf8")).replaceAll("\r\n", "\n"));
const records = text => text.split(/\r?\n/).map(line => line.replace(/#.*/, "").trim()).filter(Boolean).map(line => line.split(";").map(v => v.trim()));
const interval = text => { const [from, to = from] = text.split("..").map(v => parseInt(v, 16)); assert.ok(from >= 0 && to >= from && to <= 0x10ffff); return [from, to]; };
const kinds = ["Other", "CR", "LF", "Control", "Extend", "ZWJ", "Regional_Indicator", "Prepend", "SpacingMark", "L", "V", "T", "LV", "LVT"], conjunct = ["None", "Consonant", "Extend", "Linker"], packed = new Uint8Array(0x110000);
for (const [range, property] of records(files.GraphemeBreakProperty)) { const [from, to] = interval(range), at = kinds.indexOf(property); assert.ok(at >= 0); for (let cp = from; cp <= to; cp++) { assert.equal(packed[cp] & 15, 0); packed[cp] |= at; } }
for (const [range, property, value] of records(files.DerivedCoreProperties)) if (property === "InCB") { const [from, to] = interval(range), at = conjunct.indexOf(value); assert.ok(at >= 0); for (let cp = from; cp <= to; cp++) { assert.equal(packed[cp] & 48, 0); packed[cp] |= at << 4; } }
for (const [range, property] of records(files["emoji-data"])) if (property === "Extended_Pictographic") { const [from, to] = interval(range); for (let cp = from; cp <= to; cp++) packed[cp] |= 64; }
// The direct ASCII lookup must agree with all three reviewed properties.
for (let cp = 0; cp < 128; cp++) assert.equal(packed[cp], cp === 13 ? 1 : cp === 10 ? 2 : cp < 32 || cp === 127 ? 3 : 0);
// Hangul's regular LV/LVT alternation need not occupy hundreds of interval records.
for (let cp = 0xac00; cp <= 0xd7a3; cp++) { assert.equal(packed[cp], (cp - 0xac00) % 28 ? 13 : 12); packed[cp] = 0; }
const ranges = []; for (let cp = 0; cp < packed.length; cp++) if (cp === 0 || packed[cp] !== packed[cp - 1]) ranges.push(cp, packed[cp]);
const lines = []; for (let i = 0; i < ranges.length; i += 24) lines.push("    " + ranges.slice(i, i + 24).join(", ") + ",");
const source = `// Generated Unicode18 grapheme/property facts. See licenses/Unicode-3.0.txt.
// Regenerate offline with scripts/generate-grapheme-data.mjs from reviewed data.
export const graphemeUnicodeVersion = "18.0.0";
const kinds = ${JSON.stringify(kinds)} as const;
const conjunct = ${JSON.stringify(conjunct)} as const;
export type GraphemeBreakProperty = typeof kinds[number];
export type IndicConjunctBreak = typeof conjunct[number];
const ranges: readonly number[] = [
${lines.join("\n")}
];
/** Internal packed properties: GCB bits0..3, InCB bits4..5, Extended_Pictographic bit6. */
export function graphemeProperties(cp: number): number {
    if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) throw new RangeError("Invalid Unicode code point.");
    if (cp < 128) return cp === 13 ? 1 : cp === 10 ? 2 : cp < 32 || cp === 127 ? 3 : 0;
    if (cp >= 0xac00 && cp <= 0xd7a3) return (cp - 0xac00) % 28 ? 13 : 12;
    let low = 0, high = ranges.length / 2; while (low + 1 < high) { const mid = (low + high) >>> 1; if (ranges[mid * 2]! <= cp) low = mid; else high = mid; } return ranges[low * 2 + 1]!;
}
export const graphemeBreakProperty = (cp: number): GraphemeBreakProperty => kinds[graphemeProperties(cp) & 15]!;
export const indicConjunctBreak = (cp: number): IndicConjunctBreak => conjunct[graphemeProperties(cp) >>> 4 & 3]!;
export const extendedPictographic = (cp: number): boolean => !!(graphemeProperties(cp) & 64);
`;
await writeFile("src/core/grapheme-data.ts", source); await mkdir("tests/fixtures/graphemes", { recursive: true });
for (const name of names.filter(n => n !== "ReadMe")) { const text = files[name].split(/\r?\n/).map(line => line.replace(/#.*/, "").trim()).filter(Boolean).join("\n") + "\n"; await writeFile(`tests/fixtures/graphemes/${name}.txt.gz`, gzipSync(text, { level: 9 })); }
console.log(JSON.stringify({ unicode: "18.0.0", intervalRecords: ranges.length / 2, sourceBytes: Buffer.byteLength(source), copiedImplementation: false }));
