import type { DocumentSnapshot, TextBuffer } from "../../src/index.ts";
import type { InlineDecoration, PresentedLine } from "../../src/browser/index.ts";
import { DemoSyntaxColors } from "./syntax-colors.ts";
import { DemoEditingRules } from "./editing-rules.ts";

type Analysis = Readonly<{ job: number; kind: "result" | "failed"; spans?: Uint32Array; javascript?: string }>;

/** One worker for the active document. Immutable captures survive upload and asynchronous analysis. */
export class DemoPresentation {
    private worker: Worker | undefined;
    private timer: number | undefined;
    private job = 0;
    private capture: DocumentSnapshot | undefined;
    private plain = false;
    private readonly colors = new DemoSyntaxColors();
    readonly editing = new DemoEditingRules();
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
            this.colors.accept(this.capture!, message.spans); this.javascript = message.javascript;
            this.editing.accept(this.capture!.buffer, message.spans);
            this.status = "ready"; this.changed();
        });
        this.worker.addEventListener("error", event => { event.preventDefault(); if (!this.disposed) { this.status = "failed"; this.changed(); } });
    }
    update(capture: DocumentSnapshot, plain = false): void {
        if (this.disposed || this.capture?.buffer === capture.buffer && this.capture.id === capture.id && this.plain === plain) return;
        this.plain = plain;
        if (plain) {
            this.job++; if (this.timer !== undefined) window.clearTimeout(this.timer); this.timer = undefined;
            this.capture = capture; this.colors.clear(); this.editing.clear(); this.javascript = "// This host outline has no JavaScript output.\n";
            this.status = "ready"; this.changed(); return;
        }
        if (this.capture?.key !== capture.key) this.editing.clear();
        this.colors.update(capture); this.capture = capture; this.javascript = "";
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
        const result = this.colors.decorate(line);
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
        const capture = this.capture; this.capture = undefined; if (capture) this.update(capture, this.plain);
    }
    dispose(): void {
        this.disposed = true; this.job++; if (this.timer !== undefined) window.clearTimeout(this.timer);
        this.worker?.terminate(); this.worker = undefined; this.capture = undefined; this.colors.clear(); this.editing.clear(); this.search = undefined; this.diagnostics = undefined;
    }
}
