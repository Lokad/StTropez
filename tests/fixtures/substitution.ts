import { FontBytes, assembleFont, fontFixture, fontTables } from "./consumer/font-fixture.ts";
export const words = (...values: number[]): Uint8Array => { const b = new FontBytes(values.length * 2); values.forEach((v, i) => b.u16(i * 2, v)); return b.data; };
type Link = Readonly<{ at: number; bytes: Uint8Array; wide?: boolean }>;
export function table(header: Uint8Array, links: readonly Link[]): Uint8Array {
    const b = new FontBytes(header.length + links.reduce((sum, link) => sum + link.bytes.length, 0)).put(0, header); let at = header.length;
    for (const link of links) { if (link.wide) b.u32(link.at * 2, at); else b.u16(link.at * 2, at); b.put(at, link.bytes); at += link.bytes.length; } return b.data;
}
export const coverage = (glyphs: readonly number[]) => words(1, glyphs.length, ...glyphs);
export const ranges = (entries: readonly (readonly [number, number, number])[]) => words(2, entries.length, ...entries.flat());
export const classes = (first: number, values: readonly number[]) => words(1, first, values.length, ...values);
export const single = (from: readonly number[], to: readonly number[] | number, cov = coverage(from)) => table(typeof to === "number" ? words(1, 0, to) : words(2, 0, to.length, ...to), [{ at: 1, bytes: cov }]);
export const multiple = (from: readonly number[], sequences: readonly (readonly number[])[]) => table(words(1, 0, sequences.length, ...sequences.map(() => 0)), [{ at: 1, bytes: coverage(from) }, ...sequences.map((sequence, i) => ({ at: 3 + i, bytes: words(sequence.length, ...sequence) }))]);
export function ligatures(from: readonly number[], sets: readonly (readonly Readonly<{ to: number; rest: readonly number[] }>[])[]): Uint8Array {
    return table(words(1, 0, sets.length, ...sets.map(() => 0)), [{ at: 1, bytes: coverage(from) }, ...sets.map((set, i) => ({ at: 3 + i,
        bytes: table(words(set.length, ...set.map(() => 0)), set.map((entry, j) => ({ at: 1 + j, bytes: words(entry.to, entry.rest.length + 1, ...entry.rest) }))) }))]);
}
export type SequenceRule = Readonly<{ rest: readonly number[]; actions: readonly (readonly [number, number])[]; back?: readonly number[]; ahead?: readonly number[] }>;
function ruleData(rule: SequenceRule, chain: boolean): Uint8Array {
    const actions = rule.actions.flat(); return chain ? words(rule.back?.length ?? 0, ...rule.back ?? [], rule.rest.length + 1, ...rule.rest, rule.ahead?.length ?? 0, ...rule.ahead ?? [], rule.actions.length, ...actions)
        : words(rule.rest.length + 1, rule.actions.length, ...rule.rest, ...actions);
}
export function contexts(from: readonly number[], sets: readonly (readonly SequenceRule[] | null)[], options: Readonly<{ chain?: boolean; inputClass?: Uint8Array; backClass?: Uint8Array; aheadClass?: Uint8Array }> = {}): Uint8Array {
    const chain = options.chain ?? false, classified = !!options.inputClass, prefix = classified ? chain ? [2, 0, 0, 0, 0] : [2, 0, 0] : [1, 0], links: Link[] = [{ at: 1, bytes: coverage(from) }];
    if (classified) { if (chain) links.push({ at: 2, bytes: options.backClass! }, { at: 3, bytes: options.inputClass! }, { at: 4, bytes: options.aheadClass! }); else links.push({ at: 2, bytes: options.inputClass! }); }
    sets.forEach((set, i) => { if (set) links.push({ at: prefix.length + 1 + i, bytes: table(words(set.length, ...set.map(() => 0)), set.map((rule, j) => ({ at: 1 + j, bytes: ruleData(rule, chain) }))) }); });
    return table(words(...prefix, sets.length, ...sets.map(() => 0)), links);
}
export function coverageContext(input: readonly (readonly number[])[], actions: readonly (readonly [number, number])[], back?: readonly (readonly number[])[], ahead: readonly (readonly number[])[] = []): Uint8Array {
    const links: Link[] = []; let header: number[];
    if (!back) { header = [3, input.length, actions.length, ...input.map(() => 0), ...actions.flat()]; input.forEach((set, i) => links.push({ at: 3 + i, bytes: coverage(set) })); }
    else { header = [3]; for (const sequence of [back, input, ahead]) { header.push(sequence.length); for (const set of sequence) { links.push({ at: header.length, bytes: coverage(set) }); header.push(0); } } header.push(actions.length, ...actions.flat()); }
    return table(words(...header), links);
}
export function reverse(from: readonly number[], to: readonly number[], back: readonly (readonly number[])[], ahead: readonly (readonly number[])[]): Uint8Array {
    const header = [1, 0], links: Link[] = [{ at: 1, bytes: coverage(from) }];
    for (const sequence of [back, ahead]) { header.push(sequence.length); for (const set of sequence) { links.push({ at: header.length, bytes: coverage(set) }); header.push(0); } } header.push(to.length, ...to); return table(words(...header), links);
}
export const extension = (type: number, bytes: Uint8Array) => table(words(1, type, 0, 0), [{ at: 2, bytes, wide: true }]);
export const lookup = (type: number, subtables: readonly Uint8Array[], flags = 0, markSet = 0) => table(words(type, flags, subtables.length, ...subtables.map(() => 0), ...flags & 0x10 ? [markSet] : []), subtables.map((bytes, i) => ({ at: 3 + i, bytes })));
const tagged = (records: readonly Readonly<{ tag: string; bytes: Uint8Array }>[]) => {
    const b = new FontBytes(2 + records.length * 6).u16(0, records.length); records.forEach((r, i) => b.tag(2 + i * 6, r.tag)); return table(b.data, records.map((r, i) => ({ at: 3 + i * 3, bytes: r.bytes })));
};
export const language = (features: readonly number[], required = 0xffff) => words(0, required, features.length, ...features);
export const script = (defaultLanguage: Uint8Array | null, languages: readonly Readonly<{ tag: string; bytes: Uint8Array }>[] = []) => {
    const b = new FontBytes(4 + languages.length * 6).u16(2, languages.length); languages.forEach((r, i) => b.tag(4 + i * 6, r.tag));
    return table(b.data, [...defaultLanguage ? [{ at: 0, bytes: defaultLanguage }] : [], ...languages.map((r, i) => ({ at: 4 + i * 3, bytes: r.bytes }))]);
};
export function gsub(lookups: readonly Uint8Array[], options: Readonly<{ features?: readonly Readonly<{ tag: string; lookups: readonly number[] }>[]; scripts?: readonly Readonly<{ tag: string; bytes: Uint8Array }>[]; variations?: Uint8Array }> = {}): Uint8Array {
    const features = options.features ?? [{ tag: "test", lookups: lookups.map((_, i) => i) }], featureList = tagged(features.map(f => ({ tag: f.tag, bytes: words(0, f.lookups.length, ...f.lookups) }))), scripts = options.scripts ?? [{ tag: "DFLT", bytes: script(language(features.map((_, i) => i))) }];
    return table(words(1, options.variations ? 1 : 0, 0, 0, 0, ...options.variations ? [0, 0] : []), [{ at: 2, bytes: tagged(scripts) }, { at: 3, bytes: featureList },
        { at: 4, bytes: table(words(lookups.length, ...lookups.map(() => 0)), lookups.map((bytes, i) => ({ at: 1 + i, bytes }))) }, ...options.variations ? [{ at: 5, bytes: options.variations, wide: true }] : []]);
}
export function gdef(glyphClasses: Uint8Array | null, attachmentClasses: Uint8Array | null = null, sets: readonly (readonly number[])[] = []): Uint8Array {
    const links: Link[] = []; if (glyphClasses) links.push({ at: 2, bytes: glyphClasses }); if (attachmentClasses) links.push({ at: 5, bytes: attachmentClasses });
    if (sets.length) links.push({ at: 6, bytes: table(words(1, sets.length, ...sets.flatMap(() => [0, 0])), sets.map((set, i) => ({ at: 2 + i * 2, bytes: coverage(set), wide: true }))) }); return table(words(1, 2, 0, 0, 0, 0, 0), links);
}
export function variations(records: readonly Readonly<{ conditions: readonly (readonly [number, number, number])[] | null; replacements: readonly Readonly<{ feature: number; lookups: readonly number[] }>[] | null }>[]): Uint8Array {
    const links: Link[] = [];
    records.forEach((record, i) => {
        if (record.conditions) links.push({ at: 4 + i * 4, wide: true, bytes: table(words(record.conditions.length, ...record.conditions.flatMap(() => [0, 0])), record.conditions.map(([axis, low, high], j) => ({ at: 1 + j * 2, wide: true, bytes: words(1, axis, low * 16384, high * 16384) }))) });
        if (record.replacements) links.push({ at: 6 + i * 4, wide: true, bytes: table(words(1, 0, record.replacements.length, ...record.replacements.flatMap(r => [r.feature, 0, 0])), record.replacements.map((r, j) => ({ at: 4 + j * 3, wide: true, bytes: words(0, r.lookups.length, ...r.lookups) }))) });
    }); return table(words(1, 0, 0, records.length, ...records.flatMap(() => [0, 0, 0, 0])), links);
}
export function fontWithSubstitution(substitution: Uint8Array, definition?: Uint8Array, fvar?: Uint8Array): Uint8Array {
    const tables = fontTables(fontFixture()); tables.set("GSUB", substitution); if (definition) tables.set("GDEF", definition); if (fvar) tables.set("fvar", fvar); return assembleFont(tables);
}

