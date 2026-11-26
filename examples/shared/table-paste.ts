import type { DocumentId } from "../../src/index.ts";
import type { CapturedInsertion, TextEditor } from "../../src/browser/index.ts";
import { HostCell } from "./observable.ts";
import { TableTextFormatter, tableLimits, tsvTokens } from "./table-text.ts";
import { htmlTableTokens } from "./table-html.ts";

type Session = { id: string; editor: TextEditor };
type Job = {
    session: Session;
    insertion: CapturedInsertion;
    plain: string;
    html: string;
    formatter?: TableTextFormatter;
    timer?: number;
    started: number;
};
export type TablePasteSnapshot = Readonly<{
    enabled: boolean;
    status: "idle" | "converting" | "applied" | "cancelled" | "failed";
    view: string | null;
    work: number;
    outputUnits: number;
    rows: number;
    columns: number;
    message: string;
}>;

/** Optional host policy. Clipboard bytes/targets are captured synchronously; only this lane commits. */
export class HostTablePaste {
    private readonly sessions = new Map<string, Session>();
    private readonly cell: HostCell<TablePasteSnapshot>;
    private job: Job | undefined;
    private lastHostPasteMs = 0;
    private maxTurnMs = 0;
    private commitMs = 0;
    private elapsedMs = 0;
    readonly state;
    hasPendingInput(documentId: DocumentId): boolean {
        return this.job?.session.editor.view.documentId === documentId;
    }
    constructor() {
        this.cell = new HostCell<TablePasteSnapshot>({
            enabled: false,
            status: "idle",
            view: null,
            work: 0,
            outputUnits: 0,
            rows: 0,
            columns: 0,
            message: "Literal paste is active."
        });
        this.state = this.cell.observable;
    }
    readonly setEnabled = (enabled: boolean): void => {
        if (enabled === this.cell.get().enabled) return;
        this.cancel();
        this.cell.set({
            ...this.cell.get(),
            enabled,
            status: "idle",
            message: enabled ? "Paste a table to insert quoted CSV." : "Literal paste is active."
        });
    };
    private current(job: Job): boolean {
        return this.job === job && job.insertion.isCurrent();
    }
    private release(job: Job): void {
        if (job.timer !== undefined) job.session.editor.element.ownerDocument.defaultView!.clearTimeout(job.timer);
        job.formatter?.dispose();
        job.plain = "";
        job.html = "";
        job.insertion.cancel();
    }
    readonly cancel = (): void => {
        const job = this.job;
        if (!job) return;
        this.job = undefined;
        this.release(job);
        this.cell.set({
            ...this.cell.get(),
            status: "cancelled",
            message: "Table paste cancelled; no table was inserted."
        });
    };
    private fail(message: string): void {
        this.cancel();
        this.cell.set({ ...this.cell.get(), status: "failed", message });
    }
    /** Explicit host command using the same conversion and captured insertion as a paste event. */
    insertTable(id: string, plain: string, html = ""): void {
        const session = this.sessions.get(id);
        if (session) this.start(session, session.editor.captureInsertion(), plain, html);
    }
    private start(session: Session, insertion: CapturedInsertion | undefined, plain: string, html: string): void {
        this.cancel();
        if (!insertion) {
            this.fail("Finish pending input in an editable source before table paste.");
            return;
        }
        if (plain.length > tableLimits.textUnits || html.length > tableLimits.htmlUnits) {
            insertion.cancel();
            this.fail("Clipboard table exceeds the supported text/HTML size.");
            return;
        }
        const job: Job = {
            session,
            insertion,
            plain,
            html,
            started: session.editor.element.ownerDocument.defaultView!.performance.now()
        };
        this.job = job;
        this.maxTurnMs = this.commitMs = this.elapsedMs = 0;
        insertion.signal.addEventListener(
            "abort",
            () => {
                if (this.job === job) this.cancel();
            },
            { once: true }
        );
        this.cell.set({
            ...this.cell.get(),
            status: "converting",
            view: session.id,
            work: 0,
            outputUnits: 0,
            rows: 0,
            columns: 0,
            message: "Converting the captured table. Escape cancels."
        });
        this.schedule(job);
    }
    private schedule(job: Job): void {
        job.timer = job.session.editor.element.ownerDocument.defaultView!.setTimeout(() => {
            delete job.timer;
            this.step(job);
        }, 0);
    }
    private step(job: Job): void {
        if (this.job !== job) return;
        const win = job.session.editor.element.ownerDocument.defaultView!,
            began = win.performance.now();
        try {
            if (!this.current(job)) {
                this.cancel();
                return;
            }
            job.formatter ??= new TableTextFormatter(
                job.html
                    ? htmlTableTokens(job.session.editor.element.ownerDocument, job.html, job.plain)
                    : tsvTokens(job.plain)
            );
            const progress = job.formatter.advance();
            if (!progress.done) {
                this.cell.set({ ...this.cell.get(), work: progress.totalWork, outputUnits: progress.outputUnits });
                this.schedule(job);
                return;
            }
            const result = progress.result!;
            if (!this.current(job)) {
                this.cancel();
                return;
            }
            const inserted = result.text.length * job.insertion.selectionSet.ranges.length,
                removed = job.insertion.selectionSet.ranges.reduce((n, r) => n + Math.abs(r.head - r.anchor), 0);
            if (inserted > tableLimits.outputUnits || job.insertion.length - removed + inserted > 32 * 1024 * 1024)
                throw new RangeError("Table paste exceeds the aggregate edit/document limit.");
            // The insertion owns validation, subscription cleanup and the lease through commit.
            this.job = undefined;
            try {
                if (result.cells) {
                    const start = win.performance.now(),
                        applied = job.insertion.insert(result.text);
                    this.commitMs = win.performance.now() - start;
                    if (!applied) throw new Error("The captured table target is no longer editable.");
                }
                this.elapsedMs = win.performance.now() - job.started;
                this.cell.set({
                    ...this.cell.get(),
                    status: "applied",
                    rows: result.rows,
                    columns: result.columns,
                    work: progress.totalWork,
                    outputUnits: result.text.length,
                    message: result.cells
                        ? `Pasted ${result.rows} × ${result.columns} table as CSV.`
                        : "Clipboard table is empty; source text is unchanged."
                });
            } finally {
                this.release(job);
            }
        } catch (error) {
            this.fail(
                error instanceof Error && error.message.length <= 256 ? error.message : "Table conversion failed."
            );
        } finally {
            this.maxTurnMs = Math.max(this.maxTurnMs, win.performance.now() - began);
        }
    }
    attach(id: string, editor: TextEditor): () => void {
        if (this.sessions.has(id)) throw new Error("Table paste view is already mounted.");
        const session = { id, editor },
            clock = editor.element.ownerDocument.defaultView!.performance;
        const stop = editor.registerPasteHandler((data) => {
            if (!this.cell.get().enabled) return;
            return (insertion) => {
                const began = clock.now();
                try {
                    this.start(session, insertion, data.getData("text/plain"), data.getData("text/html"));
                } finally {
                    this.lastHostPasteMs = clock.now() - began;
                }
            };
        });
        this.sessions.set(id, session);
        return () => {
            if (this.sessions.get(id) !== session) return;
            this.sessions.delete(id);
            stop();
            if (this.job?.session === session) this.cancel();
        };
    }
    debug() {
        return {
            ...this.cell.get(),
            subscriptions: this.cell.count(),
            sessions: this.sessions.size,
            pending: this.job !== undefined,
            lastHostPasteMs: this.lastHostPasteMs,
            maxTurnMs: this.maxTurnMs,
            commitMs: this.commitMs,
            conversionToCommitMs: this.elapsedMs
        };
    }
}
