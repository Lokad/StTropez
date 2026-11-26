import { fixtureModules } from "../helpers/fixture-modules.ts";
import { test, expect } from "./fixtures.ts";

const serveModules = fixtureModules({
    core: "src/index.ts",
    browser: "src/browser/index.ts",
    host: "tests/fixtures/hosts/navigation.ts",
    panel: "tests/fixtures/hosts/navigation-panel.ts",
    panes: "examples/shared/language-host.ts",
    links: "tests/fixtures/hosts/document-links.ts",
    linkPanel: "tests/fixtures/hosts/document-links-panel.ts",
});

test("links and definitions retry a failed presentation and keep the requesting source", async ({ page }) => {
    const path = "/navigation-target/";
    await serveModules(page, "/navigation-target/");
    await page.route("**/protocol-fixture.js", route => route.fulfill({ contentType: "text/javascript", body: "" }));
    await page.routeWebSocket("**/lsp-fixture", client => {
        const server = client.connectToServer();
        client.onMessage(message => {
            const packet = JSON.parse(message.toString());
            if (packet.method === "textDocument/documentLink") {
                client.send(JSON.stringify({ jsonrpc: "2.0", id: packet.id, result: [{ target: "project:currency",
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } }] }));
                return;
            }
            if (packet.method !== "textDocument/definition") { server.send(message); return; }
            client.send(JSON.stringify({ jsonrpc: "2.0", id: packet.id, result: [{ uri: "library:types",
                range: { start: { line: 1, character: 5 }, end: { line: 1, character: 13 } } }] }));
        });
    });
    await page.goto("/protocol/");
    await page.setContent('<link rel="stylesheet" href="/app.css"><div id="source"></div><div id="destination"></div><div id="panel"></div><div id="links"></div>');
    const cleanup = await page.evaluateHandle(async path => {
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor, openWebSocketTransport, BrowserLspWorkspace } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const { HostNavigationTools } = await import(path + "host.js") as typeof import("../fixtures/hosts/navigation.ts");
        const { createNavigationHost } = await import(path + "panes.js") as typeof import("../../examples/shared/language-host.ts");
        const { mountNavigationPanel } = await import(path + "panel.js") as typeof import("../fixtures/hosts/navigation-panel.ts");
        const { HostDocumentLinks } = await import(path + "links.js") as typeof import("../fixtures/hosts/document-links.ts");
        const { mountDocumentLinksPanel } = await import(path + "linkPanel.js") as typeof import("../fixtures/hosts/document-links-panel.ts");
        const ws = new Workspace(), source = ws.createTextResource({ scope: "host", resource: "main", variant: "working" }, "Main",
            { value: "Currency" }, undefined, { language: { uri: "project:main", languageId: "generic" } });
        const tab = ws.tabs.open({ kind: "text", documentId: source.documentId });
        const editor = mountTextEditor(document.getElementById("source")!, ws, tab, { ariaLabel: "Main" });
        const url = new URL("/lsp-fixture", location.href); url.protocol = "ws:";
        const provider = new BrowserLspWorkspace(ws, { connect: signal => openWebSocketTransport(url.href, { signal }),
            resolveTarget: async uri => uri === "library:types" ? { text: "// declarations\ntype Currency = string", languageId: "generic" } : undefined });
        const module = ws.createTextResource({ scope: "host", resource: "currency", variant: "working" }, "Currency module",
            { value: "export const currency = 1;" }, undefined, { language: { uri: "project:currency", languageId: "generic" } });
        let destination: typeof editor | undefined;
        const attempted = new Set<string>();
        const panes = createNavigationHost({ workspace: ws, canCapture: () => true, present: id => {
            const label = id === module.documentId ? "Module" : "Declaration";
            if (!attempted.has(label)) { attempted.add(label); throw new Error(label + " pane is unavailable."); }
            destination?.dispose();
            return destination = mountTextEditor(document.getElementById("destination")!, ws, id, { ariaLabel: label });
        } });
        const notes = ws.createTextResource({ scope: "host", resource: "notes", variant: "working" }, "Notes", { value: "Plain text" });
        const notesTab = ws.tabs.open({ kind: "text", documentId: notes.documentId });
        const notesEditor = mountTextEditor(document.body.appendChild(document.createElement("div")), ws, notesTab, { ariaLabel: "Notes" });
        // The host closes an unrelated, non-language pane while the declaration lookup is in flight.
        const host = new HostNavigationTools(panes, { provider, prepare: () => async () => { notesEditor.dispose(); } });
        host.attach("notes", notesEditor);
        const links = new HostDocumentLinks(panes, { provider, prepare: () => async () => {} });
        links.setAlias("currency", module.documentId);
        links.attach("notes", notesEditor);
        links.attach("source", editor);
        const removeLinks = mountDocumentLinksPanel(document.getElementById("links")!, links);
        const detach = host.attach("source", editor), removePanel = mountNavigationPanel(document.getElementById("panel")!, host);
        editor.focus();
        return async () => {
            const loaded = destination && ws.observeDocument(destination.view.documentId);
            removeLinks(); links.dispose(); removePanel(); detach(); host.dispose(); panes.history.dispose(); destination?.dispose(); editor.dispose(); provider.dispose();
            await new Promise<void>(done => requestAnimationFrame(() => done()));
            return loaded !== undefined && loaded.getSnapshot() === undefined;
        };
    }, path);
    const findDefinition = page.getByRole("button", { name: "Find definition", exact: true });
    const discoverLinks = page.getByRole("button", { name: "Discover module links", exact: true });
    await page.getByRole("textbox", { name: "Notes", exact: true }).focus();
    await expect(findDefinition).toBeDisabled();
    await expect(discoverLinks).toBeDisabled();
    await page.getByRole("textbox", { name: "Main", exact: true }).focus();
    await expect(findDefinition).toBeEnabled();
    await discoverLinks.click();
    const link = page.getByRole("list", { name: "Module link results" }).getByRole("button");
    await link.click();
    await expect(page.getByLabel("Module link status", { exact: true })).toHaveText("Module pane is unavailable.");
    await expect(page.getByRole("button", { name: "Return to link origin" })).toBeDisabled();
    await link.click();
    await expect(page.getByRole("textbox", { name: "Module", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Return to link origin" }).click();
    await expect(page.getByRole("textbox", { name: "Main", exact: true })).toBeFocused();
    await findDefinition.click();
    await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Symbol navigation status", { exact: true })).toHaveText("Declaration pane is unavailable.");
    await expect(page.getByRole("button", { name: "Return to navigation origin" })).toBeDisabled();
    await findDefinition.click();
    const target = page.getByRole("textbox", { name: "Declaration" });
    await expect(target).toBeFocused(); await expect(target).toHaveAttribute("readonly", "");
    const start = (await target.inputValue()).indexOf("Currency");
    expect(await target.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd]))
        .toEqual([start, start]);
    await page.getByRole("button", { name: "Return to navigation origin" }).click();
    await expect(page.getByRole("textbox", { name: "Main", exact: true })).toBeFocused();
    expect(await cleanup.evaluate(dispose => dispose())).toBe(true);
});
