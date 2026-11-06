import { FontReader, fontSearch, invalidFont as invalid } from "./font-reader.ts";

export type LayoutFeature = Readonly<{ tag: string; value?: number }>;
export type LayoutSelectionOptions = Readonly<{ script?: string; language?: string | null; features: readonly LayoutFeature[]; normalizedCoordinates?: readonly number[] }>;
export type LayoutSelection = Readonly<{ requestedScript: string; script: string | null; requestedLanguage: string | null; language: string | null;
    featureVariation: number | null; features: readonly Readonly<{ tag: string; index: number; required: boolean; value: number; lookups: readonly number[] }>[];
    lookups: readonly number[] }>;
export type Coverage = Readonly<{ count: number; index: (glyph: number) => number; glyph: (index: number) => number }>;
export type GlyphClasses = Readonly<{ maximum: number; get: (glyph: number) => number }>;
const tag = (value: string) => { if (typeof value !== "string" || !/^[\x20-\x7e]{4}$/.test(value)) throw new RangeError("Expected a four-byte layout tag."); return value; };
export const requiredOffset = (b: FontReader, offset: number): FontReader => { if (!offset) invalid("null layout offset"); return b.tail(offset); };

/** Coverage and class definitions are shared by substitution and future positioning readers. */
export function layoutReaders(glyphCount: number) {
    const coverages = new Map<number, Coverage>(), definitions = new Map<number, GlyphClasses>();
    const glyph = (value: number) => { if (value >= glyphCount) invalid("layout glyph exceeds maxp"); return value; };
    const coverage = (b: FontReader): Coverage => {
        const cached = coverages.get(b.start); if (cached) return cached;
        const format = b.u16(0), count = b.u16(2); let values: Uint16Array;
        if (format === 1) {
            b.span(4, count * 2); values = new Uint16Array(count);
            for (let i = 0, previous = -1; i < count; i++) { const value = glyph(b.u16(4 + i * 2)); if (value <= previous) invalid("unordered coverage"); values[i] = value; previous = value; }
        } else if (format === 2) {
            b.span(4, count * 6); let length = 0;
            for (let i = 0, previous = -1; i < count; i++) { const p = 4 + i * 6, first = glyph(b.u16(p)), last = glyph(b.u16(p + 2));
                if (first > last || first <= previous || b.u16(p + 4) !== length) invalid("coverage range"); length += last - first + 1; previous = last; }
            values = new Uint16Array(length); let at = 0;
            for (let i = 0; i < count; i++) for (let value = b.u16(4 + i * 6), last = b.u16(6 + i * 6); value <= last; value++) values[at++] = value;
        } else invalid("coverage format");
        const data = values!, result = { count: data.length, index: (value: number) => { const i = fontSearch(data.length, at => data[at]!, value); return data[i] === value ? i : -1; }, glyph: (i: number) => data[i]! };
        coverages.set(b.start, result); return result;
    };
    const classes = (b: FontReader): GlyphClasses => {
        const cached = definitions.get(b.start); if (cached) return cached;
        const format = b.u16(0); let maximum = 0, get: (glyph: number) => number;
        if (format === 1) {
            const first = b.u16(2), count = b.u16(4); if (first + count > glyphCount) invalid("class glyph range"); b.span(6, count * 2);
            for (let i = 0; i < count; i++) maximum = Math.max(maximum, b.u16(6 + i * 2));
            get = value => value >= first && value < first + count ? b.u16(6 + (value - first) * 2) : 0;
        } else if (format === 2) {
            const count = b.u16(2); b.span(4, count * 6);
            for (let i = 0, previous = -1; i < count; i++) { const p = 4 + i * 6, first = glyph(b.u16(p)), last = glyph(b.u16(p + 2));
                if (first > last || first <= previous) invalid("class ranges"); previous = last; maximum = Math.max(maximum, b.u16(p + 4)); }
            get = value => { const i = fontSearch(count, at => b.u16(6 + at * 6), value); return i < count && b.u16(4 + i * 6) <= value ? b.u16(8 + i * 6) : 0; };
        } else return invalid("class definition format");
        const result = { maximum, get }; definitions.set(b.start, result); return result;
    };
    return { glyph, coverage, classes };
}

