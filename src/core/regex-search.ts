import { codeWordConstituentPattern } from "./words.ts";
/** Pure matching kernel for a dedicated worker, never a main-thread cooperative cursor.
 * Native matching can take unbounded time in one next() call; the owner must terminate
 * its worker on cancellation/timeout. Raw strings retain exact UTF-16 source offsets. */
export type RegexMatch = Readonly<{ from: number; to: number; captures: readonly (string | undefined)[];
    groups: Readonly<Record<string, string | undefined>> | undefined }>;

export function regexExpression(pattern: string, matchCase = true, wholeWord = false): RegExp {
    if (typeof pattern !== "string" || typeof matchCase !== "boolean" || typeof wholeWord !== "boolean") throw new TypeError("Invalid regex search options.");
    // Wrap before native matching so alternatives/backtracking can reach a valid boundary.
    const source = wholeWord ? `(?<!${codeWordConstituentPattern})(?:${pattern})(?!${codeWordConstituentPattern})` : pattern;
    return new RegExp(source, matchCase ? "gmu" : "gimu");
}
export function* regexMatches(text: string, pattern: string, matchCase = true, wholeWord = false, from = 0): Generator<RegexMatch> {
    if (typeof text !== "string") throw new TypeError("Invalid regex search input.");
    if (!Number.isSafeInteger(from) || from < 0 || from > text.length || from > 0 && from < text.length && /^[\ud800-\udbff][\udc00-\udfff]$/.test(text.slice(from - 1, from + 1))) throw new RangeError("Invalid regex start offset.");
    // The platform iterator handles Unicode zero-width progression, including EOF.
    // Multiline anchors match editor lines; dot still requires an explicit class to cross lines.
    const expression = regexExpression(pattern, matchCase, wholeWord);
    expression.lastIndex = from;
    for (const match of text.matchAll(expression)) yield Object.freeze({ from: match.index, to: match.index + match[0].length,
        captures: Object.freeze(match.slice(1)), groups: match.groups === undefined ? undefined : Object.freeze({ ...match.groups }) });
}

/** Native replacement-string substitutions without executing the expression a second time.
 * The worker owns the complete captured input; prefix/suffix substitutions are explicit bulk work.
 * The controller must bound planned output before publishing a transaction. */
export function regexReplacement(text: string, match: RegexMatch, replacement: string, maxUnits = Number.MAX_SAFE_INTEGER): string {
    if (typeof replacement !== "string") throw new TypeError("Expected replacement text.");
    if (!Number.isSafeInteger(maxUnits) || maxUnits < 0) throw new RangeError("Invalid regex replacement budget.");
    let result = "";
    const append = (value: string) => { if (value.length > maxUnits - result.length) throw new RangeError("Regex replacement output limit exceeded."); result += value; };
    const source = (from: number, to: number) => { if (to - from > maxUnits - result.length) throw new RangeError("Regex replacement output limit exceeded."); append(text.slice(from, to)); };
    for (let i = 0; i < replacement.length; i++) {
        const unit = replacement[i]!;
        if (unit !== "$" || i + 1 === replacement.length) { append(unit); continue; }
        const next = replacement[i + 1]!;
        if (next === "$") { append("$"); i++; }
        else if (next === "&") { source(match.from, match.to); i++; }
        else if (next === "`") { source(0, match.from); i++; }
        else if (next === "'") { source(match.to, text.length); i++; }
        else if (next === "<" && match.groups !== undefined) {
            const end = replacement.indexOf(">", i + 2);
            if (end < 0) append("$");
            else { const name = replacement.slice(i + 2, end); append(Object.hasOwn(match.groups, name) ? match.groups[name] ?? "" : ""); i = end; }
        } else if (next >= "0" && next <= "9") {
            const first = Number(next), following = replacement[i + 2], second = following !== undefined && following >= "0" && following <= "9" ? first * 10 + Number(following) : -1;
            if (second > 0 && second <= match.captures.length) { append(match.captures[second - 1] ?? ""); i += 2; }
            else if (first > 0 && first <= match.captures.length) { append(match.captures[first - 1] ?? ""); i++; }
            else append("$");
        } else append("$");
    }
    return result;
}
