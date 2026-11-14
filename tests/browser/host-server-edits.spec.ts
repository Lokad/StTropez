import { test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { reviewHeader, reviewFooter } from "../../examples/probes/project-commands.ts";
const snapshot = (p: Page) => p.evaluate(() => window.hostFixture.snapshot());
const input = (p: Page, name = "Primary source") => p.getByRole("textbox", { name, exact: true });
const button = (p: Page, name: string) => p.getByRole("button", { name, exact: true });
async function ready(p: Page): Promise<void> {
    await expect.poll(() => p.evaluate(() => { const s = window.hostFixture.snapshot(), c = s.bindings.comparison;
        return !s.bindings.project.pending && !s.bindings.navigation.pending && s.bindings.views.every(v => !v.metrics!.pendingCommand && !v.metrics!.pendingCaret && !v.metrics!.viewport.pending)
            && (!c || c.status === "ready" && !c.workingViewport.pending && !c.referenceViewport?.pending);
    }), { timeout: 30000 }).toBe(true);
}
async function exact(p: Page, text: string): Promise<void> {
    expect(await p.evaluate(text => { const f = window.hostFixture; if (f.snapshot().source.length !== text.length) return false;
        for (let from = 0; from < text.length; from += 32768) if (f.range(from, Math.min(from + 32768, text.length)) !== text.slice(from, from + 32768)) return false; return true;
    }, text)).toBe(true);
}
async function setup(p: Page, host: string, text: string): Promise<void> {
     await p.goto(`/hosts/${host}/?editor=candidate`);
    await p.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, text); await ready(p);
}
async function register(p: Page): Promise<void> { await input(p).focus(); await button(p, "Register provider review command").click(); await ready(p); expect((await snapshot(p)).bindings.project.registered).toBe(true); }
async function review(p: Page): Promise<void> { await button(p, "Request provider review edits").click(); await ready(p); }
async function dispose(p: Page): Promise<void> {
    await p.evaluate(() => window.hostFixture.dispose()); const s = await snapshot(p);
    expect(s.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(s.hostSubscriptions).toBe(0); expect(s.bindings.project).toMatchObject({ transport: null, sessions: 0, subscriptions: 0 });
    expect(s.bindings.project.worker.created).toBe(s.bindings.project.worker.terminated); await expect.poll(() => p.workers().length).toBe(0);
}
for (const host of ["plain", "react"]) {
    test(`${host} a batch affecting only an unmounted resource exposes captured reveal and participating undo without retargeting primary commands`, async ({ page: p }, info) => {
        const raw = "alpha", expected = reviewHeader + raw + reviewFooter; await setup(p, host, raw); await button(p, "Open source review").click(); await register(p); await review(p); await exact(p, expected);
        const baseline = (await snapshot(p)).bindings.comparison!.baseline; await button(p, "Add navigation companion").click(); const before = await snapshot(p); await review(p);
        const after = await snapshot(p), companion = after.bindings.navigation.companion!; expect(after.source.revision).toBe(before.source.revision); expect(after.bindings.views.every(v => v.documentId !== companion)).toBe(true);
        const changed = p.getByRole("list", { name: "Provider changed resources", exact: true }).getByRole("button"); await expect(changed).toHaveCount(1); await expect(changed.first()).toHaveText("Open provider changes in Navigation companion"); await changed.first().click(); await ready(p);
        expect((await snapshot(p)).bindings.views.find(v => v.id === "secondary")!.documentId).toBe(companion); await expect(input(p, "Secondary source")).toBeFocused(); expect(await p.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(reviewHeader + "const catalogue = 1;\r\ncatalogue;\r\n" + reviewFooter);
        if (info.project.name === "chromium") await p.screenshot({ path: `artifacts/server-edits-reveal-images/host-${host}-server-edits-reveal.png`, fullPage: true });
        await input(p, "Secondary source").press("Control+z"); await ready(p); await exact(p, expected); expect(await p.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe("const catalogue = 1;\r\ncatalogue;\r\n");
        await input(p, "Secondary source").press("Control+Shift+z"); await ready(p); await exact(p, expected); expect((await snapshot(p)).bindings.comparison!.baseline).toEqual(baseline); expect((await snapshot(p)).source.exports).toBe(0);
        expect(await p.evaluate(() => window.hostFixture.releaseNavigationCompanion())).toBe(false);
        await button(p, "Run captured inputs").click(); expect(await p.evaluate(text => window.hostFixture.runCapture(0)!.source === text, expected)).toBe(true); await p.evaluate(() => window.hostFixture.finishRun()); await button(p, "Save source").click(); await p.evaluate(() => window.hostFixture.finishSave()); await ready(p); expect((await snapshot(p)).source.dirty).toBe(false); await exact(p, expected); await dispose(p);
    });
    for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} actual server batch has atomic shared history, immutable review and primary Save/Run identity`, async ({ page: p }) => {
        test.setTimeout(120000); const raw = "\ufeffconst café = '😀';\r\n" + (large ? "const unchanged = 123;\r\n".repeat(100000) : "") + "café;", expected = reviewHeader + raw + reviewFooter;
        await setup(p, host, raw); await button(p, "Open source review").click(); await button(p, "Add navigation companion").click(); await ready(p);
        const baseline = (await snapshot(p)).bindings.comparison!.baseline, reference = await p.evaluate(() => { const f = window.hostFixture; return f.referenceRange(0, Math.min(32, f.snapshot().bindings.comparison!.baseline!.length)); });
        await input(p).focus(); const ranges = [{ anchor: 8, head: 2 }, { anchor: raw.length - 2, head: raw.length - 1 }];
        await p.evaluate(ranges => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, ranges, 1); }, ranges);
        const before = await snapshot(p); await register(p); const connected = (await snapshot(p)).bindings.project; expect(connected.worker).toMatchObject({ created: 1, opened: 2 }); expect(p.workers().length).toBeGreaterThan(0);
        await button(p, "Request provider workspace status").click(); await ready(p); await expect(p.getByLabel("Workspace provider status", { exact: true })).toContainText("2 synchronized working resources");
        expect((await snapshot(p)).bindings.project.worker.transferred).toBe(connected.worker.transferred);
        if (!large) {
            const id = (await snapshot(p)).bindings.navigation.companion!; await p.evaluate(id => window.hostFixture.setProjectTargetReadOnly(id, true), id);
            await review(p); await exact(p, raw); expect((await snapshot(p)).history.undoDepth).toBe(before.history.undoDepth); expect((await snapshot(p)).bindings.project.registered).toBe(true);
            expect(await p.evaluate(id => window.hostFixture.navigationDocument(id).text, id)).toBe("const catalogue = 1;\r\ncatalogue;\r\n"); await p.evaluate(id => window.hostFixture.setProjectTargetReadOnly(id, false), id);
        }
        await review(p); await exact(p, expected); let s = await snapshot(p); expect(s.history.undoDepth).toBe(before.history.undoDepth + 1); expect(s.bindings.project.applied).toBe(1);
        const companion = s.bindings.navigation.companion!; expect(await p.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(reviewHeader + "const catalogue = 1;\r\ncatalogue;\r\n" + reviewFooter);
        expect(s.bindings.views.find(v => v.id === "primary")!.selectionSet.ranges.map(r => ({ anchor: r.anchor, head: r.head }))).toEqual(ranges.map(r => ({ anchor: r.anchor + reviewHeader.length, head: r.head + reviewHeader.length })));
        expect(s.bindings.comparison!.baseline).toEqual(baseline); expect(await p.evaluate(() => { const f = window.hostFixture; return f.referenceRange(0, Math.min(32, f.snapshot().bindings.comparison!.baseline!.length)); })).toBe(reference); expect(s.source.exports).toBe(0); expect(s.bindings.views.every(v => v.metrics!.viewport.rows < 100)).toBe(true);
        await p.evaluate(() => { const f = window.hostFixture, s = f.snapshot(); f.selectSourceSet("primary", s.source.revision, [{ anchor: s.source.length, head: s.source.length }]); });
        await input(p).pressSequentially("H"); await ready(p); await exact(p, expected + "H");
        await input(p, "Secondary source").press("Control+z"); await ready(p); await exact(p, expected);
        await input(p, "Secondary source").press("Control+z"); await ready(p); await exact(p, raw); expect(await p.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe("const catalogue = 1;\r\ncatalogue;\r\n");
        await input(p, "Secondary source").press("Control+Shift+z"); await ready(p); await exact(p, expected);
        const depth = (await snapshot(p)).history.undoDepth; await review(p); expect((await snapshot(p)).history.undoDepth).toBe(depth);
        await button(p, "Unregister provider review command").click(); await ready(p); expect((await snapshot(p)).bindings.project.registered).toBe(false); await expect(button(p, "Request provider review edits")).toBeDisabled();
        await button(p, "Run captured inputs").click(); expect(await p.evaluate(text => window.hostFixture.runCapture(0)!.source === text, expected)).toBe(true); await p.evaluate(() => window.hostFixture.finishRun());
        await button(p, "Save source").click(); await p.evaluate(() => window.hostFixture.finishSave()); await ready(p); expect((await snapshot(p)).source.dirty).toBe(false);
        const epoch = (await snapshot(p)).bindings.project.transport!.epoch; await button(p, "Disconnect workspace provider").click(); await button(p, "Reconnect workspace provider").click(); await register(p);
        s = await snapshot(p); expect(s.bindings.project.worker.created).toBe(2); expect(s.bindings.project.transport!.epoch).toBeGreaterThan(epoch); expect(s.bindings.comparison!.baseline).toEqual(baseline); await dispose(p);
    });
    test(`${host} malformed late server edits never partially apply and lost acknowledgement retains one undoable command`, async ({ page: p }) => {
        const raw = "alpha\r\n😀 beta", expected = reviewHeader + raw + reviewFooter; await setup(p, host, raw); await button(p, "Add navigation companion").click(); await register(p);
        const before = await snapshot(p); await p.evaluate(() => window.hostFixture.faultProjectNext("malformed")); await review(p); await exact(p, raw);
        let s = await snapshot(p); expect(s.history.undoDepth).toBe(before.history.undoDepth); expect(s.bindings.project).toMatchObject({ failed: 1, applied: 0, registered: false, transport: null });
        expect(await p.evaluate(id => window.hostFixture.navigationDocument(id).text, s.bindings.navigation.companion!)).toBe("const catalogue = 1;\r\ncatalogue;\r\n");
        await button(p, "Reconnect workspace provider").click(); await register(p); await p.evaluate(() => window.hostFixture.faultProjectNext("failure")); await review(p); await exact(p, raw); expect((await snapshot(p)).bindings.project.applied).toBe(0);
        await button(p, "Reconnect workspace provider").click(); await register(p); await p.evaluate(() => window.hostFixture.faultProjectNext("ack")); await review(p); await exact(p, expected);
        s = await snapshot(p); expect(s.bindings.project).toMatchObject({ applied: 1, registered: false, transport: null }); expect(s.history.undoDepth).toBe(before.history.undoDepth + 1); await expect(p.getByLabel("Workspace provider status", { exact: true })).toContainText("acknowledgement failed after application");
        await button(p, "Reconnect workspace provider").click(); await register(p); await review(p); expect((await snapshot(p)).history.undoDepth).toBe(before.history.undoDepth + 1);
        expect(await p.evaluate(() => window.hostFixture.faultIdleProject())).toBe(true); await expect.poll(async () => (await snapshot(p)).bindings.project.registered).toBe(false); expect((await snapshot(p)).bindings.project.transport).toBeNull(); await expect(button(p, "Request provider review edits")).toBeDisabled(); await exact(p, expected);
        await button(p, "Reconnect workspace provider").click(); await register(p);
        await input(p, "Secondary source").press("Control+z"); await ready(p); await exact(p, raw); expect((await snapshot(p)).source.exports).toBe(0); await dispose(p);
    });
    test(`${host} captured server commands expire on typing, authority and remount while table input and host focus stay protected`, async ({ page: p }) => {
        test.setTimeout(120000); const raw = "alpha\r\nbeta"; await setup(p, host, raw); let current = raw;
        for (const mode of ["typing", "authority", "lease", "remount"] as const) {
            await register(p); await p.evaluate(() => window.hostFixture.setProjectDelay(1000)); await button(p, "Request provider review edits").click(); expect((await snapshot(p)).bindings.project.pending).toBe(true);
            if (mode === "typing") { await input(p).press("Control+End"); await input(p).pressSequentially("X"); current += "X"; }
            else if (mode === "authority") await p.evaluate(() => { window.hostFixture.setSourceReadOnly(true); window.hostFixture.setSourceReadOnly(false); });
            else if (mode === "lease") await p.evaluate(() => window.hostFixture.cycleSourceEditLease());
            else await p.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
            await ready(p); await exact(p, current); expect((await snapshot(p)).bindings.project).toMatchObject({ pending: false, registered: false, applied: 0, transport: null });
        }
        await register(p); await button(p, "Request provider review edits").click(); const moved = [{ anchor: 4, head: 2 }, { anchor: 8, head: 8 }];
        await p.evaluate(ranges => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, ranges, 1); }, moved);
        const form = p.getByRole("textbox", { name: "Configuration path", exact: true }); await form.fill("during-provider.csv"); await ready(p); await expect(form).toBeFocused(); await exact(p, reviewHeader + current + reviewFooter);
        expect((await snapshot(p)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges.map(r => ({ anchor: r.anchor, head: r.head }))).toEqual(moved.map(r => ({ anchor: r.anchor + reviewHeader.length, head: r.head + reviewHeader.length })));
        await p.evaluate(() => window.hostFixture.setProjectDelay(0)); const base = "left right", at = 5, cell = "B".repeat(400000), csv = '"A","' + cell + '"';
        await p.evaluate(({base,at}) => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: base }]); f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: at, head: at }]); }, {base,at});
        await p.getByRole("checkbox", { name: "Paste tables as CSV", exact: true }).check(); await input(p).focus(); await ready(p);
        const guard = await input(p).evaluate((node, text) => { const f = window.hostFixture, before = f.snapshot().bindings.project.requested, event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }); event.clipboardData!.setData("text/plain", text); node.dispatchEvent(event);
            const pending = f.snapshot().bindings.tablePaste.pending; [...document.querySelectorAll("button")].find(b => b.textContent === "Request provider review edits")!.click(); return { pending, captures: f.snapshot().bindings.project.requested - before }; }, "A\t" + cell);
        expect(guard).toEqual({ pending: true, captures: 0 }); await expect.poll(async () => (await snapshot(p)).bindings.tablePaste.pending).toBe(false); await ready(p); await exact(p, base.slice(0, at) + csv + base.slice(at)); expect((await snapshot(p)).source.exports).toBe(0); await dispose(p);
    });
}
