import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { hostTextEquals } from "../../scripts/host-scene.mjs";

type HostState = ReturnType<Window["hostFixture"]["snapshot"]>;
type CompositionIndentTrace = { trustedKey: boolean; afterKey: HostState; afterStart?: HostState; events: Readonly<{ type: string; trusted: boolean; revision: number }>[] };
declare global { interface Window { compositionIndentTrace?: CompositionIndentTrace } }
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const primary = (page: Page) => page.getByRole("textbox", { name: "Primary source", exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const selections = (s: HostState) => s.bindings.views.map(v => ({ id: v.id, selection: v.selection }));
async function exact(page: Page, text: string): Promise<void> { expect(await hostTextEquals(page, text)).toBe(true); }

async function drainPlanningTurns(page: Page, lines: number): Promise<void> {
    // Let queued continuations run, including a stale continuation after cancelled composition.
    await page.evaluate(turns => new Promise<void>(resolve => {
        const step = () => { if (--turns) setTimeout(step, 0); else resolve(); }; setTimeout(step, 0);
    }), Math.ceil(lines / 256) + 16);
}

test.afterEach(async ({ page }, info) => {
    if (page.isClosed()) return;
    const trace = await page.evaluate(() => window.compositionIndentTrace);
    if (trace) await info.attach("composition-indent-events", { contentType: "application/json", body: JSON.stringify(trace, null, 2) });
    if (info.status !== info.expectedStatus) {
        await info.attach("composition-indent-failed-state", { contentType: "application/json", body: JSON.stringify(await snapshot(page), null, 2) });
        const text = await page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); });
        await info.attach("composition-indent-failed-source", { contentType: "text/plain", body: text });
    }
});

// Discovery alone charges at least five units per row. 8192 rows exceed the
// 64-call × 256-unit synchronous budget, so composition starts during pending work.
for (const host of ["plain", "react"] as const) for (const lines of [8192, 100000])
    for (const key of ["Tab", "Shift+Tab"]) for (const outcome of ["ordinary", "commit", "cancel"] as const)
        test(`${host} ${lines} ${key} ${outcome} preserves staged composition and captured save`, async ({ page }) => {

            const original = Array(lines).fill("    const café = 1;").join("\r\n");
            const changed = key === "Tab" ? "    " + original.replaceAll("\r\n", "\r\n    ") : original.replace(/^ {4}/gm, "");
            await page.goto(`/hosts/${host}/?editor=candidate`); await expect(primary(page)).toBeVisible();
            await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot();
                f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]);
            }, original); await ready(page);
            await button(page, "Save source").click(); await button(page, "Finish save").click();
            await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1");
            await button(page, "Open source review").click();
            await button(page, "Capture reference refresh").click(); await button(page, "Finish reference refresh").click(); await ready(page);
            const reference = (await snapshot(page)).bindings.comparison!;
            expect(reference.referenceIsWorkingBuffer).toBe(false); expect(reference.hunks).toBe(0);
            await button(page, "Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
            await primary(page).focus(); await page.keyboard.press("Control+a"); await ready(page); const before = await snapshot(page);

            await primary(page).evaluate((node, outcome) => {
                const input = node as HTMLTextAreaElement, events: CompositionIndentTrace["events"] = [];
                for (const type of ["keydown", "compositionstart", "input", "compositionend"])
                    input.addEventListener(type, event => events.push({ type, trusted: event.isTrusted, revision: window.hostFixture.snapshot().source.revision }));
                const afterKey = (event: KeyboardEvent) => {
                    if (event.key !== "Tab") return; input.removeEventListener("keydown", afterKey);
                    const trace: CompositionIndentTrace = { trustedKey: event.isTrusted, afterKey: window.hostFixture.snapshot(), events };
                    window.compositionIndentTrace = trace;
                    if (outcome === "ordinary") return;
                    // Deliberately synthetic composition: checks staged-input invariants, never native IME qualification.
                    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
                    trace.afterStart = window.hostFixture.snapshot();
                    if (outcome === "commit") {
                        input.setRangeText("東京", input.selectionStart, input.selectionEnd, "end");
                        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "東京", isComposing: true }));
                    } else input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
                };
                input.addEventListener("keydown", afterKey);
            }, outcome);
            await page.keyboard.press(key); await drainPlanningTurns(page, lines);
            const trace = await page.evaluate(() => window.compositionIndentTrace!); expect(trace.trustedKey).toBe(true);
            expect(trace.afterKey.source.revision).toBe(before.source.revision);
            const during = await snapshot(page);
            expect(during.pendingSaves).toEqual(before.pendingSaves);
            if (outcome === "ordinary") {
                await ready(page); await exact(page, changed);
                expect(during.source.exports).toBe(0); // Export counters belong to this new immutable buffer.
                expect(during.source.revision).toBe(before.source.revision + 1);
                expect(during.history.undoDepth).toBe(before.history.undoDepth + 1);
            } else {
                expect(trace.afterStart!.source.revision).toBe(before.source.revision);
                expect(during.source.revision).toBe(before.source.revision); expect(during.history).toEqual(before.history);
                expect(during.source.exports).toBe(before.source.exports); // The original buffer has not changed.
                expect(selections(during)).toEqual(selections(before)); await exact(page, original);
                expect(during.bindings.views.find(v => v.id === "primary")!.metrics!.composing).toBe(outcome === "commit");
                if (outcome === "commit") {
                    await primary(page).evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "東京" })));
                    await ready(page); await exact(page, "東京"); const committed = await snapshot(page);
                    expect(committed.source.revision).toBe(before.source.revision + 1);
                    expect(committed.history.undoDepth).toBe(before.history.undoDepth + 1);
                    expect(committed.bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: 2, head: 2 });
                } else {
                    // Cancellation leaves no revision change; a stale timer must not revive after composition ends.
                    await page.keyboard.press(key); await drainPlanningTurns(page, lines); await ready(page); await exact(page, changed);
                    expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
                }
            }
            await ready(page); const edited = await snapshot(page);
            expect(edited.bindings.comparison!.baseline!.version).toBe(reference.baseline!.version);
            expect(edited.source.exports).toBe(0); expect(edited.inputRecovery).toEqual(before.inputRecovery);
            await button(page, "Finish save").click(); await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v2");
            expect((await snapshot(page)).source.dirty).toBe(true); await exact(page, outcome === "commit" ? "東京" : changed);
            const peer = page.getByRole("textbox", { name: "Secondary source", exact: true }); await peer.focus(); await page.keyboard.press("Control+z");
            await ready(page); await exact(page, original); expect((await snapshot(page)).source.dirty).toBe(false);
            await page.keyboard.press("Control+Shift+z"); await ready(page); await exact(page, outcome === "commit" ? "東京" : changed);
            expect((await snapshot(page)).source.dirty).toBe(true); expect((await snapshot(page)).source.exports).toBe(0);
            await page.evaluate(() => window.hostFixture.dispose()); const disposed = await snapshot(page);
            expect(disposed.diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 }); expect(disposed.hostSubscriptions).toBe(0);
        });
