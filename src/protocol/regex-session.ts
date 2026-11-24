import { regexExpression, regexMatches, regexRanges, regexReplacement } from "../core/regex-search.ts";
import type { RegexMatch } from "../core/regex-search.ts";
import type { TextEdit } from "../core/changes.ts";
import { splitsSurrogatePair } from "../core/utf16.ts";
import { regexProtocolVersion, regexChunkUnits, regexSourceLimit, regexPageLimit, regexErrorLimit, regexRecord, regexIdentity, regexChunk, readRegexStart } from "./regex.ts";
import type { RegexRange, RegexReply } from "./regex.ts";
type Request = { id: number; source: number; revision: number; length: number; pattern: string; matchCase: boolean; wholeWord: boolean; received: number; parts: string[];
    replacement: string | undefined; range: RegexRange | undefined; maxOutputUnits: number };

/** One captured input per worker lane. Acknowledgements let the client bound queued transfer.
 * Text is joined only in the worker, preserving cross-chunk patterns and lookbehind. */
export class RegexSession {
    private request: Request | undefined;
    private source: { id: number; revision: number; text: string } | undefined;
    private generation = 0;
    *receive(value: unknown): Generator<RegexReply> {
        if (!regexRecord(value)) { if (this.request) yield this.fail("Malformed regex request."); return; }
        if (value.operation === "regex-start") {
            this.generation++; this.request = undefined;
            if (!regexIdentity(value) || value.id === 0) return;
            const error = (message: string): RegexReply => ({ operation: "regex-error", id: value.id, revision: value.revision, message });
            let start: ReturnType<typeof readRegexStart>;
            try { start = readRegexStart(value); }
            catch (cause) { yield error((cause as Error).message); return; }
            const wholeWord = start.wholeWord === true;
            try { regexExpression(start.pattern, start.matchCase, wholeWord); }
            catch (cause) {
                // Engines may include the entire pattern before the syntax error.
                const detail = cause instanceof SyntaxError
                    ? cause.message.replace(/^Invalid regular expression:\s*(?:\/[\s\S]*\/[a-z]+:\s*)?/i, "").trim() : "";
                yield error(detail ? ("Invalid regular expression: " + detail).slice(0, regexErrorLimit) : "Invalid regular expression.");
                return;
            }
            const retained = this.source?.id === start.source && this.source.revision === start.revision && this.source.text.length === start.length;
            if (!retained) this.source = undefined;
            const received = retained ? start.length : 0;
            this.request = { id: start.id, source: start.source, revision: start.revision, length: start.length, pattern: start.pattern, matchCase: start.matchCase, wholeWord, received, parts: [],
                replacement: start.replacement, range: start.range === undefined ? undefined : { from: start.range.from, to: start.range.to }, maxOutputUnits: start.maxOutputUnits ?? regexSourceLimit };
            yield { operation: "regex-progress", id: value.id, revision: value.revision, received, version: regexProtocolVersion }; return;
        }
        const request = this.request;
        if (!request) return;
        if (!regexIdentity(value)) { yield this.fail("Malformed regex request."); return; }
        if (value.id !== request.id || value.revision !== request.revision) return;
        if (value.operation === "regex-chunk") {
            if (!regexChunk(value) || value.from !== request.received || request.received + value.text.length > request.length) {
                yield this.fail("Invalid or out-of-order regex source chunk."); return;
            }
            request.parts.push(value.text); request.received += value.text.length;
            yield { operation: "regex-progress", id: request.id, revision: request.revision, received: request.received }; return;
        }
        if (value.operation !== "regex-run" || request.received !== request.length) { yield this.fail("Incomplete regex source capture."); return; }
        const generation = this.generation, text = this.source?.text ?? request.parts.join(""); request.parts = [];
        this.source = { id: request.source, revision: request.revision, text };
        if (request.range) for (const at of [request.range.from, request.range.to]) if (splitsSurrogatePair(text, at)) {
            yield this.fail("Captured regex range splits a Unicode character."); return;
        }
        let count = 0, page: RegexRange[] = [], edits: TextEdit[] = [], pageUnits = 0, inserted = 0, outputLength = text.length;
        const matches: Generator<RegexRange | RegexMatch> = request.replacement === undefined
            ? regexRanges(text, request.pattern, request.matchCase, request.wholeWord, request.range?.from ?? 0)
            : regexMatches(text, request.pattern, request.matchCase, request.wholeWord, request.range?.from ?? 0);
        for (const match of matches) {
            if (this.generation !== generation) return;
            if (request.range && (match.from !== request.range.from || match.to !== request.range.to)) break;
            count++;
            if (!("captures" in match)) {
                page.push(match);
                if (page.length === regexPageLimit) { yield { operation: "regex-matches", id: request.id, revision: request.revision, matches: Object.freeze(page) }; page = []; }
            } else {
                let insert: string;
                // Only the replacement iterator produces captured matches.
                try { insert = regexReplacement(text, match, request.replacement!, request.maxOutputUnits - inserted); }
                catch (error) { yield this.fail(error instanceof Error ? error.message : "Regex replacement failed."); return; }
                inserted += insert.length; outputLength += insert.length - (match.to - match.from);
                if (edits.length && (insert.length > regexChunkUnits - pageUnits || edits.length === regexPageLimit)) {
                    yield { operation: "regex-edits", id: request.id, revision: request.revision, edits: Object.freeze(edits) }; edits = []; pageUnits = 0;
                    if (this.generation !== generation) return;
                }
                if (insert.length > regexChunkUnits) {
                    yield { operation: "regex-edit", id: request.id, revision: request.revision, ordinal: count - 1, from: match.from, to: match.to, units: insert.length };
                    for (let from = 0; from < insert.length; from += regexChunkUnits) {
                        if (this.generation !== generation) return;
                        yield { operation: "regex-insert", id: request.id, revision: request.revision, ordinal: count - 1, from, text: insert.slice(from, from + regexChunkUnits) };
                    }
                } else { edits.push(Object.freeze({ from: match.from, to: match.to, insert })); pageUnits += insert.length; }
            }
            if (request.range) break;
        }
        if (this.generation !== generation) return;
        if (page.length) yield { operation: "regex-matches", id: request.id, revision: request.revision, matches: Object.freeze(page) };
        if (edits.length) yield { operation: "regex-edits", id: request.id, revision: request.revision, edits: Object.freeze(edits) };
        if (this.generation !== generation) return;
        if (request.range && count !== 1) { yield this.fail("Captured regex match no longer qualifies."); return; }
        if (outputLength > regexSourceLimit) { yield this.fail("Regex result exceeds the supported document size."); return; }
        this.request = undefined; yield { operation: "regex-done", id: request.id, revision: request.revision, count,
            ...(request.replacement === undefined ? {} : { outputLength }) };
    }
    /** The worker boundary uses the captured request, never the latest incoming message. */
    abort(): RegexReply | undefined {
        return this.request ? this.fail("Regex search failed; editing remains available.") : undefined;
    }
    private fail(message: string): RegexReply {
        const request = this.request!; this.request = undefined; this.source = undefined; this.generation++;
        return { operation: "regex-error", id: request.id, revision: request.revision, message };
    }
}
