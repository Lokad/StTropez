import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer, WordCursor } from "../src/index.ts";
const next = (buffer: TextBuffer, offset: number, direction: -1 | 1) => {
    const cursor = new WordCursor(buffer, offset, direction); let step = cursor.next(256);
    while (step.status === "running") { const before = step.workUnits; step = cursor.next(256); assert.ok(step.workUnits - before <= 512); }
    assert.equal(step.status, "ready"); return step.offset!;
};
test("code word starts preserve Unicode letters, marks, joiners, punctuation and raw line endings", () => {
    const text = "alpha_beta  gamma.delta 😀 café", buffer = TextBuffer.from(text);
    let offset = 0; const forward = [];
    while (offset < text.length) { offset = next(buffer, offset, 1); forward.push(offset); }
    assert.deepEqual(forward, [12, 17, 18, 24, 27, 31]);
    const backward = []; while (offset > 0) { offset = next(buffer, offset, -1); backward.push(offset); }
    assert.deepEqual(backward, [27, 24, 18, 17, 12, 0]);
    for (const value of ["école\r\n東京", "👩‍💻  αβ", "\t\u0301abc", "a\u200db c"]) {
        const b = TextBuffer.from(value); let at = 0; while (at < b.length) { const old = at; at = next(b, at, 1); assert.ok(at > old); }
        while (at > 0) { const old = at; at = next(b, at, -1); assert.ok(at < old); }
        assert.equal(b.readMetrics().textExports, 0);
    }
    assert.equal(next(TextBuffer.from("👩‍💻  αβ"), 0, 1), 7);
    assert.equal(next(TextBuffer.from("👩‍💻  αβ"), 7, -1), 0);
});
test("arbitrarily long code words and whitespace yield across immutable piece seams without export", () => {
    const buffer = TextBuffer.from("x".repeat(1_000_000) + "  end").replace(255, 255, "😀");
    const job = new WordCursor(buffer, 258, 1); const first = job.next(256); assert.equal(first.status, "running"); assert.ok(first.readUnits <= 768);
    let step = first; while (step.status === "running") step = job.next(4096);
    assert.equal(step.offset, 1_000_004); assert.equal(next(buffer, 1_000_004, -1), 257);
    job.dispose(); assert.equal(job.next().status, "cancelled"); assert.equal(buffer.readMetrics().textExports, 0);
    assert.throws(() => new WordCursor(buffer, -1, 1)); assert.throws(() => job.next(1));
});

test("seeded code-word navigation agrees with an independent whole-string grapheme/run oracle", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const tokens = ["alpha", "βγ", "東京", "नम", "123", "_", "é", "👩‍💻", "!?", "😀", "  ", "\t", "\r\n"];
    let seed = 0x42ab7; const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
    for (let trial = 0; trial < 250; trial++) {
        const text = Array.from({ length: 3 + random(20) }, () => tokens[random(tokens.length)]!).join("");
        let buffer = TextBuffer.from("");
        for (let offset = 0; offset < text.length;) { const end = Math.min(text.length, offset + 1 + random(9)); buffer = buffer.replace(buffer.length, buffer.length, text.slice(offset, end)); offset = end; }
        const clusters = [...segmenter.segment(text)], starts = [0]; let previous = "";
        for (const part of clusters) {
            const type = /^\p{White_Space}+$/u.test(part.segment) ? "space" : /^[\p{L}\p{N}\p{Pc}]/u.test(part.segment) ? "word" : "symbol";
            if (type !== "space" && type !== previous && part.index > 0) starts.push(part.index);
            previous = type;
        }
        starts.push(text.length);
        for (const offset of [0, ...clusters.map(part => part.index + part.segment.length)]) {
            assert.equal(next(buffer, offset, 1), starts.find(start => start > offset) ?? text.length, `forward ${JSON.stringify({ text, offset })}`);
            assert.equal(next(buffer, offset, -1), starts.filter(start => start < offset).at(-1) ?? 0, `backward ${JSON.stringify({ text, offset })}`);
        }
        assert.equal(buffer.readMetrics().textExports, 0);
    }
});

test("batched runs preserve ASCII transitions, interior starts and independent bounded Unicode advances", () => {
    const text = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)).join("") + "x".repeat(769) + " \r\n\t".repeat(130) + "!?".repeat(390) + "_tail";
    let buffer = TextBuffer.from(""); for (let from = 0; from < text.length; from += 17) buffer = buffer.replace(buffer.length, buffer.length, text.slice(from, from + 17));
    const starts = [0]; let previous = "";
    for (let offset = 0; offset < text.length; offset++) {
        const value = text[offset]!, type = /^\p{White_Space}$/u.test(value) ? "space" : /^[\p{L}\p{N}\p{Pc}]$/u.test(value) ? "word" : "symbol";
        if (offset > 0 && type !== "space" && type !== previous) starts.push(offset); previous = type;
    }
    starts.push(text.length);
    for (let offset = 0; offset <= text.length; offset++) {
        assert.equal(next(buffer, offset, 1), starts.find(start => start > offset) ?? text.length, `forward ${offset}`);
        assert.equal(next(buffer, offset, -1), starts.filter(start => start < offset).at(-1) ?? 0, `backward ${offset}`);
    }
    for (const token of ["x", "東京", "𐐀", "😀", "\u0301\u200d", " \t\u00a0\u2028"]) for (const budget of [256, 257, 4096]) {
        const source = TextBuffer.from(token.repeat(10000));
        const jobs = [new WordCursor(source, 0, 1), new WordCursor(source, source.length, -1)];
        const prior = [0, 0]; let done;
        do {
            done = true;
            for (const [index, job] of jobs.entries()) {
                const step = job.next(budget);
                assert.ok(step.workUnits - prior[index]! <= budget + 256); assert.ok(step.readUnits <= step.workUnits + 512); prior[index] = step.workUnits;
                if (step.status === "running") { done = false; assert.equal(step.offset, null); }
                else assert.equal(step.offset, index === 0 ? source.length : 0);
            }
        } while (!done);
        for (const job of jobs) { job.dispose(); assert.equal(job.next().offset, null); }
        assert.equal(source.readMetrics().textExports, 0);
    }
    assert.equal(buffer.readMetrics().textExports, 0);
});
