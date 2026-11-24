import { isNonNegativeInteger, isOffsetRange, isPositiveInteger } from "../core/bounds.ts";
import type { SearchMatch } from "../core/search.ts";

/** Private structured-clone messages shared by the worker and its owning browser client. */
export const regexProtocolVersion = 3;
export const regexSourceLimit = 512_000;
export const regexErrorLimit = 256;
export type RegexOptions = Readonly<{ replacement?: string; range?: SearchMatch; maxOutputUnits?: number }>;
export type RegexQuery = Readonly<{ length: number; pattern: string; matchCase: boolean; wholeWord?: boolean }>;
type Identity = Readonly<{ id: number; revision: number }>;
export type RegexRequest = Identity & RegexQuery & RegexOptions & Readonly<{
    version: number; source: number; text?: string;
}>;
export type RegexResult = Readonly<{ operation: "regex-matches"; offsets: Uint32Array }>
    | Readonly<{ operation: "regex-edits"; offsets: Uint32Array; insertions: string }>;
export type RegexReply = Identity & Readonly<{ version: number }> &
    (RegexResult | Readonly<{ operation: "regex-error"; message: string }>);

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
export const regexIdentity = (value: unknown): value is Record<string, unknown> & Identity =>
    record(value) && isPositiveInteger(value.id) && isNonNegativeInteger(value.revision);
export function regexQuery(value: RegexQuery): boolean {
    return isNonNegativeInteger(value.length) && value.length <= regexSourceLimit
        && typeof value.pattern === "string" && value.pattern.length <= 4096 && typeof value.matchCase === "boolean"
        && (value.wholeWord === undefined || typeof value.wholeWord === "boolean");
}
export function regexOptions(value: RegexOptions, length: number): boolean {
    const range = value.range;
    return (value.replacement === undefined || typeof value.replacement === "string" && value.replacement.length <= 32768)
        && (value.maxOutputUnits === undefined || isNonNegativeInteger(value.maxOutputUnits) && value.maxOutputUnits <= regexSourceLimit)
        && (range === undefined || value.replacement !== undefined && record(range)
            && isOffsetRange(range.from, range.to, length));
}

/** Match offsets are pairs. Each edit adds the exclusive end of its text in the joined insertions. */
export function readRegexResult(value: Record<string, unknown>, length: number, replacement: boolean, maxOutput: number): RegexResult {
    if (value.version !== regexProtocolVersion) throw new Error("Unsupported regex worker protocol version.");
    if (value.operation === "regex-error") {
        throw new Error(typeof value.message === "string" && value.message.length <= regexErrorLimit ? value.message : "Regex search failed.");
    }
    const stride = replacement ? 3 : 2;
    const offsets = value.offsets;
    if (!(offsets instanceof Uint32Array) || !(offsets.buffer instanceof ArrayBuffer) || offsets.byteLength !== offsets.buffer.byteLength
        || offsets.length % stride || offsets.length > stride * (length + 1))
        throw new Error("Invalid regex result offsets.");
    if (replacement && value.operation === "regex-edits" && typeof value.insertions === "string" && value.insertions.length <= maxOutput)
        return { operation: "regex-edits", offsets, insertions: value.insertions };
    if (!replacement && value.operation === "regex-matches") return { operation: "regex-matches", offsets };
    throw new Error("Invalid regex worker result.");
}
