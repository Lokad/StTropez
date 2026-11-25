import { build } from "esbuild";
import { basename } from "node:path";
import { test, expect } from "./fixtures.ts";

test.beforeEach(async ({ page }) => {
    const built = await build({ entryPoints: { controller: "examples/hosts/controller.ts", bindings: "examples/hosts/bindings.ts", editor: "src/browser/index.ts" },
        outdir: "artifacts/host-attachment", bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", write: false });
    const modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text]));
    await page.route("**/host-attachment/**", route => {
        const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
        return name === "" ? route.fulfill({ contentType: "text/html", body: '<div id="host" style="width:600px;height:240px"></div>' })
            : modules.has(name) ? route.fulfill({ contentType: "text/javascript", body: modules.get(name)! }) : route.abort();
    });
    await page.goto("/host-attachment/");
});

test("failed host attachments unwind acquired owners and can mount and edit again", async ({ page }, testInfo) => {
    const results = await page.evaluate(async () => {
        const path = "/host-attachment/";
        const { HostController } = await import(path + "controller.js") as typeof import("../../examples/hosts/controller.ts");
        const { ViewBindings } = await import(path + "bindings.js") as typeof import("../../examples/hosts/bindings.ts");
        const controller = new HostController(), bindings = new ViewBindings(controller), host = document.querySelector<HTMLDivElement>("#host")!;
        const messages = (error: unknown): string[] => error instanceof AggregateError ? error.errors.flatMap(messages) : [String(error instanceof Error ? error.message : error)];
        const ownership = () => {
            const { resources, documents, tabs, views, leases, subscriptions } = controller.workspace.diagnostics();
            return { resources, documents, tabs, views, leases, subscriptions, hostSubscriptions: controller.debug().hostSubscriptions };
        };
        const result = [];
        try {
            for (const id of ["primary", "secondary", "comparison"] as const) {
                const mount = bindings[id];
                // Warm retained view state belongs to the bindings, independently of mounted UI.
                mount(host); mount(null); await Promise.resolve();
                const before = ownership(), colors = bindings.colors.attach, reference = bindings.language.attachReferenceFind, hover = bindings.hover.bind;
                const attachError = new Error("Attachment refused"), cleanupError = new Error("Cleanup reported failure");
                let retiredInput: HTMLTextAreaElement | undefined;
                const fail = () => { retiredInput = host.querySelector<HTMLTextAreaElement>("textarea")!; throw attachError; };
                if (id === "comparison") bindings.language.attachReferenceFind = fail;
                else bindings.colors.attach = fail;
                if (id === "primary") bindings.hover.bind = (...args) => {
                    const stop = hover.call(bindings.hover, ...args);
                    return () => { stop(); throw cleanupError; };
                };
                let failure: string[] = [];
                try { mount(host); } catch (error) { failure = messages(error); }
                finally { bindings.colors.attach = colors; bindings.language.attachReferenceFind = reference; bindings.hover.bind = hover; }
                await Promise.resolve();
                // Detached listeners must not reactivate a retired language/hover session.
                retiredInput?.dispatchEvent(new FocusEvent("focus"));
                const failed = bindings.debug(), afterFailure = ownership(), children = host.childElementCount;
                // A retry must exercise the real editor and all original feature attachments.
                let retryError: string[] = [], detachFailure: string[] = [], edited = false;
                try {
                    if (id === "secondary") bindings.colors.attach = (...args) => {
                        const stop = colors.call(bindings.colors, ...args);
                        return () => { stop(); throw cleanupError; };
                    };
                    mount(host);
                    const input = host.querySelector<HTMLTextAreaElement>(id === "comparison" ? 'textarea:not([readonly])' : "textarea")!;
                    const revision = controller.source.getSnapshot().revision;
                    if (input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "x", bubbles: true, cancelable: true }))) {
                        input.setRangeText("x", input.selectionStart, input.selectionEnd, "end");
                        input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "x", bubbles: true }));
                    }
                    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                    edited = controller.source.getSnapshot().revision === revision + 1;
                    try { mount(null); } catch (error) { detachFailure = messages(error); }
                    mount(null);
                    if (id === "secondary") { bindings.colors.attach = colors; mount(host); mount(null); }
                } catch (error) { retryError = messages(error); }
                finally { bindings.colors.attach = colors; }
                result.push({ id, failure, before, afterFailure, afterRetry: ownership(), children, retired: retiredInput?.isConnected === false,
                    active: failed.activeViews, comparison: failed.comparison !== null, language: failed.language.sessions.length,
                    reference: failed.language.referenceFind.length, languageActive: failed.language.active, hover: failed.hover.sessions.length, paste: failed.tablePaste.sessions,
                    instruction: failed.instruction !== null, retryError, detachFailure, edited });
            }
        } finally { bindings.dispose(); await controller.dispose(); }
        return result;
    });
    await testInfo.attach("attachment-ownership", { contentType: "application/json", body: JSON.stringify(results, null, 2) });
    for (const result of results) {
        expect(result.failure, result.id).toEqual(result.id === "primary" ? ["Attachment refused", "Cleanup reported failure"] : ["Attachment refused"]);
        expect(result.detachFailure, result.id).toEqual(result.id === "secondary" ? ["Cleanup reported failure"] : []);
        expect(result.afterFailure, result.id).toEqual(result.before);
        expect(result.afterRetry, result.id).toEqual(result.before);
        expect(result, result.id).toMatchObject({ children: 0, retired: true, active: 0, comparison: false, language: 0, reference: 0, hover: 0, paste: 0,
            languageActive: null, instruction: false, retryError: [], edited: true });
    }
});

