export function onPaintedSelection(root: HTMLElement, target: EventTarget | null): boolean {
    return target instanceof root.ownerDocument.defaultView!.Element && !!target.closest(".st-viewport-selected, .st-selection-run");
}

/** Resolve at hit time because hosts can move a mounted editor between trees. */
export function hitTestRoot(element: Element): DocumentOrShadowRoot {
    return element.isConnected ? element.getRootNode() as Document | ShadowRoot : element.ownerDocument;
}

/** CSS zoom scales client rectangles, while scrolling and inline styles keep local CSS units. */
export function cssZoom(element: Element): number {
    const value = element.currentCSSZoom;
    if (Number.isFinite(value) && value > 0) return value;
    // Older engines can implement zoom before exposing its effective value.
    let result = 1;
    for (let ancestor: Element | null = element; ancestor;) {
        result *= parseFloat(element.ownerDocument.defaultView!.getComputedStyle(ancestor).zoom) || 1;
        const root = ancestor.getRootNode();
        ancestor = ancestor.parentElement ?? ("host" in root ? (root as ShadowRoot).host : null);
    }
    return result;
}

export function minimapWidth(clientWidth: number): number {
    return Math.min(112, Math.floor(clientWidth * .18));
}

export function clientBox(element: HTMLElement, minimap = false, gutter = 0) {
    const zoom = cssZoom(element), rectangle = element.getBoundingClientRect();
    const left = rectangle.left + element.clientLeft * zoom, top = rectangle.top + element.clientTop * zoom;
    const width = element.clientWidth;
    return { left: left + gutter * zoom, top, right: left + (minimap ? width - minimapWidth(width) : width) * zoom, bottom: top + element.clientHeight * zoom, zoom };
}
