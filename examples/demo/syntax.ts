import ts from "typescript-demo";
import type { DiscoveredFold } from "../../src/index.ts";
import { typeScriptFolds } from "./typescript-folds.ts";

export type SyntaxOptions = Readonly<{ emit?: boolean; folds?: boolean }>;
export type SyntaxAnalysis = Readonly<{ spans: Uint32Array; javascript: string; folds: readonly DiscoveredFold[] }>;

class SyntaxSnapshot implements ts.IScriptSnapshot {
    private readonly changes = new WeakMap<ts.IScriptSnapshot, ts.TextChangeRange>();
    readonly text: string;
    constructor(text: string, previous?: ts.IScriptSnapshot, change?: ts.TextChangeRange) {
        this.text = text;
        if (previous && change) this.changes.set(previous, change);
    }
    getText(start: number, end: number): string {
        return this.text.slice(start, end);
    }
    getLength(): number {
        return this.text.length;
    }
    getChangeRange(previous: ts.IScriptSnapshot): ts.TextChangeRange | undefined {
        return previous === this ? ts.createTextChangeRange(ts.createTextSpan(0, 0), 0) : this.changes.get(previous);
    }
}

/** One compiler context per demo worker. Snapshots never retain an unbounded text history. */
export class TypeScriptSyntax {
    private current = new SyntaxSnapshot("");
    private version = 0;
    private readonly service: ts.LanguageService;
    private disposed = false;
    constructor() {
        const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, noLib: true };
        this.service = ts.createLanguageService({
            getCompilationSettings: () => options,
            getScriptFileNames: () => ["sample.ts"],
            getScriptVersion: () => String(this.version),
            getScriptSnapshot: (name) => (name === "sample.ts" ? this.current : undefined),
            getCurrentDirectory: () => "/",
            getDefaultLibFileName: () => "lib.d.ts",
            fileExists: (name) => name === "sample.ts",
            readFile: (name) => (name === "sample.ts" ? this.current.text : undefined)
        });
    }
    get snapshot(): ts.IScriptSnapshot {
        return this.current;
    }
    private active(): void {
        if (this.disposed) throw new Error("Syntax service is disposed.");
    }
    reset(text: string): void {
        this.active();
        this.current = new SyntaxSnapshot(text);
        this.version++;
    }
    replace(from: number, to: number, insert: string): void {
        this.active();
        if (
            !Number.isSafeInteger(from) ||
            !Number.isSafeInteger(to) ||
            from < 0 ||
            from > to ||
            to > this.current.text.length
        )
            throw new RangeError("Invalid syntax replacement.");
        if (from === to && !insert.length) return;
        this.current = new SyntaxSnapshot(
            this.current.text.slice(0, from) + insert + this.current.text.slice(to),
            this.current,
            ts.createTextChangeRange(ts.createTextSpan(from, to - from), insert.length)
        );
        this.version++;
    }
    analyze(analysis: SyntaxOptions = {}): SyntaxAnalysis {
        this.active();
        const file = "sample.ts",
            text = this.current.text,
            service = this.service;
        const spans = new Uint32Array(
            service.getEncodedSyntacticClassifications(file, { start: 0, length: text.length }).spans
        );
        const document = analysis.folds ? service.getProgram()!.getSourceFile(file)! : undefined;
        const folds = document ? typeScriptFolds(text, service.getOutliningSpans(file), document) : [];
        return {
            spans,
            javascript:
                analysis.emit === false
                    ? ""
                    : (service.getEmitOutput(file).outputFiles.find((output) => output.name.endsWith(".js"))?.text ??
                      ""),
            folds
        };
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.service.dispose();
        this.current = new SyntaxSnapshot("");
    }
}

/** Isolated analysis for callers that do not retain a compiler session. */
export function analyzeTypeScript(text: string, analysis: SyntaxOptions = {}): SyntaxAnalysis {
    const syntax = new TypeScriptSyntax();
    try {
        syntax.reset(text);
        return syntax.analyze(analysis);
    } finally {
        syntax.dispose();
    }
}
