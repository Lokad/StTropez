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

/** Treat transport payloads as unknown; validate the whole result before publishing any part. */
export function validateProviderResult(value: unknown, input: ProviderInput): ProviderResult | undefined {
    const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
    if (!record(value) || value.id !== input.id || value.revision !== input.revision || !record(value.completion) || !Array.isArray(value.diagnostics) || value.diagnostics.length > 256 || typeof value.diagnosticsTruncated !== "boolean") return undefined;
    const edit = value.completion;
    if (![edit.from, edit.to, edit.replaceTo].every(Number.isSafeInteger) || typeof edit.from !== "number" || typeof edit.to !== "number" || typeof edit.replaceTo !== "number"
        || edit.from < 0 || edit.from > input.offset || edit.to !== input.offset || edit.replaceTo < edit.to || edit.replaceTo > input.text.length
        || typeof edit.insert !== "string" || edit.insert.length > 4096) return undefined;
    const diagnostics: { from: number; to: number; message: string }[] = [];
    for (const item of value.diagnostics) {
        if (!record(item) || !Number.isSafeInteger(item.from) || !Number.isSafeInteger(item.to) || typeof item.from !== "number" || typeof item.to !== "number"
            || item.from < 0 || item.to < item.from || item.to > input.text.length || typeof item.message !== "string" || item.message.length > 1024) return undefined;
        diagnostics.push(Object.freeze({ from: item.from, to: item.to, message: item.message }));
    }
    return Object.freeze({ id: input.id, revision: input.revision, completion: Object.freeze({ from: edit.from, to: edit.to, replaceTo: edit.replaceTo, insert: edit.insert }), diagnostics: Object.freeze(diagnostics), diagnosticsTruncated: value.diagnosticsTruncated });
}
