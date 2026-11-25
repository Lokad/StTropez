/** Development-only boundary, independent of DOM, framework and transport. Not an LSP client. */
export type ProviderInput = Readonly<{ id: number; revision: number; text: string; offset: number; delay: number; fault?: "malformed" | "failure" }>;
export type ProviderResult = Readonly<{ id: number; revision: number;
    completion: Readonly<{ from: number; to: number; replaceTo: number; insert: string }>;
    diagnosticsTruncated: boolean;
    diagnostics: readonly Readonly<{ from: number; to: number; message: string }>[] }>;
export type Token = Readonly<{ from: number; to: number; kind: "keyword" | "number" | "comment" }>;

/** Small fixture tokenizer: one line can be re-tokenized without requiring server availability. */
export function tokenizeLine(text: string): readonly Token[] {
    const tokens: Token[] = [];
    for (const match of text.matchAll(/\/\/[^\r\n]*|\bconst\b|\b\d+\b/g)) {
        tokens.push(Object.freeze({ from: match.index, to: match.index + match[0].length,
            kind: match[0].startsWith("//") ? "comment" : match[0] === "const" ? "keyword" : "number" }));
    }
    return Object.freeze(tokens);
}

export function provide(input: ProviderInput): ProviderResult {
    const prefix = /[a-zA-Z]*$/.exec(input.text.slice(0, input.offset))![0];
    const diagnostics = [...input.text.matchAll(/TODO/g)].map(match => ({ from: match.index, to: match.index + 4, message: "Resolve this placeholder." }));
    return { id: input.id, revision: input.revision,
        completion: { from: input.offset - prefix.length, to: input.offset, replaceTo: input.offset + /^[a-zA-Z]*/.exec(input.text.slice(input.offset))![0].length, insert: "sample" },
        diagnostics: diagnostics.slice(0, 256), diagnosticsTruncated: diagnostics.length > 256 };
}
