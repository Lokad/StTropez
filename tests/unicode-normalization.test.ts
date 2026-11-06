import assert from "node:assert/strict";
import test from "node:test";
import { NormalizationLimitError, TextBuffer, createNormalizationCursor, normalizeText } from "../src/index.ts";
import type { NormalizationCursor, NormalizedText } from "../src/index.ts";
function finish(cursor: NormalizationCursor, budget = 256): NormalizedText {
    let previous = cursor.snapshot(); while (true) { const step = cursor.next(budget); assert.ok(step.workUnits - previous.workUnits <= budget + 512); assert.ok(Object.isFrozen(step)); if (step.status === "ready") return step.result!; assert.equal(step.status, "running"); assert.equal(step.result, null); previous = step; }
}

test("normalization reorders and composes while retaining noncontiguous UTF-16 provenance", () => {
    const source = TextBuffer.from("prefix A\u0315\u0300 suffix"), result = normalizeText(source, { from: 7, to: 10, form: "NFC" });
    assert.equal(result.text(), "À\u0315"); assert.equal(result.source, source); assert.equal(result.from, 7); assert.equal(result.to, 10); assert.equal(result.length, 2); assert.equal(result.utf16Length, 2);
    assert.deepEqual(result.at(0).sources, [{ from: 7, to: 8 }, { from: 9, to: 10 }]); assert.deepEqual(result.at(1).sources, [{ from: 8, to: 9 }]); assert.equal(source.readMetrics().textExports, 0);
    for (const value of [result, result.at(0), result.at(0).sources, result.at(0).sources[0]]) assert.ok(Object.isFrozen(value)); assert.equal(result.text(1, 2), "\u0315");
});

test("decomposition repeats origin spans and recomposition deduplicates the same original point", () => {
    const source = TextBuffer.from("éﬁ"), decomposed = normalizeText(source, { form: "NFKD" }); assert.equal(decomposed.text(), "e\u0301fi");
    assert.deepEqual(decomposed.at(0).sources, [{ from: 0, to: 1 }]); assert.deepEqual(decomposed.at(1).sources, [{ from: 0, to: 1 }]); assert.deepEqual(decomposed.at(2).sources, [{ from: 1, to: 2 }]); assert.deepEqual(decomposed.at(3).sources, [{ from: 1, to: 2 }]);
    const composed = normalizeText(source, { form: "NFKC" }); assert.equal(composed.text(), "éfi"); assert.deepEqual(composed.at(0).sources, [{ from: 0, to: 1 }]); assert.equal(composed.at(0).sources.length, 1);
});

test("canonical ordering is stable for equal classes and composition respects blockers", () => {
    for (const text of ["\u0315\u0300A", "A\u0305\u0301", "A\u0327\u0301", "A\u0301\u0300", "\u0344", "\u212b"]) for (const form of ["NFC", "NFD", "NFKC", "NFKD"] as const) assert.equal(normalizeText(TextBuffer.from(text), { form }).text(), text.normalize(form));
    const result = normalizeText(TextBuffer.from("\u0301\u0300"), { form: "NFD" }); assert.deepEqual(result.at(0).sources, [{ from: 0, to: 1 }]); assert.deepEqual(result.at(1).sources, [{ from: 1, to: 2 }]);
});

test("Hangul and canonical composition with a second class-zero point cross streaming boundaries", () => {
    for (const text of ["\u1100\u1161\u11a8", "각", "\u09c7\u09be", "ｶﾞ", "a".repeat(255) + "\u1100\u1161\u11a8"]) for (const form of ["NFC", "NFD", "NFKC", "NFKD"] as const) assert.equal(normalizeText(TextBuffer.from(text), { form }).text(), text.normalize(form));
    const result = normalizeText(TextBuffer.from("각"), { form: "NFC" }); assert.equal(result.at(0).codePoint, 0xac01); assert.deepEqual(result.at(0).sources, [{ from: 0, to: 1 }]);
});

