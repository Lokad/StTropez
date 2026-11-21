import type { InlineDecoration } from "./viewport.ts";

export type RowPart = Readonly<{ text: string; className: string; properties?: InlineDecoration["properties"];
    ornament?: "point" | "before" | "afterLine" | "fold"; label?: string }>;
type Boundary = { at: number; id: number; add: boolean };
const classes = new Set<string>();
export function applyDecorationProperties(element: HTMLElement, properties: InlineDecoration["properties"]): void {
    for (const [name, value] of Object.entries(properties ?? {}))
        if (/^--[\w-]+$/.test(name) && typeof value === "string") element.style.setProperty(name, value);
}
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
    decorations: readonly InlineDecoration[] | undefined, selections: readonly Readonly<{ from: number; to: number }>[], lineStart?: number): RowPart[] {
    if (!decorations?.length && !selections.length) return [{ text, className: "" }];
    const styles: InlineDecoration[] = [], events: Boundary[] = [];
    const marks = new Map<number, RowPart[]>(), annotations: RowPart[] = [];
    function mark(at: number, part: RowPart) {
        const list = marks.get(at);
        if (list) list.push(part);
        else { marks.set(at, [part]); events.push({ at, id: -2, add: true }); }
    }
    for (const range of decorations ?? []) {
        const start = range.from, end = range.to;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > length || start > end) continue;
        const name = range.className; if (!validDecorationClass(name)) continue;
        if (range.afterLine && lineStart !== undefined && end >= lineStart && end <= to) annotations.push({
            text: "", className: name, ornament: "afterLine", label: range.afterLine, properties: range.properties });
        if (start >= from && start <= to) {
            if (range.before && validDecorationClass(range.before)) mark(start, { text: "", className: range.before, ornament: "before", properties: range.properties });
            if (start === end) mark(start, { text: "", className: name, ornament: "point", properties: range.properties });
        }
        if (start === end || start >= to || end <= from) continue;
        const id = styles.length; styles.push(range);
        events.push({ at: Math.max(from, start), id, add: true }, { at: Math.min(to, end), id, add: false });
    }
    for (const range of selections) events.push({ at: range.from, id: -1, add: true }, { at: range.to, id: -1, add: false });
    events.sort((a, b) => a.at - b.at || a.id - b.id);
    const parts: RowPart[] = []; let active: number[] = [], cursor = from, index = 0, selected = 0;
    while (cursor < to) {
        const markers = marks.get(cursor); if (markers) for (const part of markers) parts.push(part);
        const next: number[] = []; let prior = 0;
        // Merge all changes at this boundary in one pass. Individual array insertions or
        // removals would be quadratic when many overlapping ranges share an endpoint.
        while (events[index]?.at === cursor) {
            const event = events[index++]!;
            if (event.id === -2) continue;
            if (event.id < 0) { selected += event.add ? 1 : -1; continue; }
            while (prior < active.length && active[prior]! < event.id) next.push(active[prior++]!);
            if (event.add) next.push(event.id); else if (active[prior] === event.id) prior++;
        }
        while (prior < active.length) next.push(active[prior++]!);
        active = next;
        const end = Math.min(to, events[index]?.at ?? to), labels: string[] = [];
        let properties: Record<`--${string}`, string> | undefined;
        for (const id of active) {
            const style = styles[id]!; labels.push(style.className);
            if (style.properties) Object.assign(properties ??= Object.create(null), style.properties);
        }
        if (selected) labels.push("st-viewport-selected");
        parts.push({ text: text.slice(cursor - from, end - from), className: labels.join(" "), ...(properties && { properties }) }); cursor = end;
    }
    for (const part of marks.get(to) ?? []) parts.push(part);
    for (const part of annotations) parts.push(part);
    return parts;
}
