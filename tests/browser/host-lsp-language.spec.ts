import { ready, isolatedTest as test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const field = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
async function seed(page: Page, text: string, offset = text.length) {
    await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, text);
    await field(page).focus(); await page.evaluate(at => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: at, head: at }); }, offset);
    await expect.poll(async () => (await snapshot(page)).bindings.language.sessions.find(session => session.id === "primary")!.provider.connected).toBe(true);
}
async function settledColorsAndLinks(page: Page) {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && !s.bindings.colors.state.pending && !s.bindings.links.state.pending; });
}
async function exact(page: Page, text: string) {
    expect(await page.evaluate(text => { const f = window.hostFixture; if (f.snapshot().source.length !== text.length) return false;
        for (let at = 0; at < text.length; at += 32768) if (f.range(at, Math.min(text.length, at + 32768)) !== text.slice(at, at + 32768)) return false;
        return true;
    }, text)).toBe(true);
}
async function disposeColorsAndLinks(page: Page) {
    await page.evaluate(() => window.hostFixture.dispose()); const state = await snapshot(page);
    expect(state.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(state.hostSubscriptions).toBe(0);
    for (const feature of [state.bindings.colors, state.bindings.links]) expect(feature).toMatchObject({ transport: null, sessions: 0, subscriptions: 0, disposed: true, worker: { created: 0 } });
    expect(state.bindings.colors.decoratedViews).toBe(0);
}
for (const host of ["plain", "react"] as const) test.describe(`${host} selected LSP features`, () => {
    test.beforeEach(async ({ page }) => {  await page.goto(`/hosts/${host}/?editor=candidate&language=lsp`); await expect(field(page)).toBeVisible(); });
    test("paged links and colors keep unresolved targets and invalid form values inert and reject oversized lists", async ({ page }) => {
        const methods: string[] = []; page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method) methods.push(value.method); }));
        const line = 'import "sample-utils";\r\n#abc;\r\n', text = line.repeat(70) + 'import "missing-utils";';
        await seed(page, text, text.indexOf("#abc") + 2); await button(page, "Add module companion").click(); const before = await snapshot(page);
        const links = page.getByLabel("Module link results", { exact: true }), colors = page.getByLabel("Document color results", { exact: true });
        await button(page, "Discover module links").click(); await settledColorsAndLinks(page); await expect(links.getByRole("listitem")).toHaveCount(64);
        await expect(button(page, "Previous module links")).toBeDisabled(); await button(page, "Next module links").click(); await expect(links.getByRole("listitem")).toHaveCount(7);
        await expect(button(page, "Next module links")).toBeDisabled(); await expect(links.getByRole("button").last()).toBeEnabled();
        await links.getByRole("button").last().click(); await settledColorsAndLinks(page); await expect(links.getByRole("button").last()).toBeDisabled();
        expect((await snapshot(page)).bindings.links.opened).toBe(0); await button(page, "Previous module links").click(); await expect(links.getByRole("listitem")).toHaveCount(64);
        await button(page, "Discover document colors").click(); await settledColorsAndLinks(page); await expect(colors.getByRole("listitem")).toHaveCount(64);
        await expect(button(page, "Previous document colors")).toBeDisabled(); await button(page, "Next document colors").click(); await expect(colors.getByRole("listitem")).toHaveCount(6);
        await expect(button(page, "Next document colors")).toBeDisabled(); await colors.getByRole("button").last().click();
        await expect(button(page, "Preview color presentations")).toBeEnabled();
        expect(await page.locator(".st-document-color").count()).toBeGreaterThan(0); expect(await page.locator(".st-document-color").count()).toBeLessThan(150);
        const previews = (await snapshot(page)).bindings.colors.previews, presentations = methods.filter(method => method === "textDocument/colorPresentation").length;
        await field(page, "Proposed color").fill('url("https://invalid.example/")'); await expect(button(page, "Preview color presentations")).toBeDisabled(); await expect(button(page, "Apply captured color")).toBeDisabled();
        await page.evaluate(() => window.hostFixture.previewColor()); await page.evaluate(() => window.hostFixture.providerCustom("fixture/state", {}));
        expect((await snapshot(page)).bindings.colors.previews).toBe(previews); expect(methods.filter(method => method === "textDocument/colorPresentation")).toHaveLength(presentations);
        await exact(page, text); expect((await snapshot(page)).history).toEqual(before.history); expect((await snapshot(page)).source.revision).toBe(before.source.revision);
        for (const method of ["textDocument/documentLink", "documentLink/resolve", "textDocument/documentColor"]) expect(methods).toContain(method);
        const oversized = line.repeat(1025); await seed(page, oversized, oversized.indexOf("#abc") + 2); const overflow = await snapshot(page);
        await button(page, "Discover module links").click(); await settledColorsAndLinks(page); await expect(links.getByRole("listitem")).toHaveCount(0);
        expect((await snapshot(page)).bindings.links.state.status).toBe("failed"); await expect(page.getByLabel("Module link status", { exact: true })).toContainText("limit");
        await button(page, "Discover document colors").click(); await settledColorsAndLinks(page); await expect(colors.getByRole("listitem")).toHaveCount(0);
        expect((await snapshot(page)).bindings.colors.state.status).toBe("failed"); await expect(page.getByLabel("Document color status", { exact: true })).toContainText("limit");
        expect((await snapshot(page)).bindings.colors.decoratedViews).toBe(0); await exact(page, oversized);
        expect((await snapshot(page)).history).toEqual(overflow.history); expect((await snapshot(page)).source.revision).toBe(overflow.source.revision);
        expect((await snapshot(page)).source.exports).toBe(0); await disposeColorsAndLinks(page);
    });
    test("secondary-resource color edits and explicit reveal keep primary Save and Run identity", async ({ page }) => {
        const text = 'import "sample-utils";', original = 'const color = "#abc";\r\nexport const value = 1;\r\n', expected = original.replace("#abc", "#112233");
        await seed(page, text, 10); await button(page, "Add module companion").click(); const companion = (await snapshot(page)).bindings.links.companion!;
        await page.evaluate(id => { const f = window.hostFixture, document = f.navigationDocument(id); f.editLinkTarget(id, document.revision, [{ from: 0, to: 0, insert: 'const color = "#abc";\r\n' }]); }, companion);
        await button(page, "Discover module links").click(); await settledColorsAndLinks(page); await page.getByLabel("Module link results", { exact: true }).getByRole("button").click();
        await settledColorsAndLinks(page); await expect(field(page, "Secondary source")).toBeFocused();
        await button(page, "Discover document colors").click(); await settledColorsAndLinks(page); expect((await snapshot(page)).bindings.colors.capture!.view).toBe("secondary");
        await field(page, "Proposed color").fill("#112233"); await button(page, "Preview color presentations").click(); await settledColorsAndLinks(page);
        await button(page, "Apply captured color").click(); await settledColorsAndLinks(page); expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(expected); await exact(page, text);
        await field(page).focus(); await button(page, "Open color changes in Module companion").click(); await expect(field(page, "Secondary source")).toBeFocused();
        await field(page, "Secondary source").press("Control+z"); await settledColorsAndLinks(page); expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(original);
        await field(page, "Secondary source").press("Control+Shift+z"); await settledColorsAndLinks(page); expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(expected);
        await button(page, "Run captured inputs").click(); expect(await page.evaluate(() => window.hostFixture.runCapture(0)!.source)).toBe(text); await page.evaluate(() => window.hostFixture.finishRun());
        await button(page, "Save source").click(); await page.evaluate(() => window.hostFixture.finishSave()); await settledColorsAndLinks(page);
        await exact(page, text); expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(expected); await disposeColorsAndLinks(page);
    });
    test("provider color presentations preview every edit and preserve shared history while cancelled requests leave text intact", async ({ page }) => {
        const methods: string[] = []; page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method) methods.push(value.method); }));
        const raw = '\ufeffconst color = "#abc";\r\nvalue;'; await seed(page, raw);
        await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 4, head: 1 }, { anchor: 20, head: 20 }], 1); });
        const before = await snapshot(page), proposed = page.getByRole("textbox", { name: "Proposed color", exact: true });
        await button(page, "Discover document colors").click(); await expect.poll(async () => (await snapshot(page)).bindings.colors.state.count).toBe(1);
        await proposed.fill("rgba(1, 2, 3, 0.5)"); await button(page, "Preview color presentations").click(); await expect(button(page, "Apply captured color")).toBeEnabled();
        await expect(page.getByLabel("Proposed color edits", { exact: true }).getByRole("listitem")).toHaveCount(2);
        await button(page, "Apply captured color").click(); const expected = "// color presentation\r\n" + raw.replace("#abc", "rgba(1, 2, 3, 0.5)");
        expect(await page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); })).toBe(expected); expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
        await field(page, "Secondary source").press("Control+z"); expect(await page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); })).toBe(raw);
        expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selectionSet).toEqual(before.bindings.views.find(view => view.id === "primary")!.selectionSet);
        await field(page).focus(); await button(page, "Discover document colors").click(); await expect.poll(async () => (await snapshot(page)).bindings.colors.state.count).toBe(1);
        await proposed.fill("#112233"); await page.evaluate(() => window.hostFixture.setColorsDelay(650)); await button(page, "Preview color presentations").click();
        await expect.poll(async () => (await snapshot(page)).bindings.colors.state.pending).toBe(true); await proposed.fill("#445566"); await page.waitForTimeout(700);
        await expect(button(page, "Apply captured color")).toBeDisabled(); expect(await page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); })).toBe(raw);
        expect((await snapshot(page)).bindings.colors.state.pending).toBe(false); expect((await snapshot(page)).bindings.colors.worker.created).toBe(0); expect((await snapshot(page)).source.exports).toBe(0);
        expect(methods).toContain("textDocument/documentColor"); expect(methods).toContain("textDocument/colorPresentation");
    });
    test("provider links resolve to captured host resources and late or outside destinations do not steal focus", async ({ page }) => {
        const methods: string[] = []; page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method) methods.push(value.method); }));
        let outside = false, hold = false, release: (() => void) | undefined;
        await page.routeWebSocket("**/lsp-fixture", client => {
            const server = client.connectToServer(), held = new Set<number>();
            client.onMessage(message => { const value = JSON.parse(message.toString());
                if (value.method === "documentLink/resolve") {
                    if (hold) { hold = false; held.add(value.id); }
                    if (outside) { outside = false; server.send(JSON.stringify({ ...value, params: { ...value.params, _fixture: { delay: 0, fault: "outside" } } })); return; }
                }
                server.send(message);
            });
            server.onMessage(message => { const value = JSON.parse(message.toString());
                if (held.delete(value.id)) release = () => client.send(message); else client.send(message); });
        });
        await page.reload(); await expect(field(page)).toBeVisible();
        const text = 'import "sample-utils";\r\nvalue;'; await seed(page, text); await button(page, "Add module companion").click();
        const history = (await snapshot(page)).history, list = page.getByLabel("Module link results", { exact: true });
        await button(page, "Discover module links").click(); await expect(list.getByRole("button")).toHaveCount(1); await expect(list.getByRole("button")).toBeEnabled();
        await list.getByRole("button").click(); await expect.poll(async () => (await snapshot(page)).bindings.links.opened).toBe(1); await expect(field(page, "Secondary source")).toBeFocused();
        await button(page, "Return to link origin").click(); await expect(field(page)).toBeFocused(); expect((await snapshot(page)).history).toEqual(history); expect((await snapshot(page)).bindings.links.worker.created).toBe(0);
        await button(page, "Discover module links").click(); await expect(list.getByRole("button")).toBeEnabled();
        outside = true; await list.getByRole("button").click(); expect(outside).toBe(false);
        await expect(page.getByLabel("Module link status", { exact: true })).toContainText("outside the host"); await expect(list.getByRole("button")).toBeDisabled(); expect((await snapshot(page)).bindings.links.opened).toBe(1);
        await field(page).focus(); await button(page, "Discover module links").click(); await expect(list.getByRole("button")).toBeEnabled();
        hold = true; await list.getByRole("button").click(); await expect.poll(() => !!release).toBe(true);
        await field(page, "Configuration path").focus(); release!(); release = undefined;
        await page.evaluate(() => window.hostFixture.providerCustom("fixture/state", {}));
        await expect.poll(async () => (await snapshot(page)).bindings.links.state.pending).toBe(false);
        await expect(field(page, "Configuration path")).toBeFocused(); expect((await snapshot(page)).bindings.links.opened).toBe(1);
        expect(methods).toContain("textDocument/documentLink"); expect(methods).toContain("documentLink/resolve"); expect((await snapshot(page)).source.exports).toBe(0);
    });
    test("advertised signature triggers and retriggers show active parameters without taking completion shortcuts", async ({ page }) => {
        const contexts: { triggerKind: number; triggerCharacter?: string; isRetrigger: boolean; activeSignatureHelp?: unknown }[] = [];
        page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method === "textDocument/signatureHelp") contexts.push(value.params.context); }));
        const popup = page.getByRole("tooltip", { name: "Signature help", exact: true }), parameter = popup.getByLabel("Active signature parameter", { exact: true });
        await seed(page, "lookup"); await field(page).pressSequentially("("); await expect(parameter).toHaveText("key: string"); expect(contexts[0]).toMatchObject({ triggerKind: 2, triggerCharacter: "(", isRetrigger: false });
        await field(page).pressSequentially("'key',"); await expect(parameter).toHaveText("fallback?: string");
        expect(contexts.at(-1)).toMatchObject({ triggerKind: 2, triggerCharacter: ",", isRetrigger: true }); expect(contexts.at(-1)!.activeSignatureHelp).toBeTruthy();
        const before = await snapshot(page), posted = before.bindings.language.sessions.find(session => session.id === "primary")!.provider.posted;
        await field(page).press("Control+Shift+Space"); await expect.poll(async () => (await snapshot(page)).bindings.signature.applied).toBe(before.bindings.signature.applied + 1); await expect(parameter).toHaveText("fallback?: string");
        expect(contexts.at(-1)).toMatchObject({ triggerKind: 1, isRetrigger: false }); expect((await snapshot(page)).bindings.language.sessions.find(session => session.id === "primary")!.provider.posted).toBe(posted);
        expect((await snapshot(page)).history).toEqual(before.history); expect((await snapshot(page)).bindings.signature.worker.created).toBe(0);
        await field(page).press("Escape"); await expect(popup).not.toBeVisible();
        await seed(page, "lookup(saMORE)", 9); await field(page).press("Control+Shift+Space"); await expect(popup).toBeVisible();
        await field(page).press("Control+Space"); await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible();
        await field(page).press("Escape"); await expect(page.getByRole("option")).toHaveCount(0); await expect(popup).toBeVisible();
        await field(page).press("Escape"); await expect(popup).not.toBeVisible();
        await page.evaluate(() => window.hostFixture.setSignatureDelay(1000)); await field(page).press("Control+Shift+Space"); await expect.poll(async () => (await snapshot(page)).bindings.signature.pending).toBe(true);
        await field(page, "Configuration path").fill("while-signature.csv"); await expect.poll(async () => (await snapshot(page)).bindings.signature.pending).toBe(false);
        await expect(field(page, "Configuration path")).toBeFocused(); expect((await snapshot(page)).source.exports).toBe(0);
    });
    if (host === "react") test("100k-line signature, link resolution and a selected color presentation use bounded source controls", async ({ page }) => {
        const prefix = "const unchanged = 123;\r\n".repeat(100_000), tail = 'lookup("a", )\r\nimport "sample-utils";\r\nconst color = "#abc";', raw = prefix + tail;
        await seed(page, raw, prefix.length + tail.indexOf(")")); await field(page).press("Control+Shift+Space");
        await expect(page.getByRole("tooltip", { name: "Signature help", exact: true }).getByLabel("Active signature parameter", { exact: true })).toHaveText("fallback?: string");
        await field(page).press("Escape"); await button(page, "Add module companion").click(); await button(page, "Discover module links").click();
        const links = page.getByLabel("Module link results", { exact: true }); await expect(links.getByRole("button")).toHaveCount(1); await links.getByRole("button").click();
        await expect.poll(async () => (await snapshot(page)).bindings.links.opened).toBe(1); await button(page, "Return to link origin").click();
        await button(page, "Discover document colors").click(); await expect.poll(async () => (await snapshot(page)).bindings.colors.state.count).toBe(1);
        await page.getByRole("textbox", { name: "Proposed color", exact: true }).fill("#112233"); await button(page, "Preview color presentations").click(); await expect(button(page, "Apply captured color")).toBeEnabled();
        const depth = (await snapshot(page)).history.undoDepth; await button(page, "Apply captured color").click();
        expect(await page.evaluate(from => { const f = window.hostFixture; return f.range(from, f.snapshot().source.length); }, prefix.length)).toBe(tail.replace("#abc", "#112233"));
        const state = await snapshot(page); expect(state.history.undoDepth).toBe(depth + 1); expect(state.source.exports).toBe(0);
        for (const view of state.bindings.views) { expect(view.metrics!.inputUnits).toBeLessThanOrEqual(4096); expect(view.metrics!.viewport.rows).toBeLessThan(100); }
        await field(page).press("Control+z"); expect(await page.evaluate(from => { const f = window.hostFixture; return f.range(from, f.snapshot().source.length); }, prefix.length)).toBe(tail);
    });
});
test("missing and withdrawn language capabilities fail explicitly without a worker fallback or a late color edit", async ({ page }) => {
     await page.goto("/hosts/plain/?editor=candidate&language=lsp&lspSubset=dynamic");
    const text = 'lookup("a", )\r\nconst color = "#abc";'; await seed(page, text, text.indexOf(")"));
    await field(page).press("Control+Shift+Space"); await expect.poll(async () => (await snapshot(page)).bindings.signature.presentation.status).toBe("failed");
    await button(page, "Discover module links").click(); await expect.poll(async () => (await snapshot(page)).bindings.links.state.status).toBe("failed");
    await button(page, "Discover document colors").click(); await expect.poll(async () => (await snapshot(page)).bindings.colors.state.status).toBe("failed");
    const methods = ["textDocument/signatureHelp", "textDocument/documentLink", "textDocument/documentColor"];
    await page.evaluate(methods => window.hostFixture.providerCustom("fixture/register", { registrations: methods.map((method, i) => ({ id: `selected-${i}`, method, registerOptions: { documentSelector: null, ...(i === 0 ? { triggerCharacters: ["("], retriggerCharacters: [","] } : {}), ...(i === 1 ? { resolveProvider: true } : {}) } })) }), methods);
    await field(page).press("Control+Shift+Space"); await expect(page.getByRole("tooltip", { name: "Signature help", exact: true })).toBeVisible(); await field(page).press("Escape");
    await button(page, "Discover document colors").click(); await expect.poll(async () => (await snapshot(page)).bindings.colors.state.count).toBe(1);
    await page.getByRole("textbox", { name: "Proposed color", exact: true }).fill("#112233"); await page.evaluate(() => window.hostFixture.setColorsDelay(650)); await button(page, "Preview color presentations").click();
    await expect.poll(async () => (await snapshot(page)).bindings.colors.state.pending).toBe(true);
    await page.evaluate(() => window.hostFixture.providerCustom("fixture/unregister", { unregisterations: [{ id: "selected-2", method: "textDocument/documentColor" }] }));
    await expect.poll(async () => (await snapshot(page)).bindings.colors.state.pending).toBe(false); await expect(button(page, "Apply captured color")).toBeDisabled();
    const state = await snapshot(page); expect(state.bindings.signature.worker.created).toBe(0); expect(state.bindings.links.worker.created).toBe(0); expect(state.bindings.colors.worker.created).toBe(0);
    expect(await page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); })).toBe(text);
});
