import ts from "typescript-demo";

/** Compiler-owned syntax analysis, used only by the development worker and focused tests. */
export function analyzeTypeScript(text: string): Readonly<{ spans: Uint32Array; javascript: string }> {
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
        return { spans, javascript: ts.transpileModule(text, { compilerOptions: options }).outputText };
    } finally { service.dispose(); }
}
