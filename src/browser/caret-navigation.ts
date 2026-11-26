import type { Affinity } from "../core/positions.ts";
import type { Selection, SelectionSet } from "../core/selections.ts";
import type { BufferLine, TextBuffer } from "../core/text-buffer.ts";
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
    const cells = new Map<number, BufferLine | null>();
    const fixed = set.ranges.length > 1 && navigation.fixedPitch();
    let pageDelta = 0;

    // Short, printable ASCII rows share fixed-pitch geometry. Tabs and shaped text use the measured row.
    function fixedRow(line: number) {
        if (!fixed) return;
        let span = cells.get(line);
        if (span === undefined) {
            const row = buffer.line(line);
            span = row.to - row.from <= 512 && !/[^ -~]/.test(row.text) ? row : null;
            cells.set(line, span);
        }
        return span;
    }
    function columnAt(line: number, offset: number, affinity: Affinity | undefined) {
        const span = fixedRow(line);
        return span ? viewportPadding + (Math.min(span.to, offset) - span.from) * state.columnWidth
            : navigation.columnAt(offset, affinity);
    }
    function caretAt(line: number, column: number) {
        const span = fixedRow(line);
        if (!span) return navigation.caretAtColumn(line, column);
        const index = Math.round((column - viewportPadding) / state.columnWidth);
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
