import { fixtureModules } from "../helpers/fixture-modules.ts";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import type { Workspace, TextResourceHandle } from "../../src/index.ts";
import type { TextEditor, CompletionController, LspHighlightController } from "../../src/browser/index.ts";
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
export async function mountShadowEditor(page: Page, language: boolean) {
    const css = await readFile("src/browser/editor.css", "utf8");
    await serveModules(page, "/shadow-focus/");
    // Keep a real local response as the document origin for native WebSocket policy.
    await page.goto("/protocol/");
    await page.evaluate(async ({ css, language }) => {
        const path = "/shadow-focus/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { BrowserLspWorkspace, mountTextEditor, attachEditorLanguage, openWebSocketTransport } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const { RpcError } = await import(path + "protocol.js") as typeof import("../../src/protocol/index.ts");
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "focus", resource: "source", variant: "text" }, "Source", {
            value: "sample sample\ns",
            language: { uri: "focus:source", languageId: "generic" },
        });
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
export const shadowText = (page: Page) => page.evaluate(() => { const f = window.shadowFocus, buffer = f.workspace.document(f.source.id).buffer; return buffer.slice(0, buffer.length); });
