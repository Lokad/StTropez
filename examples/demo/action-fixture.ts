type Document = Readonly<{ uri: string; version: number; getText: () => string; positionAt: (offset: number) => { line: number; character: number } }>;
const marker = "// Demo project action fixture\n";

/** Fixed sample refactoring shared by both demo providers; not a general language service. */
export function demoProjectActions(origin: Document, documents: readonly Document[]) {
    if (!origin.getText().startsWith(marker)) return undefined;
    const project = documents.filter(doc => doc.getText().startsWith(marker));
    const documentChanges = project.flatMap(doc => {
        const text = doc.getText(), matches = [...text.matchAll(/\bexampleRate\b/g)];
        if (!matches.length) return [];
        return [{ textDocument: { uri: doc.uri, version: doc.version }, edits: matches.map(match => ({
            range: { start: doc.positionAt(match.index), end: doc.positionAt(match.index + match[0].length) }, newText: "discountRate" })) }];
    });
    return [{ title: "Demo refactor: rename exampleRate across files", kind: "refactor.rename", edit: { documentChanges },
        ...(project.length !== 2 ? { disabled: { reason: "Open both sample files before refactoring." } }
            : !documentChanges.length ? { disabled: { reason: "The sample has already been refactored." } } : {}) }];
}
