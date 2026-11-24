import assert from "node:assert/strict";
import { nextSeed } from "../fixtures/workloads.ts";
import test from "node:test";
import { BracketMatcher, TextBuffer } from "../src/index.ts";
import { createBracketNavigationCursor } from "../src/core/bracket-matching.ts";
import type { BracketMatchCursor, BracketMatchOptions, LanguageConfiguration, PairingContext } from "../src/index.ts";

function checkedCursor(matcher: BracketMatcher, buffer: TextBuffer, caret: number, options?: BracketMatchOptions): BracketMatchCursor {
    const beforeConstruction = buffer.readMetrics(), cursor = matcher.createCursor(buffer, caret, options);
    const checkReads = (before: ReturnType<TextBuffer["readMetrics"]>, readUnits: number) => {
        const current = buffer.readMetrics();
        assert.equal(current.textExports, before.textExports);
        assert.equal(current.sliceUnits - before.sliceUnits, readUnits, "Unreported bracket-matching slice reads.");
    };
    const initial = cursor.snapshot(); checkReads(beforeConstruction, initial.readUnits);
    assert.equal(initial.workUnits, 0); assert.equal(initial.readUnits, 0);
    return {
        snapshot: () => cursor.snapshot(),
        next: (budget = 4096) => {
            // These callbacks do not read source; oracle reads and other cursors stay outside this call.
            const before = buffer.readMetrics(), prior = cursor.snapshot();
            try { return cursor.next(budget); }
            finally {
                const step = cursor.snapshot(), work = step.workUnits - prior.workUnits, reads = step.readUnits - prior.readUnits;
                checkReads(before, reads);
                if (Number.isSafeInteger(budget) && budget >= 256) assert.ok(work <= budget + 63);
                assert.ok(reads <= work + 256);
            }
        },
        dispose: () => { const before = buffer.readMetrics(); try { cursor.dispose(); } finally { assert.deepEqual(buffer.readMetrics(), before); } }
    };
}

function finish(cursor: BracketMatchCursor, budget = 256) {
    try {
        for (;;) {
            const step = cursor.next(budget); assert.ok(Object.isFrozen(step));
            if (step.status === "ready") { assert.ok(Object.isFrozen(step.result)); return step; }
            assert.equal(step.status, "running"); assert.equal(step.result, null);
        }
    } finally { cursor.dispose(); }
}
const match = (text: string, caret: number, configuration?: LanguageConfiguration, options?: BracketMatchOptions) =>
    finish(checkedCursor(new BracketMatcher(configuration), TextBuffer.from(text), caret, options)).result!;

test("matching follows known nested pairs in both directions and uses absolute UTF-16 offsets", () => {
    const matcher = new BracketMatcher(), pairs = [["(", ")"], ["[", "]"], ["{", "}"]] as const;
    let seed = 417;
    const random = () => { seed = nextSeed(seed); return seed; };
    for (let sample = 0; sample < 64; sample++) {
        let text = "😀\r\n", expected = new Map<number, number>();
        const add = (depth: number) => {
            const pair = pairs[random() % pairs.length]!, start = text.length; text += pair[0] + "x😀";
            if (depth < 3) for (let count = random() % 3; count > 0; count--) add(depth + 1);
            const end = text.length; text += pair[1]; expected.set(start, end); expected.set(end, start);
        };
        add(0); add(0); text += "\n";
        // Fragmented storage has the same absolute coordinate contract.
        let buffer = TextBuffer.from(text.slice(0, 3)); buffer = buffer.apply([{ from: 3, to: 3, insert: text.slice(3) }]).buffer;
        for (let caret = 0; caret <= text.length; caret++) {
            const at = expected.has(caret) ? caret : expected.has(caret - 1) ? caret - 1 : null;
            const result = finish(checkedCursor(matcher, buffer, caret)).result!;
            assert.equal(result.kind, at === null ? "none" : "matched"); assert.equal(result.at, at);
            assert.equal(result.match, at === null ? null : expected.get(at));
            if (at !== null) assert.equal(result.direction, expected.get(at)! > at ? 1 : -1);
        }
    }
});

