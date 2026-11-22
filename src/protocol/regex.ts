import type { TextEdit } from "../core/changes.ts";
import type { SearchMatch } from "../core/search.ts";

/** Private worker wire contract. Shape validation never establishes live request authority. */
export const regexProtocolVersion = 2;
export const regexChunkUnits = 32768;
export const regexSourceLimit = 32 * 1024 * 1024;
export const regexMatchLimit = 1_000_000;
export const regexPatternLimit = 4096;
export const regexErrorLimit = 256;
export const regexMessageLimit = 262144;
export const regexPageLimit = 512;
export type RegexRange = SearchMatch;
export type RegexQuery = Readonly<{ length: number; pattern: string; matchCase: boolean; wholeWord?: boolean }>;
export type RegexOptions = Readonly<{ replacement?: string; range?: RegexRange; maxOutputUnits?: number }>;
type Identity = Readonly<{ id: number; revision: number }>;
export type RegexCommand = (Readonly<{ operation: "regex-start"; version: number; source: number }> & RegexQuery & RegexOptions)
    | Readonly<{ operation: "regex-chunk"; from: number; text: string }>
    | Readonly<{ operation: "regex-run" | "regex-continue" }>;
export type RegexRequest = Identity & RegexCommand;
export type RegexReply = Identity & (
    Readonly<{ operation: "regex-progress"; received: number; version?: number }>
    | Readonly<{ operation: "regex-matches"; matches: readonly RegexRange[] }>
    | Readonly<{ operation: "regex-edits"; edits: readonly TextEdit[] }>
    | Readonly<{ operation: "regex-edit"; ordinal: number; from: number; to: number; units: number }>
    | Readonly<{ operation: "regex-insert"; ordinal: number; from: number; text: string }>
    | Readonly<{ operation: "regex-done"; count: number; outputLength?: number }>
    | Readonly<{ operation: "regex-error"; message: string }>);
export const regexRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
export const regexInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const regexIdentity = (value: unknown): value is Record<string, unknown> & Identity => regexRecord(value) && regexInteger(value.id) && regexInteger(value.revision);
export const regexRange = (value: unknown): value is RegexRange => regexRecord(value) && regexInteger(value.from) && regexInteger(value.to) && value.to >= value.from;

/** Decode before identity dispatch; callers reject malformed data but ignore identified stale replies. */
export function decodeRegexMessage(data: unknown): Record<string, unknown> | undefined {
    if (typeof data !== "string" || data.length > regexMessageLimit) return;
    try { const value: unknown = JSON.parse(data); return regexRecord(value) ? value : undefined; } catch { return; }
}
export function regexQuery(value: unknown): value is RegexQuery {
    return regexRecord(value) && regexInteger(value.length) && value.length <= regexSourceLimit
        && typeof value.pattern === "string" && value.pattern.length <= regexPatternLimit && typeof value.matchCase === "boolean"
        && (value.wholeWord === undefined || typeof value.wholeWord === "boolean");
}
export function regexOptions(value: unknown, length: number): value is RegexOptions {
    return regexRecord(value) && (value.replacement === undefined || typeof value.replacement === "string" && value.replacement.length <= regexChunkUnits)
        && (value.maxOutputUnits === undefined || regexInteger(value.maxOutputUnits) && value.maxOutputUnits <= regexSourceLimit)
        && (value.range === undefined || value.replacement !== undefined && regexRange(value.range) && value.range.to <= length);
}
export function readRegexStart(value: Record<string, unknown> & Identity): Extract<RegexRequest, { operation: "regex-start" }> {
    if (value.operation !== "regex-start") throw new Error("Malformed regex start request.");
    if (value.version !== regexProtocolVersion) throw new Error("Unsupported regex worker protocol version.");
    if (!regexInteger(value.source) || value.source === 0 || !regexQuery(value)) throw new Error("Regex input exceeds the supported source/pattern bounds.");
    if (!regexOptions(value, value.length)) throw new Error("Invalid regex replacement capture or output budget.");
    return { operation: "regex-start", id: value.id, revision: value.revision, version: regexProtocolVersion, source: value.source,
        length: value.length, pattern: value.pattern, matchCase: value.matchCase, wholeWord: value.wholeWord === true,
        ...(value.replacement === undefined ? {} : { replacement: value.replacement }), ...(value.range === undefined ? {} : { range: value.range }),
        ...(value.maxOutputUnits === undefined ? {} : { maxOutputUnits: value.maxOutputUnits }) };
}
export function regexChunk(value: unknown): value is Extract<RegexCommand, { operation: "regex-chunk" }> {
    return regexRecord(value) && value.operation === "regex-chunk" && regexInteger(value.from)
        && typeof value.text === "string" && value.text.length > 0 && value.text.length <= regexChunkUnits;
}
/** Validate bounded wire structure once. Captured length, order, counts and output accounting remain with the client. */
export function readRegexReply(value: Record<string, unknown> & Identity): RegexReply {
    switch (value.operation) {
        case "regex-progress":
            if (!regexInteger(value.received)) throw new Error("Invalid regex acknowledgement.");
            if (value.version !== undefined && !regexInteger(value.version)) throw new Error("Unsupported regex worker protocol version.");
            break;
        case "regex-matches":
            if (!Array.isArray(value.matches) || !value.matches.length || value.matches.length > regexPageLimit) throw new Error("Invalid regex result page.");
            if (!value.matches.every(regexRange)) throw new Error("Invalid raw regex range.");
            break;
        case "regex-edits": {
            if (!Array.isArray(value.edits) || !value.edits.length || value.edits.length > regexPageLimit) throw new Error("Invalid regex edit page.");
            let units = 0;
            for (const edit of value.edits as unknown[]) {
                if (!regexRecord(edit) || typeof edit.insert !== "string" || edit.insert.length > regexChunkUnits - units) throw new Error("Invalid regex edit text.");
                units += edit.insert.length;
                if (!regexRange(edit)) throw new Error("Invalid raw regex range.");
            }
            break;
        }
        case "regex-edit":
            if (!regexInteger(value.ordinal) || !regexInteger(value.units) || value.units <= regexChunkUnits) throw new Error("Invalid regex insertion descriptor.");
            if (!regexRange(value)) throw new Error("Invalid raw regex range.");
            break;
        case "regex-insert":
            if (!regexInteger(value.ordinal) || !regexInteger(value.from) || typeof value.text !== "string" || !value.text.length || value.text.length > regexChunkUnits) throw new Error("Invalid regex insertion chunk.");
            break;
        case "regex-done":
            if (!regexInteger(value.count)) throw new Error("Invalid regex result count.");
            if (value.outputLength !== undefined && !regexInteger(value.outputLength)) throw new Error("Invalid regex result size.");
            break;
        case "regex-error": return { operation: "regex-error", id: value.id, revision: value.revision,
            message: typeof value.message === "string" && value.message.length <= regexErrorLimit ? value.message : "Regex search failed." };
        default: throw new Error("Unexpected regex response.");
    }
    return value as RegexReply;
}
