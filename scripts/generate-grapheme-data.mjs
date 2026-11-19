import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { unicodeArguments, readUnicodeInputs, emitUnicodeFiles } from "./unicode-generation.mjs";

const { input, check } = unicodeArguments(process.argv.slice(2));
const names = ["ReadMe", "GraphemeBreakProperty", "GraphemeBreakTest", "DerivedCoreProperties", "emoji-data"];
const files = await readUnicodeInputs("grapheme", input);
assert.ok(files.ReadMe?.includes("final data files for version 18.0.0"));
for (const name of ["GraphemeBreakProperty", "GraphemeBreakTest", "DerivedCoreProperties"]) assert.ok(files[name]?.startsWith(`# ${name}-18.0.0.txt`));
const grapheme = files.GraphemeBreakProperty, derived = files.DerivedCoreProperties, emoji = files["emoji-data"];
assert.ok(grapheme && derived && emoji && emoji.includes("# Version: 18.0.0"));
/** @param {string} text */
const records = text => text.split(/\r?\n/).map(line => line.replace(/#.*/, "").trim()).filter(Boolean).map(line => {
    const fields = line.split(";").map(v => v.trim()), [range, property] = fields;
    assert.ok(range && property, "Reviewed property records require a range and property.");
    return { range, property, value: fields[2] };
});
/** @param {string} text @returns {[number, number]} */
const interval = text => { const [from, to = from] = text.split("..").map(v => parseInt(v, 16)); assert.ok(from !== undefined && to !== undefined && from >= 0 && to >= from && to <= 0x10ffff); return [from, to]; };
const kinds = ["Other", "CR", "LF", "Control", "Extend", "ZWJ", "Regional_Indicator", "Prepend", "SpacingMark", "L", "V", "T", "LV", "LVT"], conjunct = ["None", "Consonant", "Extend", "Linker"], packed = new Uint8Array(0x110000);
// interval() bounds every code point to the allocated table.
for (const { range, property } of records(grapheme)) { const [from, to] = interval(range), at = kinds.indexOf(property); assert.ok(at >= 0); for (let cp = from; cp <= to; cp++) { assert.equal(/** @type {number} */ (packed[cp]) & 15, 0); /** @type {number} */ (packed[cp]) |= at; } }
for (const { range, property, value } of records(derived)) if (property === "InCB") { assert.ok(value); const [from, to] = interval(range), at = conjunct.indexOf(value); assert.ok(at >= 0); for (let cp = from; cp <= to; cp++) { assert.equal(/** @type {number} */ (packed[cp]) & 48, 0); /** @type {number} */ (packed[cp]) |= at << 4; } }
for (const { range, property } of records(emoji)) if (property === "Extended_Pictographic") { const [from, to] = interval(range); for (let cp = from; cp <= to; cp++) /** @type {number} */ (packed[cp]) |= 64; }
for (const { range, property } of records(derived)) if (property === "Default_Ignorable_Code_Point") { const [from, to] = interval(range); for (let cp = from; cp <= to; cp++) /** @type {number} */ (packed[cp]) |= 128; }
// The direct ASCII lookup must agree with all four reviewed properties.
for (let cp = 0; cp < 128; cp++) assert.equal(packed[cp], cp === 13 ? 1 : cp === 10 ? 2 : cp < 32 || cp === 127 ? 3 : 0);
// Hangul's regular LV/LVT alternation need not occupy hundreds of interval records.
for (let cp = 0xac00; cp <= 0xd7a3; cp++) { assert.equal(packed[cp], (cp - 0xac00) % 28 ? 13 : 12); packed[cp] = 0; }
const ranges = []; for (let cp = 0; cp < packed.length; cp++) if (cp === 0 || packed[cp] !== packed[cp - 1]) ranges.push(cp, packed[cp]);
const lines = []; for (let i = 0; i < ranges.length; i += 24) lines.push("    " + ranges.slice(i, i + 24).join(", ") + ",");
const source = `// Generated Unicode18 grapheme/property facts. See licenses/Unicode-3.0.txt.
// Regenerate offline with scripts/generate-grapheme-data.mjs from reviewed data.
export const unicodeGraphemeVersion = "18.0.0";
const kinds = ${JSON.stringify(kinds)} as const;
const conjunct = ${JSON.stringify(conjunct)} as const;
export type GraphemeBreakProperty = typeof kinds[number];
export type IndicConjunctBreak = typeof conjunct[number];
const ranges: readonly number[] = [
${lines.join("\n")}
];
/** Internal packed properties: GCB bits0..3, InCB bits4..5, Extended_Pictographic bit6, Default_Ignorable bit7. */
export function graphemeProperties(cp: number): number {
    if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) throw new RangeError("Invalid Unicode code point.");
    if (cp < 128) return cp === 13 ? 1 : cp === 10 ? 2 : cp < 32 || cp === 127 ? 3 : 0;
    if (cp >= 0xac00 && cp <= 0xd7a3) return (cp - 0xac00) % 28 ? 13 : 12;
    let low = 0, high = ranges.length / 2; while (low + 1 < high) { const mid = (low + high) >>> 1; if (ranges[mid * 2]! <= cp) low = mid; else high = mid; } return ranges[low * 2 + 1]!;
}
export const graphemeBreakProperty = (cp: number): GraphemeBreakProperty => kinds[graphemeProperties(cp) & 15]!;
export const indicConjunctBreak = (cp: number): IndicConjunctBreak => conjunct[graphemeProperties(cp) >>> 4 & 3]!;
export const extendedPictographic = (cp: number): boolean => !!(graphemeProperties(cp) & 64);
export const defaultIgnorable = (cp: number): boolean => !!(graphemeProperties(cp) & 128);
`;
/** @type {Record<string, string | Uint8Array>} */ const outputs = { "src/core/grapheme-data.ts": source };
for (const name of names.filter(n => n !== "ReadMe")) {
    const file = files[name]; assert.ok(file, `Missing reviewed grapheme input: ${name}`);
    const text = file.split(/\r?\n/).map(line => line.replace(/#.*/, "").trim()).filter(Boolean).join("\n") + "\n";
    outputs[`tests/fixtures/graphemes/${name}.txt.gz`] = gzipSync(text, { level: 9 });
}
await emitUnicodeFiles(outputs, check);
console.log(JSON.stringify({ unicode: "18.0.0", check, intervalRecords: ranges.length / 2, sourceBytes: Buffer.byteLength(source), copiedImplementation: false }));
