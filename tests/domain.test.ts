import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer, createFoldRegions } from "../src/index.ts";
import { DomainCursor, DomainAnnotationIndex, FixtureDomainProvider, domainLimits, validateDomainResult } from "../fixtures/language/domain.ts";
import type { DomainInput, DomainResult } from "../fixtures/language/domain.ts";

const input = (text: string, kind: DomainInput["kind"] = "analyze"): DomainInput => ({ id: 7, revision: 3, buffer: TextBuffer.from(text), kind, module: "catalogue" });
function run(capture: DomainInput, budget = 3): DomainResult {
    const cursor = new DomainCursor(capture); let previous = 0;
    for (;;) { const step = cursor.next(budget); assert.ok(step.work - previous <= budget); previous = step.work;
        if (step.status === "done") { assert.equal(step.work, capture.buffer.length); return validateDomainResult(step.result, capture); } }
}
test("domain fixture retains raw BOM/CRLF/Unicode anchors and nested stable identities", () => {
    const text = "\ufeff// #region outer 東京 😀\r\nbody\r\n// #region inner <b>safe</b>\r\nx\r\n// #endregion inner\r\n// #endregion outer\r\ntail";
    const capture = input(text), result = run(capture, 1), folds = createFoldRegions(capture.buffer, result.folds);
    assert.deepEqual(folds.map(r => [r.id, r.lineFrom, r.lineTo]), [["outer", 0, 6], ["inner", 2, 5]]);
    assert.deepEqual(result.annotations.map(r => [r.id, text.slice(r.from, r.to), r.label]), [["outer", "\ufeff// #region outer 東京 😀", "東京 😀"], ["inner", "// #region inner <b>safe</b>", "<b>safe</b>"]]);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.annotations[0])); assert.equal(capture.buffer.readMetrics().textExports, 0);
});
test("domain cursor bounds work and line prefixes across huge ordinary lines and 100k rows", () => {
    const capture = input("x".repeat(2400000) + "\r\n" + "const filler = 1;\r\n".repeat(100000) + "// #region end End\nbody\n// #endregion end"), result = run(capture, 8192);
    assert.equal(result.folds.length, 1); assert.equal(result.annotations[0]!.label, "End"); assert.equal(capture.buffer.readMetrics().textExports, 0);
});
test("invalid region structure and explicit result limits fail before a publishable result", () => {
    for (const text of ["// #region a A\nx", "// #endregion a", "// #region a A\n// #endregion b", "// #region a A\nx\n// #endregion a\n// #region a Again\nx\n// #endregion a", "// #region a " + "x".repeat(257) + "\nx\n// #endregion a", "// #region a " + "x".repeat(600), Array.from({ length: domainLimits.depth + 1 }, (_, i) => `// #region a${i} A`).join("\n")]) assert.throws(() => run(input(text)), /Domain|domain|Close/);
    assert.throws(() => new DomainCursor(input("x")).next(0), RangeError);
});
test("captured import policy preserves BOM and first line ending, is idempotent and permits incomplete regions", () => {
    for (const [text, ending] of [["\ufeff// #region open Label\r\nx", "\r\n"], ["x\ny\r\nz", "\n"], ["", "\n"]]) {
        const result = run(input(text!, "import")), from = text!.startsWith("\ufeff") ? 1 : 0;
        assert.deepEqual(result.edits, [{ from, to: from, insert: `import "catalogue";${ending}` }]);
        assert.equal(run(input(text!.slice(0, from) + result.edits[0]!.insert + text!.slice(from), "import")).edits.length, 0);
    }
    assert.throws(() => new DomainCursor({ ...input(""), module: "bad\nmodule" }), /bounded/);
});
test("whole domain reply validation rejects stale captures, malformed final annotations and edits", () => {
    const capture = input("// #region a A\nx\n// #endregion a"), good = run(capture);
    for (const value of [{ ...good, revision: 4 }, { ...good, folds: [...good.folds, good.folds[0]] }, { ...good, annotations: [...good.annotations, { id: "bad", from: 0, to: 999, label: "bad" }] }, { ...good, edits: [{ from: 0, to: 0, insert: "x" }] }, { ...good, edits: [{ from: NaN, to: 0, insert: "x" }] }, { ...good, edits: [{ from: 0, to: 0, insert: "x".repeat(domainLimits.resultTextUnits + 1) }] }]) assert.throws(() => validateDomainResult(value, capture));
    const index = new DomainAnnotationIndex(Array.from({ length: 100 }, (_, i) => ({ id: String(i), from: i, to: 150 - i, label: String(i) })));
    assert.equal(index.query(60, 61).length, 61); assert.equal(index.query(0, 150, 7).length, 7); assert.equal(index.query(150, 200).length, 0);
});
test("actual deferred provider cancels cooperatively and explicitly permits a late reply for rejection tests", async () => {
    const provider = new FixtureDomainProvider(); provider.delay = 0; const abort = new AbortController();
    await assert.rejects(provider.run(input("x".repeat(100000)), abort.signal, work => { assert.ok(work <= 16384); abort.abort(); }), /cancelled/);
    assert.deepEqual(provider.metrics, { requested: 1, completed: 0, cancelled: 1, turns: 1, work: 16384 });
    provider.fault = "late"; const late = new AbortController(), promise = provider.run(input("x"), late.signal, () => {}); late.abort();
    assert.equal((await promise as DomainResult).revision, 3); assert.equal(provider.metrics.completed, 1);
});
