import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

// Reviewed Unicode data only. Generation/build performs no download and copies no implementation.
const input = process.argv[2]; if (!input) throw new Error("Supply the reviewed Unicode 18 data directory.");
const names = ["ReadMe", "UnicodeData", "DerivedNormalizationProps", "NormalizationTest", "Scripts", "ScriptExtensions", "PropertyValueAliases", "DerivedCoreProperties", "PropList"], data = {};
for (const name of names) data[name] = await readFile(resolve(input, `${name}.txt`), "utf8");
assert.ok(data.ReadMe.includes("final data files for version 18.0.0"));
for (const name of names.filter(n => n !== "ReadMe" && n !== "UnicodeData")) assert.ok(data[name].startsWith(`# ${name}-18.0.0.txt`), name);
assert.equal((await readFile(resolve(input, "license.txt"), "utf8")).replaceAll("\r\n", "\n"), (await readFile("licenses/Unicode-3.0.txt", "utf8")).replaceAll("\r\n", "\n"));
const records = text => text.split(/\r?\n/).map(line => line.replace(/#.*/, "").trim()).filter(line => line && !line.startsWith("@")).map(line => line.split(";").map(v => v.trim()));
const range = value => { const [from, to = from] = value.split("..").map(v => parseInt(v, 16)); return [from, to]; };
const aliases = new Map(); for (const row of records(data.PropertyValueAliases)) if (row[0] === "sc") for (const value of row.slice(1)) aliases.set(value, row[1]);
const scripts = [...new Set(aliases.values())].sort(), scriptIds = new Map(scripts.map((name, i) => [name, i])), categories = ["Cn", "Lu", "Ll", "Lt", "Lm", "Lo", "Mn", "Mc", "Me", "Nd", "Nl", "No", "Pc", "Pd", "Ps", "Pe", "Pi", "Pf", "Po", "Sm", "Sc", "Sk", "So", "Zs", "Zl", "Zp", "Cc", "Cf", "Cs", "Co"];
const script = new Uint16Array(0x110000).fill(scriptIds.get("Zzzz")), category = new Uint8Array(0x110000), ccc = new Uint8Array(0x110000), flags = new Uint8Array(0x110000), exclusion = new Uint8Array(0x110000), decompositions = [];
let pending;
for (const row of records(data.UnicodeData)) {
    const cp = parseInt(row[0], 16), gc = categories.indexOf(row[2]), cc = Number(row[3]); assert.ok(gc >= 0 && cc >= 0 && cc <= 255);
    if (row[1].endsWith(", First>")) { assert.equal(pending, undefined); pending = { cp, gc, cc, name: row[1].replace(", First>", "") }; continue; }
    let from = cp; if (row[1].endsWith(", Last>")) { assert.equal(pending.name, row[1].replace(", Last>", "")); assert.equal(pending.gc, gc); assert.equal(pending.cc, cc); from = pending.cp; pending = undefined; }
    category.fill(gc, from, cp + 1); ccc.fill(cc, from, cp + 1);
    if (row[5]) { const compatible = row[5].startsWith("<"), values = row[5].replace(/^<[^>]+>\s*/, "").split(/\s+/).map(v => parseInt(v, 16)); assert.ok(values.length && values.every(Number.isInteger)); decompositions.push([cp, compatible ? 1 : 0, ...values]); }
}
assert.equal(pending, undefined);
for (const [r, name] of records(data.Scripts)) { const [from, to] = range(r), id = scriptIds.get(aliases.get(name)); assert.notEqual(id, undefined); script.fill(id, from, to + 1); }
for (const [r, name] of records(data.DerivedNormalizationProps)) if (name === "Full_Composition_Exclusion") { const [from, to] = range(r); exclusion.fill(1, from, to + 1); }
for (const [text, property, bit] of [[data.DerivedCoreProperties, "Default_Ignorable_Code_Point", 1], [data.PropList, "Variation_Selector", 2], [data.PropList, "Join_Control", 4], [data.PropList, "Bidi_Control", 8]])
    for (const [r, name] of records(text)) if (name === property) { const [from, to] = range(r); for (let cp = from; cp <= to; cp++) flags[cp] |= bit; }
const compress = values => { const result = []; for (let cp = 0; cp < values.length; cp++) if (!cp || values[cp] !== values[cp - 1]) result.push(cp, values[cp]); return result; };
const sets = [], setIds = new Map(), extensions = [];
for (const [r, names] of records(data.ScriptExtensions)) { const values = names.split(/\s+/).map(n => aliases.get(n)).sort(); assert.ok(values.every(Boolean)); const key = values.join(" "); let id = setIds.get(key); if (id === undefined) { id = sets.length; setIds.set(key, id); sets.push(values); } const [from, to] = range(r); extensions.push([from, to, id]); }
extensions.sort((a, b) => a[0] - b[0]); for (let i = 1; i < extensions.length; i++) assert.ok(extensions[i - 1][1] < extensions[i][0]);
const pairs = [], keys = new Set(); for (const [cp, compatible, ...sequence] of decompositions) if (!compatible && sequence.length === 2 && !exclusion[cp]) { assert.equal(ccc[sequence[0]], 0); const key = sequence[0] * 0x110000 + sequence[1]; assert.ok(!keys.has(key)); keys.add(key); pairs.push([key, cp]); }
pairs.sort((a, b) => a[0] - b[0]); const decompositionRecords = [], decompositionValues = [];
for (const [cp, compatible, ...sequence] of decompositions) { decompositionRecords.push(cp, decompositionValues.length, compatible ? -sequence.length : sequence.length); decompositionValues.push(...sequence); }
const array = (name, values) => { const lines = []; for (let i = 0; i < values.length; i += 24) lines.push("    " + values.slice(i, i + 24).join(", ") + ","); return `const ${name}: readonly number[] = [\n${lines.join("\n")}\n];\n`; };
const source = `// Generated Unicode 18.0.0 property and normalization facts. See licenses/Unicode-3.0.txt.
// Regenerate with scripts/generate-unicode-shaping.mjs from reviewed local data.
export const shapingUnicodeVersion = "18.0.0";
const scriptNames = ${JSON.stringify(scripts)} as const;
export type UnicodeScript = typeof scriptNames[number];
const categories = ${JSON.stringify(categories)} as const;
export type UnicodeCategory = typeof categories[number];
${array("scriptRanges", compress(script))}${array("categoryRanges", compress(category))}${array("combiningRanges", compress(ccc))}${array("flagRanges", compress(flags))}
const extensionSets: readonly (readonly UnicodeScript[])[] = Object.freeze([${sets.map(s => `Object.freeze(${JSON.stringify(s)} as const)`).join(",")}]);
${array("extensionRanges", extensions.flat())}
${array("decompositionRecords", decompositionRecords)}${array("decompositionValues", decompositionValues)}${array("compositionRecords", pairs.flat())}
const decompositionCache = new Map<number, readonly number[]>();
const singletonScripts: readonly (readonly UnicodeScript[])[] = Object.freeze(scriptNames.map(name => Object.freeze([name])));
function point(cp: number): void { if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) throw new RangeError("Invalid Unicode code point."); }
function value(ranges: readonly number[], cp: number): number { point(cp); let low = 0, high = ranges.length / 2; while (low + 1 < high) { const mid = (low + high) >>> 1; if (ranges[mid * 2]! <= cp) low = mid; else high = mid; } return ranges[low * 2 + 1]!; }
export const unicodeScript = (cp: number): UnicodeScript => scriptNames[value(scriptRanges, cp)]!;
export const unicodeCategory = (cp: number): UnicodeCategory => categories[value(categoryRanges, cp)]!;
export const canonicalCombiningClass = (cp: number): number => value(combiningRanges, cp);
export const unicodeDefaultIgnorable = (cp: number): boolean => !!(value(flagRanges, cp) & 1);
export const unicodeVariationSelector = (cp: number): boolean => !!(value(flagRanges, cp) & 2);
export const unicodeJoinControl = (cp: number): boolean => !!(value(flagRanges, cp) & 4);
export const unicodeBidiControl = (cp: number): boolean => !!(value(flagRanges, cp) & 8);
export function unicodeScriptExtensions(cp: number): readonly UnicodeScript[] { point(cp); let low = 0, high = extensionRanges.length / 3; while (low < high) { const mid = (low + high) >>> 1; if (extensionRanges[mid * 3]! <= cp) low = mid + 1; else high = mid; } const at = (low - 1) * 3; return at >= 0 && cp <= extensionRanges[at + 1]! ? extensionSets[extensionRanges[at + 2]!]! : singletonScripts[value(scriptRanges, cp)]!; }
/** Internal normalization facts; Hangul syllables are handled algorithmically. */
export function normalizationDecomposition(cp: number, compatibility: boolean): readonly number[] | null { if (cp < decompositionRecords[0]!) return null; let low = 0, high = decompositionRecords.length / 3; while (low < high) { const mid = (low + high) >>> 1; if (decompositionRecords[mid * 3]! < cp) low = mid + 1; else high = mid; } const at = low * 3; if (decompositionRecords[at] !== cp || decompositionRecords[at + 2]! < 0 && !compatibility) return null; let result = decompositionCache.get(cp); if (!result) { result = Object.freeze(decompositionValues.slice(decompositionRecords[at + 1]!, decompositionRecords[at + 1]! + Math.abs(decompositionRecords[at + 2]!))); decompositionCache.set(cp, result); } return result; }
export function normalizationComposition(first: number, second: number): number | null { const key = first * 0x110000 + second; let low = 0, high = compositionRecords.length / 2; while (low < high) { const mid = (low + high) >>> 1; if (compositionRecords[mid * 2]! < key) low = mid + 1; else high = mid; } return compositionRecords[low * 2] === key ? compositionRecords[low * 2 + 1]! : null; }
`;
await writeFile("src/core/unicode-shaping-data.ts", source);
await mkdir("tests/fixtures/unicode-shaping", { recursive: true });
for (const name of ["UnicodeData", "NormalizationTest", "Scripts", "ScriptExtensions", "PropertyValueAliases", "DerivedCoreProperties", "PropList"]) {
    const stripped = data[name].split(/\r?\n/).map(line => line.replace(/#.*/, "").trim()).filter(Boolean).join("\n") + "\n";
    await writeFile(`tests/fixtures/unicode-shaping/${name}.txt.gz`, gzipSync(stripped, { level: 9 }));
}
console.log(JSON.stringify({ unicode: "18.0.0", scripts: scripts.length, scriptRanges: compress(script).length / 2, extensionRanges: extensions.length, extensionSets: sets.length, categories: categories.length, combiningRanges: compress(ccc).length / 2, decompositions: decompositions.length, compositions: pairs.length, sourceBytes: Buffer.byteLength(source), glyphDataCodeCopied: false }));
