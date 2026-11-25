import test from "node:test";
import { nextSeed } from "../fixtures/workloads.ts";
import assert from "node:assert/strict";
import { decorationParts, validDecorationClass } from "../src/browser/decoration-parts.ts";
import type { RowPart } from "../src/browser/decoration-parts.ts";
import type { InlineDecoration } from "../src/browser/viewport.ts";

test("a zero-width line label paints once at the last fragment", () => {
    const label = { from: 2, to: 2, className: "note", afterLine: "12 rows" };
    const point = { from: 1, to: 1, className: "stop" };
    const parts = [
        ...decorationParts("abc", 0, 3, 6, [label, point], []),
        ...decorationParts("def", 3, 6, 6, [label], [], 0),
    ];
    assert.deepEqual(parts.filter(part => part.ornament).map(part => [part.ornament, part.className, part.label]),
        [["point", "stop", undefined], ["afterLine", "note", "12 rows"]]);
    assert.equal(parts.at(-1)?.ornament, "afterLine");
    assert.equal(parts.map(part => part.text).join(""), "abcdef");
});

// Deliberately scan individual UTF-16 units and every range. This oracle shares neither
// sorted events nor an active-set merge with the production sweep.
function oracle(text: string, from: number, to: number, length: number, decorations: readonly InlineDecoration[], selections: readonly { from: number; to: number }[]): RowPart[] {
    const validName = (name: string) => name.length <= 256 && /^[a-zA-Z][\w-]{0,63}( [a-zA-Z][\w-]{0,63})*$/.test(name);
    const valid = decorations.filter(r => Number.isSafeInteger(r.from) && Number.isSafeInteger(r.to) && r.from >= 0 && r.to <= length && r.from < r.to
        && r.from < to && r.to > from && validName(r.className));
    const points = decorations.filter(r => Number.isSafeInteger(r.from) && r.from === r.to && r.from >= from && r.from <= to
        && validName(r.className));
    const parts: { text: string; className: string; ornament?: "point"; properties?: InlineDecoration["properties"] }[] = [];
    for (let at = from; at <= to; at++) {
        const here = points.filter(r => r.from === at);
        for (const range of here) parts.push({ text: "", className: range.className, ornament: "point", properties: undefined });
        if (at === to) break;
        const names = valid.filter(r => r.from <= at && at < r.to).map(r => r.className);
        if (selections.some(r => r.from <= at && at < r.to)) names.push("st-viewport-selected");
        if (at === from || here.length || valid.some(r => r.from === at || r.to === at) || selections.some(r => r.from === at || r.to === at)) parts.push({ text: "", className: names.join(" ") });
        parts.at(-1)!.text += text[at - from]!;
    }
    return parts;
}

test("decoration sweep agrees with a per-unit oracle for clipped overlaps, host order, duplicate classes and selection layering", () => {
    let seed = 71529; const random = (n: number) => { seed = nextSeed(seed) | 0; return (seed >>> 0) % n; };
    const source = "ab😀é␍cd\ud800xy".repeat(3);
    const names = ["first", "second", "first", "-bad", "with space", "valid .invalid", "st-viewport-selected", "x".repeat(65)];
    for (let trial = 0; trial < 500; trial++) {
        const from = random(source.length), to = from + 1 + random(source.length - from), text = source.slice(from, to);
        const decorations = Array.from({ length: 1 + random(24) }, () => ({ from: random(source.length + 6) - 3, to: random(source.length + 6), className: names[random(names.length)]! }));
        const selections = Array.from({ length: random(5) }, () => { const start = from + random(to - from); return { from: start, to: start + 1 + random(to - start) }; });
        const before = JSON.stringify({ decorations, selections });
        assert.deepEqual(decorationParts(text, from, to, source.length, decorations, selections), oracle(text, from, to, source.length, decorations, selections), `seeded trial ${trial}`);
        assert.equal(JSON.stringify({ decorations, selections }), before);
    }
    assert.deepEqual(decorationParts("", 0, 0, 0, undefined, []), [{ text: "", className: "" }]);
    assert.deepEqual(decorationParts("", 0, 0, 0, [{ from: 0, to: 1, className: "x" }], []), []);
    for (const from of [NaN, Infinity, .5, -1]) assert.deepEqual(decorationParts("abc", 0, 3, 3, [{ from, to: 2, get className(): string { throw new Error("Invalid range must be filtered before reading its class."); } }], []), [{ text: "abc", className: "" }]);
});

test("disjoint decoration endpoint reads grow linearly and shared endpoints retain every ordered class", () => {
    for (const count of [64, 128, 256, 1024]) {
        let reads = 0; const text = "x".repeat(count * 2), ranges = Array.from({ length: count }, (_, i) => ({ get from() { reads++; return i * 2; }, get to() { reads++; return i * 2 + 1; }, className: "color" }));
        const parts = decorationParts(text, 0, text.length, text.length, ranges, []);
        assert.ok(reads <= count * 2); assert.equal(parts.length, count * 2); assert.equal(parts.map(p => p.text).join(""), text);
        assert.ok(parts.every((p, i) => p.className === (i % 2 ? "" : "color")));
        const overlap = Array.from({ length: count }, (_, i) => ({ from: 0, to: 1, className: `color-${i}` }));
        assert.deepEqual(decorationParts("xy", 0, 2, 2, overlap, []), [{ text: "x", className: overlap.map(r => r.className).join(" ") }, { text: "y", className: "" }]);
    }
    for (let i = 0; i < 1000; i++) assert.equal(validDecorationClass(`color-${i}`), true);
    for (const name of ["", " with-space", "a.b", "-x", "_x", "é", "a".repeat(65)]) assert.equal(validDecorationClass(name), false);
    assert.equal(validDecorationClass("a".repeat(64)), true);
});
