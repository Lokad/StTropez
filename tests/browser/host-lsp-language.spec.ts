import { ready, isolatedTest as test, expect, expectPanelKeyReserved } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { holdLspReplies } from "../helpers/lsp-replies.ts";
import { coversHost } from "./host-cases.ts";
import { hostTextEquals } from "../../scripts/host-scene.mjs";
import { typedTextEvent } from "../../src/browser/input-events.ts";

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
async function exact(page: Page, text: string) { expect(await hostTextEquals(page, text)).toBe(true); }
async function disposeColorsAndLinks(page: Page) {
    await page.evaluate(() => window.hostFixture.dispose()); const state = await snapshot(page);
    expect(state.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(state.hostSubscriptions).toBe(0);
    for (const feature of [state.bindings.colors, state.bindings.links]) expect(feature).toMatchObject({ sessions: 0, subscriptions: 0, disposed: true });
    expect(state.bindings.colors.decoratedViews).toBe(0);
}
async function languageFailureScene(page: Page) {
    const raw = 'lookup("key", )\r\nimport "sample-utils";\r\nconst color = "#abc";';
    await seed(page, raw, raw.indexOf(")"));
    await button(page, "Add module companion").click();
    const before = await snapshot(page);
    const links = page.getByLabel("Module link results", { exact: true });
    const colors = page.getByLabel("Document color results", { exact: true });
    const popup = page.getByRole("tooltip", { name: "Signature help", exact: true });
    const proposed = field(page, "Proposed color"), apply = button(page, "Apply captured color");
    const discoverColors = async () => {
        await field(page).focus();
        await button(page, "Discover document colors").click();
        await settledColorsAndLinks(page);
    };
    const preview = async () => {
        await proposed.fill("#112233");
        await button(page, "Preview color presentations").click();
        await settledColorsAndLinks(page);
    };
    const signature = async () => {
        await field(page).focus();
        await field(page).press("Control+Shift+Space");
        await expect.poll(async () => (await snapshot(page)).bindings.signature.pending).toBe(false);
    };
    return { raw, before, links, colors, popup, apply, discoverColors, preview, signature };
}
const colorCaptureSource = 'const color = "#abc";\r\nvalue;';
async function colorCaptureScene(page: Page, text: string) {
    await seed(page, text);
    const proposed = field(page, "Proposed color"), apply = button(page, "Apply captured color");
    const discover = async () => {
        await field(page).focus(); await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 16, head: 16 }]); });
        await button(page, "Discover document colors").click(); await settledColorsAndLinks(page);
    };
    const preview = async (value: string) => { await proposed.fill(value); await button(page, "Preview color presentations").click(); await settledColorsAndLinks(page); return (await snapshot(page)).bindings.colors.state; };
    return { proposed, apply, discover, preview };
}
const linkCaptureSource = 'import "sample-utils";\r\nvalue;', linkCaptureTarget = "export const value = 1;\r\n";
async function linkCaptureScene(page: Page, text: string, editedTarget: boolean) {
    await seed(page, text, 10);
    await button(page, "Add module companion").click();
    const companion = (await snapshot(page)).bindings.links.companion!;
    const editTarget = async () => page.evaluate(id => {
        const f = window.hostFixture, document = f.navigationDocument(id);
        f.editLinkTarget(id, document.revision, [{ from: 0, to: 0, insert: "// target\r\n" }]);
    }, companion);
    if (editedTarget) await editTarget();
    const select = async () => { await field(page).focus(); await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 10, head: 10 }]); }); await settledColorsAndLinks(page); };
    const discover = async () => { await button(page, "Discover module links").click(); await settledColorsAndLinks(page); };
    return { companion, editTarget, select, discover };
}
for (const host of ["plain", "react"] as const) test.describe(`${host} selected LSP features`, () => {
    test.beforeEach(async ({ page }) => {  await page.goto(`/hosts/${host}/?editor=candidate&language=lsp`); await expect(field(page)).toBeVisible(); });
    test("painted swatches open the clicked literal in its pane and refresh after typing", async ({ page }) => {
        const raw = 'const a = "#abc";\r\nconst b = "#f008";';
        await seed(page, raw, 2);
        const source = field(page, "Secondary source"), marks = source.locator("..").locator(".host-inline-swatch");
        await expect(marks).toHaveCount(2);
        await expect(field(page)).toBeFocused();
        const before = await snapshot(page);
        await marks.nth(1).click();
        const value = field(page, "Proposed color"), selected = page.getByLabel("Document color results", { exact: true }).getByRole("button");
        await expect(value).toBeFocused();
        await expect(value).toHaveValue("#f008"); await expect(selected.nth(1)).toContainText("#f008");
        await expect(selected.nth(1)).toHaveAttribute("aria-pressed", "true");
        const opened = await snapshot(page);
        expect(opened.bindings.colors.state.view).toBe("secondary");
        expect(opened.bindings.views.map(v => v.selectionSet)).toEqual(before.bindings.views.map(v => v.selectionSet));
        await value.fill("#123456"); await value.press("Enter"); await button(page, "Apply captured color").click();
        await exact(page, raw.replace("#f008", "#123456")); await expect(source).toBeFocused();
        await source.press("Control+z"); await exact(page, raw);
        await source.press("Control+End"); await page.keyboard.insertText(' const c = "#00ff00";');
        await expect(marks).toHaveCount(3); await expect(marks.nth(2)).toHaveCSS("background-color", "rgb(0, 255, 0)");
        await expect(source).toBeFocused();
        await disposeColorsAndLinks(page);
    });
    if (host === "plain") test("a late background color scan cannot repaint a newer revision or open its picker", async ({ page }) => {
        const replies = await holdLspReplies(page, "textDocument/documentColor"); await page.reload();
        const marks = field(page).locator("..").locator(".host-inline-swatch");
        await seed(page, 'const a = "#abc";'); await expect(marks).toHaveCount(1);
        replies.hold();
        await field(page).press("Control+End"); await page.keyboard.insertText(' const b = "#ff0000";');
        await expect.poll(replies.waiting).toBe(true);
        await expect(marks).toHaveCount(1);
        await field(page).press("Control+a"); await page.keyboard.insertText('const latest = "#00ff00";');
        await expect(marks).toHaveCSS("background-color", "rgb(0, 255, 0)");
        await replies.release();
        await expect(marks).toHaveCount(1); await expect(marks).toHaveCSS("background-color", "rgb(0, 255, 0)");
        await expect(field(page)).toBeFocused(); expect((await snapshot(page)).bindings.colors.state.view).toBeNull();
    });
    for (const fault of ["malformed", "incomplete", "failure"] as const) test(`${fault} language replies clear partial presentation without changing source or history`, async ({ page }) => {
        test.setTimeout(60000);
        const { raw, before, links, colors, popup, apply, discoverColors, preview, signature } = await languageFailureScene(page);
        await page.evaluate(fault => window.hostFixture.faultLinksNext(fault), fault); await button(page, "Discover module links").click(); await settledColorsAndLinks(page);
        expect((await snapshot(page)).bindings.links.state.status).toBe("failed"); await expect(links.locator("li")).toHaveCount(0);
        await page.evaluate(fault => window.hostFixture.faultColorsNext(fault), fault); await discoverColors();
        expect((await snapshot(page)).bindings.colors.state.status).toBe("failed"); await expect(colors.locator("li")).toHaveCount(0); expect((await snapshot(page)).bindings.colors.decoratedViews).toBe(0);
        await discoverColors(); await expect(colors.getByRole("button")).toHaveCount(1); await page.evaluate(fault => window.hostFixture.faultColorsNext(fault), fault); await preview();
        expect((await snapshot(page)).bindings.colors.state).toMatchObject({ status: "failed", choices: [], canApply: false }); await expect(apply).toBeDisabled();
        await expect(button(page, "Reconnect color provider")).toBeEnabled();
        if (fault !== "incomplete") {
            await page.evaluate(fault => window.hostFixture.faultSignatureNext(fault), fault); await signature();
            expect((await snapshot(page)).bindings.signature.presentation.status).toBe("failed"); await expect(popup).toBeHidden(); await expect(field(page)).toBeFocused();
        }
        await exact(page, raw); expect((await snapshot(page)).history).toEqual(before.history);
    });
    test("provider link tooltips and color labels render literal markup", async ({ page }) => {
        const { links, apply, discoverColors, preview } = await languageFailureScene(page);
        await page.evaluate(() => window.hostFixture.faultLinksNext("markup")); await button(page, "Discover module links").click(); await settledColorsAndLinks(page);
        await expect(links).toContainText("<b>Literal link tooltip</b>"); await expect(links.locator("b,img,script,a")).toHaveCount(0);
        await discoverColors(); await page.evaluate(() => window.hostFixture.faultColorsNext("markup")); await preview();
        await expect(page.getByRole("combobox", { name: "Color presentation", exact: true })).toContainText("<b>Literal color label</b>");
        await expect(page.getByRole("region", { name: "Document colors", exact: true }).locator("b,img,script")).toHaveCount(0); await expect(apply).toBeEnabled();
    });
    test("shared language disconnect clears presentation and preserves editing until explicit reconnect", async ({ page }) => {
        test.setTimeout(60000);
        const methods: string[] = []; let dropCompletion = false;
        await page.routeWebSocket("**/lsp-fixture", client => {
            const server = client.connectToServer();
            client.onMessage(message => { const value = JSON.parse(message.toString());
                if (value.method) methods.push(value.method);
                if (dropCompletion && value.method === "textDocument/completion") {
                    dropCompletion = false;
                    server.send(JSON.stringify({ jsonrpc: "2.0", method: "fixture/disconnect" }));
                    return;
                }
                server.send(message);
            });
            server.onMessage(message => client.send(message));
        });
        await page.reload();
        const { raw, links, popup, apply, discoverColors, preview, signature } = await languageFailureScene(page);
        await button(page, "Discover module links").click(); await settledColorsAndLinks(page);
        await expect(links.getByRole("button")).toHaveCount(1);
        await discoverColors(); await preview(); await expect(apply).toBeEnabled();
        await signature(); await expect(popup.getByLabel("Active signature parameter", { exact: true })).toHaveText("fallback?: string");
        const connected = await snapshot(page); dropCompletion = true;
        await page.evaluate(() => window.hostFixture.requestProvider());
        await expect.poll(async () => (await snapshot(page)).bindings.signature.presentation.connected).toBe(false);
        const completionStatus = page.getByLabel("Language status", { exact: true });
        await expect(completionStatus).toContainText("provider disconnected");
        expect(await page.evaluate(() => window.hostFixture.providerState())).toMatchObject({ connected: false, pending: false, choices: [] });
        await expect(popup).toBeHidden(); await settledColorsAndLinks(page);
        await expect(apply).toBeDisabled(); await expect(links.locator("li")).toHaveCount(0);
        expect((await snapshot(page)).bindings.links.state.connected).toBe(false); expect((await snapshot(page)).bindings.colors.state.choices).toHaveLength(0);
        await expect(button(page, "Reconnect color provider")).toBeEnabled();
        await field(page).press("Control+End"); await field(page).pressSequentially("H"); await ready(page); await exact(page, raw + "H");
        await expect(completionStatus).toContainText("provider disconnected");
        expect((await snapshot(page)).bindings.lsp!.created).toBe(connected.bindings.lsp!.created);
        await button(page, "Reconnect signature provider").click();
        await expect(completionStatus).toContainText("provider connected");
        await page.evaluate(at => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: at, head: at }]); }, raw.indexOf(")"));
        await signature(); await expect(popup).toBeVisible(); await button(page, "Discover module links").click(); await settledColorsAndLinks(page); await expect(links.getByRole("button")).toHaveCount(1);
        await discoverColors(); await preview(); await expect(apply).toBeEnabled(); await exact(page, raw + "H");
        for (const name of ["signature", "link", "color"]) await button(page, `Disconnect ${name} provider`).click();
        const requests = methods.filter(method => /^(textDocument\/(signatureHelp|documentLink|documentColor|colorPresentation))$/.test(method));
        await field(page).press("Control+End"); await field(page).pressSequentially("X"); await field(page).press("Control+Shift+Space"); await field(page).press("F4"); await field(page).press("F6"); await ready(page);
        expect(methods.filter(method => /^(textDocument\/(signatureHelp|documentLink|documentColor|colorPresentation))$/.test(method))).toEqual(requests); await exact(page, raw + "HX");
        expect((await snapshot(page)).source.exports).toBe(0); await disposeColorsAndLinks(page);
        const final = await snapshot(page); expect(final.bindings.lsp!.created).toBe(final.bindings.lsp!.terminated);
    });
    test("paged links and colors keep unresolved targets and invalid form values inert and reject oversized lists", async ({ page }) => {
        const methods: string[] = [];
        await page.routeWebSocket("**/lsp-fixture", client => {
            const server = client.connectToServer(), colorRequests = new Set<number>();
            client.onMessage(message => {
                const value = JSON.parse(message.toString());
                if (value.method) methods.push(value.method);
                if (value.method === "textDocument/documentColor") colorRequests.add(value.id);
                server.send(message);
            });
            server.onMessage(message => {
                const value = JSON.parse(message.toString());
                if (colorRequests.delete(value.id) && value.result?.length === 70) {
                    // Two provider entries can start at the same character.
                    value.result[1].range = value.result[0].range;
                    value.result[1].color = { red: 1, green: 0, blue: 0, alpha: 1 };
                    client.send(JSON.stringify(value));
                } else client.send(message);
            });
        });
        await page.reload(); await settledColorsAndLinks(page);
        const line = 'import "sample-utils";\r\n#abc;\r\n', text = line.repeat(70) + 'import "missing-utils";';
        await seed(page, text, text.indexOf("#abc") + 2); await button(page, "Add module companion").click(); const before = await snapshot(page);
        const links = page.getByLabel("Module link results", { exact: true }), colors = page.getByLabel("Document color results", { exact: true });
        const turnAfterRefresh = async (kind: "links" | "colors") => {
            const name = kind === "links" ? "module links" : "document colors", rows = (kind === "links" ? links : colors).getByRole("listitem");
            const discover = button(page, "Discover " + name), next = button(page, "Next " + name);
            await discover.click(); await settledColorsAndLinks(page); await expect(rows).toHaveCount(64);
            const oldNext = await page.evaluateHandle(kind => window.hostFixture.snapshot().bindings[kind].state.paging!.next!, kind);
            await next.hover(); await page.mouse.down();
            await discover.evaluate(node => (node as HTMLButtonElement).click()); await settledColorsAndLinks(page);
            await expect(next).toBeEnabled(); await next.hover(); await page.mouse.up();
            await oldNext.evaluate(turn => turn()); await oldNext.dispose();
            await expect(button(page, "Previous " + name)).toBeDisabled(); await expect(rows).toHaveCount(64);
            if (kind === "colors") {
                const red = rows.nth(1).getByRole("button"); await red.click();
                await expect(red).toHaveAttribute("aria-pressed", "true");
            }
            const row = rows.first().getByRole("button"), resolves = methods.filter(method => method === "documentLink/resolve").length;
            await row.hover(); await page.mouse.down(); await next.evaluate(node => (node as HTMLButtonElement).click());
            await expect(rows).toHaveCount(kind === "links" ? 7 : 6);
            await row.hover(); await page.mouse.up(); await settledColorsAndLinks(page);
            if (kind === "links") {
                expect(methods.filter(method => method === "documentLink/resolve")).toHaveLength(resolves);
                expect((await snapshot(page)).bindings.links.opened).toBe(0);
            } else expect((await snapshot(page)).bindings.colors.state.selected).toBe(1);
        };
        await turnAfterRefresh("links"); await expect(links.getByRole("listitem")).toHaveCount(7);
        await expect(button(page, "Next module links")).toBeDisabled(); await expect(links.getByRole("button").last()).toBeEnabled();
        await field(page).focus(); await page.evaluate(at => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: at, head: at }); }, text.lastIndexOf("missing-utils") + 2);
        await field(page).press("F4"); await expect(links.getByRole("button").last()).toBeFocused();
        await page.keyboard.press("ArrowUp"); await expect(links.getByRole("button").nth(5)).toBeFocused();
        await page.keyboard.press("ArrowDown"); await expect(links.getByRole("button").last()).toBeFocused();
        await page.keyboard.press("Enter"); await settledColorsAndLinks(page); await expect(links.getByRole("button").last()).toBeDisabled();
        await expect(page.getByLabel("Locations status", { exact: true })).toContainText("No destination for missing-utils");
        expect((await snapshot(page)).bindings.links.opened).toBe(0); await button(page, "Previous module links").click(); await expect(links.getByRole("listitem")).toHaveCount(64);
        await turnAfterRefresh("colors"); await expect(colors.getByRole("listitem")).toHaveCount(6);
        await expect(button(page, "Next document colors")).toBeDisabled(); await colors.getByRole("button").last().click();
        await expect(button(page, "Preview color presentations")).toBeEnabled();
        expect(await page.locator(".st-document-color").count()).toBeGreaterThan(0); expect(await page.locator(".st-document-color").count()).toBeLessThan(150);
        await expect(page.locator('.host-inline-swatch[data-ornament="before"]').first()).toHaveCSS("background-color", "rgb(170, 187, 204)");
        const previews = (await snapshot(page)).bindings.colors.previews, presentations = methods.filter(method => method === "textDocument/colorPresentation").length;
        await field(page, "Proposed color").fill('url("https://invalid.example/")'); await expect(button(page, "Preview color presentations")).toBeDisabled(); await expect(button(page, "Apply captured color")).toBeDisabled();
        await page.evaluate(() => window.hostFixture.previewColor()); await page.evaluate(() => window.hostFixture.providerCustom("fixture/state", {}));
        expect((await snapshot(page)).bindings.colors.previews).toBe(previews); expect(methods.filter(method => method === "textDocument/colorPresentation")).toHaveLength(presentations);
        await exact(page, text); expect((await snapshot(page)).history).toEqual(before.history); expect((await snapshot(page)).source.revision).toBe(before.source.revision);
        for (const method of ["textDocument/documentLink", "documentLink/resolve", "textDocument/documentColor"]) expect(methods).toContain(method);
        const oversized = line.repeat(1025); await seed(page, oversized, oversized.indexOf("#abc") + 2); const overflow = await snapshot(page);
        await button(page, "Discover module links").click(); await settledColorsAndLinks(page); await expect(links.getByRole("listitem")).toHaveCount(0);
        expect((await snapshot(page)).bindings.links.state.status).toBe("failed"); await expect(page.getByLabel("Locations status", { exact: true })).toContainText("limit");
        await button(page, "Discover document colors").click(); await settledColorsAndLinks(page); await expect(colors.getByRole("listitem")).toHaveCount(0);
        expect((await snapshot(page)).bindings.colors.state.status).toBe("failed"); await expect(page.getByLabel("Document color status", { exact: true })).toContainText("limit");
        expect((await snapshot(page)).bindings.colors.decoratedViews).toBe(0); await exact(page, oversized);
        expect((await snapshot(page)).history).toEqual(overflow.history); expect((await snapshot(page)).source.revision).toBe(overflow.source.revision);
        expect((await snapshot(page)).source.exports).toBe(0); await disposeColorsAndLinks(page);
    });
    test("secondary-resource color edits and explicit reveal keep primary Save and Run identity", async ({ page }) => {
        const text = 'import "sample-utils";\r\nconst accent = "#abc";', original = 'const color = "#abc";\r\nexport const value = 1;\r\n', expected = original.replace("#abc", "#112233");
        await seed(page, text, 10); await button(page, "Add module companion").click(); const companion = (await snapshot(page)).bindings.links.companion!;
        await page.evaluate(id => { const f = window.hostFixture, document = f.navigationDocument(id); f.editLinkTarget(id, document.revision, [{ from: 0, to: 0, insert: 'const color = "#abc";\r\n' }]); }, companion);
        await button(page, "Discover module links").click(); await settledColorsAndLinks(page); await page.getByLabel("Module link results", { exact: true }).getByRole("button").click();
        await settledColorsAndLinks(page); await expect(field(page, "Secondary source")).toBeFocused();
        await button(page, "Discover document colors").click(); await settledColorsAndLinks(page); expect((await snapshot(page)).bindings.colors.state.view).toBe("secondary");
        await field(page, "Proposed color").fill("#112233"); await button(page, "Preview color presentations").click(); await settledColorsAndLinks(page);
        await button(page, "Apply captured color").click(); await settledColorsAndLinks(page); expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(expected); await exact(page, text);
        const open = button(page, "Open color changes in Module companion"), secondary = field(page, "Secondary source");
        const oldEditor = await secondary.elementHandle();
        await button(page, "Toggle views").click(); await expect(secondary).toHaveCount(0);
        await open.click(); await expect(page.getByLabel("Document color status", { exact: true })).toContainText("source pane");
        await button(page, "Toggle views").click(); await open.click(); await expect(secondary).toBeFocused();
        expect(await oldEditor!.evaluate(node => node.isConnected)).toBe(false); await oldEditor!.dispose();
        expect((await snapshot(page)).bindings.views.find(view => view.id === "secondary")!.documentId).toBe(companion);
        await button(page, "Run captured inputs").click(); expect(await page.evaluate(() => window.hostFixture.runCapture(0)!.source)).toBe(text); await page.evaluate(() => window.hostFixture.finishRun());
        await button(page, "Save source").click(); await page.evaluate(() => window.hostFixture.finishSave()); await settledColorsAndLinks(page);
        await exact(page, text); expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(expected);
        await open.hover(); await page.mouse.down();
        await field(page).focus(); await button(page, "Discover document colors").press("Enter"); await settledColorsAndLinks(page);
        await field(page, "Proposed color").fill("#445566");
        await button(page, "Preview color presentations").press("Enter"); await settledColorsAndLinks(page);
        await button(page, "Apply captured color").press("Enter"); await settledColorsAndLinks(page);
        const replacement = page.getByRole("button", { name: /^Open color changes in / });
        await expect(replacement).not.toHaveText("Open color changes in Module companion");
        await secondary.focus(); await replacement.hover(); await page.mouse.up();
        await expect(secondary).toBeFocused();
        await secondary.press("Control+z"); await settledColorsAndLinks(page); expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(original);
        await secondary.press("Control+Shift+z"); await settledColorsAndLinks(page); expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(expected);
        await replacement.click(); await expect(field(page)).toBeFocused();
        await expect(page.getByLabel("Document color status", { exact: true })).toContainText("Opened");
        await field(page).press("Control+z"); await exact(page, text); await expect(replacement).toBeHidden();
        await expect(page.getByLabel("Document color status", { exact: true })).toContainText("Source changed");
        await disposeColorsAndLinks(page);
    });
    if (coversHost("plain-candidate", host, "candidate")) test("a long color insertion has a bounded review and applies in full", async ({ page }) => {
        const raw = 'const color = "#abc";', insert = "#aabbcc/*" + "x".repeat(12_000) + "*/";
        await page.routeWebSocket("**/lsp-fixture", client => {
            const server = client.connectToServer();
            client.onMessage(message => {
                const packet = JSON.parse(message.toString());
                if (packet.method !== "textDocument/colorPresentation") { server.send(message); return; }
                client.send(JSON.stringify({ jsonrpc: "2.0", id: packet.id, result: [
                    { label: "Hex with comment", textEdit: { range: packet.params.range, newText: insert } },
                ] }));
            });
        });
        await page.reload(); await seed(page, raw);
        await button(page, "Discover document colors").click(); await settledColorsAndLinks(page);
        await button(page, "Preview color presentations").click();
        const notes = page.getByRole("list", { name: "Proposed color edits", exact: true }), apply = button(page, "Apply captured color");
        await expect(apply).toBeEnabled();
        const shown = (await notes.textContent())!;
        expect(shown.length).toBeLessThan(1_000);
        expect(shown).toContain(`${insert.length} UTF-16 units`);
        await exact(page, raw); await apply.click(); await exact(page, raw.replace("#abc", insert));
        await field(page).press("Control+z"); await exact(page, raw); await disposeColorsAndLinks(page);
    });
    test("provider color presentations preview every edit and preserve complete selections through shared history", async ({ page }) => {
        const methods: string[] = []; page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method) methods.push(value.method); }));
        const raw = '\ufeffconst color = "#aabbcc";\r\nvalue;'; await seed(page, raw);
        await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 4, head: 1 }, { anchor: 20, head: 20 }], 1); });
        const before = await snapshot(page), proposed = page.getByRole("textbox", { name: "Proposed color", exact: true });
        await button(page, "Discover document colors").click(); await expect.poll(async () => (await snapshot(page)).bindings.colors.state.count).toBe(1);
        await button(page, "Preview color presentations").click(); await expect(button(page, "Apply captured color")).toBeEnabled();
        await expect(page.getByRole("combobox", { name: "Color presentation", exact: true })).toHaveValue("provider-0");
        await button(page, "Apply captured color").click(); await settledColorsAndLinks(page); await exact(page, raw);
        const unchanged = await snapshot(page); expect(unchanged.source.revision).toBe(before.source.revision); expect(unchanged.history).toEqual(before.history);
        expect(unchanged.bindings.views.find(view => view.id === "primary")!.selectionSet).toEqual(before.bindings.views.find(view => view.id === "primary")!.selectionSet);
        expect(unchanged.bindings.colors).toMatchObject({ unchanged: 1, applied: 0 });
        const openChanges = page.getByRole("button", { name: /^Open color changes in / });
        await expect(openChanges).toBeHidden();
        await expect(field(page).locator("..").locator(".host-inline-swatch")).toHaveCount(1);
        await button(page, "Discover document colors").click(); await settledColorsAndLinks(page);
        await proposed.fill("rgba(1, 2, 3, 0.5)"); await button(page, "Preview color presentations").click(); await expect(button(page, "Apply captured color")).toBeEnabled();
        await expect(page.getByLabel("Proposed color edits", { exact: true }).getByRole("listitem")).toHaveCount(2);
        await button(page, "Apply captured color").click(); const prefix = "// color presentation\r\n", expected = prefix + raw.replace("#aabbcc", "rgba(1, 2, 3, 0.5)");
        const applied = (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet;
        expect(applied.primary).toBe(1); expect(applied.ranges.map(({ anchor, head }) => [anchor, head])).toEqual([[prefix.length + 4, prefix.length + 1], [prefix.length + 20, prefix.length + 20]]);
        await expect(page.locator('.st-viewport:has(> textarea[aria-label="Primary source"]) .st-viewport-row').filter({ hasText: "rgba(1, 2, 3, 0.5)" })).toBeInViewport();
        expect(await page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); })).toBe(expected); expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
        await expect(openChanges).toBeVisible();
        await field(page, "Secondary source").press("Control+z"); expect(await page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); })).toBe(raw);
        await expect(openChanges).toBeHidden(); await expect(page.getByLabel("Document color status", { exact: true })).toContainText("Source changed");
        expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selectionSet).toEqual(before.bindings.views.find(view => view.id === "primary")!.selectionSet);
        expect(methods).toContain("textDocument/documentColor"); expect(methods).toContain("textDocument/colorPresentation");
        expect((await snapshot(page)).source.exports).toBe(0); await disposeColorsAndLinks(page);
    });
    for (const mode of ["selection", "value", "typing", "authority", "remount"] as const) if (coversHost(mode === "value" || mode === "remount" ? "candidate-hosts" : "plain-candidate", host, "candidate")) test(`pending color preview rejects a stale reply after ${mode}`, async ({ page }) => {
        test.setTimeout(60000);
        const replies = await holdLspReplies(page, "textDocument/colorPresentation");
        await page.reload();
        // These variants retain the text that followed typing in the original shared journey.
        let current = colorCaptureSource + (mode === "authority" || mode === "remount" ? "H" : "");
        const { proposed, apply, discover, preview } = await colorCaptureScene(page, current);
        await discover();
        const valid = await preview("#112233");
        const retired = await page.evaluateHandle(() => window.hostFixture.snapshot().bindings.colors.state.apply!);
        await expect(apply).toBeEnabled(); expect(valid.presentation).not.toBe("");
        await discover(); await proposed.fill("#112233"); replies.hold();
        await button(page, "Preview color presentations").click();
        await expect.poll(replies.waiting).toBe(true);
        const { state: captured, requested } = (await snapshot(page)).bindings.colors;
        expect(captured.pending).toBe(true); expect(captured.apply).toBeNull();
        if (mode === "selection") await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 17, head: 17 }]); });
        else if (mode === "value") { await proposed.press("Home"); await proposed.press("ArrowRight"); await page.keyboard.type("ff"); await expect(proposed).toHaveValue("#ff112233"); }
        else if (mode === "typing") { await field(page).press("Control+End"); await field(page).pressSequentially("H"); current += "H"; }
        else if (mode === "authority") await page.evaluate(() => window.hostFixture.cycleSourceEditLease());
        else await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
        await settledColorsAndLinks(page);
        await expect.poll(replies.cancelled).toBe(true);
        const invalidated = await snapshot(page);
        if (mode === "value") {
            expect(invalidated.bindings.colors.state).toMatchObject({ canPreview: true, canApply: false, choices: [], count: captured.count, selected: captured.selected });
            await proposed.press("Enter");
            await expect(apply).toBeEnabled();
        }
        await replies.release();
        expect(await retired.evaluate(apply => apply())).toEqual({ applied: false, reason: "expired" }); await retired.dispose();
        await settledColorsAndLinks(page);
        const after = await snapshot(page);
        if (mode === "value") {
            expect(after.bindings.colors.state).toMatchObject({ pending: false, canApply: true, value: "#ff112233" });
            expect(after.bindings.colors.requested).toBe(requested);
        } else expect(after.bindings.colors.state).toMatchObject({ pending: false, canApply: false, choices: [] });
        expect(after.bindings.colors.applied).toBe(0);
        expect(after.history).toEqual(invalidated.history);
        expect(after.bindings.views.map(view => view.selectionSet)).toEqual(invalidated.bindings.views.map(view => view.selectionSet));
        await exact(page, current);
        if (mode === "value") {
            await apply.click(); await exact(page, current.replace("#abc", "#ff112233"));
            await field(page).press("Control+z"); await exact(page, current);
        }
        expect((await snapshot(page)).source.exports).toBe(0);
        await disposeColorsAndLinks(page);
    });
    test("reviewed colors reject stale Apply after a new value or format and recover from read-only refusal", async ({ page }) => {
        test.setTimeout(60000);
        const current = colorCaptureSource + "H";
        const { apply, discover, preview } = await colorCaptureScene(page, current);
        await discover();
        await preview("#112233");
        const old = await page.evaluateHandle(() => window.hostFixture.snapshot().bindings.colors.state.apply!);
        await expect(apply).toBeEnabled();
        await preview("#445566"); const beforeOld = await snapshot(page);
        expect(await old.evaluate(apply => apply())).toEqual({ applied: false, reason: "expired" }); await old.dispose();
        const format = page.getByRole("combobox", { name: "Color presentation", exact: true });
        const option = format.getByRole("option").first();
        await option.evaluate(node => { node.dataset.retained = "color-format"; });
        const edits = page.getByLabel("Proposed color edits", { exact: true }).getByRole("listitem");
        const firstEdits = await edits.allTextContents();
        const first = await page.evaluateHandle(() => window.hostFixture.snapshot().bindings.colors.state.apply!);
        await apply.hover(); await page.mouse.down();
        await format.selectOption("provider-1");
        await expect(edits).not.toHaveText(firstEdits);
        await expect(option).toHaveAttribute("data-retained", "color-format");
        await format.selectOption("provider-0"); await expect(edits).toHaveText(firstEdits);
        await apply.hover(); await page.mouse.up();
        expect(await first.evaluate(apply => apply())).toEqual({ applied: false, reason: "expired" }); await first.dispose();
        await exact(page, current);
        expect((await snapshot(page)).history).toEqual(beforeOld.history);
        await expect(apply).toBeEnabled();
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(true));
        await settledColorsAndLinks(page);
        await expect(apply).toBeDisabled();
        await discover();
        await preview("#445566"); const beforeReadOnly = await snapshot(page);
        await expect(apply).toBeDisabled();
        expect(await page.evaluate(() => window.hostFixture.snapshot().bindings.colors.state.apply!())).toEqual({ applied: false, reason: "not-writable" });
        await exact(page, current);
        expect((await snapshot(page)).history).toEqual(beforeReadOnly.history);
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(false));
        await discover(); await preview("#445566");
        await expect(apply).toBeEnabled();
        await apply.click(); await settledColorsAndLinks(page);
        await exact(page, current.replace("#abc", "#445566"));
        expect((await snapshot(page)).bindings.colors.applied).toBe(1);
        expect((await snapshot(page)).source.exports).toBe(0);
        await disposeColorsAndLinks(page);
    });
    test("provider links resolve to captured host resources and late or outside destinations do not steal focus", async ({ page }) => {
        const methods: string[] = []; page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method) methods.push(value.method); }));
        let fault: "malformed" | "outside" | null = null, hold = false, release: (() => void) | undefined;
        await page.routeWebSocket("**/lsp-fixture", client => {
            const server = client.connectToServer(), held = new Set<number>();
            client.onMessage(message => { const value = JSON.parse(message.toString());
                if (value.method === "documentLink/resolve") {
                    if (hold) { hold = false; held.add(value.id); }
                    if (fault) { server.send(JSON.stringify({ ...value, params: { ...value.params, _fixture: { delay: 0, fault } } })); fault = null; return; }
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
        await expect(field(page, "Secondary source").locator("..").locator('.st-viewport-row[data-line="0"]')).toBeInViewport();
        await button(page, "Return to link origin").click(); await expect(field(page)).toBeFocused(); expect((await snapshot(page)).history).toEqual(history);
        await expect(field(page).locator("..").locator('.st-viewport-row[data-line="1"]')).toBeInViewport();
        await button(page, "Discover module links").click(); await expect(list.getByRole("button")).toBeEnabled();
        fault = "outside"; await list.getByRole("button").click(); expect(fault).toBeNull();
        await expect(page.getByLabel("Locations status", { exact: true })).toContainText("outside the host"); await expect(list.getByRole("button")).toBeDisabled(); expect((await snapshot(page)).bindings.links.opened).toBe(1);
        await button(page, "Discover module links").click(); await expect(list.getByRole("button")).toBeEnabled();
        fault = "malformed"; await list.getByRole("button").click();
        await expect(page.getByLabel("Locations status", { exact: true })).toContainText("range or identity");
        expect((await snapshot(page)).bindings.links.state.status).toBe("failed");
        for (const destination of ["escape", "form", "heading", "back-to-list"]) {
            await field(page).focus(); await button(page, "Discover module links").click(); await expect(list.getByRole("button")).toBeEnabled();
            hold = true; await list.getByRole("button").press("Enter"); await expect.poll(() => !!release).toBe(true);
            await expect(list).toBeFocused();
            let focused = list;
            if (destination === "escape") { await page.keyboard.press("Escape"); focused = field(page); }
            if (destination === "form") { focused = field(page, "Configuration path"); await focused.focus(); }
            if (destination === "heading") { await page.getByRole("heading", { name: "Module document links", exact: true }).click(); focused = page.locator("body"); }
            if (destination === "back-to-list") { await page.keyboard.press("Tab"); await expect(list).not.toBeFocused(); await list.focus(); }
            await expect(focused).toBeFocused(); release!(); release = undefined;
            await page.evaluate(() => window.hostFixture.providerCustom("fixture/state", {}));
            await expect.poll(async () => (await snapshot(page)).bindings.links.state.pending).toBe(false);
            expect((await snapshot(page)).bindings.links.opened).toBe(1); await expect(focused).toBeFocused();
            if (destination === "escape") await expect(list.getByRole("button")).toHaveCount(0);
        }
        await list.getByRole("button").click(); await expect(field(page, "Secondary source")).toBeFocused();
        expect((await snapshot(page)).bindings.links.opened).toBe(2); expect((await snapshot(page)).history).toEqual(history);
        expect(methods).toContain("textDocument/documentLink"); expect(methods).toContain("documentLink/resolve"); expect((await snapshot(page)).source.exports).toBe(0);
    });
    test("a link waits for the secondary pane's paste and opens on a fresh click", async ({ page }) => {
        const replies = await holdLspReplies(page, "documentLink/resolve"); await page.reload();
        const raw = 'import "sample-utils";\ncatalogue;';
        await seed(page, raw, raw.indexOf("catalogue") + 1);
        await button(page, "Add navigation companion").click();
        await field(page).press("F12");
        const secondary = field(page, "Secondary source");
        await expect(secondary).toBeFocused();
        await button(page, "Add module companion").click();
        await page.getByRole("checkbox", { name: "Paste tables as CSV" }).check();
        await field(page).press("F4");
        const row = page.getByLabel("Module link results", { exact: true }).getByRole("button");
        replies.hold(); await row.click(); await expect.poll(replies.waiting).toBe(true);
        await field(page, "Configuration path").focus(); await replies.release();
        await expect(row).toContainText("Module companion");
        const before = await snapshot(page), occupant = before.bindings.navigation.companion!;
        await secondary.press("Control+End");
        const pending = await row.evaluate(node => {
            const input = document.activeElement as HTMLTextAreaElement;
            const paste = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            paste.clipboardData!.setData("text/plain", "one\ttwo"); input.dispatchEvent(paste);
            const busy = window.hostFixture.snapshot().bindings.tablePaste.pending;
            (node as HTMLButtonElement).click();
            return busy;
        });
        expect(pending).toBe(true);
        await expect(page.getByLabel("Locations status", { exact: true })).toContainText("pending input");
        await expect(secondary).toBeFocused();
        await expect.poll(async () => (await snapshot(page)).bindings.tablePaste.status).toBe("applied");
        expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, occupant)).toMatch(/"one","two"$/);
        expect((await snapshot(page)).bindings.links.opened).toBe(0);
        await row.click(); await expect(secondary).toBeFocused();
        expect((await snapshot(page)).bindings.views.find(view => view.id === "secondary")?.documentId).toBe(before.bindings.links.companion);
        const mounted = (await snapshot(page)).bindings.mounts;
        await row.click(); await expect(secondary).toBeFocused();
        expect((await snapshot(page)).bindings.mounts).toBe(mounted);
        await secondary.press("End"); await secondary.pressSequentially(" // edited");
        await expect(row).toHaveCount(0);
        const back = button(page, "Return to link origin");
        await expect(back).toBeEnabled();
        await back.evaluate(node => {
            const paste = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            paste.clipboardData!.setData("text/plain", "three\tfour"); document.activeElement!.dispatchEvent(paste);
            (node as HTMLButtonElement).click();
        });
        await expect(secondary).toBeFocused();
        await expect(page.getByLabel("Locations status", { exact: true })).toContainText("pending input");
        await expect.poll(async () => (await snapshot(page)).bindings.tablePaste.status).toBe("applied");
        await secondary.press("Shift+F4"); await expect(field(page)).toBeFocused(); await exact(page, raw);
        expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, before.bindings.links.companion!)).toContain(' // edited"three","four"');
        await expect(back).toBeDisabled();
        await disposeColorsAndLinks(page);
    });
    test("F4 links restore complete comparison and secondary selections without taking later form focus", async ({ page }) => {
        const replies = await holdLspReplies(page, "textDocument/documentLink"); await page.reload();
        const raw = ['\ufeffimport "sample-utils";', 'const café = "😀";', ...Array.from({ length: 180 }, (_, i) => `const row${i} = ${i};`)].join("\r\n");
        await seed(page, raw);
        await button(page, "Open source review").click(); await button(page, "Add module companion").click(); await settledColorsAndLinks(page);
        const list = page.getByLabel("Module link results", { exact: true }), row = list.getByRole("button").first();
        for (const origin of ["secondary", "comparison"] as const) {
            const source = field(page, origin === "comparison" ? "Comparison working source" : "Secondary source"); await source.focus();
            await page.evaluate(origin => { const f = window.hostFixture; f.selectSourceSet(origin, f.snapshot().source.revision, [{ anchor: 20, head: 9 }, { anchor: f.snapshot().source.length, head: f.snapshot().source.length }]); }, origin);
            const viewport = source.locator("..");
            await viewport.evaluate(node => { node.scrollTop = node.scrollHeight / 2; }); await ready(page);
            const readingLine = () => viewport.evaluate(node => {
                const top = node.getBoundingClientRect().top;
                return [...node.querySelectorAll(".st-viewport-row")].find(row => row.getBoundingClientRect().bottom > top + 1)?.textContent;
            });
            await expect.poll(readingLine).toMatch(/^const row/);
            const line = await readingLine();
            const before = await snapshot(page); await source.press("F4"); await settledColorsAndLinks(page); await expect(row).toBeFocused();
            await page.keyboard.press("Enter"); await settledColorsAndLinks(page);
            await expect(field(page, "Secondary source")).toBeFocused();
            expect((await snapshot(page)).bindings.views.find(view => view.id === "secondary")!.documentId).toBe(before.bindings.links.companion);
            // Resolution changes row contents. Subsequent focus/navigation publications retain that resolved row.
            await row.evaluate(node => { node.dataset.retained = "module-link"; });
            await field(page, "Secondary source").press("Shift+F4"); await settledColorsAndLinks(page); await expect(source).toBeFocused();
            await expect.poll(readingLine).toBe(line);
            await row.click(); await settledColorsAndLinks(page); await expect(field(page, "Secondary source")).toBeFocused();
            await expect(row).toHaveAttribute("data-retained", "module-link");
            await field(page, "Secondary source").pressSequentially("x"); await expect(row).toHaveCount(0);
            await field(page, "Secondary source").press("Shift+F4"); await settledColorsAndLinks(page); await expect(source).toBeFocused();
            await expect.poll(readingLine).toBe(line);
            const after = await snapshot(page);
            if (origin === "comparison") expect(after.bindings.comparison!.selectionSet).toEqual(before.bindings.comparison!.selectionSet);
            else expect(after.bindings.views.find(view => view.id === "secondary")!.selectionSet).toEqual(before.bindings.views.find(view => view.id === "secondary")!.selectionSet);
            expect(after.bindings.comparison!.baseline).toEqual(before.bindings.comparison!.baseline); expect(after.history).toEqual(before.history);
            await source.press("F4"); await expect(row).toBeFocused(); await expectPanelKeyReserved(row, "Escape");
            await row.press("Escape"); await expect(source).toBeFocused();
            expect((await snapshot(page)).bindings.links.state).toMatchObject({ status: "idle", canReturn: false, count: 0 });
            if (origin === "secondary") {
                // Dismissing while away releases the route without focusing the replacement editor.
                await source.press("F4"); await expect(row).toBeFocused();
                await row.click(); await expect.poll(async () => (await snapshot(page)).bindings.links.state.status).toBe("away");
                await list.focus(); await list.press("Escape"); await expect(list).toBeFocused();
                const dismissed = await snapshot(page);
                expect(dismissed.bindings.links.state.canReturn).toBe(false);
                expect(dismissed.bindings.views.find(view => view.id === "secondary")!.documentId).toBe(before.bindings.links.companion);
            }
        }
        await field(page).focus(); replies.hold(); await field(page).press("F4"); await expect.poll(replies.waiting).toBe(true);
        const form = field(page, "Configuration path"); await form.focus(); await replies.release(); await settledColorsAndLinks(page);
        await expect(form).toBeFocused(); await expect(row).toBeEnabled(); await exact(page, raw);
        expect((await snapshot(page)).source.exports).toBe(0); await disposeColorsAndLinks(page);
    });
    test("F6 comparison colors retain alpha and controls until explicit keyboard confirmation", async ({ page }) => {
        const raw = '\ufeffconst color = "#abc";\r\nvalue;', expected = "// color presentation\r\n" + raw.replace("#abc", "rgba(1, 2, 3, 0.5)");
        await seed(page, raw); await button(page, "Open source review").click(); await settledColorsAndLinks(page);
        const working = field(page, "Comparison working source"), colors = page.getByLabel("Document color results", { exact: true }), value = field(page, "Proposed color");
        await working.focus(); await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("comparison", f.snapshot().source.revision, [{ anchor: 18, head: 16 }, { anchor: f.snapshot().source.length, head: f.snapshot().source.length }]); });
        const before = await snapshot(page); await working.press("F6"); await settledColorsAndLinks(page); await expect(colors).toBeFocused();
        const row = colors.getByRole("button").first(); await row.evaluate(node => { node.dataset.retained = "color-result"; }); await value.evaluate(node => { node.dataset.retained = "color-value"; });
        await page.keyboard.press("Tab"); await page.keyboard.press("Enter"); await expect(value).toBeFocused(); await page.keyboard.type("rgba(1,2,3,.5)");
        await expect(value).toHaveValue("rgba(1,2,3,.5)"); await exact(page, raw); expect((await snapshot(page)).history).toEqual(before.history);
        await expect(row).toHaveAttribute("data-retained", "color-result"); await expect(value).toHaveAttribute("data-retained", "color-value");
        await expectPanelKeyReserved(value, "Enter");
        await value.dispatchEvent("keydown", { key: "Enter", repeat: true });
        expect((await snapshot(page)).bindings.colors.previews).toBe(before.bindings.colors.previews);
        await page.keyboard.press("Enter"); await settledColorsAndLinks(page); await expect(row).toHaveAttribute("data-retained", "color-result");
        await expect(page.getByRole("combobox", { name: "Color presentation", exact: true }).getByRole("option")).toHaveText(["rgba(1, 2, 3, 0.5)"]);
        await page.keyboard.press("Tab"); await expect(button(page, "Preview color presentations")).toBeFocused();
        await page.keyboard.press("Tab"); await expect(page.getByRole("combobox", { name: "Color presentation", exact: true })).toBeFocused();
        await page.keyboard.press("Tab"); await expect(button(page, "Apply captured color")).toBeFocused(); await exact(page, raw);
        await page.keyboard.press("Enter"); await settledColorsAndLinks(page); await exact(page, expected); await expect(working).toBeFocused();
        expect((await snapshot(page)).bindings.comparison!.baseline).toEqual(before.bindings.comparison!.baseline);
        await working.press("F6"); await settledColorsAndLinks(page); await expectPanelKeyReserved(colors, "Escape");
        await page.keyboard.press("Escape"); await expect(working).toBeFocused();
        expect((await snapshot(page)).bindings.colors.state.view).toBeNull(); expect((await snapshot(page)).source.exports).toBe(0); await disposeColorsAndLinks(page);
    });
    for (const mode of ["selection", "typing", "target", "authority", "alias", "remount"] as const)
        if (coversHost(mode === "remount" ? "candidate-hosts" : "plain-candidate", host, "candidate")) test(`pending link discovery rejects a stale reply after ${mode}`, async ({ page }) => {
            test.setTimeout(60000);
            const replies = await holdLspReplies(page, "textDocument/documentLink");
            await page.reload(); await expect(field(page)).toBeVisible();
            let current = linkCaptureSource + (mode === "selection" || mode === "typing" ? "" : "H");
            const editedTarget = mode === "authority" || mode === "alias" || mode === "remount";
            const { companion, select, editTarget } = await linkCaptureScene(page, current, editedTarget);
            await select(); replies.hold(); await button(page, "Discover module links").click();
            await expect.poll(replies.waiting).toBe(true);
            expect((await snapshot(page)).bindings.links.state.status).toBe("pending");
            if (mode === "selection") await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 11, head: 11 }]); });
            else if (mode === "typing") { await field(page).press("Control+End"); await field(page).pressSequentially("H"); current += "H"; }
            else if (mode === "target") await editTarget();
            else if (mode === "authority") await page.evaluate(id => { window.hostFixture.setProjectTargetReadOnly(id, true); window.hostFixture.setProjectTargetReadOnly(id, false); }, companion);
            else if (mode === "alias") await page.evaluate(id => { window.hostFixture.setLinkAlias("sample-utils", null); window.hostFixture.setLinkAlias("sample-utils", id); }, companion);
            else await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
            await settledColorsAndLinks(page);
            await expect.poll(replies.cancelled).toBe(true);
            const invalidated = await snapshot(page);
            await replies.release();
            await settledColorsAndLinks(page);
            const after = await snapshot(page);
            expect(after.bindings.links.opened).toBe(0);
            expect(after.bindings.links.state.links).toHaveLength(0);
            if (mode === "selection") expect(after.bindings.links.state.message).toBe("Module links expired. Press F4 in the source to refresh them.");
            expect(after.history).toEqual(invalidated.history);
            expect(after.bindings.views.map(view => view.selectionSet)).toEqual(invalidated.bindings.views.map(view => view.selectionSet));
            await exact(page, current);
            expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe((editedTarget || mode === "target" ? "// target\r\n" : "") + linkCaptureTarget);
            await disposeColorsAndLinks(page);
        });
    test("retained link actions reject source edits and remounts while a fresh link opens a read-only target", async ({ page }) => {
        test.setTimeout(60000);
        const replies = await holdLspReplies(page, "documentLink/resolve"); await page.reload();
        const current = linkCaptureSource + "H";
        const { companion, select, discover } = await linkCaptureScene(page, current, true);
        await select(); await discover();
        for (const interrupt of ["edit", "remount"]) {
            const old = await page.evaluateHandle(() => window.hostFixture.snapshot().bindings.links.state.links[0]!.open);
            replies.hold(); await page.getByLabel("Module link results", { exact: true }).getByRole("button").click();
            await expect.poll(replies.waiting).toBe(true);
            if (interrupt === "edit") { await field(page).press("End"); await field(page).pressSequentially("x"); await field(page).press("Control+z"); }
            else await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
            await select(); await discover(); await replies.release(); await old.evaluate(open => open()); await old.dispose();
            expect((await snapshot(page)).bindings.links.opened).toBe(0); await exact(page, current);
        }
        await page.evaluate(id => window.hostFixture.setProjectTargetReadOnly(id, true), companion);
        const working = field(page, "Comparison working source"), row = page.getByLabel("Module link results", { exact: true }).getByRole("button");
        await button(page, "Open source review").click(); await working.focus(); await discover();
        await expect(row).toBeEnabled(); await button(page, "Close source review").click();
        await expect(row).toHaveCount(0);
        await button(page, "Open source review").click();
        await expect(working).toBeVisible();
        await select(); await discover();
        await expect(row).toBeEnabled(); await button(page, "Close source review").click();
        await expect(working).toHaveCount(0);
        await row.click();
        await settledColorsAndLinks(page);
        await expect(field(page, "Secondary source")).toBeFocused();
        expect((await snapshot(page)).bindings.links.opened).toBe(1);
        expect((await snapshot(page)).bindings.views.find(view => view.id === "secondary")!.documentId).toBe(companion);
        expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe("// target\r\n" + linkCaptureTarget);
        await exact(page, current);
        const back = button(page, "Return to link origin");
        await expect(back).toBeEnabled();
        await page.evaluate(() => {
            const host = window.hostFixture;
            host.editSource(host.snapshot().source.revision, [{ from: 0, to: 0, insert: "// changed origin\n" }]);
        });
        await expect(back).toBeDisabled();
        await field(page, "Secondary source").press("Shift+F4"); await expect(field(page, "Secondary source")).toBeFocused();
        await disposeColorsAndLinks(page);
    });
    test("advertised signature triggers and retriggers show active parameters without taking completion shortcuts", async ({ page }) => {
        const replies = await holdLspReplies(page, "textDocument/signatureHelp"); await page.reload();
        const contexts: { triggerKind: number; triggerCharacter?: string; isRetrigger: boolean; activeSignatureHelp?: unknown }[] = [];
        page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method === "textDocument/signatureHelp") contexts.push(value.params.context); }));
        const popup = page.getByRole("tooltip", { name: "Signature help", exact: true }), parameter = popup.getByLabel("Active signature parameter", { exact: true });
        await seed(page, "lookup");
        await field(page).evaluate(node => node.addEventListener("keydown", e => {
            e.preventDefault(); e.stopImmediatePropagation();
            const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: 5, head: 5 });
        }, { capture: true, once: true }));
        await field(page).press("("); await expect.poll(async () => (await snapshot(page)).bindings.signature.scheduled).toBe(false);
        expect((await snapshot(page)).bindings.signature.requested).toBe(0); await exact(page, "lookup");
        await field(page).press("End"); expect(contexts).toHaveLength(0);
        await field(page).evaluate((node, name) => node.closest(".st-editor")!.addEventListener(name, () => queueMicrotask(() => {
            const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: 0, head: 0 });
        }), { once: true }), typedTextEvent);
        await field(page).press("("); await expect.poll(async () => (await snapshot(page)).bindings.signature.scheduled).toBe(false);
        expect((await snapshot(page)).bindings.signature.requested).toBe(0);
        await seed(page, "lookup");
        await field(page).pressSequentially("("); await expect(parameter).toHaveText("key: string"); expect(contexts[0]).toMatchObject({ triggerKind: 2, triggerCharacter: "(", isRetrigger: false });
        await field(page).press("ArrowDown"); await expect(parameter).toHaveText("keys: readonly string[]");
        await field(page).evaluate((input, name) => input.closest(".st-editor")!.addEventListener(name, () => queueMicrotask(() => {
            const { presentation, scheduled } = window.hostFixture.snapshot().bindings.signature;
            input.setAttribute("data-refresh-parameter", scheduled ? presentation.signature?.label ?? "" : "");
        }), { once: true }), typedTextEvent);
        replies.hold(); await field(page).pressSequentially("x.");
        await expect(field(page)).toHaveAttribute("data-refresh-parameter", /keys: readonly string\[\]/);
        await expect.poll(replies.waiting).toBe(true);
        await expect(parameter).toHaveText("keys: readonly string[]");
        await expect(popup).toBeVisible();
        await replies.release();
        await expect.poll(() => contexts.at(-1)).toMatchObject({ triggerKind: 3, isRetrigger: true, activeSignatureHelp: { activeSignature: 1 } });
        await expect.poll(async () => (await snapshot(page)).bindings.signature.presentation.status).toBe("ready");
        const priorLabel = await popup.locator("pre").innerText();
        replies.hold(); await field(page).pressSequentially(","); await expect.poll(replies.waiting).toBe(true);
        await expect(popup.locator("pre")).toHaveText(priorLabel); await expect(parameter).toBeHidden();
        await replies.release(); await expect(parameter).toHaveText("fallback?: string");
        expect(contexts.at(-1)).toMatchObject({ triggerKind: 2, triggerCharacter: ",", isRetrigger: true }); expect(contexts.at(-1)!.activeSignatureHelp).toBeTruthy();
        const before = await snapshot(page), posted = before.bindings.language.sessions.find(session => session.id === "primary")!.provider.posted;
        await field(page).press("Control+Shift+Space"); await expect.poll(async () => (await snapshot(page)).bindings.signature.applied).toBe(before.bindings.signature.applied + 1); await expect(parameter).toHaveText("fallback?: string");
        expect(contexts.at(-1)).toMatchObject({ triggerKind: 1, isRetrigger: false }); expect((await snapshot(page)).bindings.language.sessions.find(session => session.id === "primary")!.provider.posted).toBe(posted);
        expect((await snapshot(page)).history).toEqual(before.history);
        await field(page).press("Escape"); await expect(popup).not.toBeVisible();
        await seed(page, "lookup(saMORE)", 9); await field(page).press("Control+Shift+Space"); await expect(popup).toBeVisible();
        await field(page).press("Control+Space"); await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible();
        await field(page).press("Escape"); await expect(page.getByRole("option")).toHaveCount(0); await expect(popup).toBeVisible();
        await field(page).press("Escape"); await expect(popup).not.toBeVisible();
        replies.hold(); await field(page).press("Control+Shift+Space"); await expect.poll(replies.waiting).toBe(true); await expect.poll(async () => (await snapshot(page)).bindings.signature.pending).toBe(true);
        await field(page, "Configuration path").fill("while-signature.csv"); await expect.poll(async () => (await snapshot(page)).bindings.signature.pending).toBe(false);
        await expect.poll(replies.cancelled).toBe(true); await replies.release();
        await expect(field(page, "Configuration path")).toBeFocused(); expect((await snapshot(page)).source.exports).toBe(0);
    });
    if (host === "plain") test("a nested call and a moved caret discard earlier signature text while replies wait", async ({ page }) => {
        const replies = await holdLspReplies(page, "textDocument/signatureHelp"); await page.reload();
        const source = field(page), popup = page.getByRole("tooltip", { name: "Signature help", exact: true });
        const parameter = popup.getByLabel("Active signature parameter", { exact: true });
        await seed(page, "lookup(format"); await source.press("Control+Shift+Space"); await expect(parameter).toHaveText("key: string");
        replies.hold(); await source.pressSequentially("("); await expect.poll(replies.waiting).toBe(true);
        await expect(popup).not.toContainText("lookup("); await replies.release(); await expect(parameter).toHaveText("value: unknown");
        replies.hold(); await source.pressSequentially("a"); await expect.poll(replies.waiting).toBe(true);
        await expect(parameter).toHaveText("value: unknown"); await source.press("Home");
        await expect.poll(replies.cancelled).toBe(true); await replies.release();
        await expect(popup).toBeHidden(); await expect(source).toBeFocused();
    });
    test("read-only manual signature help keeps complete selections and yields only to explicit hover", async ({ page }) => {
        const raw = "lookup('a', )\r\nformat(1, )"; await seed(page, raw);
        const popup = page.getByRole("tooltip", { name: "Signature help", exact: true });
        await page.evaluate(at => { const f = window.hostFixture; f.setSourceReadOnly(true); f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 2, head: 2 }, { anchor: at, head: at }], 1); }, raw.indexOf(")"));
        await ready(page); const before = await snapshot(page), complete = before.bindings.views.find(view => view.id === "primary")!.selectionSet;
        await field(page).press("Control+Shift+Space"); await expect(popup.getByLabel("Active signature parameter", { exact: true })).toHaveText("fallback?: string");
        expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selectionSet).toEqual(complete);
        await popup.click(); await expect(field(page)).toBeFocused(); await expect(popup).toBeVisible(); await popup.dispatchEvent("scroll");
        expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selectionSet).toEqual(complete);
        const at = await page.locator('.st-editor:has(> textarea[aria-label="Primary source"]) .st-viewport-row').first().evaluate(row => {
            const node = document.createTreeWalker(row, NodeFilter.SHOW_TEXT).nextNode()!, range = document.createRange(); range.setStart(node, 1); range.setEnd(node, 2);
            const box = range.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        });
        const posted = (await snapshot(page)).bindings.hover.sessions.find(session => session.id === "primary")!.counters.posted;
        await page.mouse.move(at.x, at.y); await page.waitForTimeout(350); await expect(popup).toBeVisible();
        expect((await snapshot(page)).bindings.hover.sessions.find(session => session.id === "primary")!.counters.posted).toBe(posted);
        await page.evaluate(set => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, set.ranges, 0); }, complete);
        const hoverSelection = (await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selectionSet;
        await field(page).press("Control+k"); await field(page).press("Control+i"); await expect(popup).toBeHidden(); await expect(page.getByRole("tooltip")).toContainText("Symbol");
        await field(page).press("Escape"); expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selectionSet).toEqual(hoverSelection);
        await page.evaluate(set => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, set.ranges, set.primary); }, complete);
        await page.evaluate(() => window.hostFixture.faultSignatureNext("markup")); await field(page).press("Control+Shift+Space");
        await expect(popup).toContainText("<b>Literal signature documentation</b>"); await expect(popup.locator("b,img,script")).toHaveCount(0);
        await field(page).press("Escape"); expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selectionSet).toEqual(complete);
        await field(page).press("Escape"); expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selectionSet.ranges).toHaveLength(1);
        expect((await snapshot(page)).history).toEqual(before.history); expect((await snapshot(page)).source.exports).toBe(0); await exact(page, raw);
        await disposeColorsAndLinks(page); const final = await snapshot(page);
        expect(final.bindings.signature).toMatchObject({ pending: false, scheduled: false, sessions: 0, subscriptions: 0, capture: null });
        expect(final.bindings.lsp).toMatchObject({ scopes: 0, documents: 0, created: 1, terminated: 1 });
    });
    if (host === "react") test("100k-line signature, link resolution and a selected color presentation use bounded source controls", async ({ page }) => {
        const prefix = "const unchanged = 123;\r\n".repeat(100_000), tail = 'lookup("a", )\r\nimport "sample-utils";\r\nconst color = "#abc";', raw = prefix + tail;
        await seed(page, raw, prefix.length + tail.indexOf(")")); await field(page).press("Control+Shift+Space");
        await expect.poll(async () => (await snapshot(page)).bindings.signature.presentation.status).toBe("ready");
        const viewport = page.locator('.st-viewport:has(> textarea[aria-label="Primary source"])');
        await viewport.evaluate(node => { node.scrollTop = 0; });
        await expect(page.getByRole("tooltip", { name: "Signature help", exact: true })).toBeHidden();
        await viewport.evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(page.getByRole("tooltip", { name: "Signature help", exact: true }).getByLabel("Active signature parameter", { exact: true })).toHaveText("fallback?: string");
        await field(page).press("Escape"); await button(page, "Add module companion").click(); await button(page, "Discover module links").click();
        const links = page.getByLabel("Module link results", { exact: true }); await expect(links.getByRole("button")).toHaveCount(1); await links.getByRole("button").click();
        await expect.poll(async () => (await snapshot(page)).bindings.links.opened).toBe(1); await button(page, "Return to link origin").click();
        await button(page, "Discover document colors").click(); await expect.poll(async () => (await snapshot(page)).bindings.colors.state.count).toBe(1);
        await page.getByRole("textbox", { name: "Proposed color", exact: true }).fill("#112233"); await button(page, "Preview color presentations").click(); await expect(button(page, "Apply captured color")).toBeEnabled();
        const depth = (await snapshot(page)).history.undoDepth; await button(page, "Apply captured color").click();
        await expect(viewport.locator(".st-viewport-row").filter({ hasText: 'const color = "#112233";' })).toBeInViewport();
        expect(await page.evaluate(from => { const f = window.hostFixture; return f.range(from, f.snapshot().source.length); }, prefix.length)).toBe(tail.replace("#abc", "#112233"));
        const state = await snapshot(page); expect(state.history.undoDepth).toBe(depth + 1); expect(state.source.exports).toBe(0);
        for (const view of state.bindings.views) { expect(view.metrics!.inputUnits).toBeLessThanOrEqual(4096); expect(view.metrics!.viewport.rows).toBeLessThan(100); }
        await field(page).press("Control+z"); expect(await page.evaluate(from => { const f = window.hostFixture; return f.range(from, f.snapshot().source.length); }, prefix.length)).toBe(tail);
    });
});
test("missing and withdrawn language capabilities fail explicitly without a worker fallback or a late color edit", async ({ page }) => {
    const replies = await holdLspReplies(page, "textDocument/colorPresentation");
    await page.goto("/hosts/plain/?editor=candidate&language=lsp&lspSubset=dynamic");
    const text = 'lookup("a", )\r\nconst color = "#abc";'; await seed(page, text, text.indexOf(")"));
    await field(page).press("Control+Shift+Space"); await expect.poll(async () => (await snapshot(page)).bindings.signature.presentation.status).toBe("failed");
    await button(page, "Discover module links").click(); await expect.poll(async () => (await snapshot(page)).bindings.links.state.status).toBe("failed");
    await button(page, "Discover document colors").click(); await expect.poll(async () => (await snapshot(page)).bindings.colors.state.status).toBe("failed");
    const methods = ["textDocument/signatureHelp", "textDocument/documentLink", "textDocument/documentColor"];
    await page.evaluate(methods => window.hostFixture.providerCustom("fixture/register", { registrations: methods.map((method, i) => ({ id: `selected-${i}`, method, registerOptions: { documentSelector: null, ...(i === 0 ? { triggerCharacters: ["("], retriggerCharacters: [","] } : {}), ...(i === 1 ? { resolveProvider: true } : {}) } })) }), methods);
    await field(page).press("Control+Shift+Space"); await expect(page.getByRole("tooltip", { name: "Signature help", exact: true })).toBeVisible(); await field(page).press("Escape");
    await button(page, "Discover document colors").click(); await expect.poll(async () => (await snapshot(page)).bindings.colors.state.count).toBe(1);
    await page.getByRole("textbox", { name: "Proposed color", exact: true }).fill("#112233"); replies.hold(); await button(page, "Preview color presentations").click(); await expect.poll(replies.waiting).toBe(true);
    await expect.poll(async () => (await snapshot(page)).bindings.colors.state.pending).toBe(true);
    await page.evaluate(() => window.hostFixture.providerCustom("fixture/unregister", { unregisterations: [{ id: "selected-2", method: "textDocument/documentColor" }] }));
    await replies.release(); await expect.poll(async () => (await snapshot(page)).bindings.colors.state.pending).toBe(false); await expect(button(page, "Apply captured color")).toBeDisabled();
    expect(await page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); })).toBe(text);
});
