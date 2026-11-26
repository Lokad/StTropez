import type { NavigationChoice, NavigationResult } from "../../src/browser/index.ts";

export type NavigationPage = Readonly<{
    count: number; first: number; locations: readonly NavigationChoice[]; selected: NavigationChoice;
    previousPage: (() => NavigationPage) | null; nextPage: (() => NavigationPage) | null;
    moveSelection: (direction: -1 | 1) => NavigationPage;
}>;

const navigationPageSize = 64;

export function locationPage({ count, locationAt }: NavigationResult, index = 0): NavigationPage | undefined {
    function buildPage(index: number, preferredRow = index % navigationPageSize): NavigationPage {
        const first = index - index % navigationPageSize, end = Math.min(first + navigationPageSize, count);
        const locations = Object.freeze(Array.from({ length: end - first }, (_, row) => locationAt(first + row)!));
        function select(at: number, row: number): NavigationPage {
            return Object.freeze({ count, first, locations, selected: locations[at - first]!,
                previousPage: first > 0 ? () => buildPage(first - navigationPageSize + row, row) : null,
                nextPage: end < count ? () => buildPage(Math.min(end + row, count - 1), row) : null,
                moveSelection(direction: -1 | 1) {
                    if (direction !== -1 && direction !== 1) throw new RangeError("Expected a navigation direction of -1 or 1.");
                    const next = (at + direction + count) % count;
                    return next >= first && next < end ? select(next, next - first) : buildPage(next);
                } });
        }
        return select(index, preferredRow);
    }
    return Number.isSafeInteger(index) && index >= 0 && index < count ? buildPage(index) : undefined;
}
