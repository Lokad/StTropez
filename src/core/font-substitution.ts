import type { SfntFont } from "./font-data.ts";
import { ownedGlyphRun } from "./glyph-run.ts";
import type { GlyphRun } from "./glyph-run.ts";
import { substitutionCursor } from "./font-substitution-cursor.ts";
import type { SubstitutionCounters, SubstitutionCursor } from "./font-substitution-cursor.ts";
import { FontReader, invalidFont as invalid } from "./font-reader.ts";
import { glyphDefinitions, layoutLookupProperties, layoutReaders, layoutSelection, readLayoutContext, requiredOffset } from "./font-layout.ts";
import type { Coverage, LayoutContextRule as Rule, LayoutMatcher as Matcher, LayoutSelection, LayoutSelectionOptions } from "./font-layout.ts";
import { copyGlyphProperties, mergeGlyphProperties, substitutedGlyphProperties } from "./glyph-properties.ts";
import type { GlyphProperties } from "./glyph-properties.ts";

export type GlyphSourceSpan = Readonly<{ from: number; to: number }>;
export type SubstitutionGlyph = Readonly<{ glyphId: number; glyphClass: number; properties?: GlyphProperties; sources: readonly GlyphSourceSpan[];
    components: readonly (readonly GlyphSourceSpan[])[]; attachment: Readonly<{ glyphIndex: number; component: number }> | null }>;
export type SubstitutionInputGlyph = Readonly<{ glyphId: number; source: GlyphSourceSpan; glyphClass?: number; properties?: GlyphProperties }> | SubstitutionGlyph;
export type SubstitutionOptions = LayoutSelectionOptions;
export type SubstitutionLimits = Readonly<{ maxOperations?: number; maxGlyphs?: number; maxDepth?: number }>;
export type SubstitutionResult = Readonly<{ font: SfntFont; selection: LayoutSelection; glyphs: readonly SubstitutionGlyph[]; operations: number; substitutions: number }>;
const ownedResults = new WeakSet<SubstitutionResult>();
/** Internal ownership check: cooperative consumers can retain these deeply immutable values. */
export const ownedSubstitutionResult = (result: unknown): result is SubstitutionResult => typeof result === "object" && result !== null && ownedResults.has(result as SubstitutionResult);
export type SubstitutionSource = readonly SubstitutionInputGlyph[] | GlyphRun<SubstitutionInputGlyph> | SubstitutionResult;
export type SubstitutionPlan = Readonly<{ font: SfntFont; selection: LayoutSelection;
    apply: (input: SubstitutionSource, limits?: SubstitutionLimits) => SubstitutionResult;
    createCursor: (input: GlyphRun<SubstitutionInputGlyph> | SubstitutionResult, limits?: SubstitutionLimits) => SubstitutionCursor }>;
type Input = Readonly<{ length: number; owned: boolean; at: (index: number) => SubstitutionInputGlyph }>;
export class SubstitutionLimitError extends Error {
    readonly limit: "operations" | "glyphs" | "depth";
    constructor(limit: "operations" | "glyphs" | "depth") { super(`Glyph substitution exceeded its ${limit} limit.`); this.name = "SubstitutionLimitError"; this.limit = limit; }
}

type Subtable = { type: 1; coverage: Coverage; outputs: readonly number[] } | { type: 2 | 3; coverage: Coverage; outputs: readonly (readonly number[])[] }
    | { type: 4; coverage: Coverage; ligatures: readonly (readonly Readonly<{ output: number; components: readonly number[] }>[])[] }
    | { type: 5 | 6; rules: (glyph: number) => readonly Rule[] }
    | { type: 8; coverage: Coverage; outputs: readonly number[]; back: readonly Matcher[]; ahead: readonly Matcher[] };
type Lookup = Readonly<{ type: number; flags: number; markSet: number; subtables: readonly Subtable[] }>;