export function glyphDefinitions(b: FontReader | undefined, readers: ReturnType<typeof layoutReaders>) {
    let glyphs: GlyphClasses | undefined, attachments: GlyphClasses | undefined, variations: FontReader | undefined; const sets: Coverage[] = [];
    if (b) {
        const version = b.u32(0); if (version !== 0x10000 && version !== 0x10002 && version !== 0x10003) invalid("GDEF version"); b.span(0, version >= 0x10003 ? 18 : version >= 0x10002 ? 14 : 12);
        if (b.u16(4)) { glyphs = readers.classes(requiredOffset(b, b.u16(4))); if (glyphs.maximum > 4) invalid("GDEF glyph class"); }
        if (b.u16(10)) attachments = readers.classes(requiredOffset(b, b.u16(10)));
        if (version >= 0x10002 && b.u16(12)) {
            const table = requiredOffset(b, b.u16(12)); if (table.u16(0) !== 1) invalid("mark glyph set format"); const count = table.u16(2); table.span(4, count * 4);
            for (let i = 0; i < count; i++) sets.push(readers.coverage(requiredOffset(table, table.u32(4 + i * 4))));
        }
        if (version >= 0x10003 && b.u32(14)) variations = requiredOffset(b, b.u32(14));
    }
    return { glyphs, attachments, sets, variations };
}

export function layoutLookupProperties(b: FontReader, definitions: ReturnType<typeof glyphDefinitions>) {
    const flags = b.u16(2), count = b.u16(4); if (flags & 0x00e0) invalid("reserved lookup flags"); b.span(6, count * 2);
    const markSet = flags & 0x10 ? b.u16(6 + count * 2) : -1;
    if (flags & 0xff1e && !definitions.glyphs) invalid("lookup requires GDEF glyph classes");
    if (!(flags & 8) && flags & 0x10 && markSet >= definitions.sets.length) invalid("lookup mark filtering set");
    if (!(flags & 0x18) && flags & 0xff00 && !definitions.attachments) invalid("lookup requires mark attachment classes");
    return { flags, markSet, count };
}

function axisCoordinates(fvar: FontReader | undefined, input: readonly number[] | undefined): readonly number[] {
    let count = 0;
    if (fvar) { if (fvar.u32(0) !== 0x10000) invalid("fvar version"); fvar.span(0, 16); count = fvar.u16(8); const size = fvar.u16(10); if (size < 20) invalid("fvar axis size"); fvar.span(fvar.u16(4), count * size); }
    const coordinates = input ? [...input] : new Array<number>(count).fill(0);
    if (coordinates.length !== count || coordinates.some(value => !Number.isFinite(value) || value < -1 || value > 1)) throw new RangeError("Expected normalized coordinates for every font axis.");
    return coordinates;
}

