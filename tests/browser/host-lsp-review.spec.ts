import { ready, isolatedTest as test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const source = (page: Page) => page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length));
const field = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const provider = async (page: Page, id = "primary") => (await snapshot(page)).bindings.language.sessions.find(session => session.id === id)!.provider;

async function seed(page: Page, text: string, offset = text.indexOf("saMORE") + 2) {
    await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, text);
    await field(page).focus(); await page.evaluate(offset => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: offset, head: offset }); }, offset); await ready(page);
}
async function offer(page: Page) { await field(page).press("Control+Space"); await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible(); }

for (const mode of ["plain", "react"] as const) test.describe(`${mode} LSP review host`, () => {
    test.beforeEach(async ({ page }) => {
         await page.goto(`/hosts/${mode}/?editor=candidate&language=lsp`); await expect(field(page)).toBeVisible(); await ready(page);
    });
    test("rejected provider attachment retains review and retries without leaking scopes or leases", async ({ page }) => {
        const original = ("const sa = 1; // " + "x".repeat(1000) + "\r\n").repeat(3100);
        await seed(page, original, 0); await button(page, "Open source review").click(); await ready(page);
        const working = field(page, "Comparison working source"), status = page.getByLabel("Language status", { exact: true });
        await working.focus(); await expect(status).toContainText("LSP document size limit exceeded.");
        await expect(status).toContainText("Local editing and Find remain available."); await expect(button(page, "Request completion")).toBeDisabled();
        const before = await snapshot(page); expect(before.bindings.comparison).not.toBeNull(); expect(before.lastError).toBeNull();
        for (let i = 0; i < 2; i++) {
            await button(page, "Reconnect provider").click(); await expect(status).toContainText("LSP document size limit exceeded.");
            const after = await snapshot(page);
            expect(after.diagnostics).toMatchObject({ leases: before.diagnostics.leases, views: before.diagnostics.views, subscriptions: before.diagnostics.subscriptions });
            expect(after.bindings.lsp).toMatchObject({ scopes: before.bindings.lsp!.scopes, documents: before.bindings.lsp!.documents, documentParticipants: before.bindings.lsp!.documentParticipants });
        }
        await working.press("Control+Home"); await working.pressSequentially("!"); await ready(page); expect(await source(page)).toBe("!" + original);
        await working.press("Control+z"); await ready(page); expect(await source(page)).toBe(original);
        await page.evaluate(() => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: "const sa" }]); });
        await ready(page); await button(page, "Reconnect provider").click();
        await expect.poll(async () => (await provider(page, "comparison")).connected).toBe(true); await expect(status).not.toContainText("unavailable");
        await working.press("Control+End"); await working.press("Control+Space"); await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible();
        await working.press("Alt+Enter"); await ready(page); expect(await source(page)).toBe("const sample");
        await page.evaluate(() => window.hostFixture.dispose()); const final = await snapshot(page);
        expect(final.diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 }); expect(final.hostSubscriptions).toBe(0);
        expect(final.bindings.lsp).toMatchObject({ scopes: 0, documents: 0, documentParticipants: 0 });
    });
    test("LSP completion in conflict review preserves its reference and captured Save/Run identities", async ({ page }) => {
        const original = "const local = 1; // TODO", remote = "const remote = 9;\r\n"; await seed(page, original, original.length);
        await page.evaluate(text => window.hostFixture.externalWrite(text), remote); await button(page, "Save source").click(); await button(page, "Finish save").click();
        await button(page, "Review remote source").click(); await button(page, "Finish remote review").click(); await ready(page);
        const working = field(page, "Comparison working source"); await working.press("Control+End"); await working.pressSequentially("\nconst saMORE"); for (let i = 0; i < 4; i++) await working.press("ArrowLeft");
        await working.press("Control+Space"); await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible(); await working.press("Alt+Enter"); await ready(page);
        const corrected = original + "\nconst sample"; expect(await source(page)).toBe(corrected); expect(await page.evaluate(text => window.hostFixture.referenceRange(0, text.length), remote)).toBe(remote);
        await field(page, "Comparison baseline source").focus(); await expect(button(page, "Request completion")).toBeDisabled(); await expect(field(page, "Comparison baseline source")).toHaveAttribute("readonly", "");
        await working.focus(); const identity = (await snapshot(page)).source.id; await button(page, "Save reviewed source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await working.press("Control+End"); await working.pressSequentially(" later"); await button(page, "Finish save").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(0); expect((await snapshot(page)).source.dirty).toBe(true);
        await button(page, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(page)).pendingRuns.length).toBe(1);
        expect((await snapshot(page)).pendingRuns[0]!.sourceId).toBe(identity); expect(await page.evaluate(() => window.hostFixture.runCapture(0))).toMatchObject({ source: corrected + " later" });
    });
    test("proposal locks expire an offered completion; a fresh correction survives save, acknowledgement retry and the next request", async ({ page }) => {
        const original = "const saMORE = 1; // TODO";
        await seed(page, original); await offer(page);
        const offered = await page.evaluate(() => window.hostFixture.providerState()!.completionId), before = await snapshot(page);
        expect(offered).toBeGreaterThan(0); expect((await provider(page)).transport).toBe("lsp3.17");
        const obsoleteChoice = await page.getByRole("option", { name: "sample", exact: true }).getByRole("button").elementHandle();
        expect(obsoleteChoice).not.toBeNull();
        await button(page, "Associate agent").click(); await button(page, "Request proposal").click();
        const captured = (await snapshot(page)).requestInput, revision = (await snapshot(page)).source.revision;
        await expect(page.getByRole("option")).toHaveCount(0); await expect(button(page, "Replace completion")).toBeDisabled();
        expect(await page.evaluate(() => window.hostFixture.providerState()!.completionId)).not.toBe(offered);
        await obsoleteChoice!.evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true }))); await obsoleteChoice!.dispose();
        await button(page, "Replace completion").dispatchEvent("click");
        expect((await snapshot(page)).source.revision).toBe(revision); expect(await source(page)).toBe(original);
        expect((await snapshot(page)).history).toEqual(before.history);
        await page.evaluate(() => window.hostFixture.deliverProposal("const saMORE = 2; // TODO")); await ready(page);
        await field(page).press("Control+Home"); for (let i = 0; i < 8; i++) await field(page).press("ArrowRight");
        await offer(page); const proposed = await snapshot(page); await field(page).press("Alt+Enter"); await ready(page);
        await expect(field(page, "Secondary source")).toHaveValue("const sample = 2; // TODO");
        expect((await snapshot(page)).history.undoDepth).toBe(proposed.history.undoDepth + 1);
        await field(page, "Secondary source").press("Control+z"); expect(await source(page)).toBe("const saMORE = 2; // TODO");
        await field(page, "Secondary source").press("Control+Shift+z"); expect(await source(page)).toBe("const sample = 2; // TODO");
        await button(page, "Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await field(page).press("Control+End"); await field(page).pressSequentially(" correction"); await ready(page);
        const corrected = await snapshot(page);
        await page.evaluate(() => window.hostFixture.finishSave()); await expect.poll(async () => (await snapshot(page)).review.acknowledgements.length).toBe(1);
        await button(page, "Retry acknowledgement").click(); await expect.poll(async () => (await snapshot(page)).review.acknowledgements[0]?.status).toBe("failed");
        await button(page, "Retry acknowledgement").click(); await expect.poll(async () => (await snapshot(page)).review.proposal).toBeNull();
        expect(await source(page)).toBe("const sample = 2; // TODO correction"); expect((await snapshot(page)).source.dirty).toBe(true);
        expect((await snapshot(page)).history).toEqual(corrected.history);
        await button(page, "Request proposal").click(); const next = (await snapshot(page)).requestInput!;
        expect(next.sourceLength).toBe("const sample = 2; // TODO correction".length);
        expect(next.sourceRevision).toBe(corrected.source.revision); expect(next.sourceRevision).toBeGreaterThan(captured!.sourceRevision);
        await page.evaluate(() => window.hostFixture.dispose()); const final = await snapshot(page);
        expect(final.diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 }); expect(final.hostSubscriptions).toBe(0);
        expect(final.bindings.lsp).toMatchObject({ scopes: 0, documents: 0, created: 1, terminated: 1 });
    });
});
