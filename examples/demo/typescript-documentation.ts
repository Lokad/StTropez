import type ts from "typescript-demo";

type Span = { from: number; to: number };

// TypeScript splits JSDoc links into display parts even inside Markdown examples.
function codeSpans(text: string): Span[] {
    const spans: Span[] = [], ticks: Span[] = [];
    function finishParagraph() {
        const next: number[] = [], byLength = new Map<number, number>();
        for (let i = ticks.length - 1; i >= 0; i--) {
            const tick = ticks[i]!, length = tick.to - tick.from;
            next[i] = byLength.get(length) ?? -1; byLength.set(length, i);
        }
        for (let i = 0; i < ticks.length; i++) {
            const end = next[i]!;
            if (end > i) { spans.push({ from: ticks[i]!.from, to: ticks[end]!.to }); i = end; }
        }
        ticks.length = 0;
    }
    let fence: { delimiter: string; from: number } | undefined;
    for (const line of text.matchAll(/[^\n]+|\n/g)) {
        if (line[0] === "\n") {
            if (!fence && text[line.index - 1] === "\n") finishParagraph();
            continue;
        }
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line[0].trimEnd());
        if (fence) {
            if (marker && marker[1]!.startsWith(fence.delimiter) && !marker[2]) {
                spans.push({ from: fence.from, to: line.index + line[0].length }); fence = undefined;
            }
        } else if (marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
            finishParagraph(); fence = { delimiter: marker[1]!, from: line.index };
        } else if (!line[0].trim()) finishParagraph();
        else {
            for (const run of line[0].matchAll(/\\[\\`]|`+/g)) {
                if (run[0][0] === "`") ticks.push({ from: line.index + run.index, to: line.index + run.index + run[0].length });
            }
        }
    }
    finishParagraph();
    if (fence) spans.push({ from: fence.from, to: text.length });
    return spans;
}

function linkLabel(target: string, caption: string, code: boolean, markdown: boolean): string {
    const label = caption || target;
    if (!markdown || !label) return label;
    let formatted = label.replace(/[\\`*_\[\]<>]/g, "\\$&");
    if (code) {
        let length = 1;
        for (const run of label.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
        const delimiter = "`".repeat(length);
        formatted = delimiter + " " + label + " " + delimiter;
    }
    if (!/^https?:\/\//i.test(target)) return formatted;
    // The documentation view still applies the host's policy when deciding which links can open.
    const destination = target.replace(/[\\()<>]/g, char => "%" + char.charCodeAt(0).toString(16));
    return "[" + formatted + "](" + destination + ")";
}

export function typeScriptDocumentation(parts: readonly ts.SymbolDisplayPart[] = [], markdown = true, maximum = 4096): string {
    const raw = parts.map(part => part.text).join("");
    if (!parts.some(part => part.kind === "link")) return raw.slice(0, maximum);
    const literals = codeSpans(raw), output: string[] = [];
    let offset = 0, literal = 0;
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!, start = offset;
        offset += part.text.length;
        while (literal < literals.length && literals[literal]!.to <= start) literal++;
        if (part.kind !== "link" || !part.text.startsWith("{@") || (literals[literal]?.from ?? Infinity) <= start) {
            output.push(part.text); continue;
        }
        let target = "", caption = "";
        if (parts[i + 1]?.kind === "linkName") { target = parts[++i]!.text; offset += target.length; }
        if (parts[i + 1]?.kind === "linkText") { caption = parts[++i]!.text; offset += caption.length; }
        if (parts[i + 1]?.kind !== "link" || parts[i + 1]?.text !== "}") { output.push(raw.slice(start, offset)); continue; }
        i++; offset++;
        // An unresolved name or URL and its optional caption arrive in one linkText part.
        if (!target) {
            const match = /^(\S+)\s*(.*)$/s.exec(caption.trim());
            target = match?.[1] ?? ""; caption = match?.[2] ?? "";
        }
        output.push(linkLabel(target, caption.trim(), part.text.startsWith("{@linkcode"), markdown));
    }
    return output.join("").slice(0, maximum);
}
