import { ready, isolatedTest as test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { publishFixtureDiagnostics, sourceDiagnosticUri } from "./fixture-diagnostics.ts";
import { holdLspReplies } from "../helpers/lsp-replies.ts";
// Explicit background process ownership also avoids the known Firefox context-deletion issue.

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

for (const mode of ["plain", "react"] as const) test.describe(`${mode} LSP editor host`, () => {
    test.beforeEach(async ({ page }) => {
         await page.goto(`/hosts/${mode}/?editor=candidate&language=lsp`); await expect(field(page)).toBeVisible(); await ready(page);
    });
    test("actual typing, insert/replace choices and additional edits share history across views", async ({ page }) => {
        const packets: string[] = []; page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()) as { method?: string }; if (value.method) packets.push(value.method); }));
        const original = "// 😀\r\nconst saMORE = 1; // TODO\r\n"; await seed(page, original);
        await field(page).pressSequentially("x"); const typed = original.replace("saMORE", "saxMORE"); expect(await source(page)).toBe(typed);
        await expect.poll(async () => (await provider(page)).connected).toBe(true); await page.evaluate(() => window.hostFixture.providerCustom("fixture/completionStyle", { style: "defaults" }));
        await offer(page); expect((await provider(page)).transport).toBe("lsp3.17"); await button(page, "Insert completion").click(); await ready(page);
        expect(await source(page)).toBe(typed.replace("saxMORE", "sampleMORE"));
        await field(page, "Secondary source").press("Control+z"); expect(await source(page)).toBe(typed);
        await seed(page, typed, typed.indexOf("saxMORE") + 3); await offer(page); const depth = (await snapshot(page)).history.undoDepth;
        await page.getByRole("option", { name: "sampleWithImport", exact: true }).getByRole("button").click(); await button(page, "Replace completion").click(); await ready(page);
        const replaced = "// fixture import\r\n" + typed.replace("saxMORE", "sampleValue"); expect(await source(page)).toBe(replaced); expect((await snapshot(page)).history.undoDepth).toBe(depth + 1);
        await field(page, "Secondary source").press("Control+z"); expect(await source(page)).toBe(typed); await field(page, "Secondary source").press("Control+Shift+z"); expect(await source(page)).toBe(replaced);
        expect(packets).toContain("initialize"); expect(packets).toContain("textDocument/completion"); expect(packets).toContain("textDocument/didChange");
        await expect(page.getByLabel("Source diagnostics", { exact: true }).getByRole("button")).toHaveCount(1); expect((await snapshot(page)).source.exports).toBe(0);
    });
    test("ordinary prefix growth retains choices and accepts a keyboard selection with one undo transaction", async ({ page }) => {
        const calls: unknown[] = []; page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method === "textDocument/completion") calls.push(value.params.context); }));
        await seed(page, "const sMORE = 1; // TODO\r\n", 7); await field(page).pressSequentially("a");
        await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible(); const count = calls.length;
        await field(page).pressSequentially("m"); await ready(page); await expect(page.getByRole("option", { name: "sampleWithImport", exact: true })).toBeVisible();
        expect(calls.length).toBe(count); expect(calls[0]).toEqual({ triggerKind: 1 }); const typed = await source(page), depth = (await snapshot(page)).history.undoDepth;
        await field(page).press("Shift+ArrowDown"); await ready(page); await expect(page.getByRole("option")).toHaveCount(0);
        const selected = (await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selection; expect(selected.anchor).not.toBe(selected.head);
        await page.evaluate(() => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: 9, head: 9 }); }); await offer(page);
        await page.evaluate(() => { const choices = window.hostFixture.providerState()!.choices!; if (!Object.isFrozen(choices)) throw new Error("Completion choices must be immutable."); Reflect.set(window, "retainedCompletionChoices", choices); });
        await publishFixtureDiagnostics(page, await sourceDiagnosticUri(page), "clear");
        await field(page).press("ArrowDown");
        expect(await page.evaluate(() => window.hostFixture.providerState()!.choices === Reflect.get(window, "retainedCompletionChoices"))).toBe(true);
        await field(page).press("Enter"); await ready(page);
        const expected = "// fixture import\r\nconst sampleValue = 1; // TODO\r\n"; expect(await source(page)).toBe(expected); expect((await snapshot(page)).history.undoDepth).toBe(depth + 1);
        expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selection).toMatchObject({ anchor: expected.indexOf("sampleValue") + 11, head: expected.indexOf("sampleValue") + 11 });
        await field(page, "Secondary source").press("Control+z"); expect(await source(page)).toBe(typed); await field(page, "Secondary source").press("Control+Shift+z"); expect(await source(page)).toBe(expected);
    });
    test("advertised punctuation triggers completion and Escape preserves the typed source", async ({ page }) => {
        const calls: unknown[] = []; page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method === "textDocument/completion") calls.push(value.params.context); }));
        await seed(page, "object", 6); await expect.poll(async () => (await provider(page)).connected).toBe(true); await field(page).pressSequentially(".");
        await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible(); expect(calls.at(-1)).toEqual({ triggerKind: 2, triggerCharacter: "." });
        await field(page).press("Escape"); await expect(page.getByRole("option")).toHaveCount(0); expect(await source(page)).toBe("object.");
        await field(page).press("Tab"); await expect(field(page)).toBeFocused(); expect(await source(page)).toBe("object. ");
        await field(page).press("Control+z"); expect(await source(page)).toBe("object.");
    });
    if (mode === "plain") for (const completed of [false, true]) test(`${completed ? "empty" : "pending"} invisible completion preserves Escape focus traversal`, async ({ page }) => {
        const replies = await holdLspReplies(page, "textDocument/completion"); await page.reload();
        await seed(page, "const ", 6); await expect.poll(async () => (await provider(page)).connected).toBe(true);
        replies.hold(); await field(page).pressSequentially("z"); await expect.poll(replies.waiting).toBe(true);
        expect((await provider(page)).pending).toBe(true); await expect(page.getByRole("option")).toHaveCount(0);
        if (completed) { await replies.release(); await expect.poll(async () => (await provider(page)).pending).toBe(false); }
        const before = await snapshot(page), selection = before.bindings.views.find(view => view.id === "primary")!.selection;
        await field(page).press("Escape"); await page.keyboard.press(completed ? "Shift+Tab" : "Tab");
        const target = completed ? button(page, "Inject form error") : field(page, "Configuration path");
        await expect(target).toBeFocused();
        if (!completed) { await expect.poll(replies.cancelled).toBe(true); await replies.release(); }
        await expect(target).toBeFocused(); await expect(page.getByRole("option")).toHaveCount(0);
        const after = await snapshot(page); expect(after.source.revision).toBe(before.source.revision); expect(after.history).toEqual(before.history);
        expect(after.bindings.views.find(view => view.id === "primary")!.selection).toEqual(selection); expect(await source(page)).toBe("const z");
        await page.keyboard.press(completed ? "Tab" : "Shift+Tab"); await expect(field(page)).toBeFocused();
        expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selection).toEqual(selection);
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 });
    });
    test("incomplete prefix lists refresh, filter provider metadata, resolve and commit with one shared undo", async ({ page }) => {
        const contexts: unknown[] = []; page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method === "textDocument/completion") contexts.push(value.params.context); }));
        await seed(page, "const sMORE = 1;", 7); await expect.poll(async () => (await provider(page)).connected).toBe(true);
        await page.evaluate(() => window.hostFixture.providerCustom("fixture/completionStyle", { style: "incomplete" }));
        await field(page).pressSequentially("a"); await expect(page.getByLabel("Completion detail", { exact: true })).toContainText("Resolved sample");
        await expect(page.getByRole("option", { name: "Displayed sibling", exact: true })).toHaveCount(0);
        await field(page).pressSequentially("mpleV"); await expect.poll(() => contexts).toContainEqual({ triggerKind: 3 });
        await expect.poll(async () => (await provider(page)).pending).toBe(false);
        await expect(page.getByRole("option", { name: "sample", exact: true })).toHaveCount(0); await expect(page.getByRole("option", { name: "sampleWithImport", exact: true })).toBeVisible();
        await field(page).press("ArrowDown"); await expect(page.getByLabel("Completion detail", { exact: true })).toContainText("Resolved sampleWithImport");
        await expect.poll(async () => (await provider(page)).pending).toBe(false);
        await expect(page.getByLabel("Completion detail", { exact: true })).toContainText("<b>Literal completion detail</b>"); expect(await page.locator(".host-language b").count()).toBe(0);
        const typed = await source(page), depth = (await snapshot(page)).history.undoDepth; await field(page).pressSequentially(";"); await ready(page);
        const expected = "// resolved import\r\nconst sampleValue; = 1;"; expect(await source(page)).toBe(expected); expect((await snapshot(page)).history.undoDepth).toBe(depth + 1);
        expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selection.head).toBe(expected.indexOf("sampleValue;") + 12);
        await field(page, "Secondary source").press("Control+z"); expect(await source(page)).toBe(typed);
        await field(page, "Secondary source").press("Control+Shift+z"); expect(await source(page)).toBe(expected);
    });
    test("pending acceptance applies once and expires on selection, focus or document changes", async ({ page }) => {
        let hold = true, release: (() => void) | undefined;
        await page.routeWebSocket("**/lsp-fixture", client => {
            const server = client.connectToServer(), held = new Set<number>();
            client.onMessage(message => { const value = JSON.parse(message.toString());
                if (hold && value.method === "completionItem/resolve") { hold = false; held.add(value.id); } server.send(message); });
            server.onMessage(message => { const value = JSON.parse(message.toString());
                if (held.delete(value.id)) release = () => client.send(message); else client.send(message); });
        });
        await page.reload(); await expect(field(page)).toBeVisible(); await ready(page);
        const pending = async () => {
            await field(page).pressSequentially("a"); await expect.poll(() => !!release).toBe(true);
            // Editor completion must not wait for this deliberately withheld provider reply.
            await ready(page); expect(release).toBeDefined();
        };
        const complete = async () => { const send = release!; release = undefined; send();
            // The subsequent reply proves the held response reached the client before assertions.
            await page.evaluate(() => window.hostFixture.providerCustom("fixture/state", {})); };
        await seed(page, "const sMORE = 1;", 7); await expect.poll(async () => (await provider(page)).connected).toBe(true);
        await page.evaluate(() => window.hostFixture.providerCustom("fixture/completionStyle", { style: "interactive" }));
        await pending();
        await page.evaluate(() => Reflect.set(window, "retainedCompletionChoices", window.hostFixture.providerState()!.choices));
        await field(page).press("Tab"); await field(page).press("ArrowDown"); await expect(page.getByLabel("Completion detail", { exact: true })).toContainText("Resolved sampleWithImport");
        expect(await page.evaluate(() => window.hostFixture.providerState()!.choices === Reflect.get(window, "retainedCompletionChoices"))).toBe(true);
        await complete(); await expect(page.getByLabel("Completion detail", { exact: true })).toContainText("Resolved sampleWithImport");
        await field(page).press("Tab"); await ready(page); expect(await source(page)).toBe("// resolved import\r\nconst sampleValueMORE = 1;");
        await seed(page, "const sMORE = 1;", 7);
        hold = true; await pending();
        const depth = (await snapshot(page)).history.undoDepth;
        await field(page).press("Enter"); expect(await source(page)).toBe("const saMORE = 1;");
        await complete();
        await expect.poll(() => source(page)).toBe("const sample = 1;"); expect((await snapshot(page)).history.undoDepth).toBe(depth + 1);
        await field(page).press("Control+z"); expect(await source(page)).toBe("const saMORE = 1;");
        await seed(page, "const sMORE = 1;", 7);
        hold = true; await pending();
        await field(page).press("Tab"); await field(page, "Secondary source").focus(); await complete();
        expect(await source(page)).toBe("const saMORE = 1;");
        await seed(page, "const sMORE = 1;", 7);
        hold = true; await pending();
        await field(page).press("Tab"); await field(page).pressSequentially(";"); await complete(); await ready(page);
        expect(await source(page)).toBe("const sa;MORE = 1;"); await expect(page.getByRole("option")).toHaveCount(0);
    });
    test("synthetic composition suppresses premature requests and rapid typing cancels bounded automatic work", async ({ page }) => {
        const methods: string[] = []; page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method) methods.push(value.method); }));
        await seed(page, "const saMORE", 8); await expect.poll(async () => (await provider(page)).connected).toBe(true);
        await field(page).evaluate(node => { const input = node as HTMLTextAreaElement; input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
            input.setRangeText("m", input.selectionStart, input.selectionEnd, "end"); input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true })); });
        expect(methods.filter(method => method === "textDocument/completion")).toHaveLength(0); await expect(page.getByRole("option")).toHaveCount(0);
        await field(page).evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "m" })));
        await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible(); expect(await source(page)).toBe("const samMORE");
        await field(page).press("Escape"); await seed(page, "const s", 7); await page.evaluate(() => window.hostFixture.setProviderDelay(300));
        const count = (await provider(page)).posted; await field(page).pressSequentially("a"); await expect.poll(async () => (await provider(page)).pending).toBe(true);
        await field(page).pressSequentially("mple"); await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible();
        await expect.poll(async () => (await provider(page)).pending).toBe(false); expect(await source(page)).toBe("const sample");
        const state = await provider(page); expect(state.posted - count).toBeLessThanOrEqual(5); expect(state.protocol?.pendingDocumentRequests).toBe(0); expect(state.protocol?.pendingRequests).toBe(0);
        await page.evaluate(() => window.hostFixture.providerCustom("fixture/completionStyle", { style: "interactive" })); await field(page).press("Control+Space");
        await expect(page.getByLabel("Completion detail", { exact: true })).toContainText("Resolved");
        await page.evaluate(() => window.hostFixture.providerCustom("fixture/unregister", { unregisterations: [{ id: "fixture-completion", method: "textDocument/completion" }] }));
        await expect(page.getByRole("option")).toHaveCount(0); expect(await source(page)).toBe("const sample");
    });
    test("diagnostic pushes preserve uncertain markers, reject malformed/stale batches and retain unplaceable messages", async ({ page }) => {
        await seed(page, "const saMORE = 1; // TODO\r\n"); await offer(page); await button(page, "Cancel request").click();
        const diagnostics = page.getByLabel("Source diagnostics", { exact: true }); await expect(diagnostics.getByRole("button")).toHaveCount(1);
        await diagnostics.getByRole("button").evaluate(node => { node.dataset.retained = "diagnostic"; });
        const before = await provider(page), uri = await sourceDiagnosticUri(page); await publishFixtureDiagnostics(page, uri, "malformed");
        await expect.poll(async () => (await provider(page)).invalid).toBe(before.invalid + 1); await expect(diagnostics.getByRole("button")).toHaveCount(1);
        await publishFixtureDiagnostics(page, uri, "stale"); await expect.poll(async () => (await provider(page)).stale).toBe(before.stale + 1);
        await publishFixtureDiagnostics(page, uri, "unversioned"); await expect(diagnostics.getByRole("button")).toHaveCount(1);
        await expect(page.getByLabel("Unversioned diagnostics", { exact: true })).toContainText("Resolve this placeholder.");
        await expect(diagnostics.getByRole("button")).toHaveAttribute("data-retained", "diagnostic");
        await diagnostics.getByRole("button").click(); expect((await snapshot(page)).bindings.views.find(view => view.id === "primary")!.selection).toMatchObject({ anchor: 21, head: 25 });
        await publishFixtureDiagnostics(page, uri, "out-of-bounds"); await expect(diagnostics.getByRole("button")).toHaveCount(1);
        await expect(page.getByLabel("Unversioned diagnostics", { exact: true })).toContainText("Unplaceable diagnostic (range outside the current snapshot)");
        await publishFixtureDiagnostics(page, uri, "html"); await expect(diagnostics).toContainText("<img src=x onerror=unsafe()>"); expect(await page.locator('img[src="x"]').count()).toBe(0);
        await publishFixtureDiagnostics(page, uri, "clear"); await expect(diagnostics.getByRole("button")).toHaveCount(0);
        await field(page).focus(); await page.evaluate(() => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: 8, head: 8 }); });
        await page.evaluate(() => window.hostFixture.faultProviderNext("malformed")); await field(page).press("Control+Space"); await expect(page.getByLabel("Language status", { exact: true })).toContainText("Malformed"); await expect(page.getByRole("option")).toHaveCount(0);
        await page.evaluate(() => window.hostFixture.providerCustom("fixture/completionStyle", { style: "plain" })); await offer(page); await field(page).press("Alt+Enter"); expect(await source(page)).toBe("const sample = 1; // TODO\r\n");
    });
    test("pending results expire on navigation, authority changes and remount; outage preserves typing", async ({ page }) => {
        let requests = 0;
        page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method === "textDocument/completion") requests++; }));
        const original = "const saMORE = 1; // TODO"; await seed(page, original); await offer(page); await button(page, "Cancel request").click();
        const sent = requests;
        await field(page).focus(); await field(page).evaluate(node => {
            // Cancellation precedes asynchronous preparation and must send no completion.
            window.hostFixture.requestProvider();
            node.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        });
        await expect.poll(async () => (await provider(page)).pending).toBe(false); await offer(page);
        expect(requests).toBe(sent + 1);
        await button(page, "Cancel request").click();
        await page.evaluate(() => window.hostFixture.setProviderDelay(1000)); await field(page).press("Control+Space"); await expect.poll(async () => (await provider(page)).pending).toBe(true);
        await field(page).press("ArrowRight"); await expect.poll(async () => (await provider(page)).pending).toBe(false); await expect(page.getByRole("option")).toHaveCount(0);
        await page.evaluate(() => window.hostFixture.setProviderDelay(0)); await offer(page);
        const choice = await page.evaluateHandle(() => window.hostFixture.providerState()!.completionAt(0)!);
        await button(page, "Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await button(page, "Finish save").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(0);
        expect(await choice.evaluate(item => item.select())).toBe(true); await choice.dispose(); await expect(page.getByRole("option")).toHaveCount(2);
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(true));
        await expect(page.getByRole("option")).toHaveCount(0); expect(await source(page)).toBe(original); await page.evaluate(() => window.hostFixture.setSourceReadOnly(false));
        await button(page, "Disconnect provider").click(); await field(page).pressSequentially("x"); expect(await source(page)).toBe(original.replace("saMORE", "saMxORE"));
        await button(page, "Reconnect provider").click(); await expect.poll(async () => (await provider(page)).connected).toBe(true); await offer(page);
        await page.evaluate(() => window.hostFixture.setProviderDelay(1000)); await field(page).press("Control+Space"); await page.evaluate(() => window.hostFixture.unmount()); await page.evaluate(() => window.hostFixture.mount()); await ready(page);
        await expect(page.getByRole("option")).toHaveCount(0); expect((await snapshot(page)).bindings.language.sessions.every(session => !session.provider.pending)).toBe(true);
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 }); expect((await snapshot(page)).hostSubscriptions).toBe(0);
    });
});
