import { ready, isolatedTest as test, expect } from "./fixtures.ts";
import type { Page, WebSocketRoute } from "@playwright/test";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const source = (page: Page) => page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length));
const field = (page: Page) => page.getByRole("textbox", { name: "Primary source", exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const provider = async (page: Page) => (await snapshot(page)).bindings.language.sessions.find(session => session.id === "primary")!.provider;
async function seed(page: Page, text: string) {
    await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, text);
    await field(page).focus(); await page.evaluate(() => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: 8, head: 8 }); }); await ready(page);
}
async function offer(page: Page) { await field(page).press("Control+Space"); await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible(); }

test("a first-character import keeps multicaret snippet selection and atomic undo", async ({ page }) => {
    const prefix = "// import\r\n"; let resolutions = 0;
    await page.routeWebSocket("**/lsp-fixture", client => {
        const server = client.connectToServer(); server.onMessage(message => client.send(message));
        client.onMessage(message => {
            const value = JSON.parse(message.toString());
            if (value.method === "textDocument/completion") {
                const start = { line: 0, character: 0 }, end = { line: 0, character: 2 };
                client.send(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: [{ label: "sample", insertTextFormat: 2,
                    textEdit: { newText: "sample(${1:value})$0", insert: { start, end }, replace: { start, end: { line: 0, character: 6 } } } }] })); return;
            }
            if (value.method === "completionItem/resolve") {
                resolutions++;
                const at = { line: 0, character: 0 };
                client.send(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: { ...value.params, additionalTextEdits: [{ range: { start: at, end: at }, newText: prefix }] } })); return;
            }
            server.send(message);
        });
    });
    await page.goto("/hosts/plain/?editor=candidate&language=lsp"); await expect(field(page)).toBeVisible(); await ready(page);
    const initial = "saMORE\r\nsaMORE"; await seed(page, initial);
    await expect.poll(async () => (await provider(page)).connected).toBe(true);
    await page.evaluate(() => window.hostFixture.providerCustom("fixture/completionStyle", { style: "interactive" }));
    await page.evaluate(() => { const f = window.hostFixture; if (!f.selectSourceSet("primary", f.snapshot().source.revision,
        [{ anchor: 2, head: 2 }, { anchor: 10, head: 10 }], 0)) throw new Error("Caret setup failed"); });
    const before = (await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selectionSet, depth = (await snapshot(page)).history.undoDepth;
    await offer(page); await field(page).press("Alt+Enter"); await ready(page); expect(resolutions).toBe(1);
    expect(await source(page)).toBe(prefix + "sample(value)\r\nsample(value)");
    const selected = (await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selectionSet;
    expect(selected.ranges).toEqual([{ anchor: prefix.length + 7, head: prefix.length + 12, anchorAffinity: "after", headAffinity: "before" },
        { anchor: prefix.length + 22, head: prefix.length + 27, anchorAffinity: "after", headAffinity: "before" }]);
    expect((await snapshot(page)).history.undoDepth).toBe(depth + 1);
    await field(page).press("Control+z"); await ready(page); expect(await source(page)).toBe(initial);
    expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selectionSet).toEqual(before);
});