function readLookups(tables: readonly FontReader[], readers: ReturnType<typeof layoutReaders>, definitions: ReturnType<typeof glyphDefinitions>): readonly Lookup[] {
    const member = (coverage: Coverage): Matcher => glyph => coverage.index(glyph) >= 0;
    const coverageAt = (b: FontReader, at: number) => readers.coverage(requiredOffset(b, b.u16(at)));
    function subtable(b: FontReader, type: number): Subtable {
        const format = b.u16(0);
        if (type === 5 || type === 6) return { type, ...readLayoutContext(b, type === 6, readers, tables.length) };
        const coverage = coverageAt(b, 2);
        if (type === 1) {
            const outputs: number[] = []; if (format !== 1 && format !== 2) invalid("single substitution format");
            if (format === 2) { const count = b.u16(4); if (count !== coverage.count) invalid("single coverage count"); b.span(6, count * 2); }
            for (let i = 0; i < coverage.count; i++) outputs.push(readers.glyph(format === 1 ? (coverage.glyph(i) + b.i16(4)) & 0xffff : b.u16(6 + i * 2)));
            return { type, coverage, outputs };
        }
        if (type === 2 || type === 3) {
            if (format !== 1) invalid("sequence substitution format"); const count = b.u16(4); if (count !== coverage.count) invalid("sequence coverage count"); b.span(6, count * 2);
            const outputs: number[][] = [];
            for (let i = 0; i < count; i++) { const sequence = requiredOffset(b, b.u16(6 + i * 2)), length = sequence.u16(0); if (!length) invalid("empty substitution sequence"); sequence.span(2, length * 2);
                outputs.push(Array.from({ length }, (_, j) => readers.glyph(sequence.u16(2 + j * 2)))); }
            return { type, coverage, outputs };
        }
        if (type === 4) {
            if (format !== 1) invalid("ligature format"); const count = b.u16(4); if (count !== coverage.count) invalid("ligature coverage count"); b.span(6, count * 2);
            const ligatures: { output: number; components: number[] }[][] = [];
            for (let i = 0; i < count; i++) { const set = requiredOffset(b, b.u16(6 + i * 2)), length = set.u16(0); set.span(2, length * 2); const entries: { output: number; components: number[] }[] = []; ligatures.push(entries);
                for (let j = 0; j < length; j++) { const ligature = requiredOffset(set, set.u16(2 + j * 2)), n = ligature.u16(2); if (!n) invalid("empty ligature"); ligature.span(4, (n - 1) * 2);
                    entries.push({ output: readers.glyph(ligature.u16(0)), components: Array.from({ length: n - 1 }, (_, k) => readers.glyph(ligature.u16(4 + k * 2))) }); }
            }
            return { type, coverage, ligatures };
        }
        if (type === 8) {
            if (format !== 1) invalid("reverse substitution format"); let at = 4;
            const coverages = () => { const count = b.u16(at); at += 2; b.span(at, count * 2); const result: Matcher[] = [];
                for (let i = 0; i < count; i++, at += 2) result.push(member(coverageAt(b, at))); return result; };
            const back = coverages(), ahead = coverages(), count = b.u16(at); at += 2; if (count !== coverage.count) invalid("reverse coverage count"); b.span(at, count * 2);
            return { type, coverage, back, ahead, outputs: Array.from({ length: count }, (_, i) => readers.glyph(b.u16(at + i * 2))) };
        }
        return invalid("substitution lookup type");
    }
    return tables.map(b => {
        const declared = b.u16(0), { flags, markSet, count } = layoutLookupProperties(b, definitions); if (declared < 1 || declared > 8) invalid("substitution lookup header");
        let type = declared; const subtables: Subtable[] = [];
        for (let i = 0; i < count; i++) {
            let table = requiredOffset(b, b.u16(6 + i * 2)), effective = declared;
            if (declared === 7) { if (table.u16(0) !== 1) invalid("extension format"); effective = table.u16(2); if (effective < 1 || effective > 8 || effective === 7) invalid("extension lookup type");
                table = requiredOffset(table, table.u32(4)); if (i && effective !== type) invalid("mixed extension types"); type = effective; }
            subtables.push(subtable(table, effective));
        }
        return { type, flags, markSet, subtables };
    });
}

type Node = { glyph: number; inferred: number; properties: GlyphProperties | undefined; components: readonly (readonly GlyphSourceSpan[])[]; prev: Node | null; next: Node | null;
    attachment: { target: Node; component: number } | null; marks: Set<Node> };
