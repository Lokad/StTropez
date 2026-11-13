import type { DocumentSnapshot, TextBuffer, DiscoveredFold } from "../../src/index.ts";
import type { InlineDecoration, PresentedLine } from "../../src/browser/index.ts";
import { DemoSyntaxColors } from "./syntax-colors.ts";
import { DemoEditingRules } from "./editing-rules.ts";
import type { SyntaxOptions } from "./syntax.ts";

type Analysis = Readonly<{ job: number; kind: "result" | "failed"; spans?: Uint32Array; javascript?: string; folds?: readonly DiscoveredFold[] }>;

/** One worker for the active document. Immutable captures survive upload and asynchronous analysis. */
export class DemoPresentation {
    private worker: Worker | undefined;
    private timer: number | undefined;
    private job = 0;
    private capture: DocumentSnapshot | undefined;
    private foldRanges: readonly DiscoveredFold[] | undefined;
    private readonly waiting = new Set<() => void>();
    private plain = false;
    private readonly colors = new DemoSyntaxColors();
    readonly editing = new DemoEditingRules();
    private disposed = false;
    search: Readonly<{ revision: number; ranges: readonly Readonly<{ from: number; to: number }>[] }> | undefined;
    diagnostics: Readonly<{ documentId: string; revision: number; ranges: readonly Readonly<{ from: number; to: number }>[] }> | undefined;
    javascript = "";
    status: "starting" | "pending" | "ready" | "failed" = "starting";
    private readonly changed: () => void;
    private readonly options: SyntaxOptions;
    constructor(changed: () => void, options: SyntaxOptions = {}) { this.changed = changed; this.options = options; this.start(); }
    private notify(): void { for (const listener of [...this.waiting]) listener(); if (!this.disposed) this.changed(); }
    private start(): void {
        this.worker = new Worker(new URL("demo-syntax-worker.js", document.baseURI), { type: "module" });
        this.worker.addEventListener("message", (event: MessageEvent<Analysis>) => {
            const message = event.data;
            if (this.disposed || message.job !== this.job) return;
            if (message.kind === "failed" || !(message.spans instanceof Uint32Array) || typeof message.javascript !== "string" || !Array.isArray(message.folds)) {
                this.status = "failed"; this.notify(); return;
            }
            this.colors.accept(this.capture!, message.spans); this.javascript = message.javascript;
            this.editing.accept(this.capture!.buffer, message.spans);
            this.foldRanges = Object.freeze(message.folds.map(range => Object.freeze({ ...range })));
            this.status = "ready"; this.notify();
        });
        this.worker.addEventListener("error", event => { event.preventDefault(); if (!this.disposed) { this.status = "failed"; this.notify(); } });
    }
    update(capture: DocumentSnapshot, plain = false): void {
        if (this.disposed || this.capture?.buffer === capture.buffer && this.capture.id === capture.id && this.plain === plain) return;
        this.plain = plain;
        this.foldRanges = undefined;
        if (plain) {
            this.job++; if (this.timer !== undefined) window.clearTimeout(this.timer); this.timer = undefined;
            this.capture = capture; this.colors.clear(); this.editing.clear(); this.javascript = "// This host outline has no JavaScript output.\n";
            this.foldRanges = Object.freeze([]); this.status = "ready"; this.notify(); return;
        }
        if (this.capture?.key !== capture.key) this.editing.clear();
        this.colors.update(capture); this.capture = capture; this.javascript = "";
        const job = ++this.job;
        if (this.timer !== undefined) window.clearTimeout(this.timer);
        if (this.status === "failed") { this.timer = undefined; this.notify(); return; }
        this.status = "pending";
        // Snapshot serialization is scheduled outside native input and decoration callbacks.
        this.timer = window.setTimeout(() => { this.timer = undefined; this.upload(capture.buffer, job, 0); }, 100);
        this.notify();
    }
    /** Review-only outlining shares the color worker and its exact immutable snapshot lifetime. */
    discoverFolds(capture: DocumentSnapshot, signal: AbortSignal): Promise<readonly DiscoveredFold[]> {
        if (!this.options.folds) return Promise.reject(new Error("Snapshot outlining is not enabled."));
        return new Promise((resolve, reject) => {
            const finish = () => { this.waiting.delete(check); signal.removeEventListener("abort", check); };
            const check = () => {
                if (signal.aborted || this.disposed || this.capture?.key !== capture.key || this.capture.id !== capture.id
                    || this.capture.revision !== capture.revision || this.capture.buffer !== capture.buffer) {
                    finish(); reject(new Error("Snapshot outlining cancelled."));
                } else if (this.status === "failed") { finish(); reject(new Error("Saved-copy analysis failed. Retry analysis to restore colors and folds.")); }
                else if (this.foldRanges) { finish(); resolve(this.foldRanges); }
            };
            this.waiting.add(check); signal.addEventListener("abort", check, { once: true }); check();
        });
    }
    private upload(buffer: TextBuffer, job: number, from: number): void {
        if (this.disposed || job !== this.job) return;
        if (from === 0) this.worker?.postMessage({ job, kind: "start" });
        const to = Math.min(buffer.length, from + 65536);
        this.worker?.postMessage({ job, kind: "chunk", text: buffer.slice(from, to) });
        if (to === buffer.length) { this.worker?.postMessage({ job, kind: "finish", options: this.options }); return; }
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
        this.foldRanges = undefined; this.notify();
    }
}
