import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { TextBuffer, canonicalCombiningClass, normalizeText, unicodeBidiControl, unicodeCategory, unicodeDefaultIgnorable,
    unicodeJoinControl, unicodeScript, unicodeScriptExtensions, unicodeShapingVersion, unicodeVariationSelector } from "../src/index.ts";

const read = async (name: string) => gunzipSync(await readFile(new URL(`fixtures/unicode-shaping/${name}.txt.gz`, import.meta.url))).toString("utf8");
const records = (text: string) => text.split(/\r?\n/).filter(line => line && !line.startsWith("@")).map(line => line.split(";").map(v => v.trim()));
const range = (text: string): readonly [number, number] => { const parts = text.split("..").map(v => parseInt(v, 16)); return [parts[0]!, parts[1] ?? parts[0]!]; };
const decoded = (text: string) => text.trim().split(/\s+/).filter(Boolean).map(v => parseInt(v, 16));
const expected = (async () => {
    const names = ["UnicodeData", "Scripts", "ScriptExtensions", "PropertyValueAliases", "DerivedCoreProperties", "PropList", "NormalizationTest"] as const;
    const loaded = await Promise.allSettled(names.map(async name => [name, await read(name)] as const)); const files = new Map<string, string>(); for (const item of loaded) { if (item.status === "rejected") throw item.reason; files.set(...item.value); }
    const aliases = new Map<string, string>(); for (const row of records(files.get("PropertyValueAliases")!)) if (row[0] === "sc") for (const name of row.slice(1)) aliases.set(name, row[1]!);
    const scripts: string[] = Array<string>(0x110000).fill("Zzzz"), categories: string[] = Array<string>(0x110000).fill("Cn"), classes = new Uint8Array(0x110000), flags = new Uint8Array(0x110000), extensions = new Map<number, readonly string[]>(); let first = 0;
    for (const row of records(files.get("UnicodeData")!)) { const cp = parseInt(row[0]!, 16); if (row[1]!.endsWith(", First>")) { first = cp; continue; } const from = row[1]!.endsWith(", Last>") ? first : cp; categories.fill(row[2]!, from, cp + 1); classes.fill(Number(row[3]), from, cp + 1); }
    for (const [text, name] of records(files.get("Scripts")!)) { const [from, to] = range(text!); scripts.fill(aliases.get(name!)!, from, to + 1); }
    for (const [text, names] of records(files.get("ScriptExtensions")!)) { const [from, to] = range(text!), values = names!.split(/\s+/).map(n => aliases.get(n)!).sort(); for (let cp = from; cp <= to; cp++) extensions.set(cp, values); }
    for (const [file, property, bit] of [["DerivedCoreProperties", "Default_Ignorable_Code_Point", 1], ["PropList", "Variation_Selector", 2], ["PropList", "Join_Control", 4], ["PropList", "Bidi_Control", 8]] as const)
        for (const [text, name] of records(files.get(file)!)) if (name === property) { const [from, to] = range(text!); for (let cp = from; cp <= to; cp++) flags[cp] = flags[cp]! | bit; }
    return { files, scripts, categories, classes, flags, extensions };
})();

test("Unicode 18 shaping facts match the reviewed property files for every code point", async () => {
    const facts = await expected; assert.equal(unicodeShapingVersion, "18.0.0");
    for (let cp = 0; cp <= 0x10ffff; cp++) {
        assert.equal(unicodeScript(cp), facts.scripts[cp], `script ${cp}`); assert.equal(unicodeCategory(cp), facts.categories[cp], `category ${cp}`); assert.equal(canonicalCombiningClass(cp), facts.classes[cp], `ccc ${cp}`);
        assert.equal(unicodeDefaultIgnorable(cp), !!(facts.flags[cp]! & 1)); assert.equal(unicodeVariationSelector(cp), !!(facts.flags[cp]! & 2)); assert.equal(unicodeJoinControl(cp), !!(facts.flags[cp]! & 4)); assert.equal(unicodeBidiControl(cp), !!(facts.flags[cp]! & 8));
        const scripts = unicodeScriptExtensions(cp); assert.equal(scripts.join(" "), (facts.extensions.get(cp) ?? [facts.scripts[cp]!]).join(" "), `extensions ${cp}`); assert.ok(Object.isFrozen(scripts));
    }
    for (const cp of [-1, 0x110000, NaN, .5]) { assert.throws(() => unicodeScript(cp)); assert.throws(() => canonicalCombiningClass(cp)); assert.throws(() => unicodeScriptExtensions(cp)); }
    console.log("Unicode shaping facts: 1114112 code points, including Script_Extensions and control flags.");
});

test("Unicode 18 normalization conformance: all four forms and every declared invariant", async () => {
    const facts = await expected; let rows = 0, conditions = 0;
    for (const line of facts.files.get("NormalizationTest")!.split(/\r?\n/)) {
        if (!line || line.startsWith("@")) continue; const columns = line.split(";").slice(0, 5).map(v => String.fromCodePoint(...decoded(v)));
        for (const [form, targets] of [["NFC", [1, 1, 1, 3, 3]], ["NFD", [2, 2, 2, 4, 4]], ["NFKC", [3, 3, 3, 3, 3]], ["NFKD", [4, 4, 4, 4, 4]]] as const) for (let i = 0; i < 5; i++) {
            const source = TextBuffer.from(columns[i]!), result = normalizeText(source, { form }); assert.equal(result.text(), columns[targets[i]!], `${rows}:${form}:${i}:${line}`); assert.equal(source.readMetrics().textExports, 0); conditions++;
        } rows++;
    }
    assert.equal(rows, 20_171); assert.equal(conditions, 403_420); console.log(`Unicode normalization invariants: ${rows} rows, ${conditions} form checks.`);
});

test("Unicode 18 normalization conformance: every other assigned code point is stable", async () => {
    const facts = await expected, listed = new Set<number>(); let part = "";
    for (const line of facts.files.get("NormalizationTest")!.split(/\r?\n/)) { if (line.startsWith("@")) { part = line.trim(); continue; } if (!line || part !== "@Part1") continue; const points = decoded(line.split(";")[0]!); assert.equal(points.length, 1); listed.add(points[0]!); }
    let points = 0, conditions = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) { if (facts.categories[cp] === "Cn" || cp >= 0xd800 && cp <= 0xdfff || listed.has(cp)) continue; const text = String.fromCodePoint(cp), source = TextBuffer.from(text);
        for (const form of ["NFC", "NFD", "NFKC", "NFKD"] as const) { assert.equal(normalizeText(source, { form }).text(), text, `stable ${cp}:${form}`); conditions++; } points++;
    }
    assert.ok(points > 250_000); assert.equal(conditions, points * 4); console.log(`Unicode normalization stability: ${points} other assigned points, ${conditions} form checks.`);
});
