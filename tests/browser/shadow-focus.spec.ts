import { isolatedTest as test, expect } from "./fixtures.ts";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Page } from "@playwright/test";
import type { Workspace, TextResourceHandle, TabId } from "../../src/index.ts";
import type { TextEditor, InputConflictDetail, CompletionController, LspHighlightController } from "../../src/browser/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";

type Fixture = { workspace: Workspace; source: TextResourceHandle; tab: TabId; editor: TextEditor;
    provider?: LspWorkspace; completion?: CompletionController; highlights?: LspHighlightController;
    errors: string[]; cancellations: string[]; dispose: () => Promise<void> };
declare global { interface Window { shadowFocus: Fixture } }
let modules: Map<string, string>, css: string;
test.beforeAll(async () => {
    const built = await build({ entryPoints: { core: "src/index.ts", browser: "src/browser/index.ts", protocol: "src/protocol/index.ts", baseline: "fixtures/textarea-editor.ts" },
        outdir: "artifacts/shadow-focus", bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", write: false });
    modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text])); css = await readFile("src/browser/editor.css", "utf8");
});
async function mount(page: Page, language: boolean) {
    await page.route("**/shadow-focus/**", route => {
        const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
        return route.fulfill({ contentType: "text/javascript", body: modules.get(name)! });
    });
    // Keep a real local response as the document origin for native WebSocket policy.
    await page.goto("/viewport/");
    await page.evaluate(async ({ css, language }) => {
        const path = "/shadow-focus/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { BrowserLspWorkspace, mountTextEditor, createCompletionController, createLspHighlightController, openWebSocketTransport } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const { RpcError } = await import(path + "protocol.js") as typeof import("../../src/protocol/index.ts");
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "focus", resource: "source", variant: "text" }, "Source", { value: "sample sample\ns" }, undefined,
            { language: { uri: "focus:source", languageId: "generic" } });
        const tab = workspace.tabs.open({ kind: "text", documentId: source.documentId }, "source");
        const outer = document.createElement("div"), inner = document.createElement("div"), outside = document.createElement("button");
        outside.id = "shadow-focus-outside"; outside.textContent = "Outside"; document.body.append(outside, outer); outer.attachShadow({ mode: "open" }).append(inner);
        const tree = inner.attachShadow({ mode: "closed" }), style = document.createElement("style"), host = document.createElement("section");
        style.textContent = css; host.style.cssText = "height:240px;width:600px"; tree.append(style, host);
        const editor = mountTextEditor(host, workspace, tab, { ariaLabel: "Shadow source" }), errors: string[] = [], cancellations: string[] = [];
        // A cancelled request may already be removed when its peer's cancellation reply arrives.
        // The protocol reports that late reply; keep it distinct from unexpected diagnostics.
        const report = (error: unknown) => { if (error instanceof RpcError && error.code === -32800) cancellations.push(error.message); else errors.push(String(error)); };
        const f: Fixture = { workspace, source, tab, editor, errors, cancellations, dispose: async () => {
            f.highlights?.dispose(); f.completion?.dispose(); f.provider?.dispose(); editor.dispose(); workspace.tabs.close(tab);
            await Promise.resolve(); workspace.releaseResource(source.id, true); outer.remove(); outside.remove();
        } }; window.shadowFocus = f;
        if (language) {
            const endpoint = new URL("/lsp-fixture", location.href); endpoint.protocol = "ws:";
            f.provider = new BrowserLspWorkspace(workspace, {
                connect: signal => openWebSocketTransport(endpoint.href, { signal }), onError: report });
            f.completion = createCompletionController(editor, f.provider, { onError: report });
            f.highlights = createLspHighlightController(editor, { provider: f.provider, delayMs: 0 });
        }
    }, { css, language });
    return page.evaluateHandle(() => window.shadowFocus.editor.input);
}
const text = (page: Page) => page.evaluate(() => { const f = window.shadowFocus, buffer = f.workspace.document(f.source.documentId).buffer; return buffer.slice(0, buffer.length); });
const completion = (page: Page) => page.evaluate(() => window.shadowFocus.completion!.getSnapshot());

test("reconnect advertises the surviving pane's controllers before its first link request", async ({ page }) => {
    await mount(page, true);
    const epochs = await page.evaluate(async () => {
        const path = "/shadow-focus/browser.js";
        const { mountTextEditor, createCompletionController, createDocumentLinkController } = await import(path) as typeof import("../../src/browser/index.ts");
        const { workspace, source, editor, provider, dispose } = window.shadowFocus;
        const host = document.createElement("div"); document.body.append(host);
        const second = mountTextEditor(host, workspace, source.documentId);
        try {
            await provider!.connect();
            const advertised = () => [...provider!.getSnapshot().clientFeatures].sort();
            const first = advertised();
            createCompletionController(second, provider!, { autoConnect: false });
            createDocumentLinkController(second, provider!);
            editor.dispose();
            const unchanged = advertised();
            await provider!.reconnect(); const survivor = advertised();
            second.dispose();
            await provider!.reconnect();
            return [first, unchanged, survivor, advertised()];
        } finally { second.dispose(); host.remove(); await dispose(); }
    });
    const first = ["textDocument/completion", "textDocument/documentHighlight"];
    expect(epochs).toEqual([first, first, ["textDocument/completion", "textDocument/documentLink"], []]);
});

