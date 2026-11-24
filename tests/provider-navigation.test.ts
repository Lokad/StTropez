import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer } from "../src/index.ts";
import { SymbolScanner, navigationSymbol } from "../fixtures/language/navigation.ts";
import type { LspNavigationRequest } from "../src/protocol/index.ts";
function run(texts: readonly string[], kind: LspNavigationRequest["kind"] = "references", includeDeclaration = true, budget = 3, name = "café") {
    const locations: { document: string; revision: number; from: number; to: number; declaration: boolean }[] = [];
    texts.forEach((text, i) => {
        const scanner = new SymbolScanner(name, (from, to, declaration) => {
            if (kind === "definition" ? !declaration : declaration && !includeDeclaration) return;
            locations.push({ document: `doc-${i}`, revision: 7 + i, from, to, declaration });
        });
        for (let from = 0; from < text.length; from += budget) scanner.chunk(text.slice(from, from + budget));
        scanner.finish();
    });
    return { result: { locations } };
}

test("streamed project navigation retains raw Unicode/CRLF ranges, declarations and comment/string policy across every boundary", () => {
    const texts = ['\ufeffconst /* declaration */ café = "café";\r\ncafé; // café\r\n`café ${café}`; othercafé;', "function café() { return café; }\r\n'escaped\\\'café'; /* café */"], expected = texts.flatMap((text, i) => {
        const starts = i === 0 ? [text.indexOf("café"), text.indexOf("\r\ncafé") + 2] : [9, text.indexOf("return café") + 7];
        return starts.map((from, ordinal) => ({ document: `doc-${i}`, revision: 7 + i, from, to: from + 5, declaration: ordinal === 0 }));
    });
    for (const budget of [1, 2, 3, 7, 16384]) {
        const all = run(texts, "references", true, budget); assert.deepEqual(all.result.locations, expected);
        assert.deepEqual(run(texts, "definition", true, budget).result.locations, expected.filter(at => at.declaration));
        assert.deepEqual(run(texts, "references", false, budget).result.locations, expected.filter(at => !at.declaration));
    }
    const astral = "const 𐐀value = 1;\r\n𐐀value"; for (const budget of [1, 2, 3]) assert.deepEqual(run([astral], "references", true, budget, "𐐀value").result.locations.map(at => at.from), [6, 20]);
});
test("captured symbol lookup is bounded on huge lines and rejects a cut or oversized symbol", () => {
    const buffer = TextBuffer.from("x".repeat(24_000) + " café 𐐀value"), offset = 24_004;
    assert.equal(navigationSymbol(buffer, offset), "café"); assert.equal(navigationSymbol(buffer, buffer.length), "𐐀value"); assert.equal(navigationSymbol(buffer, 10_000), undefined);
    assert.equal(buffer.readMetrics().textExports, 0);
});
test("oversized lexical tokens do not hide later symbols or retain unbounded token text", () => {
    assert.equal(run(["x".repeat(32_768) + " café "], "references", true, 16384).result.locations.length, 1);
    assert.equal(run(["café".repeat(10000)], "references", true, 16384).result.locations.length, 0);
});
