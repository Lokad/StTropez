import { ready, isolatedTest as test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { coversHost } from "./host-cases.ts";
import { holdLspReplies } from "../helpers/lsp-replies.ts";
import { hostTextEquals } from "../../scripts/host-scene.mjs";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const choices = (page: Page) => page.getByRole("list", { name: "Provider code actions", exact: true }).getByRole("button");
const edits = (page: Page) => page.getByRole("list", { name: "Proposed action edits", exact: true }).locator("li");
const raw = "// 😀 TODO\r\nconst catalogue = 1;\r\ncatalogue;", marker = "// fixture action\r\n";
async function releaseAfterReplacement(page: Page, kind: "choices" | "edits", replace: () => Promise<void>) {
    const label = "action " + kind, next = button(page, "Next " + label);
    const old = await page.evaluateHandle(kind => {
        const state = window.hostFixture.snapshot().bindings.actions.state;
        return (kind === "choices" ? state.choicePaging : state.editPaging)!.next!;
    }, kind);
    await next.hover(); await page.mouse.down(); await replace();
    await expect(next).toBeEnabled(); await next.hover(); await page.mouse.up();
    await old.evaluate(callback => callback()); await old.dispose();
    await expect(button(page, "Previous " + label)).toBeDisabled();
}
const header = "// provider review\r\n", footer = "\r\n// end provider review";
async function faultCommand(page: Page, fault: "malformed" | "failure" | "ack") {
    await page.evaluate(fault => {
        const socket = Reflect.get(window, "actionTestSocket") as WebSocket, send = socket.send;
        Reflect.set(window, "actionCommandFaultPending", true);
        socket.send = function(data) {
            if (typeof data === "string") {
                const value = JSON.parse(data);
                if (value.method === "workspace/executeCommand" && value.params.command === "fixture.review") {
                    socket.send = send; Reflect.set(window, "actionCommandFaultPending", false);
                    data = JSON.stringify({ ...value, params: { ...value.params, _fixture: { delay: 0, fault } } });
                }
            }
            send.call(this, data);
        };
    }, fault);
    return async () => expect(await page.evaluate(() => Reflect.get(window, "actionCommandFaultPending"))).toBe(false);
}
async function control(page: Page, method: string, params?: unknown, expectReply = true): Promise<any> {
    return page.evaluate(({ method, params, expectReply }) => { const socket = Reflect.get(window, "actionTestSocket") as WebSocket;
        if (params === undefined) { socket.send(JSON.stringify({ jsonrpc: "2.0", method })); return null; }
        if (!expectReply) { socket.send(JSON.stringify({ jsonrpc: "2.0", id: "test-" + crypto.randomUUID(), method, params })); return null; }
        return new Promise((resolve, reject) => { const id = "test-" + crypto.randomUUID(), onMessage = (event: MessageEvent<string>) => { const value = JSON.parse(event.data); if (value.id !== id) return;
            socket.removeEventListener("message", onMessage); if (value.error) reject(new Error(value.error.message)); else resolve(value.result); };
            socket.addEventListener("message", onMessage); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
    }, { method, params, expectReply });
}
async function review(page: Page) { await expect.poll(async () => !!(await snapshot(page)).bindings.project.state.review).toBe(true); }
async function waitForActions(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (!s.bindings.actions.state.pending); });
}
async function select(page: Page, at = raw.indexOf("TODO") + 1) { await input(page).focus(); await page.evaluate(at => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: at, head: at }]); }, at); await waitForActions(page); }
async function seed(page: Page, text = raw) { await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, text); await select(page, text.indexOf("TODO") + 1); }
async function preview(page: Page) {
    const requested = (await snapshot(page)).bindings.actions.requested;
    await button(page, "Preview module action").click();
    // Idle also satisfies !pending. Establish that the intended command actually started.
    await expect.poll(async () => { const s = (await snapshot(page)).bindings.actions;
        return { requested: s.requested, status: s.state.status, message: s.state.message };
    }).toMatchObject({ requested: requested + 1 });
    await waitForActions(page);
}
async function exact(page: Page, text: string) { expect(await hostTextEquals(page, text)).toBe(true); }
async function dispose(page: Page) { await page.evaluate(() => window.hostFixture.dispose()); const s = await snapshot(page); expect(s.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(s.hostSubscriptions).toBe(0); expect(s.bindings.actions).toMatchObject({ sessions: 0, subscriptions: 0, transport: null, disposed: true }); }
for (const host of ["plain", "react"] as const) test.describe(`${host} LSP code actions`, () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => { const send = WebSocket.prototype.send; WebSocket.prototype.send = function(this: WebSocket, data) { if (typeof data === "string") { const value = JSON.parse(data); if (value.method === "initialize" && value.params.capabilities.textDocument?.codeAction) Reflect.set(window, "actionTestSocket", this); } send.call(this, data); }; });
        await page.goto(`/hosts/${host}/?editor=candidate&language=lsp`); await expect(input(page)).toBeVisible(); await waitForActions(page); });
    if (coversHost("candidate-hosts", host, "candidate")) test("action choices and lazy previews preserve captured diagnostic ranges, safe commands and complete-set history", async ({ page }) => {
        const replies = await holdLspReplies(page, "codeAction/resolve");
        const requests: { method: string; params: any }[] = []; let opened = 0, closed = 0;
        page.on("websocket", socket => { opened++; socket.on("close", () => closed++); socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method) requests.push(value); }); });
        await page.reload();
        await seed(page); const ranges = [{ anchor: raw.indexOf("TODO") + 4, head: raw.indexOf("TODO") + 1 }, { anchor: raw.length, head: raw.length }]; await page.evaluate(ranges => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, ranges); }, ranges); const before = await snapshot(page);
        await input(page).press("Control+."); await expect(input(page, "Action module")).toBeFocused(); await waitForActions(page); await expect(choices(page)).toHaveCount(9); await expect(edits(page)).toHaveCount(1); await expect(button(page, "Apply captured action")).toBeEnabled();
        const module = input(page, "Action module");
        await input(page, "Secondary source").focus(); await preview(page);
        expect((await snapshot(page)).bindings.actions.capture?.view).toBe("primary");
        const requested = (await snapshot(page)).bindings.actions.requested;
        await module.press("Escape"); await expect(input(page)).toBeFocused(); await expect(choices(page)).toHaveCount(0);
        await expect(input(page).locator("..").locator(".st-viewport-selected").first()).toBeInViewport();
        await module.focus(); await page.keyboard.down("Enter"); await page.keyboard.down("Enter"); await page.keyboard.up("Enter");
        await waitForActions(page); await expect(choices(page)).toHaveCount(9);
        expect((await snapshot(page)).bindings.actions.requested).toBe(requested + 1);
        await choices(page).nth(5).evaluate(node => { node.dataset.retained = "action-choice"; });
        await input(page, "Action module").evaluate(node => { node.dataset.retained = "action-module"; });
        await choices(page).nth(3).click(); await expect(button(page, "Apply captured action")).toBeDisabled(); await expect(page.getByLabel("Code action status", { exact: true })).toContainText("requires another context");
        await choices(page).nth(4).click();
        const execute = button(page, "Execute captured action");
        await expect(execute).toBeEnabled(); await execute.hover(); await page.mouse.down();
        await choices(page).nth(5).evaluate(node => (node as HTMLButtonElement).click()); await expect(choices(page).nth(5)).toHaveAttribute("aria-pressed", "true");
        await expect(execute).toBeEnabled(); await execute.hover(); await page.mouse.up(); await waitForActions(page);
        expect(requests.some(r => r.method === "workspace/executeCommand")).toBe(false); await exact(page, raw);
        await expect(choices(page).nth(5)).toHaveAttribute("data-retained", "action-choice"); await expect(choices(page).nth(5)).toHaveAttribute("aria-pressed", "true");
        await expect(input(page, "Action module")).toHaveAttribute("data-retained", "action-module");
        replies.hold(); await choices(page).nth(2).click(); await expect.poll(replies.waiting).toBe(true);
        await page.evaluate(() => window.hostFixture.snapshot().bindings.actions.state.choices[2]!.select(() => {
            Reflect.set(window, "retiredDirectFix", true); return true;
        }));
        await choices(page).first().click(); await expect(choices(page).first()).toHaveAttribute("aria-pressed", "true");
        await expect.poll(replies.cancelled).toBe(true); await expect(edits(page).first()).toContainText("sample-utils");
        // Return to the same lazy row while the first reply is still held. Its old direct-fix predicate has expired.
        await choices(page).nth(2).click(); await expect(edits(page).first()).toContainText('Insert "DONE"');
        await input(page, "Configuration path").focus(); await replies.release(); await waitForActions(page); await expect(input(page, "Configuration path")).toBeFocused(); await expect(edits(page)).toHaveCount(1); await expect(edits(page).first()).toContainText('Insert "DONE"');
        expect(await page.evaluate(() => Reflect.get(window, "retiredDirectFix"))).toBeUndefined(); await exact(page, raw);
        const request = requests.find(r => r.method === "textDocument/codeAction")!;
        expect(request.params._fixture).toEqual({ module: "sample-utils", delay: 0 });
        expect(request.params.range).toEqual({ start: { line: 0, character: 7 }, end: { line: 0, character: 10 } }); expect(request.params.context.triggerKind).toBe(1); expect(request.params.context.diagnostics).toHaveLength(1); expect(request.params.context.diagnostics[0].range).toEqual({ start: { line: 0, character: 6 }, end: { line: 0, character: 10 } });
        expect(requests.filter(r => r.method === "codeAction/resolve")).toHaveLength(2); const initialize = requests.find(r => r.method === "initialize" && r.params.capabilities.textDocument.codeAction)!; expect(initialize.params.capabilities.textDocument.codeAction.resolveSupport.properties).toEqual(["edit"]);
        expect((await snapshot(page)).history).toEqual(before.history); await button(page, "Apply captured action").click(); await waitForActions(page); await exact(page, raw.replace("TODO", "DONE")); expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
        await input(page, "Secondary source").press("Control+z"); await waitForActions(page); await exact(page, raw); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet.ranges.map(r => ({ anchor: r.anchor, head: r.head }))).toEqual(ranges);
        await input(page, "Secondary source").press("Control+Shift+z"); await waitForActions(page); await exact(page, raw.replace("TODO", "DONE")); expect((await snapshot(page)).source.exports).toBe(0); await dispose(page); await expect.poll(() => closed).toBe(opened);
    });
    if (coversHost("plain-candidate", host, "candidate")) test("a wide provider edit keeps action preview context and DOM bounded without applying source", async ({ page }) => {
        const text = "// TODO\n" + "x".repeat(100000); let rewritten = 0;
        await page.routeWebSocket("**/lsp-fixture", client => {
            const server = client.connectToServer(), ids = new Set<number>();
            client.onMessage(message => { const value = JSON.parse(message.toString()); if (value.method === "textDocument/codeAction") ids.add(value.id); server.send(message); });
            server.onMessage(message => {
                const value = JSON.parse(message.toString());
                if (ids.delete(value.id)) {
                    expect(value.error).toBeUndefined();
                    const edit = value.result[0].edit.documentChanges[0].edits[0];
                    edit.range = { start: { line: 0, character: 0 }, end: { line: 1, character: 100000 } };
                    rewritten++; client.send(JSON.stringify(value));
                } else client.send(message);
            });
        });
        await page.reload(); await waitForActions(page); await seed(page, text); const before = await snapshot(page); await preview(page);
        expect(rewritten).toBe(1); const after = await snapshot(page);
        expect(after.bindings.actions.state).toMatchObject({ status: "ready", canApply: true });
        expect(after.bindings.actions.state.edits[0]).toMatchObject({ from: 0, to: text.length });
        expect(after.bindings.actions.state.edits[0]!.context.length).toBeLessThanOrEqual(193);
        await expect(edits(page)).toHaveCount(1);
        expect((await page.getByRole("list", { name: "Proposed action edits", exact: true }).textContent())!.length).toBeLessThan(2000);
        await exact(page, text); expect(after.history).toEqual(before.history); expect(after.source.revision).toBe(before.source.revision);
        expect(after.source.exports).toBe(0); await dispose(page);
    });
    if (coversHost("candidate-hosts", host, "candidate")) test("a complete 65-action list pages to the last captured choice and applies one undoable edit", async ({ page }) => {
        await page.routeWebSocket("**/lsp-fixture", client => {
            const server = client.connectToServer(), requests = new Map<number, string>();
            client.onMessage(message => { const value = JSON.parse(message.toString()); if (value.method === "textDocument/codeAction") requests.set(value.id, value.params.textDocument.uri); server.send(message); });
            server.onMessage(message => {
                const value = JSON.parse(message.toString()), uri = requests.get(value.id);
                if (!uri) { client.send(message); return; }
                requests.delete(value.id);
                const at = { line: 0, character: 0 }, range = { start: at, end: at };
                value.result = Array.from({ length: 65 }, (_, index) => ({ title: `Review option ${index + 1}`, kind: "refactor.rewrite",
                    edit: { changes: { [uri]: [{ range, newText: `// choice ${index + 1}\r\n` }] } } }));
                client.send(JSON.stringify(value));
            });
        });
        await page.reload(); await waitForActions(page); await seed(page); await preview(page);
        await expect(choices(page)).toHaveCount(16);
        await releaseAfterReplacement(page, "choices", async () => {
            await button(page, "Preview module action").evaluate(node => (node as HTMLButtonElement).click());
            await waitForActions(page);
        });
        await expect(choices(page).first()).toContainText("Review option 1 ·");
        for (let i = 0; i < 4; i++) await button(page, "Next action choices").click();
        await expect(choices(page)).toHaveCount(1); await expect(choices(page)).toContainText("Review option 65");
        await choices(page).click(); await expect(choices(page)).toHaveAttribute("aria-pressed", "true");
        await button(page, "Apply captured action").click(); await waitForActions(page); await exact(page, "// choice 65\r\n" + raw);
        await input(page).press("Control+z"); await waitForActions(page); await exact(page, raw); await dispose(page);
    });
    if (coversHost("candidate-hosts", host, "candidate")) test("multi-resource action confirmation preserves comparison baselines, unmounted targets and captured Save/Run", async ({ page }) => {
        await seed(page); await button(page, "Open source review").click(); await button(page, "Add navigation companion").click(); await waitForActions(page); const working = input(page, "Comparison working source"), before = await snapshot(page), baseline = before.bindings.comparison!.baseline;
        await working.focus(); await page.evaluate(at => { const f = window.hostFixture; f.selectSourceSet("comparison", f.snapshot().source.revision, [{ anchor: at + 1, head: at }, { anchor: rawLength(f), head: rawLength(f) }]); function rawLength(f: typeof window.hostFixture) { return f.snapshot().source.length; } }, raw.indexOf("TODO") + 1);
        const selections = (await snapshot(page)).bindings.comparison!.selectionSet; await working.press("Control+."); await waitForActions(page); expect((await snapshot(page)).bindings.actions.capture!.view).toBe("comparison"); await choices(page).nth(1).click(); await waitForActions(page); await expect(edits(page)).toHaveCount(2); await exact(page, raw);
        await button(page, "Apply captured action").click(); await waitForActions(page); await exact(page, marker + raw); expect((await snapshot(page)).bindings.comparison!.baseline).toEqual(baseline); const companion = before.bindings.navigation.companion!; expect(await page.evaluate(id => window.hostFixture.navigationDocument(id).text, companion)).toBe(marker + "const catalogue = 1;\r\ncatalogue;\r\n");
        const open = button(page, "Open action changes in Navigation companion");
        await button(page, "Toggle views").click(); await expect(input(page, "Secondary source")).toHaveCount(0);
        await open.click(); await expect(page.getByLabel("Code action status", { exact: true })).toContainText("source pane");
        await button(page, "Toggle views").click(); await open.click(); await waitForActions(page); await expect(input(page, "Secondary source")).toBeFocused();
        expect((await snapshot(page)).bindings.views.find(v => v.id === "secondary")!.documentId).toBe(companion);
        await input(page, "Secondary source").press("Control+z"); await waitForActions(page); await exact(page, raw); expect((await snapshot(page)).bindings.comparison!.selectionSet).toEqual(selections); await input(page, "Secondary source").press("Control+Shift+z"); await waitForActions(page); await exact(page, marker + raw);
        const reference = input(page, "Comparison baseline source"), requested = (await snapshot(page)).bindings.actions.requested; await reference.press("Control+."); expect((await snapshot(page)).bindings.actions.requested).toBe(requested); await expect(reference).toHaveAttribute("readonly", "");
        await input(page, "Secondary source").focus(); await button(page, "Run captured inputs").click(); expect((await snapshot(page)).pendingRuns[0]!.sourceId).toBe(before.source.id); expect(await page.evaluate(() => window.hostFixture.runCapture(0)!.source)).toBe(marker + raw); await page.evaluate(() => window.hostFixture.finishRun());
        await button(page, "Save source").click(); await working.press("Control+End"); await working.pressSequentially(" later"); await waitForActions(page); await page.evaluate(() => window.hostFixture.finishSave()); await waitForActions(page); await exact(page, marker + raw + " later"); expect((await snapshot(page)).source.dirty).toBe(true); expect((await snapshot(page)).bindings.comparison!.baseline).toEqual(baseline); await dispose(page);
    });
    if (coversHost("plain-candidate", host, "candidate")) test("invalid action replies clear choices and provider titles remain literal", async ({ page }) => {
        await seed(page);
        await button(page, "Add navigation companion").click();
        for (const fault of ["malformed", "incomplete"] as const) {
            await page.evaluate(fault => window.hostFixture.faultActionNext(fault), fault);
            await preview(page);
            expect((await snapshot(page)).bindings.actions.state).toMatchObject({ status: "failed", choices: [], canApply: false });
            await exact(page, raw);
        }
        await page.evaluate(() => window.hostFixture.faultActionNext("markup"));
        await preview(page);
        await expect(choices(page).first()).toContainText("<img");
        await expect(page.getByRole("list", { name: "Provider code actions" }).locator("img,script")).toHaveCount(0);
        expect(await page.evaluate(() => Reflect.get(window, "actionExecuted"))).toBeUndefined();
        for (const fault of ["malformed", "markup"] as const) {
            await preview(page);
            await page.evaluate(fault => window.hostFixture.faultActionNext(fault), fault);
            await choices(page).nth(2).click();
            await waitForActions(page);
            expect((await snapshot(page)).bindings.actions.state).toMatchObject({ status: "failed", choices: [], canApply: false });
            await exact(page, raw);
        }
    });
    if (coversHost("plain-candidate", host, "candidate")) test("project authority changes disable captured actions without editing source or history", async ({ page }) => {
        await seed(page);
        await button(page, "Add navigation companion").click();
        const before = await snapshot(page), companion = before.bindings.navigation.companion!;
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(true));
        await input(page).press("Control+.");
        const status = page.getByLabel("Code action status", { exact: true });
        await expect(status).toContainText("read-only or locked");
        await expect(button(page, "Apply captured action")).toBeDisabled();
        await expect(edits(page)).toHaveCount(1);
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(false));
        await preview(page);
        await choices(page).nth(1).click();
        await page.evaluate(id => window.hostFixture.setProjectTargetReadOnly(id, true), companion);
        await waitForActions(page);
        await expect(button(page, "Apply captured action")).toBeDisabled();
        await preview(page);
        await choices(page).nth(1).click();
        await expect(status).toContainText("read-only or locked");
        expect(await page.evaluate(() => window.hostFixture.snapshot().bindings.actions.state.confirm?.())).toEqual({ status: "not-writable" });
        await waitForActions(page);
        await exact(page, raw);
        expect((await snapshot(page)).history).toEqual(before.history);
        await page.evaluate(id => window.hostFixture.setProjectTargetReadOnly(id, false), companion);
    });
    for (const mode of ["selection", "typing", "remount"] as const) if (coversHost(mode === "remount" ? "candidate-hosts" : "plain-candidate", host, "candidate")) test(`pending action resolution expires after ${mode}`, async ({ page }) => {
        const replies = await holdLspReplies(page, "codeAction/resolve"); await page.reload();
        await seed(page);
        await button(page, "Add navigation companion").click();
        await select(page);
        await preview(page);
        replies.hold();
        await choices(page).nth(2).click();
        await expect.poll(replies.waiting).toBe(true);
        expect((await snapshot(page)).bindings.actions.state.resolving).toBe(true);
        if (mode === "selection") await select(page, raw.indexOf("TODO") + 2);
        else if (mode === "typing") {
            await input(page).press("Control+End");
            await input(page).pressSequentially("x");
            await waitForActions(page);
            await input(page).press("Control+z");
        } else {
            const module = input(page, "Action module"), current = await module.inputValue();
            await module.evaluate(retiring => {
                if (!(retiring instanceof HTMLInputElement)) throw new Error("Missing module field.");
                window.hostFixture.unmount(); window.hostFixture.mount();
                retiring.value = "retired-module";
                retiring.dispatchEvent(new Event("input", { bubbles: true }));
            });
            await expect(module).toHaveValue(current);
        }
        await expect.poll(replies.cancelled).toBe(true); await replies.release();
        await waitForActions(page);
        await expect(button(page, "Apply captured action")).toBeDisabled();
        await exact(page, raw);
    });
    if (coversHost("candidate-hosts", host, "candidate")) test("action disconnect and idle faults require explicit provider recovery", async ({ page }) => {
        const replies = await holdLspReplies(page, "codeAction/resolve");
        await page.addInitScript(() => {
            const send = WebSocket.prototype.send; Reflect.set(window, "actionResolutionSends", 0);
            WebSocket.prototype.send = function(this: WebSocket, data) {
                if (typeof data === "string") { const value = JSON.parse(data);
                    if (value.method === "initialize" && value.params.capabilities.textDocument?.codeAction) Reflect.set(window, "actionTestSocket", this);
                    if (value.method === "codeAction/resolve") Reflect.set(window, "actionResolutionSends", Reflect.get(window, "actionResolutionSends") + 1);
                } send.call(this, data);
            };
        });
        await page.reload();
        await seed(page);
        await button(page, "Add navigation companion").click();
        await select(page);
        await preview(page);
        const resolutions = await page.evaluate(() => Reflect.get(window, "actionResolutionSends") as number);
        replies.hold();
        await choices(page).nth(2).click();
        await expect.poll(() => page.evaluate(() => Reflect.get(window, "actionResolutionSends") as number)).toBeGreaterThan(resolutions);
        await expect.poll(replies.waiting).toBe(true);
        // The response remains withheld while its original transport closes.
        await page.evaluate(() => (Reflect.get(window, "actionTestSocket") as WebSocket).send(JSON.stringify({ jsonrpc: "2.0", method: "fixture/disconnect" })));
        await waitForActions(page);
        await expect(button(page, "Reconnect action provider")).toBeEnabled();
        await exact(page, raw);
        await button(page, "Reconnect action provider").click();
        await select(page);
        await preview(page);
        await page.evaluate(() => window.hostFixture.faultIdleAction());
        await waitForActions(page);
        await expect(button(page, "Apply captured action")).toBeDisabled();
        await button(page, "Reconnect action provider").click();
        await select(page);
        await preview(page);
        await expect(button(page, "Apply captured action")).toBeEnabled();
        await dispose(page);
    });
    if (coversHost("plain-candidate", host, "candidate")) test("confirmed action commands preserve ordered edits, wire arguments and complete history without automatic execution", async ({ page }) => {
        await seed(page); await button(page, "Add navigation companion").click(); const before = await snapshot(page);
        await preview(page); await choices(page).nth(4).click(); await expect(button(page, "Execute captured action")).toBeEnabled(); expect(await control(page, "fixture/lastCommand", {})).toBeNull(); await exact(page, raw);
        await button(page, "Execute captured action").click(); await waitForActions(page); expect((await snapshot(page)).bindings.actions.state.status).toBe("executed"); expect((await snapshot(page)).history).toEqual(before.history); expect((await control(page, "fixture/lastCommand", {})).command).toBe("fixture.status");
        await select(page); const ranges = [{ anchor: raw.indexOf("TODO") + 4, head: raw.indexOf("TODO") + 1 }, { anchor: raw.length, head: raw.length }]; await page.evaluate(ranges => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, ranges); }, ranges); await preview(page); await choices(page).nth(8).click(); await expect(button(page, "Execute captured action")).toBeDisabled(); expect(await page.evaluate(() => window.hostFixture.snapshot().bindings.actions.state.confirm?.())).toEqual({ status: "disabled" }); await exact(page, raw);
        await choices(page).nth(5).click();
        const confirm = await page.evaluateHandle(() => window.hostFixture.snapshot().bindings.actions.state.confirm!);
        await button(page, "Register provider review command").click();
        await expect.poll(async () => (await snapshot(page)).bindings.project.pending).toBe(false);
        await button(page, "Request provider review edits").click(); await review(page);
        const previousCommand = await control(page, "fixture/lastCommand", {});
        await expect(button(page, "Execute captured action")).toBeDisabled();
        const refused = await confirm.evaluate(invoke => invoke());
        const afterRefusal = (await snapshot(page)).bindings.actions.state;
        await exact(page, raw); expect((await snapshot(page)).history).toEqual(before.history);
        expect(await control(page, "fixture/lastCommand", {})).toEqual(previousCommand);
        expect(await confirm.evaluate(invoke => invoke === window.hostFixture.snapshot().bindings.actions.state.confirm)).toBe(true);
        expect({ result: refused, status: afterRefusal.status, message: afterRefusal.message }).toMatchObject({
            result: { status: "declined" }, status: "ready", message: expect.stringContaining("retry"),
        });
        await button(page, "Decline captured provider edits").click();
        await expect(button(page, "Execute captured action")).toBeEnabled();
        expect(await confirm.evaluate(invoke => invoke())).toEqual({ status: "executing" });
        await waitForActions(page); await exact(page, marker + raw);
        expect(await confirm.evaluate(invoke => invoke())).toEqual({ status: "expired" });
        await confirm.dispose();
        const receipt = await control(page, "fixture/lastCommand", {}); expect(receipt.arguments).toEqual([]); expect(receipt.documents.some((doc: any) => doc.prefix.startsWith(marker))).toBe(true); expect(receipt.documents.every((doc: any) => doc.version >= 1)).toBe(true); expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
        await button(page, "Open action changes in Navigation companion").click(); await input(page, "Secondary source").press("Control+z"); await waitForActions(page); await exact(page, raw); expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selectionSet.ranges.map(range => ({ anchor: range.anchor, head: range.head }))).toEqual(ranges); await input(page, "Secondary source").press("Control+Shift+z"); await waitForActions(page); await exact(page, marker + raw); await dispose(page);
    });
    if (coversHost("plain-candidate", host, "candidate")) test("action commands share the captured workspace decision owner and retain initial edits when later decisions fail", async ({ page }) => {
        await seed(page); await button(page, "Add navigation companion").click(); const before = await snapshot(page); await button(page, "Register provider review command").click(); await expect.poll(async () => (await snapshot(page)).bindings.project.pending).toBe(false);
        await preview(page); await choices(page).nth(6).click(); await button(page, "Request provider review edits").click(); await review(page); await expect(button(page, "Execute captured action")).toBeDisabled(); await button(page, "Decline captured provider edits").click(); await expect.poll(async () => (await snapshot(page)).bindings.project.pending).toBe(false); await expect(button(page, "Execute captured action")).toBeEnabled(); await button(page, "Execute captured action").click(); await review(page); await exact(page, raw); await expect(button(page, "Request provider review edits")).toBeDisabled(); const captured = await page.evaluateHandle(() => window.hostFixture.snapshot().bindings.project.state.review!); expect(await page.evaluate(() => window.hostFixture.faultIdleProject())).toBe(true); await expect.poll(async () => (await snapshot(page)).bindings.project.transport).toBeNull(); expect((await snapshot(page)).bindings.project.state.review).toBeNull();
        await waitForActions(page); await captured.evaluate(review => review.apply()); await exact(page, raw); expect((await snapshot(page)).history).toEqual(before.history); await button(page, "Reconnect action provider").click();
        await select(page); await preview(page); await choices(page).nth(7).click(); await button(page, "Execute captured action").click(); await review(page); await exact(page, marker + raw); const receipt = await control(page, "fixture/lastCommand", {}); expect(receipt.command).toBe("fixture.review"); expect(receipt.arguments[0]).toMatchObject({ expectedPrefix: marker, opaque: { note: "😀" } }); expect(receipt.documents.find((doc: any) => doc.uri === receipt.arguments[0].uri).prefix).toContain(marker);
        await captured.evaluate(review => review.apply()); await exact(page, marker + raw); expect((await snapshot(page)).bindings.project.state.review).not.toBeNull(); await button(page, "Apply captured provider edits").click(); await waitForActions(page); await exact(page, header + marker + raw + footer); expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 2);
        await input(page).press("Control+z"); await waitForActions(page); await exact(page, marker + raw); await input(page).press("Control+z"); await waitForActions(page); await exact(page, raw);
        for (const fault of ["malformed", "failure"] as const) { await select(page); await preview(page); await choices(page).nth(7).click(); const consumed = await faultCommand(page, fault); await button(page, "Execute captured action").click(); await waitForActions(page); await consumed(); await exact(page, marker + raw); await expect(page.getByLabel("Code action status", { exact: true })).toContainText("undo"); await input(page).press("Control+z"); await waitForActions(page); await exact(page, raw); if ((await snapshot(page)).bindings.actions.state.disconnected || (await snapshot(page)).bindings.actions.state.reconnectRequired) await button(page, "Reconnect action provider").click(); }
        await dispose(page);
    });
    for (const mode of ["selection", "authority", "typing", "remount", "withdraw", "disconnect", "cancel"] as const) if (coversHost(mode === "remount" ? "candidate-hosts" : "plain-candidate", host, "candidate")) test(`action-command review expires after ${mode} without undoing its committed phase`, async ({ page }) => {
        await seed(page);
        await button(page, "Add navigation companion").click();
        const before = await snapshot(page), companion = before.bindings.navigation.companion!;
        await select(page);
        await preview(page);
        await choices(page).nth(7).click();
        await button(page, "Execute captured action").click();
        await review(page);
        await exact(page, marker + raw);
        const captured = await page.evaluateHandle(() => window.hostFixture.snapshot().bindings.project.state.review!);
        if (mode === "selection") await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 3, head: 3 }]); });
        else if (mode === "authority") await page.evaluate(id => window.hostFixture.setProjectTargetReadOnly(id, true), companion);
        else if (mode === "typing") { await input(page).press("Control+End"); await input(page).pressSequentially("x"); }
        else if (mode === "remount") await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
        else if (mode === "withdraw") await control(page, "fixture/reviewRegistration", { registered: false }, false);
        else if (mode === "disconnect") await control(page, "fixture/disconnect");
        else await button(page, "Dismiss action preview").click();
        await waitForActions(page);
        await captured.evaluate(review => review.apply());
        if (mode === "authority") await page.evaluate(id => window.hostFixture.setProjectTargetReadOnly(id, false), companion);
        if (mode === "typing") { await input(page).press("Control+z"); await waitForActions(page); }
        await exact(page, marker + raw);
        await expect(page.getByLabel("Code action status", { exact: true })).toContainText("undo");
        await input(page).press("Control+z");
        await waitForActions(page);
        await exact(page, raw);
        await dispose(page);
    });
    if (coversHost("candidate-hosts", host, "candidate")) test("action-command acknowledgement loss preserves history without replay after reconnect", async ({ page }) => {
        await seed(page);
        await button(page, "Add navigation companion").click();
        const before = await snapshot(page);
        let executed = 0;
        page.on("websocket", socket => socket.on("framesent", frame => { if (JSON.parse(frame.payload.toString()).method === "workspace/executeCommand") executed++; }));
        await select(page);
        await preview(page);
        await choices(page).nth(7).click();
        const consumed = await faultCommand(page, "ack");
        await button(page, "Execute captured action").click();
        await review(page);
        await button(page, "Apply captured provider edits").click();
        await waitForActions(page);
        await exact(page, header + marker + raw + footer);
        expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 2);
        await expect(button(page, "Reconnect action provider")).toBeEnabled();
        await consumed();
        const count = executed;
        await button(page, "Reconnect action provider").click();
        await select(page);
        await preview(page);
        expect(executed).toBe(count);
        await button(page, "Dismiss action preview").click();
        await input(page).press("Control+z");
        await waitForActions(page);
        await exact(page, marker + raw);
        await input(page).press("Control+z");
        await waitForActions(page);
        await exact(page, raw);
        await dispose(page);
    });
    if (coversHost("candidate-hosts", host, "candidate")) test("comparison action commands retain phase history, bounded review and primary Save/Run ownership", async ({ page }) => {
        test.setTimeout(90000); const text = "// 😀 TODO\r\n" + "const unchanged = 123;\r\n" + "// TODO\r\n".repeat(134); await seed(page, text); await button(page, "Open source review").click(); await button(page, "Add navigation companion").click(); await waitForActions(page); const working = input(page, "Comparison working source"), before = await snapshot(page), baseline = before.bindings.comparison!.baseline;
        await working.focus(); await preview(page); await choices(page).nth(7).click(); await control(page, "fixture/projectStyle", { style: "many" });
        await button(page, "Execute captured action").click(); await review(page); await exact(page, marker + text);
        const list = page.getByRole("list", { name: "Captured provider edits", exact: true }), next = button(page, "Next provider edits");
        await expect(list.locator("li")).toHaveCount(64);
        await next.focus(); await page.keyboard.down("Space");
        await next.evaluate(node => (node as HTMLButtonElement).click()); await expect(list).toHaveAttribute("start", "65");
        await page.keyboard.up("Space"); await expect(list).toHaveAttribute("start", "65"); await expect(next).toBeFocused();
        const capturedNotes = await page.evaluateHandle(() => window.hostFixture.snapshot().bindings.project.state.review!.notes);
        await working.focus();
        expect(await capturedNotes.evaluate(notes => window.hostFixture.snapshot().bindings.project.state.review!.notes === notes)).toBe(true);
        await capturedNotes.dispose();
        await next.click(); await expect(list).toHaveAttribute("start", "129");
        await expect(list.locator("li")).toHaveCount((await snapshot(page)).bindings.project.state.review!.count - 128);
        await button(page, "Apply captured provider edits").click(); await waitForActions(page); const expected = header + marker + text.replaceAll("TODO", "DONE") + footer; await exact(page, expected); expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 2); expect((await snapshot(page)).bindings.comparison!.baseline).toEqual(baseline);
        await button(page, "Open action changes in Navigation companion").click(); await button(page, "Run captured inputs").click(); expect((await snapshot(page)).pendingRuns[0]!.sourceId).toBe(before.source.id); expect(await page.evaluate(() => window.hostFixture.runCapture(0)!.source)).toBe(expected); await page.evaluate(() => window.hostFixture.finishRun());
        await button(page, "Save source").click(); await working.press("Control+End"); await working.pressSequentially(" later"); await waitForActions(page); await page.evaluate(() => window.hostFixture.finishSave()); await waitForActions(page); await exact(page, expected + " later"); expect((await snapshot(page)).source.dirty).toBe(true); expect((await snapshot(page)).bindings.comparison!.baseline).toEqual(baseline); expect((await snapshot(page)).source.exports).toBe(0); expect((await snapshot(page)).bindings.views.every(view => !view.metrics || view.metrics.inputUnits <= 4096 && view.metrics.viewport.rows < 100)).toBe(true); await dispose(page);
    });
    if (coversHost("plain-candidate", host, "candidate")) test("resolved actions page bounded previews and apply every edit as one undo command", async ({ page }) => {
        test.setTimeout(90000); const text = "// 😀 TODO\r\n" + "const unchanged = 123;\r\n" + "// TODO\r\n".repeat(70); await seed(page, text); const before = await snapshot(page); await preview(page); await choices(page).nth(2).click(); await waitForActions(page); expect((await snapshot(page)).bindings.actions.state.editCount).toBe(71); await expect(edits(page)).toHaveCount(64);
        await releaseAfterReplacement(page, "edits", async () => {
            await choices(page).nth(1).evaluate(node => (node as HTMLButtonElement).click());
            await choices(page).nth(2).evaluate(node => (node as HTMLButtonElement).click()); await waitForActions(page);
        });
        await expect(edits(page)).toHaveCount(64); await button(page, "Next action edits").click(); await expect(edits(page)).toHaveCount(7); await button(page, "Apply captured action").click(); await waitForActions(page); await exact(page, text.replaceAll("TODO", "DONE"));
        await input(page).press("Control+z"); await waitForActions(page); await exact(page, text); await input(page).press("Control+Shift+z"); await waitForActions(page); await exact(page, text.replaceAll("TODO", "DONE")); expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1); expect((await snapshot(page)).source.exports).toBe(0); expect((await snapshot(page)).bindings.views.every(v => v.metrics!.inputUnits <= 4096 && v.metrics!.viewport.rows < 100)).toBe(true); await dispose(page);
    });
});
