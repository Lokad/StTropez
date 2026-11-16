import type { InlineDecoration, PresentedLine } from "../../../src/browser/index.ts";
import type { SearchMatch } from "../../../src/index.ts";
import { tokenizeLine } from "../../../fixtures/language/provider.ts";
import type { Token } from "../../../fixtures/language/provider.ts";
import type { DomainAnnotationIndex } from "../../../fixtures/language/domain.ts";

/** Bounded development lexer cache: unchanged visible line fragments reuse local token offsets. */
export class EditingPresentation {
    private readonly cache = new Map<number, Readonly<{ text: string; tokens: readonly Token[] }>>();
    private lexedLines = 0;
    private lexedUnits = 0;
    search: Readonly<{ revision: number; ranges: readonly SearchMatch[] }> | undefined;
    diagnostics: Readonly<{ revision: number; ranges: readonly SearchMatch[] }> | undefined;
    domain: Readonly<{ revision: number; index: DomainAnnotationIndex }> | undefined;
    colors: Readonly<{ revision: number; index: DomainAnnotationIndex }> | undefined;
    readonly decorate = (line: PresentedLine): readonly InlineDecoration[] => {
        let cached = this.cache.get(line.line);
        if (!cached || cached.text !== line.text) { cached = { text: line.text, tokens: tokenizeLine(line.text) }; this.lexedLines++; this.lexedUnits += line.text.length; }
        this.cache.delete(line.line); this.cache.set(line.line, cached);
        if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
        const decorations: InlineDecoration[] = cached.tokens.map(token => ({ from: line.from + token.from, to: line.from + token.to, className: `st-token-${token.kind}` }));
        for (const [snapshot, className] of [[this.search, "st-search-match"], [this.diagnostics, "st-diagnostic"]] as const) {
            if (snapshot?.revision === line.revision) for (const range of snapshot.ranges) if (range.from < line.to && range.to > line.from) decorations.push({ ...range, className });
        }
        if (this.domain?.revision === line.revision) for (const range of this.domain.index.query(line.from, line.to)) decorations.push({ from: range.from, to: range.to, className: "st-domain-note" });
        if (this.colors?.revision === line.revision) for (const range of this.colors.index.query(line.from, line.to)) decorations.push({ from: range.from, to: range.to, className: "st-document-color" });
        return decorations;
    };
    snapshot() { return { cachedLines: this.cache.size, lexedLines: this.lexedLines, lexedUnits: this.lexedUnits }; }
    clear(): void { this.cache.clear(); this.search = undefined; this.diagnostics = undefined; this.domain = undefined; this.colors = undefined; }
}
