import { mountShadowEditor } from "./shadow-editor.ts";
import { isolatedTest, expect } from "./fixtures.ts";
import { presentationTest as test } from "./presentation-fixture.ts";
import { paintedCharacter } from "../helpers/painted-character.ts";

test("a saved color action cannot open or displace a picker after editing and Undo", async ({ page }) => {
    const fixture = await page.evaluateHandle(async () => {
        const path = "/presentation-fixture/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { BrowserLspWorkspace, attachEditorLanguage, mountTextEditor, openWebSocketTransport } =
            await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace();
        const file = workspace.createTextResource({ scope: "test", resource: "colors", variant: "working" }, "Colors",
            { value: '"#5fae99"', language: { uri: "fixture:/colors", languageId: "generic" } });
        const host = document.body.appendChild(document.createElement("main"));
        host.style.height = "220px";
        const editor = mountTextEditor(host, workspace, file.id, { ariaLabel: "Colors" });
        const provider = new BrowserLspWorkspace(workspace, {
            connect: signal => openWebSocketTransport("ws://" + location.host + "/lsp-fixture", { signal }),
        });
        const { colors } = attachEditorLanguage(editor, provider, { colors: { picker: true } });
        await provider.connect();
        async function discover() {
            const result = await colors.request();
            if (result.status !== "done" || !result.value.length) throw new Error("Expected a document color.");
            return result.value[0]!;
        }
        const choice = await discover();
        const mark = colors.colorAt(choice.from)!;
        return {
            retired: () => [colors.openPicker(mark), colors.openPicker(choice)],
            open: async () => colors.openPicker(await discover()),
            dispose() { editor.dispose(); provider.dispose(); },
        };
    });
    const source = page.getByRole("textbox", { name: "Colors", exact: true });
    await source.press("End");
    await source.press("x");
    await source.press("ControlOrMeta+z");
    expect(await fixture.evaluate(api => api.open())).toBe(true);
    const picker = page.getByRole("dialog", { name: "Color picker" });
    await expect(picker.getByRole("combobox", { name: "Format" })).toBeEnabled();
    expect(await fixture.evaluate(api => api.retired())).toEqual([false, false]);
    await expect(picker.getByLabel("Color", { exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(source).toBeFocused();
    await fixture.evaluate(api => api.dispose());
});

test("definition lookup uses its attached scope and recovers from a refused mount", async ({ page }) => {
    const fixture = await page.evaluateHandle(async () => {
        const path = "/presentation-fixture/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { BrowserLspWorkspace, attachEditorLanguage, mountTextEditor, openWebSocketTransport } =
            await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace();
        const source = workspace.createTextResource({ scope: "test", resource: "source", variant: "working" }, "Source",
            {
                value: "const catalogue = 1;\ncatalogue",
                language: { uri: "fixture:/source", languageId: "generic" },
            });
        const host = document.createElement("main"); host.style.height = "240px"; document.body.append(host);
        const editor = mountTextEditor(host, workspace, source.id);
        const connect = (signal: AbortSignal) => openWebSocketTransport("ws://" + location.host + "/lsp-fixture", { signal });
        const provider = new BrowserLspWorkspace(workspace, { maxScopes: 1, connect });
        const ownership = () => { const { leases, subscriptions } = workspace.diagnostics(); return { leases, subscriptions }; };
        const occupied = provider.createScope();
        const before = ownership();
        let refusal = "", retiredHits = 0, pointerHits = 0;
        try {
            attachEditorLanguage(editor, provider, { navigation: { linkAt() { retiredHits++; return undefined; } } });
        } catch (error) { refusal = String(error); }
        const after = ownership();
        occupied.dispose();
        let cancelLookup = true;
        let prepared = 0;
        const language = attachEditorLanguage(editor, provider, {
            navigation: {
                linkAt() { pointerHits++; return undefined; },
                documents() {
                    if (cancelLookup) {
                        cancelLookup = false;
                        navigation.cancel();
                    }
                    return [workspace.document(source.id)];
                },
                prepareRequest() { prepared++; return undefined; },
            },
        });
        const sibling = attachEditorLanguage(editor, provider, { rename: {} });
        sibling.dispose();
        sibling.dispose();
        const { navigation } = language;
        return { ownership, pointerHits: () => pointerHits, before, after, refusal, retiredHits: () => retiredHits,
            cancelNext() { cancelLookup = true; }, cancelled: () => !cancelLookup, prepared: () => prepared,
            lookup: async () => {
                const result = await navigation.request("definition", 23);
                if (result.status === "done") return result.value.locationAt(0)?.from;
                return result.status === "failed" && result.error instanceof Error ? result.error.message : result.status;
            },
            finish() { language.dispose(); provider.dispose(); editor.dispose(); } };
    });
    expect(await fixture.evaluate(f => f.refusal)).toContain("scope limit");
    expect(await fixture.evaluate(f => f.after)).toEqual(await fixture.evaluate(f => f.before));
    expect(await fixture.evaluate(f => f.lookup())).toBe("stale");
    await fixture.evaluate(f => f.cancelNext());
    const row = page.locator(".st-viewport-row").filter({ hasText: "const catalogue" });
    await expect(row).toBeVisible();
    const point = await paintedCharacter(row, "catalogue", 2);
    await page.keyboard.down("Control"); await page.mouse.move(point.x, point.y);
    await expect.poll(() => fixture.evaluate(f => f.pointerHits())).toBeGreaterThan(0);
    await expect.poll(() => fixture.evaluate(f => f.cancelled())).toBe(true);
    expect(await fixture.evaluate(f => f.prepared())).toBe(0);
    await page.keyboard.up("Control");
    expect(await fixture.evaluate(f => f.retiredHits())).toBe(0);
    expect(await fixture.evaluate(f => f.lookup())).toBe(6);
    await fixture.evaluate(f => f.finish());
    expect(await fixture.evaluate(f => f.ownership())).toEqual({ leases: 0, subscriptions: 0 });
});

test("signature help can release focus to a host field and recover from a refused mount", async ({ page }) => {
    const fixture = await page.evaluateHandle(async () => {
        const path = "/presentation-fixture/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { BrowserLspWorkspace, attachEditorLanguage, mountTextEditor, openWebSocketTransport } =
            await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace(), text = 'lookup("key", )';
        const source = workspace.createTextResource({ scope: "test", resource: "source", variant: "working" }, "Source",
            { value: text, language: { uri: "fixture:/source", languageId: "generic" } });
        const host = document.createElement("main"), field = document.createElement("input");
        host.style.height = "240px"; field.setAttribute("aria-label", "Host field"); document.body.append(host, field);
        const editor = mountTextEditor(host, workspace, source.id, { ariaLabel: "Source" });
        const caret = text.indexOf(")"); editor.view.setSelection(0, { anchor: caret, head: caret }); editor.focus();
        const connect = (signal: AbortSignal) => openWebSocketTransport("ws://" + location.host + "/lsp-fixture", { signal });
        const provider = new BrowserLspWorkspace(workspace, { connect, maxScopes: 1 });
        const mount = () => attachEditorLanguage(editor, provider, { signature: {}, hover: {} });
        let tools = mount();
        tools.signature.subscribe(() => { if (tools.signature.getSnapshot().status === "ready") field.focus(); });
        return { status: () => tools.signature.getSnapshot().status,
            tryRetired() {
                tools.dispose();
                const retired = new BrowserLspWorkspace(workspace, { connect }); retired.dispose();
                try { attachEditorLanguage(editor, retired, { signature: {} }); } catch (error) { return String(error); }
            },
            registered: () => editor.commands.list().filter(command => command.id.startsWith("signature.")).map(command => command.id),
            remount() { tools = mount(); editor.focus(); },
            async requestAfterBlur() {
                const prior = tools.signature.request();
                field.focus();
                editor.focus();
                const next = await tools.signature.request();
                return [(await prior).status, next.status === "done" ? next.value.status : next.status];
            },
            hover() { tools.hover.request({ revision: editor.view.getSnapshot().revision, offset: 2 }); },
            inspection() { return tools.hover.getSnapshot().status; },
            overload() { return tools.signature.getSnapshot().activeSignature; },
            binding() { const { scopes, documentParticipants } = provider.snapshot(); return [scopes, documentParticipants]; },
            finish() { editor.dispose(); provider.dispose(); },
            owners() { const { views, subscriptions, leases } = workspace.diagnostics(); return { views, subscriptions, leases }; } };
    });
    const source = page.getByRole("textbox", { name: "Source" }), field = page.getByRole("textbox", { name: "Host field" });
    await source.press("Control+Shift+Space");
    await expect(field).toBeFocused();
    await page.keyboard.type("ok"); await expect(field).toHaveValue("ok");
    expect(await fixture.evaluate(f => f.status())).toBe("idle");
    expect(await fixture.evaluate(f => f.tryRetired())).toContain("disposed");
    expect(await fixture.evaluate(f => f.registered())).toEqual([]);
    await fixture.evaluate(f => f.remount());
    await source.press("Control+Shift+Space");
    await expect.poll(() => fixture.evaluate(f => f.status())).toBe("ready");
    expect(await fixture.evaluate(f => f.requestAfterBlur())).toEqual(["stale", "ready"]);
    await source.pressSequentially("x");
    await expect.poll(() => fixture.evaluate(f => f.status())).toBe("ready");
    await fixture.evaluate(f => f.hover());
    await expect.poll(() => fixture.evaluate(f => f.inspection())).toBe("ready");
    const overload = await fixture.evaluate(f => f.overload());
    await source.press("ArrowDown");
    expect(await fixture.evaluate(f => f.overload())).not.toBe(overload);
    await source.press("Escape");
    expect(await fixture.evaluate(f => f.inspection())).toBe("ready");
    expect(await fixture.evaluate(f => f.binding())).toEqual([1, 1]);
    await fixture.evaluate(f => f.finish());
    expect(await fixture.evaluate(f => f.owners())).toEqual({ views: 0, subscriptions: 0, leases: 0 });
});

isolatedTest("a link controller on a later pane requests links on the already open connection", async ({ page }) => {
    await mountShadowEditor(page, true);
    const result = await page.evaluate(async () => {
        const path = "/shadow-focus/browser.js";
        const { mountTextEditor, attachEditorLanguage } = await import(path) as typeof import("../../src/browser/index.ts");
        const { workspace, source, editor, provider, dispose } = window.shadowFocus;
        await provider!.connect();
        const epoch = provider!.getSnapshot().epoch;
        const host = document.createElement("div"); document.body.append(host);
        const second = mountTextEditor(host, workspace, source.id);
        try {
            const { links } = attachEditorLanguage(second, provider!, { links: {} });
            editor.dispose();
            await links.request();
            return { status: links.getSnapshot().status, sameConnection: provider!.getSnapshot().epoch === epoch };
        } finally { second.dispose(); host.remove(); await dispose(); }
    });
    expect(result).toEqual({ status: "ready", sameConnection: true });
});