test("raw unpaired UTF-16 and range boundaries survive normalization across rope pieces", () => {
    const text = "a".repeat(255) + "😀\ud800b\udc00", source = TextBuffer.from(text).replace(256, 257, "").replace(256, 256, text.slice(256, 257)), cursor = createNormalizationCursor(source, { form: "NFKC" });
    assert.equal(source.readMetrics().sliceUnits, 0); const result = finish(cursor); assert.equal(result.text(), text); assert.equal(result.at(255).codePoint, 0x1f600); assert.deepEqual(result.at(255).sources, [{ from: 255, to: 257 }]); assert.equal(result.at(256).codePoint, 0xd800); assert.equal(result.at(258).codePoint, 0xdc00); assert.equal(cursor.snapshot().readUnits, source.readMetrics().sliceUnits); assert.equal(source.readMetrics().textExports, 0);
    assert.equal(normalizeText(source, { from: 256, to: 257 }).text(), "\ude00"); cursor.dispose(); assert.equal(result.text(), text);
});

test("long combining runs normalize in counted work without quadratic insertion sorting", () => {
    const text = "A" + "\u0315\u0300\u0323".repeat(30_000), source = TextBuffer.from(text), cursor = createNormalizationCursor(source, { form: "NFC" }), result = finish(cursor, 4096);
    assert.equal(result.text(), text.normalize("NFC")); assert.ok(cursor.snapshot().workUnits < text.length * 32); assert.equal(cursor.snapshot().scannedUnits, text.length); assert.equal(source.readMetrics().textExports, 0); cursor.dispose();
});

test("cancellation during scan, decomposition, composition and publication exposes no partial output", () => {
    const source = TextBuffer.from("A" + "\u0315\u0300\u0323".repeat(10_000));
    for (const phase of ["scan", "decompose", "compose", "publish"] as const) {
        const cursor = createNormalizationCursor(source); let step = cursor.next(256); while (step.status === "running" && step.phase !== phase) step = cursor.next(256);
        assert.equal(step.status, "running", phase); assert.equal(step.result, null); cursor.dispose(); cursor.dispose(); assert.equal(cursor.next().status, "disposed"); assert.equal(cursor.snapshot().result, null);
    }
});

test("normalization captures options and immutable buffers and retains complete output after disposal", () => {
    const source = TextBuffer.from("e\u0301"), options = { form: "NFC" as "NFC" | "NFD" }, cursor = createNormalizationCursor(source, options), initial = cursor.snapshot(); options.form = "NFD"; const changed = source.replace(0, 1, "a"), result = finish(cursor); cursor.dispose();
    assert.equal(result.text(), "é"); assert.equal(result.source, source); assert.equal(changed.slice(0, 1), "a"); assert.equal(initial.workUnits, 0); assert.equal(initial.result, null); assert.equal(cursor.snapshot().result, null);
});

test("normalization limits and invalid requests fail without publishing partially expanded points", () => {
    const source = TextBuffer.from("\ufdfa"), limited = createNormalizationCursor(source, { form: "NFKD", maxPoints: 10 }); assert.throws(() => finish(limited), (error: unknown) => error instanceof NormalizationLimitError && error.limit === "points"); assert.equal(limited.snapshot().status, "failed"); assert.equal(limited.snapshot().result, null); limited.dispose();
    const operations = createNormalizationCursor(TextBuffer.from("x".repeat(1000)), { maxOperations: 100 }); assert.throws(() => operations.next(), NormalizationLimitError); assert.equal(operations.snapshot().status, "failed"); operations.dispose();
    assert.throws(() => createNormalizationCursor(source, { from: -1 })); assert.throws(() => createNormalizationCursor(source, { maxPoints: 0 })); const cursor = createNormalizationCursor(source); for (const budget of [0, 255, 256.5, NaN, Infinity]) assert.throws(() => cursor.next(budget)); assert.equal(cursor.snapshot().readUnits, 0); cursor.dispose();
});

test("none preserves original ordering and empty output has explicit immutable query bounds", () => {
    const text = "A\u0315\u0300ﬁ", value = normalizeText(TextBuffer.from(text), { form: "none" }); assert.equal(value.text(), text); const empty = normalizeText(TextBuffer.from("")); assert.equal(empty.text(), ""); assert.equal(empty.length, 0); assert.equal(empty.utf16Length, 0); assert.throws(() => empty.at(0)); for (const [from, to] of [[-1, 0], [0, 99], [1, 0], [.5, 1]]) assert.throws(() => value.text(from!, to!));
});
