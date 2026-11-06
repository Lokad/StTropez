import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const directory = process.argv[2]; if (!directory) throw new Error("Supply reviewed Unicode18 data.");
assert.ok((await readFile(resolve(directory, "ReadMe.txt"), "utf8")).includes("final data files for version 18.0.0"));
assert.equal((await readFile(resolve(directory, "license.txt"), "utf8")).replaceAll("\r\n", "\n"), (await readFile("licenses/Unicode-3.0.txt", "utf8")).replaceAll("\r\n", "\n"));
const rows = (await readFile(resolve(directory, "UnicodeData.txt"), "utf8")).trim().split(/\r?\n/).map(line => line.split(";")), ccc = new Map(rows.map(r => [parseInt(r[0], 16), Number(r[3])])), mappings = new Map();
for (const r of rows) if (r[5] && !r[5].startsWith("<")) mappings.set(parseInt(r[0], 16), r[5].split(" ").map(v => parseInt(v, 16)));
function nfd(cp) {
    const expansion = mappings.get(cp); if (!expansion) return [cp]; const values = expansion.flatMap(nfd);
    for (let i = 1; i < values.length; i++) { let j = i; const cls = ccc.get(values[i]) ?? 0; while (cls && j > 0 && (ccc.get(values[j - 1]) ?? 0) > cls) { [values[j], values[j - 1]] = [values[j - 1], values[j]]; j--; } } return values;
}
const entries = [...mappings.keys()].map(cp => [cp, nfd(cp)]).sort((a, b) => a[1][0] - b[1][0] || b[1].length - a[1].length || a[0] - b[0]);
const flat = [], records = []; for (const [cp, expansion] of entries) { records.push(expansion[0], cp, flat.length, expansion.length); flat.push(...expansion); }
const lines = values => Array.from({ length: Math.ceil(values.length / 24) }, (_, i) => "    " + values.slice(i * 24, (i + 1) * 24).join(", ")).join(",\n");
const source = `// Generated Unicode18 canonical-equivalence facts; Unicode License V3 in licenses/Unicode-3.0.txt.
// Canonical mappings include composition exclusions and singleton aliases. Hangul is algorithmic.
export type CanonicalVariant = Readonly<{ codePoint: number; decomposition: readonly number[] }>;
const records: readonly number[] = [\n${lines(records)}\n];
const values: readonly number[] = [\n${lines(flat)}\n];
export const canonicalVariantCount = ${entries.length};
const cache = new Map<number, CanonicalVariant>();
export function canonicalVariantRange(first: number): readonly [number, number] {
    let low = 0, high = records.length / 4; while (low < high) { const mid = (low + high) >>> 1; if (records[mid * 4]! < first) low = mid + 1; else high = mid; } const start = low;
    high = records.length / 4; while (low < high) { const mid = (low + high) >>> 1; if (records[mid * 4]! <= first) low = mid + 1; else high = mid; } return [start, low];
}
export function canonicalVariantAt(index: number): CanonicalVariant {
    if (!Number.isSafeInteger(index) || index < 0 || index >= canonicalVariantCount) throw new RangeError("Invalid canonical variant.");
    let result = cache.get(index); if (!result) { const p = index * 4; result = Object.freeze({ codePoint: records[p + 1]!, decomposition: Object.freeze(values.slice(records[p + 2]!, records[p + 2]! + records[p + 3]!)) }); cache.set(index, result); } return result;
}
`;
await writeFile("src/core/canonical-variants.ts", source); console.log(JSON.stringify({ unicode: "18.0.0", variants: entries.length, decompositionPoints: flat.length, bytes: Buffer.byteLength(source) }));
