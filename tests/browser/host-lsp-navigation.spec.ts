import { moveEditorIntoShadow } from "../helpers/shadow-editor.ts";
import { ready, isolatedTest as test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { coversHost } from "./host-cases.ts";
import { holdLspReplies } from "../helpers/lsp-replies.ts";
import { paintedCharacter } from "../helpers/painted-character.ts";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const field = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const results = (page: Page) => page.getByRole("list", { name: "Navigation results", exact: true }).getByRole("button");
async function waitForNavigation(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (!s.bindings.navigation.pending); });
}
async function select(page: Page, offset: number) { await page.evaluate(offset => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: offset, head: offset }); }, offset); }
async function seed(page: Page, text: string, offset: number) {
    await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, text); await field(page).focus(); await select(page, offset); await waitForNavigation(page);
}
async function hover(page: Page) { await field(page).press("Control+k"); await field(page).press("Control+i"); }
for (const host of ["plain", "react"] as const) test.describe(`${host} LSP inspection/navigation`, () => {
    test.beforeEach(async ({ page }) => {  await page.goto(`/hosts/${host}/?editor=candidate&language=lsp`); await expect(field(page)).toBeVisible(); await waitForNavigation(page); });
    if (coversHost("candidate-hosts", host, "candidate")) test("standard hover content and absent ranges preserve selections, safe text and focus", async ({ page }) => {
        const replies = await holdLspReplies(page, "textDocument/hover"); await page.reload();
        const packets: string[] = []; page.on("websocket", socket => socket.on("framesent", frame => { const data = JSON.parse(frame.payload.toString()); if (data.method) packets.push(data.method); }));
        await seed(page, "const café = 1;\r\n𐐀value = 2;", 2); await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 2, head: 2 }, { anchor: 8, head: 8 }]); }); await waitForNavigation(page);
        await moveEditorIntoShadow(field(page));
        await field(page).focus(); await waitForNavigation(page);
        const before = await snapshot(page); await hover(page); await expect(page.getByRole("tooltip")).toContainText("Declares a constant binding."); await expect(field(page)).toBeFocused();
        await page.getByRole("tooltip").focus(); await page.keyboard.press("Escape"); await expect(field(page)).toBeFocused();
        expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selectionSet).toEqual(before.bindings.views.find(view => view.id === "primary")!.selectionSet);
        expect((await snapshot(page)).bindings.hover.sessions.find(session => session.id === "primary")!.counters.transport).toBe("lsp3.17");
        await page.evaluate(() => window.hostFixture.faultHoverNext("primary", "markup")); await hover(page); await expect(page.getByRole("tooltip")).toContainText("<img"); await expect(page.getByRole("tooltip").locator("img,script")).toHaveCount(0);
        expect(await page.evaluate(() => Reflect.get(window, "hoverExecuted"))).toBeUndefined();
        await page.evaluate(() => window.hostFixture.faultHoverNext("primary", "malformed")); await hover(page); await expect.poll(async () => (await snapshot(page)).bindings.hover.presentation.status).toBe("failed");
        replies.hold(); await hover(page); await expect.poll(replies.waiting).toBe(true);
        await field(page, "Configuration path").focus(); await expect.poll(replies.cancelled).toBe(true); await replies.release();
        await expect(page.getByRole("tooltip")).toBeHidden(); await expect(field(page, "Configuration path")).toBeFocused();
        expect((await snapshot(page)).history).toEqual(before.history); expect((await snapshot(page)).source.exports).toBe(0); expect(packets).toContain("textDocument/hover");
    });
    if (coversHost("candidate-hosts", host, "candidate")) test("definition links and references open captured unmounted targets and return complete selections", async ({ page }) => {
        const replies = await holdLspReplies(page, "textDocument/definition"); await page.reload();
        const methods: { method: string; params?: { position?: unknown; context?: { includeDeclaration?: boolean } } }[] = []; let linkedResponses = 0;
        page.on("websocket", socket => { socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method) methods.push(value); });
            socket.on("framereceived", frame => { const value = JSON.parse(frame.payload.toString()); if (Array.isArray(value.result) && value.result[0]?.targetUri) linkedResponses++; }); });
        const text = "catalogue;\r\nconst local = 1;\r\n"; await seed(page, text, 3); await button(page, "Add navigation companion").click();
        await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 3, head: 3 }, { anchor: 22, head: 22 }]); });
        await moveEditorIntoShadow(field(page));
        const before = await snapshot(page); replies.hold(); await field(page).press("F12"); await expect.poll(replies.waiting).toBe(true);
        const progress = page.getByLabel("Symbol navigation progress", { exact: true });
        await expect(progress).toBeVisible();
        expect(await progress.evaluate(node => (node as HTMLProgressElement).position)).toBe(-1);
        await field(page, "Configuration path").focus(); await replies.release(); await waitForNavigation(page);
        await expect(progress).toBeHidden();
        await expect(field(page, "Configuration path")).toBeFocused(); await expect(results(page)).toHaveText(["Navigation companion:1:7 · declaration"]);
        expect((await snapshot(page)).bindings.navigation.transport?.version).toBe("LSP3.17");
        const companion = (await snapshot(page)).bindings.navigation.companion!; expect((await snapshot(page)).bindings.views.every(view => view.documentId !== companion)).toBe(true);
        replies.hold(); await field(page).press("F12"); await expect.poll(replies.waiting).toBe(true);
        await field(page, "Configuration path").focus(); await field(page).focus();
        await replies.release(); await waitForNavigation(page);
        await expect(field(page)).toBeFocused(); await expect(button(page, "Return to navigation origin")).toBeDisabled();
        await expect(results(page)).toHaveText(["Navigation companion:1:7 · declaration"]);
        await results(page).first().evaluate(node => { node.dataset.retained = "navigation-row"; });
        await results(page).first().click(); await waitForNavigation(page); await expect(field(page, "Secondary source")).toBeFocused(); expect((await snapshot(page)).bindings.views.find(view => view.id === "secondary")!.documentId).toBe(companion);
        await button(page, "Return to navigation origin").click(); await waitForNavigation(page); await expect(field(page)).toBeFocused(); expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selectionSet).toEqual(before.bindings.views.find(view => view.id === "primary")!.selectionSet);
        await expect(results(page).first()).toHaveAttribute("data-retained", "navigation-row");
        await field(page).press("F12"); await expect(field(page, "Secondary source")).toBeFocused();
        await button(page, "Return to navigation origin").click(); await expect(field(page)).toBeFocused();
        await button(page, "Find references").click(); await waitForNavigation(page); await expect(results(page)).toHaveCount(3);
        const sameList = results(page).filter({ hasText: "Navigation companion:" });
        await expect(sameList).toHaveCount(2);
        for (const [row, from] of [[0, 6], [1, "const catalogue = 1;\r\n".length]] as const) {
            await sameList.nth(row).click(); await expect(field(page, "Secondary source")).toBeFocused();
            expect((await snapshot(page)).bindings.views.find(view => view.id === "secondary")!.selection)
                .toMatchObject({ anchor: from, head: from + "catalogue".length });
        }
        await button(page, "Return to navigation origin").click(); await expect(field(page)).toBeFocused();
        await page.getByRole("checkbox", { name: "Include declarations in references", exact: true }).uncheck(); await button(page, "Find references").click(); await waitForNavigation(page); await expect(results(page)).toHaveCount(2);
        expect((await snapshot(page)).source.id).toBe(before.source.id); expect((await snapshot(page)).source.revision).toBe(before.source.revision); expect((await snapshot(page)).history).toEqual(before.history);
        expect(methods.some(message => message.method === "textDocument/definition" && JSON.stringify(message.params?.position) === JSON.stringify({ line: 0, character: 3 }))).toBe(true); expect(linkedResponses).toBeGreaterThan(0);
        expect(methods.filter(message => message.method === "textDocument/references").map(message => message.params?.context?.includeDeclaration)).toEqual([true, false]);
        const definitions = methods.filter(message => message.method === "textDocument/definition").length;
        await field(page).focus(); await select(page, text.indexOf(";") + 1); await button(page, "Find definition").click(); await waitForNavigation(page); await expect(results(page)).toHaveCount(0);
        expect(methods.filter(message => message.method === "textDocument/definition").length).toBe(definitions + 1);
    });
    if (coversHost("candidate-hosts", host, "candidate")) test("F12 from the secondary pane selects the definition when that pane opens the file", async ({ page }) => {
        await seed(page, "catalogue;", 0);
        await button(page, "Add navigation companion").click();
        const secondary = field(page, "Secondary source");
        await secondary.focus();
        await secondary.press("Home"); await secondary.press("ArrowRight"); await secondary.press("ArrowRight");
        const before = await snapshot(page);
        await secondary.press("F12");
        await expect.poll(async () => (await snapshot(page)).bindings.views.find(view => view.id === "secondary")?.documentId)
            .toBe(before.bindings.navigation.companion);
        await expect(secondary).toBeFocused();
        const after = await snapshot(page);
        expect(after.bindings.views.find(view => view.id === "secondary")?.selection).toMatchObject({ anchor: 6, head: 15 });
        await expect(results(page)).toHaveCount(0);
        await expect(button(page, "Return to navigation origin")).toBeDisabled();
        await secondary.press("ArrowLeft");
        expect((await snapshot(page)).bindings.views.find(view => view.id === "secondary")?.selection).toMatchObject({ anchor: 6, head: 6 });
        expect(after.source.id).toBe(before.source.id); expect(after.history).toEqual(before.history);
    });
    if (coversHost("candidate-hosts", host, "candidate")) test("closing the review preserves primary references and retires the review's own request", async ({ page }) => {
        const replies = await holdLspReplies(page, "textDocument/references");
        await page.reload();
        const text = "const target = 1;\ntarget;";
        await seed(page, text, text.lastIndexOf("target") + 2);
        await button(page, "Open source review").click();
        const review = field(page, "Comparison working source");
        await expect(review).toBeVisible();
        replies.hold();
        await field(page).press("Shift+F12");
        await expect.poll(replies.waiting).toBe(true);
        await button(page, "Close source review").click();
        await expect(review).toHaveCount(0);
        await replies.release();
        await waitForNavigation(page);
        await expect(results(page)).toHaveCount(2);
        await results(page).filter({ hasText: "Primary source:1:7" }).click();
        await expect(field(page)).toBeFocused();
        const selected = (await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selection;
        expect(selected).toMatchObject({ anchor: 6, head: 12 });

        await button(page, "Open source review").click();
        await review.focus();
        await page.evaluate(() => {
            const f = window.hostFixture;
            f.selectSourceSet("comparison", f.snapshot().source.revision, [{ anchor: 8, head: 8 }]);
        });
        replies.hold();
        await review.press("Shift+F12");
        await expect.poll(replies.waiting).toBe(true);
        await button(page, "Close source review").click();
        await expect.poll(replies.cancelled).toBe(true);
        await field(page).focus();
        await replies.release();
        await waitForNavigation(page);
        await expect(results(page)).toHaveCount(0);
        expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selection).toEqual(selected);
    });
    if (coversHost("candidate-hosts", host, "candidate")) test("replacing references during a press needs a fresh click to advance the page", async ({ page }) => {
        await seed(page, "const target = 1;\n" + "target;\n".repeat(130), 8);
        const find = button(page, "Find references"), next = button(page, "Next navigation results");
        await find.click(); await waitForNavigation(page);
        const first = results(page).first();
        await expect(first).toHaveText("Primary source:1:7");
        const initial = (await snapshot(page)).bindings.navigation.applied;
        const oldNext = await next.elementHandle();
        if (!oldNext) throw new Error("Missing Next button on the original references list.");
        await next.hover(); await page.mouse.down();
        await find.evaluate(node => (node as HTMLButtonElement).click());
        await expect.poll(async () => (await snapshot(page)).bindings.navigation.applied).toBe(initial + 1);
        await expect(next).toBeEnabled(); await page.mouse.up();
        await expect(first).toHaveText("Primary source:1:7");
        await oldNext.evaluate(node => (node as HTMLButtonElement).click()); await oldNext.dispose();
        await expect(first).toHaveText("Primary source:1:7");
        await next.focus(); await page.keyboard.press("Enter");
        await expect(first).toHaveText("Primary source:65:1"); await expect(next).toBeFocused();
        await page.keyboard.press("Space"); await expect(first).toHaveText("Primary source:129:1");
    });
    if (coversHost("candidate-hosts", host, "candidate")) test("Return retraces two symbol jumps with their selections, scroll and focus", async ({ page }) => {
        const text = "catalogue;\n" + "// padding\n".repeat(120) + "catalogue;\n";
        const tail = text.lastIndexOf("catalogue"), primary = field(page), secondary = field(page, "Secondary source");
        const back = button(page, "Return to navigation origin");
        const current = async (id: string) => (await snapshot(page)).bindings.views.find(view => view.id === id)!;
        await seed(page, text, tail + 3);
        await button(page, "Add navigation companion").click();
        await page.evaluate(tail => { const f = window.hostFixture;
            f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 1, head: 1 }, { anchor: tail + 7, head: tail + 3 }], 1);
        }, tail);
        await primary.evaluate(input => { input.closest<HTMLElement>(".st-editor")!.scrollTop = 1200; });
        await expect.poll(async () => (await current("primary")).metrics!.viewport.scrollTop).toBeGreaterThan(1000);
        const origin = await current("primary");
        await button(page, "Find definition").click();
        await results(page).filter({ hasText: "Navigation companion:" }).click();
        await expect(secondary).toBeFocused();
        await secondary.press("ArrowLeft"); await secondary.press("ArrowRight"); await waitForNavigation(page);
        const intermediate = await current("secondary");
        await button(page, "Find references").click();
        await results(page).filter({ hasText: /^Primary source:1:1$/ }).click();
        await expect(primary).toBeFocused(); await waitForNavigation(page);
        expect((await current("primary")).metrics!.viewport.scrollTop).toBeLessThan(origin.metrics!.viewport.scrollTop);
        await back.click(); await expect(secondary).toBeFocused();
        expect((await current("secondary")).selectionSet).toEqual(intermediate.selectionSet);
        await back.click(); await expect(primary).toBeFocused(); await waitForNavigation(page);
        const restored = await current("primary");
        expect(restored.selectionSet).toEqual(origin.selectionSet);
        expect(restored.metrics!.viewport.scrollTop).toBeCloseTo(origin.metrics!.viewport.scrollTop, 2);
        await expect(back).toBeDisabled();
    });
    if (coversHost("candidate-hosts", host, "candidate")) test("malformed navigation, changed authority and pending remount cannot publish stale targets", async ({ page, browserName, browserErrors }) => {
        const replies = await holdLspReplies(page, "textDocument/definition"); await page.reload();
        const text = "const target = 1;\r\ntarget"; await seed(page, text, text.length - 2); const before = await snapshot(page);
        await page.evaluate(() => window.hostFixture.faultNavigationNext("malformed")); await field(page).press("F12"); await expect(page.getByLabel("Symbol navigation status", { exact: true })).toContainText("unavailable"); await expect(results(page)).toHaveCount(0); await expect(field(page)).toBeFocused();
        await button(page, "Find definition").click(); await waitForNavigation(page); await expect(results(page)).toHaveCount(1); await page.evaluate(() => window.hostFixture.setSourceReadOnly(true)); await expect(results(page)).toHaveCount(0); await page.evaluate(() => window.hostFixture.setSourceReadOnly(false));
        replies.hold(); await field(page).press("F12"); await expect.poll(replies.waiting).toBe(true); await expect.poll(async () => (await snapshot(page)).bindings.navigation.pending).toBe(true);
        await field(page).press("ArrowLeft"); await expect.poll(replies.cancelled).toBe(true); await replies.release(); await waitForNavigation(page); await expect(results(page)).toHaveCount(0);
        const row = page.locator('.st-editor:has(> textarea[aria-label="Primary source"]) .st-viewport-row[data-line="1"]');
        await row.scrollIntoViewIfNeeded(); const point = await paintedCharacter(row, "target", 2);
        const link = row.locator(".st-definition-link");
        await field(page).focus(); await page.mouse.move(point.x, point.y);
        replies.hold(); await page.keyboard.down("Meta"); await expect.poll(replies.waiting).toBe(true);
        await page.mouse.click(point.x, point.y); await page.keyboard.up("Meta");
        await expect.poll(async () => (await snapshot(page)).bindings.navigation.pending).toBe(true);
        await page.keyboard.insertText("x"); await expect.poll(replies.cancelled).toBe(true); await replies.release(); await waitForNavigation(page);
        await expect(results(page)).toHaveCount(0); await expect(link).toHaveCount(0); await field(page).press("Control+z");
        await expect(row).toHaveText("target");
        const restored = await paintedCharacter(row, "target", 2);
        replies.hold(); await page.keyboard.down("Control"); await page.mouse.click(restored.x, restored.y); await page.keyboard.up("Control");
        await expect.poll(replies.waiting).toBe(true);
        await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await expect.poll(replies.cancelled).toBe(true); await replies.release(); await waitForNavigation(page); await expect(results(page)).toHaveCount(0);
        await field(page).focus(); await select(page, text.length - 2); await button(page, "Find definition").click(); await waitForNavigation(page); await expect(results(page)).toHaveCount(1);
        await button(page, "Disconnect navigation provider").click(); await field(page).press("Control+End"); await field(page).pressSequentially(" local");
        // This last reconnect is deliberately disposed during its handshake. WebKit can
        // report that abort from Playwright's routed socket; permit one exact diagnostic.
        if (browserName === "webkit") {
            const endpoint = new URL("/lsp-fixture", page.url()); endpoint.protocol = "ws:";
            browserErrors.allowConsoleError(`WebSocket connection to '${endpoint.href}' failed: WebSocket is closed before the connection is established.`,
                "web-inspector://bootstrap.js");
        }
        await button(page, "Reconnect navigation provider").click();
        expect((await snapshot(page)).source.revision).toBeGreaterThan(before.source.revision); await page.evaluate(() => window.hostFixture.dispose()); const final = await snapshot(page);
        expect(final.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(final.hostSubscriptions).toBe(0);
    });
    if (coversHost("candidate-hosts", host, "candidate")) test("review navigation and hover preserve the immutable baseline and working Save/Run identity", async ({ page }) => {
        const text = "catalogue;\r\nconst working = 1;"; await seed(page, text, 3); await button(page, "Open source review").click(); await button(page, "Add navigation companion").click(); await waitForNavigation(page);
        const working = field(page, "Comparison working source"); await working.focus(); await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("comparison", f.snapshot().source.revision, [{ anchor: 3, head: 3 }, { anchor: 23, head: 23 }]); });
        const before = await snapshot(page), baseline = await page.evaluate(() => { const f = window.hostFixture; return f.referenceRange(0, f.snapshot().bindings.comparison!.baseline!.length); });
        await working.press("F12"); await waitForNavigation(page); await expect(field(page, "Secondary source")).toBeFocused(); await button(page, "Return to navigation origin").click(); await waitForNavigation(page); await expect(working).toBeFocused();
        expect((await snapshot(page)).bindings.comparison!.selectionSet).toEqual(before.bindings.comparison!.selectionSet); await working.press("Control+k"); await working.press("Control+i"); await expect(page.getByRole("tooltip")).toContainText("catalogue");
        await field(page, "Comparison baseline source").focus(); await expect(page.getByRole("tooltip")).toBeHidden(); await expect(field(page, "Comparison baseline source")).toHaveAttribute("readonly", "");
        const requested = (await snapshot(page)).bindings.navigation.requested; await field(page, "Comparison baseline source").press("F12"); expect((await snapshot(page)).bindings.navigation.requested).toBe(requested);
        expect(await page.evaluate(length => window.hostFixture.referenceRange(0, length), baseline!.length)).toBe(baseline); expect((await snapshot(page)).history).toEqual(before.history);
        await field(page, "Secondary source").focus(); await button(page, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(page)).pendingRuns.length).toBe(1);
        expect((await snapshot(page)).pendingRuns[0]!.sourceId).toBe(before.source.id); expect(await page.evaluate(() => window.hostFixture.runCapture(0)!.source)).toBe(text); await page.evaluate(() => window.hostFixture.finishRun());
        await button(page, "Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1); await working.press("Control+End"); await working.pressSequentially(" later"); await page.evaluate(() => window.hostFixture.finishSave()); await waitForNavigation(page);
        expect((await snapshot(page)).source.dirty).toBe(true); expect(await page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); })).toBe(text + " later");
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
    });
    if (coversHost("plain-candidate", host, "candidate")) test("large-document hover and reference pages expose every target without changing source or history", async ({ page }) => {
        const text = "const unrelated = 123;\r\n".repeat(98_976) + "const target = 1;\r\n" + "target;\r\n".repeat(1023);
        await seed(page, text, text.lastIndexOf("target") + 2); const before = await snapshot(page);
        await hover(page); await expect(page.getByRole("tooltip")).toContainText("target"); await field(page).press("Escape"); await field(page).press("F12"); await waitForNavigation(page); await expect(results(page)).toHaveCount(1);
        const selected = (await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selection; expect(selected).toMatchObject({ anchor: text.lastIndexOf("const target") + 6, head: text.lastIndexOf("const target") + 12 });
        await button(page, "Find references").click(); await waitForNavigation(page); await expect(results(page)).toHaveCount(64);
        const second = await results(page).nth(1).elementHandle(); expect(second).toBeTruthy();
        await expect(button(page, "Previous navigation results")).toBeDisabled();
        for (let index = 1; index < 16; index++) { await button(page, "Next navigation results").click(); await expect(results(page)).toHaveCount(64); }
        await expect(button(page, "Next navigation results")).toBeDisabled();
        await second!.evaluate(node => (node as HTMLButtonElement).click()); await second!.dispose(); await waitForNavigation(page);
        const secondOffset = text.indexOf("target;", text.indexOf("const target"));
        expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selection).toMatchObject({ anchor: secondOffset, head: secondOffset + 6 });
        await results(page).last().click(); await waitForNavigation(page);
        expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selection).toMatchObject({ anchor: text.lastIndexOf("target"), head: text.lastIndexOf("target") + 6 });
        await button(page, "Previous navigation results").click(); await expect(results(page)).toHaveCount(64);
        await expect(button(page, "Next navigation results")).toBeEnabled();
        expect((await snapshot(page)).history).toEqual(before.history); expect((await snapshot(page)).source.revision).toBe(before.source.revision);
        expect((await snapshot(page)).source.exports).toBe(0); expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.metrics!.inputUnits).toBeLessThanOrEqual(4096);
    });
});