export function nativeSubstitutionCases() {
    const result: { name: string; text: string; feature: string; value: number; bytes: Uint8Array; expectedGlyphs: readonly number[]; nativeWidths: Readonly<Record<string, number>> }[] = [];
    const add = (name: string, text: string, entries: readonly Uint8Array[], expectedGlyphs: readonly number[], options: Readonly<{ definition?: Uint8Array; value?: number; feature?: string; nativeWidths?: Readonly<Record<string, number>> }> = {}) => {
        const feature = options.feature ?? "liga"; result.push({ name, text, feature, value: options.value ?? 1, expectedGlyphs, nativeWidths: options.nativeWidths ?? {}, bytes: fontWithSubstitution(gsub(entries, { features: [{ tag: feature, lookups: [0] }] }), options.definition) });
    };
    add("single-delta", "A", [lookup(1, [single([2], 1)])], [3], { nativeWidths: { webkit: 60 } });
    add("single-indexed", "A", [lookup(1, [single([2], [6])])], [6], { nativeWidths: { webkit: 60 } });
    add("multiple", "B", [lookup(2, [multiple([3], [[4, 5]])])], [4, 5], { nativeWidths: { webkit: 70 } });
    add("alternate", "A", [lookup(3, [multiple([2], [[3, 6]])])], [6], { value: 2, nativeWidths: { webkit: 60 } });
    add("ligature", "fi", [lookup(4, [ligatures([4], [[{ to: 6, rest: [5] }]])])], [6]);
    const rule = { rest: [3, 4], actions: [[1, 1]] as const };
    [contexts([2], [[rule]]), contexts([2], [null, [{ ...rule, rest: [2, 3] }]], { inputClass: classes(2, [1, 2, 3]) }), coverageContext([[2], [3], [4]], [[1, 1]])].forEach((bytes, i) => add(`context-${i + 1}`, "ABf", [lookup(5, [bytes]), lookup(1, [single([3], [5])])], [2, 5, 4]));
    for (const mixed of [false, true]) {
        const end = mixed ? 7 : 2, rule = { rest: [3], back: [5, 4], ahead: [end], actions: [[1, 1]] as const };
        [contexts([2], [[rule]], { chain: true }), contexts([2], [null, [{ rest: [2], back: [2, 1], ahead: [1], actions: [[1, 1]] }]], { chain: true, backClass: classes(4, [1, 2]), inputClass: classes(2, [1, 2]), aheadClass: classes(end, [1]) }), coverageContext([[2], [3]], [[1, 1]], [[5], [4]], [[end]])].forEach((bytes, i) =>
            add(`${mixed ? "mixed" : "latin"}-chain-${i + 1}`, mixed ? "fiAB😀" : "fiABA", [lookup(6, [bytes]), lookup(1, [single([3], [5])])], [4, 5, 2, 5, end], mixed ? { nativeWidths: { chromium: 290, webkit: 290 } } : {}));
    }
    add("reverse", "AAAB", [lookup(8, [reverse([2], [3], [], [[3]])])], [3, 3, 3, 3]);
    add("extension", "fi", [lookup(7, [extension(4, ligatures([4], [[{ to: 6, rest: [5] }]]))])], [6]);
    add("context-contraction", "ABfi", [lookup(5, [contexts([2], [[{ rest: [3, 4, 5], actions: [[1, 1], [2, 2]] }]])]), lookup(4, [ligatures([3], [[{ to: 6, rest: [4] }]])]), lookup(1, [single([5], [8])])], [2, 6, 8]);
    add("context-expansion", "ABfi", [lookup(5, [contexts([2], [[{ rest: [3, 4, 5], actions: [[0, 1], [2, 2]] }]])]), lookup(2, [multiple([2], [[4, 5]])]), lookup(1, [single([3], [8])])], [4, 5, 8, 4, 5]);
    add("nested-beyond-input", "AB", [lookup(5, [contexts([2], [[{ rest: [], actions: [[0, 1]] }]])]), lookup(4, [ligatures([2], [[{ to: 6, rest: [3] }]])])], [6]);
    add("ignored-mark", "A\u0301B", [lookup(4, [ligatures([2], [[{ to: 6, rest: [3] }]])], 8)], [6, 9], { definition: gdef(classes(0, [0, 1, 1, 1, 1, 1, 2, 1, 2, 3])) });
    for (const feature of ["liga", "test"]) {
        if (feature === "test") {
            add("custom-single", "A", [lookup(1, [single([2], [6])])], [6], { feature, nativeWidths: { webkit: 60 } });
            add("custom-multiple", "B", [lookup(2, [multiple([3], [[4, 5]])])], [4, 5], { feature, nativeWidths: { webkit: 70 } });
            add("custom-alternate", "A", [lookup(3, [multiple([2], [[3, 6]])])], [6], { feature, value: 2, nativeWidths: { webkit: 60 } });
        }
    }
    add("multi-character-single", "AA", [lookup(1, [single([2], [6])])], [6, 6]);
    add("multi-character-multiple", "BB", [lookup(2, [multiple([3], [[4, 5]])])], [4, 5, 4, 5]);
    add("multi-character-alternate", "AA", [lookup(3, [multiple([2], [[3, 6]])])], [6, 6], { value: 2 });
    add("marked-single", "A\u0301", [lookup(1, [single([2], [6])])], [6, 9]); return result;
}
