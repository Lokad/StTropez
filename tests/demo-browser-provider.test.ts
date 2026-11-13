import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { TextDocument } from "vscode-languageserver-protocol/browser.js";
import { BrowserLanguageService } from "../examples/demo/browser-language-service.ts";
import { demoSample } from "../examples/demo/samples.ts";

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
