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

export type OutlineSpan = Pick<ts.OutliningSpan, "textSpan" | "kind">;

/** Project the compiler's source-ordered spans onto complete LF-delimited editor rows. */
export function typeScriptFolds(text: string, spans: readonly OutlineSpan[], source?: ts.SourceFile) {
    let statement = 0,
        header = 0,
        newline = text.indexOf("\n");
    return spans.flatMap((span) => {
        const from = span.textSpan.start,
            to = from + span.textSpan.length;
        while (newline !== -1 && newline < from) {
            header = newline + 1;
            newline = text.indexOf("\n", header);
        }
        if (newline === -1 || newline + 1 >= to) return [];
        if (span.kind === ts.OutliningSpanKind.Imports) {
            if (source) {
                while (statement < source.statements.length && source.statements[statement]!.end <= from) statement++;
                if (!startsImportGroup(source.statements, statement, to)) return [];
            } else {
                // The development server supplies exact spans but retains its own parse tree.
                const section = ts.createSourceFile("imports.ts", text.slice(from, to), ts.ScriptTarget.Latest);
                if (!startsImportGroup(section.statements, 0, section.end)) return [];
            }
        }
        const last = text.lastIndexOf("\n", to - 1) + 1;
        let end = last;
        if (to > last) {
            const next = text.indexOf("\n", to),
                lineEnd = next === -1 ? text.length : next;
            const tail = text.slice(to, lineEnd).trim();
            const code = span.kind === ts.OutliningSpanKind.Code;
            const closingLine = code && /^[}\])]+[;,]?$/.test(text.slice(last, lineEnd).trim());
            if (!closingLine && (!tail || (code && (tail === ";" || tail === ","))))
                end = next === -1 ? text.length : next + 1;
        }
        return end > newline + 1 ? [{ from: header, to: end, group: span.kind }] : [];
    });
}

export function typeScriptFoldingRanges(
    text: string,
    spans: readonly OutlineSpan[],
    positionAt: (offset: number) => { line: number },
    source?: ts.SourceFile
) {
    return typeScriptFolds(text, spans, source).map((range) => ({
        startLine: positionAt(range.from).line,
        endLine: positionAt(range.to - 1).line,
        kind: range.group
    }));
}
