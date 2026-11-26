import { moveEditorIntoShadow } from "../helpers/shadow-editor.ts";
import { ready, isolatedTest as test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { holdLspReplies } from "../helpers/lsp-replies.ts";
import { paintedCharacter } from "../helpers/painted-character.ts";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const field = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const results = (page: Page) => page.getByRole("region", { name: "Symbol locations", exact: true }).getByRole("option");
async function waitForNavigation(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (!s.bindings.navigation.pending); });
}
async function select(page: Page, offset: number) { await page.evaluate(offset => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: offset, head: offset }); }, offset); }
async function seed(page: Page, text: string, offset: number) {
    await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, text); await field(page).focus(); await select(page, offset); await waitForNavigation(page);
}
async function hover(page: Page) { await field(page).press("Control+k"); await field(page).press("Control+i"); }
test.describe("plain LSP inspection/navigation", () => {
    test.beforeEach(async ({ page }) => {  await page.goto(`/hosts/plain/?language=lsp`); await expect(field(page)).toBeVisible(); await waitForNavigation(page); });
    test("successive symbol lookups share unopened project files and release them on dismissal", async ({ page }) => {
        const opens: string[] = [], closes: string[] = [];
        let companionUri: string | undefined;
        page.on("websocket", socket => socket.on("framesent", frame => {
            const { method, params } = JSON.parse(frame.payload.toString());
            if (method === "textDocument/didOpen") {
                opens.push(params.textDocument.uri);
                if (params.textDocument.text.startsWith("const catalogue = 1;")) companionUri = params.textDocument.uri;
            } else if (method === "textDocument/didClose") closes.push(params.textDocument.uri);
        }));
        await page.reload(); await seed(page, "catalogue;\r\ncatalogue;", 3);
        await button(page, "Add navigation companion").click(); await field(page).focus();
        const editor = page.locator('.st-editor:has(> textarea[aria-label="Primary source"])');
        await editor.scrollIntoViewIfNeeded(); await page.keyboard.down("Control");
        for (const line of [0, 1]) {
            const row = editor.locator(`.st-viewport-row[data-line="${line}"]`), at = await paintedCharacter(row, "catalogue", 3);
            await page.mouse.move(at.x, at.y); await expect(row.locator(".st-definition-link")).toHaveText("catalogue");
        }
        const opened = () => opens.filter(uri => uri === companionUri).length, closed = () => closes.filter(uri => uri === companionUri).length;
        expect(opened()).toBe(1); expect(closed()).toBe(0);
        await page.keyboard.up("Control"); await expect.poll(closed).toBe(1);
        await field(page).press("Shift+F12");
        await expect(results(page).first()).toBeVisible();
        const row = editor.locator('.st-viewport-row[data-line="0"]'); await row.scrollIntoViewIfNeeded();
        const at = await paintedCharacter(row, "catalogue", 3);
        await page.keyboard.down("Control"); await page.mouse.move(at.x, at.y); await expect(row.locator(".st-definition-link")).toHaveText("catalogue");
        await page.keyboard.up("Control"); await expect(row.locator(".st-definition-link")).toHaveCount(0);
        await expect(results(page).first()).toBeEnabled();
        expect(opened()).toBe(2); expect(closed()).toBe(1);
        await field(page).press("Escape");
        await expect.poll(closed).toBe(2); await expect(results(page)).toHaveCount(0);
        expect(await page.evaluate(() => window.hostFixture.releaseNavigationCompanion())).toBe(true);
    });
    test("standard hover content and absent ranges preserve selections, safe text and focus", async ({ page }) => {
        const replies = await holdLspReplies(page, "textDocument/hover"); await page.reload();
        await seed(page, "const café = 1;\r\n𐐀value = 2;", 2); await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 2, head: 2 }, { anchor: 8, head: 8 }]); }); await waitForNavigation(page);
        await moveEditorIntoShadow(field(page));
        await field(page).focus(); await waitForNavigation(page);
        const before = await snapshot(page); await hover(page); await expect(page.getByRole("tooltip")).toContainText("Declares a constant binding."); await expect(field(page)).toBeFocused();
        await page.getByRole("tooltip").focus(); await page.keyboard.press("Escape"); await expect(field(page)).toBeFocused();
        expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selectionSet).toEqual(before.bindings.views.find(view => view.id === "primary")!.selectionSet);
        await page.evaluate(() => window.hostFixture.faultHoverNext("primary", "markup")); await hover(page); await expect(page.getByRole("tooltip")).toContainText("<img"); await expect(page.getByRole("tooltip").locator("img,script")).toHaveCount(0);
        expect(await page.evaluate(() => Reflect.get(window, "hoverExecuted"))).toBeUndefined();
        await page.evaluate(() => window.hostFixture.faultHoverNext("primary", "malformed"));
        await hover(page);
        await expect(page.getByRole("tooltip")).toContainText("Malformed");
        replies.hold(); await hover(page); await expect.poll(replies.waiting).toBe(true);
        await field(page, "Configuration path").focus(); await expect.poll(replies.cancelled).toBe(true); await replies.release();
        await expect(page.getByRole("tooltip")).toBeHidden(); await expect(field(page, "Configuration path")).toBeFocused();
        expect((await snapshot(page)).history).toEqual(before.history);
    });
    test("the references chooser opens a companion in the secondary pane and Return restores every caret", async ({ page }) => {
        const text = "catalogue;\r\nconst local = 1;\r\n";
        await seed(page, text, 3);
        await button(page, "Add navigation companion").click();
        await page.evaluate(() => {
            const f = window.hostFixture;
            f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 9, head: 0 }, { anchor: 22, head: 22 }]);
        });
        const before = await snapshot(page);
        await field(page).press("Shift+F12");
        const destination = results(page).filter({ hasText: /Navigation companion.*1:7/ });
        await destination.click();
        await expect(field(page, "Secondary source")).toBeFocused();
        expect((await snapshot(page)).bindings.views.find(v => v.id === "secondary")!.selection)
            .toMatchObject({ anchor: 6, head: 15 });
        await button(page, "Return to navigation origin").click();
        await expect(field(page)).toBeFocused();
        const after = await snapshot(page);
        expect(after.bindings.views.find(v => v.id === "primary")!.selectionSet)
            .toEqual(before.bindings.views.find(v => v.id === "primary")!.selectionSet);
        expect(after.history).toEqual(before.history);
    });
    test("F12 and modifier clicks follow whole module paths and respect later input", async ({ page }) => {
        const replies = await holdLspReplies(page, "documentLink/resolve");
        let routedScans = 0;
        const methods: string[] = [];
        page.on("websocket", ws => ws.on("framesent", frame => {
            const { method, params } = JSON.parse(frame.payload.toString());
            if (typeof method === "string") methods.push(method);
            if (method === "textDocument/documentLink" && params?._fixture?.aliases) routedScans++;
        }));
        await page.reload();
        const text = 'import "sample-utils";\r\nimport "missing-utils";\r\ncatalogue;';
        await seed(page, text, text.length); await button(page, "Add module companion").click();
        const source = field(page), editor = source.locator(".."), status = page.getByLabel("Locations status", { exact: true });
        await source.focus();
        const clickPath = async (line: number, module: string) => {
            const row = editor.locator(`.st-viewport-row[data-line="${line}"]`);
            await row.scrollIntoViewIfNeeded();
            const at = await paintedCharacter(row, module, module.indexOf("-"));
            await page.mouse.move(at.x, at.y); await page.keyboard.down("Control");
            try {
                await expect(row.locator(".st-definition-link")).toHaveText(module);
                await page.mouse.click(at.x, at.y);
            } finally { await page.keyboard.up("Control"); }
        };
        await expect(editor.locator(".st-document-link")).toHaveText(["sample-utils", "missing-utils"]);
        // The first click captures the aliases for this route. A later resolve cannot steal focus back from a field.
        replies.hold(); await clickPath(0, "sample-utils"); await expect.poll(replies.waiting).toBe(true);
        const path = field(page, "Configuration path"); await path.focus(); await replies.release();
        await expect(path).toBeFocused(); expect((await snapshot(page)).bindings.links.opened).toBe(0);
        await expect(editor.locator(".st-document-link")).toHaveText(["sample-utils", "missing-utils"]);
        await source.focus(); await select(page, text.indexOf("-")); await source.press("F12");
        await expect(field(page, "Secondary source")).toBeFocused();
        await button(page, "Return to link origin").click(); await expect(source).toBeFocused();
        await select(page, text.length); await clickPath(0, "sample-utils");
        await expect(field(page, "Secondary source")).toBeFocused();
        await button(page, "Return to link origin").click(); await expect(source).toBeFocused();
        expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selection.head).toBe(text.indexOf("-"));
        await clickPath(1, "missing-utils"); await expect(status).toContainText("No destination for missing-utils");
        await expect(status).toBeInViewport(); await expect(source).toBeFocused();
        expect(routedScans).toBe(1);
        expect(methods).not.toContain("textDocument/definition");
        expect((await snapshot(page)).bindings.links.opened).toBe(2);
        // A source edit retires the choice while resolution is in flight.
        await button(page, "Discover module links").click();
        await expect(page.getByLabel("Module link results", { exact: true }).getByRole("button")).toHaveCount(2);
        replies.hold(); await clickPath(0, "sample-utils"); await expect.poll(replies.waiting).toBe(true);
        await source.press("Control+End"); await page.keyboard.type("!"); await replies.release();
        await expect(source).toBeFocused(); await expect(editor.locator(".st-document-link")).toHaveText(["sample-utils", "missing-utils"]);
        await expect(editor.locator('.st-viewport-row[data-line="2"]')).toHaveText("catalogue;!");
        expect((await snapshot(page)).bindings.links.opened).toBe(2);
    });
    test("F12 follows a newly typed import while its background link reply is held", async ({ page }) => {
        const scans = await holdLspReplies(page, "textDocument/documentLink", "background");
        await page.reload();
        const source = field(page);
        const links = source.locator("..").locator(".st-document-link");
        await seed(page, 'import "prior";', 8);
        await expect(links).toHaveText("prior");
        await button(page, "Add module companion").click();
        scans.hold();
        const text = 'import "sample-utils";';
        await seed(page, text, text.indexOf("-"));
        await expect.poll(scans.waiting).toBe(true);
        try {
            await source.press("F12");
            await expect(field(page, "Secondary source")).toBeFocused();
        } finally {
            await scans.release();
        }
    });
    test("a later module lookup prevents an earlier definition from switching panes", async ({ page }) => {
        const definitions = await holdLspReplies(page, "textDocument/definition");
        await page.reload();
        await seed(page, 'catalogue;\r\nimport "sample-utils";\r\n', 3);
        await button(page, "Add navigation companion").click();
        await page.evaluate(() => window.hostFixture.faultLinksNext("failure"));
        definitions.hold();
        await field(page).press("F12");
        await expect.poll(definitions.waiting).toBe(true);
        await field(page).press("F4");
        await expect.poll(async () => (await snapshot(page)).bindings.links.state.status).toBe("failed");
        await definitions.release();
        await waitForNavigation(page);
        await expect(field(page)).toBeFocused();
        const state = await snapshot(page);
        expect(state.bindings.views.every(view => view.documentId !== state.bindings.navigation.companion)).toBe(true);
        await expect(button(page, "Return to navigation origin")).toBeDisabled();
    });
    test("F12 from the secondary pane places the caret before the definition when that pane opens the file", async ({ page }) => {
        await seed(page, "// preceding line\n".repeat(100) + "catalogue;", 0);
        await button(page, "Add navigation companion").click();
        const secondary = field(page, "Secondary source");
        await secondary.press("Control+End");
        await secondary.press("Home"); await secondary.press("ArrowRight"); await secondary.press("ArrowRight");
        const scroll = await secondary.locator("..").evaluate(node => node.scrollTop);
        expect(scroll).toBeGreaterThan(0);
        const before = await snapshot(page);
        await secondary.press("F12");
        await expect.poll(async () => (await snapshot(page)).bindings.views.find(view => view.id === "secondary")?.documentId)
            .toBe(before.bindings.navigation.companion);
        await expect(secondary).toBeFocused();
        const after = await snapshot(page);
        const pane = page.getByRole("region", { name: "Right host pane", exact: true });
        await expect(pane.getByText("Navigation companion", { exact: true })).toBeInViewport();
        expect(after.bindings.views.find(view => view.id === "secondary")?.selection).toMatchObject({ anchor: 6, head: 6 });
        await expect(results(page)).toHaveCount(0);
        await expect(button(page, "Return to navigation origin")).toBeDisabled();
        await secondary.press("ArrowLeft");
        expect((await snapshot(page)).bindings.views.find(view => view.id === "secondary")?.selection).toMatchObject({ anchor: 5, head: 5 });
        expect(after.source.id).toBe(before.source.id); expect(after.history).toEqual(before.history);
        await pane.getByRole("button", { name: "Show original source", exact: true }).click();
        await expect(secondary).toBeFocused();
        await expect(pane.getByText("Navigation companion", { exact: true })).toHaveCount(0);
        await expect.poll(() => secondary.locator("..").evaluate(node => node.scrollTop)).toBe(scroll);
        const originalView = before.bindings.views.find(view => view.id === "secondary")!;
        expect((await snapshot(page)).bindings.views.find(view => view.id === "secondary")).toMatchObject({
            documentId: originalView.documentId, viewId: originalView.viewId, selectionSet: originalView.selectionSet,
        });
    });
    test("returning to a module origin preserves the later symbol visit", async ({ page }) => {
        const text = 'import "sample-utils";\nconst sample = 1;\nsample;';
        const symbol = text.lastIndexOf("sample") + 2, path = text.indexOf("-");
        await seed(page, text, symbol);
        await button(page, "Add module companion").click();
        const primary = field(page), secondary = field(page, "Secondary source");
        const back = button(page, "Return to navigation origin");
        await select(page, path); await primary.press("F12"); await expect(secondary).toBeFocused();
        await primary.focus(); await select(page, symbol); await primary.press("F12");
        await expect.poll(async () => (await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selection.anchor)
            .toBe(text.indexOf("sample ="));
        await button(page, "Return to link origin").click(); await expect(primary).toBeFocused();
        expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selection).toMatchObject({ anchor: path, head: path });
        await back.click();
        expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selection).toMatchObject({ anchor: symbol, head: symbol });
    });

    test("review navigation and hover preserve the immutable baseline and working Save/Run identity", async ({ page }) => {
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
        await page.evaluate(() => window.hostFixture.dispose());
    });
});

