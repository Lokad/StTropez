import test from "node:test";
import { nextSeed } from "../fixtures/workloads.ts";
import assert from "node:assert/strict";
import { TextBuffer } from "../src/index.ts";
import { TextDiff } from "../src/kernels/index.ts";
import { comparisonLine } from "../src/core/comparison-scroll.ts";
function mapping(a: string, b: string) {
    const baseline = TextBuffer.from(a), working = TextBuffer.from(b), diff = new TextDiff(baseline, working); let result = diff.next(32768);
    while (result.status === "running") result = diff.next(32768);
    assert.equal(result.status, "ready");
    return { baseline, working, line: (side: "baseline" | "working", at: number) => comparisonLine(result.hunks, side, at, baseline, working) };
}
test("scroll projection preserves rows after scalar-trimmed same-row insertions/deletions and CRLF edits", () => {
    const rows = Array.from({ length: 80 }, (_, i) => `row ${i} café😀;\r\n`), a = rows.join("");
    for (const b of [a.replace("row 20", "row XYZ20"), a.replace("café😀", "é"), a.replace("\r\n", "\n")]) {
        const m = mapping(a, b);
        for (const side of ["baseline", "working"] as const) for (const at of [0, 1, 19.25, 20, 20.75, 21.5, 40.25, 79.75, 80]) assert.equal(m.line(side, at), at);
        assert.equal(m.baseline.readMetrics().textExports, 0); assert.equal(m.working.readMetrics().textExports, 0);
    }
});
test("inserted/deleted rows project to captured anchors and unchanged rows retain fractional alignment", () => {
    const a = Array.from({ length: 30 }, (_, i) => `${i};\n`).join(""), b = a.replace("10;\n", "one\ntwo\nthree\n10;\n"), m = mapping(a, b);
    assert.equal(m.line("baseline", 9.5), 9.5); assert.equal(m.line("baseline", 10), 13); assert.equal(m.line("baseline", 15.25), 18.25);
    assert.equal(m.line("working", 10), 10); assert.equal(m.line("working", 12.5), 10); assert.equal(m.line("working", 18.25), 15.25);
    const reverse = mapping(b, a); assert.equal(reverse.line("baseline", 11.5), 10); assert.equal(reverse.line("working", 15.5), 18.5);
    const trailing = mapping("one\r\ntwo\r\nthree", "one\r\ntwo"); assert.equal(trailing.line("working", 1), 1); assert.equal(trailing.line("baseline", 1), 1);
});
test("actual diff projections preserve every unique unchanged row through multiple line edits", () => {
    let seed = 43829; const random = (n: number) => { seed = nextSeed(seed) | 0; return (seed >>> 0) % n; };
    for (let trial = 0; trial < 40; trial++) {
        const a = Array.from({ length: 70 }, (_, i) => `original-${i};`), b = a.slice();
        for (let edit = 0; edit < 8; edit++) b.splice(random(b.length), random(4), ...Array.from({ length: random(5) }, (_, i) => `new-${edit}-${i};`));
        const m = mapping(a.join("\r\n"), b.join("\r\n"));
        for (const [side, from, to] of [["baseline", a, b], ["working", b, a]] as const) {
            let previous = -1;
            for (let row = 0; row < from.length; row++) {
                const target = to.indexOf(from[row]!); if (target >= 0) assert.equal(m.line(side, row), target, `${trial} ${side} ${row}`);
                const mapped = m.line(side, row); assert.ok(mapped >= previous && mapped < to.length); previous = mapped;
            }
        }
    }
});
test("empty/unterminated sources clamp projection without exporting or splitting source coordinates", () => {
    for (const a of ["", "😀", "a\nb", "a\r\n"]) for (const b of ["", "c\nd", "é\n"]) {
        const m = mapping(a, b); for (const side of ["baseline", "working"] as const) for (const row of [-50, 0, .25, 10000]) {
            const target = side === "baseline" ? m.working : m.baseline, at = m.line(side, row); assert.ok(at >= 0 && at <= target.lineCount - 1);
        }
        assert.throws(() => m.line("baseline", NaN)); assert.throws(() => m.line("working", Infinity));
    }
});
