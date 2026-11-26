import { isolatedTest as test, expect } from "./fixtures.ts";
import { fixtureModules } from "../helpers/fixture-modules.ts";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import type { Workspace, TextResourceHandle } from "../../src/index.ts";
import type { TextEditor, InputConflictDetail, CompletionController, LspHighlightController } from "../../src/browser/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";

const serveModules = fixtureModules({
    core: "src/index.ts",
    browser: "src/browser/index.ts",
    protocol: "src/protocol/index.ts",
});

type Fixture = { workspace: Workspace; source: TextResourceHandle; editor: TextEditor;
    provider?: LspWorkspace; completion?: CompletionController; highlights?: LspHighlightController;
    errors: string[]; cancellations: string[]; dispose: () => Promise<void> };
declare global { interface Window { shadowFocus: Fixture } }
let css: string;
test.beforeAll(async () => { css = await readFile("src/browser/editor.css", "utf8"); });
async function mount(page: Page, language: boolean) {
    await serveModules(page, "/shadow-focus/");
    // Keep a real local response as the document origin for native WebSocket policy.
    await page.goto("/protocol/");
    await page.evaluate(async ({ css, language }) => {
        const path = "/shadow-focus/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { BrowserLspWorkspace, mountTextEditor, attachEditorLanguage, openWebSocketTransport } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const { RpcError } = await import(path + "protocol.js") as typeof import("../../src/protocol/index.ts");
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "focus", resource: "source", variant: "text" }, "Source", { value: "sample sample\ns" }, undefined,
            { language: { uri: "focus:source", languageId: "generic" } });
        const outer = document.createElement("div"), inner = document.createElement("div"), outside = document.createElement("button");
        outside.id = "shadow-focus-outside"; outside.textContent = "Outside"; document.body.append(outside, outer); outer.attachShadow({ mode: "open" }).append(inner);
        const tree = inner.attachShadow({ mode: "closed" }), style = document.createElement("style"), host = document.createElement("section");
        style.textContent = css; host.style.cssText = "height:240px;width:600px"; tree.append(style, host);
        const editor = mountTextEditor(host, workspace, source.id, { ariaLabel: "Shadow source" }), errors: string[] = [], cancellations: string[] = [];
        // A cancelled request may already be removed when its peer's cancellation reply arrives.
        // The protocol reports that late reply; keep it distinct from unexpected diagnostics.
        const report = (error: unknown) => { if (error instanceof RpcError && error.code === -32800) cancellations.push(error.message); else errors.push(String(error)); };
        const f: Fixture = { workspace, source, editor, errors, cancellations, dispose: async () => {
            editor.dispose(); f.provider?.dispose();
            await Promise.resolve(); workspace.releaseResource(source.id, true); outer.remove(); outside.remove();
        } }; window.shadowFocus = f;
        if (language) {
            const endpoint = new URL("/lsp-fixture", location.href); endpoint.protocol = "ws:";
            f.provider = new BrowserLspWorkspace(workspace, {
                connect: signal => openWebSocketTransport(endpoint.href, { signal }), onError: report });
            const language = attachEditorLanguage(editor, f.provider, { completion: { onError: report }, occurrences: { delayMs: 0 } });
            f.completion = language.completion;
            f.highlights = language.occurrences;
        }
    }, { css, language });
    return page.evaluateHandle(() => window.shadowFocus.editor.element.querySelector("textarea")!);
}
const text = (page: Page) => page.evaluate(() => { const f = window.shadowFocus, buffer = f.workspace.document(f.source.id).buffer; return buffer.slice(0, buffer.length); });
const completion = (page: Page) => page.evaluate(() => window.shadowFocus.completion!.getSnapshot());

test("native undo and redo belong to the focused text field", async ({ page }) => {
    const input = await mount(page, false), original = await text(page);
    await input.focus();
    await page.keyboard.type("X");
    const edited = await text(page);
    expect(edited).not.toBe(original);
    const field = page.getByRole("textbox", { name: "Search the document" });
    await page.evaluate(() => {
        const search = document.createElement("input");
        search.setAttribute("aria-label", "Search the document");
        document.body.append(search);
    });
    await field.fill("query");
    await field.press("Control+z");
    await expect(field).toHaveValue("");
    await field.press("Control+z");
    // Engines can deliver native history events to the last edited textarea after focus moves.
    const dispatchHistory = (inputType: string) => input.evaluate((node, inputType) => {
        for (const type of ["beforeinput", "input"]) {
            node.dispatchEvent(new InputEvent(type, { inputType, bubbles: true, cancelable: type === "beforeinput" }));
        }
    }, inputType);
    await dispatchHistory("historyUndo");
    expect(await text(page)).toBe(edited);
    await input.focus();
    await page.keyboard.press("Control+z");
    expect(await text(page)).toBe(original);
    await field.focus();
    await dispatchHistory("historyRedo");
    expect(await text(page)).toBe(original);
    await input.focus();
    await page.keyboard.press("Control+Shift+z");
    expect(await text(page)).toBe(edited);
});

