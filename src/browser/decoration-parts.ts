import type { InlineDecoration } from "./viewport.ts";

export type RowPart = Readonly<{ text: string; className: string }>;
type Boundary = { at: number; id: number; add: boolean };
const classes = new Set<string>();
export function validDecorationClass(name: string): boolean {
    if (typeof name !== "string" || name.length > 64) return false;
    if (classes.has(name)) return true;
    if (!/^[a-zA-Z][\w-]{0,63}$/.test(name)) return false;
    if (classes.size === 256) classes.clear();
    classes.add(name); return true;
}

/** Sweep intersecting boundaries; selections are already clipped to this row fragment.
 * Active ids retain host class order and duplicates, with selection styling last. */
export function decorationParts(text: string, from: number, to: number, length: number,
    decorations: readonly InlineDecoration[] | undefined, selections: readonly Readonly<{ from: number; to: number }>[]): RowPart[] {
    if (!decorations?.length && !selections.length) return [{ text, className: "" }];
    const names: string[] = [], events: Boundary[] = [];
    for (const range of decorations ?? []) {
        const start = range.from, end = range.to;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > length || start >= end
            || start >= to || end <= from) continue;
        const name = range.className; if (!validDecorationClass(name)) continue;
        const id = names.length; names.push(name);
        events.push({ at: Math.max(from, start), id, add: true }, { at: Math.min(to, end), id, add: false });
    }
    for (const range of selections) events.push({ at: range.from, id: -1, add: true }, { at: range.to, id: -1, add: false });
    events.sort((a, b) => a.at - b.at || a.id - b.id);
    const parts: RowPart[] = []; let active: number[] = [], cursor = from, index = 0, selected = 0;
    while (cursor < to) {
        const next: number[] = []; let prior = 0;
        // Merge all changes at this boundary in one pass. Individual array insertions or
        // removals would be quadratic when many overlapping ranges share an endpoint.
        while (events[index]?.at === cursor) {
            const event = events[index++]!;
            if (event.id < 0) { selected += event.add ? 1 : -1; continue; }
            while (prior < active.length && active[prior]! < event.id) next.push(active[prior++]!);
            if (event.add) next.push(event.id); else if (active[prior] === event.id) prior++;
        }
        while (prior < active.length) next.push(active[prior++]!);
        active = next;
        const end = Math.min(to, events[index]?.at ?? to), labels = active.map(id => names[id]!);
        if (selected) labels.push("st-viewport-selected");
        parts.push({ text: text.slice(cursor - from, end - from), className: labels.join(" ") }); cursor = end;
    }
    return parts;
}
