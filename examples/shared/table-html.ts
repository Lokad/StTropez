import { tableLimits, tsvTokens } from "./table-text.ts";
import type { TableToken } from "./table-text.ts";

const omitted = new Set(["script", "style", "template", "noscript", "iframe", "object", "embed"]),
    blocks = new Set(["p", "div", "li", "pre"]);
function* cellText(cell: Element): Generator<TableToken> {
    let node: Node | null = cell.firstChild,
        pendingBreak = false,
        last = "";
    while (node) {
        yield "tick";
        const tag = node.nodeType === 1 ? (node as Element).localName : "";
        if (node.nodeType === 3) {
            const text = node.nodeValue ?? "";
            if (
                pendingBreak &&
                text.length &&
                last &&
                last !== "\n" &&
                last !== "\r" &&
                text[0] !== "\n" &&
                text[0] !== "\r"
            ) {
                yield "\n";
                last = "\n";
            }
            pendingBreak = false;
            for (let i = 0; i < text.length; i++) {
                last = text[i]!;
                yield last;
            }
        } else if (tag === "br") {
            yield "\n";
            last = "\n";
            pendingBreak = false;
        } else if (blocks.has(tag)) pendingBreak = true;
        if (!omitted.has(tag) && node.firstChild) {
            node = node.firstChild;
            continue;
        }
        while (node && node !== cell) {
            if (node.nodeType === 1 && blocks.has((node as Element).localName)) pendingBreak = true;
            if (node.nextSibling) {
                node = node.nextSibling;
                break;
            }
            node = node.parentNode;
            yield "tick";
        }
        if (node === cell) node = null;
    }
}

/** The template stays detached/inert. Only text tokens leave it; all nodes are released. */
export function* htmlTableTokens(owner: Document, html: string, plain?: string): Generator<TableToken> {
    if (html.length > tableLimits.htmlUnits) throw new RangeError("HTML table exceeds 256 Ki UTF-16 units.");
    const template = owner.createElement("template");
    try {
        template.innerHTML = html;
        const tables = template.content.querySelectorAll("table");
        if (!tables.length && plain !== undefined) {
            yield* tsvTokens(plain);
            return;
        }
        if (tables.length !== 1) throw new RangeError("Paste one table without nested tables, or use literal paste.");
        const table = tables[0]!,
            rows = Array.from(table.rows);
        if (rows.length > tableLimits.rows) throw new RangeError("Table exceeds 10,000 rows.");
        const groupEnds: number[] = [];
        for (let start = 0; start < rows.length;) {
            let end = start + 1;
            while (end < rows.length && rows[end]!.parentElement === rows[start]!.parentElement) {
                end++;
                yield "tick";
            }
            for (let r = start; r < end; r++) {
                groupEnds[r] = end;
                yield "tick";
            }
            start = end;
        }
        const future = new Map<number, Map<number, HTMLTableCellElement | null>>();
        let slots = 0;
        for (let r = 0; r < rows.length; r++) {
            const source = rows[r]!,
                cells = future.get(r) ?? new Map<number, HTMLTableCellElement | null>();
            future.delete(r);
            let column = 0;
            for (const cell of Array.from(source.cells)) {
                while (cells.has(column)) {
                    column++;
                    yield "tick";
                }
                const width = cell.colSpan;
                const groupEnd = groupEnds[r]!;
                const height = cell.rowSpan === 0 ? groupEnd - r : Math.min(cell.rowSpan, groupEnd - r);
                if (column + width > tableLimits.columns) throw new RangeError("Table exceeds 1,024 columns.");
                for (let down = 0; down < height; down++) {
                    const target = down
                        ? (future.get(r + down) ?? new Map<number, HTMLTableCellElement | null>())
                        : cells;
                    if (down) future.set(r + down, target);
                    for (let across = 0; across < width; across++) {
                        if (target.has(column + across)) throw new RangeError("Table cells overlap.");
                        if (++slots > tableLimits.cells) throw new RangeError("Table exceeds 100,000 cells.");
                        target.set(column + across, !down && !across ? cell : null);
                        yield "tick";
                    }
                }
                column += width;
            }
            const width = cells.size ? Math.max(...cells.keys()) + 1 : 1;
            for (let c = 0; c < width; c++) {
                const cell = cells.get(c);
                if (cell) yield* cellText(cell);
                yield c + 1 < width ? "cell" : r + 1 < rows.length ? "row" : "end";
            }
        }
    } finally {
        template.content.replaceChildren();
    }
}
