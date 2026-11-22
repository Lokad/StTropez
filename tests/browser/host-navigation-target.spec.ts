import { build } from "esbuild";
import { basename } from "node:path";
import { test, expect } from "./fixtures.ts";

test("the navigation panel opens a declaration loaded by the host resolver and returns to the source", async ({ page }) => {
    const path = "/navigation-target/";
    const built = await build({ entryPoints: { core: "src/index.ts", browser: "src/browser/index.ts",
        host: "examples/hosts/navigation.ts", panel: "examples/hosts/navigation-panel.ts" },
        outdir: "artifacts/navigation-target", bundle: true, splitting: true, format: "esm", platform: "browser", write: false });
    const modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text]));
    await page.route("**/navigation-target/*.js", route =>
        route.fulfill({ contentType: "text/javascript", body: modules.get(basename(route.request().url()))! }));
    await page.route("**/workspace-fixture.js", route => route.fulfill({ contentType: "text/javascript", body: "" }));
    await page.routeWebSocket("**/lsp-fixture", client => {
        const server = client.connectToServer();
        client.onMessage(message => {
            const packet = JSON.parse(message.toString());
            if (packet.method !== "textDocument/definition") { server.send(message); return; }
            client.send(JSON.stringify({ jsonrpc: "2.0", id: packet.id, result: [{ uri: "library:types",
                range: { start: { line: 1, character: 5 }, end: { line: 1, character: 13 } } }] }));
        });
    });
    await page.goto("/workspace/");
    await page.setContent('<link rel="stylesheet" href="/app.css"><div id="source"></div><div id="destination"></div><div id="panel"></div>');
    const cleanup = await page.evaluateHandle(async path => {
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor, openWebSocketTransport, BrowserLspWorkspace } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const { HostNavigationTools } = await import(path + "host.js") as typeof import("../../examples/hosts/navigation.ts");
        const { mountNavigationPanel } = await import(path + "panel.js") as typeof import("../../examples/hosts/navigation-panel.ts");
        const ws = new Workspace(), source = ws.createTextResource({ scope: "host", resource: "main", variant: "working" }, "Main",
            { value: "Currency" }, undefined, { language: { uri: "project:main", languageId: "generic" } });
        const tab = ws.tabs.open({ kind: "text", documentId: source.documentId }, "Main");
        const editor = mountTextEditor(document.getElementById("source")!, ws, tab, { ariaLabel: "Main" });
        const url = new URL("/lsp-fixture", location.href); url.protocol = "ws:";
        const provider = new BrowserLspWorkspace(ws, { connect: signal => openWebSocketTransport(url.href, { signal }),
            resolveTarget: async uri => uri === "library:types" ? { text: "// declarations\ntype Currency = string", languageId: "generic" } : undefined });
        let destination: typeof editor | undefined, attempts = 0;
        const host = new HostNavigationTools({ workspace: ws, canCapture: () => true, present: id => {
            if (++attempts === 1) throw new Error("Declaration pane is unavailable.");
            return destination = mountTextEditor(document.getElementById("destination")!, ws, id, { ariaLabel: "Declaration" });
        } }, { provider, prepare: () => async () => {} });
        const detach = host.attach("source", tab, editor), removePanel = mountNavigationPanel(document.getElementById("panel")!, host);
        editor.focus();
        return async () => {
            const loaded = destination && ws.observeDocument(destination.view.documentId);
            removePanel(); detach(); host.dispose(); destination?.dispose(); editor.dispose(); provider.dispose();
            await new Promise<void>(done => requestAnimationFrame(() => done()));
            return loaded !== undefined && loaded.getSnapshot() === undefined;
        };
    }, path);
    await page.getByRole("button", { name: "Find definition", exact: true }).click();
    const row = page.getByRole("button", { name: "library:types:2:6 · declaration", exact: true });
    await expect(row).toBeVisible(); await row.click();
    await expect(page.getByLabel("Symbol navigation status", { exact: true })).toHaveText("Declaration pane is unavailable.");
    await expect(page.getByRole("button", { name: "Return to navigation origin" })).toBeDisabled();
    await row.click();
    const target = page.getByRole("textbox", { name: "Declaration" });
    await expect(target).toBeFocused(); await expect(target).toHaveAttribute("readonly", "");
    expect(await target.evaluate(node => { const field = node as HTMLTextAreaElement; return field.value.slice(field.selectionStart, field.selectionEnd); })).toBe("Currency");
    await page.getByRole("button", { name: "Return to navigation origin" }).click();
    await expect(page.getByRole("textbox", { name: "Main", exact: true })).toBeFocused();
    expect(await cleanup.evaluate(dispose => dispose())).toBe(true);
});
