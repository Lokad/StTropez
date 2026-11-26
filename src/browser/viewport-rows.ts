import { unchangedPositionEdges } from "../core/positions.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";
import { editorElement } from "./editor-element.ts";

type Span = Readonly<{ start: number; end: number }>;
type Row = Span & Readonly<{ line: number }>;

/** Keep the DOM node for a visible source row when an edit moves it to another line. */
export function viewportRows(layer: HTMLDivElement) {
    const elements = new Map<number, HTMLDivElement>();
    const sources = new Map<HTMLDivElement, Span>();
    let sourceRevision: number | null = null;

    function advance(document: DocumentSnapshot | undefined): void {
        if (document?.revision === sourceRevision) return;
        const change = document?.change;
        if (!change || change.previousRevision !== sourceRevision) {
            sources.clear();
        } else {
            const mapping = change.mapping;
            const edges = unchangedPositionEdges(mapping);
            const delta = mapping.newLength - mapping.oldLength;
            for (const [element, { start, end }] of sources) {
                if (edges && start < edges.prefix && end <= edges.prefix) continue;
                if (edges && start >= mapping.oldLength - edges.suffix) {
                    if (delta) sources.set(element, { start: start + delta, end: end + delta });
                    continue;
                }
                // An empty row owns its terminator. Deleting it must retire the correct node.
                const mapped = mapping.mapRange({
                    from: start, to: Math.min(mapping.oldLength, Math.max(end, start + 1)),
                    fromAffinity: "after", toAffinity: "before", onDelete: "invalidate",
                });
                if (mapped) sources.set(element, { start: mapped.from, end: start === end ? mapped.from : mapped.to });
                else sources.delete(element);
            }
        }
        sourceRevision = document?.revision ?? null;
    }

    function retain(document: DocumentSnapshot, next: readonly Row[], paintedRevision: number | null): boolean {
        // A host can flush before this viewport receives its document notification.
        advance(document);
        if (paintedRevision === document.revision || !elements.size) return false;
        const targets = new Map(next.map(row => [row.start, row]));
        const retained = new Map<number, HTMLDivElement>();
        const used = new Set<HTMLDivElement>();
        for (const [element, span] of sources) {
            const row = targets.get(span.start);
            if (!row || row.end !== span.end || retained.has(row.line)) continue;
            retained.set(row.line, element);
            used.add(element);
        }
        // Reserve unchanged source rows before recycling a node at its old line number.
        for (const { line } of next) {
            const element = elements.get(line);
            if (!element || retained.has(line) || used.has(element)) continue;
            retained.set(line, element);
            used.add(element);
        }
        for (const element of elements.values()) {
            if (!used.has(element)) remove(element);
        }
        elements.clear();
        for (const [line, element] of retained) elements.set(line, element);
        return true;
    }

    function forLine(line: number): HTMLDivElement {
        let element = elements.get(line);
        if (!element) {
            element = editorElement(layer.ownerDocument, "div", "viewport-row");
            elements.set(line, element);
            layer.append(element);
        }
        return element;
    }

    function painted(element: HTMLDivElement, row: Row): void {
        sources.set(element, row);
    }

    function finish(next: readonly Row[], revision: number, dropGeometry: (line: number) => void): void {
        const visible = new Set(next.map(row => row.line));
        for (const [line, element] of elements) {
            if (visible.has(line)) continue;
            remove(element);
            elements.delete(line);
            dropGeometry(line);
        }
        next.forEach(({ line }, index) => {
            const element = elements.get(line)!;
            const existing = layer.children.item(index);
            if (existing !== element) layer.insertBefore(element, existing);
        });
        sourceRevision = revision;
    }

    function remove(element: HTMLDivElement): void {
        element.remove();
        sources.delete(element);
    }

    function clear(): void {
        layer.replaceChildren();
        elements.clear();
        sources.clear();
        sourceRevision = null;
    }
    return { elements, advance, retain, forLine, painted, finish, clear };
}
