/** Provider/host content retains its format; literal text is never inferred to be Markdown. */
export type DocumentationPart = Readonly<{ kind: "plaintext" | "markdown"; value: string } | { kind: "code"; value: string; language: string }>;
export type DocumentationContent = readonly DocumentationPart[];
