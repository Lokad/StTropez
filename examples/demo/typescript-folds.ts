import ts from "typescript-demo";

function startsImportGroup(statements: readonly ts.Statement[], first: number, end: number): boolean {
    const third = statements[first + 2];
    if (!third || third.end > end) return false;
    for (let i = first; i <= first + 2; i++) {
        const statement = statements[i]!;
        if (!ts.isImportDeclaration(statement) && !ts.isImportEqualsDeclaration(statement)) return false;
    }
    return true;
}

/** The external language server supplies only line ranges. Parse just its proposed import section. */
export function containsImportGroup(section: string): boolean {
    const source = ts.createSourceFile("imports.ts", section, ts.ScriptTarget.Latest);
    return source.statements.some((_, index) => startsImportGroup(source.statements, index, section.length));
}

/** Shared conversion for live provider and immutable review-snapshot outlining. */
export function typeScriptFoldingRanges(source: ts.SourceFile, spans: readonly ts.OutliningSpan[],
    positionAt = (offset: number) => source.getLineAndCharacterOfPosition(offset)) {
    let statement = 0;
    return spans.flatMap(span => {
        const from = span.textSpan.start, to = from + span.textSpan.length;
        if (span.kind === ts.OutliningSpanKind.Imports) {
            // Compiler spans are in source order. Reuse the parsed declarations across groups.
            while (statement < source.statements.length && source.statements[statement]!.end <= from) statement++;
            if (!startsImportGroup(source.statements, statement, to)) return [];
        }
        const start = positionAt(from), end = positionAt(to);
        const endLine = end.character === 0 ? end.line - 1 : end.line;
        return endLine > start.line ? [{ startLine: start.line, endLine, kind: span.kind }] : [];
    });
}
