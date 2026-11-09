import { resolveBidi, graphemeBoundaries } from "../index.ts";
import type { Affinity } from "../index.ts";

export type CaretRectangle = Readonly<{ offset: number; affinity: Affinity; left: number; top: number; height: number; revision: number; padding?: true }>;
export { graphemeBoundaries };
/** Geometry retains native shaping; resolved bidi levels distinguish the two sides of a logical boundary. */
export function rowGeometry(element: HTMLElement, from: number, revision: number, lineHeight: number) {
    const text = element.textContent ?? "", boundaries = graphemeBoundaries(text), nodes: Text[] = [], owner = element.ownerDocument;
    const iterator = owner.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = iterator.nextNode(); node; node = iterator.nextNode()) nodes.push(node as Text);
    type Glyph = Readonly<{ start: CaretRectangle; end: CaretRectangle; rtl: boolean; nativeStart: boolean; nativeEnd: boolean }>;
    let bounds: DOMRect | undefined, glyphs = new Map<number, Glyph>(), boxes = new Map<number, readonly DOMRect[]>(), raw = new Map<number, readonly DOMRect[]>(), levels: readonly (number | null)[] = [], order: readonly number[] = [], styleKey = "", flow = 1, prepared = false;
    const ensure = () => {
        const next = element.getBoundingClientRect(), style = owner.defaultView!.getComputedStyle(element);
        const key = [style.direction, style.font, style.letterSpacing, style.wordSpacing, style.fontVariantLigatures, style.fontKerning, style.unicodeBidi, style.tabSize, style.textAlign].join("|");
        if (bounds && key === styleKey && next.left === bounds.left && next.top === bounds.top && next.width === bounds.width && next.height === bounds.height) return;
        styleKey = key; flow = style.direction === "rtl" ? -1 : 1;
        bounds = next; glyphs = new Map(); boxes = new Map(); raw = new Map(); prepared = false;
        const resolved = resolveBidi(text, flow < 0 ? "rtl" : "ltr"); levels = resolved.levels; order = resolved.order;
    };
    const locate = (offset: number): Readonly<{ node: Text; offset: number }> | undefined => {
        for (const node of nodes) { if (offset <= node.length) return { node, offset }; offset -= node.length; } return undefined;
    };
    const range = (start: number, end: number): Range | undefined => {
        const a = locate(start), b = locate(end); if (!a || !b) return;
        const value = owner.createRange(); value.setStart(a.node, a.offset); value.setEnd(b.node, b.offset); return value;
    };
    const collapsed = (offset: number): readonly DOMRect[] => {
        let result = raw.get(offset); if (!result) { result = [...range(offset, offset)?.getClientRects() ?? []]; raw.set(offset, result); } return result;
    };
    const measured = (index: number): readonly DOMRect[] => {
        let result = boxes.get(index); if (result) return result;
        const start = boundaries[index]!, end = boundaries[index + 1]!;
        // Formatting controls can expose remote rectangles in native ranges. They have no advance.
        let invisible = true, offset = start;
        for (const char of text.slice(start, end)) {
            const cp = char.codePointAt(0)!;
            if (levels[offset] !== null && !(cp >= 0x2066 && cp <= 0x2069) && cp !== 0x200e && cp !== 0x200f && cp !== 0x061c) invisible = false;
            offset += char.length;
        }
        result = invisible ? [] : [...range(start, end)?.getClientRects() ?? []].filter(rect => rect.width > .01 && rect.height > 0);
        boxes.set(index, result); return result;
    };
    const make = (offset: number, affinity: Affinity, left: number, top: number, height: number): CaretRectangle => Object.freeze({ offset: from + offset, affinity, left, top, height: height || lineHeight, revision });
    const glyph = (index: number): Glyph => {
        let value = glyphs.get(index); if (value) return value;
        const start = boundaries[index]!, end = boundaries[index + 1]!, rectangles = measured(index);
        if (rectangles.length) {
            const left = Math.min(...rectangles.map(r => r.left)), right = Math.max(...rectangles.map(r => r.right)), top = Math.min(...rectangles.map(r => r.top)), bottom = Math.max(...rectangles.map(r => r.bottom));
            let level = 0; for (let offset = start; offset < end; offset++) if (levels[offset] !== null) { level = levels[offset] ?? 0; break; }
            const rtl = level % 2 === 1, desiredStart = rtl ? right : left, desiredEnd = rtl ? left : right;
            const closest = (values: readonly DOMRect[], x: number) => values.reduce<DOMRect | undefined>((best, next) => !best || Math.abs(next.left - x) < Math.abs(best.left - x) ? next : best, undefined);
            const a = closest(collapsed(start), desiredStart), b = closest(collapsed(end), desiredEnd);
            const inside = (rect: DOMRect | undefined) => rect && rect.left >= left - 1.5 && rect.left <= right + 1.5;
            // Native caret interiors preserve ligature subdivisions when both endpoints agree with the run direction.
            const consistent = inside(a) && inside(b) && (rtl ? a!.left > b!.left : a!.left < b!.left);
            const nativeStart = !!a && (!!consistent || Math.abs(a.left - desiredStart) <= 1.5), nativeEnd = !!b && (!!consistent || Math.abs(b.left - desiredEnd) <= 1.5);
            value = { start: make(start, "after", nativeStart ? a!.left : desiredStart, top, bottom - top), end: make(end, "before", nativeEnd ? b!.left : desiredEnd, top, bottom - top), rtl, nativeStart, nativeEnd };
        } else {
            let before = index - 1, after = index + 1;
            while (before >= 0 && !measured(before).length) before--; while (after + 1 < boundaries.length && !measured(after).length) after++;
            const previous = before >= 0 ? glyph(before).end : undefined, next = after + 1 < boundaries.length ? glyph(after).start : undefined;
            const a = previous ?? next, b = next ?? previous;
            value = { start: make(start, "after", a?.left ?? bounds!.left, a?.top ?? bounds!.top, a?.height ?? lineHeight), end: make(end, "before", b?.left ?? bounds!.left, b?.top ?? bounds!.top, b?.height ?? lineHeight), rtl: false, nativeStart: false, nativeEnd: false };
        }
        glyphs.set(index, value); return value;
    };
    const prepare = () => {
        ensure(); if (prepared) return;
        const clusters = new Int32Array(text.length), visible: number[] = [], seen = new Set<number>();
        for (let index = 0; index + 1 < boundaries.length; index++) { clusters.fill(index, boundaries[index]!, boundaries[index + 1]!); if (measured(index).length) glyph(index); }
        for (const offset of order) { const index = clusters[offset]!; if (!seen.has(index) && measured(index).length) { visible.push(index); seen.add(index); } }
        // Two adjacent visible clusters share one insertion position. Native rectangle rounding
        // must not create an extra caret stop; never merge the two edges of a narrow glyph.
        for (let position = 1; position < visible.length; position++) {
            const ai = visible[position - 1]!, bi = visible[position]!, a = glyph(ai), b = glyph(bi);
            const aSide = a.rtl ? "start" : "end", bSide = b.rtl ? "end" : "start", ap = a[aSide], bp = b[bSide];
            if (Math.abs(ap.left - bp.left) > 1.5 || Math.abs(ap.top - bp.top) > 1) continue;
            const an = a.rtl ? a.nativeStart : a.nativeEnd, bn = b.rtl ? b.nativeEnd : b.nativeStart;
            const x = an === bn ? (ap.left + bp.left) / 2 : an ? ap.left : bp.left;
            glyphs.set(ai, { ...a, [aSide]: Object.freeze({ ...ap, left: x }) }); glyphs.set(bi, { ...b, [bSide]: Object.freeze({ ...bp, left: x }) });
        }
        for (let index = 0; index + 1 < boundaries.length; index++) glyph(index); prepared = true;
    };
    const point = (offset: number, affinity: Affinity = "after"): CaretRectangle | undefined => {
        const local = offset - from; if (local < 0 || local > text.length) return;
        let low = 0, high = boundaries.length;
        while (low < high) { const middle = (low + high) >>> 1; if (boundaries[middle]! < local) low = middle + 1; else high = middle; }
        const index = boundaries[low] === local || affinity === "after" ? low : Math.max(0, low - 1);
        if (boundaries.length === 1) return make(0, affinity, bounds!.left, bounds!.top, lineHeight);
        const selected = index === boundaries.length - 1 || affinity === "before" && index > 0 ? glyph(index - 1).end : glyph(index).start;
        return Object.freeze({ ...selected, affinity });
    };
    return Object.freeze({ point: (offset: number, affinity: Affinity = "after") => { prepare(); return point(offset, affinity); },
        nearest: (clientX: number): CaretRectangle => {
            prepare(); let best: CaretRectangle | undefined, distance = Infinity, underPointer = false;
            for (let index = 0; index + 1 < boundaries.length; index++) {
                const g = glyph(index), inside = clientX >= Math.min(g.start.left, g.end.left) && clientX <= Math.max(g.start.left, g.end.left);
                for (const candidate of [g.start, g.end]) {
                    const next = Math.abs(clientX - candidate.left);
                    if (next < distance - .02 || Math.abs(next - distance) <= .02 && (inside && !underPointer || inside === underPointer && best?.offset === candidate.offset && candidate.affinity === "after")) { best = candidate; distance = next; underPointer = inside; }
                }
            } return best ?? point(from)!;
        },
        visual: (offset: number, affinity: Affinity, direction: -1 | 1): CaretRectangle | undefined => {
            prepare(); const current = point(offset, affinity); if (!current) return;
            let best: CaretRectangle | undefined, distance = Infinity;
            for (let index = 0; index + 1 < boundaries.length; index++) {
                const g = glyph(index), candidate = direction > 0 ? g.start.left > g.end.left ? g.start : g.end : g.start.left < g.end.left ? g.start : g.end;
                const delta = (candidate.left - current.left) * direction; if (delta > .25 && delta < distance) { best = candidate; distance = delta; }
            } return best;
        },
        edge: (direction: -1 | 1, low = from, high = from + text.length): CaretRectangle => {
            prepare(); let best: CaretRectangle | undefined;
            for (let index = 0; index + 1 < boundaries.length; index++) {
                if (from + boundaries[index]! >= high || from + boundaries[index + 1]! <= low) continue;
                const g = glyph(index); for (const candidate of [g.start, g.end]) if (!best || direction * candidate.left > direction * best.left
                    || candidate.left === best.left && direction * flow * candidate.offset > direction * flow * best.offset) best = candidate;
            } return best ?? point(direction < 0 ? Math.max(from, low) : Math.min(from + text.length, high))!;
        } });
}
