import { isolatedTest as test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { hostTextEquals } from "../../scripts/host-scene.mjs";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const notes = (page: Page) => page.getByRole("list", { name: "Captured provider edits", exact: true }).locator("li");
const raw = "// 😀 TODO\r\nconst catalogue = 1;\r\ncatalogue;", header = "// provider review\r\n", footer = "\r\n// end provider review";
async function editors(page: Page) { await expect.poll(async () => { const s = await snapshot(page), c = s.bindings.comparison; return s.bindings.views.every(v => !v.metrics?.pendingInput && !v.metrics?.pendingCommand && !v.metrics?.pendingCaret && !v.metrics?.viewport.pending)
    && (!c || c.status === "ready" && !c.workingViewport.pending && !c.referenceViewport?.pending); }, { timeout: 30000 }).toBe(true); }
async function done(page: Page) { await expect.poll(async () => (await snapshot(page)).bindings.project.pending, { timeout: 30000 }).toBe(false); await editors(page); }
async function select(page: Page, at = 7) { await input(page).focus(); await page.evaluate(at => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: at, head: at }]); }, at); await editors(page); }
async function seed(page: Page, text = raw) { await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, text); await select(page); }
async function register(page: Page) { if ((await snapshot(page)).bindings.project.state.reconnectRequired) { await button(page, "Reconnect workspace provider").click(); await select(page); }
    await button(page, "Register provider review command").click(); await done(page); const s = await snapshot(page); expect(s.bindings.project.registered, JSON.stringify({ project: s.bindings.project, lsp: s.bindings.lsp })).toBe(true); }
