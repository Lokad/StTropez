import type ts from "typescript-demo";

/** Shared conversion for live provider and immutable review-snapshot outlining. */
export function typeScriptFoldingRanges(positionAt: (offset: number) => Readonly<{ line: number; character: number }>, spans: readonly ts.OutliningSpan[]) {
    return spans.flatMap(span => {
        const start = positionAt(span.textSpan.start), end = positionAt(span.textSpan.start + span.textSpan.length);
        const endLine = end.character === 0 ? end.line - 1 : end.line;
        return endLine > start.line ? [{ startLine: start.line, endLine, kind: span.kind }] : [];
    });
}
