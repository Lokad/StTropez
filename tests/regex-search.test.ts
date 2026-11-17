import test from "node:test";
import assert from "node:assert/strict";
import { regexMatches, regexRanges, regexReplacement } from "../src/core/regex-search.ts";
import { codeWordConstituentPattern, wordConstituent } from "../src/core/words.ts";

test("worker regex kernel retains raw multiline, lookbehind, captures and Unicode zero-width spans", () => {
    const text = "😀 Café\r\n𐐀value = 12;\r\n𐐨value = 34;";
    const found = [...regexMatches(text, "(?<=^)(?<name>𐐨value) = (\\d+)", false)];
    assert.deepEqual(found.map(m => [m.from, m.to, m.captures, m.groups]), [
        [10, 22, ["𐐀value", "12"], { name: "𐐀value" }], [25, 37, ["𐐨value", "34"], { name: "𐐨value" }],
    ]);
    assert.deepEqual([...regexMatches("😀x", "(?:)")].map(m => [m.from, m.to]), [[0, 0], [2, 2], [3, 3]]);
    assert.deepEqual([...regexMatches("a\r\nb\rc\nd", "^|$")].map(m => m.from), [0, 1, 3, 6, 7, 8]);
    assert.ok(found.every(m => Object.isFrozen(m) && Object.isFrozen(m.captures) && Object.isFrozen(m.groups)));
    const ranges = [...regexRanges(text, "(?<=^)(?<name>𐐨value) = (\\d+)", false)];
    assert.deepEqual(ranges, found.map(({ from, to }) => ({ from, to })));
    assert.ok(ranges.every(m => Object.isFrozen(m) && Object.keys(m).join(",") === "from,to"));
    assert.deepEqual([...regexRanges(text, "(?<name>𐐨value)", false, true, 25)], [{ from: 25, to: 32 }]);
    assert.throws(() => [...regexRanges(text, "x", true, false, 1)], RangeError);
    assert.deepEqual([...regexRanges("\ud800x\udc00😀", "(?:)", true, false, 2)].map(match => match.from), [2, 3, 5]);
    assert.throws(() => [...regexRanges("\ud800x\udc00😀", "(?:)", true, false, 4)], RangeError);
    assert.deepEqual([...regexMatches("K k K", "k", false)].map(m => m.from), [0, 2, 4]);
    assert.throws(() => [...regexMatches("text", "(")], SyntaxError);
});

test("regex whole words share code-word boundaries and preserve alternatives, captures and raw marks", () => {
    const classifier = new RegExp(`^${codeWordConstituentPattern}$`, "u");
    for (const point of "a_K𐐀ßé漢字1\u0301\u200c\u200d‿😀 -\r\n\ud800") assert.equal(classifier.test(point), wordConstituent(point), point);
    const text = "foobar foo foo_ café café 𐐀 𐐨 K k K_";
    assert.deepEqual([...regexMatches(text, "(?<value>foo|foobar)", true, true)].map(m => [m.from, m.to, m.groups]), [
        [0, 6, { value: "foobar" }], [7, 10, { value: "foo" }],
    ]);
    assert.deepEqual([...regexMatches(text, "cafe", true, true)], []);
    assert.equal([...regexMatches(text, "café", true, true)][0]!.to - [...regexMatches(text, "café", true, true)][0]!.from, 5);
    assert.deepEqual([...regexMatches(text, "𐐨|k", false, true)].map(m => text.slice(m.from, m.to)), ["𐐀", "𐐨", "K", "k"]);
    assert.deepEqual([...regexMatches(" 😀 ", "(?:)", true, true)].map(m => m.from), [0, 1, 3, 4]);
    for (const pattern of [")(", "a)|(b", "(", "[", "(?<name>x"]) {
        for (const wholeWord of [false, true]) assert.throws(() => [...regexMatches("ab ba", pattern, true, wholeWord)], SyntaxError);
    }
});

test("regex anchors follow LF rows and preserve CRLF, literal syntax and native group semantics", () => {
    const offsets = (text: string, pattern: string) => [...regexRanges(text, pattern)].map(m => m.from);
    assert.deepEqual(offsets("a\r\nb\r\n", "^"), [0, 3, 6]);
    assert.deepEqual(offsets("a\r\nb\r\n", "$"), [1, 4, 6]);
    assert.deepEqual(offsets("a\rb\u2028c\u2029d\n", "^|$"), [0, 7, 8]);
    assert.deepEqual(offsets("a\r\r\n\r", "$"), [2, 5]);
    assert.deepEqual(offsets("\r\n\n", "^$"), [0, 2, 3]);
    assert.deepEqual(offsets("a\nb\n", "(?-m:^)|(?-m:$)"), [0, 4]);
    assert.deepEqual(offsets("^$ ^$", "[$^]+"), [0, 3]);
    assert.deepEqual(offsets("^$ ^$", "\\^\\$"), [0, 3]);
    assert.deepEqual(offsets("a\n\\", "\\\\$"), [2]);
    const named = [...regexMatches("aa\r\naa", "^(?<$value>a)\\k<$value>$")];
    assert.deepEqual(named.map(m => [m.from, m.to, m.groups]), [[0, 2, { $value: "a" }], [4, 6, { $value: "a" }]]);
    assert.deepEqual(offsets("a\rb\nc", "(?<=^)\\w|\\w(?=$)"), [0, 2, 4]);
});

test("planned regex substitutions agree with native replacement for optional, named and numeric captures", () => {
    const cases = [
        { text: "before ab after ab", pattern: "(?<first>a)(b)(c)?" },
        { text: "a\n😀x\n𐐀", pattern: "^|(?=😀)|$" },
        { text: "ab", pattern: "(a)(b)()()()()()()()(z)?" },
        { text: "a", pattern: "(?<__proto__>a)(?<constructor>b)?" },
        { text: "xabz", pattern: "(?<=x)(a)(b)(?=z)" },
        { text: "ab", pattern: "ab" },
    ];
    const templates = ["literal", "$&", "$$$&", "$`|$'", "$0,$00,$01,$02,$09,$10,$12,$99", "$1:$2:$3:$4", "$<first>/$<missing>", "$<__proto__>/$<constructor>", "$<unfinished", "trailing$", "$$1\\$&😀"];
    for (const { text, pattern } of cases) for (const replacement of templates) {
        let actual = "", end = 0;
        for (const match of regexMatches(text, pattern)) { actual += text.slice(end, match.from) + regexReplacement(text, match, replacement); end = match.to; }
        actual += text.slice(end);
        assert.equal(actual, text.replace(new RegExp(pattern, "gmu"), replacement), JSON.stringify({ text, pattern, replacement }));
    }
    const text = "x".repeat(32768) + "ab", match = [...regexMatches(text, "(a)(b)")][0]!;
    assert.equal(regexReplacement(text, match, "$1$2", 2), "ab");
    assert.throws(() => regexReplacement(text, match, "$1$2", 1), /limit/);
    assert.equal(regexReplacement(text, match, "$`", 32768).length, 32768);
    assert.throws(() => regexReplacement(text, match, "$`", 32767), /limit/);
    assert.throws(() => regexReplacement(text, match, "$&$&", 3), /limit/);
});