test("language shortcuts follow their panel and editor through attachment failure and remount", async ({ page }) => {
    const results = await page.evaluate(async () => {
        const path = "/host-attachment/";
        const { HostController } = await import(path + "controller.js") as typeof import("../../examples/hosts/controller.ts");
        const { ViewBindings } = await import(path + "bindings.js") as typeof import("../../examples/hosts/bindings.ts");
        const { mountTextEditor } = await import(path + "editor.js") as typeof import("../../src/browser/index.ts");
        const controller = new HostController(), bindings = new ViewBindings(controller);
        const host = document.querySelector<HTMLDivElement>("#host")!, tab = controller.viewTab("primary");
        const results = [];
        try {
            for (const [feature, discover, shortcut, priority] of [
                ["links", "links.discover", "F4", 7], ["colors", "colors.discover", "F6", 8],
                ["navigation", "navigation.definition", "F12", 5], ["rename", "rename.start", "F2", 9],
                ["actions", "actions.request", "Mod+.", 6], ["hover", "hover.inspect", "Mod+k Mod+i", 20],
                ["signature", "signature.request", "Mod+Shift+Space", 10],
            ] as const) {
                const panel = feature === "hover" ? bindings.signature : bindings[feature];
                const first = mountTextEditor(host, controller.workspace, tab);
                const conflict = first.commands.register({ id: "host.escape", label: "Host Escape", run() {} }, { keys: ["Escape"], priority });
                const owned = (editor: typeof first) => editor.commands.list().filter(c => c.id.startsWith(feature + ".")).map(c => c.id);
                const sessions = () => { const active = panel.debug().sessions; return typeof active === "number" ? active : active.length; };
                let refused = false;
                try { panel.attach("primary", tab, first); } catch (error) { refused = String(error).includes("Key binding conflicts: Escape"); }
                const rollback = { refused, commands: owned(first), sessions: sessions(), escape: first.commands.run("host.escape") };
                conflict.dispose();
                if (feature !== "hover") {
                    first.focus();
                    const failure = new Error("The host could not render the focused panel");
                    const stop = panel.state.subscribe(() => { stop(); throw failure; });
                    try { panel.attach("primary", tab, first); throw new Error("Expected the focused mount to fail"); }
                    catch (error) { if (error !== failure) throw error; }
                    if (owned(first).length || sessions()) throw new Error(feature + " retained a failed mount");
                }
                const detach = panel.attach("primary", tab, first);
                first.dispose();
                const afterEditor = sessions();
                const next = mountTextEditor(host, controller.workspace, tab);
                try {
                    const detachNext = panel.attach("primary", tab, next); detach();
                    const remounted = next.keymap.getShortcuts(discover);
                    let reattached = false;
                    if (feature !== "hover") {
                        panel.dispose();
                        try { panel.attach("primary", tab, next); reattached = true; } catch (error) {
                            if (!String(error).includes("panel is disposed")) throw error;
                        }
                    } else detachNext();
                    results.push({ feature, shortcut, rollback, afterEditor, remounted, reattached, afterPanel: owned(next), sessions: sessions() });
                } finally { next.dispose(); }
            }
        } finally { bindings.dispose(); await controller.dispose(); }
        return results;
    });
    for (const result of results) {
        expect.soft(result, result.feature).toMatchObject({ rollback: { refused: true, commands: [], sessions: 0, escape: true },
            afterEditor: 0, remounted: [result.shortcut],
            reattached: false, afterPanel: [], sessions: 0 });
    }
});