test("a link controller on a later pane requests links on the already open connection", async ({ page }) => {
    await mount(page, true);
    const result = await page.evaluate(async () => {
        const path = "/shadow-focus/browser.js";
        const { mountTextEditor, attachEditorLanguage } = await import(path) as typeof import("../../src/browser/index.ts");
        const { workspace, source, editor, provider, dispose } = window.shadowFocus;
        await provider!.connect();
        const epoch = provider!.getSnapshot().epoch;
        const host = document.createElement("div"); document.body.append(host);
        const second = mountTextEditor(host, workspace, source.id);
        try {
            const { links } = attachEditorLanguage(second, provider!, { links: {} });
            editor.dispose();
            await links.request();
            return { status: links.getSnapshot().status, sameConnection: provider!.getSnapshot().epoch === epoch };
        } finally { second.dispose(); host.remove(); await dispose(); }
    });
    expect(result).toEqual({ status: "ready", sameConnection: true });
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
        await page.evaluate(async () => {
            const scope = window.shadowFocus.provider!.createScope();
            try {
                await scope.request("fixture/completionStyle", { style: "interactive" }).result;
            } finally {
                scope.dispose();
            }
        });
        await input.focus(); await page.evaluate(() => window.shadowFocus.editor.view.setSelection(0, { anchor: 1, head: 1 }));
        await expect.poll(() => page.evaluate(() => window.shadowFocus.highlights!.getSnapshot().items.length)).toBe(2);
        expect(await page.evaluate(() => document.activeElement === window.shadowFocus.editor.element.querySelector("textarea")!)).toBe(false);
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

test("discovering an expanded fold while typing preserves one undo group", async ({ page }) => {
    const input = await mount(page, false), original = await text(page);
    await input.focus();
    await page.keyboard.type("c");
    await page.evaluate(() => {
        const { editor, workspace, source } = window.shadowFocus;
        const { folding } = editor.view, buffer = workspace.document(source.id).buffer;
        const from = buffer.offsetAt(0), to = buffer.length;
        if (!folding.setRanges(folding.getSnapshot(), [{ id: "body", from, to }])) throw Error("Fold installation failed");
    });
    await page.keyboard.type("ache");
    expect(await text(page)).toBe("cache" + original);
    await page.keyboard.press("Control+z");
    expect(await text(page)).toBe(original);
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
            const f = window.shadowFocus, host = f.editor.element.parentElement!, listeners = new AbortController();
            const received: { detail: InputConflictDetail; frozen: boolean; bubbles: boolean; composed: boolean }[] = [];
            const states: { focused: boolean; composing: boolean; disabled: boolean }[] = [];
            f.editor.subscribe(() => { const { focused, composing, disabled } = f.editor.getSnapshot(); states.push({ focused, composing, disabled }); });
            f.editor.focus();
            let inside = 0, outside = 0;
            host.addEventListener(inputConflictEvent, () => inside++, { signal: listeners.signal });
            document.addEventListener(inputConflictEvent, () => outside++, { signal: listeners.signal });
            try {
                f.editor.element.addEventListener(inputConflictEvent, event => {
                    const detail = (event as CustomEvent<InputConflictDetail>).detail;
                    received.push({ detail, frozen: Object.isFrozen(detail), bubbles: event.bubbles, composed: event.composed });
                }, { signal: listeners.signal });
                const node = f.editor.element.querySelector("textarea")!;
                node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
                node.value = "é";
                f.editor.dispose();
                return { name: inputConflictEvent, received, inside, outside, states, documentId: f.source.id, revision: f.workspace.document(f.source.id).revision };
            } finally { listeners.abort(); }
        });
        expect(result.states).toEqual([
            { focused: true, composing: false, disabled: false },
            { focused: true, composing: true, disabled: false },
            { focused: false, composing: false, disabled: true },
        ]);
        expect(result.name).toBe("sttropez-conflict"); expect(result.inside).toBe(1); expect(result.outside).toBe(0);
        expect(result.revision).toBe(0); expect(await text(page)).toBe("sample sample\ns");
        expect(result.received).toEqual([{ frozen: true, bubbles: true, composed: false, detail: {
            documentId: result.documentId, expectedRevision: 0, reason: "composition-detached", attemptedText: "é", contextFrom: 0,
        } }]);
    } finally { await input.dispose(); await page.evaluate(() => window.shadowFocus.dispose()); }
    expect(await page.evaluate(() => window.shadowFocus.workspace.diagnostics())).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});
