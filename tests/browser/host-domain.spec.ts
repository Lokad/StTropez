import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { hostTextEquals } from "../../scripts/host-scene.mjs";
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const status = (page: Page) => page.getByLabel("Domain command status", { exact: true });
async function waitForDomain(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (!s.bindings.domain.pending); });
}
async function exact(page: Page, text: string): Promise<void> { expect(await hostTextEquals(page, text)).toBe(true); }
async function setup(page: Page, host: string, text: string): Promise<void> {
     await page.goto(`/hosts/${host}/?editor=candidate`);
    await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, text); await waitForDomain(page); await input(page).focus();
}
async function dispose(page: Page): Promise<void> {
    await page.evaluate(() => window.hostFixture.dispose()); const s = await snapshot(page);
    expect(s.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(s.hostSubscriptions).toBe(0);
    expect(s.bindings.domain).toMatchObject({ sessions: [], pending: false, subscriptions: 0 }); await expect.poll(() => page.workers().length).toBe(0);
}
const region = "// #region root <b>東京 😀</b>\r\nconst one\r\n// #region child Child\r\nconst two\r\n// #endregion child\r\n// #endregion root\r\n";
for (const host of ["plain", "react"]) {
    for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} 1000 indexed annotations stay bounded with inactive documents and typing`, async ({ page }) => {
        test.setTimeout(120000);
        const line = "row Δ😀 12345678901234\r\n", starts: number[] = [], bodies: number[] = []; let text = "";
        for (let index = 0; index < 1000; index++) {
            starts.push(text.length); text += `// #region r${index} Note ${index}\r\n`; bodies.push(text.length);
            text += line.repeat(large ? 98 : 1) + `// #endregion r${index}\r\n`;
        }
        text += "tail"; expect(text.length).toBe(large ? 2397674 : 69674);
        await setup(page, host, text); const initial = await snapshot(page);
        await page.evaluate(() => window.hostFixture.seedInactiveDocuments()); await waitForDomain(page);
        const seeded = await snapshot(page), inactive = await page.evaluate(() => window.hostFixture.inactiveDocuments());
        expect(inactive).toHaveLength(100); expect(inactive.every(v => v.revision === 0 && !v.dirty && v.current && v.exports === 0)).toBe(true);
        expect(seeded.diagnostics.documents).toBe(initial.diagnostics.documents + 100); expect(seeded.diagnostics.tabs).toBe(initial.diagnostics.tabs + 100);
        expect(seeded.bindings.views.map(v => v.viewId)).toEqual(initial.bindings.views.map(v => v.viewId)); expect(seeded.bindings.activeViews).toBe(2);
        await button(page, "Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await page.evaluate(() => window.hostFixture.finishSave()); await expect.poll(async () => (await snapshot(page)).source.dirty).toBe(false);
        await input(page).focus(); await button(page, "Discover domain regions").click(); await waitForDomain(page);
        expect((await snapshot(page)).bindings.domain.sessions.find(v => v.id === "primary")).toMatchObject({ annotations: 1000, folds: 1000 });
        const notes = page.getByRole("list", { name: "Domain annotations", exact: true }); await expect(notes.getByRole("button")).toHaveCount(64);
        const primary = page.locator(".st-editor").filter({ has: input(page) });
        for (const index of [0, 500, 999]) {
            await page.evaluate(at => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: at, head: at }]); }, starts[index]! + 3);
            await input(page).focus(); await input(page).press("ArrowRight"); await waitForDomain(page);
            expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection.head).toBe(starts[index]! + 4);
            await expect(primary.locator(".st-domain-note").filter({ hasText: `Note ${index}` })).toHaveCount(1);
            expect(await primary.locator(".st-domain-note").count()).toBeLessThan(100);
        }
        await input(page).press("ArrowDown"); await input(page).press("End"); await waitForDomain(page);
        const at = bodies[999]! + line.length - 2, before = await snapshot(page);
        expect(before.bindings.views.find(v => v.id === "primary")!.selection.head).toBe(at);
        await input(page).press("Control+s"); await button(page, "Run captured inputs").click();
        await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await expect.poll(async () => (await snapshot(page)).pendingRuns.length).toBe(1);
        const captured = await snapshot(page); expect(captured.pendingSaves[0]!.revision).toBe(before.source.revision);
        expect(captured.pendingRuns[0]).toMatchObject({ sourceId: before.source.id, sourceRevision: before.source.revision, sourceLength: text.length });
        expect((await snapshot(page)).bindings.domain.sessions.find(v => v.id === "primary")!.annotations).toBe(1000);
        await input(page).focus(); await input(page).pressSequentially("q"); await waitForDomain(page);
        const edited = text.slice(0, at) + "q" + text.slice(at); await exact(page, edited);
        expect((await snapshot(page)).bindings.domain.sessions.find(v => v.id === "primary")!.annotations).toBe(0); await expect(notes.getByRole("button")).toHaveCount(0);
        await expect.poll(async () => (await snapshot(page)).activity.background).toBeGreaterThan(before.activity.background);
        expect(await page.evaluate(() => window.hostFixture.inactiveDocuments())).toEqual(inactive);
        await page.evaluate(() => { window.hostFixture.finishSave(); window.hostFixture.finishRun(); });
        await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0); expect((await snapshot(page)).source.dirty).toBe(true);
        await input(page, "Secondary source").press("Control+z"); await waitForDomain(page); await exact(page, text); expect((await snapshot(page)).source.dirty).toBe(false);
        await input(page, "Secondary source").press("Control+Shift+z"); await waitForDomain(page); await exact(page, edited);
        await input(page).focus(); await button(page, "Discover domain regions").click(); await waitForDomain(page);
        expect((await snapshot(page)).bindings.domain.sessions.find(v => v.id === "primary")!.annotations).toBe(1000); await expect(notes.getByRole("button")).toHaveCount(64);
        const retained = await snapshot(page); await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await waitForDomain(page);
        const remounted = await snapshot(page); expect(remounted.history).toEqual(retained.history); expect(remounted.source.exports).toBe(0);
        expect(remounted.bindings.views.every(v => v.metrics!.inputUnits <= 2600 && v.metrics!.viewport.rows < 100)).toBe(true);
        expect(await page.evaluate(() => window.hostFixture.inactiveDocuments())).toEqual(inactive);
        await dispose(page); const stopped = await snapshot(page); expect(await page.evaluate(() => window.hostFixture.inactiveDocuments())).toEqual([]);
        expect(stopped.diagnostics.documents).toBe(initial.diagnostics.documents); expect(stopped.diagnostics.tabs).toBe(initial.diagnostics.tabs);
    });
    for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} actual domain discovery preserves manual folds, independent views and remount`, async ({ page }) => {
        test.setTimeout(120000); const text = "manual\r\nbody\r\n" + region + (large ? "const unchanged = 123;\r\n".repeat(100000) : "") + "tail";
        await setup(page, host, text); await button(page, "Open source review").click(); await waitForDomain(page); await input(page).focus();
        await page.evaluate(to => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: to }]); }, text.indexOf("// #region"));
        await button(page, "Fold selected lines").click(); await waitForDomain(page); const before = await snapshot(page);
        // Analysis is resource/fold-scoped; selection movement during its request must remain usable.
        expect(await button(page, "Discover domain regions").evaluate((node, head) => {
            (node as HTMLButtonElement).click(); const f = window.hostFixture, state = f.snapshot();
            f.selectSourceSet("primary", state.source.revision, [{ anchor: head, head }]); return state.bindings.domain.pending;
        }, text.length - 1)).toBe(true);
        await expect(status(page)).toContainText("Discovered 2 domain regions"); await waitForDomain(page);
        let s = await snapshot(page); expect(s.source.revision).toBe(before.source.revision); expect(s.history).toEqual(before.history);
        expect(s.bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: text.length - 1, head: text.length - 1 });
        expect(s.bindings.domain.provider).toMatchObject({ requested: 1, completed: 1, work: text.length });
        expect(s.bindings.domain.sessions.find(v => v.id === "primary")).toMatchObject({ annotations: 2, folds: 2 });
        expect(s.bindings.views.find(v => v.id === "secondary")!.metrics!.viewport.collapsedFolds).toBe(0); expect(s.bindings.comparison!.workingViewport.collapsedFolds).toBe(0);
        const notes = page.getByRole("list", { name: "Domain annotations", exact: true }); await expect(notes.getByRole("button")).toHaveText(["<b>東京 😀</b>", "Child"]); await expect(notes.locator("b")).toHaveCount(0);
        await notes.getByRole("button", { name: "Child", exact: true }).evaluate(node => { node.dataset.retained = "domain-note"; });
        await button(page, "Collapse domain regions").click(); await waitForDomain(page); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.collapsedFolds).toBe(3);
        await expect(notes.getByRole("button", { name: "Child", exact: true })).toHaveAttribute("data-retained", "domain-note");
        await button(page, "Discover domain regions").click(); await waitForDomain(page); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.collapsedFolds).toBe(3);
        await notes.getByRole("button", { name: "Child", exact: true }).click(); await waitForDomain(page);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: text.indexOf("// #region child"), head: text.indexOf("// #region child") + "// #region child Child".length });
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.collapsedFolds).toBe(2);
        expect(await page.evaluate(() => { const f = window.hostFixture, old = document.querySelector<HTMLButtonElement>('ul[aria-label="Domain annotations"] button'); f.unmount(); f.mount();
            const before = f.snapshot().bindings.views.find(v => v.id === "primary")!.selectionSet; old!.click(); return JSON.stringify(before) === JSON.stringify(f.snapshot().bindings.views.find(v => v.id === "primary")!.selectionSet); })).toBe(true);
        await input(page).focus(); await waitForDomain(page);
        await expect(page.getByRole("list", { name: "Domain annotations", exact: true }).getByRole("button")).toHaveCount(2);
        await input(page).pressSequentially("X"); await waitForDomain(page); await expect(page.getByRole("list", { name: "Domain annotations", exact: true }).getByRole("button")).toHaveCount(0);
        await input(page, "Secondary source").press("Control+z"); await waitForDomain(page); await exact(page, text); expect((await snapshot(page)).source.exports).toBe(0); await dispose(page);
    });
    test(`${host} captured comparison import is one shared undo step and preserves later Save/Run and reference identity`, async ({ page }) => {
        const text = "\ufeff" + region + "tail"; await setup(page, host, text); await button(page, "Open source review").click(); await waitForDomain(page);
        const working = input(page, "Comparison working source"); await working.focus();
        await page.evaluate(length => { const f = window.hostFixture; f.selectSourceSet("comparison", f.snapshot().source.revision, [{ anchor: 8, head: 2 }, { anchor: length, head: length }], 1); f.setDomainDelay(200); }, text.length);
        const before = await snapshot(page), selections = before.bindings.comparison!.selectionSet, baseline = before.bindings.comparison!.baseline;
        await button(page, "Insert catalogue import").click(); await input(page).focus(); await expect(status(page)).toContainText("Inserted the captured import in comparison"); await waitForDomain(page);
        const insert = 'import "catalogue";\r\n', imported = "\ufeff" + insert + text.slice(1); await exact(page, imported);
        let s = await snapshot(page); expect(s.history.undoDepth).toBe(before.history.undoDepth + 1); expect(s.bindings.comparison!.baseline).toEqual(baseline);
        expect(s.bindings.comparison!.selectionSet.ranges).toEqual(selections.ranges.map(r => ({ ...r, anchor: r.anchor + insert.length, head: r.head + insert.length })));
        await input(page).press("Control+z"); await waitForDomain(page); await exact(page, text); expect((await snapshot(page)).bindings.comparison!.selectionSet).toEqual(selections);
        await input(page, "Secondary source").press("Control+Shift+z"); await waitForDomain(page); await exact(page, imported);
        await working.focus(); const history = (await snapshot(page)).history; await button(page, "Insert catalogue import").click(); await expect(status(page)).toContainText("already present"); await waitForDomain(page); expect((await snapshot(page)).history).toEqual(history);
        // Complete the multiple-set command, then make a separate human correction in a different view.
        await input(page).press("Control+End"); await input(page).pressSequentially(" later"); await waitForDomain(page); await exact(page, imported + " later");
        await input(page).press("Control+s"); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await input(page).pressSequentially(" newer"); await waitForDomain(page); await page.evaluate(() => window.hostFixture.finishSave()); await waitForDomain(page);
        await input(page).press("Control+z"); await waitForDomain(page); await exact(page, imported + " later"); expect((await snapshot(page)).source.dirty).toBe(false);
        await button(page, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(page)).pendingRuns.length).toBe(1);
        expect(await page.evaluate(text => window.hostFixture.runCapture(0)!.source === text, imported + " later")).toBe(true); await page.evaluate(() => window.hostFixture.finishRun());
        expect((await snapshot(page)).bindings.comparison!.baseline).toEqual(baseline); await dispose(page);
    });
    test(`${host} domain results reject stale revision, authority, fold, selection, composition and remount captures`, async ({ page }) => {
        await setup(page, host, region + "tail"); await page.evaluate(() => window.hostFixture.setDomainDelay(1000));
        await input(page, "Secondary source").evaluate(node => node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
        await button(page, "Discover domain regions").click(); await expect(status(page)).toContainText("Finish pending typing or composition"); expect((await snapshot(page)).bindings.domain.requested).toBe(0);
        await input(page, "Secondary source").evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
        const cases = ["revision", "permission", "lease", "fold", "selection", "composition", "remount", "replacement"] as const;
        for (const reason of cases) {
            await input(page).focus(); const before = await snapshot(page); await button(page, reason === "selection" ? "Insert catalogue import" : "Discover domain regions").click();
            expect((await snapshot(page)).bindings.domain.pending).toBe(true);
            if (reason === "revision") await page.evaluate(() => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: "x" }]); });
            if (reason === "permission") await page.evaluate(() => { window.hostFixture.setSourceReadOnly(true); window.hostFixture.setSourceReadOnly(false); });
            if (reason === "lease") await page.evaluate(() => window.hostFixture.cycleSourceEditLease());
            if (reason === "fold") { await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: 45 }]); }); await button(page, "Fold selected lines").click(); }
            if (reason === "selection") await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 1, head: 1 }]); });
            if (reason === "composition") { await input(page, "Secondary source").evaluate(node => node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))); await input(page, "Secondary source").evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))); }
            if (reason === "remount") await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
            if (reason === "replacement") await page.evaluate(() => window.hostFixture.openTransferTarget("unrelated target"));
            await expect.poll(async () => (await snapshot(page)).bindings.domain.pending).toBe(false);
            const after = await snapshot(page); expect(after.bindings.domain.applied).toBe(before.bindings.domain.applied); expect(after.bindings.domain.provider.cancelled).toBeGreaterThan(before.bindings.domain.provider.cancelled);
        }
        expect(await page.evaluate(() => window.hostFixture.transferSnapshot().text)).toBe("unrelated target");
        await input(page).focus(); await page.evaluate(() => window.hostFixture.setSourceReadOnly(true)); await expect(button(page, "Insert catalogue import")).toBeDisabled();
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(false)); await expect(button(page, "Insert catalogue import")).toBeEnabled();
        await dispose(page);
    });
    test(`${host} malformed, failed, late and conflicting domain replies preserve prior results and allow explicit retry`, async ({ page }) => {
        await setup(page, host, region + "tail"); await button(page, "Discover domain regions").click(); await waitForDomain(page); const baseline = await snapshot(page);
        for (const fault of ["malformed", "failure"] as const) {
            await page.evaluate(fault => window.hostFixture.faultDomainNext(fault), fault); await button(page, "Discover domain regions").click(); await waitForDomain(page);
            expect((await snapshot(page)).bindings.domain.applied).toBe(baseline.bindings.domain.applied); await expect(page.getByRole("list", { name: "Domain annotations", exact: true }).getByRole("button")).toHaveCount(2);
            expect((await snapshot(page)).source.revision).toBe(baseline.source.revision); await expect(status(page)).not.toContainText("Discovered");
        }
        await page.evaluate(() => { window.hostFixture.setDomainDelay(200); window.hostFixture.faultDomainNext("late"); }); await button(page, "Discover domain regions").click();
        await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await input(page).focus();
        await expect.poll(async () => (await snapshot(page)).bindings.domain.stale).toBe(1); expect((await snapshot(page)).bindings.domain.applied).toBe(baseline.bindings.domain.applied);
        await page.evaluate(() => window.hostFixture.setDomainDelay(0)); await button(page, "Discover domain regions").click(); await expect(status(page)).toContainText("Discovered 2"); await waitForDomain(page);
        // A manual fold on an existing domain header takes ownership; a refresh rejects the duplicate header atomically.
        await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: 40 }]); }); await button(page, "Fold selected lines").click(); await waitForDomain(page);
        const prior = await snapshot(page); await button(page, "Discover domain regions").click(); await waitForDomain(page); await expect(status(page)).toContainText("one identity");
        expect((await snapshot(page)).bindings.domain.applied).toBe(prior.bindings.domain.applied); expect((await snapshot(page)).source.revision).toBe(prior.source.revision);
        await dispose(page);
    });
}
