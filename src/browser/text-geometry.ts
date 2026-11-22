import { graphemeBoundaries } from "../core/graphemes.ts";
import { partitionPoint } from "../core/bound-search.ts";
import type { Affinity } from "../core/positions.ts";

export type CaretRectangle = Readonly<{ offset: number; affinity: Affinity; left: number; top: number; height: number; revision: number; padding?: true }>;
export { graphemeBoundaries };
/** Resolve source offsets within a painted row, skipping ornaments without source text. */
export function rowTextRanges(element: HTMLElement) {
    const nodes: Text[] = [], owner = element.ownerDocument;
    const iterator = owner.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = iterator.nextNode(); node; node = iterator.nextNode()) nodes.push(node as Text);
    let nativeRange: Range | undefined;
    const hasMarkers = element.querySelector('[data-ornament="before"]') !== null;
    const locate = (offset: number, after = false): Readonly<{ node: Text; offset: number }> | undefined => {
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i]!;
            if (offset < node.length || offset === node.length && (!after || i === nodes.length - 1)) return { node, offset };
            offset -= node.length;
        }
        return undefined;
    };
    const range = (start: number, end: number, after = false): Range | undefined => {
        // A swatch between text nodes takes up space but owns no source offsets. Measure
        // a glyph from its own text node and retain both caret edges around the swatch.
        const a = locate(start, hasMarkers && (start < end || after)), b = start === end ? a : locate(end); if (!a || !b) return;
        const value = nativeRange ??= owner.createRange(); value.setStart(a.node, a.offset); value.setEnd(b.node, b.offset); return value;
    };
    return { nodes, hasMarkers, range };
}
/** Native range geometry for grapheme clusters on a left-to-right row. */
export function rowGeometry(element: HTMLElement, from: number, revision: number, lineHeight: number) {
    const text = element.textContent ?? "", boundaries = graphemeBoundaries(text), owner = element.ownerDocument;
    const { nodes, hasMarkers, range } = rowTextRanges(element);
    const styled = [element, ...new Set(nodes.map(node => node.parentElement!).filter(parent => parent !== element))];
    type Glyph = Readonly<{ start: CaretRectangle; end: CaretRectangle; nativeStart: boolean; nativeEnd: boolean }>;
    let bounds: DOMRect | undefined, glyphs = new Map<number, Glyph>(), boxes = new Map<number, readonly DOMRect[]>(), raw = new Map<number, readonly DOMRect[]>(), styleKey = "", prepared = false;
    const corrected = new Set<number>();
    const ensure = () => {
        const next = element.getBoundingClientRect(), style = owner.defaultView!.getComputedStyle(element);
        // Inline typography can change while the row's outer dimensions stay identical.
        const key = styled.map(node => {
            const value = node === element ? style : owner.defaultView!.getComputedStyle(node);
            return [value.font, value.letterSpacing, value.wordSpacing, value.fontVariantLigatures, value.fontKerning,
                value.fontFeatureSettings, value.fontVariationSettings, value.tabSize, value.textAlign, value.textTransform, value.verticalAlign].join("|");
        }).join("\n");
        if (bounds && key === styleKey && next.left === bounds.left && next.top === bounds.top && next.width === bounds.width && next.height === bounds.height) return;
        styleKey = key;
        bounds = next; glyphs = new Map(); boxes = new Map(); raw = new Map(); prepared = false; corrected.clear();
    };
    const collapsed = (offset: number): readonly DOMRect[] => {
        let result = raw.get(offset);
        if (!result) {
            result = [...range(offset, offset)?.getClientRects() ?? []];
            if (hasMarkers) result = [...result, ...range(offset, offset, true)?.getClientRects() ?? []];
            raw.set(offset, result);
        }
        return result;
    };
    const measured = (index: number): readonly DOMRect[] => {
        let result = boxes.get(index); if (result) return result;
        const start = boundaries[index]!, end = boundaries[index + 1]!;
        result = [...range(start, end)?.getClientRects() ?? []].filter(rect => rect.width > .01 && rect.height > 0);
        boxes.set(index, result); return result;
    };
    const make = (offset: number, affinity: Affinity, left: number, top: number, height: number): CaretRectangle => Object.freeze({ offset: from + offset, affinity, left, top, height: height || lineHeight, revision });
    const glyph = (index: number): Glyph => {
        let value = glyphs.get(index); if (value) return value;
        const start = boundaries[index]!, end = boundaries[index + 1]!, rectangles = measured(index);
        if (rectangles.length) {
            const left = Math.min(...rectangles.map(r => r.left)), right = Math.max(...rectangles.map(r => r.right)), top = Math.min(...rectangles.map(r => r.top)), bottom = Math.max(...rectangles.map(r => r.bottom));
            const closest = (values: readonly DOMRect[], x: number) => values.reduce<DOMRect | undefined>((best, next) => !best || Math.abs(next.left - x) < Math.abs(best.left - x) ? next : best, undefined);
            const a = closest(collapsed(start), left), b = closest(collapsed(end), right);
            const inside = (rect: DOMRect | undefined) => rect && rect.left >= left - 1.5 && rect.left <= right + 1.5;
            // Native caret interiors preserve ligature subdivisions when both endpoints agree with the run direction.
            const consistent = inside(a) && inside(b) && a!.left < b!.left;
            // WebKit rounds a collapsed range at a span boundary to an integer pixel. A
            // color-only span around a bidi control must not change which cluster wins a hit.
            // Keep measured glyph edges there, and use native interior stops for ligatures.
            const nativeStart = !!consistent && Math.abs(a!.left - left) > 1.5;
            const nativeEnd = !!consistent && Math.abs(b!.left - right) > 1.5;
            value = { start: make(start, "after", nativeStart ? a!.left : left, top, bottom - top), end: make(end, "before", nativeEnd ? b!.left : right, top, bottom - top), nativeStart, nativeEnd };
        } else {
            let before = index - 1, after = index + 1;
            while (before >= 0 && !measured(before).length) before--; while (after + 1 < boundaries.length && !measured(after).length) after++;
            // Invisible glyphs copy logical neighbors. Correct those visible edges before caching
            // a fallback, just as full preparation does before filling its invisible glyphs.
            if (before >= 0) correctVisible(before); if (after + 1 < boundaries.length) correctVisible(after);
            const previous = before >= 0 ? glyph(before).end : undefined, next = after + 1 < boundaries.length ? glyph(after).start : undefined;
            const a = previous ?? next, b = next ?? previous;
            value = { start: make(start, "after", a?.left ?? bounds!.left, a?.top ?? bounds!.top, a?.height ?? lineHeight), end: make(end, "before", b?.left ?? bounds!.left, b?.top ?? bounds!.top, b?.height ?? lineHeight), nativeStart: false, nativeEnd: false };
        }
        glyphs.set(index, value); return value;
    };
    const merge = (ai: number, bi: number) => {
        // Two adjacent visible clusters share one insertion position. Native rectangle rounding
        // must not create an extra caret stop; never merge the two edges of a narrow glyph.
        const a = glyph(ai), b = glyph(bi), ap = a.end, bp = b.start;
        if (Math.abs(ap.left - bp.left) > 1.5 || Math.abs(ap.top - bp.top) > 1) return;
        const an = a.nativeEnd, bn = b.nativeStart;
        const x = an === bn ? (ap.left + bp.left) / 2 : an ? ap.left : bp.left;
        glyphs.set(ai, { ...a, end: Object.freeze({ ...ap, left: x }) }); glyphs.set(bi, { ...b, start: Object.freeze({ ...bp, left: x }) });
    };
    function correctVisible(index: number): void {
        if (prepared || corrected.has(index)) return;
        // Each pair touches only its facing edges. Other pairs cannot change those edges;
        // repeating a merge is idempotent, including when full preparation follows a point.
        for (const direction of [-1, 1]) {
            let next = index + direction;
            while (next >= 0 && next + 1 < boundaries.length && !measured(next).length) next += direction;
            if (next >= 0 && next + 1 < boundaries.length) merge(direction < 0 ? next : index, direction < 0 ? index : next);
        }
        corrected.add(index);
    }
    const prepare = () => {
        ensure(); if (prepared) return;
        let previous = -1;
        for (let index = 0; index + 1 < boundaries.length; index++) if (measured(index).length) {
            glyph(index);
            if (previous >= 0) merge(previous, index);
            previous = index;
        }
        prepared = true;
        for (let index = 0; index + 1 < boundaries.length; index++) glyph(index);
    };
    const point = (offset: number, affinity: Affinity = "after"): CaretRectangle | undefined => {
        const local = offset - from; if (local < 0 || local > text.length) return;
        const low = partitionPoint(boundaries.length, index => boundaries[index]! < local);
        const index = boundaries[low] === local || affinity === "after" ? low : Math.max(0, low - 1);
        if (boundaries.length === 1) return make(0, affinity, bounds!.left, bounds!.top, lineHeight);
        const end = index === boundaries.length - 1 || affinity === "before" && index > 0, at = end ? index - 1 : index;
        if (measured(at).length) correctVisible(at);
        const selected = glyph(at)[end ? "end" : "start"];
        return Object.freeze({ ...selected, affinity });
    };
    return Object.freeze({ point: (offset: number, affinity: Affinity = "after") => { ensure(); return point(offset, affinity); },
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
        visual: (offset: number, direction: -1 | 1): CaretRectangle | undefined => {
            ensure();
            const local = offset - from;
            const next = direction < 0 ? partitionPoint(boundaries.length, i => boundaries[i]! < local) - 1
                : partitionPoint(boundaries.length, i => boundaries[i]! <= local);
            if (next < 0 || next >= boundaries.length) return;
            return point(from + boundaries[next]!, direction < 0 ? "after" : "before");
        },
        edge: (direction: -1 | 1, low = from, high = from + text.length): CaretRectangle => {
            ensure();
            return point(direction < 0 ? Math.max(from, low) : Math.min(from + text.length, high), direction < 0 ? "after" : "before")!;
        } });
}
