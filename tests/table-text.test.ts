import test from "node:test";
import { nextSeed } from "./fixtures/workloads.ts";
import assert from "node:assert/strict";
import { TableTextFormatter, tableLimits, tsvTokens } from "../examples/shared/table-text.ts";
function convert(text: string, budget = 3) {
    const formatter = new TableTextFormatter(tsvTokens(text)); let total = 0;
    try { for (;;) { const step = formatter.advance(budget); assert.ok(step.work <= budget); total += step.work; assert.equal(step.totalWork, total); if (step.done) return step.result!; } }
    finally { formatter.dispose(); }
}
test("host TSV conversion preserves quoted raw Unicode/newlines, empty cells and terminal rows as CSV", () => {
    assert.deepEqual(convert('a\tb\r\n"x\ty"\t"z""q\r\n😀"\r\n'), { text: '"a","b"\r\n"x\ty","z""q\r\n😀"\r\n', rows: 2, columns: 2, cells: 4 });
    assert.equal(convert('\t\n\t').text, '"",""\r\n"",""');
    assert.equal(convert('  a,b  \tquoted"value\t""').text, '"  a,b  ","quoted""value",""');
    assert.deepEqual(convert(""), { text: "", rows: 0, columns: 0, cells: 0 });
    assert.equal(convert('one\nsecond\rthird').text, '"one"\r\n"second"\r\n"third"');
});
test("cooperative conversion makes bounded progress on a huge cell and disposes private partial output", () => {
    const input = '"' + '""'.repeat(100000) + '"\tend', formatter = new TableTextFormatter(tsvTokens(input));
    const first = formatter.advance(64); assert.equal(first.done, false); assert.equal(first.work, 64); assert.equal(first.result, undefined);
    formatter.dispose(); assert.throws(() => formatter.advance(), /disposed/);
    const result = convert(input, 8192); assert.equal(result.text, '"' + '""'.repeat(100000) + '","end"'); assert.equal(result.cells, 2);
});
test("malformed/ragged tables and explicit dimensions fail without a publishable result", () => {
    for (const text of ['"unterminated', '"cell"x', 'a\tb\nc', 'a\tb\nc\td\te', 'x\n'.repeat(tableLimits.rows + 1), '\t'.repeat(tableLimits.columns)]) assert.throws(() => convert(text, 4096), RangeError);
    assert.throws(() => convert('x'.repeat(tableLimits.textUnits + 1)), /exceeds/);
    assert.throws(() => new TableTextFormatter(tsvTokens('a')).advance(0), RangeError);
});

test("generated rectangular tables retain every cell through tiny and larger streaming boundaries", () => {
    let seed = 1967; const next = (limit: number) => { seed = nextSeed(seed); return seed % limit; };
    const alphabet = ["", "x", "\t", '"', "\r\n", "\n", "é", "東京", "😀", "\ud800", ",", " "];
    const quote = (cell: string) => '"' + cell.replaceAll('"', '""') + '"';
    for (let sample = 0; sample < 80; sample++) {
        const columns = 1 + next(6), rows = Array.from({ length: 1 + next(8) }, () => Array.from({ length: columns }, () => Array.from({ length: next(7) }, () => alphabet[next(alphabet.length)]!).join("")));
        const terminal = next(2) ? "\r\n" : "", input = rows.map(row => row.map(quote).join("\t")).join("\r\n") + terminal;
        const expected = rows.map(row => row.map(quote).join(",")).join("\r\n") + terminal;
        for (const budget of [1, 3, 31]) assert.deepEqual(convert(input, budget), { text: expected, rows: rows.length, columns, cells: rows.length * columns });
    }
});
