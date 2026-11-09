import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
const snapshot = (p: Page) => p.evaluate(() => window.hostFixture.snapshot());
const input = (p: Page, name = "Primary source") => p.getByRole("textbox", { name, exact: true });
const button = (p: Page, name: string) => p.getByRole("button", { name, exact: true });
async function ready(p: Page): Promise<void> {
    await expect.poll(() => p.evaluate(() => { const s = window.hostFixture.snapshot(), c = s.bindings.comparison;
        return !s.bindings.actions.state.pending && s.bindings.views.every(v => !v.metrics!.pendingCommand && !v.metrics!.pendingInput && !v.metrics!.pendingCaret && !v.metrics!.viewport.pending)
            && (!c || c.status === "ready" && !c.input.pendingCommand && !c.input.pendingCaret && !c.workingViewport.pending && !c.referenceViewport?.pending);
    }), { timeout: 30000 }).toBe(true);
}
async function exact(p: Page, text: string): Promise<void> { expect(await p.evaluate(text => { const f = window.hostFixture; if (f.snapshot().source.length !== text.length) return false;
    for (let at = 0; at < text.length; at += 32768) if (f.range(at, Math.min(at + 32768, text.length)) !== text.slice(at, at + 32768)) return false; return true;
}, text)).toBe(true); }
async function setup(p: Page, host: string, text: string): Promise<void> { p.on("pageerror", error => { throw error; }); await p.goto(`/hosts/${host}/?editor=candidate`);
    await p.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, text); await ready(p);
}
async function select(p: Page, at = 2): Promise<void> { await input(p).focus(); await p.evaluate(at => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: at, head: at }]); }, at); }
async function preview(p: Page): Promise<void> { await button(p, "Preview module action").click(); await ready(p); }
async function dispose(p: Page): Promise<void> { await p.evaluate(() => window.hostFixture.dispose()); const s = await snapshot(p); expect(s.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(s.hostSubscriptions).toBe(0); expect(s.bindings.actions).toMatchObject({ transport: null, sessions: 0, subscriptions: 0, disposed: true }); expect(s.bindings.actions.worker.created).toBe(s.bindings.actions.worker.terminated); }
for (const host of ["plain", "react"]) {
    test(`${host} a valid wide provider edit keeps preview context and DOM bounded without applying source`, async ({ page: p }) => {
        const raw = "const value = 1;\n" + "x".repeat(100000);
        await p.addInitScript(({ length }) => {
            const Current = window.Worker, forwarded = new WeakSet<Event>();
            window.Worker = class extends Current {
                constructor(url: string | URL, options?: WorkerOptions) {
                    super(url, options); this.addEventListener("message", event => {
                        if (forwarded.has(event) || typeof event.data !== "string") return; const reply = JSON.parse(event.data);
                        if (reply.operation !== "project-action-result" || !reply.result.action.edits.length) return;
                        const edit = reply.result.action.edits[0].edits[0]; edit.from = 0; edit.to = length;
                        const next = new MessageEvent("message", { data: JSON.stringify(reply) }); forwarded.add(next); event.stopImmediatePropagation(); this.dispatchEvent(next);
                    });
                }
            };
        }, { length: raw.length });
        await setup(p, host, raw); await select(p); const before = await snapshot(p); await preview(p); const s = await snapshot(p);
        expect(s.bindings.actions.state).toMatchObject({ status: "ready", canApply: true }); expect(s.bindings.actions.state.edits[0]).toMatchObject({ from: 0, to: raw.length });
        expect(s.bindings.actions.state.edits[0]!.context.length).toBeLessThanOrEqual(64); expect((await p.getByLabel("Proposed action edits", { exact: true }).textContent())!.length).toBeLessThan(512);
        await exact(p, raw); expect(s.history).toEqual(before.history); expect(s.source.exports).toBe(0); await dispose(p);
    });
    for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} captured worker import preview preserves complete selections, shared history, review and primary Save/Run`, async ({ page: p }) => {
        test.setTimeout(120000); const raw = "\ufeffconst café = '😀';\r\n" + (large ? "const unchanged = 123;\r\n".repeat(100000) : "") + "café;", header = 'import "sample-utils";\r\n', expected = raw.slice(0, 1) + header + raw.slice(1);
        await setup(p, host, raw); await button(p, "Open source review").click(); await ready(p); await input(p).focus(); const ranges = [{ anchor: 12, head: 7 }, { anchor: raw.length, head: raw.length }];
        await p.evaluate(ranges => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, ranges, 0); }, ranges); const before = await snapshot(p);
        await preview(p); let s = await snapshot(p); expect(s.bindings.actions.state).toMatchObject({ status: "ready", canApply: true }); expect(s.bindings.actions.state.edits).toHaveLength(1); expect(s.bindings.actions.worker).toMatchObject({ created: 1, opened: 1, snapshotUnits: raw.length }); expect(s.history).toEqual(before.history); await exact(p, raw);
        await button(p, "Apply captured action").click(); await ready(p); await exact(p, expected); s = await snapshot(p); expect(s.history.undoDepth).toBe(before.history.undoDepth + 1); expect(s.bindings.actions.applied).toBe(1);
        expect(s.bindings.views.find(v => v.id === "primary")!.selectionSet.ranges.map(r => ({ anchor: r.anchor, head: r.head }))).toEqual(ranges.map(r => ({ anchor: r.anchor + header.length, head: r.head + header.length })));
        expect(s.bindings.comparison!.baseline).toEqual(before.bindings.comparison!.baseline); expect(s.source.exports).toBe(0); expect(s.bindings.views.every(v => v.metrics!.viewport.rows < 100)).toBe(true);
        await input(p).press("Control+End"); await input(p).pressSequentially("H"); await ready(p); await exact(p, expected + "H");
        await input(p, "Secondary source").press("Control+z"); await ready(p); await exact(p, expected); await input(p, "Secondary source").press("Control+z"); await ready(p); await exact(p, raw);
        expect((await snapshot(p)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges.map(r => ({ anchor: r.anchor, head: r.head }))).toEqual(ranges);
        await input(p, "Secondary source").press("Control+Shift+z"); await ready(p); await exact(p, expected); await preview(p); s = await snapshot(p); expect(s.bindings.actions.state.disabled).toContain("already present"); await expect(button(p, "Apply captured action")).toBeDisabled(); expect(s.history.undoDepth).toBe(before.history.undoDepth + 1); expect(s.bindings.actions.worker.created).toBe(1);
        await button(p, "Dismiss action preview").click(); await button(p, "Run captured inputs").click(); expect(await p.evaluate(text => window.hostFixture.runCapture(0)!.source === text, expected)).toBe(true); await p.evaluate(() => window.hostFixture.finishRun()); await button(p, "Save source").click(); await p.evaluate(() => window.hostFixture.finishSave()); await ready(p); expect((await snapshot(p)).source.dirty).toBe(false); await dispose(p);
    });
    test(`${host} action keyboard entry and explicit confirmation preserve comparison origin, module edits and host focus`, async ({ page: p }) => {
        const raw = "const value = 1;\r\nvalue;", header = 'import "other-utils";\r\n'; await setup(p, host, raw); await button(p, "Open source review").click(); await ready(p);
        const working = input(p, "Comparison working source"), module = p.getByLabel("Action module", { exact: true }); await working.focus(); const ranges = [{ anchor: 9, head: 7 }, { anchor: raw.length, head: raw.length }];
        await p.evaluate(ranges => { const f = window.hostFixture; f.selectSourceSet("comparison", f.snapshot().source.revision, ranges); }, ranges); const before = await snapshot(p);
        await working.press("Control+."); await ready(p); await expect(module).toBeFocused(); await p.keyboard.type("other-utils"); await expect(module).toHaveValue("other-utils"); await exact(p, raw); expect((await snapshot(p)).bindings.actions.state.canApply).toBe(false);
        await p.keyboard.press("Enter"); await ready(p); expect((await snapshot(p)).bindings.actions.capture!.view).toBe("comparison"); await exact(p, raw); expect((await snapshot(p)).history).toEqual(before.history);
        await p.keyboard.press("Escape"); await expect(working).toBeFocused(); expect((await snapshot(p)).bindings.comparison!.selectionSet).toEqual(before.bindings.comparison!.selectionSet);
        await working.press("Control+."); await ready(p); await p.keyboard.press("Tab"); await expect(button(p, "Preview module action")).toBeFocused(); await p.keyboard.press("Tab"); await expect(button(p, "Apply captured action")).toBeFocused(); await p.keyboard.press("Enter"); await ready(p); await exact(p, header + raw); await expect(working).toBeFocused(); expect((await snapshot(p)).bindings.comparison!.baseline).toEqual(before.bindings.comparison!.baseline); await dispose(p);
    });
    test(`${host} secondary-resource actions retain explicit reveal and primary Save/Run identity`, async ({ page: p }) => {
        const raw = "catalogue;", companionRaw = "const catalogue = 1;\r\ncatalogue;\r\n", expected = 'import "sample-utils";\r\n' + companionRaw;
        await setup(p, host, raw); await button(p, "Add navigation companion").click(); await select(p, 3); await button(p, "Find definition").click();
        await expect.poll(async () => (await snapshot(p)).bindings.navigation.pending).toBe(false); await p.getByLabel("Navigation results", { exact: true }).getByRole("button").first().click(); await ready(p);
        const companion = (await snapshot(p)).bindings.navigation.companion!; await expect(input(p, "Secondary source")).toBeFocused(); await preview(p); const oldToken = (await snapshot(p)).bindings.actions.state.token;
        await button(p, "Dismiss action preview").click(); await preview(p); await p.evaluate(token => window.hostFixture.applyAction(token), oldToken);
        expect(await p.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(companionRaw); expect((await snapshot(p)).bindings.actions.state.canApply).toBe(true);
        await button(p, "Apply captured action").click(); await ready(p); expect(await p.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(expected); await exact(p, raw);
        await input(p).focus(); await button(p, "Open action changes in Navigation companion").click(); await expect(input(p, "Secondary source")).toBeFocused();
        await input(p, "Secondary source").press("Control+z"); await ready(p); expect(await p.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(companionRaw);
        await input(p, "Secondary source").press("Control+Shift+z"); await ready(p); expect(await p.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(expected);
        await button(p, "Run captured inputs").click(); expect(await p.evaluate(text => window.hostFixture.runCapture(0)!.source === text, raw)).toBe(true); await p.evaluate(() => window.hostFixture.finishRun());
        await button(p, "Save source").click(); await p.evaluate(() => window.hostFixture.finishSave()); await ready(p); await exact(p, raw); expect(await p.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(expected); await dispose(p);
    });
    test(`${host} action captures expire on selection, typing, module, authority and remount while old confirmation tokens stay inert`, async ({ page: p }) => {
        test.setTimeout(120000); const raw = "const value = 1;\r\nvalue;"; await setup(p, host, raw); let current = raw;
        for (const mode of ["selection", "typing", "module", "authority", "remount"] as const) {
            await select(p); await p.evaluate(() => window.hostFixture.setActionDelay(1000)); await button(p, "Preview module action").click(); const token = (await snapshot(p)).bindings.actions.state.token; expect((await snapshot(p)).bindings.actions.state.pending).toBe(true);
            if (mode === "selection") await p.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 3, head: 3 }]); });
            else if (mode === "typing") { await input(p).press("Control+End"); await input(p).pressSequentially("X"); current += "X"; }
            else if (mode === "module") await p.getByLabel("Action module", { exact: true }).fill("changed-utils");
            else if (mode === "authority") await p.evaluate(() => window.hostFixture.cycleSourceEditLease());
            else await p.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
            await ready(p); await p.evaluate(token => window.hostFixture.applyAction(token), token); await exact(p, current); expect((await snapshot(p)).bindings.actions.applied).toBe(0);
        }
        await p.evaluate(() => window.hostFixture.setActionDelay(0)); await select(p); await preview(p); await p.evaluate(() => window.hostFixture.setSourceReadOnly(true)); await ready(p); await expect(button(p, "Apply captured action")).toBeDisabled(); await exact(p, current);
        await select(p); await preview(p); await expect(button(p, "Apply captured action")).toBeDisabled(); await p.evaluate(() => window.hostFixture.setSourceReadOnly(false)); await dispose(p);
    });
    test(`${host} malformed and incomplete actions never publish partial edits; safe titles, idle failure and reconnect retain local editing`, async ({ page: p }) => {
        const raw = "const value = 1;\r\nvalue;"; await setup(p, host, raw); await select(p); const before = await snapshot(p);
        for (const fault of ["malformed", "incomplete", "failure"] as const) { await p.evaluate(fault => window.hostFixture.faultActionNext(fault), fault); await preview(p); expect((await snapshot(p)).bindings.actions.state.status).toBe("failed"); await exact(p, raw); expect((await snapshot(p)).history).toEqual(before.history); await expect(button(p, "Apply captured action")).toBeDisabled(); await button(p, "Reconnect action provider").click(); }
        await p.evaluate(() => window.hostFixture.faultActionNext("markup")); await preview(p); await expect(p.getByLabel("Captured action title", { exact: true })).toContainText("<img"); expect(await p.getByRole("region", { name: "Code actions", exact: true }).locator("img,script").count()).toBe(0); expect(await p.evaluate(() => (window as unknown as { actionExecuted?: boolean }).actionExecuted)).toBeUndefined();
        expect(await p.evaluate(() => window.hostFixture.faultIdleAction())).toBe(true); await expect.poll(async () => (await snapshot(p)).bindings.actions.state.status).toBe("failed"); expect((await snapshot(p)).bindings.actions.transport).toBeNull(); await button(p, "Reconnect action provider").click(); await preview(p); await button(p, "Disconnect action provider").click(); const requested = (await snapshot(p)).bindings.actions.requested;
        await select(p); await input(p).press("Control+."); expect((await snapshot(p)).bindings.actions.requested).toBe(requested); await input(p).press("Control+End"); await input(p).pressSequentially("H"); await ready(p); await exact(p, raw + "H"); await button(p, "Reconnect action provider").click(); await preview(p); expect((await snapshot(p)).bindings.actions.state.canApply).toBe(true); await dispose(p);
    });
    test(`${host} action capture respects yielded navigation, synthetic composition and pending table conversion`, async ({ page: p }) => {
        test.setTimeout(120000); const raw = "value " + " ".repeat(1000000) + "end"; await setup(p, host, raw); await select(p, 6);
        const movement = await input(p).evaluate(node => { const f = window.hostFixture, before = f.snapshot().bindings.actions.requested; node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true })); const pending = f.snapshot().bindings.views.find(v => v.id === "primary")!.metrics!.pendingCommand; f.requestAction(); return { pending, requests: f.snapshot().bindings.actions.requested - before }; });
        expect(movement).toEqual({ pending: true, requests: 0 }); await ready(p); await select(p); await preview(p); await input(p).dispatchEvent("compositionstart", { data: "" }); const before = (await snapshot(p)).bindings.actions.requested; await p.evaluate(() => window.hostFixture.requestAction()); expect((await snapshot(p)).bindings.actions.requested).toBe(before); await expect(button(p, "Apply captured action")).toBeDisabled();
        await p.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await ready(p); const base = "left right", point = 5, cell = "B".repeat(400000), csv = '"A","' + cell + '"';
        await p.evaluate(({ base, point }) => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: base }]); f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: point, head: point }]); }, { base, point }); await p.getByRole("checkbox", { name: "Paste tables as CSV", exact: true }).check(); await input(p).focus(); await ready(p);
        const guard = await input(p).evaluate((node, text) => { const f = window.hostFixture, before = f.snapshot().bindings.actions.requested, event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }); event.clipboardData!.setData("text/plain", text); node.dispatchEvent(event); const pending = f.snapshot().bindings.tablePaste.pending; f.requestAction(); return { pending, requests: f.snapshot().bindings.actions.requested - before }; }, "A\t" + cell);
        expect(guard).toEqual({ pending: true, requests: 0 }); await expect.poll(async () => (await snapshot(p)).bindings.tablePaste.pending).toBe(false); await ready(p); await exact(p, base.slice(0, point) + csv + base.slice(point)); expect((await snapshot(p)).source.exports).toBe(0); await dispose(p);
    });
}
