import { unicodeDefaultIgnorable, unicodeVariationSelector } from "./unicode-shaping-data.ts";

/** Properties of the mapped input and its substitution lineage; independent of source spans. */
export type GlyphProperties = Readonly<{ defaultIgnorable: boolean; zeroWidthJoiner: boolean; zeroWidthNonJoiner: boolean;
    variationSelector: boolean; substituted: boolean; ligated: boolean }>;
const cache: (GlyphProperties | undefined)[] = new Array(64);
function properties(bits: number): GlyphProperties {
    return cache[bits] ??= Object.freeze({ defaultIgnorable: !!(bits & 1), zeroWidthJoiner: !!(bits & 2), zeroWidthNonJoiner: !!(bits & 4),
        variationSelector: !!(bits & 8), substituted: !!(bits & 16), ligated: !!(bits & 32) });
}
const bitsOf = (p: GlyphProperties) => +p.defaultIgnorable | +p.zeroWidthJoiner << 1 | +p.zeroWidthNonJoiner << 2 | +p.variationSelector << 3 | +p.substituted << 4 | +p.ligated << 5;
export function copyGlyphProperties(value: GlyphProperties | undefined): GlyphProperties | undefined {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== "object") throw new RangeError("Invalid glyph properties.");
    const { defaultIgnorable, zeroWidthJoiner, zeroWidthNonJoiner, variationSelector, substituted, ligated } = value;
    if (![defaultIgnorable, zeroWidthJoiner, zeroWidthNonJoiner, variationSelector, substituted, ligated].every(v => typeof v === "boolean")) throw new RangeError("Invalid glyph properties.");
    return properties(bitsOf({ defaultIgnorable, zeroWidthJoiner, zeroWidthNonJoiner, variationSelector, substituted, ligated }));
}
export const mappedGlyphProperties = (cp: number): GlyphProperties => properties(+unicodeDefaultIgnorable(cp) | +(cp === 0x200d) << 1 | +(cp === 0x200c) << 2 | +unicodeVariationSelector(cp) << 3);
export const substitutedGlyphProperties = (p: GlyphProperties | undefined, ligated = false): GlyphProperties | undefined => p ? properties(bitsOf(p) | 16 | (ligated ? 32 : 0)) : undefined;
/** A mixed or unknown input is not wholly ignorable. Other flags describe any contributing input. */
export const mergeGlyphProperties = (a: GlyphProperties | undefined, b: GlyphProperties | undefined): GlyphProperties | undefined => a || b
    ? properties(((a ? bitsOf(a) : 0) | (b ? bitsOf(b) : 0)) & ~1 | +(!!a?.defaultIgnorable && !!b?.defaultIgnorable)) : undefined;
export const hiddenGlyph = (p: GlyphProperties | undefined): boolean => !!p?.defaultIgnorable && !p.substituted && !p.ligated;
