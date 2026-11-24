import { ready, isolatedTest as test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { holdLspReplies } from "../helpers/lsp-replies.ts";
import { hostTextEquals } from "../../scripts/host-scene.mjs";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const source = '// TODO\r\nconst catalogue = 1;\r\ncatalogue;\r\nimport "other-utils";\r\nconst color = "#abc";\r\nlookup("key", )', caret = source.lastIndexOf("catalogue") + 2;
// Background swatches use documentColor too. blocked() and previews() count explicit color commands at the host.
const methods = ["textDocument/definition", "textDocument/rename", "textDocument/codeAction", "textDocument/documentLink", "textDocument/colorPresentation", "textDocument/signatureHelp"];
const signature = (page: Page) => page.getByRole("tooltip", { name: "Signature help", exact: true });

async function settled(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => {
        const s = window.hostFixture.snapshot();
        return window.hostFixture.settled && !s.bindings.navigation.pending && !s.bindings.rename.state.pending && !s.bindings.actions.state.pending
            && !s.bindings.signature.pending && !s.bindings.links.state.pending && !s.bindings.colors.state.pending;
    });
}
async function select(page: Page, at: number): Promise<void> {
    // The host's tool panels can scroll the source outside the page. Its popups
    // only paint while the anchor is visible, even when the input retains focus.
    await page.getByRole("region", { name: "Primary source", exact: true }).scrollIntoViewIfNeeded();
    await input(page).focus();
    await page.evaluate(at => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: at, head: at }]); }, at);
    await settled(page);
}
async function seed(page: Page, text: string, at: number): Promise<void> {
    await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, text);
    await select(page, at);
}
async function exact(page: Page, text: string): Promise<void> { expect(await hostTextEquals(page, text)).toBe(true); }
async function composition(page: Page, offered: "rename" | "actions" | "colors" | "signature"): Promise<void> {
    if (offered === "signature") await expect(signature(page)).toBeVisible();
    else expect((await snapshot(page)).bindings[offered].state.canApply).toBe(true);
    await blocked(page, "composition");
    await expect(button(page, "Apply captured rename")).toBeDisabled();
    await expect(button(page, "Apply captured action")).toBeDisabled();
    await expect(button(page, "Apply captured color")).toBeDisabled();
    await expect(signature(page)).toBeHidden();
    // Synthetic composition exercises arbitration, not native IME. Remount explicitly ends it.
    await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
    await settled(page);
}
async function previews(page: Page, checkComposition = false): Promise<void> {
    await select(page, caret);
    const before = await snapshot(page);
    await input(page).press("F12"); await settled(page);
    await expect(page.getByRole("list", { name: "Navigation results", exact: true }).getByRole("button")).toHaveCount(1);
    await select(page, caret);
    await page.getByLabel("New identifier", { exact: true }).fill("inventory");
    await button(page, "Prepare rename preview").click();
    await expect.poll(async () => (await snapshot(page)).bindings.rename.state.canApply).toBe(true);
    // The first action request registers a command capability, expiring earlier protocol
    // captures. Check composition against each live offer before starting another feature.
    if (checkComposition) { await composition(page, "rename"); await select(page, caret); }
    await button(page, "Preview module action").click();
    await expect(button(page, "Apply captured action")).toBeEnabled();
    if (checkComposition) await composition(page, "actions");
    await select(page, source.indexOf("#abc") + 2);
    await button(page, "Discover module links").click();
    await expect(page.getByLabel("Module link results", { exact: true }).getByRole("listitem")).toHaveCount(1);
    await button(page, "Discover document colors").click();
    await expect.poll(async () => (await snapshot(page)).bindings.colors.state.count).toBe(1);
    await page.getByLabel("Proposed color", { exact: true }).fill("#112233");
    await button(page, "Preview color presentations").click();
    await expect(button(page, "Apply captured color")).toBeEnabled();
    expect((await snapshot(page)).bindings.links.state.count).toBe(1);
    if (checkComposition) await composition(page, "colors");
    await select(page, source.length - 1);
    await input(page).press("Control+Shift+Space");
    await expect(signature(page).getByLabel("Active signature parameter", { exact: true })).toHaveText("fallback?: string");
    await settled(page);
    const after = await snapshot(page);
    expect(after.bindings.navigation.requested).toBe(before.bindings.navigation.requested + 1);
    expect(after.bindings.rename.requested).toBe(before.bindings.rename.requested + 1);
    expect(after.bindings.actions.requested).toBe(before.bindings.actions.requested + 1);
    expect(after.bindings.signature.requested).toBe(before.bindings.signature.requested + 1);
    expect(after.bindings.links.requested).toBe(before.bindings.links.requested + 1);
    expect(after.bindings.colors.requested).toBe(before.bindings.colors.requested + 1);
    expect(after.bindings.colors.previews).toBe(before.bindings.colors.previews + 1);
    expect(after.history).toEqual(before.history); expect(after.source.revision).toBe(before.source.revision);
    if (checkComposition) await composition(page, "signature");
}

