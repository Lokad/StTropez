import { regexMatches, regexRanges, regexReplacement } from "../core/regex-search.ts";
import { splitsSurrogatePair } from "../core/utf16.ts";
import { isPositiveInteger } from "../core/bounds.ts";
import { regexErrorLimit, regexIdentity, regexOptions, regexOutputLimit, regexProtocolVersion, regexQuery } from "./regex.ts";
import type { RegexReply, RegexRequest, RegexResult } from "./regex.ts";

function run(request: RegexRequest, text: string): RegexResult {
    const { pattern, matchCase, wholeWord, range, replacement } = request;
    const offsets: number[] = [];
    if (replacement === undefined) {
        for (const at of regexRanges(text, pattern, matchCase, wholeWord)) offsets.push(at.from, at.to);
        return { operation: "regex-matches", offsets: Uint32Array.from(offsets) };
    }
    const limit = regexOutputLimit(text.length, request);
    const parts: string[] = [];
    let inserted = 0;
    const matches = range && splitsSurrogatePair(text, range.from) ? []
        : regexMatches(text, pattern, matchCase, wholeWord, range?.from);
    for (const match of matches) {
        if (range && (match.from !== range.from || match.to !== range.to)) break;
        const insert = regexReplacement(text, match, replacement, limit - inserted);
        inserted += insert.length;
        offsets.push(match.from, match.to, inserted);
        if (insert) parts.push(insert);
        if (range) break;
    }
    return { operation: "regex-edits", offsets: Uint32Array.from(offsets), insertions: parts.join("") };
}

export class RegexSession {
    private source: { id: number; revision: number; text: string } | undefined;

    receive(value: unknown): RegexReply | undefined {
        if (!regexIdentity(value)) return;
        const { id, revision } = value;
        const version = regexProtocolVersion;
        try {
            if (value.version !== version) throw new RangeError("Unsupported regex worker protocol version.");
            const request = value as unknown as RegexRequest;
            if (!isPositiveInteger(request.source) || !regexQuery(request) || !regexOptions(request, request.length))
                throw new RangeError("Unsupported regex capture.");
            if (request.text !== undefined) {
                if (request.source !== id || typeof request.text !== "string" || request.text.length !== request.length)
                    throw new RangeError("Invalid regex source.");
                this.source = { id, revision, text: request.text };
            }
            const source = this.source;
            if (source?.id !== request.source || source.revision !== revision || source.text.length !== request.length)
                throw new RangeError("Regex source is no longer available.");
            return { id, revision, version, ...run(request, source.text) };
        } catch (cause) {
            this.source = undefined;
            let message = cause instanceof RangeError ? cause.message : "Regex search failed; editing remains available.";
            if (cause instanceof SyntaxError) {
                // Engines can repeat the whole pattern before the syntax error.
                const detail = cause.message.replace(/^Invalid regular expression:\s*(?:\/[\s\S]*\/[a-z]+:\s*)?/i, "").trim();
                message = detail ? "Invalid regular expression: " + detail : "Invalid regular expression.";
            }
            return { id, revision, version, operation: "regex-error", message: message.slice(0, regexErrorLimit) };
        }
    }
}
