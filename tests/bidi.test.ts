import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolveBidi } from "../src/index.ts";
import type { BidiDirection } from "../src/index.ts";
import { bidiClass } from "../src/core/bidi-data.ts";

const fixture = (name: string) => gunzipSync(readFileSync(new URL(`./fixtures/bidi/${name}.txt.gz`, import.meta.url))).toString("utf8").trim().split("\n");
const numbers = (text: string) => text.trim() ? text.trim().split(/\s+/).map(Number) : [];
const levels = (text: string) => text.trim() ? text.trim().split(/\s+/).map(v => v === "x" ? null : Number(v)) : [];

test("Unicode bidi properties cover every code point, including specialized unassigned defaults", () => {
    const expected = new Array<string>(0x110000).fill("L"), aliases: Record<string, string> = { Left_To_Right: "L", Right_To_Left: "R", Arabic_Letter: "AL", European_Terminator: "ET" };
    const lines = fixture("classes");
    for (const missing of [true, false]) for (let line of lines) {
        if (line.startsWith("@missing:") !== missing) continue; line = line.replace("@missing:", "");
        const [range, value] = line.split(";").map(v => v.trim()), [first, last] = range!.split("..").map(v => parseInt(v, 16));
        expected.fill(aliases[value!] ?? value!, first!, (last ?? first!) + 1);
    }
    for (let cp = 0; cp < expected.length; cp++) if (bidiClass(cp) !== expected[cp]) assert.fail(`Bidi class mismatch U+${cp.toString(16)}`);
    assert.throws(() => bidiClass(-1)); assert.throws(() => bidiClass(0x110000));
});

test("Unicode 18 bidi type conformance: every declared direction, resolved level and visual order", () => {
    const characters: Record<string, string> = { L: "a", R: "א", AL: "ا", EN: "1", ES: "+", ET: "$", AN: "١", CS: ",", NSM: "\u0300", BN: "\0", B: "\u2029", S: "\t", WS: " ", ON: "!", LRE: "\u202a", LRO: "\u202d", RLE: "\u202b", RLO: "\u202e", PDF: "\u202c", LRI: "\u2066", RLI: "\u2067", FSI: "\u2068", PDI: "\u2069" };
    let expectedLevels: readonly (number | null)[] = [], expectedOrder: readonly number[] = [], cases = 0;
    for (const line of fixture("types")) {
        if (line.startsWith("@Levels:")) { expectedLevels = levels(line.slice(8)); continue; }
        if (line.startsWith("@Reorder:")) { expectedOrder = numbers(line.slice(9)); continue; }
        if (line.startsWith("@")) continue;
        const [input, flags] = line.split(";"), text = input!.trim().split(/\s+/).map(type => { assert.ok(characters[type]); return characters[type]; }).join("");
        for (const [mask, direction] of [[1, "auto"], [2, "ltr"], [4, "rtl"]] as const) if (parseInt(flags!, 16) & mask) {
            const actual = resolveBidi(text, direction); cases++;
            if (JSON.stringify(actual.levels) !== JSON.stringify(expectedLevels) || JSON.stringify(actual.order) !== JSON.stringify(expectedOrder)) assert.fail(JSON.stringify({ input, direction, expectedLevels, expectedOrder, actual }));
        }
    }
    assert.ok(cases > 750_000); console.log(`Bidi type conformance: ${cases} direction cases.`);
});

test("Unicode 18 character conformance: brackets, canonical pairs, isolates and depth overflow", () => {
    let cases = 0;
    for (const line of fixture("characters")) {
        const [input, requested, base, expectedLevels, expectedOrder] = line.split(";"), cps = input!.trim().split(/\s+/).map(v => parseInt(v, 16));
        const text = cps.map(cp => String.fromCodePoint(cp)).join(""), offsets: number[] = []; let offset = 0;
        for (const cp of cps) { offsets.push(offset); offset += cp > 0xffff ? 2 : 1; }
        const direction = (["ltr", "rtl", "auto"] as const)[Number(requested)]!, actual = resolveBidi(text, direction), gotLevels = offsets.map(o => actual.levels[o]), gotOrder = actual.order.map(o => offsets.indexOf(o)); cases++;
        if (actual.paragraphs[0]?.level !== Number(base) || JSON.stringify(gotLevels) !== JSON.stringify(levels(expectedLevels!)) || JSON.stringify(gotOrder) !== JSON.stringify(numbers(expectedOrder!))) assert.fail(JSON.stringify({ input, direction, expectedLevels, expectedOrder, gotLevels, gotOrder, paragraphs: actual.paragraphs }));
    }
    assert.ok(cases > 90_000); console.log(`Bidi character conformance: ${cases} paragraphs.`);
});

test("bidi paragraphs use raw UTF-16 identities, immutable results and independent automatic directions", () => {
    const result = resolveBidi("א😀\r\na\u2029ب", "auto");
    assert.deepEqual(result.paragraphs, [{ from: 0, to: 5, level: 1 }, { from: 5, to: 7, level: 0 }, { from: 7, to: 8, level: 1 }]);
    assert.equal(result.levels[1], result.levels[2]); assert.equal(result.order.includes(2), false);
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.levels)); assert.ok(Object.isFrozen(result.order)); assert.ok(result.paragraphs.every(Object.isFrozen));
    assert.deepEqual(resolveBidi("").paragraphs, [{ from: 0, to: 0, level: 0 }]);
    assert.throws(() => resolveBidi("a", "invalid" as BidiDirection));
});
