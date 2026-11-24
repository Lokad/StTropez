import type { FindIndex } from "../core/find-index.ts";
import { clientBox } from "./dom-coordinates.ts";
import type { TextViewport } from "./viewport.ts";

/** Prefer text inside the viewport over a highlight clipped by its edge. */
export function visibleFindMatch(viewport: TextViewport, matches: FindIndex, preferred: number, foldedHeader?: number): number | undefined {
    viewport.flush();
    const root = viewport.element, box = clientBox(root, viewport.settings().minimap, viewport.getSnapshot().gutterWidth);
    let best: number | undefined, bestRank = Infinity;
    for (const row of root.querySelectorAll<HTMLElement>(".st-viewport-row")) {
        const bounds = row.getBoundingClientRect();
        if (bounds.bottom <= box.top || bounds.top >= box.bottom) continue;
        if (Number(row.dataset.line) === foldedHeader) return preferred;
        let offset = Number(row.dataset.from);
        for (const part of row.childNodes as NodeListOf<Text | HTMLElement>) {
            if ("classList" in part && part.classList.contains("st-search-match")) {
                const rect = part.getBoundingClientRect();
                if (rect.right >= box.left && rect.left < box.right) {
                    // A match can continue from the previous line or span several styled fragments.
                    const index = matches.firstIntersecting(offset);
                    if (index < matches.count) {
                        const inside = bounds.top >= box.top && bounds.bottom <= box.bottom && rect.left >= box.left && rect.right <= box.right;
                        const distance = (index - preferred + matches.count) % matches.count;
                        const rank = inside ? distance : matches.count + distance;
                        if (rank === 0) return index;
                        if (rank < bestRank) { bestRank = rank; best = index; }
                    }
                }
            }
            offset += part.textContent?.length ?? 0;
        }
    }
    return best;
}
