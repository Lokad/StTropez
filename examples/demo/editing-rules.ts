import type { LanguageConfiguration, TextBuffer } from "../../src/index.ts";

/** Conservative host rules. Compiler colors establish unchanged line starts; a bounded local
 * quote scan handles typing since analysis. Regexes, templates and uncertain prefixes stay literal. */
export class DemoEditingRules {
    private base: TextBuffer | undefined;
    private spans: Uint32Array = new Uint32Array();
    private current: TextBuffer | undefined;
    private prefix = 0;
    accept(buffer: TextBuffer, spans: Uint32Array): void { this.base = buffer; this.spans = spans; this.current = undefined; }
    clear(): void { this.base = undefined; this.current = undefined; this.spans = new Uint32Array(); }
    private spanAt(offset: number): number {
        let low = 0, high = this.spans.length / 3;
        while (low < high) {
            const middle = (low + high) >>> 1, at = middle * 3;
            if (this.spans[at]! + this.spans[at + 1]! <= offset) low = middle + 1; else high = middle;
        }
        return low * 3;
    }
    private context(buffer: TextBuffer, offset: number): "code" | "unknown" | "'" | '"' {
        if (this.current !== buffer) {
            this.current = buffer; this.prefix = this.base === buffer ? buffer.length : 0;
            if (this.base && this.base !== buffer) {
                const iterator = this.base.sharedEdge(buffer, "start")[Symbol.iterator]();
                try { for (let count = 0; count < 64; count++) { const step = iterator.next(); if (step.done) break; this.prefix = step.value; } }
                finally { iterator.return?.(); }
            }
        }
        // New lines created since analysis may still be proved from an unchanged line start.
        const start = buffer.offsetAt(buffer.lineAt(Math.min(offset, this.prefix)));
        if (offset - start > 4096) return "unknown";
        if (start && this.base) {
            const at = this.spanAt(start);
            if (this.spans[at]! < start && [1, 6, 7, 24].includes(this.spans[at + 2]!)) return "unknown";
        }
        const text = buffer.slice(start, offset); let quote: "'" | '"' | undefined, escaped = false;
        for (const char of text) {
            if (quote) {
                if (escaped) escaped = false;
                else if (char === "\\") escaped = true;
                else if (char === quote) quote = undefined;
            } else if (char === "/" || char === "`") return "unknown";
            else if (char === "'" || char === '"') quote = char;
        }
        return escaped ? "unknown" : quote ?? "code";
    }
    configuration(tabSize = 2, insertSpaces = true): LanguageConfiguration {
        return { tabSize, insertSpaces, lineComment: "//", blockComment: { open: "/*", close: "*/" },
            pairs: [{ open: "(", close: ")" }, { open: "[", close: "]" }, { open: "{", close: "}" }, { open: '"', close: '"' }, { open: "'", close: "'" }],
            allowPair: ({ buffer, from, pair, operation }) => {
                if (pair.open === "/*" && buffer === this.base) {
                    const at = this.spanAt(from);
                    return this.spans[at] === from && this.spans[at + 2] === 1;
                }
                const context = this.context(buffer, from);
                if (operation === "open" && pair.open === pair.close && /[\p{L}\p{N}_$]/u.test(buffer.slice(Math.max(0, from - 1), from))) return false;
                return context === "code" || operation === "close" && context === pair.close;
            },
            enter: ({ buffer, from, to }) => {
                if (this.context(buffer, from) !== "code") return { indent: 0 };
                const before = buffer.slice(Math.max(buffer.offsetAt(buffer.lineAt(from)), from - 256), from).trimEnd();
                const line = buffer.lineAt(to), end = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) - 1 : buffer.length;
                const after = buffer.slice(to, Math.min(end, to + 256)).trimStart();
                const close = { "{": "}", "[": "]", "(": ")" }[before.at(-1) ?? ""];
                return { indent: close ? 1 : 0, split: !!close && after.startsWith(close) };
            } };
    }
}
