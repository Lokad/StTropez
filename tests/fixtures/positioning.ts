import { FontBytes, assembleFont, cmapTable, fixtureMappings, fontFixture, fontTables } from "./consumer/font-fixture.ts";
import { classes, contexts, coverage, coverageContext, gdef, gsub, language, ligatures, lookup, script, table, words } from "./substitution.ts";
export type TestValue = readonly (number | Uint8Array | undefined)[];
type Link = { at: number; bytes: Uint8Array; wide?: boolean };
const valueFormat = (records: readonly TestValue[]) => records.reduce((mask, record) => record.reduce<number>((value, field, bit) => value | (field === undefined ? 0 : 1 << bit), mask), 0);
function valueWords(format: number, record: TestValue, at: number, links: Link[]): number[] {
    const result: number[] = []; for (let bit = 0; bit < 8; bit++) if (format & 1 << bit) { const field = record[bit]; if (field instanceof Uint8Array) links.push({ at: at + result.length, bytes: field }); result.push(typeof field === "number" ? field : 0); } return result;
}
export function singlePos(glyphs: readonly number[], records: readonly TestValue[], format = records.length === 1 ? 1 : 2): Uint8Array {
    const flags = valueFormat(records), header = [format, 0, flags, ...format === 2 ? [records.length] : []], links: Link[] = [{ at: 1, bytes: coverage(glyphs) }];
    for (const record of records) header.push(...valueWords(flags, record, header.length, links)); return table(words(...header), links);
}
export function pairPos(sets: readonly Readonly<{ first: number; pairs: readonly Readonly<{ second: number; firstValue: TestValue; secondValue?: TestValue }>[] }>[]): Uint8Array {
    const f1 = valueFormat(sets.flatMap(s => s.pairs.map(p => p.firstValue))), f2 = valueFormat(sets.flatMap(s => s.pairs.map(p => p.secondValue ?? [])));
    const links: Link[] = [{ at: 1, bytes: coverage(sets.map(s => s.first)) }];
    sets.forEach((set, i) => { const data = [set.pairs.length], device: Link[] = [];
        for (const pair of set.pairs) { data.push(pair.second); data.push(...valueWords(f1, pair.firstValue, data.length, device)); data.push(...valueWords(f2, pair.secondValue ?? [], data.length, device)); }
        links.push({ at: 5 + i, bytes: table(words(...data), device) }); });
    return table(words(1, 0, f1, f2, sets.length, ...sets.map(() => 0)), links);
}
export function pairClassPos(glyphs: readonly number[], class1: Uint8Array, class2: Uint8Array, matrix: readonly (readonly Readonly<{ first: TestValue; second?: TestValue }>[])[]): Uint8Array {
    const rows = matrix.length, columns = matrix[0]!.length, values = matrix.flat(), f1 = valueFormat(values.map(v => v.first)), f2 = valueFormat(values.map(v => v.second ?? [])), header = [2, 0, f1, f2, 0, 0, rows, columns], links: Link[] = [{ at: 1, bytes: coverage(glyphs) }, { at: 4, bytes: class1 }, { at: 5, bytes: class2 }];
    for (const value of values) { header.push(...valueWords(f1, value.first, header.length, links)); header.push(...valueWords(f2, value.second ?? [], header.length, links)); } return table(words(...header), links);
}
export function anchor(x: number, y: number, options: Readonly<{ point?: number; xDevice?: Uint8Array; yDevice?: Uint8Array }> = {}): Uint8Array {
    if (options.point !== undefined) return words(2, x, y, options.point);
    if (options.xDevice || options.yDevice) return table(words(3, x, y, 0, 0), [...options.xDevice ? [{ at: 3, bytes: options.xDevice }] : [], ...options.yDevice ? [{ at: 4, bytes: options.yDevice }] : []]); return words(1, x, y);
}
export const device = (first: number, last: number, format: number, packed: readonly number[]) => words(first, last, format, ...packed);
export const variationIndex = (outer: number, inner: number) => words(outer, inner, 0x8000);
export function cursivePos(glyphs: readonly number[], entries: readonly Readonly<{ entry?: Uint8Array; exit?: Uint8Array }>[]): Uint8Array {
    const links: Link[] = [{ at: 1, bytes: coverage(glyphs) }]; entries.forEach((e, i) => { if (e.entry) links.push({ at: 3 + i * 2, bytes: e.entry }); if (e.exit) links.push({ at: 4 + i * 2, bytes: e.exit }); }); return table(words(1, 0, entries.length, ...entries.flatMap(() => [0, 0])), links);
}
export type TestMark = Readonly<{ glyph: number; markClass: number; anchor: Uint8Array }>;
export type TestTarget = Readonly<{ glyph: number; components: readonly (readonly (Uint8Array | null)[])[] }>;
export function markPos(type: 4 | 5 | 6, marks: readonly TestMark[], targets: readonly TestTarget[], classCount: number): Uint8Array {
    const markArray = table(words(marks.length, ...marks.flatMap(m => [m.markClass, 0])), marks.map((m, i) => ({ at: 2 + i * 2, bytes: m.anchor }))); let targetArray: Uint8Array;
    if (type === 5) targetArray = table(words(targets.length, ...targets.map(() => 0)), targets.map((target, i) => {
        const links: Link[] = []; target.components.forEach((anchors, component) => anchors.forEach((bytes, cls) => { if (bytes) links.push({ at: 1 + component * classCount + cls, bytes }); }));
        return { at: 1 + i, bytes: table(words(target.components.length, ...target.components.flatMap(() => new Array<number>(classCount).fill(0))), links) }; }));
    else { const links: Link[] = []; targets.forEach((target, i) => target.components[0]!.forEach((bytes, cls) => { if (bytes) links.push({ at: 1 + i * classCount + cls, bytes }); })); targetArray = table(words(targets.length, ...targets.flatMap(() => new Array<number>(classCount).fill(0))), links); }
    return table(words(1, 0, 0, classCount, 0, 0), [{ at: 1, bytes: coverage(marks.map(m => m.glyph)) }, { at: 2, bytes: coverage(targets.map(t => t.glyph)) }, { at: 4, bytes: markArray }, { at: 5, bytes: targetArray }]);
}
export function positionFont(lookups: readonly Uint8Array[], options: Readonly<{ definition?: Uint8Array; feature?: string; selected?: readonly number[]; variations?: Uint8Array; fvar?: Uint8Array; kern?: Uint8Array }> = {}): Uint8Array {
    const tables = fontTables(fontFixture()); tables.delete("kern"); tables.set("GPOS", gsub(lookups, { features: [{ tag: options.feature ?? "kern", lookups: options.selected ?? lookups.map((_, i) => i) }], ...options.variations ? { variations: options.variations } : {} }));
    if (options.definition) tables.set("GDEF", options.definition); if (options.fvar) tables.set("fvar", options.fvar); if (options.kern) tables.set("kern", options.kern); return assembleFont(tables);
}
export function variableDefinition(store: Uint8Array, glyphClasses?: Uint8Array): Uint8Array {
    return table(words(1, 3, 0, 0, 0, 0, 0, 0, 0), [...glyphClasses ? [{ at: 2, bytes: glyphClasses }] : [], { at: 7, bytes: store, wide: true }]);
}
export function itemVariationStore(regions: readonly (readonly (readonly [number, number, number])[])[], data: readonly Uint8Array[]): Uint8Array {
    const regionData = words(regions[0]?.length ?? 0, regions.length, ...regions.flatMap(region => region.flatMap(axis => axis.map(value => value * 16384))));
    return table(words(1, 0, 0, data.length, ...data.flatMap(() => [0, 0])), [{ at: 1, bytes: regionData, wide: true }, ...data.map((bytes, i) => ({ at: 4 + i * 2, bytes, wide: true }))]);
}
export const fvarAxis = () => new FontBytes(36).u32(0, 0x10000).u16(4, 16).u16(6, 2).u16(8, 1).u16(10, 20).u16(14, 4).data;
export function kernPairs(entries: readonly (readonly [number, number, number])[], coverage = 1): Uint8Array {
    return words(0, 1, 0, 14 + entries.length * 6, coverage, entries.length, 0, 0, 0, ...entries.flat());
}
export function kernClass(value = -100): Uint8Array {
    const sub = table(words(0, 0, 0x201, 4, 0, 0, 0), [{ at: 4, bytes: words(2, 1, 4) }, { at: 5, bytes: words(3, 1, 2) }, { at: 6, bytes: words(0, 0, 0, value) }]);
    new DataView(sub.buffer).setUint16(2, sub.length); return new FontBytes(4 + sub.length).u16(2, 1).put(4, sub).data;
}