export function layoutSelection(b: FontReader | undefined, fvar: FontReader | undefined, options: LayoutSelectionOptions, tableTag = "GSUB") {
    const requestedScript = tag(options.script ?? "DFLT"), requestedLanguage = options.language == null ? null : tag(options.language), requested = new Map<string, number>();
    for (const feature of options.features) { tag(feature.tag); const value = feature.value ?? 1; if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff || requested.has(feature.tag)) throw new RangeError("Invalid or duplicate layout feature."); requested.set(feature.tag, value); }
    const coordinates = axisCoordinates(fvar, options.normalizedCoordinates), lookups: FontReader[] = [];
    const empty = (): { metadata: LayoutSelection; coordinates: readonly number[]; lookups: FontReader[]; selected: readonly Readonly<{ index: number; value: number }>[] } => ({ metadata: Object.freeze({ requestedScript, script: null, requestedLanguage, language: null, featureVariation: null, features: Object.freeze([]), lookups: Object.freeze([]) }), coordinates, lookups, selected: [] });
    if (!b) return empty(); const version = b.u32(0); if (version !== 0x10000 && version !== 0x10001) invalid(`${tableTag} version`); b.span(0, version === 0x10001 ? 14 : 10);
    const scripts = requiredOffset(b, b.u16(4)), features = requiredOffset(b, b.u16(6)), list = requiredOffset(b, b.u16(8)), lookupCount = list.u16(0); list.span(2, lookupCount * 2);
    for (let i = 0; i < lookupCount; i++) lookups.push(requiredOffset(list, list.u16(2 + i * 2)));
    const featureCount = features.u16(0); features.span(2, featureCount * 6); const featureTables: FontReader[] = [], featureTags: string[] = [];
    for (let i = 0, previous = ""; i < featureCount; i++) { const p = 2 + i * 6, value = tag(features.tag(p)); if (value < previous) invalid("feature tag order"); previous = value; featureTags.push(value); featureTables.push(requiredOffset(features, features.u16(p + 4))); }
    let featureVariation: number | null = null;
    if (version === 0x10001 && b.u32(10)) {
        const variations = requiredOffset(b, b.u32(10)); if (variations.u32(0) !== 0x10000) invalid("feature variations version"); const count = variations.u32(4); variations.span(8, count * 8);
        for (let i = 0; i < count; i++) {
            const p = 8 + i * 8, conditionOffset = variations.u32(p), substitutionOffset = variations.u32(p + 4); let matches = true;
            if (conditionOffset) { const conditions = requiredOffset(variations, conditionOffset), n = conditions.u16(0); conditions.span(2, n * 4);
                for (let j = 0; j < n; j++) { const condition = requiredOffset(conditions, conditions.u32(2 + j * 4)); if (condition.u16(0) !== 1) { matches = false; continue; }
                    const axis = condition.u16(2), low = condition.i16(4) / 16384, high = condition.i16(6) / 16384; if (low < -1 || high > 1 || low > high) invalid("variation condition range");
                    if (axis >= coordinates.length || coordinates[axis]! < low || coordinates[axis]! > high) matches = false; }
            }
            if (!matches || featureVariation !== null) continue;
            if (!substitutionOffset) { featureVariation = i; continue; }
            const substitutions = requiredOffset(variations, substitutionOffset); if (substitutions.u32(0) !== 0x10000) continue;
            const n = substitutions.u16(4); substitutions.span(6, n * 6); let previous = -1;
            for (let j = 0; j < n; j++) { const q = 6 + j * 6, index = substitutions.u16(q); if (index <= previous || index >= featureCount) invalid("feature substitution index"); previous = index;
                featureTables[index] = requiredOffset(substitutions, substitutions.u32(q + 2)); }
            featureVariation = i;
        }
    }
    const featureLookups = featureTables.map(table => { const count = table.u16(2), indices: number[] = []; table.span(4, count * 2); if (table.u16(0)) table.span(table.u16(0), 0);
        for (let i = 0; i < count; i++) { const index = table.u16(4 + i * 2); if (index >= lookupCount) invalid("feature lookup index"); indices.push(index); } return indices; });
    const scriptCount = scripts.u16(0); scripts.span(2, scriptCount * 6); const scriptTables = new Map<string, FontReader>();
    for (let i = 0, previous = ""; i < scriptCount; i++) { const p = 2 + i * 6, value = tag(scripts.tag(p)); if (value <= previous) invalid("script tag order"); previous = value; scriptTables.set(value, requiredOffset(scripts, scripts.u16(p + 4))); }
    const script = scriptTables.has(requestedScript) ? requestedScript : scriptTables.has("DFLT") ? "DFLT" : null; if (!script) return empty();
    const table = scriptTables.get(script)!, defaultOffset = table.u16(0), languageCount = table.u16(2); table.span(4, languageCount * 6); const languages = new Map<string, FontReader>();
    for (let i = 0, previous = ""; i < languageCount; i++) { const p = 4 + i * 6, value = tag(table.tag(p)); if (value <= previous) invalid("language tag order"); previous = value; languages.set(value, requiredOffset(table, table.u16(p + 4))); }
    if (script === "DFLT" && !defaultOffset) invalid("default script language"); const language = requestedLanguage && languages.has(requestedLanguage) ? requestedLanguage : null;
    const lang = language ? languages.get(language)! : defaultOffset ? requiredOffset(table, defaultOffset) : undefined;
    const chosen: number[] = [], required = lang?.u16(2) ?? 0xffff;
    if (lang) { if (lang.u16(0)) invalid("reserved language lookup order"); const count = lang.u16(4); lang.span(6, count * 2);
        if (required !== 0xffff) { if (required >= featureCount) invalid("required feature index"); chosen.push(required); }
        for (let i = 0; i < count; i++) { const index = lang.u16(6 + i * 2); if (index >= featureCount) invalid("language feature index"); if (!chosen.includes(index) && (requested.get(featureTags[index]!) ?? 0) > 0) chosen.push(index); }
    }
    const passes = new Map<number, number>(), chosenFeatures = chosen.map(index => {
        const value = index === required ? requested.get(featureTags[index]!) || 1 : requested.get(featureTags[index]!)!;
        for (const lookup of featureLookups[index]!) { const prior = passes.get(lookup); if (prior !== undefined && prior !== value) throw new RangeError("A shared lookup has conflicting feature values; use separate stages."); passes.set(lookup, value); }
        return Object.freeze({ tag: featureTags[index]!, index, required: index === required, value, lookups: Object.freeze([...featureLookups[index]!]) });
    });
    const selected = [...passes].sort(([a], [c]) => a - c).map(([index, value]) => Object.freeze({ index, value }));
    const metadata: LayoutSelection = Object.freeze({ requestedScript, script, requestedLanguage, language, featureVariation, features: Object.freeze(chosenFeatures), lookups: Object.freeze(selected.map(p => p.index)) });
    return { metadata, coordinates, lookups, selected };
}

