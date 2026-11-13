import type { DocumentationContent } from "../core/documentation.ts";

export type DocumentationOptions = Readonly<{
    /** Opaque destinations are inert unless the host explicitly supplies an opening policy. */
    canOpenLink?: (target: string) => boolean;
    openLink?: (target: string) => void;
}>;
const escape = /\\([\\`*_[\]{}()#+.!<>~\-])/g;
const unescape = (value: string) => value.replace(escape, "$1");
const fence = (line: string) => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
const listItem = (line: string) => /^ {0,3}([-+*]|[0-9]{1,9}[.)])[ \t]+(.*)$/.exec(line);
const word = (value: string) => /[\p{L}\p{N}]/u.test(value);

/** Small documentation presentation, not a general Markdown engine. No HTML or automatic URLs. */
export function mountDocumentation(host: HTMLElement, options: DocumentationOptions = {}) {
    const owner = host.ownerDocument, element = owner.createElement("div"), events = new AbortController();
    element.className = "st-documentation"; host.append(element);
    let disposed = false, current: DocumentationContent | undefined, links = new WeakMap<HTMLButtonElement, string>();
    const node = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: Node, text?: string): HTMLElementTagNameMap[K] => {
        const child = owner.createElement(tag); if (text !== undefined) child.textContent = text; parent.appendChild(child); return child;
    };
    const code = (parent: Node, value: string, language: string) => {
        const body = node("code", node("pre", parent), value); if (language) body.dataset.language = language;
    };
    const inline = (parent: Node, value: string) => {
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
            const values = closing.get(token) ?? []; let low = 0, high = values.length;
            while (low < high) { const middle = (low + high) >>> 1; if (values[middle]! <= at) low = middle + 1; else high = middle; }
            const found = values[low]; return found !== undefined && found + token.length <= end ? found : undefined;
        };
        const render = (parent: Node, from: number, to: number, depth: number, allowLinks: boolean) => {
            if (depth >= 16) { parent.appendChild(owner.createTextNode(value.slice(from, to))); return; }
            let literal = "";
            const flush = () => { if (literal) { parent.appendChild(owner.createTextNode(literal)); literal = ""; } };
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
                            node("code", parent, text);
                        } else render(node(length === 2 ? "strong" : "em", parent), i + length, end, depth + 1, allowLinks);
                        i = end + length; continue;
                    }
                }
                if (allowLinks && char === "[" && value[i - 1] !== "!") {
                    const labelEnd = pairs.get(i), end = labelEnd === undefined ? undefined : pairs.get(labelEnd + 1);
                    if (labelEnd !== undefined && value[labelEnd + 1] === "(" && end !== undefined && end < to) {
                        const raw = value.slice(labelEnd + 2, end).trim();
                        const destination = /^(?:<([^<>\n]*)>|([^\s]+?))(?:[ \t]+(?:"([^"]*)"|'([^']*)'))?$/.exec(raw);
                        if (destination) {
                            flush(); const target = unescape(destination[1] ?? destination[2]!);
                            const active = !!options.openLink && (options.canOpenLink?.(target) ?? true);
                            const link = node(active ? "button" : "span", parent); link.className = "st-documentation-link"; link.title = destination[3] ?? destination[4] ?? target;
                            if (link instanceof owner.defaultView!.HTMLButtonElement) { link.type = "button"; links.set(link, target); }
                            render(link, i + 1, labelEnd, depth + 1, false); i = end + 1; continue;
                        }
                    }
                }
                // Runs not recognized by this subset remain literal in one step.
                const count = length ?? 1; literal += value.slice(i, Math.min(to, i + count)); i += count;
            }
            flush();
        };
        render(parent, 0, value.length, 0, true);
    };
    const markdown = (parent: Node, text: string) => {
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
                code(parent, body.join("\n"), language); continue;
            }
            const first = listItem(lines[i]!);
            if (first) {
                const ordered = /^[0-9]/.test(first[1]!), list = node(ordered ? "ol" : "ul", parent);
                if (ordered) (list as HTMLOListElement).start = Number.parseInt(first[1]!, 10);
                while (i < lines.length) {
                    const item = listItem(lines[i]!); if (!item || /^[0-9]/.test(item[1]!) !== ordered) break;
                    const body = [item[2]!]; i++;
                    while (i < lines.length && /^(?: {2,}|\t)\S/.test(lines[i]!) && !listItem(lines[i]!) && !fence(lines[i]!)) body.push(lines[i++]!.trimStart());
                    inline(node("li", list), body.join("\n"));
                }
                continue;
            }
            const body = [lines[i++]!];
            while (i < lines.length && lines[i]!.trim() && !fence(lines[i]!) && !listItem(lines[i]!)) body.push(lines[i++]!);
            inline(node("p", parent), body.join("\n"));
        }
    };
    element.addEventListener("click", event => {
        const target = (event.target as Element).closest("button"), destination = target ? links.get(target) : undefined;
        if (disposed || destination === undefined || !element.contains(target) || options.canOpenLink && !options.canOpenLink(destination)) return;
        event.preventDefault(); options.openLink?.(destination);
    }, { signal: events.signal });
    return Object.freeze({ element,
        setContent: (content: DocumentationContent) => {
            if (disposed || content === current) return;
            const fragment = owner.createDocumentFragment(); links = new WeakMap();
            for (const part of content) {
                if (part.kind === "code") code(fragment, part.value, part.language);
                else if (part.kind === "markdown") markdown(fragment, part.value);
                else { const plain = node("p", fragment, part.value); plain.className = "st-documentation-plain"; }
            }
            current = content; element.replaceChildren(fragment);
        },
        dispose: () => { if (disposed) return; disposed = true; events.abort(); links = new WeakMap(); current = undefined; element.remove(); } });
}
export type DocumentationView = ReturnType<typeof mountDocumentation>;
