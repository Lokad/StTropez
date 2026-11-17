import { partitionPoint } from "./bound-search.ts";

/** Provider/host content retains its format; literal text is never inferred to be Markdown. */
export type DocumentationPart = Readonly<{ kind: "plaintext" | "markdown"; value: string } | { kind: "code"; value: string; language: string }>;
export type DocumentationContent = readonly DocumentationPart[];

export type DocumentationInline = Readonly<{ kind: "text"; value: string } | { kind: "code"; value: string }
    | { kind: "em" | "strong"; children: readonly DocumentationInline[] }
    | { kind: "link"; target: string; title: string; children: readonly DocumentationInline[] }>;
export type DocumentationBlock = Readonly<{ kind: "plaintext"; value: string }
    | { kind: "paragraph"; children: readonly DocumentationInline[] }
    | { kind: "code"; value: string; language: string }
    | { kind: "list"; start: number | null; items: readonly (readonly DocumentationInline[])[] }>;

const escape = /\\([\\`*_[\]{}()#+.!<>~\-])/g;
const unescape = (value: string) => value.replace(escape, "$1");
const fence = (line: string) => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
const listItem = (line: string) => /^ {0,3}([-+*]|[0-9]{1,9}[.)])[ \t]+(.*)$/.exec(line);
const word = (value: string) => /[\p{L}\p{N}]/u.test(value);
const maxLinkDestinationUnits = 8192;

function parseInline(value: string): readonly DocumentationInline[] {
    // Index delimiters once. Unmatched punctuation must not repeatedly scan the rest of a
    // large provider response. Balanced destinations and code spans are independent of DOM.
    const lengths = new Map<number, number>(), closing = new Map<string, number[]>(), pairs = new Map<number, number>();
    const brackets: number[] = [], parentheses: number[] = [];
    for (let i = 0; i < value.length; i++) {
        const char = value[i]!;
        if (char === "\\" && i + 1 < value.length && /[\\*_[\]{}()#+.!<>~\-]/.test(value[i + 1]!)) { i++; continue; }
        if (char === "[") brackets.push(i);
        else if (char === "]" && brackets.length) pairs.set(brackets.pop()!, i);
        else if (char === "(") parentheses.push(i);
        else if (char === ")" && parentheses.length) pairs.set(parentheses.pop()!, i);
        if (char !== "`" && char !== "*" && char !== "_") continue;
        let end = i + 1; while (value[end] === char) end++;
        const length = end - i, token = value.slice(i, end); lengths.set(i, length);
        if (char === "`" || length <= 2 && i > 0 && !/\s/.test(value[i - 1]!) && !(char === "_" && word(value[i - 1]!) && word(value[end] ?? ""))) {
            const list = closing.get(token) ?? []; list.push(i); closing.set(token, list);
        }
        i = end - 1;
    }
    const next = (token: string, at: number, end: number) => {
        const values = closing.get(token) ?? [], low = partitionPoint(values.length, index => values[index]! <= at);
        const found = values[low]; return found !== undefined && found + token.length <= end ? found : undefined;
    };
    const parse = (from: number, to: number, depth: number, allowLinks: boolean): readonly DocumentationInline[] => {
        if (depth >= 16) return Object.freeze([Object.freeze({ kind: "text", value: value.slice(from, to) })]);
        const result: DocumentationInline[] = []; let literal = "";
        const flush = () => { if (literal) { result.push(Object.freeze({ kind: "text", value: literal })); literal = ""; } };
        for (let i = from; i < to;) {
            const char = value[i]!;
            if (char === "\\" && i + 1 < to && /[\\`*_[\]{}()#+.!<>~\-]/.test(value[i + 1]!)) { literal += value[i + 1]; i += 2; continue; }
            const length = lengths.get(i);
            if (length && (char === "`" || length <= 2 && i + length < to && !/\s/.test(value[i + length]!)
                && !(char === "_" && word(value[i - 1] ?? "") && word(value[i + length]!)))) {
                const end = next(value.slice(i, i + length), i, to);
                if (end !== undefined && end > i + length) {
                    flush();
                    if (char === "`") {
                        let text = value.slice(i + length, end).replace(/\r\n?|\n/g, " ");
                        if (text.startsWith(" ") && text.endsWith(" ") && /[^ ]/.test(text)) text = text.slice(1, -1);
                        result.push(Object.freeze({ kind: "code", value: text }));
                    } else result.push(Object.freeze({ kind: length === 2 ? "strong" : "em", children: parse(i + length, end, depth + 1, allowLinks) }));
                    i = end + length; continue;
                }
            }
            if (allowLinks && char === "[" && value[i - 1] !== "!") {
                const labelEnd = pairs.get(i), end = labelEnd === undefined ? undefined : pairs.get(labelEnd + 1);
                // Bound the raw span before slicing, trimming or matching it. Nested invalid
                // destinations otherwise rescan successively smaller document-sized suffixes.
                if (labelEnd !== undefined && value[labelEnd + 1] === "(" && end !== undefined && end < to && end - labelEnd - 2 <= maxLinkDestinationUnits) {
                    const raw = value.slice(labelEnd + 2, end).trim();
                    const destination = /^(?:<([^<>\n]*)>|([^\s]+?))(?:[ \t]+(?:"([^"]*)"|'([^']*)'))?$/.exec(raw);
                    if (destination) {
                        flush(); const target = unescape(destination[1] ?? destination[2]!);
                        result.push(Object.freeze({ kind: "link", target, title: destination[3] ?? destination[4] ?? target,
                            children: parse(i + 1, labelEnd, depth + 1, false) })); i = end + 1; continue;
                    }
                }
            }
            // Runs not recognized by this subset remain literal in one step.
            const count = length ?? 1; literal += value.slice(i, Math.min(to, i + count)); i += count;
        }
        flush(); return Object.freeze(result);
    };
    return parse(0, value.length, 0, true);
}

