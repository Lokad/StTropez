import type { SfntFont } from "./font-data.ts";
import { createAdvanceBuilder } from "./advances.ts";
import { AdvanceIndex } from "./advances.ts";
import { positioningCursor } from "./font-position-cursor.ts";
import type { PositioningCounters, PositioningCursor } from "./font-position-cursor.ts";
import { ownedSubstitutionResult } from "./font-substitution.ts";
import { FontReader, fontSearch, invalidFont as invalid } from "./font-reader.ts";
import { glyphDefinitions, layoutLookupProperties, layoutReaders, layoutSelection, readLayoutContext, requiredOffset } from "./font-layout.ts";
import type { Coverage, LayoutContext, LayoutMatcher, LayoutSelection, LayoutSelectionOptions } from "./font-layout.ts";
import { positionValues, positionValueSize } from "./font-position-values.ts";
import type { ContourAnchorPoint, PositionAnchor, PositionValue } from "./font-position-values.ts";
import { readKern } from "./font-kern.ts";
import type { SubstitutionGlyph, SubstitutionResult } from "./font-substitution.ts";
import { copyGlyphProperties, hiddenGlyph } from "./glyph-properties.ts";

export type PositioningOptions = LayoutSelectionOptions & Readonly<{ direction?: "ltr" | "rtl"; legacyKerning?: boolean;
    defaultIgnorables?: "hide" | "preserve"; ppem?: Readonly<{ x: number; y: number }>; contourPoints?: readonly ContourAnchorPoint[] }>;
export type PositioningLimits = Readonly<{ maxOperations?: number; maxDepth?: number; advanceWidths?: readonly number[] }>;
export type PositioningCursorOptions = Readonly<{ maxOperations?: number; maxDepth?: number; advanceWidths?: AdvanceIndex }>;
export type PositionedGlyph = Readonly<{ source: SubstitutionGlyph; hidden: boolean; xAdvance: number; xOffset: number; yOffset: number;
    penX: number; x: number; y: number; attachment: Readonly<{ kind: "mark" | "cursive"; glyphIndex: number }> | null }>;
export type PositioningResult = Readonly<{ font: SfntFont; selection: LayoutSelection; direction: "ltr" | "rtl"; glyphs: readonly PositionedGlyph[];
    advances: AdvanceIndex; hiddenGlyphs: number; operations: number; adjustments: number; legacyKerning: boolean; contourFallbacks: number }>;
export type PositioningPlan = Readonly<{ font: SfntFont; selection: LayoutSelection; direction: "ltr" | "rtl";
    defaultIgnorables: "hide" | "preserve";
    apply: (input: SubstitutionResult, limits?: PositioningLimits) => PositioningResult;
    createCursor: (input: SubstitutionResult, options?: PositioningCursorOptions) => PositioningCursor }>;
export class PositioningLimitError extends Error {
    readonly limit: "operations" | "depth" | "attachment cycle";
    constructor(limit: "operations" | "depth" | "attachment cycle") { super(`Glyph positioning exceeded its ${limit} limit.`); this.name = "PositioningLimitError"; this.limit = limit; }
}
type Mark = Readonly<{ markClass: number; anchor: PositionAnchor | null }>;
type Pair = readonly [PositionValue, PositionValue];
type Subtable = { type: 1; coverage: Coverage; value: (covered: number) => PositionValue }
    | { type: 2; coverage: Coverage; pair: (covered: number, first: number, second: number) => Pair | null; consumeSecond: boolean }
    | { type: 3; coverage: Coverage; entries: readonly Readonly<{ entry: PositionAnchor | null; exit: PositionAnchor | null }>[] }
    | { type: 4 | 5 | 6; coverage: Coverage; targets: Coverage; marks: readonly Mark[];
        anchor: (covered: number, component: number, markClass: number) => PositionAnchor | null; components: (covered: number) => number }
    | ({ type: 7 | 8 } & LayoutContext);
type Lookup = Readonly<{ flags: number; markSet: number; subtables: readonly Subtable[] }>;

