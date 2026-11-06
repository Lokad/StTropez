/** Development oracle only. It deliberately lays out the entire supplied paragraph. */
export type ShapingBox = Readonly<{ left: number; right: number; top: number; bottom: number; width: number; height: number }>;
export type ShapingStyle = Readonly<{ font?: string; direction?: "ltr" | "rtl"; letterSpacing?: number; tabSize?: number; ligatures?: "normal" | "none" }>;

export function mountNativeShapingProbe(host: HTMLElement, text: string, options: ShapingStyle = {}) {
    const owner = host.ownerDocument, win = owner.defaultView!;
    if (!win || /[\n\r]/.test(text)) throw new Error("The shaping probe requires an attached document and one unwrapped paragraph.");
    const root = owner.createElement("div"), whole = owner.createElement("div"), fragment = owner.createElement("div"), canvas = owner.createElement("canvas");
    const context = canvas.getContext("2d"); if (!context) throw new Error("Canvas text measurement unavailable.");
    const began = win.performance.now(); let disposed = false, revision = 0;
    root.dataset.shapingProbe = "true"; root.setAttribute("aria-hidden", "true");
    root.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;visibility:hidden;pointer-events:none;contain:layout style paint";
    for (const element of [whole, fragment]) {
        element.style.cssText = "position:relative;display:table;white-space:pre;width:max-content;margin:0;padding:0;border:0;text-align:start";
        element.style.font = options.font ?? "24px Arial"; element.style.direction = options.direction ?? "ltr";
        element.style.fontKerning = "normal"; element.style.fontVariantLigatures = options.ligatures ?? "normal";
        element.style.letterSpacing = `${options.letterSpacing ?? 0}px`; element.style.tabSize = String(options.tabSize ?? 4);
    }
    const node = owner.createTextNode(text); whole.append(node); root.append(whole, fragment); host.append(root);
    const prepareMs = win.performance.now() - began, layoutStart = win.performance.now(), bounds = whole.getBoundingClientRect(), layoutMs = win.performance.now() - layoutStart;
    const style = win.getComputedStyle(whole);
    // The computed shorthand can be empty when longhands cannot serialize together.
    // Reconstruct the font dimensions used by these fixtures instead of accepting canvas's default.
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    if (!["normal", "100%"].includes(style.fontStretch) || style.fontVariantCaps !== "normal") { root.remove(); throw new Error("Probe canvas comparison requires normal stretch and capitals."); }
    context.font = font; context.direction = options.direction ?? "ltr"; context.fontKerning = "normal";
    if (!context.font.includes(style.fontSize)) { root.remove(); throw new Error("Canvas rejected the probe font."); }
    // Record the effective canvas setting; support varies and must not be assumed.
    const canvasLetterSpacingSupported = "letterSpacing" in context;
    if (canvasLetterSpacingSupported) context.letterSpacing = style.letterSpacing;
    const canvasStart = win.performance.now(), canvasWidth = context.measureText(text).width, canvasMs = win.performance.now() - canvasStart;
    const range = owner.createRange();
    const boxes = (start: Text, from: number, to: number, element: HTMLElement): readonly ShapingBox[] => {
        range.setStart(start, from); range.setEnd(start, to); const origin = element.getBoundingClientRect();
        return Object.freeze([...range.getClientRects()].map(rect => Object.freeze({ left: rect.left - origin.left, right: rect.right - origin.left,
            top: rect.top - origin.top, bottom: rect.bottom - origin.top, width: rect.width, height: rect.height })));
    };
    const initial = Object.freeze({ revision, units: text.length, prepareMs, layoutMs, canvasMs, nativeWidth: bounds.width, canvasWidth,
        style: Object.freeze({ font, computedFontShorthand: style.font, fontSize: style.fontSize, fontFamily: style.fontFamily, fontStretch: style.fontStretch,
            direction: style.direction, fontKerning: style.fontKerning, ligatures: style.fontVariantLigatures,
            letterSpacing: style.letterSpacing, tabSize: style.tabSize, canvasFont: context.font,
            canvasLetterSpacingSupported, canvasLetterSpacing: canvasLetterSpacingSupported ? context.letterSpacing : null, canvasLigatureControl: false }),
        domTextUnits: text.length, nativeTextNodes: 1 });
    return Object.freeze({ initial,
        query: (from: number, to: number, windowFrom: number, windowTo: number) => {
            if (disposed) throw new Error("Shaping probe is disposed.");
            if (![from, to, windowFrom, windowTo].every(Number.isSafeInteger) || windowFrom < 0 || windowFrom > from || from > to || to > windowTo || windowTo > text.length) throw new RangeError("Invalid shaping query.");
            const wholeStart = win.performance.now(), wholeBoxes = boxes(node, from, to, whole), wholeQueryMs = win.performance.now() - wholeStart;
            const fragmentStart = win.performance.now(), value = text.slice(windowFrom, windowTo); fragment.textContent = value;
            const fragmentNode = (fragment.firstChild ?? fragment.appendChild(owner.createTextNode(""))) as Text;
            const fragmentBoxes = boxes(fragmentNode, from - windowFrom, to - windowFrom, fragment);
            const fragmentMs = win.performance.now() - fragmentStart, prefixStart = win.performance.now(), prefixWidth = context.measureText(text.slice(0, windowFrom)).width, prefixMs = win.performance.now() - prefixStart;
            return Object.freeze({ revision, from, to, windowFrom, windowTo, wholeBoxes, fragmentBoxes, prefixWidth, wholeQueryMs, fragmentMs, prefixMs,
                domTextUnits: text.length + value.length, nativeTextNodes: 2 });
        },
        replace: (expectedRevision: number, from: number, to: number, insert: string) => {
            if (disposed) throw new Error("Shaping probe is disposed.");
            if (expectedRevision !== revision) return null;
            if (![from, to].every(Number.isSafeInteger) || from < 0 || from > to || to > text.length || /[\r\n]/.test(insert)) throw new RangeError("Invalid shaping replacement.");
            const start = win.performance.now(); node.replaceData(from, to - from, insert); text = node.data; revision++;
            const updateMs = win.performance.now() - start, layoutStart = win.performance.now(), rectangle = whole.getBoundingClientRect();
            return Object.freeze({ revision, units: text.length, updateMs, layoutMs: win.performance.now() - layoutStart, nativeWidth: rectangle.width, readbackUnits: text.length });
        },
        /** Sparse native observations exercise the retained index; they are not a complete glyph layout. */
        retainOrigins: (expectedRevision: number, ranges: readonly Readonly<{ from: number; to: number }>[]) => {
            if (disposed) throw new Error("Shaping probe is disposed."); if (expectedRevision !== revision) return null;
            if (ranges.length > 256) throw new RangeError("Capture at most 256 native observations.");
            const builder = createAdvanceBuilder(), samples = ranges.map(({ from, to }) => {
                if (![from, to].every(Number.isSafeInteger) || from < 0 || from >= to || to > text.length) throw new RangeError("Invalid native observation range.");
                const rectangles = boxes(node, from, to, whole); if (!rectangles.length) throw new Error("Native observation has no range rectangles.");
                return Object.freeze({ from, to, left: rectangles.reduce((left, rectangle) => Math.min(left, rectangle.left), Infinity), rectangles });
            });
            if (disposed || revision !== expectedRevision) { builder.dispose(); return null; }
            let previous = 0; builder.append(samples.map(sample => { const value = sample.left - previous; previous = sample.left; return value; }));
            const index = builder.finish(); builder.dispose();
            return Object.freeze({ revision, font: initial.style, samples: Object.freeze(samples), index });
        },
        snapshot: () => Object.freeze({ disposed, revision, domTextUnits: node.length + (fragment.textContent?.length ?? 0), nativeTextNodes: disposed ? 0 : 1 + fragment.childNodes.length }),
        dispose: () => { if (disposed) return; disposed = true; text = ""; node.data = ""; fragment.replaceChildren(); root.remove(); range.detach(); }
    });
}
import { createAdvanceBuilder } from "../src/index.ts";