function parseMarkdown(text: string): readonly DocumentationBlock[] {
    const blocks: DocumentationBlock[] = [];
    const lines = text.split(/\r\n?|\n/); let i = 0;
    while (i < lines.length) {
        if (!lines[i]!.trim()) { i++; continue; }
        const opening = fence(lines[i]!);
        if (opening) {
            const delimiter = opening[1]!, language = opening[2]!.trim().split(/\s/)[0] ?? "", body: string[] = []; i++;
            for (; i < lines.length; i++) {
                const end = fence(lines[i]!);
                if (end && end[1]![0] === delimiter[0] && end[1]!.length >= delimiter.length && !end[2]!.trim()) { i++; break; }
                body.push(lines[i]!);
            }
            blocks.push(Object.freeze({ kind: "code", value: body.join("\n"), language })); continue;
        }
        const first = listItem(lines[i]!);
        if (first) {
            const ordered = /^[0-9]/.test(first[1]!), start = ordered ? Number.parseInt(first[1]!, 10) : null;
            const items: (readonly DocumentationInline[])[] = [];
            while (i < lines.length) {
                const item = listItem(lines[i]!); if (!item || /^[0-9]/.test(item[1]!) !== ordered) break;
                const body = [item[2]!]; i++;
                while (i < lines.length && /^(?: {2,}|\t)\S/.test(lines[i]!) && !listItem(lines[i]!) && !fence(lines[i]!)) body.push(lines[i++]!.trimStart());
                items.push(parseInline(body.join("\n")));
            }
            blocks.push(Object.freeze({ kind: "list", start, items: Object.freeze(items) })); continue;
        }
        const body = [lines[i++]!];
        while (i < lines.length && lines[i]!.trim() && !fence(lines[i]!) && !listItem(lines[i]!)) body.push(lines[i++]!);
        blocks.push(Object.freeze({ kind: "paragraph", children: parseInline(body.join("\n")) }));
    }
    return Object.freeze(blocks);
}

/** Internal presentation tree for the supported subset; parsing never invokes host policy. */
export function parseDocumentation(content: DocumentationContent): readonly DocumentationBlock[] {
    const blocks: DocumentationBlock[] = [];
    for (const part of content) {
        if (part.kind === "code") blocks.push(Object.freeze({ kind: "code", value: part.value, language: part.language }));
        else if (part.kind === "markdown") { for (const block of parseMarkdown(part.value)) blocks.push(block); }
        else blocks.push(Object.freeze({ kind: "plaintext", value: part.value }));
    }
    return Object.freeze(blocks);
}
