import type { DocumentSnapshot, TextBuffer } from "../../src/index.ts";
import type { InlineDecoration, PresentedLine } from "../../src/browser/index.ts";

// Keep this small mapping separate from syntax.ts: the compiler must never enter the UI bundle.
const classes: Readonly<Record<number, string>> = { 1: "comment", 3: "keyword", 4: "number", 6: "string", 7: "string",
    11: "type", 12: "type", 13: "type", 14: "type", 15: "type", 16: "type", 18: "keyword", 24: "string", 25: "number" };
type Analysis = Readonly<{ job: number; kind: "result" | "failed"; spans?: Uint32Array; javascript?: string }>;

/** One worker for the active document. Immutable captures survive upload and asynchronous analysis. */
export class DemoPresentation {
    private worker: Worker | undefined;
    private timer: number | undefined;
    private job = 0;
    private capture: DocumentSnapshot | undefined;
    private spans: Uint32Array = new Uint32Array();
    private renderedRevision = -1;
    private disposed = false;
    search: Readonly<{ revision: number; ranges: readonly Readonly<{ from: number; to: number }>[] }> | undefined;
    diagnostics: Readonly<{ documentId: string; revision: number; ranges: readonly Readonly<{ from: number; to: number }>[] }> | undefined;
    javascript = "";
    status: "starting" | "pending" | "ready" | "failed" = "starting";
    private readonly changed: () => void;
    constructor(changed: () => void) { this.changed = changed; this.start(); }
    private start(): void {
        this.worker = new Worker(new URL("demo-syntax-worker.js", document.baseURI), { type: "module" });
        this.worker.addEventListener("message", (event: MessageEvent<Analysis>) => {
            const message = event.data;
            if (this.disposed || message.job !== this.job) return;
            if (message.kind === "failed" || !(message.spans instanceof Uint32Array) || typeof message.javascript !== "string") {
                this.status = "failed"; this.changed(); return;
            }
            this.spans = message.spans; this.javascript = message.javascript;
            this.renderedRevision = this.capture!.revision; this.status = "ready"; this.changed();
        });
        this.worker.addEventListener("error", event => { event.preventDefault(); if (!this.disposed) { this.status = "failed"; this.changed(); } });
    }
    update(capture: DocumentSnapshot): void {
        if (this.disposed || this.capture?.buffer === capture.buffer && this.capture.id === capture.id) return;
        this.capture = capture; this.spans = new Uint32Array(); this.javascript = ""; this.renderedRevision = -1;
        const job = ++this.job;
        if (this.timer !== undefined) window.clearTimeout(this.timer);
        if (this.status === "failed") { this.timer = undefined; this.changed(); return; }
        this.status = "pending";
        // Snapshot serialization is scheduled outside native input and decoration callbacks.
        this.timer = window.setTimeout(() => { this.timer = undefined; this.upload(capture.buffer, job, 0); }, 100);
        this.changed();
    }
    private upload(buffer: TextBuffer, job: number, from: number): void {
        if (this.disposed || job !== this.job) return;
        if (from === 0) this.worker?.postMessage({ job, kind: "start" });
        const to = Math.min(buffer.length, from + 65536);
        this.worker?.postMessage({ job, kind: "chunk", text: buffer.slice(from, to) });
        if (to === buffer.length) { this.worker?.postMessage({ job, kind: "finish" }); return; }
        this.timer = window.setTimeout(() => { this.timer = undefined; this.upload(buffer, job, to); }, 0);
    }
    readonly decorate = (line: PresentedLine): readonly InlineDecoration[] => {
        const result: InlineDecoration[] = [];
        if (line.documentId === this.capture?.id && line.revision === this.renderedRevision) {
            // Compiler spans are ordered triples. Query only those intersecting the visible fragment.
            let low = 0, high = this.spans.length / 3;
            while (low < high) { const mid = (low + high) >>> 1;
                if (this.spans[mid * 3]! + this.spans[mid * 3 + 1]! <= line.from) low = mid + 1; else high = mid; }
            for (let i = low * 3; i < this.spans.length && this.spans[i]! < line.to; i += 3) {
                const kind = classes[this.spans[i + 2]!];
                if (kind) result.push({ from: this.spans[i]!, to: this.spans[i]! + this.spans[i + 1]!, className: `demo-token-${kind}` });
            }
        }
        if (this.search?.revision === line.revision) for (const range of this.search.ranges) {
            if (range.from < line.to && range.to > line.from) result.push({ ...range, className: "demo-search" });
        }
        if (this.diagnostics?.documentId === line.documentId && this.diagnostics.revision === line.revision) for (const range of this.diagnostics.ranges) {
            if (range.from < line.to && range.to > line.from) result.push({ ...range, className: "demo-diagnostic" });
        }
        return result;
    };
    retry(): void {
        if (this.disposed) return;
        this.worker?.terminate(); this.status = "starting"; this.start();
        const capture = this.capture; this.capture = undefined; if (capture) this.update(capture);
    }
    dispose(): void {
        this.disposed = true; this.job++; if (this.timer !== undefined) window.clearTimeout(this.timer);
        this.worker?.terminate(); this.worker = undefined; this.capture = undefined; this.spans = new Uint32Array(); this.search = undefined; this.diagnostics = undefined;
    }
}
