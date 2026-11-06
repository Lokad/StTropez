import { FontReader, invalidFont as invalid } from "./font-reader.ts";
export type PositionValue = readonly [number, number, number, number];
export type PositionAnchor = Readonly<{ x: number; y: number }>;
export type ContourAnchorPoint = Readonly<{ glyphId: number; pointIndex: number; x: number; y: number }>;
export const zeroPosition: PositionValue = Object.freeze([0, 0, 0, 0]);
export function positionValueSize(format: number): number {
    if (format & 0xff00) invalid("reserved position value format"); let size = 0; for (let bit = 1; bit <= 0x80; bit *= 2) if (format & bit) size += 2; return size;
}

function variationValues(store: FontReader | undefined, coordinates: readonly number[]) {
    const scalars: number[] = [], data: (FontReader | undefined)[] = [];
    if (store) {
        if (store.u16(0) !== 1) invalid("item variation store format"); const regions = store.tail(store.u32(2)), count = store.u16(6); store.span(8, count * 4);
        const axes = regions.u16(0), n = regions.u16(2); if (axes !== coordinates.length || n >= 32768) invalid("variation region counts"); regions.span(4, axes * n * 6);
        for (let i = 0; i < n; i++) { let scalar = 1;
            for (let axis = 0; axis < axes; axis++) { const p = 4 + (i * axes + axis) * 6, start = regions.i16(p) / 16384, peak = regions.i16(p + 2) / 16384, end = regions.i16(p + 4) / 16384, value = coordinates[axis]!;
                if (start < -1 || end > 1 || start > peak || peak > end || peak !== 0 && start < 0 && end > 0) invalid("variation region coordinates");
                if (!peak || value === peak) continue; if (value <= start || value >= end) scalar = 0; else scalar *= value < peak ? (value - start) / (peak - start) : (end - value) / (end - peak); }
            scalars.push(scalar);
        }
        for (let i = 0; i < count; i++) { const offset = store.u32(8 + i * 4); if (!offset) { data.push(undefined); continue; } const b = store.tail(offset), items = b.u16(0), packed = b.u16(2), regions = b.u16(4), words = packed & 0x7fff, long = !!(packed & 0x8000);
            if (words > regions) invalid("variation delta counts"); b.span(6, regions * 2); for (let j = 0; j < regions; j++) if (b.u16(6 + j * 2) >= scalars.length) invalid("variation region index");
            b.span(6 + regions * 2, items * (regions + words) * (long ? 2 : 1)); data.push(b); }
    }
    return (outer: number, inner: number): number => {
        if (outer === 0xffff && inner === 0xffff) return 0; if (!store || outer >= data.length) return invalid("variation delta outer index"); const b = data[outer]; if (!b) return 0;
        if (inner >= b.u16(0)) invalid("variation delta inner index"); const packed = b.u16(2), count = b.u16(4), words = packed & 0x7fff, long = !!(packed & 0x8000), rowSize = (count + words) * (long ? 2 : 1); let at = 6 + count * 2 + inner * rowSize, result = 0;
        for (let i = 0; i < count; i++) { const width = i < words ? long ? 4 : 2 : long ? 2 : 1, delta = width === 4 ? b.i32(at) : width === 2 ? b.i16(at) : b.i8(at); at += width; result += delta * scalars[b.u16(6 + i * 2)]!; }
        return result;
    };
}

/** Resolves adjustments for one captured size/variation instance. No outline or hinting engine. */
export function positionValues(unitsPerEm: number, coordinates: readonly number[], store: FontReader | undefined,
    ppem: Readonly<{ x: number; y: number }> | undefined, points: readonly ContourAnchorPoint[] | undefined, glyphCount: number) {
    if (ppem && [ppem.x, ppem.y].some(value => !Number.isInteger(value) || value <= 0 || value > 65535)) throw new RangeError("Invalid positioning ppem.");
    const sizes = ppem ? { ...ppem } : undefined, contour = new Map<number, PositionAnchor>(), fallbacks = new Set<number>(), delta = variationValues(store, coordinates), cache = new Map<string, PositionValue>();
    for (const point of points ?? []) { if (!Number.isInteger(point.glyphId) || point.glyphId < 0 || point.glyphId >= glyphCount || !Number.isInteger(point.pointIndex) || point.pointIndex < 0 || point.pointIndex > 65535 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError("Invalid contour anchor point.");
        const key = point.glyphId * 65536 + point.pointIndex; if (contour.has(key)) throw new RangeError("Duplicate contour anchor point."); contour.set(key, Object.freeze({ x: point.x, y: point.y })); }
    const device = (b: FontReader, offset: number, axis: "x" | "y"): number => {
        if (!offset) return 0; const table = b.tail(offset), first = table.u16(0), last = table.u16(2), format = table.u16(4);
        if (format === 0x8000) return delta(first, last); if (format < 1 || format > 3 || last < first) return invalid("device adjustment format");
        const bits = 2 ** format, perWord = 16 / bits; table.span(6, Math.ceil((last - first + 1) / perWord) * 2); const size = sizes?.[axis]; if (size === undefined || size < first || size > last) return 0;
        const at = size - first, shift = 16 - bits - at % perWord * bits, mask = 2 ** bits - 1, raw = table.u16(6 + Math.floor(at / perWord) * 2) >>> shift & mask, signed = raw & 2 ** (bits - 1) ? raw - 2 ** bits : raw;
        return signed * unitsPerEm / size;
    };
    const value = (b: FontReader, at: number, format: number): PositionValue => {
        const key = `${b.start}:${at}:${format}`, prior = cache.get(key); if (prior) return prior; b.span(at, positionValueSize(format)); const fields = [0, 0, 0, 0];
        for (let bit = 0; bit < 8; bit++) if (format & 1 << bit) { if (bit < 4) fields[bit] = b.i16(at); else fields[bit - 4]! += device(b, b.u16(at), bit % 2 ? "y" : "x"); at += 2; }
        const result: PositionValue = Object.freeze([fields[0]!, fields[1]!, fields[2]!, fields[3]!]); cache.set(key, result); return result;
    };
    const anchor = (b: FontReader, offset: number, glyph: number): PositionAnchor | null => {
        if (!offset) return null; const a = b.tail(offset), format = a.u16(0); let x = a.i16(2), y = a.i16(4);
        if (format === 2) { const key = glyph * 65536 + a.u16(6), point = contour.get(key); if (point) { x = point.x; y = point.y; } else fallbacks.add(key); }
        else if (format === 3) { x += device(a, a.u16(6), "x"); y += device(a, a.u16(8), "y"); }
        else if (format !== 1) invalid("anchor format"); return Object.freeze({ x, y });
    };
    return { value, anchor, pointFallbacks: () => fallbacks.size };
}
