import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { TextDocument } from "vscode-languageserver-protocol/browser.js";
import { BrowserLanguageService } from "../examples/demo/browser-language-service.ts";
import { changeDemoDocument } from "../examples/demo/document-changes.ts";
import { demoSample } from "../examples/demo/samples.ts";
import { parseDocumentation } from "../src/core/documentation.ts";
import type { CompletionList, CompletionItem } from "vscode-languageserver-protocol/browser.js";

test("provider mirrors apply each change against the preceding text and preserve captured versions", () => {
    const doc = TextDocument.create("file:///main.ts", "typescript", 1, "ab\rcd\r\n😀 end");
    const at = (line: number, start: number, end: number, text: string) =>
        ({ range: { start: { line, character: start }, end: { line, character: end } }, text });
    const changes = [
        at(2, 3, 6, "fin"), at(1, 1, 2, "D"), at(0, 0, 1, "A"),
        at(2, 3, 6, "last"), { text: "A\rB" }, at(1, 0, 0, "\n"), at(1, 0, 1, "C"),
        at(1, 1, 1, "!"), at(1, 1, 1, "?"),
    ];
    const result = changeDemoDocument(doc, 2, changes);
    assert.equal(result.getText(), "A\r\nC?!");
    assert.equal(result.version, 2);
    assert.equal(doc.getText(), "ab\rcd\r\n😀 end");
    assert.equal(changeDemoDocument(doc, 2, changes.slice(0, 4)).getText(), "Ab\rcD\r\n😀 last");
    assert.throws(() => changeDemoDocument(doc, 2, [{ text: "oversize" }, { text: "" }], 4), /exceeds its limit/);
});

test("browser provider resolves closed sample modules and declarations without pretending they are synchronized", () => {
    const sample = demoSample("navigation"), backing = { ...sample.files, ...sample.declarations };
    const provider = new BrowserLanguageService({}, Object.keys(backing), backing), uri = "file:///sttropez/main.ts", text = backing["main.ts"]!;
    const doc = TextDocument.create(uri, "typescript", 1, text);
    try {
        provider.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text } });
        const at = (word: string) => ({ textDocument: { uri }, position: doc.positionAt(text.lastIndexOf(word) + 2) });
        for (const [symbol, name] of [["formatLabel", "labels.ts"], ["RecordId", "contracts.d.ts"]]) {
            const locations = provider.request("textDocument/definition", at(symbol!)) as { uri: string }[];
            assert.equal(locations[0]!.uri, `file:///sttropez/${name}`);
            assert.deepEqual(provider.request("sttropez/readDocument", { uri: locations[0]!.uri }), { uri: locations[0]!.uri, text: backing[name!] });
        }
        const renamed = provider.request("textDocument/rename", { ...at("LabelOptions"), newName: "DisplayOptions" }) as { documentChanges: { textDocument: { uri: string; version: number | null }; edits: unknown[] }[] };
        assert.equal(renamed.documentChanges.find(item => item.textDocument.uri.endsWith("/labels.ts"))!.textDocument.version, null);
        assert.equal(renamed.documentChanges.find(item => item.textDocument.uri === uri)!.textDocument.version, 1);
        assert.throws(() => provider.request("sttropez/readDocument", { uri: "file:///outside.ts" }));
    } finally { provider.dispose(); }
});

test("browser TypeScript occurrences distinguish writes and reads in raw UTF-16 source", () => {
    const provider = new BrowserLanguageService({}, ["main.ts"]), uri = "file:///sttropez/main.ts";
    const text = "// 😀\r\nlet value = 1;\r\nvalue = value + 1;\r\n", document = TextDocument.create(uri, "typescript", 1, text);
    try {
        provider.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text } });
        const initialized = provider.request("initialize", {}) as { capabilities: { documentHighlightProvider: boolean } };
        assert.equal(initialized.capabilities.documentHighlightProvider, true);
        const result = provider.request("textDocument/documentHighlight", { textDocument: { uri }, position: document.positionAt(text.indexOf("value")) }) as { range: { start: { line: number; character: number }; end: { line: number; character: number } }; kind: number }[];
        assert.deepEqual(result.map(item => ({ text: document.getText(item.range), kind: item.kind })), [{ text: "value", kind: 3 }, { text: "value", kind: 3 }, { text: "value", kind: 2 }]);
    } finally { provider.dispose(); }
});

test("browser signature help formats JSDoc links in prose and preserves code examples", () => {
    const provider = new BrowserLanguageService({}, ["main.ts"]), uri = "file:///sttropez/main.ts";
    const text = ["/** See {@linkcode prices} and {@link prices | the prices}.",
        " * {@link https://www.typescriptlang.org/docs/ | TS guide}",
        " * Literal `{@linkcode prices}`.", " * ~~~ts", " * {@linkcode prices}", " * ~~~",
        " * @param prices Use {@linkcode prices}.", " */", "function total(prices: number[]) {}", "total("].join("\n");
    try {
        provider.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text } });
        const doc = TextDocument.create(uri, "typescript", 1, text);
        type Markdown = { kind: "markdown"; value: string };
        const response = provider.request("textDocument/signatureHelp", { textDocument: { uri }, position: doc.positionAt(text.length) }) as
            { signatures: { documentation: Markdown; parameters: { documentation: Markdown }[] }[] };
        const signature = response.signatures[0]!;
        assert.deepEqual(parseDocumentation([signature.documentation]), [
            { kind: "paragraph", children: [{ kind: "text", value: "See " }, { kind: "code", value: "prices" },
                { kind: "text", value: " and the prices.\n" }, { kind: "link", target: "https://www.typescriptlang.org/docs/",
                    title: "https://www.typescriptlang.org/docs/", children: [{ kind: "text", value: "TS guide" }] },
                { kind: "text", value: "\nLiteral " }, { kind: "code", value: "{@linkcode prices}" }, { kind: "text", value: "." }] },
            { kind: "code", language: "ts", value: "{@linkcode prices}" },
        ]);
        assert.deepEqual(parseDocumentation([signature.parameters[0]!.documentation]), [{ kind: "paragraph", children: [
            { kind: "text", value: "Use " }, { kind: "code", value: "prices" }, { kind: "text", value: "." }] }]);
    } finally { provider.dispose(); }
});

