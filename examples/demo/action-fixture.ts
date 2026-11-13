type Document = Readonly<{ uri: string; version: number; getText: () => string; positionAt: (offset: number) => { line: number; character: number } }>;
export const projectActionMarker = "// Demo project action fixture\n";
export const projectReviewNote = "// Reviewed by the demo host command.\n";
export const projectCommand = "sttropez.demo.project";

/** Fixed sample refactoring shared by both demo providers; not a general language service. */
export function demoProjectActions(origin: Document, documents: readonly Document[]) {
    if (!origin.getText().startsWith(projectActionMarker)) return undefined;
    const project = documents.filter(doc => doc.getText().startsWith(projectActionMarker));
    const documentChanges = project.flatMap(doc => {
        const text = doc.getText(), matches = [...text.matchAll(/\bexampleRate\b/g)];
        if (!matches.length) return [];
        return [{ textDocument: { uri: doc.uri, version: doc.version }, edits: matches.map(match => ({
            range: { start: doc.positionAt(match.index), end: doc.positionAt(match.index + match[0].length) }, newText: "discountRate" })) }];
    });
    const refactor = { kind: "refactor.rename", edit: { documentChanges },
        ...(project.length !== 2 ? { disabled: { reason: "Open both sample files before refactoring." } }
            : !documentChanges.length ? { disabled: { reason: "The sample has already been refactored." } } : {}) };
    const command = (title: string, mode: string) => ({ title, command: projectCommand, arguments: [origin.uri, mode] });
    return [{ ...refactor, title: "Demo refactor: rename exampleRate across files" },
        { title: "Demo host: add review note", kind: "source", command: command("Add review note", "note"),
            ...(origin.getText().includes(projectReviewNote) ? { disabled: { reason: "This file already has a review note." } } : {}) },
        { ...refactor, title: "Demo host: refactor, then check", command: command("Check renamed project", "check") },
        { ...refactor, title: "Demo host: refactor, then fail (recovery demo)", command: command("Demonstrate failed later phase", "fail") }];
}
