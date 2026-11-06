import assert from "node:assert/strict";
import test from "node:test";
import { TextBuffer, normalizeText, itemizeScripts, createScriptItemizationCursor, ScriptItemizationLimitError, unicodeScript, unicodeScriptExtensions, unicodeCategory, createNormalizedGraphemeCursor, createGraphemeCursor } from "../src/index.ts";
import type { NormalizedText, ScriptIndex, ScriptItemizationCursor } from "../src/index.ts";
import { bidiBracket } from "../src/core/bidi-data.ts";
const text = (value: string) => normalizeText(TextBuffer.from(value), { form: "none" });
const runs = (index: ScriptIndex) => Array.from({ length: index.runCount }, (_, i) => { const run = index.runAt(i); return [run.script, index.text.text(run.from, run.to)] as const; });
function finish(cursor: ScriptItemizationCursor, budget = 256): ScriptIndex {
    let prior = cursor.snapshot(); while (true) { const step = cursor.next(budget); assert.ok(Object.isFrozen(step)); assert.ok(step.workUnits - prior.workUnits <= budget + 256); if (step.status === "ready") return step.result!; assert.equal(step.result, null); assert.equal(step.status, "running"); prior = step; }
}

test("script runs resolve leading/trailing Common and Inherited text without changing normalized points", () => {
    const normalized = text("...A αא "), index = itemizeScripts(normalized); assert.equal(index.text, normalized); assert.deepEqual(runs(index), [["Latn", "...A "], ["Grek", "α"], ["Hebr", "א "]]);
    assert.deepEqual(runs(itemizeScripts(text("\u032a\u200d !"))), [["Zyyy", "\u032a\u200d !"]]); assert.deepEqual(runs(itemizeScripts(text("\u0363"))), [["Latn", "\u0363"]]);
    const empty = itemizeScripts(text("")); assert.equal(empty.runCount, 0); assert.equal(empty.clusterCount, 0); assert.equal(empty.from, 0); assert.equal(empty.to, 0); assert.throws(() => empty.scriptAt(0));
});
test("default script units preserve full extended graphemes and explicitly retain the earlier combining policy", () => {
    const normalized = text("\u0600A🇦🇧👩‍💻\n\u094dक"), index = itemizeScripts(normalized);
    assert.equal(index.clusterCount, 5); assert.deepEqual(Array.from({ length: 5 }, (_, i) => { const c = index.clusterAt(i); return normalized.text(c.from, c.to); }), ["\u0600A", "🇦🇧", "👩‍💻", "\n", "\u094dक"]);
    assert.equal(index.scriptAt(0), "Arab"); assert.equal(index.scriptAt(normalized.length - 1), "Deva");
    const legacy = itemizeScripts(normalized, { clusterMode: "combining" }); assert.ok(legacy.clusterCount > index.clusterCount);
    assert.throws(() => createScriptItemizationCursor(normalized, { clusterMode: "invalid" as "grapheme" }));
});

test("script itemization reuses only an owned grapheme index for the exact normalized identity and point range", () => {
    const normalized = text("A👩‍💻α"), cursor = createNormalizedGraphemeCursor(normalized, { from: 1, to: 4 }); let step = cursor.next(); while (step.status === "running") step = cursor.next(); const graphemes = step.result!; cursor.dispose();
    const itemizer = createScriptItemizationCursor(normalized, { from: 1, to: 4, graphemes }), index = finish(itemizer); assert.equal(index.clusterCount, 1); assert.deepEqual(index.clusterAt(0), { from: 1, to: 4, runIndex: 0 }); itemizer.dispose();
    assert.throws(() => createScriptItemizationCursor(normalized, { graphemes })); assert.throws(() => createScriptItemizationCursor(text(normalized.text()), { from: 1, to: 4, graphemes }));
    assert.throws(() => createScriptItemizationCursor(normalized, { from: 1, to: 4, graphemes, clusterMode: "combining" }));
    const raw = createGraphemeCursor("A👩‍💻α"); const rawStep = raw.next(); assert.throws(() => createScriptItemizationCursor(normalized, { graphemes: rawStep.result! })); raw.dispose();
});

