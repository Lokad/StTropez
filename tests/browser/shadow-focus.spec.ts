import { isolatedTest as test, expect } from "./fixtures.ts";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Page } from "@playwright/test";
import type { Workspace, TextResourceHandle, TabId } from "../../src/index.ts";
import type { EditingCandidate, LspEditorController, LspHighlightController } from "../../src/browser/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";

type Fixture = { workspace: Workspace; source: TextResourceHandle; tab: TabId; editor: EditingCandidate;
    provider?: LspWorkspace; completion?: LspEditorController; highlights?: LspHighlightController;
    errors: string[]; cancellations: string[]; dispose: () => Promise<void> };
declare global { interface Window { shadowFocus: Fixture } }
let modules: Map<string, string>, css: string;
test.beforeAll(async () => {
    const built = await build({ entryPoints: { core: "src/index.ts", browser: "src/browser/index.ts", protocol: "src/protocol/index.ts" },
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
        const { mountEditingCandidate, createLspEditor, createLspHighlightController, openWebSocketTransport } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const { LspWorkspace, RpcError } = await import(path + "protocol.js") as typeof import("../../src/protocol/index.ts");
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "focus", resource: "source", variant: "text" }, "Source", { value: "sample sample\ns" });
        const tab = workspace.open({ kind: "text", documentId: source.documentId }, "source");
        const outer = document.createElement("div"), inner = document.createElement("div"), outside = document.createElement("button");
        outside.id = "shadow-focus-outside"; outside.textContent = "Outside"; document.body.append(outside, outer); outer.attachShadow({ mode: "open" }).append(inner);
        const tree = inner.attachShadow({ mode: "closed" }), style = document.createElement("style"), host = document.createElement("section");
        style.textContent = css; host.style.cssText = "height:240px;width:600px"; tree.append(style, host);
        const editor = mountEditingCandidate(host, workspace, tab, { ariaLabel: "Shadow source" }), errors: string[] = [], cancellations: string[] = [];
        // A cancelled request may already be removed when its peer's cancellation reply arrives.
        // The protocol reports that late reply; keep it distinct from unexpected diagnostics.
        const report = (error: unknown) => { if (error instanceof RpcError && error.code === -32800) cancellations.push(error.message); else errors.push(String(error)); };
        const f: Fixture = { workspace, source, tab, editor, errors, cancellations, dispose: async () => {
            f.highlights?.dispose(); f.completion?.destroy(); f.provider?.dispose(); editor.destroy(); workspace.close(tab);
            await Promise.resolve(); workspace.releaseResource(source.id, true); outer.remove(); outside.remove();
        } }; window.shadowFocus = f;
        if (language) {
            const endpoint = new URL("/lsp-fixture", location.href); endpoint.protocol = "ws:";
            f.provider = new LspWorkspace(workspace, { documentInfo: doc => ({ uri: `focus:${doc.resourceId}`, languageId: "generic" }),
                connect: context => { const abort = new AbortController(), stop = context.onCancel(() => abort.abort());
                    return openWebSocketTransport(endpoint.href, { signal: abort.signal }).finally(stop); },
                schedule: (ms, work) => { const timer = setTimeout(work, ms); return () => clearTimeout(timer); },
                features: ["textDocument/completion", "textDocument/documentHighlight"], onError: report });
            f.completion = createLspEditor(workspace, tab, editor, { provider: f.provider, onError: report });
            f.highlights = createLspHighlightController(workspace, tab, editor, { provider: f.provider, delayMs: 0 });
        }
    }, { css, language });
    return page.evaluateHandle(() => window.shadowFocus.editor.input);
}
const text = (page: Page) => page.evaluate(() => { const f = window.shadowFocus, buffer = f.workspace.document(f.source.documentId).buffer; return buffer.slice(0, buffer.length); });
const completion = (page: Page) => page.evaluate(() => window.shadowFocus.completion!.state.getSnapshot());

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
        await expect.poll(() => page.evaluate(() => window.shadowFocus.highlights!.state.getSnapshot().items.length)).toBe(2);
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
        await expect.poll(() => page.evaluate(() => window.shadowFocus.highlights!.state.getSnapshot().items.length)).toBe(0);
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
