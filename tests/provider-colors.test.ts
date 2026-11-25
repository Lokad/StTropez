import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer } from "../src/index.ts";
import { DocumentColorsCursor, parseColor, hexColor, rgbaColor, sameColor } from "./fixtures/language/colors.ts";
const capture = (text: string) => ({ id: 1, document: "source", revision: 4, length: text.length, delay: 0 });
function scan(text: string) {
    const cursor = new DocumentColorsCursor(capture(text), TextBuffer.from(text));
    let work = 0;
    for (;;) {
        const step = cursor.next();
        assert.ok(step.work >= work && step.work - work <= 16384);
        work = step.work;
        if (step.result) {
            assert.equal(work, text.length);
            return step.result;
        }
    }
}

test("literal color parsing preserves CSS hex variants, numeric/percentage RGB, alpha and finite clamping", () => {
    assert.deepEqual(parseColor("#abc"), { red: 170 / 255, green: 187 / 255, blue: 204 / 255, alpha: 1 }); assert.deepEqual(parseColor("#1234"), parseColor("#11223344"));
    assert.deepEqual(parseColor("rgba(255, 0, 127.5, .5)"), { red: 1, green: 0, blue: .5, alpha: .5 }); assert.deepEqual(parseColor("rgb(100%, 0%, 50%)"), { red: 1, green: 0, blue: .5, alpha: 1 });
    assert.deepEqual(parseColor("rgba(-1,300,0,200%)"), { red: 0, green: 1, blue: 0, alpha: 1 }); assert.ok(sameColor(parseColor("rgb(1e-3, 2, 3)")!, parseColor(rgbaColor(parseColor("rgb(1e-3, 2, 3)")!))!));
    for (const text of ["#12", "#12345", "#123456789", "#abcdz", "hsl(0,0%,0%)", "rgb(1%,2,3)", "rgb(1,2,3,4)", "rgba(1,2,3,NaN)", "rgb(1e999,0,0)", "url(unsafe)", " ".repeat(97)]) assert.equal(parseColor(text), undefined);
    assert.equal(hexColor(parseColor("rgba(1,2,3,.5)")!), undefined); assert.equal(hexColor(parseColor("#11223380")!), "#11223380");
});
test("streamed color ranges remain exact across chunk boundaries, BOM/CRLF, supplementary letters and huge malformed tokens", () => {
    const literals = ['"#abc"', "#1234", "#112233", "#01020380", "rgba(1, 2, 3, .5)", "RGB(10%,20%,30%)"];
    for (const literal of literals) {
        for (let split = 1; split < literal.length; split++) {
            const prefix = " ".repeat(16384 - split);
            const { colors } = scan(prefix + literal + " ;");
            assert.equal(colors.length, 1);
            assert.equal(colors[0]!.from, prefix.length + (literal.startsWith('"') ? 1 : 0));
        }
    }
    const text = '\ufeffconst café = "😀 #abc";\r\nrgba(1,2,3,.5);\r\n#01020380'; assert.deepEqual(scan(text).colors.map(c => c.text), ["#abc", "rgba(1,2,3,.5)", "#01020380"]);
    for (const text of ["𐐀#abc", "#abc𐐀", "#abc\u200dname", "name#abc", "#abcdz", "#" + "f".repeat(32_768), "rgba(" + " ".repeat(32_768) + "1,2,3,1)"]) assert.equal(scan(text).colors.length, 0);
    for (const tail of ["𐐀#abc", "#abc𐐀"]) assert.equal(scan(" ".repeat(16383) + tail).colors.length, 0);
});
test("the scanner marks a truncated color list", () => {
    const exact = scan("#abc ".repeat(1024)), over = scan("#abc ".repeat(1025));
    assert.equal(exact.colors.length, 1024);
    assert.equal(exact.truncated, false);
    assert.equal(over.colors.length, 1024);
    assert.equal(over.truncated, true);
});
