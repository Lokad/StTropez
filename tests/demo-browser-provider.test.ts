import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { TextDocument } from "vscode-languageserver-protocol/browser.js";
import { BrowserLanguageService } from "../examples/demo/browser-language-service.ts";
import { demoSample } from "../examples/demo/samples.ts";
import type { CompletionList, CompletionItem } from "vscode-languageserver-protocol/browser.js";

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
        const diagnostics = provider.request("sttropez/diagnostics", { uri, kind: "semantic" }) as { success: boolean; body: { code: number; start: number; length: number }[] };
        assert.equal(diagnostics.success, true);
        const error = diagnostics.body.find(error => error.code === 2345); assert.ok(error);
        assert.equal(text.slice(error.start, error.start + error.length), '"10%"');
        const doc = TextDocument.create(uri, "typescript", 1, text), from = text.indexOf('"10%"');
        provider.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [
            { range: { start: doc.positionAt(from), end: doc.positionAt(from + 5) }, text: "0.2" },
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
