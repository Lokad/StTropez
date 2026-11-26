import type { DocumentSnapshot, BufferChangeSpan, DiscoveredFold } from "../../src/index.ts";
import type { InlineDecoration, PresentedLine } from "../../src/browser/index.ts";
import { DemoSyntaxColors } from "./syntax-colors.ts";
import { DemoEditingRules } from "./editing-rules.ts";
import type { SyntaxOptions } from "./syntax.ts";
import type { SyntaxRequest, SyntaxResponse } from "./syntax-session.ts";

/** One worker for the active document. Immutable captures survive upload and asynchronous analysis. */
export class DemoPresentation {
    private worker: Worker | undefined;
    private timer: number | undefined;
    private job = 0;
    private synchronized: Readonly<{ capture: DocumentSnapshot; job: number }> | undefined;
    private unchanged: { prefix: number; suffix: number } | undefined;
    private uploading: number | undefined;
    private emit: boolean;
    private capture: DocumentSnapshot | undefined;
    private foldRanges: readonly DiscoveredFold[] | undefined;
    private readonly waiting = new Set<() => void>();
    private plain = false;
    private readonly colors = new DemoSyntaxColors();
    readonly editing = new DemoEditingRules();
    private disposed = false;
    javascript = "";
    status: "starting" | "pending" | "ready" | "failed" = "starting";
    private readonly changed: () => void;
    private readonly options: SyntaxOptions;
    constructor(changed: () => void, options: SyntaxOptions = {}) {
        this.changed = changed;
        this.options = options;
        this.emit = options.emit !== false;
        this.start();
    }
    private notify(): void {
        for (const listener of [...this.waiting]) listener();
        if (!this.disposed) this.changed();
    }
    private start(): void {
        const worker = (this.worker = new Worker(new URL("demo-syntax-worker.js", document.baseURI), {
            type: "module"
        }));
        worker.addEventListener("message", (event: MessageEvent<SyntaxResponse>) => {
            const message = event.data;
            if (this.disposed || worker !== this.worker || message.job !== this.job || !this.capture) return;
            if (
                message.kind === "failed" ||
                !(message.spans instanceof Uint32Array) ||
                typeof message.javascript !== "string" ||
                !Array.isArray(message.folds)
            ) {
                this.fail();
                return;
            }
            this.colors.accept(this.capture!, message.spans);
            this.javascript = message.javascript;
            this.editing.accept(this.capture!.buffer, message.spans);
            this.foldRanges = Object.freeze(message.folds.map((range) => Object.freeze({ ...range })));
            this.status = "ready";
            this.notify();
        });
        worker.addEventListener("error", (event) => {
            event.preventDefault();
            if (!this.disposed && worker === this.worker) this.fail();
        });
    }
    private post(message: SyntaxRequest): void {
        this.worker!.postMessage(message);
    }
    private cancelWork(): void {
        if (this.timer !== undefined) window.clearTimeout(this.timer);
        this.timer = undefined;
        if (this.uploading !== undefined) {
            try {
                this.post({ job: this.uploading, kind: "cancel" });
            } catch {
                /* A failed worker will be replaced by retry. */
            }
            this.uploading = undefined;
        }
    }
    private fail(): void {
        this.cancelWork();
        this.status = "failed";
        this.notify();
    }
    /** Emission is a view demand; colors and editing rules continue while output is hidden. */
    setEmit(visible: boolean): void {
        const emit = visible && this.options.emit !== false;
        if (this.disposed || this.emit === emit) return;
        this.emit = emit;
        this.javascript = "";
        if (!this.capture || this.plain) return;
        if (!emit && this.status === "ready") this.notify();
        else this.schedule(this.capture, 0);
    }
    private schedule(capture: DocumentSnapshot, delay = 100): void {
        const job = ++this.job;
        this.cancelWork();
        if (this.status === "failed") {
            this.notify();
            return;
        }
        this.status = "pending";
        // Planning and serialization remain outside native input and decoration callbacks.
        this.timer = window.setTimeout(() => {
            this.timer = undefined;
            this.prepare(capture, job);
        }, delay);
        this.notify();
    }
    update(capture: DocumentSnapshot, plain = false): void {
        if (
            this.disposed ||
            (this.capture?.buffer === capture.buffer &&
                this.capture.id === capture.id &&
                this.capture.key === capture.key &&
                this.capture.revision === capture.revision &&
                this.plain === plain)
        )
            return;
        const previous = this.capture,
            change = capture.change;
        if (
            this.unchanged &&
            previous?.key === capture.key &&
            previous.id === capture.id &&
            change?.previousRevision === previous.revision
        ) {
            const edits = change.edits;
            if (edits.length) {
                this.unchanged.prefix = Math.min(this.unchanged.prefix, edits[0]!.from);
                this.unchanged.suffix = Math.min(
                    this.unchanged.suffix,
                    previous.buffer.length - edits[edits.length - 1]!.to
                );
            }
        } else this.unchanged = undefined;
        this.plain = plain;
        this.foldRanges = undefined;
        if (plain) {
            this.job++;
            this.cancelWork();
            this.synchronized = undefined;
            this.worker?.terminate();
            this.worker = undefined;
            this.capture = capture;
            this.colors.clear();
            this.editing.clear();
            this.javascript = "// This host outline has no JavaScript output.\n";
            this.foldRanges = Object.freeze([]);
            this.status = "ready";
            this.notify();
            return;
        }
        if (!this.worker) {
            this.status = "starting";
            this.start();
        }
        if (this.capture?.key !== capture.key) this.editing.clear();
        this.colors.update(capture);
        this.capture = capture;
        this.javascript = "";
        this.schedule(capture);
    }
    /** Review-only outlining shares the color worker and its exact immutable snapshot lifetime. */
    discoverFolds(capture: DocumentSnapshot, signal: AbortSignal): Promise<readonly DiscoveredFold[]> {
        if (!this.options.folds) return Promise.reject(new Error("Snapshot outlining is not enabled."));
        return new Promise((resolve, reject) => {
            const finish = () => {
                this.waiting.delete(check);
                signal.removeEventListener("abort", check);
            };
            const check = () => {
                if (
                    signal.aborted ||
                    this.disposed ||
                    this.capture?.key !== capture.key ||
                    this.capture.id !== capture.id ||
                    this.capture.revision !== capture.revision ||
                    this.capture.buffer !== capture.buffer
                ) {
                    finish();
                    reject(new Error("Snapshot outlining cancelled."));
                } else if (this.status === "failed") {
                    finish();
                    reject(new Error("Saved-copy analysis failed. Retry analysis to restore colors and folds."));
                } else if (this.foldRanges) {
                    finish();
                    resolve(this.foldRanges);
                }
            };
            this.waiting.add(check);
            signal.addEventListener("abort", check, { once: true });
            check();
        });
    }
    private prepare(capture: DocumentSnapshot, job: number): void {
        if (this.disposed || job !== this.job) return;
        const previous = this.synchronized;
        const edges = this.unchanged;
        if (!previous || !edges || previous.capture.key !== capture.key || previous.capture.id !== capture.id) {
            this.beginUpload(capture, job, { from: 0, to: 0, insertFrom: 0, insertTo: capture.buffer.length });
            return;
        }
        const from = edges.prefix,
            length = previous.capture.buffer.length;
        const suffix = Math.min(edges.suffix, length - from);
        this.beginUpload(
            capture,
            job,
            { from, to: length - suffix, insertFrom: from, insertTo: capture.buffer.length - suffix },
            previous.job
        );
    }
    private beginUpload(capture: DocumentSnapshot, job: number, span: BufferChangeSpan, base?: number): void {
        try {
            this.post({
                kind: "start",
                job,
                ...(base === undefined ? {} : { change: { base, from: span.from, to: span.to } })
            });
            this.uploading = job;
            this.upload(capture, job, span.insertFrom, span.insertTo);
        } catch {
            this.fail();
        }
    }
    private upload(capture: DocumentSnapshot, job: number, from: number, end: number): void {
        if (this.disposed || job !== this.job) return;
        try {
            const to = Math.min(end, from + 65536);
            if (to > from) this.post({ job, kind: "chunk", text: capture.buffer.slice(from, to) });
            if (to === end) {
                this.post({ job, kind: "finish", options: { ...this.options, emit: this.emit } });
                this.uploading = undefined;
                // Worker messages are ordered. The next delta may build on a queued finish,
                // even if its analysis reply is late or no longer belongs to the visible job.
                this.synchronized = { capture, job };
                this.unchanged = { prefix: capture.buffer.length, suffix: capture.buffer.length };
                return;
            }
            this.timer = window.setTimeout(() => {
                this.timer = undefined;
                this.upload(capture, job, to, end);
            }, 0);
        } catch {
            this.fail();
        }
    }
    readonly decorate = (line: PresentedLine): readonly InlineDecoration[] => this.colors.decorate(line);
    retry(): void {
        if (this.disposed || this.plain) return;
        this.cancelWork();
        this.synchronized = undefined;
        this.worker?.terminate();
        this.status = "starting";
        this.start();
        const capture = this.capture;
        this.capture = undefined;
        if (capture) this.update(capture, this.plain);
    }
    dispose(): void {
        this.disposed = true;
        this.job++;
        this.cancelWork();
        this.synchronized = undefined;
        this.worker?.terminate();
        this.worker = undefined;
        this.capture = undefined;
        this.colors.clear();
        this.editing.clear();
        this.foldRanges = undefined;
        this.notify();
    }
}
