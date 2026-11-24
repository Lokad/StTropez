import test from "node:test";
import { nextSeed } from "../fixtures/workloads.ts";
import assert from "node:assert/strict";
import { TextBuffer } from "../src/index.ts";
import { WordCursor } from "../src/kernels/index.ts";
import type { WordOptions } from "../src/index.ts";
const checkedCursor = (buffer: TextBuffer, offset: number, direction: -1 | 1, options: WordOptions = {}) => {
    const beforeConstruction = buffer.readMetrics(), cursor = new WordCursor(buffer, offset, direction, options);
    const checkReads = (before: ReturnType<TextBuffer["readMetrics"]>, readUnits: number) => {
        const current = buffer.readMetrics();
        assert.equal(current.textExports, before.textExports);
        assert.ok(current.sliceUnits - before.sliceUnits <= readUnits, "Unreported word-navigation slice reads.");
    };
    const initial = cursor.snapshot();
    checkReads(beforeConstruction, initial.readUnits);
    assert.equal(initial.workUnits, 0); assert.equal(initial.readUnits, 0);
    return {
        snapshot: () => cursor.snapshot(),
        next: (budget = 4096) => {
            // Measure each call independently: another cursor may read the same captured buffer.
            const before = buffer.readMetrics(), prior = cursor.snapshot(), step = cursor.next(budget);
            checkReads(before, step.readUnits - prior.readUnits);
            assert.ok(step.workUnits - prior.workUnits <= budget + 256);
            assert.ok(step.readUnits <= step.workUnits + 512);
            return step;
        },
        dispose: () => { const before = buffer.readMetrics(); cursor.dispose(); assert.deepEqual(buffer.readMetrics(), before); }
    };
};
const next = (buffer: TextBuffer, offset: number, direction: -1 | 1, options: WordOptions = {}) => {
    const cursor = checkedCursor(buffer, offset, direction, options); let step = cursor.next(256);
    while (step.status === "running") step = cursor.next(256);
    assert.equal(step.status, "ready"); cursor.dispose(); return step.offset!;
};
const boundary = (buffer: TextBuffer, offset: number, direction: -1 | 1, options: WordOptions = {}) =>
    next(buffer, offset, direction, { ...options, skipWhitespace: false });
test("code word starts preserve Unicode letters, marks, joiners, punctuation and raw line endings", () => {
    const empty = checkedCursor(TextBuffer.from(""), 0, 1), initial = empty.snapshot();
    assert.deepEqual(initial, { status: "running", offset: null, failure: null, workUnits: 0, readUnits: 0 });
    assert.ok(Object.isFrozen(initial)); assert.equal(empty.next().status, "ready"); assert.equal(empty.snapshot().offset, 0);
    assert.equal(initial.status, "running"); empty.dispose(); assert.equal(empty.snapshot().status, "disposed");
    const text = "alpha_beta  gamma.delta 😀 café", buffer = TextBuffer.from(text);
    let offset = 0; const forward = [];
    while (offset < text.length) { offset = next(buffer, offset, 1); forward.push(offset); }
    assert.deepEqual(forward, [12, 17, 18, 24, 27, 31]);
    const backward = []; while (offset > 0) { offset = next(buffer, offset, -1); backward.push(offset); }
    assert.deepEqual(backward, [27, 24, 18, 17, 12, 0]);
    for (const value of ["école\r\n東京", "👩‍💻  αβ", "\t\u0301abc", "a\u200db c"]) {
        const b = TextBuffer.from(value); let at = 0; while (at < b.length) { const old = at; at = next(b, at, 1); assert.ok(at > old); }
        while (at > 0) { const old = at; at = next(b, at, -1); assert.ok(at < old); }
    }
    assert.equal(next(TextBuffer.from("👩‍💻  αβ"), 0, 1), 7);
    assert.equal(next(TextBuffer.from("👩‍💻  αβ"), 7, -1), 0);
});
test("arbitrarily long code words and whitespace yield across immutable piece seams without export", () => {
    const buffer = TextBuffer.from("x".repeat(100_000) + "  end").replace(255, 255, "😀");
    const job = checkedCursor(buffer, 258, 1); const first = job.next(256); assert.equal(first.status, "running"); assert.ok(first.readUnits <= 768);
    let step = first; while (step.status === "running") step = job.next(4096);
    assert.equal(step.offset, 100_004); assert.equal(next(buffer, 100_004, -1), 257);
    job.dispose(); assert.equal(job.next().status, "disposed");
    assert.throws(() => new WordCursor(buffer, -1, 1)); assert.throws(() => job.next(1));
});

test("seeded code-word navigation agrees with an independent whole-string grapheme/run oracle", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const tokens = ["alpha", "βγ", "東京", "नम", "123", "_", "é", "👩‍💻", "!?", "😀", "  ", "\t", "\r\n"];
    let seed = 0x42ab7; const random = (limit: number) => { seed = nextSeed(seed); return seed % limit; };
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
        const jobs = [checkedCursor(source, 0, 1), checkedCursor(source, source.length, -1)];
        let done;
        do {
            done = true;
            for (const [index, job] of jobs.entries()) {
                const step = job.next(budget);
                if (step.status === "running") { done = false; assert.equal(step.offset, null); }
                else assert.equal(step.offset, index === 0 ? source.length : 0);
            }
        } while (!done);
        for (const job of jobs) { job.dispose(); assert.equal(job.next().offset, null); }
    }
});

