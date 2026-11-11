import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
const test = base.extend({ page: async ({ playwright, browserName, baseURL }, use) => {
    const browser = await playwright[browserName].launch({ headless: true });
    try { await use(await browser.newPage({ ...(baseURL ? { baseURL } : {}), viewport: { width: 1440, height: 900 } })); } finally { await browser.close(); }
} });
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const field = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
async function seed(page: Page, text: string, offset = text.length) {
    await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, text);
    await field(page).focus(); await page.evaluate(at => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: at, head: at }); }, offset);
    await expect.poll(async () => (await snapshot(page)).bindings.language.sessions.find(session => session.id === "primary")!.provider.connected).toBe(true);
}
for (const host of ["plain", "react"] as const) test.describe(`${host} selected LSP features`, () => {
    test.beforeEach(async ({ page }) => { page.on("pageerror", error => { throw error; }); await page.goto(`/hosts/${host}/?editor=candidate&language=lsp`); await expect(field(page)).toBeVisible(); });
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
        const text = 'import "sample-utils";\r\nvalue;'; await seed(page, text); await button(page, "Add module companion").click();
        const history = (await snapshot(page)).history, list = page.getByLabel("Module link results", { exact: true });
        await button(page, "Discover module links").click(); await expect(list.getByRole("button")).toHaveCount(1); await expect(list.getByRole("button")).toBeEnabled();
        await list.getByRole("button").click(); await expect.poll(async () => (await snapshot(page)).bindings.links.opened).toBe(1); await expect(field(page, "Secondary source")).toBeFocused();
        await button(page, "Return to link origin").click(); await expect(field(page)).toBeFocused(); expect((await snapshot(page)).history).toEqual(history); expect((await snapshot(page)).bindings.links.worker.created).toBe(0);
        await button(page, "Discover module links").click(); await expect(list.getByRole("button")).toBeEnabled();
        await page.evaluate(() => window.hostFixture.providerCustom("fixture/linksResolveConfig", { delay: 0, fault: "outside" })); await list.getByRole("button").click();
        await expect(page.getByLabel("Module link status", { exact: true })).toContainText("outside the host"); await expect(list.getByRole("button")).toBeDisabled(); expect((await snapshot(page)).bindings.links.opened).toBe(1);
        await field(page).focus(); await button(page, "Discover module links").click(); await expect(list.getByRole("button")).toBeEnabled();
        await page.evaluate(() => window.hostFixture.providerCustom("fixture/linksResolveConfig", { delay: 650 })); await list.getByRole("button").click();
        await field(page, "Configuration path").focus(); await expect.poll(async () => (await snapshot(page)).bindings.links.state.pending).toBe(false);
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
    page.on("pageerror", error => { throw error; }); await page.goto("/hosts/plain/?editor=candidate&language=lsp&lspSubset=dynamic");
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