function readPositioning(tables: readonly FontReader[], readers: ReturnType<typeof layoutReaders>, definitions: ReturnType<typeof glyphDefinitions>, values: ReturnType<typeof positionValues>): readonly Lookup[] {
    const coverageAt = (b: FontReader, at: number) => readers.coverage(requiredOffset(b, b.u16(at)));
    const subtable = (b: FontReader, type: number): Subtable => {
        const format = b.u16(0); if (type === 7 || type === 8) return { type, ...readLayoutContext(b, type === 8, readers, tables.length) };
        const coverage = coverageAt(b, 2);
        if (type === 1) { const flags = b.u16(4), size = positionValueSize(flags); if (format === 1) { b.span(6, size); const value = values.value(b, 6, flags); return { type, coverage, value: () => value }; }
            if (format !== 2 || b.u16(6) !== coverage.count) invalid("single positioning format/count"); b.span(8, size * coverage.count);
            if (flags) for (let i = 0; i < coverage.count; i++) values.value(b, 8 + i * size, flags);
            return { type, coverage, value: i => values.value(b, 8 + i * size, flags) }; }
        if (type === 2) {
            const first = b.u16(4), second = b.u16(6), firstSize = positionValueSize(first), secondSize = positionValueSize(second), size = firstSize + secondSize;
            if (format === 1) {
                const count = b.u16(8); if (count !== coverage.count) invalid("pair coverage count"); b.span(10, count * 2); const sets: Readonly<{ reader: FontReader; count: number }>[] = [];
                for (let i = 0; i < count; i++) { const set = requiredOffset(b, b.u16(10 + i * 2)), n = set.u16(0); set.span(2, n * (2 + size));
                    for (let j = 0, previous = -1; j < n; j++) { const at = 2 + j * (2 + size), glyph = readers.glyph(set.u16(at)); if (glyph <= previous) invalid("pair glyph order"); previous = glyph;
                        if (first) values.value(set, at + 2, first); if (second) values.value(set, at + 2 + firstSize, second); } sets.push({ reader: set, count: n }); }
                return { type, coverage, consumeSecond: second !== 0, pair: (covered, _first, glyph) => {
                    const set = sets[covered]!, i = fontSearch(set.count, at => set.reader.u16(2 + at * (2 + size)), glyph), at = 2 + i * (2 + size);
                    return i < set.count && set.reader.u16(at) === glyph ? [values.value(set.reader, at + 2, first), values.value(set.reader, at + 2 + firstSize, second)] : null; } };
            }
            if (format !== 2) return invalid("pair positioning format"); const class1 = readers.classes(requiredOffset(b, b.u16(8))), class2 = readers.classes(requiredOffset(b, b.u16(10))), rows = b.u16(12), columns = b.u16(14);
            if (!rows || !columns || class1.maximum >= rows || class2.maximum >= columns) invalid("pair class counts"); b.span(16, rows * columns * size);
            if (size) for (let i = 0; i < rows * columns; i++) { const at = 16 + i * size; if (first) values.value(b, at, first); if (second) values.value(b, at + firstSize, second); }
            return { type, coverage, consumeSecond: second !== 0, pair: (_covered, a, c) => { const at = 16 + (class1.get(a) * columns + class2.get(c)) * size; return [values.value(b, at, first), values.value(b, at + firstSize, second)]; } };
        }
        if (type === 3) {
            const count = b.u16(4); if (format !== 1 || count !== coverage.count) invalid("cursive format/count"); b.span(6, count * 4);
            return { type, coverage, entries: Array.from({ length: count }, (_, i) => ({ entry: values.anchor(b, b.u16(6 + i * 4), coverage.glyph(i)), exit: values.anchor(b, b.u16(8 + i * 4), coverage.glyph(i)) })) };
        }
        if (type === 4 || type === 5 || type === 6) {
            if (format !== 1) invalid("mark positioning format"); const targets = coverageAt(b, 4), classCount = b.u16(6), array = requiredOffset(b, b.u16(8)), targetArray = requiredOffset(b, b.u16(10)), count = array.u16(0);
            if (!classCount || count !== coverage.count) invalid("mark class/count"); array.span(2, count * 4);
            const marks: Mark[] = Array.from({ length: count }, (_, i) => { const markClass = array.u16(2 + i * 4); if (markClass >= classCount) invalid("mark class index"); return { markClass, anchor: values.anchor(array, array.u16(4 + i * 4), coverage.glyph(i)) }; });
            if (targetArray.u16(0) !== targets.count) invalid("mark target count");
            if (type === 5) {
                targetArray.span(2, targets.count * 2); const ligatures: { count: number; anchors: readonly (readonly (PositionAnchor | null)[])[] }[] = [];
                for (let i = 0; i < targets.count; i++) { const lig = requiredOffset(targetArray, targetArray.u16(2 + i * 2)), components = lig.u16(0); if (!components) invalid("empty ligature anchors"); lig.span(2, components * classCount * 2);
                    const anchors = Array.from({ length: components }, (_, component) => Array.from({ length: classCount }, (_, cls) => values.anchor(lig, lig.u16(2 + (component * classCount + cls) * 2), targets.glyph(i)))); ligatures.push({ count: components, anchors }); }
                return { type, coverage, targets, marks, components: i => ligatures[i]!.count, anchor: (i, component, cls) => ligatures[i]!.anchors[Math.min(component, ligatures[i]!.count - 1)]![cls]! };
            }
            targetArray.span(2, targets.count * classCount * 2); const anchors = Array.from({ length: targets.count }, (_, i) => Array.from({ length: classCount }, (_, cls) => values.anchor(targetArray, targetArray.u16(2 + (i * classCount + cls) * 2), targets.glyph(i))));
            return { type, coverage, targets, marks, components: () => 1, anchor: (i, _component, cls) => anchors[i]![cls]! };
        }
        return invalid("positioning lookup type");
    };
    return tables.map(b => {
        const declared = b.u16(0), { flags, markSet, count } = layoutLookupProperties(b, definitions); if (declared < 1 || declared > 9) invalid("positioning lookup type"); let effective = declared; const subtables: Subtable[] = [];
        for (let i = 0; i < count; i++) { let table = requiredOffset(b, b.u16(6 + i * 2)), type = declared;
            if (declared === 9) { if (table.u16(0) !== 1) invalid("position extension format"); type = table.u16(2); if (type < 1 || type >= 9 || i && effective !== type) invalid("position extension type"); effective = type; table = requiredOffset(table, table.u32(4)); } subtables.push(subtable(table, type)); }
        return { flags, markSet, subtables };
    });
}

