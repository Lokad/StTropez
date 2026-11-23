import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { hostTextEquals } from "../../scripts/host-scene.mjs";

type HostState = ReturnType<Window["hostFixture"]["snapshot"]>;
type CompositionFindTrace = { commandTrusted?: boolean; afterStart?: HostState; events: { type: string; trusted: boolean; revision: number }[] };
declare global { interface Window { compositionFindTrace?: CompositionFindTrace } }
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const primary = (page: Page) => page.getByRole("textbox", { name: "Primary source", exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const selections = (s: HostState) => s.bindings.views.map(v => ({ id: v.id, selection: v.selection }));
async function exact(page: Page, text: string): Promise<void> { expect(await hostTextEquals(page, text)).toBe(true); }

async function drainPlan(page: Page): Promise<void> {
    // Give the original 1024-match batches enough independent turns, even after immediate composition cancellation.
    // These imposed turns and whole-test durations are not interaction-latency measurements.
    await page.evaluate(turns => new Promise<void>(resolve => {
        const step = () => { if (--turns) setTimeout(step, 0); else resolve(); }; setTimeout(step, 0);
    }), Math.ceil(100000 / 1024) + 16);
}
test.afterEach(async ({ page }, info) => {
    if (page.isClosed()) return;
    await info.attach("find-composition-events", { contentType: "application/json", body: JSON.stringify(await page.evaluate(() => window.compositionFindTrace ?? {}), null, 2) });
    if (info.status !== info.expectedStatus) {
        await info.attach("find-composition-failed-state", { contentType: "application/json", body: JSON.stringify(await snapshot(page), null, 2) });
        await info.attach("find-composition-failed-source", { contentType: "text/plain", body: await page.evaluate(() => {
            const f = window.hostFixture; return f.range(0, f.snapshot().source.length);
        }) });
    }
});

for (const [host, arm] of [["plain", "ordinary"], ["react", "commit"], ["plain", "cancel"], ["react", "active"]] as const)
    test(`${host} 100000 replace all composition ${arm} preserves staged input and captured work`, async ({ page }) => {

        const original = Array(100000).fill("const sample = 1234567;").join("\r\n"), changed = original.replaceAll("sample", "changed");
        await page.goto(`/hosts/${host}/?editor=candidate`); await expect(primary(page)).toBeVisible();
        await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot();
            f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]);
        }, original); await ready(page);
        for (const name of ["Save source", "Finish save", "Open source review", "Capture reference refresh", "Finish reference refresh"])
            await button(page, name).click();
        await ready(page); const reference = (await snapshot(page)).bindings.comparison!;
        expect(reference.referenceIsWorkingBuffer).toBe(false); expect(reference.hunks).toBe(0);
        await button(page, "Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await primary(page).focus(); await page.keyboard.press("Control+Home"); await ready(page); const before = await snapshot(page);
        await primary(page).evaluate(node => {
            const trace: CompositionFindTrace = { events: [] }; window.compositionFindTrace = trace;
            for (const type of ["keydown", "compositionstart", "compositionend", "input"])
                node.addEventListener(type, event => trace.events.push({ type, trusted: event.isTrusted, revision: window.hostFixture.snapshot().source.revision }));
        });
        await page.keyboard.press("Control+f"); await page.getByRole("textbox", { name: "Find source", exact: true }).fill("sample");
        const status = page.getByLabel("Find status", { exact: true }); await expect(status).toHaveText("100000 matches · ready");
        await page.getByRole("textbox", { name: "Replacement", exact: true }).fill("changed"); const replace = button(page, "Replace all");
        await replace.evaluate(node => node.addEventListener("click", event => { window.compositionFindTrace!.commandTrusted = event.isTrusted; }, { capture: true, once: true }));
        if (arm !== "active") { await replace.click(); await expect(status).toHaveText("100000 matches · replacing"); }
        if (arm !== "ordinary") {
            await primary(page).focus(); await primary(page).evaluate((node, arm) => {
                const input = node as HTMLTextAreaElement;
                // Stage one character while replacement planning is pending.
                input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
                window.compositionFindTrace!.afterStart = window.hostFixture.snapshot();
                if (arm === "cancel") input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
                else { input.setRangeText("ê", input.selectionStart, input.selectionEnd, "end");
                    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "ê", isComposing: true })); }
            }, arm);
            // Dispatch the host command without moving focus away from the staged character.
            if (arm === "active") await replace.evaluate(node => (node as HTMLButtonElement).click());
        }
        await drainPlan(page); const during = await snapshot(page), trace = await page.evaluate(() => window.compositionFindTrace!);
        expect(trace.commandTrusted).toBe(arm !== "active");
        expect(trace.events.filter(e => e.type === "keydown").every(e => e.trusted)).toBe(true);
        expect(trace.events.filter(e => e.type.startsWith("composition")).every(e => !e.trusted)).toBe(true);
        let expected = changed;
        if (arm === "ordinary") { await ready(page); await exact(page, changed); }
        else {
            expect(trace.afterStart!.source.revision).toBe(before.source.revision);
            expect(during.source.revision).toBe(before.source.revision); expect(during.history).toEqual(before.history);
            expect(during.source.exports).toBe(before.source.exports); expect(selections(during)).toEqual(selections(before)); await exact(page, original);
            expect(during.inputRecovery).toEqual(before.inputRecovery);
            expect(during.bindings.views.find(v => v.id === "primary")!.metrics!.composing).toBe(arm !== "cancel");
            if (arm === "cancel") {
                // The old plan stays cancelled; a new explicit command can use the still-valid search index.
                await replace.click(); await expect(status).toHaveText("Replaced 100000 matches."); await ready(page); await exact(page, changed);
            } else {
                await expect(status).toHaveText(arm === "active" ? "Finish composition before replacing." : "Replacement cancelled for composition.");
                await primary(page).evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "ê" })));
                expected = "ê" + original; await ready(page); await exact(page, expected);
                expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: 1, head: 1 });
            }
        }
        await ready(page); const edited = await snapshot(page);
        expect(edited.source.revision).toBe(before.source.revision + 1); expect(edited.history.undoDepth).toBe(before.history.undoDepth + 1);
        expect(edited.source.exports).toBe(0); expect(edited.pendingSaves).toEqual(before.pendingSaves); expect(edited.inputRecovery).toEqual(before.inputRecovery);
        expect(edited.bindings.comparison!.baseline!.version).toBe(reference.baseline!.version);
        expect(await page.evaluate(text => window.hostFixture.referenceRange(0, text.length) === text, original)).toBe(true);
        await button(page, "Finish save").click(); expect((await snapshot(page)).source.serverVersion).toBe("v2");
        expect((await snapshot(page)).source.dirty).toBe(true); await exact(page, expected);
        await page.getByRole("textbox", { name: "Secondary source", exact: true }).focus(); await page.keyboard.press("Control+z");
        await ready(page); await exact(page, original); expect((await snapshot(page)).source.dirty).toBe(false);
        await page.keyboard.press("Control+Shift+z"); await ready(page); await exact(page, expected);
        expect((await snapshot(page)).source.dirty).toBe(true); expect((await snapshot(page)).source.exports).toBe(0);
        await page.evaluate(() => window.hostFixture.dispose()); const disposed = await snapshot(page);
        expect(disposed.diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 }); expect(disposed.hostSubscriptions).toBe(0);
    });
