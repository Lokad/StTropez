import { maxIdentifierUnits } from "./identifier.ts";

export const navigationLimits = Object.freeze({ documents: 100, sourceUnits: 16777216, chunkUnits: 16384, symbolUnits: maxIdentifierUnits, locations: 1024, page: 64, responseUnits: 524288 });
export type NavigationDocument = Readonly<{ document: string; revision: number; length: number }>;
export type NavigationFault = "malformed" | "failure";
export type NavigationLocation = Readonly<{ document: string; revision: number; from: number; to: number; declaration: boolean }>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const word = /^[\p{L}\p{N}\p{Pc}\p{M}\u200c\u200d]$/u;

export function validateNavigationDocuments(value: unknown): readonly NavigationDocument[] {
    if (!Array.isArray(value) || !value.length || value.length > navigationLimits.documents) throw new Error("Invalid project documents.");
    const ids = new Set<string>(); let units = 0;
    const documents = value.map((doc: unknown) => {
        if (!record(doc) || typeof doc.document !== "string" || !doc.document.length || doc.document.length > 128 || ids.has(doc.document) || !integer(doc.revision) || !integer(doc.length)
            || (units += doc.length) > navigationLimits.sourceUnits) throw new Error("Navigation supports at most 100 documents and 16 Mi UTF-16 units.");
        ids.add(doc.document); return Object.freeze({ document: doc.document, revision: doc.revision, length: doc.length });
    });
    return Object.freeze(documents);
}

/** Streaming lexical fixture, not a language parser or a text mirror. */
export class SymbolScanner {
    private offset = 0;
    private high = "";
    private token = "";
    private tokenFrom = 0;
    private tokenUnits = 0;
    private declaration = false;
    private mode: "code" | "slash" | "line" | "block" | "quote" = "code";
    private quote = "";
    private escaped = false;
    private star = false;
    private readonly accept: (from: number, to: number, declaration: boolean) => void;
    private readonly name: string;
    constructor(name: string, accept: (from: number, to: number, declaration: boolean) => void) { this.name = name; this.accept = accept; }
    private endToken(): void {
        if (!this.tokenUnits) return;
        if (this.token === this.name && this.tokenUnits === this.token.length) this.accept(this.tokenFrom, this.tokenFrom + this.tokenUnits, this.declaration);
        this.declaration = ["const", "let", "var", "function", "class"].includes(this.token) && this.tokenUnits === this.token.length;
        this.token = ""; this.tokenUnits = 0;
    }
    private point(char: string): void {
        const at = this.offset; this.offset += char.length;
        if (this.mode === "line") { if (char === "\n" || char === "\r") this.mode = "code"; return; }
        if (this.mode === "block") { if (this.star && char === "/") { this.mode = "code"; this.star = false; } else this.star = char === "*"; return; }
        if (this.mode === "quote") { if (this.escaped) this.escaped = false; else if (char === "\\") this.escaped = true; else if (char === this.quote) this.mode = "code"; return; }
        if (this.mode === "slash") {
            this.mode = char === "/" ? "line" : char === "*" ? "block" : "code";
            if (this.mode !== "code") return; this.declaration = false;
        }
        if (word.test(char)) { if (!this.tokenUnits) this.tokenFrom = at; this.tokenUnits += char.length;
            if (this.tokenUnits <= navigationLimits.symbolUnits) this.token += char; return; }
        this.endToken();
        if (char === "/") this.mode = "slash";
        else if (char === '"' || char === "'" || char === "`") { this.mode = "quote"; this.quote = char; this.declaration = false; }
        else if (!/\s/u.test(char)) this.declaration = false;
    }
    chunk(text: string): void {
        text = this.high + text; this.high = "";
        if (/[\ud800-\udbff]$/.test(text)) { this.high = text.at(-1)!; text = text.slice(0, -1); }
        for (const char of text) this.point(char);
    }
    finish(): void { if (this.high) { this.point(this.high); this.high = ""; } this.endToken(); }
}
