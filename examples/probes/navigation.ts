import type { TextBuffer } from "../../src/index.ts";
import { provideHover } from "./hover.ts";

export const navigationLimits = Object.freeze({ documents: 100, sourceUnits: 16777216, chunkUnits: 16384, symbolUnits: 256, locations: 1024, page: 64, responseUnits: 524288 });
export type NavigationDocument = Readonly<{ document: string; revision: number; length: number }>;
export type NavigationInput = Readonly<{ operation: "navigation-start"; id: number; kind: "definition" | "references"; symbol: string;
    documents: readonly NavigationDocument[]; includeDeclaration: boolean; delay: number; fault?: "malformed" | "failure" }>;
export type NavigationLocation = Readonly<{ document: string; revision: number; from: number; to: number; declaration: boolean }>;
export type NavigationResult = Readonly<{ operation: "navigation-result"; id: number; locations: readonly NavigationLocation[]; truncated: boolean }>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const word = /^[\p{L}\p{N}\p{Pc}\p{M}\u200c\u200d]$/u;
const symbol = (text: string) => text.length > 0 && text.length <= navigationLimits.symbolUnits && Array.from(text).every(char => word.test(char));

/** Reuse the bounded hover fixture's symbol policy, with guards for cut window edges. */
export function navigationSymbol(buffer: TextBuffer, offset: number): string | undefined {
    const from = Math.max(0, offset - 258), to = Math.min(buffer.length, offset + 258), text = buffer.slice(from, to);
    const range = provideHover({ operation: "hover", id: 1, revision: 0, text, offset: offset - from, delay: 0 }).range;
    if (!range || range.from === 0 && from > 0 || range.to === text.length && to < buffer.length) return;
    return text.slice(range.from, range.to);
}
export function validateNavigationInput(value: unknown): NavigationInput {
    if (!record(value) || value.operation !== "navigation-start" || !integer(value.id) || value.id < 1 || value.kind !== "definition" && value.kind !== "references"
        || typeof value.symbol !== "string" || !symbol(value.symbol) || !Array.isArray(value.documents) || !value.documents.length || value.documents.length > navigationLimits.documents
        || typeof value.includeDeclaration !== "boolean" || typeof value.delay !== "number" || !Number.isFinite(value.delay) || value.delay < 0 || value.delay > 1000
        || value.fault !== undefined && value.fault !== "malformed" && value.fault !== "failure") throw new Error("Invalid navigation capture.");
    const documents = validateNavigationDocuments(value.documents);
    return Object.freeze({ operation: "navigation-start", id: value.id, kind: value.kind, symbol: value.symbol, documents, includeDeclaration: value.includeDeclaration, delay: value.delay,
        ...(value.fault === undefined ? {} : { fault: value.fault }) });
}
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

/** One captured project per worker lane, one bounded chunk acknowledged at a time. */
export class NavigationSession {
    private readonly input: NavigationInput;
    private ordinal = -1;
    private received = 0;
    private scanner: SymbolScanner | undefined;
    private readonly locations: NavigationLocation[] = [];
    private truncated = false;
    private finished = false;
    constructor(input: unknown) { this.input = validateNavigationInput(input); }
    handle(value: unknown): Readonly<Record<string, unknown>> {
        const input = this.input, doc = input.documents[this.ordinal];
        if (!record(value) || value.id !== input.id || this.finished) throw new Error("Expired navigation request.");
        if (value.operation === "navigation-document") {
            if (this.scanner || this.ordinal + 1 >= input.documents.length || value.document !== input.documents[this.ordinal + 1]!.document) throw new Error("Invalid navigation document order.");
            const current = input.documents[++this.ordinal]!; this.received = 0;
            this.scanner = new SymbolScanner(input.symbol, (from, to, declaration) => {
                if (input.kind === "definition" ? !declaration : declaration && !input.includeDeclaration) return;
                if (this.locations.length >= navigationLimits.locations) { this.truncated = true; return; }
                this.locations.push(Object.freeze({ document: current.document, revision: current.revision, from, to, declaration }));
            });
            return { operation: "navigation-progress", id: input.id, document: current.document, received: 0 };
        }
        if (value.operation === "navigation-chunk") {
            if (!doc || !this.scanner || value.document !== doc.document || value.from !== this.received || typeof value.text !== "string" || !value.text.length
                || value.text.length > navigationLimits.chunkUnits || value.text.length > doc.length - this.received) throw new Error("Invalid navigation chunk.");
            this.scanner.chunk(value.text); this.received += value.text.length;
            return { operation: "navigation-progress", id: input.id, document: doc.document, received: this.received };
        }
        if (value.operation === "navigation-end-document") {
            if (!doc || !this.scanner || value.document !== doc.document || this.received !== doc.length) throw new Error("Incomplete navigation document.");
            this.scanner.finish(); this.scanner = undefined;
            return { operation: "navigation-progress", id: input.id, document: doc.document, received: this.received };
        }
        if (value.operation !== "navigation-finish" || this.scanner || this.ordinal !== input.documents.length - 1) throw new Error("Incomplete navigation project.");
        this.finished = true;
        return Object.freeze({ operation: "navigation-result", id: input.id, locations: Object.freeze(this.locations.slice()), truncated: this.truncated });
    }
}
export function validateNavigationResult(value: unknown, input: NavigationInput, buffers: ReadonlyMap<string, TextBuffer>): NavigationResult {
    if (!record(value) || value.operation !== "navigation-result" || value.id !== input.id || !Array.isArray(value.locations) || value.locations.length > navigationLimits.locations
        || typeof value.truncated !== "boolean" || value.truncated && value.locations.length !== navigationLimits.locations) throw new Error("Invalid navigation result.");
    const docs = new Map(input.documents.map((doc, index) => [doc.document, { ...doc, ordinal: index }])); let prior = -1, end = -1;
    const locations = value.locations.map((at: unknown) => {
        if (!record(at) || typeof at.document !== "string" || !integer(at.revision) || !integer(at.from) || !integer(at.to) || typeof at.declaration !== "boolean") throw new Error("Invalid navigation location.");
        const doc = docs.get(at.document), buffer = buffers.get(at.document);
        if (!doc || !buffer || doc.revision !== at.revision || at.to > doc.length || at.to - at.from !== input.symbol.length || buffer.slice(at.from, at.to) !== input.symbol
            || doc.ordinal < prior || doc.ordinal === prior && at.from < end || input.kind === "definition" && !at.declaration || input.kind === "references" && !input.includeDeclaration && at.declaration) throw new Error("Invalid captured navigation target.");
        const before = Array.from(buffer.slice(Math.max(0, at.from - 2), at.from)).at(-1), after = Array.from(buffer.slice(at.to, Math.min(buffer.length, at.to + 2)))[0];
        if (before && word.test(before) || after && word.test(after)) throw new Error("Navigation target splits a symbol.");
        prior = doc.ordinal; end = at.to; return Object.freeze({ document: at.document, revision: at.revision, from: at.from, to: at.to, declaration: at.declaration });
    });
    return Object.freeze({ operation: "navigation-result", id: input.id, locations: Object.freeze(locations), truncated: value.truncated });
}