export type LayoutMatcher = (glyph: number) => boolean;
type LayoutAction = Readonly<{ sequence: number; lookup: number }>;
export type LayoutContextRule = Readonly<{ input: readonly LayoutMatcher[]; back: readonly LayoutMatcher[]; ahead: readonly LayoutMatcher[]; actions: readonly LayoutAction[] }>;
export type LayoutContext = Readonly<{ rules: (glyph: number) => readonly LayoutContextRule[] }>;
export function readLayoutContext(b: FontReader, chained: boolean, readers: ReturnType<typeof layoutReaders>, lookupCount: number): LayoutContext {
    const exact = (value: number): LayoutMatcher => { readers.glyph(value); return glyph => glyph === value; };
    const member = (coverage: Coverage): LayoutMatcher => glyph => coverage.index(glyph) >= 0;
    const classified = (classes: GlyphClasses, value: number): LayoutMatcher => glyph => classes.get(glyph) === value;
    const actions = (b: FontReader, at: number, count: number): readonly LayoutAction[] => {
        b.span(at, count * 4); const result: LayoutAction[] = [];
        for (let i = 0; i < count; i++) { const p = at + i * 4, lookup = b.u16(p + 2); if (lookup >= lookupCount) invalid("nested lookup index"); result.push({ sequence: b.u16(p), lookup }); }
        return result;
    };
    const coverageAt = (b: FontReader, at: number) => readers.coverage(requiredOffset(b, b.u16(at)));

        const format = b.u16(0);
        if (format === 3) {
            let at = 2;
            const coverages = () => { const count = b.u16(at); at += 2; b.span(at, count * 2); const result: LayoutMatcher[] = [];
                for (let i = 0; i < count; i++, at += 2) result.push(member(coverageAt(b, at))); return result; };
            if (!chained) {
                const count = b.u16(2), n = b.u16(4); if (!count) invalid("empty context input"); b.span(6, count * 2);
                const input = Array.from({ length: count }, (_, i) => member(coverageAt(b, 6 + i * 2))), rule = { input, back: [], ahead: [], actions: actions(b, 6 + count * 2, n) };
                return { rules: () => [rule] };
            }
            const back = coverages(), input = coverages(), ahead = coverages(); if (!input.length) invalid("empty chained input"); const n = b.u16(at);
            const rule = { input, back, ahead, actions: actions(b, at + 2, n) }; return { rules: () => [rule] };
        }
        if (format !== 1 && format !== 2) return invalid("context format");
        const coverage = coverageAt(b, 2); let at: number, inputClass: GlyphClasses | undefined, backClass: GlyphClasses | undefined, aheadClass: GlyphClasses | undefined;
        if (format === 1) at = 4;
        else if (!chained) { inputClass = readers.classes(requiredOffset(b, b.u16(4))); at = 6; }
        else { backClass = readers.classes(requiredOffset(b, b.u16(4))); inputClass = readers.classes(requiredOffset(b, b.u16(6))); aheadClass = readers.classes(requiredOffset(b, b.u16(8))); at = 10; }
        const count = b.u16(at), sets: LayoutContextRule[][] = []; b.span(at + 2, count * 2);
        for (let i = 0; i < count; i++) {
            const offset = b.u16(at + 2 + i * 2), rules: LayoutContextRule[] = []; sets.push(rules); if (!offset) continue;
            const set = requiredOffset(b, offset), n = set.u16(0); set.span(2, n * 2);
            for (let j = 0; j < n; j++) {
                const r = requiredOffset(set, set.u16(2 + j * 2)); let p = 0;
                const sequence = (classes: GlyphClasses | undefined, omitFirst = false): LayoutMatcher[] => {
                    const total = r.u16(p); p += 2; if (omitFirst && !total) invalid("empty context input"); const length = total - (omitFirst ? 1 : 0); r.span(p, length * 2);
                    const result: LayoutMatcher[] = omitFirst ? [() => true] : [];
                    for (let k = 0; k < length; k++, p += 2) result.push(classes ? classified(classes, r.u16(p)) : exact(r.u16(p))); return result;
                };
                if (!chained) { const glyphs = r.u16(0), n = r.u16(2); if (!glyphs) invalid("empty context input"); r.span(4, (glyphs - 1) * 2);
                    const input: LayoutMatcher[] = [() => true]; for (let k = 1; k < glyphs; k++) input.push(inputClass ? classified(inputClass, r.u16(2 + k * 2)) : exact(r.u16(2 + k * 2)));
                    rules.push({ input, back: [], ahead: [], actions: actions(r, 4 + (glyphs - 1) * 2, n) });
                } else { const back = sequence(backClass), input = sequence(inputClass, true), ahead = sequence(aheadClass), n = r.u16(p);
                    rules.push({ input, back, ahead, actions: actions(r, p + 2, n) }); }
            }
        }
        return { rules: glyph => { const index = coverage.index(glyph); return index < 0 ? [] : sets[inputClass ? inputClass.get(glyph) : index] ?? []; } };
    }

