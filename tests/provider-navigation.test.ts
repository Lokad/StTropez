import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer } from "../src/index.ts";
import { NavigationSession, navigationLimits, navigationSymbol, validateNavigationInput, validateNavigationResult } from "../examples/probes/navigation.ts";
import type { NavigationInput } from "../examples/probes/navigation.ts";
const capture = (texts: readonly string[], kind: NavigationInput["kind"] = "references", includeDeclaration = true) => validateNavigationInput({ operation: "navigation-start", id: 3, kind, symbol: "café", includeDeclaration, delay: 0,
    documents: texts.map((text, i) => ({ document: `doc-${i}`, revision: 7 + i, length: text.length })) });
function run(texts: readonly string[], kind: NavigationInput["kind"] = "references", includeDeclaration = true, budget = 3, name = "café") {
    const input = { ...capture(texts, kind, includeDeclaration), symbol: name }, session = new NavigationSession(input);
    texts.forEach((text, i) => { const document = input.documents[i]!.document; session.handle({ operation: "navigation-document", id: input.id, document });
        for (let from = 0; from < text.length; from += budget) session.handle({ operation: "navigation-chunk", id: input.id, document, from, text: text.slice(from, from + budget) });
        session.handle({ operation: "navigation-end-document", id: input.id, document }); });
    const buffers = new Map(texts.map((text, i) => [`doc-${i}`, TextBuffer.from(text)]));
    return { result: validateNavigationResult(session.handle({ operation: "navigation-finish", id: input.id }), input, buffers), input, buffers };
}
test("streamed project navigation retains raw Unicode/CRLF ranges, declarations and comment/string policy across every boundary", () => {
    const texts = ['\ufeffconst /* declaration */ café = "café";\r\ncafé; // café\r\n`café ${café}`; othercafé;', "function café() { return café; }\r\n'escaped\\\'café'; /* café */"], expected = texts.flatMap((text, i) => {
        const starts = i === 0 ? [text.indexOf("café"), text.indexOf("\r\ncafé") + 2] : [9, text.indexOf("return café") + 7];
        return starts.map((from, ordinal) => ({ document: `doc-${i}`, revision: 7 + i, from, to: from + 5, declaration: ordinal === 0 }));
    });
    for (const budget of [1, 2, 3, 7, 16384]) {
        const all = run(texts, "references", true, budget); assert.deepEqual(all.result.locations, expected); assert.ok(Object.isFrozen(all.result.locations[0]));
        assert.deepEqual(run(texts, "definition", true, budget).result.locations, expected.filter(at => at.declaration));
        assert.deepEqual(run(texts, "references", false, budget).result.locations, expected.filter(at => !at.declaration));
    }
    const astral = "const 𐐀value = 1;\r\n𐐀value"; for (const budget of [1, 2, 3]) assert.deepEqual(run([astral], "references", true, budget, "𐐀value").result.locations.map(at => at.from), [6, 20]);
});
test("captured symbol lookup is bounded on huge lines and rejects a cut or oversized symbol", () => {
    const buffer = TextBuffer.from("x".repeat(2400000) + " café 𐐀value"), offset = 2400004;
    assert.equal(navigationSymbol(buffer, offset), "café"); assert.equal(navigationSymbol(buffer, buffer.length), "𐐀value"); assert.equal(navigationSymbol(buffer, 1000000), undefined);
    assert.equal(buffer.readMetrics().textExports, 0);
});
test("result bounds are explicit, not silent missing declarations or unbounded retained text", () => {
    const text = "const café = 1;\ncafé;\n".repeat(1100), { result } = run([text], "references", true, 16384);
    assert.equal(result.locations.length, navigationLimits.locations); assert.equal(result.truncated, true);
    assert.equal(run(["x".repeat(1000000) + " café "], "references", true, 16384).result.locations.length, 1);
    assert.equal(run(["café".repeat(10000)], "references", true, 16384).result.locations.length, 0);
});
test("worker session rejects duplicate/out-of-order, oversized and incomplete transfers", () => {
    const input = capture(["café"]), make = () => new NavigationSession(input), session = make(), start = { operation: "navigation-document", id: input.id, document: "doc-0" };
    assert.throws(() => make().handle({ operation: "navigation-finish", id: input.id }), /Incomplete/); session.handle(start); assert.throws(() => session.handle(start), /order/);
    for (const message of [{ operation: "navigation-chunk", id: input.id, document: "doc-0", from: 1, text: "x" }, { operation: "navigation-chunk", id: input.id, document: "doc-0", from: 0, text: "x".repeat(16385) }, { operation: "navigation-end-document", id: input.id, document: "doc-0" }, { ...start, id: 4 }]) assert.throws(() => session.handle(message));
    for (const value of [{ ...input, documents: [...input.documents, ...input.documents] }, { ...input, documents: [{ document: "big", revision: 0, length: navigationLimits.sourceUnits + 1 }] }, { ...input, symbol: "x".repeat(257) }, { ...input, symbol: "a b" }, { ...input, delay: NaN }]) assert.throws(() => validateNavigationInput(value));
});
test("complete result validation rejects malformed final locations, reordered revisions and split symbols before publication", () => {
    const texts = ["const café = 1;\ncafé;", "café"], { result, input, buffers } = run(texts), first = result.locations[0]!;
    for (const value of [{ ...result, id: 99 }, { ...result, truncated: true }, { ...result, locations: [...result.locations, { ...first, document: "unknown" }] }, { ...result, locations: [{ ...first, revision: 99 }] },
        { ...result, locations: [first, first] }, { ...result, locations: [...result.locations].reverse() }, { ...result, locations: [{ ...first, to: 999 }] }]) assert.throws(() => validateNavigationResult(value, input, buffers));
    const forged = { ...capture(["xcafé"]), symbol: "café" }; assert.throws(() => validateNavigationResult({ operation: "navigation-result", id: 3, truncated: false, locations: [{ document: "doc-0", revision: 7, from: 1, to: 6, declaration: false }] }, forged, new Map([["doc-0", TextBuffer.from("xcafé")]])), /splits/);
});