test("pending LSP diagnostics remain painted and navigable while server analysis is held", async ({ page }) => {
    let hold = false, held: string | undefined, client: WebSocketRoute | undefined;
    await page.routeWebSocket("**/lsp-fixture", socket => {
        client = socket; const server = socket.connectToServer();
        server.onMessage(message => {
            const value = JSON.parse(message.toString());
            if (hold && value.method === "textDocument/publishDiagnostics") { held = message.toString(); return; }
            socket.send(message);
        });
    });
    await page.goto("/hosts/plain/?editor=candidate&language=lsp"); await expect(field(page)).toBeVisible(); await ready(page);
    const original = "const saMORE = 1; // TODO\r\n"; await seed(page, original); await offer(page); await button(page, "Cancel request").click();
    const diagnostic = page.getByLabel("Source diagnostics", { exact: true }).getByRole("button"), status = page.getByLabel("Diagnostic status", { exact: true });
    await expect(diagnostic).toHaveText("21: Resolve this placeholder.");
    await expect(page.locator('[aria-label="Left host pane"] .st-diagnostic')).toHaveText("TODO");
    const observation = await page.evaluateHandle(() => {
        const samples: { text: string; pending: boolean | undefined; revision: number; source: number }[] = []; let frame = 0;
        const sample = () => {
            const s = window.hostFixture.snapshot(), p = s.bindings.language.sessions.find(session => session.id === "primary")!.provider;
            samples.push({ text: document.querySelector('[aria-label="Left host pane"] .st-diagnostic')?.textContent ?? "", pending: p.diagnosticsPending, revision: p.diagnosticRevision, source: s.source.revision });
            frame = requestAnimationFrame(sample);
        };
        frame = requestAnimationFrame(sample);
        return { stop: () => { cancelAnimationFrame(frame); return samples; } };
    });
    hold = true; await field(page).focus(); await field(page).press("Control+Home"); await field(page).press("Enter");
    await expect(status).toHaveText("Diagnostics pending analysis."); await expect(diagnostic).toHaveText("23: Resolve this placeholder.");
    await expect.poll(() => held).toBeDefined();
    await page.evaluate(async () => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    await diagnostic.click(); expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selection).toMatchObject({ anchor: 23, head: 27 });
    await field(page).press("Control+z"); await expect(diagnostic).toHaveText("21: Resolve this placeholder."); expect(await source(page)).toBe(original);
    await expect(status).toHaveText("Diagnostics pending analysis.");
    // A barrier ensures the held batch belongs to the undo revision before releasing it.
    await page.evaluate(() => window.hostFixture.providerCustom("fixture/diagnostics", { mode: "normal" }));
    expect(held).toBeDefined(); hold = false; client!.send(held!);
    await expect(status).toHaveText(""); await expect.poll(async () => (await provider(page)).diagnosticsPending).toBe(false);
    await expect(diagnostic).toHaveText("21: Resolve this placeholder.");
    await expect(page.locator('[aria-label="Left host pane"] .st-diagnostic')).toHaveText("TODO");
    const frames = await observation.evaluate(value => value.stop()); await observation.dispose();
    expect(frames.some(frame => frame.pending)).toBe(true);
    expect(frames.every(frame => frame.text === "TODO" && frame.revision === frame.source)).toBe(true);
});

test("unsupported completion commands preserve usable choices without issuing a command", async ({ page }) => {
    let onlyCommands = false; const methods: string[] = [];
    await page.routeWebSocket("**/lsp-fixture", client => {
        const server = client.connectToServer(); server.onMessage(message => client.send(message));
        client.onMessage(message => {
            const value = JSON.parse(message.toString()); if (value.method) methods.push(value.method);
            if (value.method === "textDocument/completion") {
                const end = value.params.position, range = { start: { line: end.line, character: end.character - 2 }, end: { ...end, character: end.character + 4 } };
                const supported = { label: "sample", textEdit: { range, newText: "sample" } };
                const unsupported = { ...supported, label: "sampleWithCommand", command: { title: "", command: "fixture.followUp", arguments: ["never execute"] } };
                client.send(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: [unsupported, ...(onlyCommands ? [] : [supported])] })); return;
            }
            if (value.method === "completionItem/resolve") { client.send(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: value.params })); return; }
            server.send(message);
        });
    });
    await page.goto("/hosts/plain/?editor=candidate&language=lsp"); await expect(field(page)).toBeVisible(); await ready(page);
    const original = "const saMORE = 1;"; await seed(page, original);
    await expect.poll(async () => (await provider(page)).connected).toBe(true); await offer(page);
    await expect(page.getByRole("option")).toHaveCount(1); await expect(page.getByRole("option", { name: "sampleWithCommand", exact: true })).toHaveCount(0);
    await button(page, "Replace completion").click(); await ready(page); expect(await source(page)).toBe("const sample = 1;");
    await field(page).press("Control+z"); expect(await source(page)).toBe(original);
    onlyCommands = true; await seed(page, original); await field(page).press("Control+Space");
    await expect(page.getByLabel("Language status", { exact: true })).toHaveText("1 unsupported completion choices omitted.");
    await expect(page.getByRole("option")).toHaveCount(0); expect(await source(page)).toBe(original);
    expect(methods).toContain("textDocument/completion"); expect(methods).not.toContain("workspace/executeCommand");
});