test("browser TypeScript folding uses outlining spans without requiring a cursor", () => {
    const provider = new BrowserLanguageService({}, ["main.ts"]), uri = "file:///sttropez/main.ts";
    try {
        provider.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text: "function demo() {\r\n  return 1;\r\n}\r\n" } });
        const initialized = provider.request("initialize", {}) as { capabilities: { foldingRangeProvider: boolean } };
        assert.equal(initialized.capabilities.foldingRangeProvider, true);
        assert.deepEqual(provider.request("textDocument/foldingRange", { textDocument: { uri } }), [{ startLine: 0, endLine: 1, kind: "code" }]);
    } finally { provider.dispose(); }
});

test("demo templates resolve captured primary content and imports and expire after a source edit", () => {
    const provider = new BrowserLanguageService({}, ["templates.ts", "types.ts"]), uri = "file:///sttropez/templates.ts";
    const text = demoSample("templates").files["templates.ts"]!, doc = TextDocument.create(uri, "typescript", 1, text);
    try {
        provider.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text } });
        const list = provider.request("textDocument/completion", { textDocument: { uri }, position: doc.positionAt(text.length) }) as CompletionList;
        assert.equal(list.items.length, 4);
        const lazy = list.items.find(item => item.label === "Template · lazy declaration")!;
        assert.equal(lazy.textEdit, undefined);
        const resolved = provider.request("completionItem/resolve", lazy) as CompletionItem;
        assert.match(resolved.textEdit!.newText, /TemplateRecord/); assert.equal(resolved.additionalTextEdits?.length, 1);
        provider.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: "changed" }] });
        assert.throws(() => provider.request("completionItem/resolve", lazy), /source changed/);
    } finally { provider.dispose(); }
});

test("the real TypeScript catalogue returns every field and bounds lazy keys by response lifetime", () => {
    const provider = new BrowserLanguageService({}, ["catalogue.ts"]), uri = "file:///sttropez/catalogue.ts";
    const text = demoSample("catalogue").files["catalogue.ts"]! + "catalogue.", doc = TextDocument.create(uri, "typescript", 1, text);
    try {
        provider.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text } });
        const request = () => provider.request("textDocument/completion", { textDocument: { uri }, position: doc.positionAt(text.length) }) as { isIncomplete: boolean; items: { label: string; data: unknown }[] };
        const first = request(); assert.equal(first.items.length, 1200); assert.equal(first.isIncomplete, false);
        const tail = first.items.find(item => item.label === "item1199")!; assert.ok(tail);
        request(); assert.match(JSON.stringify(provider.request("completionItem/resolve", tail)), /item1199/);
        request(); assert.throws(() => provider.request("completionItem/resolve", tail), /no longer available/);
    } finally { provider.dispose(); }
});

test("browser TypeScript provider preserves raw UTF-16/CRLF changes and confines versioned open files", async () => {
    const libraries = Object.fromEntries(await Promise.all((await readdir("node_modules/typescript-demo/lib"))
        .filter(name => /^lib[\w.-]*\.d\.ts$/.test(name)).map(async name => [name, await readFile(`node_modules/typescript-demo/lib/${name}`, "utf8")])));
    const provider = new BrowserLanguageService(libraries, ["main.ts", "pricing.ts"]);
    const sample = demoSample("errors"), uri = "file:///sttropez/main.ts", text = "// café 👩‍💻\r\n" + sample.files["main.ts"]!;
    try {
        for (const [name, source] of Object.entries(sample.files)) provider.notify("textDocument/didOpen", {
            textDocument: { uri: `file:///sttropez/${name}`, languageId: "typescript", version: 1, text: name === "main.ts" ? text : source },
        });
        const diagnostics = provider.request("sttropez/diagnostics", { uri, kind: "semantic" }) as { success: boolean; body: { code: number; range: { start: { line: number; character: number }; end: { line: number; character: number } } }[] };
        assert.equal(diagnostics.success, true);
        const error = diagnostics.body.find(error => error.code === 2551); assert.ok(error);
        const doc = TextDocument.create(uri, "typescript", 1, text);
        assert.equal(text.slice(doc.offsetAt(error.range.start), doc.offsetAt(error.range.end)), "quanity");
        provider.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [
            { range: error.range, text: "quantity" },
        ] });
        assert.deepEqual((provider.request("sttropez/diagnostics", { uri, kind: "semantic" }) as typeof diagnostics).body, []);
        assert.throws(() => provider.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: "stale" }] }), /synchronization/);
        assert.deepEqual((provider.request("sttropez/diagnostics", { uri, kind: "semantic" }) as typeof diagnostics).body, []);
        assert.throws(() => provider.notify("textDocument/didOpen", { textDocument: { uri: "file:///outside.ts", version: 1, text: "" } }), /Invalid demo document/);
        assert.throws(() => provider.request("sttropez/diagnostics", { uri: "file:///lib/lib.es2022.d.ts", kind: "semantic" }), /Only open demo/);
        provider.notify("textDocument/didClose", { textDocument: { uri } });
        assert.throws(() => provider.request("sttropez/diagnostics", { uri, kind: "semantic" }), /Only open demo/);
    } finally { provider.dispose(); }
    assert.throws(() => provider.request("initialize", {}), /closed/);
});
