import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer } from "../src/index.ts";
import { DocumentColorsCursor, parseColor, hexColor, rgbaColor, sameColor, validateColorsInput, validateColorsResult, validateColorPresentationInput, provideColorPresentations, validateColorPresentationsResult } from "../fixtures/language/colors.ts";
import { ProviderProject } from "../fixtures/language/project.ts";
const capture = (text: string) => validateColorsInput({ id: 1, document: "source", revision: 4, length: text.length, delay: 0 });
function scan(text: string) { const input = capture(text), buffer = TextBuffer.from(text), cursor = new DocumentColorsCursor(input, buffer); let work = 0;
    for (;;) { const step = cursor.next(); assert.ok(step.work >= work && step.work - work <= 16384); work = step.work; if (step.result) { assert.equal(work, text.length); return { input, buffer, result: step.result }; } }
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
    for (const literal of literals) for (let split = 1; split < literal.length; split++) { const prefix = " ".repeat(16384 - split), x = scan(prefix + literal + " ;"), result = validateColorsResult(x.result, x.input, x.buffer); assert.equal(result.colors.length, 1); assert.equal(result.colors[0]!.from, prefix.length + (literal.startsWith('"') ? 1 : 0)); assert.equal(x.buffer.readMetrics().textExports, 0); }
    const text = '\ufeffconst café = "😀 #abc";\r\nrgba(1,2,3,.5);\r\n#01020380', x = scan(text); assert.deepEqual(validateColorsResult(x.result, x.input, x.buffer).colors.map(c => c.text), ["#abc", "rgba(1,2,3,.5)", "#01020380"]);
    for (const text of ["𐐀#abc", "#abc𐐀", "#abc\u200dname", "name#abc", "#abcdz", "#" + "f".repeat(1000000), "rgba(" + " ".repeat(1000000) + "1,2,3,1)"]) { const y = scan(text); assert.equal(validateColorsResult(y.result, y.input, y.buffer).colors.length, 0); }
    for (const tail of ["𐐀#abc", "#abc𐐀"]) { const y = scan(" ".repeat(16383) + tail); assert.equal(validateColorsResult(y.result, y.input, y.buffer).colors.length, 0); }
});
test("complete color batches reject malformed later ranges/channels, overlap and truncation before publication", () => {
    const x = scan("#abc #def"), first = x.result.colors[0]!;
    for (const result of [{ ...x.result, complete: false }, { ...x.result, revision: 5 }, { ...x.result, colors: [first, first] }, { ...x.result, colors: [...x.result.colors, { ...first, from: -1 }] }, { ...x.result, colors: [{ ...first, to: 1000000 }] }, { ...x.result, colors: [{ ...first, color: { ...first.color, red: 2 } }] }, { ...x.result, colors: [{ ...first, text: "#bad" }] }]) assert.throws(() => validateColorsResult(result, x.input, x.buffer));
    const exact = scan("#abc ".repeat(1024)), over = scan("#abc ".repeat(1025)); assert.equal(validateColorsResult(exact.result, exact.input, exact.buffer).colors.length, 1024); assert.throws(() => validateColorsResult(over.result, over.input, over.buffer), /exceed/);
    const safe = validateColorsResult({ ...x.result, colors: [{ ...first, label: '<img onerror="execute()">' }] }, x.input, x.buffer); assert.match(safe.colors[0]!.label, /<img/);
});
test("presentation validation checks every choice/edit and preserves exact alpha instead of silently quantizing hex", () => {
    const x = scan("let color = '#abc';"), reference = x.result.colors[0]!, input = validateColorPresentationInput({ ...x.input, id: 2, discovery: 1, reference, proposed: parseColor("#11223344") }, x.buffer), result = provideColorPresentations(input);
    assert.deepEqual(result.presentations.map(p => p.id), ["hex", "rgba"]); assert.ok(result.presentations.every(p => sameColor(parseColor(p.edits[0]!.edits[0]!.insert)!, input.proposed)));
    const precise = validateColorPresentationInput({ ...input, proposed: parseColor("rgba(1,2,3,.5)") }, x.buffer); assert.deepEqual(provideColorPresentations(precise).presentations.map(p => p.id), ["rgba"]);
    const last = result.presentations[1]!; for (const bad of [{ ...result, complete: false }, { ...result, discovery: 9 }, { ...result, proposed: { ...input.proposed, alpha: NaN } }, { ...result, presentations: [result.presentations[0], { ...last, edits: [{ document: "source", revision: 4, edits: [{ from: reference.from, to: reference.to, insert: "#11223344" }, { from: -1, to: 0, insert: "bad late edit" }] }] }] }, { ...result, presentations: [{ ...last, edits: [{ document: "unknown", revision: 4, edits: last.edits[0]!.edits }] }] }, { ...result, presentations: [{ ...last, edits: [{ document: "source", revision: 4, edits: [{ from: reference.from, to: reference.to, insert: "#ff0000" }] }] }] }]) assert.throws(() => validateColorPresentationsResult(bad, input));
    assert.throws(() => validateColorPresentationInput({ ...input, reference: { ...reference, text: "#bad" } }, x.buffer));
});
test("resident colors and presentations require acknowledged revisions, serialize scans and never mutate worker buffers", () => {
    const project = new ProviderProject(6), send = (operation: string, fields: Record<string, unknown> = {}) => project.handle({ version: 1, epoch: 6, sequence: project.snapshot().sequence + 1, operation, ...fields }); send("project-hello"); const text = " ".repeat(50000) + "#abc", x = scan(text);
    send("project-open", { document: "source", revision: 4, length: text.length }); for (let from = 0; from < text.length; from += 16384) send("project-chunk", { document: "source", revision: 4, from, text: text.slice(from, from + 16384) }); send("project-commit", { document: "source", revision: 4 }); const before = project.buffer("source");
    assert.throws(() => send("project-colors", { input: { ...x.input, revision: 5 } })); send("project-colors", { input: x.input }); assert.equal(project.snapshot().colorsPending, true); assert.throws(() => send("project-close", { document: "source", revision: 4 }));
    let work = 0, reference = x.result.colors[0]!; for (;;) { const reply = send("project-colors-next", { request: 1 }); assert.ok((reply.work as number) - work <= 16384); work = reply.work as number; if (reply.operation === "project-colors-result") { reference = validateColorsResult(reply.result, x.input, x.buffer).colors[0]!; break; } }
    const input = validateColorPresentationInput({ ...x.input, id: 2, discovery: 1, reference, proposed: parseColor("#123456") }, x.buffer), reply = send("project-color-presentations", { input }); validateColorPresentationsResult(reply.result, input); assert.equal(project.buffer("source"), before); assert.equal(before!.readMetrics().textExports, 0); assert.throws(() => send("project-color-presentations", { input }));
});