async function request(page: Page) { await button(page, "Request provider review edits").click(); await expect.poll(async () => !!(await snapshot(page)).bindings.project.state.review).toBe(true); await editors(page); }
async function control(page: Page, method: string, params?: unknown) { await page.evaluate(({ method, params }) => (Reflect.get(window, "projectTestSocket") as WebSocket).send(JSON.stringify({ jsonrpc: "2.0", ...(params === undefined ? {} : { id: "control-" + method, params }), method })), { method, params }); }
async function exact(page: Page, text: string) { expect(await hostTextEquals(page, text)).toBe(true); }
async function dispose(page: Page) { await page.evaluate(() => window.hostFixture.dispose()); const s = await snapshot(page); expect(s.bindings.project).toMatchObject({ pending: false, transport: null, sessions: 0, subscriptions: 0, disposed: true }); }
test.describe(`plain LSP server edits`, () => {
    test.beforeEach(async ({ page }) => {
         await page.addInitScript(() => { const send = WebSocket.prototype.send; WebSocket.prototype.send = function(this: WebSocket, data) { if (typeof data === "string") { const value = JSON.parse(data); if (value.method === "initialize" && value.params.capabilities.workspace?.applyEdit) Reflect.set(window, "projectTestSocket", this); } send.call(this, data); }; });
        await page.goto("/hosts/plain/?language=lsp"); await expect(input(page)).toBeVisible(); await editors(page);
    });
    test("advertised commands and explicit server-edit decisions retain wire versions, complete history and one acknowledgement", async ({ page }) => {
        const sent: any[] = [], incoming: any[] = []; let opened = 0, closed = 0; page.on("websocket", socket => { opened++; socket.on("close", () => closed++); socket.on("framesent", frame => sent.push(JSON.parse(frame.payload.toString()))); socket.on("framereceived", frame => incoming.push(JSON.parse(frame.payload.toString()))); });
        await seed(page); await button(page, "Add navigation companion").click(); await button(page, "Request provider workspace status").click(); await done(page); expect((await snapshot(page)).bindings.project.transport!.version).toBe("LSP3.17"); await register(page);
        const ranges = [{ anchor: 10, head: 7 }, { anchor: raw.length, head: raw.length }]; await page.evaluate(ranges => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, ranges); }, ranges); const before = await snapshot(page); await request(page); await expect(notes(page)).toHaveCount(4); await exact(page, raw); expect((await snapshot(page)).history).toEqual(before.history);
        const apply = incoming.find(value => value.method === "workspace/applyEdit")!, replies = () => sent.filter(value => value.id === apply.id && ("result" in value || "error" in value)); expect(replies()).toHaveLength(0);
        const initialize = sent.find(value => value.method === "initialize" && value.params.capabilities.workspace?.applyEdit)!; expect(initialize.params.capabilities.workspace.executeCommand.dynamicRegistration).toBe(true); expect(incoming.some(value => value.method === "client/registerCapability" && value.params.registrations[0].method === "workspace/executeCommand")).toBe(true);
        expect(apply.params.edit.documentChanges.some((change: any) => change.textDocument.version !== 0)).toBe(true); await button(page, "Apply captured provider edits").click(); await done(page); expect(replies()).toHaveLength(1); expect(replies()[0].result.applied).toBe(true); await exact(page, header + raw + footer);
        const companion = before.bindings.navigation.companion!; expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(header + "const catalogue = 1;\r\ncatalogue;\r\n" + footer); expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
        await button(page, "Open provider changes in Navigation companion").evaluate(node => { node.dataset.retained = "changed-resource"; });
        await button(page, "Open provider changes in Navigation companion").click(); await editors(page); await input(page, "Secondary source").press("Control+z"); await editors(page); await exact(page, raw); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges.map(r => ({ anchor: r.anchor, head: r.head }))).toEqual(ranges); await input(page, "Secondary source").press("Control+Shift+z"); await editors(page); await exact(page, header + raw + footer);
        await expect(button(page, "Open provider changes in Navigation companion")).toHaveAttribute("data-retained", "changed-resource");
        const depth = (await snapshot(page)).history.undoDepth; await button(page, "Request provider review edits").click(); await done(page); expect((await snapshot(page)).history.undoDepth).toBe(depth); await button(page, "Unregister provider review command").click(); await done(page); await expect(button(page, "Request provider review edits")).toBeDisabled(); expect((await snapshot(page)).source.exports).toBe(0); await dispose(page); await expect.poll(() => closed).toBe(opened);
    });
    test("edits to only an unmounted companion preserve primary revision, review, Save and Run", async ({ page }) => {
        await seed(page); await button(page, "Open source review").click(); await register(page); await request(page);
        await button(page, "Apply captured provider edits").click(); await done(page); const expected = header + raw + footer; await exact(page, expected);
        const baseline = (await snapshot(page)).bindings.comparison!.baseline; await button(page, "Add navigation companion").click(); await editors(page);
        const before = await snapshot(page), companion = before.bindings.navigation.companion!;
        const companionText = await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion);
        expect(before.bindings.views.every(view => view.documentId !== companion)).toBe(true);
        await request(page); await expect(notes(page)).toHaveCount(2); await exact(page, expected); expect((await snapshot(page)).history).toEqual(before.history);
        await button(page, "Apply captured provider edits").click(); await done(page);
        const after = await snapshot(page); expect(after.source.revision).toBe(before.source.revision); expect(after.history).toEqual(before.history);
        expect(after.bindings.views.every(view => view.documentId !== companion)).toBe(true);
        const changed = page.getByRole("list", { name: "Provider changed resources", exact: true }).getByRole("button");
        await expect(changed).toHaveCount(1); await expect(changed).toHaveText("Open provider changes in Navigation companion"); await changed.click(); await editors(page);
        await expect(input(page, "Secondary source")).toBeFocused(); expect((await snapshot(page)).bindings.views.find(view => view.id === "secondary")!.documentId).toBe(companion);
        expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(header + companionText + footer);
        await input(page, "Secondary source").press("Control+z"); await editors(page); await exact(page, expected);
        expect((await snapshot(page)).source.revision).toBe(before.source.revision); expect((await snapshot(page)).history).toEqual(before.history);
        expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(companionText);
        await input(page, "Secondary source").press("Control+Shift+z"); await editors(page); await exact(page, expected);
        expect((await snapshot(page)).source.revision).toBe(before.source.revision); expect((await snapshot(page)).history).toEqual(before.history);
        expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(header + companionText + footer);
        expect((await snapshot(page)).bindings.comparison!.baseline).toEqual(baseline); expect((await snapshot(page)).source.exports).toBe(0);
        expect(await page.evaluate(() => window.hostFixture.releaseNavigationCompanion())).toBe(false);
        await button(page, "Run captured inputs").click(); expect((await snapshot(page)).pendingRuns[0]!.sourceId).toBe(before.source.id);
        expect(await page.evaluate(() => window.hostFixture.runCapture(0)!.source)).toBe(expected); await page.evaluate(() => window.hostFixture.finishRun());
        await button(page, "Save source").click(); await page.evaluate(() => window.hostFixture.finishSave()); await done(page);
        expect((await snapshot(page)).source.dirty).toBe(false); await exact(page, expected);  await dispose(page);
    });
    test("a held Apply, stale review handles and authority changes cannot apply a replacement batch", async ({ page }) => {
        await seed(page); await button(page, "Add navigation companion").click(); await register(page); const before = await snapshot(page), companion = before.bindings.navigation.companion!;
        // The held-request journey owns focus when review arrives after a form change.
        await request(page);
        const apply = button(page, "Apply captured provider edits");
        const old = await page.evaluateHandle(() => window.hostFixture.snapshot().bindings.project.state.review!);
        await apply.hover(); await page.mouse.down();
        await button(page, "Decline captured provider edits").evaluate(node => (node as HTMLButtonElement).click());
        await done(page); await exact(page, raw);
        await button(page, "Request provider review edits").evaluate(node => (node as HTMLButtonElement).click());
        await expect(apply).toBeEnabled();
        await apply.hover(); await page.mouse.up(); await editors(page);
        await old.evaluate(review => review.apply());
        await expect(apply).toBeEnabled(); await exact(page, raw);
        await page.evaluate(id => window.hostFixture.setProjectTargetReadOnly(id, true), companion);
        await done(page); await expect(apply).toBeDisabled();
        await select(page); await register(page); await request(page); await expect(apply).toBeDisabled();
        await page.evaluate(() => window.hostFixture.snapshot().bindings.project.state.review!.apply());
        await done(page);
        await expect(page.getByLabel("Workspace provider status", { exact: true })).toHaveText("An edit target is read-only or locked.");
        await exact(page, raw); expect((await snapshot(page)).history).toEqual(before.history);
        await page.evaluate(id => window.hostFixture.setProjectTargetReadOnly(id, false), companion);
        for (const mode of ["selection", "typing", "remount"] as const) {
            await select(page); if (!(await snapshot(page)).bindings.project.registered) await register(page); await request(page); const captured = await page.evaluateHandle(() => window.hostFixture.snapshot().bindings.project.state.review!);
            if (mode === "selection") await select(page, 8); else if (mode === "typing") { await input(page).press("Control+End"); await input(page).pressSequentially("x"); await editors(page); await input(page).press("Control+z"); } else await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
            await done(page); await captured.evaluate(review => review.apply()); await exact(page, raw);
        }
        expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth); await dispose(page);
    });
    test("request cancellation, capability withdrawal, disconnect and lost acknowledgement never replay edits", async ({ page }) => {
        let executions = 0; const incoming: any[] = []; page.on("websocket", socket => {
            socket.on("framesent", frame => { if (JSON.parse(frame.payload.toString()).method === "workspace/executeCommand") executions++; });
            socket.on("framereceived", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method === "workspace/applyEdit") incoming.push(value); });
        }); await page.reload(); await seed(page); await button(page, "Add navigation companion").click(); await register(page); const before = await snapshot(page), companion = before.bindings.navigation.companion!;
        const companionBefore = await page.evaluate(id => window.hostFixture.navigationDocument(id), companion);
        for (const fault of ["malformed", "failure"] as const) {
            await page.evaluate(fault => window.hostFixture.faultProjectNext(fault), fault); await button(page, "Request provider review edits").click(); await done(page);
            await exact(page, raw); expect((await snapshot(page)).history).toEqual(before.history); expect((await snapshot(page)).bindings.project.applied).toBe(0);
            expect((await snapshot(page)).bindings.project.state.review).toBeNull(); await expect(button(page, "Apply captured provider edits")).toBeDisabled();
            expect(await page.evaluate(id => window.hostFixture.navigationDocument(id), companion)).toEqual(companionBefore);
            if (fault === "malformed") {
                const changes = incoming.at(-1).params.edit.documentChanges; expect(changes).toHaveLength(3);
                expect(changes.at(-1).textDocument.uri).toBe("host+fixture:unknown-target");
                expect((await snapshot(page)).bindings.project).toMatchObject({ state: { status: "rejected" }, transport: { connected: true } });
            }
            if ((await snapshot(page)).bindings.project.state.status === "failed") { await button(page, "Reconnect workspace provider").click(); await select(page); await register(page); }
        }
        await request(page); const captured = await page.evaluateHandle(() => window.hostFixture.snapshot().bindings.project.state.review!); await control(page, "fixture/cancelApply"); await done(page); expect((await snapshot(page)).bindings.project.state.review).toBeNull(); await captured.evaluate(review => review.apply()); await exact(page, raw);
        await request(page); await control(page, "fixture/reviewRegistration", { registered: false }); await done(page); await exact(page, raw); expect((await snapshot(page)).bindings.project.registered).toBe(false); await button(page, "Reconnect workspace provider").click(); await select(page); const count = executions; await register(page); expect(executions).toBe(count);
        await request(page); await control(page, "fixture/disconnect"); await done(page); await exact(page, raw); await button(page, "Reconnect workspace provider").click(); await select(page); await register(page);
        await page.evaluate(() => window.hostFixture.faultProjectNext("ack")); await request(page); await button(page, "Apply captured provider edits").click(); await done(page); await exact(page, header + raw + footer); expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1); await expect(page.getByLabel("Workspace provider status", { exact: true })).toContainText("undo");
        const sent = executions; await button(page, "Reconnect workspace provider").click(); await select(page); await register(page); expect(executions).toBe(sent); await button(page, "Request provider review edits").click(); await done(page); expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1); await input(page).press("Control+z"); await editors(page); await exact(page, raw); await dispose(page);
    });
    test("held server requests cannot revive interrupted command captures and fresh reviews retain form focus", async ({ page }) => {
        test.setTimeout(60000);
        let armed = false, commandId: number | undefined, requestId: number | undefined, cancelled = false, response: any, release: (() => void) | undefined;
        await page.routeWebSocket("**/lsp-fixture", client => {
            const server = client.connectToServer();
            client.onMessage(message => { const value = JSON.parse(message.toString());
                if (armed && value.method === "workspace/executeCommand") commandId = value.id;
                if (value.method === "$/cancelRequest" && value.params.id === commandId) cancelled = true;
                if (value.id === requestId && ("result" in value || "error" in value)) response = value;
                server.send(message);
            });
            server.onMessage(message => { const value = JSON.parse(message.toString());
                if (armed && value.method === "workspace/applyEdit") { armed = false; requestId = value.id; release = () => client.send(message); }
                else client.send(message);
            });
        });
        await page.reload(); await seed(page); await button(page, "Add navigation companion").click();
        const companion = (await snapshot(page)).bindings.navigation.companion!, companionText = await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion);
        let current = raw;
        const hold = async () => {
            await select(page); await register(page); armed = true; commandId = requestId = undefined; cancelled = false; response = undefined; release = undefined;
            await button(page, "Request provider review edits").click(); await expect.poll(() => !!release).toBe(true);
            expect((await snapshot(page)).bindings.project).toMatchObject({ pending: true, applied: 0, state: { review: null } });
        };
        const deliver = async () => { expect(release).toBeDefined(); release!(); release = undefined; await page.evaluate(() => window.hostFixture.providerCustom("fixture/state", {})); };
        for (const mode of ["typing", "selection", "authority", "lease", "remount"] as const) {
            await hold();
            if (mode === "typing") { await input(page).press("Control+End"); await input(page).pressSequentially("X"); current += "X"; }
            else if (mode === "selection") await select(page, 8);
            else if (mode === "authority") await page.evaluate(() => { window.hostFixture.setSourceReadOnly(true); window.hostFixture.setSourceReadOnly(false); });
            else if (mode === "lease") await page.evaluate(() => window.hostFixture.cycleSourceEditLease());
            else await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
            await done(page); await expect.poll(() => cancelled).toBe(true); const interrupted = await snapshot(page);
            await deliver(); await expect.poll(() => response?.result?.applied).toBe(false); await done(page); await exact(page, current);
            const after = await snapshot(page); expect(after.source.revision).toBe(interrupted.source.revision); expect(after.history).toEqual(interrupted.history);
            expect(after.bindings.views.find(view => view.id === "primary")!.selectionSet).toEqual(interrupted.bindings.views.find(view => view.id === "primary")!.selectionSet);
            expect(after.bindings.project).toMatchObject({ pending: false, applied: 0, state: { review: null } }); await expect(button(page, "Apply captured provider edits")).toBeDisabled();
            expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(companionText);
        }
        await hold(); const before = await snapshot(page), form = input(page, "Configuration path"); await form.fill("during-provider.csv");
        await deliver(); await expect.poll(async () => !!(await snapshot(page)).bindings.project.state.review).toBe(true); await expect(form).toBeFocused(); await exact(page, current);
        expect((await snapshot(page)).history).toEqual(before.history); await button(page, "Apply captured provider edits").click(); await done(page);
        await exact(page, header + current + footer); expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
         expect((await snapshot(page)).source.exports).toBe(0); await dispose(page);
    });
    test("comparison review decisions keep immutable baselines and primary Save/Run despite companion focus", async ({ page }) => {
        await seed(page); await button(page, "Open source review").click(); await button(page, "Add navigation companion").click(); await editors(page); const working = input(page, "Comparison working source"), before = await snapshot(page), baseline = before.bindings.comparison!.baseline; await working.focus(); await register(page); await request(page); await button(page, "Apply captured provider edits").click(); await done(page); const expected = header + raw + footer; await exact(page, expected); expect((await snapshot(page)).bindings.comparison!.baseline).toEqual(baseline);
        await button(page, "Open provider changes in Navigation companion").click(); await editors(page); await button(page, "Run captured inputs").click(); expect((await snapshot(page)).pendingRuns[0]!.sourceId).toBe(before.source.id); expect(await page.evaluate(() => window.hostFixture.runCapture(0)!.source)).toBe(expected); await page.evaluate(() => window.hostFixture.finishRun());
        await button(page, "Save source").click(); await working.press("Control+End"); await working.pressSequentially(" later"); await editors(page); await page.evaluate(() => window.hostFixture.finishSave()); await editors(page); await exact(page, expected + " later"); expect((await snapshot(page)).source.dirty).toBe(true); expect((await snapshot(page)).bindings.comparison!.baseline).toEqual(baseline); await dispose(page);
    });
    test("server reviews page every edit and bound wide deletion previews without applying declines", async ({ page }) => {
        test.setTimeout(90000); const text = "// 😀 TODO\r\n" + "const unchanged = 123;\r\n" + "// TODO\r\n".repeat(70); await seed(page, text); await register(page); const before = await snapshot(page); await control(page, "fixture/projectStyle", { style: "many" }); await request(page); expect((await snapshot(page)).bindings.project.state.review!.count).toBe(73); await expect(notes(page)).toHaveCount(64); await button(page, "Next provider edits").click(); await expect(notes(page)).toHaveCount(9); await button(page, "Apply captured provider edits").click(); await done(page); await exact(page, header + text.replaceAll("TODO", "DONE") + footer); await input(page).press("Control+z"); await editors(page); await exact(page, text);
        await control(page, "fixture/projectStyle", { style: "wide" }); await request(page); await expect(notes(page)).toHaveCount(1); expect((await snapshot(page)).bindings.project.state.review!.notes[0]!.context.length).toBeLessThan(200); expect((await page.getByRole("list", { name: "Captured provider edits" }).textContent())!.length).toBeLessThan(2000); await button(page, "Decline captured provider edits").click(); await done(page); await exact(page, text); expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth); expect((await snapshot(page)).source.exports).toBe(0); expect((await snapshot(page)).bindings.views.every(v => v.metrics!.inputUnits <= 4096 && v.metrics!.viewport.rows < 100)).toBe(true); await dispose(page);
    });
});
