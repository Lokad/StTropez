import { regexExpression, regexMatches, regexReplacement } from "../core/regex-search.ts";
import type { TextEdit } from "../core/changes.ts";
export const regexChunkUnits = 32768;
export const regexSourceLimit = 32 * 1024 * 1024;
export const regexMatchLimit = 1_000_000;
export type RegexRange = Readonly<{ from: number; to: number }>;
export type RegexReply = Readonly<{ operation: "regex-progress"; id: number; revision: number; received: number }>
    | Readonly<{ operation: "regex-matches"; id: number; revision: number; matches: readonly RegexRange[] }>
    | Readonly<{ operation: "regex-edits"; id: number; revision: number; edits: readonly TextEdit[] }>
    | Readonly<{ operation: "regex-edit"; id: number; revision: number; ordinal: number; from: number; to: number; units: number }>
    | Readonly<{ operation: "regex-insert"; id: number; revision: number; ordinal: number; from: number; text: string }>
    | Readonly<{ operation: "regex-done"; id: number; revision: number; count: number; outputLength?: number }>
    | Readonly<{ operation: "regex-error"; id: number; revision: number; message: string }>;
type Request = { id: number; revision: number; length: number; pattern: string; matchCase: boolean; wholeWord: boolean; received: number; parts: string[];
    replacement: string | undefined; range: RegexRange | undefined; maxOutputUnits: number };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** One captured input per worker lane. Acknowledgements let the client bound queued transfer.
 * Text is joined only in the worker, preserving cross-chunk patterns and lookbehind. */
export class RegexSession {
    private request: Request | undefined;
    private generation = 0;
    private readonly matchLimit: number;
    constructor(matchLimit = regexMatchLimit) {
        if (!Number.isSafeInteger(matchLimit) || matchLimit <= 0) throw new RangeError("Invalid regex match limit.");
        this.matchLimit = matchLimit;
    }
    *receive(value: unknown): Generator<RegexReply> {
        if (!record(value)) { if (this.request) yield this.fail("Malformed regex request."); return; }
        if (value.operation === "regex-start") {
            this.generation++; this.request = undefined;
            if (!integer(value.id) || value.id === 0 || !integer(value.revision)) return;
            const error = (message: string): RegexReply => ({ operation: "regex-error", id: value.id as number, revision: value.revision as number, message });
            if (!integer(value.length) || value.length > regexSourceLimit || typeof value.pattern !== "string" || value.pattern.length > 4096 || typeof value.matchCase !== "boolean"
                || value.wholeWord !== undefined && typeof value.wholeWord !== "boolean") {
                yield error("Regex input exceeds the supported source/pattern bounds."); return;
            }
            const wholeWord = value.wholeWord === true;
            if (value.replacement !== undefined && (typeof value.replacement !== "string" || value.replacement.length > regexChunkUnits)
                || value.maxOutputUnits !== undefined && (!integer(value.maxOutputUnits) || value.maxOutputUnits > regexSourceLimit)
                || value.range !== undefined && (value.replacement === undefined || !record(value.range) || !integer(value.range.from) || !integer(value.range.to) || value.range.to < value.range.from || value.range.to > value.length)) {
                yield error("Invalid regex replacement capture or output budget."); return;
            }
            try { regexExpression(value.pattern, value.matchCase, wholeWord); }
            catch { yield error("Invalid regular expression."); return; }
            this.request = { id: value.id, revision: value.revision, length: value.length, pattern: value.pattern, matchCase: value.matchCase, wholeWord, received: 0, parts: [],
                replacement: value.replacement as string | undefined, range: value.range === undefined ? undefined : { from: (value.range as RegexRange).from, to: (value.range as RegexRange).to }, maxOutputUnits: value.maxOutputUnits as number | undefined ?? regexSourceLimit };
            yield { operation: "regex-progress", id: value.id, revision: value.revision, received: 0 }; return;
        }
        const request = this.request;
        if (!request) return;
        if (!integer(value.id) || !integer(value.revision)) { yield this.fail("Malformed regex request."); return; }
        if (value.id !== request.id || value.revision !== request.revision) return;
        if (value.operation === "regex-chunk") {
            if (value.from !== request.received || typeof value.text !== "string" || !value.text.length || value.text.length > regexChunkUnits || request.received + value.text.length > request.length) {
                yield this.fail("Invalid or out-of-order regex source chunk."); return;
            }
            request.parts.push(value.text); request.received += value.text.length;
            yield { operation: "regex-progress", id: request.id, revision: request.revision, received: request.received }; return;
        }
        if (value.operation !== "regex-run" || request.received !== request.length) { yield this.fail("Incomplete regex source capture."); return; }
        const generation = this.generation, text = request.parts.join(""); request.parts = [];
        if (request.range) for (const at of [request.range.from, request.range.to]) if (at > 0 && at < text.length && /^[\ud800-\udbff][\udc00-\udfff]$/.test(text.slice(at - 1, at + 1))) {
            yield this.fail("Captured regex range splits a Unicode character."); return;
        }
        let count = 0, page: RegexRange[] = [], edits: TextEdit[] = [], pageUnits = 0, inserted = 0, outputLength = text.length;
        for (const match of regexMatches(text, request.pattern, request.matchCase, request.wholeWord, request.range?.from ?? 0)) {
            if (this.generation !== generation) return;
            if (request.range && (match.from !== request.range.from || match.to !== request.range.to)) break;
            if (++count > this.matchLimit) { yield this.fail("Regex match limit exceeded; narrow the expression."); return; }
            if (request.replacement === undefined) {
                page.push(Object.freeze({ from: match.from, to: match.to }));
                if (page.length === 512) { yield { operation: "regex-matches", id: request.id, revision: request.revision, matches: Object.freeze(page) }; page = []; }
            } else {
                let insert: string;
                try { insert = regexReplacement(text, match, request.replacement, request.maxOutputUnits - inserted); }
                catch (error) { yield this.fail(error instanceof Error ? error.message : "Regex replacement failed."); return; }
                inserted += insert.length; outputLength += insert.length - (match.to - match.from);
                if (edits.length && (insert.length > regexChunkUnits - pageUnits || edits.length === 512)) {
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
    private fail(message: string): RegexReply {
        const request = this.request!; this.request = undefined; this.generation++;
        return { operation: "regex-error", id: request.id, revision: request.revision, message };
    }
}