// All requests run in the same turn as the input event, before cooperative work can finish.
// This tests each binding's capture guard without repeating the large paste per feature.
async function blocked(page: Page, kind: "movement" | "composition" | "paste", text = ""): Promise<void> {
    const result = await input(page).evaluate((node, { kind, text }) => {
        const f = window.hostFixture, before = f.snapshot();
        if (kind === "movement") node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true }));
        else if (kind === "composition") node.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
        else {
            const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            event.clipboardData!.setData("text/plain", text); node.dispatchEvent(event);
        }
        const pending = f.snapshot(), click = (label: string) => [...document.querySelectorAll("button")].find(button => button.textContent === label)!.click();
        node.dispatchEvent(new KeyboardEvent("keydown", { key: "F12", bubbles: true, cancelable: true }));
        node.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true }));
        click("Prepare rename preview"); f.requestAction();
        node.dispatchEvent(new KeyboardEvent("keydown", { key: " ", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
        f.requestSignature(); f.requestLinks(); f.requestColors(); f.previewColor();
        if (kind === "paste") for (const label of ["Insert catalogue import", "Save source", "Run captured inputs"]) click(label);
        const after = f.snapshot();
        return {
            movement: pending.bindings.views.find(v => v.id === "primary")!.metrics!.pendingCommand,
            paste: pending.bindings.tablePaste.pending, pasteStillPending: after.bindings.tablePaste.pending,
            navigation: after.bindings.navigation.requested - before.bindings.navigation.requested,
            rename: after.bindings.rename.requested - before.bindings.rename.requested,
            actions: after.bindings.actions.requested - before.bindings.actions.requested,
            signature: after.bindings.signature.requested - before.bindings.signature.requested,
            links: after.bindings.links.requested - before.bindings.links.requested,
            colors: after.bindings.colors.requested - before.bindings.colors.requested,
            colorPreviews: after.bindings.colors.previews - before.bindings.colors.previews,
            domain: after.bindings.domain.requested - before.bindings.domain.requested,
            saves: after.pendingSaves.length, runs: after.pendingRuns.length,
            renameApplicable: after.bindings.rename.state.canApply, actionApplicable: after.bindings.actions.state.canApply,
            colorApplicable: after.bindings.colors.state.canApply, signatureVisible: after.bindings.signature.presentation.visible, linksAvailable: after.bindings.links.state.count,
            revision: after.source.revision - before.source.revision, historyUnchanged: JSON.stringify(after.history) === JSON.stringify(before.history),
        };
    }, { kind, text });
    expect(result).toMatchObject({ navigation: 0, rename: 0, actions: 0, signature: 0, links: 0, colors: 0, colorPreviews: 0, domain: 0, saves: 0, runs: 0, revision: 0, historyUnchanged: true });
    if (kind === "movement") expect(result.movement).toBe(true);
    if (kind === "composition") expect(result).toMatchObject({ renameApplicable: false, actionApplicable: false, colorApplicable: false, signatureVisible: false, linksAvailable: 0 });
    if (kind === "paste") expect(result).toMatchObject({ paste: true, pasteStillPending: true });
}

