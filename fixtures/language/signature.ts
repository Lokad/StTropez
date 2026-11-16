import { validateNavigationDocuments } from "./navigation.ts";
import type { NavigationDocument } from "./navigation.ts";
export type SignatureInput = NavigationDocument & Readonly<{ id: number; offset: number; delay: number; fault?: "malformed" | "failure" | "markup" }>;
export type SignatureInformation = Readonly<{ label: string; documentation: string; parameters: readonly Readonly<{ from: number; to: number; documentation: string }>[] }>;
export type SignatureResult = Readonly<{ id: number; document: string; revision: number; reason: "ready" | "no-call" | "literal" | "unsupported" | "depth-limit";
    call: Readonly<{ name: string; open: number; argument: number }> | null; signatures: readonly SignatureInformation[]; activeSignature: number }>;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function validateSignatureInput(v: unknown): SignatureInput {
    if (!record(v) || !integer(v.id) || !v.id || !integer(v.offset) || typeof v.delay !== "number" || !Number.isFinite(v.delay) || v.delay < 0 || v.delay > 1000
        || v.fault !== undefined && !["malformed", "failure", "markup"].includes(v.fault as string)) throw new Error("Invalid signature capture.");
    const doc = validateNavigationDocuments([v])[0]!; if (v.offset > doc.length) throw new Error("Signature caret is outside the captured source.");
    return Object.freeze({ ...doc, id: v.id, offset: v.offset, delay: v.delay, ...(v.fault === undefined ? {} : { fault: v.fault as NonNullable<SignatureInput["fault"]> }) });
}
function signature(name: string, parameters: readonly string[], returns: string, documentation: string): SignatureInformation {
    const label = `${name}(${parameters.join(", ")}): ${returns}`; let from = name.length + 1;
    return Object.freeze({ label, documentation, parameters: Object.freeze(parameters.map(parameter => { const result = Object.freeze({ from, to: from + parameter.length, documentation: parameter }); from += parameter.length + 2; return result; })) });
}
const catalogue: Readonly<Record<string, readonly SignatureInformation[]>> = Object.freeze({
    lookup: Object.freeze([signature("lookup", ["key: string", "fallback?: string"], "string", "Returns a value for a key, with an optional fallback."), signature("lookup", ["keys: readonly string[]"], "readonly string[]", "Returns values for a list of keys.")]),
    format: Object.freeze([signature("format", ["value: unknown", "locale?: string"], "string", "Formats a value using an optional locale.")]),
    "café": Object.freeze([signature("café", ["texte: string", "options?: string"], "string", "Formats Unicode text without changing its source units.")])
});
/** Cheap automatic-trigger filter only; complete lexical state is still resolved in the worker. */
export function signatureTriggerName(prefix: string): boolean {
    if (prefix.length > 512) throw new Error("Signature trigger prefix exceeds bounds.");
    const name = /([\p{L}\p{N}\p{Pc}\p{M}\u200c\u200d]+)\s*$/u.exec(prefix)?.[1]; return !!name && Object.hasOwn(catalogue, name);
}
type Frame = { close: string; name: string | null; open: number; argument: number };
/** Streaming lexical fixture: complete prefix state, bounded chunks, names and nesting. No text mirror. */
export class SignatureScanner {
    private offset = 0;
    private high = "";
    private token = "";
    private oversized = false;
    private name = "";
    private callee = false;
    private operand = true;
    private mode: "code" | "slash" | "line" | "block" | "quote" | "regex" = "code";
    private quote = "";
    private escaped = false;
    private star = false;
    private characterClass = false;
    private regexPossible = false;
    private limited = false;
    private readonly frames: Frame[] = [];
    feed(text: string, from: number): void {
        if (from !== this.offset || text.length > 16384) throw new Error("Invalid signature scan chunk.");
        let data = this.high + text, base = from - this.high.length; this.high = ""; this.offset += text.length;
        if (data.length && /[\ud800-\udbff]/.test(data.at(-1)!)) { this.high = data.at(-1)!; data = data.slice(0, -1); }
        for (let i = 0; i < data.length;) { const char = String.fromCodePoint(data.codePointAt(i)!); this.character(char, base + i); i += char.length; }
    }
    private endWord(): void {
        if (!this.token && !this.oversized) return;
        this.name = this.oversized ? "" : this.token; this.callee = true; this.operand = ["return", "throw", "case", "yield", "await", "typeof", "void", "delete", "new"].includes(this.name);
        this.token = ""; this.oversized = false;
    }
    private character(char: string, at: number): void {
        if (this.limited) return;
        if (this.mode === "line") { if (char === "\r" || char === "\n") this.mode = "code"; return; }
        if (this.mode === "block") { if (this.star && char === "/") { this.mode = "code"; this.star = false; } else this.star = char === "*"; return; }
        if (this.mode === "quote") { if (this.escaped) this.escaped = false; else if (char === "\\") this.escaped = true; else if (char === this.quote) { this.mode = "code"; this.operand = false; } return; }
        if (this.mode === "regex") { if (this.escaped) this.escaped = false; else if (char === "\\") this.escaped = true; else if (char === "[") this.characterClass = true; else if (char === "]") this.characterClass = false; else if (char === "/" && !this.characterClass) { this.mode = "code"; this.operand = false; } return; }
        if (this.mode === "slash") {
            if (char === "/") { this.mode = "line"; return; }
            if (char === "*") { this.mode = "block"; this.star = false; return; }
            this.mode = this.regexPossible ? "regex" : "code"; this.name = ""; this.callee = false; this.operand = true; this.character(char, at); return;
        }
        if (/^[\p{L}\p{N}\p{Pc}\p{M}\u200c\u200d]$/u.test(char)) { if (!this.oversized) { this.token += char; if (this.token.length > 256) { this.token = ""; this.oversized = true; } } return; }
        this.endWord();
        if (/\s/u.test(char)) return;
        if (char === "/") { this.regexPossible = this.operand; this.mode = "slash"; return; }
        if (char === "'" || char === '"' || char === "`") { this.mode = "quote"; this.quote = char; this.escaped = false; this.name = ""; this.callee = false; return; }
        if (char === "(" || char === "[" || char === "{") {
            if (this.frames.length >= 128) { this.limited = true; this.frames.length = 0; return; }
            this.frames.push({ close: char === "(" ? ")" : char === "[" ? "]" : "}", name: char === "(" && this.callee ? this.name : null, open: at, argument: 0 }); this.operand = true;
        } else if (char === ")" || char === "]" || char === "}") {
            if (this.frames.at(-1)?.close !== char) this.frames.length = 0; else this.frames.pop(); this.operand = false;
        } else if (char === ",") { const top = this.frames.at(-1); if (top?.close === ")" && top.name !== null) top.argument++; this.operand = true; }
        else this.operand = char !== ".";
        this.name = ""; this.callee = false;
    }
    result(input: SignatureInput): SignatureResult {
        if (this.offset !== input.offset) throw new Error("Incomplete signature scan.");
        const base = { id: input.id, document: input.document, revision: input.revision, activeSignature: 0 };
        const empty = (reason: SignatureResult["reason"]): SignatureResult => Object.freeze({ ...base, reason, call: null, signatures: Object.freeze([]) });
        if (this.limited) return empty("depth-limit");
        const call = this.frames.slice().reverse().find(frame => frame.name !== null);
        if (this.mode !== "code") return empty(call ? "literal" : "no-call"); if (!call) return empty("no-call");
        const signatures = Object.hasOwn(catalogue, call.name!) ? catalogue[call.name!]! : undefined; if (!signatures) return empty("unsupported");
        return Object.freeze({ ...base, reason: "ready", call: Object.freeze({ name: call.name!, open: call.open, argument: call.argument }), signatures });
    }
}
/** Reject the entire response before any label, documentation or parameter range is published. */
export function validateSignatureResult(v: unknown, input: SignatureInput): SignatureResult {
    if (!record(v) || v.id !== input.id || v.document !== input.document || v.revision !== input.revision || !["ready", "no-call", "literal", "unsupported", "depth-limit"].includes(v.reason as string)
        || !integer(v.activeSignature) || !Array.isArray(v.signatures) || v.signatures.length > 8) throw new Error("Invalid signature response.");
    if (v.call === null) { if (v.reason === "ready" || v.signatures.length || v.activeSignature) throw new Error("Invalid empty signature response."); return Object.freeze({ id: input.id, document: input.document, revision: input.revision, reason: v.reason as SignatureResult["reason"], call: null, signatures: Object.freeze([]), activeSignature: 0 }); }
    if (!record(v.call) || v.reason !== "ready" || typeof v.call.name !== "string" || !v.call.name.length || v.call.name.length > 256 || !integer(v.call.open) || v.call.open >= input.offset || !integer(v.call.argument) || v.call.argument > input.offset
        || !v.signatures.length || v.activeSignature >= v.signatures.length) throw new Error("Invalid signature call.");
    const split = (label: string, at: number) => at > 0 && at < label.length && /[\ud800-\udbff]/.test(label[at - 1]!) && /[\udc00-\udfff]/.test(label[at]!);
    const signatures = v.signatures.map((s: unknown): SignatureInformation => {
        if (!record(s) || typeof s.label !== "string" || !s.label.length || s.label.length > 1024 || typeof s.documentation !== "string" || s.documentation.length > 2048 || !Array.isArray(s.parameters) || s.parameters.length > 16) throw new Error("Invalid signature information.");
        const label = s.label; let end = 0;
        const parameters = s.parameters.map((p: unknown) => { if (!record(p) || !integer(p.from) || !integer(p.to) || p.from < end || p.to <= p.from || p.to > label.length || split(label, p.from) || split(label, p.to)
            || typeof p.documentation !== "string" || p.documentation.length > 1024) throw new Error("Invalid signature parameter."); end = p.to; return Object.freeze({ from: p.from, to: p.to, documentation: p.documentation }); });
        return Object.freeze({ label, documentation: s.documentation, parameters: Object.freeze(parameters) });
    });
    return Object.freeze({ id: input.id, document: input.document, revision: input.revision, reason: "ready", call: Object.freeze({ name: v.call.name, open: v.call.open, argument: v.call.argument }), activeSignature: v.activeSignature, signatures: Object.freeze(signatures) });
}
