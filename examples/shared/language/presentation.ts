import type { InlineDecoration, PresentedLine } from "../../../src/browser/index.ts";
import { tokenizeLine } from "../../../fixtures/language/provider.ts";
import type { Token } from "../../../fixtures/language/provider.ts";

/** Bounded development lexer cache: unchanged visible line fragments reuse local token offsets. */
export class EditingPresentation {
    private readonly cache = new Map<number, Readonly<{ text: string; tokens: readonly Token[] }>>();
    private lexedLines = 0;
    private lexedUnits = 0;
    readonly decorate = (line: PresentedLine): readonly InlineDecoration[] => {
        let cached = this.cache.get(line.line);
        if (!cached || cached.text !== line.text) { cached = { text: line.text, tokens: tokenizeLine(line.text) }; this.lexedLines++; this.lexedUnits += line.text.length; }
        this.cache.delete(line.line); this.cache.set(line.line, cached);
        if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
        return cached.tokens.map(token => ({ from: line.from + token.from, to: line.from + token.to, className: `st-token-${token.kind}` }));
    };
    snapshot() { return { cachedLines: this.cache.size, lexedLines: this.lexedLines, lexedUnits: this.lexedUnits }; }
    clear(): void { this.cache.clear(); }
}
