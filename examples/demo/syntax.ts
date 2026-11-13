import ts from "typescript-demo";
import type { DiscoveredFold } from "../../src/index.ts";
import { typeScriptFoldingRanges } from "./typescript-folds.ts";

export type SyntaxOptions = Readonly<{ emit?: boolean; folds?: boolean }>;

/** Compiler-owned syntax analysis, used only by the development worker and focused tests. */
export function analyzeTypeScript(text: string, analysis: SyntaxOptions = {}): Readonly<{ spans: Uint32Array; javascript: string; folds: readonly DiscoveredFold[] }> {
    const file = "sample.ts", options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, noLib: true };
    const host: ts.LanguageServiceHost = {
        getCompilationSettings: () => options, getScriptFileNames: () => [file], getScriptVersion: () => "1",
        getScriptSnapshot: name => name === file ? ts.ScriptSnapshot.fromString(text) : undefined,
        getCurrentDirectory: () => "/", getDefaultLibFileName: () => "lib.d.ts", fileExists: name => name === file,
        readFile: name => name === file ? text : undefined,
    };
    const service = ts.createLanguageService(host);
    try {
        const spans = new Uint32Array(service.getEncodedSyntacticClassifications(file, { start: 0, length: text.length }).spans);
        const document = analysis.folds ? service.getProgram()!.getSourceFile(file)! : undefined, starts = document?.getLineStarts();
        const folds = document ? typeScriptFoldingRanges(offset => document.getLineAndCharacterOfPosition(offset), service.getOutliningSpans(file)).map(range => ({
            from: starts![range.startLine]!, to: starts![range.endLine + 1] ?? text.length, group: range.kind,
        })) : [];
        return { spans, javascript: analysis.emit === false ? "" : ts.transpileModule(text, { compilerOptions: options }).outputText, folds };
    } finally { service.dispose(); }
}
