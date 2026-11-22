import type { FindIndex } from "../core/find-index.ts";
import { clientBox } from "./dom-coordinates.ts";
import type { TextViewport } from "./viewport.ts";

/** Inspect only painted fragments. Folded and horizontally clipped matches cannot win. */
export function visibleFindMatch(viewport: TextViewport, matches: FindIndex, preferred: number): number | undefined {
    viewport.flush();
    const root = viewport.element, box = clientBox(root, viewport.settings().minimap, viewport.getSnapshot().gutterWidth);
    let first: number | undefined, after: number | undefined;
    for (const row of root.querySelectorAll<HTMLElement>(".st-viewport-row")) {
        const bounds = row.getBoundingClientRect();
        if (bounds.bottom <= box.top || bounds.top >= box.bottom) continue;
        let offset = Number(row.dataset.from);
        for (const part of row.childNodes) {
            if (part instanceof root.ownerDocument.defaultView!.HTMLElement && part.classList.contains("st-search-match")) {
                const rect = part.getBoundingClientRect();
                if (rect.right >= box.left && rect.left < box.right) {
                    let index = matches.lowerBound(offset);
                    // A match can continue from the previous line or span several styled fragments.
                    if (index > 0 && matches.at(index - 1).to > offset) index--;
                    if (index === preferred) return index;
                    if (index < matches.count) {
                        if (first === undefined || index < first) first = index;
                        if (index > preferred && (after === undefined || index < after)) after = index;
                    }
                }
            }
            offset += part.textContent?.length ?? 0;
        }
    }
    return after ?? first;
}