test("combining sequences retain one script even for foreign marks, joiners and variation selectors", () => {
    const normalized = text("A\u05b0\u200d\ufe0fα\u093e"), index = itemizeScripts(normalized);
    assert.deepEqual(runs(index), [["Latn", "A\u05b0\u200d\ufe0f"], ["Grek", "α\u093e"]]); assert.equal(index.clusterCount, 2); assert.deepEqual(index.clusterAt(0), { from: 0, to: 4, runIndex: 0 });
    for (let i = 0; i < 4; i++) { assert.equal(index.scriptAt(i), "Latn"); assert.equal(index.clusterIndexAt(i), 0); }
    assert.deepEqual(runs(itemizeScripts(text("◌\u05b0"))), [["Hebr", "◌\u05b0"]]);
});
test("Script_Extensions constrain ambiguous punctuation and can select a non-primary explicit script", () => {
    assert.deepEqual(runs(itemizeScripts(text("Aーア"))), [["Latn", "A"], ["Kana", "ーア"]]); assert.deepEqual(runs(itemizeScripts(text("あーア"))), [["Hira", "あー"], ["Kana", "ア"]]);
    const ambiguous = itemizeScripts(text("ー")); assert.deepEqual(ambiguous.runAt(0).candidates, ["Hira", "Kana"]); assert.equal(ambiguous.runAt(0).script, "Hira");
    const value = String.fromCodePoint(0x11083, 0x096f); assert.equal(unicodeScript(0x11083), "Kthi"); assert.ok(unicodeScriptExtensions(0x096f).includes("Kthi")); assert.deepEqual(runs(itemizeScripts(text(value))), [["Kthi", value]]);
});
test("nested paired punctuation returns to enclosing scripts, including leading and canonical pairs", () => {
    assert.deepEqual(runs(itemizeScripts(text("A(α[א]β)B"))), [["Latn", "A("], ["Grek", "α["], ["Hebr", "א"], ["Grek", "]β"], ["Latn", ")B"]]);
    assert.deepEqual(runs(itemizeScripts(text(" (α) A"))), [["Grek", " (α) "], ["Latn", "A"]]); assert.deepEqual(runs(itemizeScripts(text("A〈α〉"))), [["Latn", "A〈"], ["Grek", "α"], ["Latn", "〉"]]);
    const cursor = createScriptItemizationCursor(text("A([α)]")); finish(cursor); assert.equal(cursor.snapshot().pairedBrackets, 1); assert.equal(cursor.snapshot().unmatchedBrackets, 2); assert.equal(cursor.snapshot().bracketDepth, 0); cursor.dispose();
});
test("every paired bracket fact keeps the matched closing script with its outer text", () => {
    let pairs = 0; for (let cp = 0; cp <= 0x10ffff; cp++) { const pair = bidiBracket(cp); if (!pair?.[1]) continue; const a = String.fromCodePoint(cp), b = String.fromCodePoint(pair[0]), cursor = createScriptItemizationCursor(text(`A${a}α${b}`)); const index = finish(cursor);
        assert.deepEqual(runs(index), [["Latn", `A${a}`], ["Grek", "α"], ["Latn", b]], `bracket ${cp}`); assert.equal(cursor.snapshot().pairedBrackets, 1); cursor.dispose(); assert.deepEqual(runs(itemizeScripts(text(`${a}A${b}`))), [["Latn", `${a}A${b}`]], `leading bracket ${cp}`); pairs++; }
    assert.ok(pairs >= 60); console.log(`Script paired-bracket controls: ${pairs} pairs.`);
});
test("paragraph/line separators and unknown points reset contextual bracket interpretation", () => {
    const cursor = createScriptItemizationCursor(text("A(\r\nα)\u0085\u2028\u2029א")), index = finish(cursor); assert.deepEqual(runs(index), [["Latn", "A("], ["Zyyy", "\r\n"], ["Grek", "α)"], ["Zyyy", "\u0085"], ["Zyyy", "\u2028"], ["Zyyy", "\u2029"], ["Hebr", "א"]]); assert.equal(index.runAt(1).kind, "separator"); assert.equal(cursor.snapshot().unmatchedBrackets, 2);
    const unknown = itemizeScripts(text("A(\ud800\u0301α)")); assert.deepEqual(runs(unknown), [["Latn", "A("], ["Zzzz", "\ud800\u0301"], ["Grek", "α)"]]); assert.equal(unknown.runAt(1).kind, "unknown"); cursor.dispose();
});
test("script ranges address normalized points while preserving original UTF-16 provenance", () => {
    const normalized = normalizeText(TextBuffer.from("😀ﬁα\u05b0"), { form: "NFKD" }), index = itemizeScripts(normalized, { from: 1, to: 5 });
    assert.deepEqual(runs(index), [["Latn", "fi"], ["Grek", "α\u05b0"]]); assert.equal(index.from, 1); assert.equal(index.to, 5); assert.deepEqual(normalized.at(1).sources, [{ from: 2, to: 3 }]); assert.deepEqual(normalized.at(2).sources, [{ from: 2, to: 3 }]);
    assert.deepEqual(index.clusterAt(2), { from: 3, to: 5, runIndex: 1 }); for (const value of [index, index.runAt(0), index.runAt(0).candidates, index.clusterAt(0)]) assert.ok(Object.isFrozen(value));
    for (const i of [-1, 0, 5, .5]) assert.throws(() => index.scriptAt(i)); assert.throws(() => index.runAt(2)); assert.throws(() => index.clusterAt(3));
});
test("a long foreign-mark sequence stays one cluster with linear counted work and no buffer reads", () => {
    const normalized = text("A" + "\u05b0".repeat(90_000)), before = normalized.source.readMetrics(), cursor = createScriptItemizationCursor(normalized), index = finish(cursor, 4096);
    assert.equal(index.runCount, 1); assert.equal(index.clusterCount, 1); assert.equal(index.scriptAt(90_000), "Latn"); assert.ok(cursor.snapshot().workUnits < normalized.length * 8); assert.deepEqual(normalized.source.readMetrics(), before); cursor.dispose();
});
test("deep malformed bracket stacks use direct matching and unwind each opening only once", () => {
    const normalized = text("A" + "(".repeat(20_000) + "[".repeat(20_000) + "}".repeat(20_000) + ")"), cursor = createScriptItemizationCursor(normalized, { maxBracketDepth: 50_000 }), index = finish(cursor, 4096);
    assert.equal(index.runCount, 1); assert.equal(cursor.snapshot().pairedBrackets, 1); assert.equal(cursor.snapshot().unmatchedBrackets, 59_999); assert.equal(cursor.snapshot().bracketDepth, 0); assert.ok(cursor.snapshot().workUnits < normalized.length * 16); cursor.dispose();
});
test("itemization captures immutable options, supports cancellation in every private phase and retains completed values", () => {
    const normalized = text("A(α)".repeat(5000)); for (const phase of ["grapheme", "cluster", "resolve", "publish"] as const) { const cursor = createScriptItemizationCursor(normalized); let step = cursor.next(); while (step.status === "running" && step.phase !== phase) step = cursor.next(); assert.equal(step.status, "running", phase); assert.equal(step.result, null); cursor.dispose(); cursor.dispose(); assert.equal(cursor.next().status, "disposed"); assert.equal(cursor.snapshot().result, null); }
    const options = { from: 0, to: 2 }, cursor = createScriptItemizationCursor(normalized, options); options.to = normalized.length; const index = finish(cursor); cursor.dispose(); assert.equal(index.to, 2); assert.equal(index.text, normalized); assert.deepEqual(runs(index), [["Latn", "A("]]);
});
test("limits and invalid ownership/ranges fail without publishing script partitions", () => {
    const normalized = text("Aαא"), cursors = [createScriptItemizationCursor(normalized, { maxOperations: 1 }), createScriptItemizationCursor(normalized, { maxRuns: 1 }), createScriptItemizationCursor(text("((("), { maxBracketDepth: 2 })];
    for (const cursor of cursors) { assert.throws(() => finish(cursor), ScriptItemizationLimitError); assert.equal(cursor.snapshot().status, "failed"); assert.equal(cursor.snapshot().result, null); cursor.dispose(); }
    assert.throws(() => createScriptItemizationCursor({} as NormalizedText)); assert.throws(() => createScriptItemizationCursor(normalized, { from: -1 })); assert.throws(() => createScriptItemizationCursor(normalized, { to: 9 })); assert.throws(() => createScriptItemizationCursor(normalized, { maxRuns: 0 })); const cursor = createScriptItemizationCursor(normalized); for (const b of [0, 255, .5, NaN, Infinity]) assert.throws(() => cursor.next(b)); assert.equal(cursor.snapshot().workUnits, 0); cursor.dispose();
});
test("all represented explicit scripts and non-mark extension characters resolve in compatible contexts", () => {
    const anchors = new Map<string, number>(), extended: number[] = []; for (let cp = 0; cp <= 0x10ffff; cp++) { const script = unicodeScript(cp), category = unicodeCategory(cp); if (script !== "Zyyy" && script !== "Zinh" && script !== "Zzzz" && category.startsWith("L") && !anchors.has(script)) anchors.set(script, cp); if (!category.startsWith("M") && unicodeScriptExtensions(cp).length > 1) extended.push(cp); }
    for (const [script, cp] of anchors) assert.equal(itemizeScripts(text(String.fromCodePoint(cp))).scriptAt(0), script);
    let conditions = 0; for (const cp of extended) for (const script of unicodeScriptExtensions(cp)) { const anchor = anchors.get(script); if (anchor === undefined || bidiBracket(cp)) continue; const index = itemizeScripts(text(String.fromCodePoint(anchor, cp, anchor))); assert.equal(index.runCount, 1, `${cp}:${script}`); assert.equal(index.runAt(0).script, script); conditions++; }
    assert.ok(anchors.size > 160); assert.ok(conditions > 1000); console.log(`Script contexts: ${anchors.size} represented scripts, ${conditions} extension conditions.`);
});
