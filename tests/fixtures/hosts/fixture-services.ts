import { TextBuffer } from "../../../src/index.ts";
import type { SaveResponse, SaveSubmission } from "../../../src/index.ts";
import type { SnapshotValue } from "./values.ts";
import type { RunSubmission } from "./run-command.ts";

export type Connection = Readonly<{ path: string; format: "csv"; [key: string]: SnapshotValue }>;
export type ServiceActivity = Readonly<{ writes: number }>;
export class SourceSaveFailure extends Error {}
export type SubmittedRun = RunSubmission;

/** Deferred services for the host example. Captures, review and application remain in their owners. */
export class HostFixtureServices {
    private readonly saves: { submission: SaveSubmission; resolve: (response: SaveResponse) => void; reject: (error: unknown) => void }[] = [];
    private readonly runs: { submission: SubmittedRun; resolve: () => void; reject: (error: unknown) => void }[] = [];
    private version = "v0";
    private serial = 0;
    private buffer: TextBuffer;
    private disposed = false;
    private activity: ServiceActivity = { writes: 0 };
    private readonly changed: (activity: ServiceActivity) => void;
    constructor(buffer: TextBuffer, changed: (activity: ServiceActivity) => void) { this.buffer = buffer; this.changed = changed; }
    get server(): Readonly<{ buffer: TextBuffer; version: string }> { return { buffer: this.buffer, version: this.version }; }
    private count(key: keyof ServiceActivity): void {
        this.activity = { ...this.activity, [key]: this.activity[key] + 1 }; this.changed(this.activity);
    }
    readonly save = (submission: SaveSubmission): Promise<SaveResponse> => this.disposed
        ? Promise.resolve({ kind: "conflict", serverVersion: this.version })
        : new Promise((resolve, reject) => this.saves.push({ submission, resolve, reject }));
    readonly finishSave = (): void => {
        const pending = this.saves.shift(); if (!pending) return;
        if (pending.submission.expectedServerVersion !== this.version) {
            pending.resolve({ kind: "conflict", serverVersion: this.version }); return;
        }
        this.version = `v${++this.serial}`; this.count("writes");
        this.buffer = TextBuffer.from(pending.submission.value.trimEnd());
        pending.resolve({ kind: "saved", serverVersion: this.version, canonical: pending.submission.value.trimEnd() });
    };
    readonly failSave = (): void => { this.saves.shift()?.reject(new SourceSaveFailure("Synthetic save transport failure")); };
    externalWrite(text: string): void {
        if (this.disposed) return;
        this.buffer = TextBuffer.from(text); this.version = `v${++this.serial}`;
    }
    run(submission: SubmittedRun, settled: (status: "completed" | "failed" | "interrupted") => void): Promise<void> {
        if (this.disposed) { settled("interrupted"); return Promise.resolve(); }
        return new Promise((resolve, reject) => this.runs.push({ submission,
            resolve: () => { settled(this.disposed ? "interrupted" : "completed"); resolve(); },
            reject: error => { settled("failed"); reject(error); } }));
    }
    readonly finishRun = (): void => { this.runs.shift()?.resolve(); };
    readonly failRun = (): void => { this.runs.shift()?.reject(new Error("Synthetic run failure")); };
    runCapture(index: number) {
        const submission = this.runs[index]?.submission;
        return submission ? { source: submission.source.value, configuration: submission.configuration.value, settings: submission.settings } : null;
    }
    debug() {
        return { server: { version: this.version, length: this.buffer.length },
            pendingSaves: this.saves.map(({ submission }) => ({ revision: submission.revision, length: submission.value.length, expectedServerVersion: submission.expectedServerVersion })),
            pendingRuns: this.runs.map(({ submission }) => ({ sourceId: submission.source.id, sourceRevision: submission.source.revision,
                sourceLength: submission.source.value.length, sourceVersion: submission.source.serverVersion, configurationId: submission.configuration.id,
                configurationRevision: submission.configuration.revision, configurationVersion: submission.configuration.serverVersion, mode: submission.settings.mode })) };
    }
    dispose(): void {
        if (this.disposed) return; this.disposed = true;
        this.saves.splice(0).forEach(save => save.resolve({ kind: "conflict", serverVersion: this.version }));
        this.runs.splice(0).forEach(run => run.resolve());
    }
}