test("crossed nesting and EOF are unmatched; symmetric insertion pairs do not become bracket matches", () => {
    for (const text of ["([)]", "{)", "(", "(abc["]) assert.equal(match(text, 0).kind, "unmatched", text);
    for (const text of ["([)]", "(}", ")", "abc)"]) assert.equal(match(text, text.length).kind, "unmatched", text);
    assert.equal(match("", 0).kind, "none"); assert.equal(match("hello", 2).kind, "none");
    const quotes = { pairs: [{ open: '"', close: '"' }, { open: "(", close: ")" }] };
    assert.equal(match('"text"', 0, quotes).kind, "none"); assert.equal(match('"()"', 1, quotes).kind, "matched");
    assert.equal(match("()", 0, { pairs: [] }).kind, "none");
    assert.equal(match("()[]", 2).match, 3); // At-caret bracket takes precedence over the previous one.
});

test("interior navigation skips balanced neighbors and shares eligibility, depth and work limits across both scans", () => {
    const jump = (text: string, caret: number, options?: BracketMatchOptions, language?: LanguageConfiguration) =>
        finish(createBracketNavigationCursor(new BracketMatcher(language).configuration, TextBuffer.from(text), caret, options));
    const nested = "({[]} left 😀 right [()])";
    assert.equal(jump(nested, nested.indexOf("😀")).result!.match, nested.length - 1);
    assert.equal(jump("outer(inner(value))", 14).result!.match, 17);
    assert.equal(jump("<ignore> text", 11).result!.kind, "none");
    assert.equal(jump("([]) text", 7).result!.kind, "none");
    assert.equal(jump("([)] text", 7).result!.kind, "unmatched");
    assert.equal(jump("( left ]", 4).result!.kind, "unmatched");
    assert.equal(jump("( left [ x ] right )", 9, undefined, { allowPair: ({ pair }) => pair.open !== "[" }).result!.match, 19);
    assert.equal(jump("( [] left )", 7, { maxDepth: 1 }).result!.limit, "depth");
    assert.equal(jump("( left [] )", 3, { maxDepth: 1 }).result!.limit, "depth");
    const limited = jump("(" + "x".repeat(1200) + ")", 600, { maxWorkUnits: 1000 });
    assert.equal(limited.result!.limit, "work"); assert.equal(limited.workUnits, 1000);
});

test("host veto examines each existing delimiter with its direction, exact immutable buffer and range", () => {
    const buffer = TextBuffer.from('( "[)]" x )'), calls: PairingContext[] = [];
    const matcher = new BracketMatcher({ allowPair: context => { calls.push(context); return context.from < 2 || context.from > 6; } });
    const result = finish(checkedCursor(matcher, buffer, 0)); assert.equal(result.result!.match, buffer.length - 1);
    assert.equal(result.callbackCalls, calls.length); assert.ok(calls.some(call => call.from === 4 && call.operation === "close"));
    for (const call of calls) { assert.equal(call.buffer, buffer); assert.equal(call.to, call.from + 1); assert.ok(Object.isFrozen(call));
        assert.equal(buffer.slice(call.from, call.to), call.operation === "open" ? call.pair.open : call.pair.close); }
    assert.equal(match("()", 0, { allowPair: () => false }).kind, "vetoed");
    assert.equal(match("()[]", 2, { allowPair: ({ pair }) => pair.open !== "[" }).at, 1);
});

test("shared closing delimiters retain possible openings and eligible dual-role characters are explicit", () => {
    const shared = { pairs: [{ open: "a", close: ">" }, { open: "b", close: ">" }] };
    for (const [text, caret, other] of [["ab>>", 0, 3], ["ab>>", 3, 0], ["ab>>", 2, 1], ["ba>>", 3, 0]] as const)
        assert.equal(match(text, caret, shared).match, other);
    const dual = { pairs: [{ open: "a", close: "b" }, { open: "b", close: "c" }] };
    assert.equal(match("abc", 1, dual).kind, "ambiguous"); assert.equal(match("abc", 0, dual).kind, "ambiguous");
    assert.equal(match("ab", 0, { ...dual, allowPair: ({ pair }) => pair.open === "a" }).match, 1);
});

