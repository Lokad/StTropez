import type { Affinity } from "../core/positions.ts";
import type { Selection, SelectionSet } from "../core/selections.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import { partitionPoint } from "../core/bound-search.ts";
import { viewportPadding, type MountedViewport, type ViewportSnapshot } from "./viewport.ts";

export type VisualColumns = Readonly<{ head: number | undefined; anchor?: number | undefined }>;

export function moved(range: Selection, offset: number, extend: boolean, affinity: Affinity = "after"): Selection {
    return {
        anchor: extend ? range.anchor : offset, head: offset,
        anchorAffinity: extend ? range.anchorAffinity ?? "after" : affinity, headAffinity: affinity,
    };
}

/** Compute one command’s destinations against its captured layout. The editor owns the commit. */
export function createVerticalMovement(navigation: MountedViewport["navigation"], state: ViewportSnapshot,
    buffer: TextBuffer, set: SelectionSet, direction: -1 | 1, page: boolean, extend: boolean, add: boolean,
    prior: readonly (VisualColumns | undefined)[] | undefined) {
    const columns: (VisualColumns | undefined)[] = [];
    const count = page && state.lineHeight > 0 ? Math.max(1, Math.floor(state.height / state.lineHeight) - 1) : 1;
    type CellRow = { from: number; to: number; stops?: number[] };
    const cells = new Map<number, CellRow | null>();
    const tabSize = set.ranges.length > 1 ? navigation.fixedTabSize() : undefined;
    let pageDelta = 0;

    // Only use the grid for single-cell text. Shaping, bidi and non-integral tab stops need layout.
    function fixedRow(line: number) {
        if (tabSize === undefined) return;
        let span = cells.get(line);
        if (span === undefined) {
            const row = buffer.line(line);
            span = null;
            if (row.to - row.from <= 512) {
                const text = row.text;
                const simple = !/[^\t -~]/.test(text) || !/[^\t -~\u00c0-\u024f]/.test(text)
                    && [...text].every(c => c <= "~" || navigation.singleCell(c));
                if (simple && !text.includes("\t")) span = row;
                else if (simple && Number.isSafeInteger(tabSize) && tabSize > 0) {
                    const stops = [0];
                    let cell = 0;
                    for (const c of text) {
                        cell += c === "\t" ? tabSize - cell % tabSize : 1;
                        stops.push(cell);
                    }
                    span = { from: row.from, to: row.to, stops };
                }
            }
            cells.set(line, span);
        }
        return span;
    }
    function columnAt(line: number, offset: number, affinity: Affinity | undefined) {
        const span = fixedRow(line);
        if (!span) return navigation.columnAt(offset, affinity);
        const index = Math.min(span.to, offset) - span.from;
        return viewportPadding + (span.stops?.[index] ?? index) * state.columnWidth;
    }
    function caretAt(line: number, column: number) {
        const span = fixedRow(line);
        if (!span) return navigation.caretAtColumn(line, column);
        const cell = (column - viewportPadding) / state.columnWidth;
        const { stops } = span;
        const index = stops ? partitionPoint(stops.length - 1, i => (stops[i]! + stops[i + 1]!) / 2 < cell)
            : Math.round(cell);
        const offset = Math.max(span.from, Math.min(span.to, span.from + index));
        const affinity: Affinity = offset === span.to && offset > span.from ? "before" : "after";
        return { offset, affinity };
    }
    function move(range: Selection): Selection {
        const at = columns.length;
        const line = buffer.lineAt(range.head);
        const next = navigation.navigationLine(line, direction, count, page);
        if (at === set.primary) pageDelta = (navigation.visualRowAt(next) - navigation.visualRowAt(line)) * state.lineHeight;
        if (next === line) {
            columns.push(prior?.[at]);
            return add ? range : moved(range, direction < 0 ? 0 : buffer.length, extend);
        }
        const previous = prior?.[at];
        const column = previous?.head ?? columnAt(line, range.head, range.headAffinity);
        const hit = column === undefined ? undefined : caretAt(next, column);
        // Both ends can clamp to the same caret on a short row. Keep their goals for the next copy.
        if (add && (range.head !== range.anchor || previous?.anchor !== undefined)) {
            const anchorLine = buffer.lineAt(range.anchor);
            const targetLine = navigation.navigationLine(anchorLine, direction, count, page);
            const anchor = previous?.anchor ?? columnAt(anchorLine, range.anchor, range.anchorAffinity);
            const anchorHit = anchor !== undefined && targetLine !== anchorLine ? caretAt(targetLine, anchor) : undefined;
            columns.push({ head: column, anchor });
            return hit && anchorHit ? {
                head: hit.offset, headAffinity: hit.affinity, anchor: anchorHit.offset, anchorAffinity: anchorHit.affinity,
            } : range;
        }
        columns.push({ head: column });
        return hit ? moved(range, hit.offset, extend, hit.affinity) : range;
    }
    return { move, columns, pageDelta: () => pageDelta };
}
