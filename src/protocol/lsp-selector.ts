import { invalidRange } from "../core/bounds.ts";
import { ProtocolDecodeError, isRecord } from "./wire.ts";
/** Text-document selectors only; notebook and file-watcher registration are not advertised. */
export type LspSelectorDocument = Readonly<{ uri: string; languageId: string }>;
/** Stable URI-to-path policy for a binding's lifetime; rebind or reconnect after changing that policy. */
export type LspUriPath = (uri: string) => string;
export type LspSelector = (document: LspSelectorDocument) => boolean;
type Token = Readonly<{ kind: "literal"; value: string } | { kind: "any" } | { kind: "star" } | { kind: "glob" } | { kind: "directory" } |
    { kind: "class"; negate: boolean; ranges: readonly (readonly [number, number])[] }>;
function invalid(): never { throw new ProtocolDecodeError("Unsupported or malformed text-document selector."); }

/** Opaque URI identity is preserved. A host can replace path decoding/case policy explicitly. */
export function lspUriPath(uri: string): string {
    const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?:\/\/[^/?#]*)?([^?#]*)/.exec(uri);
    if (!match) throw new TypeError("Document URI must be absolute.");
    // Invalid percent escapes are literal path text, never a session-fatal URI operation.
    try { return decodeURIComponent(match[1]!); } catch { return match[1]!; }
}
function alternatives(pattern: string): string[] {
    const pending = [pattern], result: string[] = []; let total = 0;
    while (pending.length) {
        const value = pending.pop()!; let from = -1, depth = 0, inClass = false, start = 0; const pieces: string[] = [];
        for (let i = 0; i < value.length; i++) {
            const c = value[i]; if (c === "\\") { i++; continue; }
            if (c === "[") inClass = true; if (c === "]") inClass = false; if (inClass) continue;
            if (c === "{") { if (depth++ === 0) { from = i; start = i + 1; } }
            else if (c === "," && depth === 1) { pieces.push(value.slice(start, i)); start = i + 1; }
            else if (c === "}") {
                if (!depth) invalid();
                if (--depth === 0) {
                    pieces.push(value.slice(start, i)); if (pieces.length < 2) invalid();
                    for (const piece of pieces) pending.push(value.slice(0, from) + piece + value.slice(i + 1)); break;
                }
            }
        }
        if (depth) invalid();
        if (from < 0) { total += value.length; result.push(value); }
        if (pending.length + result.length > 16 || total > 1024) invalid();
    }
    return result;
}
function tokens(pattern: string): readonly Token[] {
    const result: Token[] = [];
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i]!;
        if (c === "\\") { if (++i >= pattern.length) invalid(); result.push({ kind: "literal", value: pattern[i]! }); }
        else if (c === "*") {
            if (pattern[i + 1] === "*") { while (pattern[i + 1] === "*") i++; if (pattern[i + 1] === "/") { i++; result.push({ kind: "directory" }); } else result.push({ kind: "glob" }); }
            else result.push({ kind: "star" });
        } else if (c === "?") result.push({ kind: "any" });
        else if (c === "[") {
            const negate = pattern[i + 1] === "!"; if (negate) i++;
            const ranges: [number, number][] = []; let closed = false;
            while (++i < pattern.length) {
                if (pattern[i] === "]") { closed = true; break; }
                let from = pattern.charCodeAt(i); if (pattern[i] === "\\") { if (++i >= pattern.length) invalid(); from = pattern.charCodeAt(i); }
                let to = from;
                if (pattern[i + 1] === "-" && pattern[i + 2] !== "]" && i + 2 < pattern.length) { i += 2; to = pattern.charCodeAt(i); }
                if (to < from || from === 47 || to === 47) invalid(); ranges.push([from, to]);
            }
            if (!closed || !ranges.length) invalid(); result.push({ kind: "class", negate, ranges });
        } else if (c === "]" || c === "{" || c === "}") invalid();
        else result.push({ kind: "literal", value: c });
    }
    return result;
}
/** Bounded dynamic programming; patterns cannot trigger regex backtracking. */
function matches(pattern: readonly Token[], path: string): boolean {
    let state = new Uint8Array(path.length + 1); state[0] = 1;
    for (const token of pattern) {
        const next = new Uint8Array(path.length + 1); let entered = false;
        for (let i = 0; i <= path.length; i++) {
            if (token.kind === "star" || token.kind === "glob") next[i] = state[i]! || (i > 0 && next[i - 1] && (token.kind === "glob" || path[i - 1] !== "/") ? 1 : 0);
            else if (token.kind === "directory") { entered ||= !!state[i]; next[i] = state[i]! || (entered && i > 0 && path[i - 1] === "/" ? 1 : 0); }
            else if (i && state[i - 1]) {
                const c = path[i - 1]!, code = c.charCodeAt(0);
                next[i] = token.kind === "literal" ? Number(c === token.value) : token.kind === "any" ? Number(c !== "/") :
                    Number(c !== "/" && token.ranges.some(([from, to]) => code >= from && code <= to) !== token.negate);
            }
        }
        state = next;
    }
    return !!state[path.length];
}
export function compileLspSelector(value: unknown, pathForUri: LspUriPath = lspUriPath): LspSelector {
    if (value === null) return () => true;
    if (!Array.isArray(value) || value.length > 32) invalid();
    const filters = value.map((input: unknown) => {
        const filter = typeof input === "string" ? { language: input } : input;
        if (!isRecord(filter) || "notebook" in filter || !["language", "scheme", "pattern"].some(key => key in filter)) invalid();
        for (const key of ["language", "scheme", "pattern"]) if (key in filter && (typeof filter[key] !== "string" || !filter[key] || (filter[key] as string).length > 256)) invalid();
        const patterns = filter.pattern === undefined ? undefined : alternatives(filter.pattern as string).map(tokens);
        return (document: LspSelectorDocument): boolean => {
            if (filter.language !== undefined && filter.language !== "*" && filter.language !== document.languageId) return false;
            if (filter.scheme !== undefined && filter.scheme !== "*" && String(filter.scheme).toLowerCase() !== document.uri.slice(0, document.uri.indexOf(":")).toLowerCase()) return false;
            if (!patterns) return true;
            const path = pathForUri(document.uri); if (typeof path !== "string" || path.length > 4096) invalidRange("selector path length");
            return patterns.some(pattern => matches(pattern, path));
        };
    });
    return document => filters.some(filter => filter(document));
}