test("a modifier click in a shadow tree retires its definition on typing or remount", async ({ page }) => {
    const replies = await holdLspReplies(page, "textDocument/definition");
    await page.goto("/hosts/plain/?language=lsp");
    await expect(field(page)).toBeVisible();
    const text = "const target = 1;\r\ntarget";
    await seed(page, text, text.length - 2);

    await moveEditorIntoShadow(field(page));
    const row = page.locator('.st-editor:has(> textarea[aria-label="Primary source"]) .st-viewport-row[data-line="1"]');
    await row.scrollIntoViewIfNeeded();
    const point = await paintedCharacter(row, "target", 2);
    await field(page).focus();
    await page.mouse.move(point.x, point.y);
    replies.hold();
    await page.keyboard.down("Meta");
    await expect.poll(replies.waiting).toBe(true);
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up("Meta");
    await expect.poll(async () => (await snapshot(page)).bindings.navigation.pending).toBe(true);
    await page.keyboard.insertText("x");
    await expect.poll(replies.cancelled).toBe(true);
    await replies.release();
    await waitForNavigation(page);
    await expect(results(page)).toHaveCount(0);
    await expect(row.locator(".st-definition-link")).toHaveCount(0);
    await field(page).press("Control+z");
    await expect(row).toHaveText("target");

    const restored = await paintedCharacter(row, "target", 2);
    replies.hold();
    await page.keyboard.down("Control");
    await page.mouse.click(restored.x, restored.y);
    await page.keyboard.up("Control");
    await expect.poll(replies.waiting).toBe(true);
    await page.evaluate(() => {
        window.hostFixture.unmount();
        window.hostFixture.mount();
    });
    await expect.poll(replies.cancelled).toBe(true);
    await replies.release();
    await waitForNavigation(page);
    await expect(results(page)).toHaveCount(0);
    await field(page).focus();
    await select(page, text.length - 2);
    await button(page, "Find definition").click();
    await expect.poll(async () => (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection)
        .toMatchObject({ anchor: 6, head: 6 });
    await page.evaluate(() => window.hostFixture.dispose());
});