test("completion distinguishes host preparation failures from malformed provider replies and keeps local typing available", async ({ page }) => {
    await page.routeWebSocket("**/lsp-fixture", client => {
        const server = client.connectToServer(); server.onMessage(message => client.send(message));
        client.onMessage(message => {
            const value = JSON.parse(message.toString());
            if (value.method === "textDocument/completion") { client.send(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: [null] })); return; }
            server.send(message);
        });
    });
    const input = await mount(page, true);
    try {
        await expect.poll(async () => (await completion(page)).connected).toBe(true);
        for (const failure of ["type", "range", "none"] as const) {
            await page.evaluate(async failure => {
                const path = "/shadow-focus/", { createCompletionController } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
                const f = window.shadowFocus; f.completion!.dispose();
                f.completion = createCompletionController(f.editor, f.provider!, { autoConnect: false, automatic: false,
                    prepareCompletion: async () => {
                        if (failure === "type") throw new TypeError("Host preparation failed.");
                        if (failure === "range") throw new RangeError("Host preparation failed.");
                    } });
            }, failure);
            await input.focus(); await input.press("Control+Space");
            const expected = failure === "none" ? { failed: 0, invalid: 1, received: 1 } : { failed: 1, invalid: 0, received: 0 };
            await expect.poll(() => page.evaluate(() => {
                const { failed, invalid, received } = window.shadowFocus.completion!.getDiagnostics(); return { failed, invalid, received };
            })).toEqual(expected);
            expect((await completion(page)).choices).toEqual([]);
        }
        const before = await text(page); await input.press("Control+End"); await input.press(";");
        await expect.poll(() => text(page)).toBe(before + ";");
        expect(await page.evaluate(() => window.shadowFocus.errors)).toEqual([]);
    } finally { await page.evaluate(() => window.shadowFocus.dispose()); }
});

test("nested shadow focus supports occurrences, automatic completion, deferred acceptance and snippet composition", async ({ page }, info) => {
    info.annotations.push({ type: "input-qualification", description: "Composition events are synthetic; this does not qualify native IME." });
    let release: (() => void) | undefined, cancellations = 0;
    await page.routeWebSocket("**/lsp-fixture", client => {
        const server = client.connectToServer(); server.onMessage(message => client.send(message));
        client.onMessage(message => {
            const value = JSON.parse(message.toString());
            if (value.method === "$/cancelRequest") cancellations++;
            if (value.method === "textDocument/completion") {
                client.send(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: [{ label: "sample", insertTextFormat: 2,
                    textEdit: { newText: "sample(${1:value})$0", range: { start: { line: value.params.position.line, character: 0 }, end: value.params.position } }, data: { uri: value.params.textDocument.uri } }] })); return;
            }
            if (value.method === "completionItem/resolve") { release = () => client.send(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: { ...value.params, detail: "Resolved" } })); return; }
            server.send(message);
        });
    });
    const input = await mount(page, true);
    try {
        await expect.poll(async () => (await completion(page)).connected).toBe(true);
        await page.evaluate(() => window.shadowFocus.completion!.customRequest("fixture/completionStyle", { style: "interactive" }));
        await input.focus(); await page.evaluate(() => window.shadowFocus.editor.view.setSelection(0, { anchor: 1, head: 1 }));
        await expect.poll(() => page.evaluate(() => window.shadowFocus.highlights!.getSnapshot().items.length)).toBe(2);
        expect(await page.evaluate(() => document.activeElement === window.shadowFocus.editor.input)).toBe(false);
        await input.press("Control+End"); await input.press("a");
        await expect.poll(async () => (await completion(page)).choices).toEqual(["sample"]); await expect.poll(() => !!release).toBe(true);
        await input.press("Tab"); expect(await text(page)).toBe("sample sample\nsa"); release!(); release = undefined;
        await expect.poll(async () => (await completion(page)).snippet?.stop).toBe(1); expect(await text(page)).toBe("sample sample\nsample(value)");
        await input.evaluate(node => { node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" })); });
        expect((await completion(page)).snippet?.stop).toBe(1); await input.press("Tab"); expect((await completion(page)).snippet).toBeNull();
        await input.press("Control+z"); expect(await text(page)).toBe("sample sample\nsa");
        await input.press("Control+Space"); await expect.poll(() => !!release).toBe(true); await input.press("Tab");
        await page.locator("#shadow-focus-outside").focus(); release!(); release = undefined;
        await expect.poll(async () => (await completion(page)).resolving).toBe(false); expect(await text(page)).toBe("sample sample\nsa");
        await expect.poll(() => page.evaluate(() => window.shadowFocus.highlights!.getSnapshot().items.length)).toBe(0);
        expect(await page.evaluate(() => window.shadowFocus.errors)).toEqual([]);
        const reported = await page.evaluate(() => window.shadowFocus.cancellations);
        expect(reported.length).toBeLessThanOrEqual(cancellations);
        await info.attach("cancelled-requests", { body: JSON.stringify({ requests: cancellations, reported }), contentType: "application/json" });
    } finally { await input.dispose(); await page.evaluate(() => window.shadowFocus.dispose()); }
    expect(await page.evaluate(() => window.shadowFocus.workspace.diagnostics())).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});

