import assert from "node:assert/strict";
import test from "node:test";
import { CharacterWarnings, characterWarningKinds, characterWarningLabel, TextBuffer } from "../src/index.ts";
import type { CharacterWarning, CharacterWarningKind, CharacterWarningOptions } from "../src/index.ts";

test("directional controls and unusual whitespace follow their distinct categories", () => {
    const rules = new CharacterWarnings();
    const directional = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    const whitespace = [9, 10, 11, 12, 13, 32, 0x85, 0xa0, 0x1680, ...Array.from({ length: 11 }, (_, index) => 0x2000 + index), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
    for (const cp of directional) assert.equal(rules.kind(cp, 1), "bidi-control", cp.toString(16));
    for (const cp of whitespace) assert.equal(rules.kind(cp, 1), [9, 10, 13, 32].includes(cp) ? null
        : [0xa0, 0x2007, 0x202f].includes(cp) ? "non-breaking-space" : "unusual-space", cp.toString(16));
    for (const cp of [0xad, 0x34f, 0x200b, 0x200c, 0x200d, 0x2060, 0xfe0f, 0xe0100]) assert.equal(rules.kind(cp, 1), "invisible");
    for (const character of "café日本語مرحباשלום👩💻🇫🇷\u0301\uD800\uDC00") assert.equal(rules.kind(character.codePointAt(0)!, 1), null);
    assert.equal(rules.kind(0xfeff, 0), null); assert.equal(rules.kind(0xfeff, 1), "bom");
    assert.equal(characterWarningLabel({ kind: "bidi-control", codePoint: 0x202e }), "Directional control (U+202E)");
});

test("category switches never reclassify disabled warnings and copied character allow-lists are exact", () => {
    const representatives: Readonly<Record<CharacterWarningKind, number>> = { "bidi-control": 0x202e, invisible: 0x200d, bom: 0xfeff,
        "non-breaking-space": 0xa0, "unusual-space": 0x2003 };
    for (const kind of characterWarningKinds) {
        const rules = new CharacterWarnings({ categories: { [kind]: false } });
        for (const other of characterWarningKinds) assert.equal(rules.kind(representatives[other], 1), other === kind ? null : other);
    }
    const allow = ["\u200D", String.fromCodePoint(0xe0100)], categories = { invisible: true }, rules = new CharacterWarnings({ allow, categories });
    allow[0] = "\u200B"; categories.invisible = false;
    assert.equal(rules.kind(0x200d, 1), null); assert.equal(rules.kind(0xe0100, 1), null); assert.equal(rules.kind(0x200b, 1), "invisible");
    assert.ok(Object.isFrozen(rules.configuration)); assert.ok(Object.isFrozen(rules.configuration.categories)); assert.ok(Object.isFrozen(rules.configuration.allow));
    const off = new CharacterWarnings({ categories: Object.fromEntries(characterWarningKinds.map(kind => [kind, false])) });
    assert.deepEqual(off.scanText(Object.values(representatives).map(cp => String.fromCodePoint(cp)).join(""), 1).warnings, []);
});

test("buffer queries return intersecting full code points at clipped UTF-16 boundaries", () => {
    const rules = new CharacterWarnings(), text = "x" + String.fromCodePoint(0xe0100) + "\u200Ba\uFEFF", buffer = TextBuffer.from(text);
    const selector = { from: 1, to: 3, codePoint: 0xe0100, kind: "invisible" };
    assert.deepEqual(rules.scan(buffer, 1, 2).warnings, [selector]); assert.deepEqual(rules.scan(buffer, 2, 3).warnings, [selector]);
    assert.deepEqual(rules.scan(buffer, 2, 2).warnings, []);
    const full = rules.scan(buffer); assert.deepEqual(full.warnings, [selector,
        { from: 3, to: 4, codePoint: 0x200b, kind: "invisible" }, { from: 5, to: 6, codePoint: 0xfeff, kind: "bom" }]);
    assert.deepEqual(rules.scanText(text, 0).warnings, full.warnings);
    assert.equal(rules.scanText("\uFEFF", 0).warnings.length, 0); assert.equal(rules.scanText("\uFEFF", 100).warnings[0]!.from, 100);
    const fragmented = TextBuffer.from("x\uDB40").replace(2, 2, "\uDD00\u200Ba\uFEFF");
    assert.deepEqual(rules.scan(fragmented).warnings, full.warnings);
});

test("bounded continuation neither splits code points nor drops warnings at unit/count limits", () => {
    const rules = new CharacterWarnings(), text = "x" + String.fromCodePoint(0xe0100) + "\u200B\uFEFFa\u202E\u2003end", buffer = TextBuffer.from(text);
    const expected = rules.scan(buffer).warnings;
    for (const maxUnits of [2, 3, 4, 7]) for (const maxWarnings of [1, 2, 4]) {
        const actual: CharacterWarning[] = []; let from = 0;
        for (;;) {
            const batch = rules.scan(buffer, from, buffer.length, { maxUnits, maxWarnings });
            assert.ok(Object.isFrozen(batch)); assert.ok(Object.isFrozen(batch.warnings)); assert.ok(batch.warnings.every(Object.isFrozen));
            assert.ok(batch.scannedUnits <= maxUnits); assert.ok(batch.readUnits <= maxUnits + 5); assert.ok(batch.warnings.length <= maxWarnings);
            actual.push(...batch.warnings); if (batch.complete) { assert.equal(batch.limit, null); assert.equal(batch.nextFrom, buffer.length); break; }
            assert.ok(batch.limit); assert.ok(batch.nextFrom > from); from = batch.nextFrom;
        }
        assert.deepEqual(actual, expected);
    }
    const exact = rules.scanText("\u200B\u200C", 0, { maxWarnings: 2, maxUnits: 2 }); assert.equal(exact.complete, true);
    assert.equal(rules.scanText("\u200B\u200C", 0, { maxWarnings: 1 }).limit, "warnings");
    const first = rules.scanText(text, 0, { maxUnits: 2 }); assert.equal(first.nextFrom, 1); assert.deepEqual(first.warnings, []);
});

test("small and limited queries in large buffers do bounded reads without exports or source changes", () => {
    const rules = new CharacterWarnings(), buffer = TextBuffer.from("x".repeat(500000) + "\u200B" + "y".repeat(500000));
    const local = rules.scan(buffer, 500000, 500001); assert.equal(local.warnings.length, 1); assert.ok(local.readUnits <= 5);
    const before = buffer.readMetrics().sliceUnits, bounded = rules.scan(buffer, 0, buffer.length, { maxUnits: 128 });
    assert.equal(bounded.limit, "units"); assert.equal(bounded.nextFrom, 128); assert.ok(bounded.readUnits <= 129);
    assert.equal(buffer.readMetrics().sliceUnits - before, bounded.readUnits); assert.equal(buffer.readMetrics().textExports, 0);
    const changed = buffer.replace(500000, 500001, "z"); assert.equal(rules.scan(changed, 500000, 500001).warnings.length, 0);
    assert.equal(rules.scan(buffer, 500000, 500001).warnings.length, 1);
});

test("invalid warning options, ranges and limits are refused", () => {
    const rules = new CharacterWarnings(), buffer = TextBuffer.from("x");
    for (const [from, to] of [[-1, 0], [0, 2], [1, 0], [.5, 1], [NaN, 1]]) assert.throws(() => rules.scan(buffer, from, to), RangeError);
    for (const maxUnits of [0, 1, .5, NaN, Infinity]) assert.throws(() => rules.scan(buffer, 0, 1, { maxUnits }), RangeError);
    for (const maxWarnings of [0, -1, .5, NaN, Infinity]) assert.throws(() => rules.scanText("x", 0, { maxWarnings }), RangeError);
    for (const allow of [[""], ["ab"], [123], "abc"]) assert.throws(() => new CharacterWarnings({ allow } as CharacterWarningOptions), TypeError);
    for (const categories of [{ unknown: true }, { invisible: 1 }]) assert.throws(() => new CharacterWarnings({ categories } as CharacterWarningOptions), TypeError);
    assert.throws(() => rules.scanText("xx", Number.MAX_SAFE_INTEGER), RangeError); assert.throws(() => rules.kind(0x110000), RangeError);
});
