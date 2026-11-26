import type { NavigationDestination } from "./navigation-controller.ts";

/** Read at most 112 UTF-16 units from the captured target line, keeping the start of the match visible. */
export function locationExcerpt(location: NavigationDestination) {
    const buffer = location.document.buffer;
    const line = buffer.lineAt(location.from), { from: start, to: end } = buffer.line(line);
    const offset = Math.min(location.from, end), from = Math.max(start, offset - 24), at = offset - from;
    const clipped = end - from > 112, excerpt = buffer.slice(from, Math.min(end, from + 112));
    const text = clipped ? excerpt.replace(/[\uD800-\uDBFF]$/u, "") : excerpt;
    const stop = Math.min(text.length, location.to - from);
    return { line: line + 1, column: offset - start + 1,
        before: (from > start ? "…" : "") + text.slice(0, at).replace(/^[\uDC00-\uDFFF]/u, "").trimStart(),
        match: text.slice(at, stop), after: text.slice(stop) + (clipped ? "…" : "") };
}
