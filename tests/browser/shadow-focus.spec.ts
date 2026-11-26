import { isolatedTest as test, expect } from "./fixtures.ts";
import { mountShadowEditor as mount, shadowText as text } from "./shadow-editor.ts";
import type { Page } from "@playwright/test";
import type { InputConflictDetail } from "../../src/browser/index.ts";

const completion = (page: Page) => page.evaluate(() => window.shadowFocus.completion!.getSnapshot());

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