test(`plain LSP captures wait for movement, composition and table input before fresh previews and Save/Run`, async ({ page }) => {
    test.setTimeout(120000);
    const replies = await holdLspReplies(page, "textDocument/signatureHelp");
    const wire: string[] = [];
    page.on("websocket", socket => socket.on("framesent", frame => {
        const message = JSON.parse(frame.payload.toString()); if (methods.includes(message.method)) wire.push(message.method);
    }));
    await page.goto("/hosts/plain/?language=lsp");
    await expect(input(page)).toBeVisible(); await settled(page);
    await page.getByLabel("New identifier", { exact: true }).fill("inventory");
    const longSource = "lookup(" + " ".repeat(200000) + ") #abc";
    await seed(page, longSource, 7);
    await blocked(page, "movement"); await settled(page);
    expect(wire).toEqual([]);
    await select(page, longSource.indexOf(")")); await input(page).press("Control+Shift+Space");
    await expect(signature(page).getByLabel("Active signature parameter", { exact: true })).toHaveText("key: string");
    expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.metrics!.viewport.scrollLeft).toBeGreaterThan(0);
    await input(page).press("Escape"); await expect(signature(page)).toBeHidden();
    await select(page, longSource.indexOf("#abc") + 2); await button(page, "Discover document colors").click();
    await expect.poll(async () => (await snapshot(page)).bindings.colors.state.count).toBe(1);
    await page.getByLabel("Proposed color", { exact: true }).fill("#112233"); await button(page, "Preview color presentations").click();
    await expect(button(page, "Apply captured color")).toBeEnabled();
    const initialMethods = ["textDocument/signatureHelp", "textDocument/colorPresentation"];
    expect(wire).toEqual(initialMethods);

    await seed(page, source, caret); await previews(page, true);
    expect(wire).toEqual([...initialMethods, ...methods]);

    const cell = "B".repeat(400000), csv = '"A","' + cell + '"', expected = source.slice(0, caret) + csv + source.slice(caret);
    await select(page, caret); await page.getByLabel("New identifier", { exact: true }).fill("inventory");
    await page.getByRole("checkbox", { name: "Paste tables as CSV", exact: true }).check();
    await input(page).focus(); await settled(page);
    const before = await snapshot(page);
    await blocked(page, "paste", "A\t" + cell);
    await expect.poll(async () => (await snapshot(page)).bindings.tablePaste.pending, { timeout: 30000 }).toBe(false);
    await settled(page); await exact(page, expected); expect(wire).toEqual([...initialMethods, ...methods]);
    const pasted = await snapshot(page);
    expect(pasted.bindings.tablePaste.status).toBe("applied"); expect(pasted.history.undoDepth).toBe(before.history.undoDepth + 1);
    expect(pasted.inputRecovery).toEqual([]);
    await button(page, "Dismiss message").click(); await button(page, "Save source").click();
    await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
    expect((await snapshot(page)).pendingSaves[0]).toMatchObject({ revision: pasted.source.revision, length: expected.length });
    await page.evaluate(() => window.hostFixture.finishSave()); await settled(page);
    await button(page, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(page)).pendingRuns.length).toBe(1);
    expect(await page.evaluate(() => window.hostFixture.runCapture(0)!.source)).toBe(expected);
    await page.evaluate(() => window.hostFixture.finishRun());
    await input(page, "Secondary source").press("Control+z"); await settled(page); await exact(page, source);
    expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth);
    await previews(page); expect(wire).toEqual([...initialMethods, ...methods, ...methods]);
    const beforeAuthority = await snapshot(page);
    replies.hold(); await input(page).press("Control+Shift+Space"); await expect.poll(replies.waiting).toBe(true);
    await page.evaluate(() => { window.hostFixture.setSourceReadOnly(true); window.hostFixture.setSourceReadOnly(false); });
    await expect.poll(replies.cancelled).toBe(true);
    // Authority cancellation is established before Escape. Dismiss the legitimate automatic
    // retrigger so only the held old response can affect the following publication checks.
    await input(page).press("Escape"); await settled(page);
    const beforeReply = await snapshot(page), sentBeforeReply = [...wire];
    await replies.release(); await settled(page);
    await expect(signature(page)).toBeHidden();
    expect((await snapshot(page)).bindings.signature.applied).toBe(beforeReply.bindings.signature.applied);
    expect(wire).toEqual(sentBeforeReply);
    expect((await snapshot(page)).history).toEqual(beforeAuthority.history); await exact(page, source);
    await input(page).press("Control+Shift+Space");
    await expect(signature(page).getByLabel("Active signature parameter", { exact: true })).toHaveText("fallback?: string");
    expect((await snapshot(page)).bindings.signature.requested).toBe(beforeReply.bindings.signature.requested + 1);
    expect(wire).toEqual([...sentBeforeReply, "textDocument/signatureHelp"]);
    await page.evaluate(() => window.hostFixture.dispose());
    const final = await snapshot(page);
    expect(final.bindings.navigation).toMatchObject({ sessions: [], subscriptions: 0, pending: false, results: 0 });
    expect(final.bindings.rename).toMatchObject({ sessions: 0, subscriptions: 0, disposed: true });
    expect(final.bindings.actions).toMatchObject({ sessions: 0, subscriptions: 0, disposed: true });
    expect(final.bindings.project).toMatchObject({ pending: false, transport: null, disposed: true });
    expect(final.bindings.signature).toMatchObject({ sessions: 0, subscriptions: 0, pending: false });
    expect(final.bindings.links).toMatchObject({ sessions: 0, subscriptions: 0, disposed: true });
    expect(final.bindings.colors).toMatchObject({ sessions: 0, subscriptions: 0, disposed: true });
    expect(final.bindings.lsp).toMatchObject({ scopes: 0, documents: 0, created: 1, terminated: 1 });
    await expect.poll(() => page.workers().length).toBe(0);
});