type Frame = { slots: Node[]; after: Node | null };
const positive = (value: number, label: string) => { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`Invalid substitution ${label}.`); return value; };

/** A complete glyph-sequence GSUB stage. Script analysis, positioning and geometry are separate. */
export function createSubstitutionPlan(font: SfntFont, tables: ReadonlyMap<string, FontReader>, options: SubstitutionOptions): SubstitutionPlan {
    const selection = layoutSelection(tables.get("GSUB"), tables.get("fvar"), options), readers = layoutReaders(font.metadata.glyphCount), definitions = glyphDefinitions(tables.get("GDEF"), readers), lookups = readLookups(selection.lookups, readers, definitions);
    function* execute(input: Input, limits: SubstitutionLimits, counters: SubstitutionCounters): Generator<void, SubstitutionResult | null> {
        const maxOperations = positive(limits.maxOperations ?? Math.max(1_000_000, input.length * 256), "operation limit"), maxGlyphs = positive(limits.maxGlyphs ?? Math.max(1_000_000, input.length * 16), "glyph limit"), maxDepth = positive(limits.maxDepth ?? 64, "depth limit");
        if (maxDepth > 256) throw new RangeError("Substitution depth limit exceeds 256."); if (input.length > maxGlyphs) throw new SubstitutionLimitError("glyphs");
        let length = input.length;
        const tick = () => { counters.operations++; if (counters.operations > maxOperations) throw new SubstitutionLimitError("operations"); };
        const pause = () => { if (counters.operations - counters.yielded < 256) return false; counters.yielded = counters.operations; return true; };
        const span = (value: GlyphSourceSpan): GlyphSourceSpan => { tick(); const { from, to } = value; if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new RangeError("Invalid glyph source span."); return Object.freeze({ from, to }); };
        const nodes: Node[] = [];
        for (let i = 0; i < input.length; i++) {
            tick(); if (pause()) yield; const entry = input.at(i);
            const glyphId = entry.glyphId; if (!Number.isSafeInteger(glyphId) || glyphId < 0 || glyphId >= font.metadata.glyphCount) throw new RangeError("Invalid substitution glyph.");
            const inferred = entry.glyphClass ?? 0; if (!Number.isInteger(inferred) || inferred < 0 || inferred > 4) throw new RangeError("Invalid input glyph class.");
            let components: readonly (readonly GlyphSourceSpan[])[];
            if (input.owned && "components" in entry) components = entry.components;
            else if ("components" in entry) {
                const copied: (readonly GlyphSourceSpan[])[] = [];
                for (const component of entry.components) { tick(); if (pause()) yield; if (!component.length) throw new RangeError("Empty glyph source component.");
                    const spans: GlyphSourceSpan[] = []; for (const value of component) { spans.push(span(value)); if (pause()) yield; } copied.push(Object.freeze(spans)); }
                components = Object.freeze(copied);
            } else components = Object.freeze([Object.freeze([input.owned ? entry.source : span(entry.source)])]);
            if (!components.length) throw new RangeError("Empty glyph components."); const previous = nodes.at(-1) ?? null;
            const properties = input.owned ? entry.properties : copyGlyphProperties(entry.properties);
            const node: Node = { glyph: glyphId, inferred, properties, components, prev: previous, next: null, attachment: null, marks: new Set() }; if (previous) previous.next = node; nodes.push(node); counters.prepared = i + 1;
        }
        const associate = (mark: Node, target: Node | null, component = 0) => {
            tick(); if (target === mark) target = null; if (mark.attachment) mark.attachment.target.marks.delete(mark);
            mark.attachment = target ? { target, component } : null; target?.marks.add(mark);
        };
        counters.phase = "associations";
        for (let i = 0; i < input.length; i++) { tick(); if (pause()) yield; const entry = input.at(i); if (!("attachment" in entry) || !entry.attachment) continue; const { glyphIndex, component } = entry.attachment;
            if (!Number.isSafeInteger(glyphIndex) || glyphIndex < 0 || glyphIndex >= nodes.length || glyphIndex === i || !Number.isSafeInteger(component) || component < 0 || component >= nodes[glyphIndex]!.components.length) throw new RangeError("Invalid ligature association."); associate(nodes[i]!, nodes[glyphIndex]!, component); }
        counters.phase = "validate";
        const colors = new Uint8Array(nodes.length), indices = new Map<Node, number>();
        for (let i = 0; i < nodes.length; i++) { tick(); if (pause()) yield; indices.set(nodes[i]!, i); }
        for (let i = 0; i < nodes.length; i++) { tick(); if (pause()) yield; if (colors[i]) continue; const path: number[] = []; let at: number | undefined = i;
            while (at !== undefined && !colors[at]) { tick(); if (pause()) yield; colors[at] = 1; path.push(at); const target: Node | undefined = nodes[at]!.attachment?.target; at = target ? indices.get(target) : undefined; }
            if (at !== undefined && colors[at] === 1) throw new RangeError("Cyclic ligature association."); for (const index of path) { tick(); if (pause()) yield; colors[index] = 2; }
        }
        let head = nodes[0] ?? null, tail = nodes.at(-1) ?? null; const frames: Frame[] = [];
        const glyphClass = (node: Node) => definitions.glyphs?.get(node.glyph) || node.inferred;
        const eligible = (node: Node, lookup: Lookup): boolean => {
            tick(); const kind = glyphClass(node), flags = lookup.flags;
            if (kind === 1 && flags & 2 || kind === 2 && flags & 4 || kind === 3 && flags & 8) return false;
            if (kind !== 3) return true; if (flags & 0x10) return definitions.sets[lookup.markSet]!.index(node.glyph) >= 0;
            return !(flags & 0xff00) || definitions.attachments!.get(node.glyph) === flags >>> 8;
        };
        function* next(node: Node, direction: 1 | -1, lookup: Lookup): Generator<void, Node | null> {
            let value = direction === 1 ? node.next : node.prev;
            while (value) { const accepted = eligible(value, lookup); if (pause()) yield; if (accepted) return value; value = direction === 1 ? value.next : value.prev; } return null;
        };
        function* surrounding(node: Node, pattern: readonly Matcher[], direction: 1 | -1, lookup: Lookup): Generator<void, boolean> {
            let value: Node | null = node; for (const matches of pattern) { tick(); if (pause()) yield; value = yield* next(value!, direction, lookup); if (!value || !matches(value.glyph)) return false; } return true;
        };
        function* slots(parts: readonly Node[], outputs: readonly Node[], after: Node | null): Generator<void, void> {
            const consumed = new Set<Node>(); for (const part of parts) { tick(); if (pause()) yield; consumed.add(part); }
            for (const frame of frames) { tick(); if (pause()) yield; if (frame.after && consumed.has(frame.after)) frame.after = after; const updated: Node[] = []; let inserted = false;
                for (const node of frame.slots) { tick(); if (pause()) yield; if (!consumed.has(node)) updated.push(node); else if (!inserted) { for (const output of outputs) { tick(); if (pause()) yield; updated.push(output); } inserted = true; } } frame.slots = updated; }
        };
        const single = (node: Node, glyph: number) => { node.inferred = glyphClass(node); node.glyph = glyph; node.properties = substitutedGlyphProperties(node.properties); counters.substitutions++; };
        function* multiple(node: Node, output: readonly number[]): Generator<void, Node | null> {
            if (length + output.length - 1 > maxGlyphs) throw new SubstitutionLimitError("glyphs"); length += output.length - 1; counters.current = length;
            const after = node.next, replacement: Node[] = [node]; node.glyph = output[0]!; node.inferred = 1; node.properties = substitutedGlyphProperties(node.properties);
            if (output.length > 1) { const marks: Node[] = []; for (const mark of node.marks) { tick(); if (pause()) yield; marks.push(mark); } for (const mark of marks) { associate(mark, null); if (pause()) yield; } }
            for (let i = 1; i < output.length; i++) { tick(); if (pause()) yield; const previous = replacement.at(-1)!, created: Node = { glyph: output[i]!, inferred: 1, properties: node.properties, components: node.components, prev: previous, next: null, attachment: null, marks: new Set() };
                previous.next = created; replacement.push(created); if (node.attachment) associate(created, node.attachment.target, node.attachment.component); }
            const last = replacement.at(-1)!; last.next = after; if (after) after.prev = last; else tail = last; yield* slots([node], replacement, after); counters.substitutions++; return after;
        };
        function* ligature(parts: readonly Node[], output: number): Generator<void, Node | null> {
            const first = parts[0]!, last = parts.at(-1)!, after = last.next, consumed = new Set<Node>(), offsets: number[] = [], components: (readonly GlyphSourceSpan[])[] = []; let componentCount = 0;
            for (const part of parts) { tick(); if (pause()) yield; consumed.add(part); offsets.push(componentCount); for (const component of part.components) { tick(); if (pause()) yield; components.push(component); componentCount++; } }
            for (let i = 0; i < parts.length; i++) { const part = parts[i]!, marks: Node[] = []; for (const mark of part.marks) { tick(); if (pause()) yield; marks.push(mark); } for (const mark of marks) { tick(); if (pause()) yield; if (consumed.has(mark)) associate(mark, null); else associate(mark, first, offsets[i]! + mark.attachment!.component); } }
            let partIndex = 0;
            for (let node = first.next; node && node !== after; node = node.next) { tick(); if (pause()) yield; if (partIndex + 1 < parts.length && node === parts[partIndex + 1]) partIndex++;
                else if (!consumed.has(node) && glyphClass(node) === 3 && node.attachment?.target !== first) associate(node, first, offsets[partIndex]! + parts[partIndex]!.components.length - 1); }
            let properties = first.properties;
            for (let i = 1; i < parts.length; i++) { tick(); if (pause()) yield; properties = mergeGlyphProperties(properties, parts[i]!.properties); }
            yield* slots(parts, [first], after); first.glyph = output; first.inferred = 2; first.components = Object.freeze(components); first.properties = substitutedGlyphProperties(properties, true);
            for (let i = 1; i < parts.length; i++) { const node = parts[i]!; associate(node, null); if (node.prev) node.prev.next = node.next; else head = node.next;
                if (node.next) node.next.prev = node.prev; else tail = node.prev; length--; counters.current = length; if (pause()) yield; }
            counters.substitutions++; return after;
        };
        function* applyLookup(node: Node, index: number, value: number, depth: number): Generator<void, { matched: boolean; next: Node | null }> {
            tick(); if (pause()) yield; if (depth > maxDepth) throw new SubstitutionLimitError("depth"); const lookup = lookups[index]!;
            if (!eligible(node, lookup)) return { matched: false, next: node.next };
            for (const table of lookup.subtables) {
                tick(); if (pause()) yield;
                if ("rules" in table) {
                    for (const rule of table.rules(node.glyph)) {
                        tick(); if (pause()) yield; if (!rule.input[0]!(node.glyph)) continue; const matched: Node[] = [node]; let current: Node | null = node;
                        for (let i = 1; i < rule.input.length; i++) { tick(); if (pause()) yield; current = yield* next(current!, 1, lookup); if (!current || !rule.input[i]!(current.glyph)) break; matched.push(current); }
                        if (matched.length !== rule.input.length || !(yield* surrounding(node, rule.back, -1, lookup)) || !(yield* surrounding(matched.at(-1)!, rule.ahead, 1, lookup))) continue;
                        const frame: Frame = { slots: matched, after: matched.at(-1)!.next }; frames.push(frame);
                        try { for (const action of rule.actions) { tick(); if (pause()) yield; const target = frame.slots[action.sequence]; if (target) yield* applyLookup(target, action.lookup, value, depth + 1); } }
                        finally { frames.pop(); }
                        return { matched: true, next: frame.after };
                    }
                    continue;
                }
                const covered = table.coverage.index(node.glyph); if (covered < 0) continue;
                if (table.type === 1) { single(node, table.outputs[covered]!); return { matched: true, next: node.next }; }
                if (table.type === 2) return { matched: true, next: yield* multiple(node, table.outputs[covered]!) };
                if (table.type === 3) { const glyph = table.outputs[covered]![value - 1]; if (glyph === undefined) continue; single(node, glyph); return { matched: true, next: node.next }; }
                if (table.type === 4) {
                    for (const entry of table.ligatures[covered]!) { tick(); if (pause()) yield; const matched = [node]; let current: Node | null = node;
                        for (const glyph of entry.components) { tick(); if (pause()) yield; current = yield* next(current!, 1, lookup); if (!current || current.glyph !== glyph) break; matched.push(current); }
                        if (matched.length === entry.components.length + 1) return { matched: true, next: yield* ligature(matched, entry.output) }; }
                } else if (table.type === 8 && (yield* surrounding(node, table.back, -1, lookup)) && (yield* surrounding(node, table.ahead, 1, lookup))) { single(node, table.outputs[covered]!); return { matched: true, next: node.next }; }
            }
            return { matched: false, next: node.next };
        };
        counters.phase = "lookups";
        for (const pass of selection.selected) { tick(); if (pause()) yield;
            const reverse = lookups[pass.index]!.type === 8; let current = reverse ? tail : head;
            while (current) { tick(); if (pause()) yield; const previous = current.prev, result = yield* applyLookup(current, pass.index, pass.value, 1); current = reverse ? previous : result.next; }
        }
        counters.phase = "ordinals";
        const outputNodes: Node[] = [], ordinals = new Map<Node, number>();
        for (let node = head; node; node = node.next) { tick(); if (pause()) yield; ordinals.set(node, outputNodes.length); outputNodes.push(node); }
        if (outputNodes.length !== length) throw new Error("Glyph sequence length invariant failed.");
        counters.phase = "publish"; const glyphs: SubstitutionGlyph[] = [];
        for (const node of outputNodes) {
            tick(); if (pause()) yield; const sources: GlyphSourceSpan[] = [];
            for (const component of node.components) { tick(); if (pause()) yield; for (const source of component) { tick(); if (pause()) yield; sources.push(source); } }
            const attachment = node.attachment ? Object.freeze({ glyphIndex: ordinals.get(node.attachment.target)!, component: node.attachment.component }) : null;
            if (attachment && (attachment.glyphIndex === undefined || attachment.component >= node.attachment!.target.components.length)) throw new Error("Ligature association invariant failed.");
            glyphs.push(Object.freeze({ glyphId: node.glyph, glyphClass: glyphClass(node), ...(node.properties ? { properties: node.properties } : {}), components: node.components, sources: Object.freeze(sources), attachment })); counters.published = glyphs.length;
        }
        const result = Object.freeze({ font, selection: selection.metadata, glyphs: Object.freeze(glyphs), operations: counters.operations, substitutions: counters.substitutions }); ownedResults.add(result); return result;
    }
    const capture = (input: SubstitutionSource, cooperative: boolean): Input => {
        if (ownedGlyphRun(input)) { if (input.font !== font) throw new RangeError("Substitution requires the captured glyph-run font."); return { length: input.length, owned: true, at: i => input.at(i) }; }
        if (ownedSubstitutionResult(input)) { if (input.font !== font) throw new RangeError("Substitution requires the captured source font."); return { length: input.glyphs.length, owned: true, at: i => input.glyphs[i]! }; }
        if (!cooperative && Array.isArray(input)) return { length: input.length, owned: false, at: i => input[i]! };
        throw new TypeError("A substitution cursor requires an owned immutable glyph run or substitution result.");
    };
    const start = (input: Input, limits: SubstitutionLimits): SubstitutionCursor => {
        const { maxOperations, maxGlyphs, maxDepth } = limits, captured: SubstitutionLimits = { ...(maxOperations === undefined ? {} : { maxOperations }), ...(maxGlyphs === undefined ? {} : { maxGlyphs }), ...(maxDepth === undefined ? {} : { maxDepth }) };
        const counters: SubstitutionCounters = { phase: "input", prepared: 0, current: input.length, published: 0, substitutions: 0, operations: 0, yielded: 0 };
        return substitutionCursor(execute(input, captured, counters), counters);
    };
    const createCursor = (input: GlyphRun<SubstitutionInputGlyph> | SubstitutionResult, limits: SubstitutionLimits = {}) => start(capture(input, true), limits);
    const apply = (input: SubstitutionSource, limits: SubstitutionLimits = {}): SubstitutionResult => {
        const cursor = start(capture(input, false), limits);
        try { let step = cursor.next(65536); while (step.status === "running") step = cursor.next(65536); return step.result!; } finally { cursor.dispose(); }
    };
    return Object.freeze({ font, selection: selection.metadata, apply, createCursor });
}