export function nativePositioningCases() {
    type NativeCase = { name: string; text: string; bytes: Uint8Array; width: number; feature: string; direction: "ltr" | "rtl"; legacy: boolean; substitute: boolean; points?: readonly Readonly<{ glyphId: number; pointIndex: number; x: number; y: number }>[] };
    const result: NativeCase[] = [], definition = gdef(classes(0, [0, 1, 1, 1, 1, 1, 2, 3, 2, 3]));
    const add = (name: string, text: string, entries: readonly Uint8Array[], width: number, options: Readonly<{ definition?: Uint8Array; selected?: readonly number[]; direction?: "ltr" | "rtl"; points?: NativeCase["points"] }> = {}) => {
        const tables = fontTables(positionFont(entries, { feature: "test", ...options })); tables.delete("GSUB"); result.push({ name, text, bytes: assembleFont(tables), width, feature: "test", direction: options.direction ?? "ltr", legacy: false, substitute: false, ...options.points ? { points: options.points } : {} });
    };
    add("single-shared", "AA", [lookup(1, [singlePos([2], [[10, 20, -100]])])], 100);
    add("single-indexed", "AB", [lookup(1, [singlePos([2, 3], [[10, 20, -100], [-20, 0, 50]])])], 125);
    add("single-character", "A", [lookup(1, [singlePos([2], [[10, 20, -100]])])], 50);
    add("pair-values", "AB", [lookup(2, [pairPos([{ first: 2, pairs: [{ second: 3, firstValue: [undefined, undefined, -100], secondValue: [20, undefined, -50] }] }])])], 115);
    add("pair-overlap", "ABB", [lookup(2, [pairPos([{ first: 2, pairs: [{ second: 3, firstValue: [undefined, undefined, -100] }] }, { first: 3, pairs: [{ second: 3, firstValue: [undefined, undefined, -10] }] }])])], 189);
    const zero = { first: [undefined, undefined, 0] }, kern = { first: [undefined, undefined, -100] };
    add("pair-classes", "AB", [lookup(2, [pairClassPos([2], classes(2, [1]), classes(3, [1]), [[zero, zero], [zero, kern]])])], 120);
    const cursive = cursivePos([2, 3], [{ exit: anchor(500, 100) }, { entry: anchor(100, 300) }]);
    add("cursive-first-baseline", "AB", [lookup(3, [cursive])], 110); add("cursive-last-baseline", "AB", [lookup(3, [cursive], 1)], 110);
    const rule = { rest: [3, 4], actions: [[1, 1]] as const };
    [contexts([2], [[rule]]), contexts([2], [null, [{ ...rule, rest: [2, 3] }]], { inputClass: classes(2, [1, 2, 3]) }), coverageContext([[2], [3], [4]], [[1, 1]])].forEach((data, i) =>
        add(`context-${i + 1}`, "ABf", [lookup(7, [data]), lookup(1, [singlePos([3], [[undefined, 80, -100]])])], 160, { selected: [0] }));
    const chain = { rest: [3], back: [5, 4], ahead: [2], actions: [[1, 1]] as const };
    [contexts([2], [[chain]], { chain: true }), contexts([2], [null, [{ rest: [2], back: [2, 1], ahead: [1], actions: [[1, 1]] }]], { chain: true, backClass: classes(4, [1, 2]), inputClass: classes(2, [1, 2]), aheadClass: classes(2, [1]) }), coverageContext([[2], [3]], [[1, 1]], [[5], [4]], [[2]])].forEach((data, i) =>
        add(`chain-${i + 1}`, "fiABA", [lookup(8, [data]), lookup(1, [singlePos([3], [[undefined, 80, -100]])])], 240, { selected: [0] }));
    const mark = { glyph: 9, markClass: 0, anchor: anchor(50, 700) }, base = markPos(4, [mark], [{ glyph: 2, components: [[anchor(300, 700)]] }], 1);
    add("mark-base", "A\u0301", [lookup(4, [base])], 60, { definition });
    add("mark-stack", "A\u0301\u0301", [lookup(4, [base]), lookup(6, [markPos(6, [mark], [{ glyph: 9, components: [[anchor(100, 850)]] }], 1)])], 60, { definition });
    const lig = markPos(5, [mark], [{ glyph: 6, components: [[anchor(200, 700)], [anchor(400, 700)]] }], 1), ligTables = fontTables(positionFont([lookup(5, [lig])], { feature: "test", definition }));
    ligTables.set("GSUB", gsub([lookup(4, [ligatures([4], [[{ to: 6, rest: [5] }]])], 8)], { features: [{ tag: "liga", lookups: [0] }] }));
    result.push({ name: "mark-ligature", text: "f\u0301i\u0301", bytes: assembleFont(ligTables), width: 50, feature: "test", direction: "ltr", legacy: false, substitute: true });
    const target = singlePos([2], [[undefined, undefined, -100]]); add("extension", "AA", [lookup(9, [table(words(1, 1, 0, 0), [{ at: 2, wide: true, bytes: target }])])], 100);
    add("rtl-pair", "BA", [lookup(2, [pairPos([{ first: 3, pairs: [{ second: 2, firstValue: [undefined, undefined, -100] }] }])])], 120, { direction: "rtl" });
    add("device-advance", "AA", [lookup(1, [singlePos([2], [[undefined, undefined, 0, undefined, undefined, undefined, device(100, 100, 3, [0x0200])]])])], 124);
    add("contour-anchor", "A\u0301", [lookup(4, [markPos(4, [{ ...mark, anchor: anchor(50, 700, { point: 2 }) }], [{ glyph: 2, components: [[anchor(300, 700)]] }], 1)])], 60, { definition, points: [{ glyphId: 9, pointIndex: 2, x: 150, y: 850 }] });
    result.push({ name: "legacy-pair", text: "AB", bytes: fontFixture(), width: 120, feature: "test", direction: "ltr", legacy: true, substitute: true });
    const hebrew = fontTables(positionFont([lookup(2, [pairPos([{ first: 3, pairs: [{ second: 2, firstValue: [undefined, undefined, -100] }] }])])], { feature: "test" })), mappings = [...fixtureMappings.map(pair => [pair[0]!, pair[1]!] as const), [0x5d0, 2] as const, [0x5d1, 3] as const].sort(([a], [b]) => a - b);
    hebrew.delete("GSUB"); const cmap = new FontBytes(16 + mappings.length * 12).u16(0, 12).u32(4, 16 + mappings.length * 12).u32(12, mappings.length); mappings.forEach(([code, glyph], i) => cmap.u32(16 + i * 12, code).u32(20 + i * 12, code).u32(24 + i * 12, glyph));
    hebrew.set("cmap", cmapTable([{ platform: 3, encoding: 10, bytes: cmap.data }])); result.push({ name: "hebrew-rtl-pair", text: "בא", bytes: assembleFont(hebrew), width: 120, feature: "test", direction: "rtl", legacy: false, substitute: false });
    result.push({ ...result.find(c => c.name === "rtl-pair")!, name: "reverse-pair-ltr-control", direction: "ltr" });
    hebrew.set("GPOS", gsub([lookup(1, [singlePos([2], [[undefined, undefined, -100]])])], { features: [{ tag: "test", lookups: [0] }] }));
    result.push({ name: "hebrew-rtl-single", text: "אא", bytes: assembleFont(hebrew), width: 100, feature: "test", direction: "rtl", legacy: false, substitute: false });
    hebrew.set("GPOS", gsub([lookup(2, [pairPos([{ first: 2, pairs: [{ second: 3, firstValue: [undefined, undefined, -100] }] }])])], { features: [{ tag: "test", lookups: [0] }] }));
    result.push({ name: "hebrew-visual-pair-control", text: "בא", bytes: assembleFont(hebrew), width: 130, feature: "test", direction: "rtl", legacy: false, substitute: false });
    const scripts = [{ tag: "DFLT", bytes: script(language([0])) }, { tag: "hebr", bytes: script(language([0])) }];
    hebrew.set("GSUB", gsub([], { scripts, features: [{ tag: "test", lookups: [] }] }));
    for (const [name, text, entry, width] of [
        ["registered-hebrew-single", "אא", lookup(1, [singlePos([2], [[undefined, undefined, -100]])]), 100],
        ["registered-hebrew-pair", "בא", lookup(2, [pairPos([{ first: 3, pairs: [{ second: 2, firstValue: [undefined, undefined, -100] }] }])]), 120],
        ["registered-hebrew-visual-pair", "בא", lookup(2, [pairPos([{ first: 2, pairs: [{ second: 3, firstValue: [undefined, undefined, -100] }] }])]), 130],
        ["registered-hebrew-cursive", "אב", lookup(3, [cursivePos([2, 3], [{ exit: anchor(100, 100) }, { entry: anchor(600, 300) }])]), 110],
        ["registered-hebrew-mark", "א\u0301", lookup(4, [base]), 60]
    ] as const) {
        hebrew.set("GPOS", gsub([entry], { scripts, features: [{ tag: "test", lookups: [0] }] }));
        hebrew.set("GDEF", definition);
        result.push({ name, text, bytes: assembleFont(hebrew), width, feature: "test", direction: "rtl", legacy: false, substitute: false });
    }
    hebrew.delete("GPOS"); hebrew.set("kern", fontTables(fontFixture()).get("kern")!);
    result.push({ name: "hebrew-rtl-legacy", text: "בא", bytes: assembleFont(hebrew), width: 120, feature: "test", direction: "rtl", legacy: true, substitute: false });
    add("single-placement-marked-control", "A\u0301", [lookup(1, [singlePos([2], [[10, 20, -100]])]), lookup(4, [base])], 50, { definition });
    const fallback = { ...result.find(c => c.name === "contour-anchor")!, name: "contour-fallback-control" }; delete fallback.points; result.push(fallback);
 return result;
}