test("work, depth and cooperative budgets stay explicit without whole-buffer reads", () => {
    const buffer = TextBuffer.from("(" + "x".repeat(16_384) + ")"), matcher = new BracketMatcher();
    const cursor = checkedCursor(matcher, buffer, 0, { maxWorkUnits: 2048 }), first = cursor.next(256);
    assert.equal(first.status, "running"); assert.equal(first.result, null); assert.equal(first.workUnits, 256);
    const final = finish(cursor); assert.equal(final.result!.kind, "limited"); assert.equal(final.result!.limit, "work");
    assert.equal(final.workUnits, 2048); assert.ok(final.readUnits <= final.scannedUnits + 256);
    assert.equal(match("((x))", 0, undefined, { maxDepth: 1 }).limit, "depth");
    assert.equal(match("((x))", 0, undefined, { maxDepth: 2 }).kind, "matched");
    assert.equal(match("()", 0, undefined, { maxWorkUnits: 4 }).kind, "matched");
    assert.equal(match("()", 0, undefined, { maxWorkUnits: 3 }).limit, "work");
    // A large shared-closing configuration cannot hide its callback loop within one scan unit.
    let calls = 0;
    const many = new BracketMatcher({ pairs: Array.from({ length: 1500 }, (_, i) => ({ open: String.fromCharCode(1000 + i), close: ">" })),
        allowPair: () => { calls++; return true; } });
    const dense = checkedCursor(many, TextBuffer.from(">"), 0, { maxWorkUnits: 600 });
    assert.equal(dense.next(256).status, "running"); assert.ok(calls <= 256);
    assert.equal(finish(dense).result!.limit, "work"); assert.ok(calls <= 600);
});

test("configuration and cursor captures survive caller mutation and disposal; callback failures propagate", () => {
    const pairs = [{ open: "(", close: ")" }], matcher = new BracketMatcher({ pairs }), before = TextBuffer.from("(x)");
    pairs[0]!.close = "]"; pairs.push({ open: "[", close: "]" });
    const cursor = checkedCursor(matcher, before, 0), edited = before.apply([{ from: 2, to: 3, insert: "]" }]).buffer;
    assert.equal(finish(cursor).result!.match, 2); assert.equal(finish(checkedCursor(matcher, edited, 0)).result!.kind, "unmatched");
    assert.equal(cursor.snapshot().status, "disposed"); assert.equal(cursor.next().result, null);
    const throwing = checkedCursor(new BracketMatcher({ allowPair: () => { throw new Error("host failure"); } }), before, 0);
    assert.throws(() => throwing.next(), /host failure/); assert.equal(throwing.snapshot().status, "failed");
    assert.equal(throwing.snapshot().failure, "host failure"); throwing.dispose();
    assert.ok(Object.isFrozen(matcher)); assert.ok(Object.isFrozen(matcher.configuration.pairs[0]));
});

test("invalid caret, limits, work budgets and pair configurations are refused", () => {
    const matcher = new BracketMatcher(), buffer = TextBuffer.from("()");
    for (const at of [-1, 3, .5, NaN, Infinity]) assert.throws(() => matcher.createCursor(buffer, at), RangeError);
    for (const value of [0, -1, .5, NaN, Infinity]) for (const key of ["maxWorkUnits", "maxDepth"])
        assert.throws(() => matcher.createCursor(buffer, 0, { [key]: value }), RangeError);
    const cursor = checkedCursor(matcher, buffer, 0); assert.throws(() => cursor.next(255), RangeError); cursor.dispose();
    assert.throws(() => new BracketMatcher({ pairs: [{ open: "\n", close: ")" }] }), RangeError);
});