test("removing a focused fold disclosure inside a shadow root returns typing to its source", async ({ page }) => {
    const input = await mount(page, false);
    try {
        await page.evaluate(() => { const f = window.shadowFocus, folds = f.editor.view.folding; folds.setRanges(folds.getSnapshot(), [{ id: "body", from: 0, to: 15, collapsed: false }]); f.editor.viewport.flush();
            const button = f.editor.element.querySelector<HTMLButtonElement>(".st-fold-button"); if (!button) throw new Error("Fold disclosure missing"); button.focus(); });
        expect(await input.evaluate(node => (node.getRootNode() as ShadowRoot).activeElement?.classList.contains("st-fold-button"))).toBe(true);
        await page.evaluate(() => { const f = window.shadowFocus, folds = f.editor.view.folding; folds.setRanges(folds.getSnapshot(), []); f.editor.viewport.flush(); });
        expect(await input.evaluate(node => (node.getRootNode() as ShadowRoot).activeElement === node)).toBe(true);
        await page.keyboard.press("x"); expect(await text(page)).toBe("xsample sample\ns");
    } finally { await input.dispose(); await page.evaluate(() => window.shadowFocus.dispose()); }
    expect(await page.evaluate(() => window.shadowFocus.workspace.diagnostics())).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});

test("public input recovery reaches retained listeners inside a closed root before disposal", async ({ page }) => {
    const input = await mount(page, false);
    try {
        const result = await page.evaluate(async () => {
            const path = "/shadow-focus/browser.js";
            const { inputConflictEvent } = await import(path) as typeof import("../../src/browser/index.ts");
            const baselinePath = "/shadow-focus/baseline.js";
            const { mountTextareaEditor } = await import(baselinePath) as typeof import("../../fixtures/textarea-editor.ts");
            const f = window.shadowFocus, host = f.editor.element.parentElement!, listeners = new AbortController();
            const native = mountTextareaEditor(host, f.workspace, f.tab), received: { detail: InputConflictDetail; frozen: boolean; bubbles: boolean; composed: boolean }[] = [];
            const states: { focused: boolean; composing: boolean; disabled: boolean }[] = [];
            f.editor.subscribe(() => { const { focused, composing, disabled } = f.editor.getSnapshot(); states.push({ focused, composing, disabled }); });
            f.editor.focus();
            let inside = 0, outside = 0;
            host.addEventListener(inputConflictEvent, () => inside++, { signal: listeners.signal });
            document.addEventListener(inputConflictEvent, () => outside++, { signal: listeners.signal });
            try {
                for (const [node, dispose] of [[f.editor.input, f.editor.dispose], [native.element, native.dispose]] as const) {
                    node.addEventListener(inputConflictEvent, event => { const detail = (event as CustomEvent<InputConflictDetail>).detail;
                        received.push({ detail, frozen: Object.isFrozen(detail), bubbles: event.bubbles, composed: event.composed }); }, { signal: listeners.signal });
                    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); node.value = "uncommitted 東京";
                    dispose();
                }
                return { name: inputConflictEvent, received, inside, outside, states, documentId: f.source.documentId, revision: f.workspace.document(f.source.documentId).revision };
            } finally { native.dispose(); listeners.abort(); }
        });
        expect(result.states).toEqual([
            { focused: true, composing: false, disabled: false },
            { focused: true, composing: true, disabled: false },
            { focused: false, composing: false, disabled: true },
        ]);
        expect(result.name).toBe("sttropez-conflict"); expect(result.inside).toBe(2); expect(result.outside).toBe(0);
        expect(result.revision).toBe(0); expect(await text(page)).toBe("sample sample\ns");
        expect(result.received).toEqual([0, undefined].map(contextFrom => ({ frozen: true, bubbles: true, composed: false,
            detail: { documentId: result.documentId, expectedRevision: 0, reason: "composition-detached", attemptedText: "uncommitted 東京", ...(contextFrom === undefined ? {} : { contextFrom }) } })));
    } finally { await input.dispose(); await page.evaluate(() => window.shadowFocus.dispose()); }
    expect(await page.evaluate(() => window.shadowFocus.workspace.diagnostics())).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});
