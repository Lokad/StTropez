import { TypeScriptSyntax } from "./syntax.ts";
import type { SyntaxAnalysis, SyntaxOptions } from "./syntax.ts";

export type SyntaxRequest = Readonly<
    { kind: "start"; job: number; change?: Readonly<{ base: number; from: number; to: number }> }
    | { kind: "chunk"; job: number; text: string }
    | { kind: "finish"; job: number; options: SyntaxOptions }
    | { kind: "cancel"; job: number }>;
export type SyntaxResponse = Readonly<{ kind: "result"; job: number } & SyntaxAnalysis> | Readonly<{ kind: "failed"; job: number }>;

/** Private demo transport: incomplete uploads never alter the compiler's committed snapshot. */
export class DemoSyntaxSession {
    private readonly syntax = new TypeScriptSyntax();
    private pending: { job: number; change?: Readonly<{ base: number; from: number; to: number }>; chunks: string[] } | undefined;
    private job = 0;
    private committed = 0;
    private disposed = false;
    accept(message: SyntaxRequest): SyntaxResponse | undefined {
        if (this.disposed) return;
        if (message.kind === "start") {
            if (message.job <= this.job) return;
            this.job = message.job; this.pending = { ...message, chunks: [] }; return;
        }
        if (!this.pending || message.job !== this.pending.job) return;
        if (message.kind === "cancel") { this.pending = undefined; return; }
        if (message.kind === "chunk") { this.pending.chunks.push(message.text); return; }
        const { change, chunks } = this.pending; this.pending = undefined;
        try {
            if (change) {
                if (change.base !== this.committed) throw new Error("Syntax base expired.");
                this.syntax.replace(change.from, change.to, chunks.join(""));
            } else this.syntax.reset(chunks.join(""));
            this.committed = message.job;
            return { job: message.job, kind: "result", ...this.syntax.analyze(message.options) };
        } catch { return { job: message.job, kind: "failed" }; }
    }
    dispose(): void { this.disposed = true; this.pending = undefined; this.syntax.dispose(); }
}