type Attachment = { kind: "mark" | "cursive"; target: number; dx: number; dy: number };
const finite = (value: number): number => { if (!Number.isFinite(value)) throw new RangeError("Non-finite glyph position."); return value; };
const positive = (value: number): number => { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("Invalid positioning work limit."); return value; };
export function createPositioningPlan(font: SfntFont, tables: ReadonlyMap<string, FontReader>, options: PositioningOptions): PositioningPlan {
    const direction = options.direction ?? "ltr"; if (direction !== "ltr" && direction !== "rtl") throw new RangeError("Expected a horizontal positioning direction.");
    const defaultIgnorables = options.defaultIgnorables ?? "hide";
    if (defaultIgnorables !== "hide" && defaultIgnorables !== "preserve") throw new RangeError("Invalid default-ignorable visibility policy.");
    const sign = direction === "ltr" ? 1 : -1, selection = layoutSelection(tables.get("GPOS"), tables.get("fvar"), options, "GPOS"), readers = layoutReaders(font.metadata.glyphCount), definitions = glyphDefinitions(tables.get("GDEF"), readers);
    const values = positionValues(font.metadata.unitsPerEm, selection.coordinates, definitions.variations, options.ppem, options.contourPoints, font.metadata.glyphCount), lookups = readPositioning(selection.lookups, readers, definitions, values);
    const legacy = options.legacyKerning ? readKern(tables.get("kern"), font.metadata.glyphCount) : [];
    function* execute(input: SubstitutionResult, limits: PositioningLimits, counters: PositioningCounters, metric: ((i: number) => number) | undefined): Generator<void, PositioningResult | null> {
        if (input.font !== font) throw new RangeError("Positioning requires the captured substitution font."); const n = input.glyphs.length, maxOperations = positive(limits.maxOperations ?? Math.max(1_000_000, n * 256)), maxDepth = positive(limits.maxDepth ?? 64);
        if (maxDepth > 256) throw new RangeError("Invalid positioning depth.");
        let adjustments = 0, hiddenGlyphs = 0; const tick = (count = 1) => { counters.operations += count; if (counters.operations > maxOperations) throw new PositioningLimitError("operations"); };
        const pause = () => { if (counters.operations - counters.yielded < 256) return false; counters.yielded = counters.operations; return true; };
        const copy: SubstitutionGlyph[] = [], source: readonly SubstitutionGlyph[] = ownedSubstitutionResult(input) ? input.glyphs : copy;
        if (source === copy) {
        for (const glyph of input.glyphs) { tick(); if (!Number.isSafeInteger(glyph.glyphId) || glyph.glyphId < 0 || glyph.glyphId >= font.metadata.glyphCount || !Number.isInteger(glyph.glyphClass) || glyph.glyphClass < 0 || glyph.glyphClass > 4 || !glyph.components.length) throw new RangeError("Invalid positioning source glyph.");
            const components = glyph.components.map(component => { tick(); if (!component.length) throw new RangeError("Empty positioning source component."); return Object.freeze(component.map(span => { tick(); if (!Number.isSafeInteger(span.from) || !Number.isSafeInteger(span.to) || span.from < 0 || span.to < span.from) throw new RangeError("Invalid positioning source span."); return Object.freeze({ from: span.from, to: span.to }); })); });
            const properties = copyGlyphProperties(glyph.properties);
            copy.push(Object.freeze({ glyphId: glyph.glyphId, glyphClass: glyph.glyphClass, ...(properties ? { properties } : {}), components: Object.freeze(components), sources: Object.freeze(components.flat()), attachment: glyph.attachment ? Object.freeze({ ...glyph.attachment }) : null })); }
        for (let i = 0; i < source.length; i++) if (source[i]!.attachment) { const a = source[i]!.attachment!; if (!Number.isSafeInteger(a.glyphIndex) || a.glyphIndex < 0 || a.glyphIndex >= n || a.glyphIndex === i || !Number.isSafeInteger(a.component) || a.component < 0 || a.component >= source[a.glyphIndex]!.components.length) throw new RangeError("Invalid positioning ligature component."); }
        }
        counters.phase = "metrics";
        const advances = new Float64Array(n), offsetX = new Float64Array(n), offsetY = new Float64Array(n), hidden = new Uint8Array(n), attachments: (Attachment | null)[] = new Array<Attachment | null>(n).fill(null);
        for (let i = 0; i < n; i++) { tick(); if (pause()) yield; counters.prepared = i + 1; hidden[i] = +(defaultIgnorables === "hide" && hiddenGlyph(source[i]!.properties));
            hiddenGlyphs += hidden[i]!;
            const width = finite(metric ? metric(i) : font.nominalGlyphMetrics(source[i]!.glyphId).advanceWidth); advances[i] = hidden[i] ? 0 : width; }
        const kind = (i: number) => definitions.glyphs?.get(source[i]!.glyphId) || source[i]!.glyphClass;
        const eligible = (i: number, lookup: Lookup): boolean => { tick(); const cls = kind(i), flags = lookup.flags; if (cls === 1 && flags & 2 || cls === 2 && flags & 4 || cls === 3 && flags & 8) return false;
            if (cls !== 3) return true; if (flags & 0x10) return definitions.sets[lookup.markSet]!.index(source[i]!.glyphId) >= 0; return !(flags & 0xff00) || definitions.attachments!.get(source[i]!.glyphId) === flags >>> 8; };
        function* next(i: number, step: 1 | -1, lookup: Lookup): Generator<void, number> { for (let j = i + step; j >= 0 && j < n; j += step) { const accepted = eligible(j, lookup); if (pause()) yield; if (accepted) return j; } return -1; }
        function* surrounding(i: number, matchers: readonly LayoutMatcher[], step: 1 | -1, lookup: Lookup): Generator<void, boolean> { let at = i; for (const matcher of matchers) { tick(); if (pause()) yield; at = yield* next(at, step, lookup); if (at < 0 || !matcher(source[at]!.glyphId)) return false; } return true; };
        const position = (i: number, value: PositionValue) => { tick(); offsetX[i] = finite(offsetX[i]! + value[0]); offsetY[i] = finite(offsetY[i]! + value[1]); advances[i] = finite(advances[i]! + value[2]); };
        const dependents = new Uint32Array(n);
        const setEdge = (child: number, edge: Attachment | null) => { tick(); const old = attachments[child]; if (old) dependents[old.target]!--; attachments[child] = edge; if (edge) dependents[edge.target]!++; };
        function* currentY(node: number): Generator<void, number> { let y = 0, steps = 0; while (true) { tick(); if (pause()) yield; if (steps++ > n) throw new PositioningLimitError("attachment cycle"); y += offsetY[node]!; const edge = attachments[node]; if (!edge) return finite(y); y += edge.dy; node = edge.target; } };
        function* attach(child: number, attachment: Attachment): Generator<void, void> {
            const path: number[] = [], edges: Attachment[] = []; let at = attachment.target; const sameParent = attachments[child]?.target === attachment.target;
            while (!sameParent && dependents[child] && attachments[at] && at !== child) { tick(); if (pause()) yield; if (path.length > n) throw new PositioningLimitError("attachment cycle"); path.push(at); edges.push(attachments[at]!); at = attachments[at]!.target; }
            if (at === child) {
                if (attachment.kind !== "cursive") throw new PositioningLimitError("attachment cycle");
                for (const edge of edges) { tick(); if (pause()) yield; if (edge.kind !== "cursive") throw new PositioningLimitError("attachment cycle"); }
                const y = new Map<number, number>([[child, yield* currentY(child)]]);
                for (let i = path.length - 1; i >= 0; i--) { tick(); if (pause()) yield; y.set(path[i]!, y.get(edges[i]!.target)! + edges[i]!.dy + offsetY[path[i]!]!); }
                for (let i = 0; i < path.length; i++) { tick(); if (pause()) yield; const target = edges[i]!.target; setEdge(target, { kind: "cursive", target: path[i]!, dx: 0, dy: y.get(target)! - y.get(path[i]!)! - offsetY[target]! }); }
                setEdge(attachment.target, null); offsetY[attachment.target] = y.get(attachment.target)!;
            }
            offsetY[child] = 0; if (attachment.kind === "mark") offsetX[child] = 0; setEdge(child, attachment);
        };
        function* lookupAt(i: number, index: number, depth: number): Generator<void, { matched: boolean; next: number }> {
            tick(); if (pause()) yield; if (depth > maxDepth) throw new PositioningLimitError("depth"); const lookup = lookups[index]!; if (!eligible(i, lookup)) return { matched: false, next: i + 1 };
            for (const table of lookup.subtables) {
                tick(); if (pause()) yield; if ("rules" in table) {
                    for (const rule of table.rules(source[i]!.glyphId)) { tick(); if (pause()) yield; if (!rule.input[0]!(source[i]!.glyphId)) continue; const matched = [i]; let at = i;
                        for (let j = 1; j < rule.input.length; j++) { tick(); if (pause()) yield; at = yield* next(at, 1, lookup); if (at < 0 || !rule.input[j]!(source[at]!.glyphId)) break; matched.push(at); }
                        if (matched.length !== rule.input.length || !(yield* surrounding(i, rule.back, -1, lookup)) || !(yield* surrounding(matched.at(-1)!, rule.ahead, 1, lookup))) continue;
                        for (const action of rule.actions) { tick(); if (pause()) yield; const target = matched[action.sequence]; if (target !== undefined) yield* lookupAt(target, action.lookup, depth + 1); }
                        return { matched: true, next: matched.at(-1)! + 1 }; }
                    continue;
                }
                const covered = table.coverage.index(source[i]!.glyphId); if (covered < 0) continue;
                if (table.type === 1) { position(i, table.value(covered)); adjustments++; return { matched: true, next: i + 1 }; }
                if (table.type === 2) { const second = yield* next(i, 1, lookup); if (second < 0) continue; const pair = table.pair(covered, source[i]!.glyphId, source[second]!.glyphId); if (!pair) continue;
                    position(i, pair[0]); position(second, pair[1]); adjustments++; return { matched: true, next: second + (table.consumeSecond ? 1 : 0) }; }
                if (table.type === 3) { const second = yield* next(i, 1, lookup), exit = table.entries[covered]!.exit; if (second < 0 || !exit) continue; const target = table.coverage.index(source[second]!.glyphId), entry = target >= 0 ? table.entries[target]!.entry : null; if (!entry) continue;
                    let distance = 0; for (let j = i; j < second; j++) { tick(); if (pause()) yield; distance += advances[j]!; } distance *= sign; if (sign < 0) distance += advances[i]! - advances[second]!;
                    const desired = offsetX[i]! + exit.x - offsetX[second]! - entry.x, delta = (desired - distance) * sign; advances[i] = finite(advances[i]! + delta); if (sign < 0) offsetX[i] = finite(offsetX[i]! + delta);
                    if (lookup.flags & 1) yield* attach(i, { kind: "cursive", target: second, dx: 0, dy: entry.y - exit.y });
                    else yield* attach(second, { kind: "cursive", target: i, dx: 0, dy: exit.y - entry.y });
                    adjustments++; return { matched: true, next: second }; }
                const mark = table.marks[covered]!; if (!mark.anchor) continue; let target = -1;
                for (let j = i - 1; j >= 0; j--) { tick(); if (pause()) yield; if (!eligible(j, lookup)) continue; const isMark = kind(j) === 3 || table.coverage.index(source[j]!.glyphId) >= 0;
                    if (table.type !== 6 && isMark) continue; if (table.type === 6 && !isMark && table.targets.index(source[j]!.glyphId) < 0) break; target = j; break; }
                if (target < 0) continue; const targetCovered = table.targets.index(source[target]!.glyphId); if (targetCovered < 0) continue;
                const prior = source[i]!.attachment, component = table.type === 5 && prior?.glyphIndex === target ? prior.component : table.components(targetCovered) - 1, anchor = table.anchor(targetCovered, component, mark.markClass); if (!anchor) continue;
                yield* attach(i, { kind: "mark", target, dx: anchor.x - mark.anchor.x, dy: anchor.y - mark.anchor.y }); adjustments++; return { matched: true, next: i + 1 };
            }
            return { matched: false, next: i + 1 };
        };
        counters.phase = "lookups";
        for (const pass of selection.selected) { tick(); if (pause()) yield; let i = 0; while (i < n) { tick(); if (pause()) yield; i = (yield* lookupAt(i, pass.index, 1)).next; } }
        counters.phase = "legacy";
        if (legacy.length) {
            const delta = new Float64Array(n), cross = new Float64Array(n);
            for (const table of legacy) { tick(); if (pause()) yield; let crossStream = 0; for (let i = 0; i + 1 < n; i++) { tick(); if (pause()) yield; const value = table.value(source[sign > 0 ? i : i + 1]!.glyphId, source[sign > 0 ? i + 1 : i]!.glyphId);
                    if (table.crossStream) { if (value === -32768) crossStream = 0; else if (value !== null) crossStream = table.override ? value : crossStream + value; cross[i + 1] = finite(cross[i + 1]! + crossStream); }
                    else if (value !== null) delta[i] = finite(table.override ? value : delta[i]! + value); if (value !== null) adjustments++; } }
            for (let i = 0; i < n; i++) { tick(); if (pause()) yield; advances[i] = finite(advances[i]! + delta[i]!); if (sign < 0) offsetX[i] = finite(offsetX[i]! + delta[i]!); offsetY[i] = finite(offsetY[i]! + cross[i]!); }
        }
        counters.phase = "visibility";
        for (let i = 0; i < n; i++) { tick(); if (pause()) yield; if (hidden[i]) { advances[i] = 0; offsetX[i] = 0; offsetY[i] = 0; attachments[i] = null; } }
        counters.phase = "pens";
        const pen = new Float64Array(n), base = new Float64Array(n), finalX = new Float64Array(n), finalY = new Float64Array(n); let x = 0;
        const builder = createAdvanceBuilder(), batch = new Float64Array(256);
        try { for (let from = 0; from < n; from += 256) { const count = Math.min(256, n - from); for (let j = 0; j < count; j++) { tick(); if (pause()) yield; const i = from + j; pen[i] = x; base[i] = x - (sign < 0 ? advances[i]! : 0); batch[j] = advances[i]! * sign; x = finite(x + batch[j]!); } builder.append(batch, 0, count); }
            const index = builder.finish(), state = new Uint8Array(n);
            counters.phase = "attachments";
            for (let i = 0; i < n; i++) { tick(); if (pause()) yield; if (state[i] === 2) continue; const path: number[] = []; let at = i;
                while (state[at] !== 2) { tick(); if (pause()) yield; if (state[at] === 1) throw new PositioningLimitError("attachment cycle"); state[at] = 1; path.push(at); const edge = attachments[at]; if (!edge) break; at = edge.target; }
                for (let j = path.length - 1; j >= 0; j--) { tick(); if (pause()) yield; const node = path[j]!, edge = attachments[node]; finalX[node] = finite((edge?.kind === "mark" ? finalX[edge.target]! + edge.dx : base[node]!) + offsetX[node]!);
                    finalY[node] = finite((edge ? finalY[edge.target]! + edge.dy : 0) + offsetY[node]!); state[node] = 2; }
            }
            counters.phase = "publish"; const glyphs: PositionedGlyph[] = [];
            for (let i = 0; i < n; i++) { tick(); if (pause()) yield; const glyph = source[i]!; glyphs.push(Object.freeze({ source: glyph, hidden: !!hidden[i], xAdvance: advances[i]!, xOffset: finalX[i]! - base[i]!, yOffset: finalY[i]!, penX: pen[i]!, x: finalX[i]!, y: finalY[i]!,
                attachment: attachments[i] ? Object.freeze({ kind: attachments[i]!.kind, glyphIndex: attachments[i]!.target }) : null })); counters.published = i + 1; }
            return Object.freeze({ font, selection: selection.metadata, direction, glyphs: Object.freeze(glyphs), advances: index, hiddenGlyphs, operations: counters.operations, adjustments, legacyKerning: legacy.length > 0, contourFallbacks: values.pointFallbacks() });
        } finally { builder.dispose(); }
    };
    const start = (input: SubstitutionResult, limits: PositioningLimits, metric?: (i: number) => number): PositioningCursor => {
        if (input.font !== font) throw new RangeError("Positioning requires the captured substitution font.");
        const captured = { maxOperations: limits.maxOperations, maxDepth: limits.maxDepth }, counters: PositioningCounters = { phase: "source", prepared: 0, published: 0, operations: 0, yielded: 0 };
        const work: PositioningLimits = {}; if (captured.maxOperations !== undefined) Object.assign(work, { maxOperations: captured.maxOperations }); if (captured.maxDepth !== undefined) Object.assign(work, { maxDepth: captured.maxDepth });
        return positioningCursor(execute(input, work, counters, metric), counters);
    };
    const apply = (input: SubstitutionResult, limits: PositioningLimits = {}): PositioningResult => {
        if (limits.advanceWidths && limits.advanceWidths.length !== input.glyphs.length) throw new RangeError("Invalid positioning metric count.");
        const widths = limits.advanceWidths, cursor = start(input, limits, widths ? i => widths[i]! : undefined);
        try { let step = cursor.next(65536); while (step.status === "running") step = cursor.next(65536); return step.result!; } finally { cursor.dispose(); }
    };
    const createCursor = (input: SubstitutionResult, options: PositioningCursorOptions = {}): PositioningCursor => {
        if (!ownedSubstitutionResult(input)) throw new TypeError("A positioning cursor requires an owned immutable substitution result.");
        const widths = options.advanceWidths, maxOperations = options.maxOperations, maxDepth = options.maxDepth;
        if (widths && (!(widths instanceof AdvanceIndex) || widths.length !== input.glyphs.length)) throw new RangeError("A positioning cursor requires a matching immutable advance index.");
        const limits: PositioningLimits = {}; if (maxOperations !== undefined) Object.assign(limits, { maxOperations }); if (maxDepth !== undefined) Object.assign(limits, { maxDepth });
        return start(input, limits, widths ? i => widths.at(i) : undefined);
    };
    return Object.freeze({ font, selection: selection.metadata, direction, defaultIgnorables, apply, createCursor });
}
