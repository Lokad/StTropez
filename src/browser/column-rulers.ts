import { isPositiveInteger } from "../core/bounds.ts";
const empty: readonly number[] = Object.freeze([]);

/** A ruler after N measured columns; normalization owns the caller's array. */
export function resolveColumnRulers(columns: readonly number[] = empty): readonly number[] {
    if (columns.length > 128 || Array.from(columns).some(column => !isPositiveInteger(column))) {
        throw new RangeError("Column rulers require at most 128 positive safe-integer columns.");
    }
    return columns.length ? Object.freeze([...new Set(columns)].sort((a, b) => a - b)) : empty;
}

/** Paint-only child of the viewport's existing clipped layer. Owns no measurement or listeners. */
export function mountColumnRulers(layer: HTMLElement, padding: number) {
    let element: HTMLDivElement | undefined;
    let painted: Readonly<{ columns: readonly number[]; columnWidth: number; left: number; width: number }> | undefined;
    const nodes = new Map<number, HTMLDivElement>();
    const clear = () => { element?.remove(); element = undefined; nodes.clear(); painted = undefined; };
    return Object.freeze({ clear,
        paint: (columns: readonly number[], columnWidth: number, left: number, width: number) => {
            if (!columns.length) { if (element) clear(); return; }
            if (painted?.columns === columns && painted.columnWidth === columnWidth && painted.left === left && painted.width === width) return;
            painted = { columns, columnWidth, left, width };
            if (!element) {
                element = layer.ownerDocument.createElement("div"); element.className = "st-column-rulers";
                element.setAttribute("aria-hidden", "true"); layer.append(element);
            }
            const visible = new Set<number>();
            for (const column of columns) {
                const x = padding + column * columnWidth - left; if (x < 0 || x >= width) continue;
                visible.add(column); let node = nodes.get(column);
                if (!node) { node = layer.ownerDocument.createElement("div"); node.className = "st-column-ruler"; node.dataset.column = String(column); element.append(node); nodes.set(column, node); }
                const position = `${x}px`; if (node.style.left !== position) node.style.left = position;
            }
            for (const [column, node] of nodes) if (!visible.has(column)) { node.remove(); nodes.delete(column); }
        },
    });
}
