import { anchoredRange } from "../../src/index.ts";
import type { DocumentSnapshot, PositionMapping, TextBuffer, Affinity } from "../../src/index.ts";
import type { InlineDecoration, PresentedLine } from "../../src/browser/index.ts";

// Compiler classifications stay in the worker; this host only presents its ordered triples.
const classes: Readonly<Record<number, string>> = { 1: "comment", 3: "keyword", 4: "number", 6: "string", 7: "string",
    11: "type", 12: "type", 13: "type", 14: "type", 15: "type", 16: "type", 18: "keyword", 24: "string", 25: "number" };

/** Last completed colors, provisionally mapped through public transactions until fresh analysis. */
export class DemoSyntaxColors {
    private id: string | undefined;
    private key: DocumentSnapshot["key"] | undefined;
    private revision = -1;
    private base: TextBuffer | undefined;
    private spans: Uint32Array = new Uint32Array();
    private mappings: PositionMapping[] = [];
    update(capture: DocumentSnapshot): void {
        // Document IDs/revisions are workspace-local; the immutable resource-key instance owns this capture.
        const same = this.id === capture.id && this.key === capture.key;
        if (same && this.revision === capture.revision) return;
        if (same && this.base === capture.buffer) this.mappings = []; // Exact undo to the analyzed buffer.
        else if (this.base && same && capture.change?.previousRevision === this.revision) this.mappings.push(capture.change.mapping);
        else this.clear();
        this.id = capture.id; this.key = capture.key; this.revision = capture.revision;
    }
    accept(capture: DocumentSnapshot, spans: Uint32Array): void {
        this.id = capture.id; this.key = capture.key; this.revision = capture.revision; this.base = capture.buffer;
        this.spans = spans; this.mappings = [];
    }
    private position(offset: number, affinity: Affinity): number {
        for (const mapping of this.mappings) offset = mapping.map(offset, affinity).offset;
        return offset;
    }
    decorate(line: PresentedLine): InlineDecoration[] {
        const result: InlineDecoration[] = [];
        if (line.documentId !== this.id || line.revision !== this.revision || !this.base) return result;
        // Mapping is lazy: neither an edit nor a row query walks every token in a large file.
        // Mapped ends remain ordered, including after large deletions that collapse many spans.
        let low = 0, high = this.spans.length / 3;
        while (low < high) {
            const middle = (low + high) >>> 1, at = middle * 3;
            if (this.position(this.spans[at]! + this.spans[at + 1]!, "before") <= line.from) low = middle + 1; else high = middle;
        }
        for (let at = low * 3; at < this.spans.length; at += 3) {
            if (this.position(this.spans[at]!, "after") >= line.to) break;
            const kind = classes[this.spans[at + 2]!]; if (!kind) continue;
            let range = anchoredRange(this.base.length, this.spans[at]!, this.spans[at]! + this.spans[at + 1]!, { onDelete: "invalidate" });
            for (const mapping of this.mappings) { const next = mapping.mapRange(range); if (!next) { range = { ...range, to: range.from }; break; } range = next; }
            if (range.from < range.to && range.from < line.to && range.to > line.from) result.push({ from: range.from, to: range.to, className: `demo-token-${kind}` });
        }
        return result;
    }
    clear(): void { this.id = undefined; this.key = undefined; this.revision = -1; this.base = undefined; this.spans = new Uint32Array(); this.mappings = []; }
}