test("lexical run boundaries exclude neighboring whitespace and stay inside captured raw-line bounds", () => {
    const text = "before\r\nalpha_beta  gamma.delta 😀 café\r\nafter", buffer = TextBuffer.from(text);
    const from = text.indexOf("alpha"), to = text.lastIndexOf("\r\n"), options = { from, to };
    assert.equal(boundary(buffer, from + 3, -1, options), from);
    assert.equal(boundary(buffer, from + 3, 1, options), from + 10);
    assert.equal(boundary(buffer, from + 10, 1, options), from + 12);
    assert.equal(boundary(buffer, from + 12, -1, options), from + 10);
    assert.equal(boundary(buffer, to - 1, 1, options), to);
    assert.equal(boundary(buffer, from, -1, options), from);
    assert.equal(next(buffer, from + 3, 1), from + 12);
    assert.equal(buffer.readMetrics().textExports, 0);
    for (const options of [{ from: -1 }, { to: buffer.length + 1 }, { from: from + 1 }, { to: from - 1 }]) {
        assert.throws(() => checkedCursor(buffer, from, 1, options), RangeError);
    }
});

test("run scans yield over long word, symbol and whitespace runs and release cancelled captures", () => {
    for (const token of ["x", "!", " ", "東", "\u0301", "\u3000"]) {
        const original = TextBuffer.from(token.repeat(24_000)), buffer = original.replace(255, 255, token);
        const cursor = checkedCursor(buffer, 12_000, 1, { skipWhitespace: false });
        const first = cursor.next(256); assert.equal(first.status, "running"); assert.ok(first.readUnits <= 768);
        assert.equal(boundary(buffer, 12_000, -1), 0);
        assert.equal(boundary(buffer, 12_000, 1), buffer.length);
        assert.equal(buffer.readMetrics().textExports, 0);
        cursor.dispose(); assert.equal(cursor.next().status, "disposed"); assert.equal(cursor.next().offset, null);
    }
});

test("Unicode runs preserve raw clipped surrogate seams and the final whitespace control", () => {
    const buffer = TextBuffer.from("!" + "𐐀".repeat(300) + "?");
    for (const [offset, direction, from, to, expected] of [[1, 1, 0, 602, 601], [601, -1, 0, 602, 1],
        [2, 1, 2, 600, 3], [600, -1, 2, 600, 599], [300, 1, 0, 602, 301], [300, -1, 0, 602, 299],
        [3, 1, 3, 599, 599], [599, -1, 3, 599, 3]] as const) {
        assert.equal(boundary(buffer, offset, direction, { from, to }), expected, JSON.stringify({ offset, direction, from, to }));
    }
    for (const spaces of ["\u00a0 \u2028", "\u0085\u2029\t", "\u2028\u0085\u00a0"]) {
        const source = TextBuffer.from("東".repeat(260) + spaces + "\u0301".repeat(260) + "𐐀"), control = /[\t\u2028]$/u.test(spaces);
        assert.equal(boundary(source, 0, 1), 260);
        assert.equal(boundary(source, 260, 1), control ? 263 : 523);
        assert.equal(boundary(source, 263, 1), 523);
        assert.equal(boundary(source, 523, -1), control ? 263 : 260);
        assert.equal(boundary(source, 525, -1), 523);
        assert.equal(source.readMetrics().textExports, 0);
    }
    assert.equal(buffer.readMetrics().textExports, 0);
});

test("Unicode and fragmented run scans match an independent complete grapheme/run table", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const tokens = ["alpha", "βγ", "東京", "नम", "123", "_", "é", "👩‍💻", "!?", "😀", "  ", "\t", "\r\n", "\u0301"];
    let seed = 0x291b; const random = (limit: number) => { seed = nextSeed(seed); return seed % limit; };
    for (let trial = 0; trial < 180; trial++) {
        const text = Array.from({ length: 3 + random(18) }, () => tokens[random(tokens.length)]!).join("");
        let buffer = TextBuffer.from("");
        for (let i = 0; i < text.length;) {
            const end = Math.min(text.length, i + 1 + random(13));
            buffer = buffer.replace(buffer.length, buffer.length, text.slice(i, end)); i = end;
        }
        // Literal runs classify the leading grapheme scalar; navigation's whitespace skipping has its own oracle.
        const clusters = [...segmenter.segment(text)], runs: { from: number; to: number; kind: string }[] = [];
        for (const cluster of clusters) {
            const kind = /^\p{White_Space}/u.test(cluster.segment) ? "space" : /^[\p{L}\p{N}\p{Pc}]/u.test(cluster.segment) ? "word" : "symbol";
            const last = runs.at(-1);
            if (last?.kind === kind) last.to = cluster.index + cluster.segment.length;
            else runs.push({ from: cluster.index, to: cluster.index + cluster.segment.length, kind });
        }
        for (const cluster of clusters) {
            const run = runs.find(run => run.from <= cluster.index && run.to > cluster.index)!;
            assert.equal(boundary(buffer, cluster.index, 1), run.to, JSON.stringify({ text, offset: cluster.index, direction: 1 }));
            assert.equal(boundary(buffer, cluster.index + cluster.segment.length, -1), run.from, JSON.stringify({ text, offset: cluster.index, direction: -1 }));
        }
        assert.equal(buffer.readMetrics().textExports, 0);
    }
});
