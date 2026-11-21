import { test, expect } from "./fixtures.ts";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Page } from "@playwright/test";
import type { Workspace, ResourceId, TabId } from "../../src/index.ts";
import type { TextEditor } from "../../src/browser/index.ts";

type Fixture = { workspace: Workspace; editor: TextEditor; tab: TabId; resource: ResourceId; host: HTMLElement; calls: number; allowed: boolean;
    set: (text: string, caret: number) => void; select: (caret: number) => void; states: string[]; stop?: () => void };
declare global { interface Window { bracketFixture: Fixture } }
let modules: Map<string, string>, css: string;
test.beforeAll(async () => {
    const built = await build({ entryPoints: { core: "src/index.ts", browser: "src/browser/index.ts" }, outdir: "artifacts/bracket-fixture",
        bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", write: false });
    modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text])); css = await readFile("src/browser/editor.css", "utf8");
});
async function fixture(page: Page, shadow = false) {
    await page.route("**/bracket-fixture/**", route => {
        const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
        return route.fulfill({ contentType: name === "" ? "text/html" : name === "editor.css" ? "text/css" : "text/javascript",
            body: name === "" ? '<!doctype html><link rel="stylesheet" href="editor.css"><button id="outside">Outside</button>' : name === "editor.css" ? css : modules.get(name)! });
    });
    await page.goto("/bracket-fixture/");
    await page.evaluate(async ({ shadow, css }) => {
        const path = "/bracket-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "brackets", variant: "text" }, "Brackets", { value: "(a) [b]" });
        const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "brackets"), container = document.createElement("div"); document.body.append(container);
        const root = shadow ? container.attachShadow({ mode: "open" }) : container, style = document.createElement("style"), host = document.createElement("section");
        style.textContent = css + ".fixture-color { color: rgb(160, 30, 120) }"; host.style.cssText = "height:240px;width:600px"; root.append(style, host);
        const before = workspace.diagnostics();
        try { mountTextEditor(host, workspace, tab, { bracketMatching: { maxWorkUnits: 0 } }); throw new Error("Invalid matching limits accepted."); }
        catch (error) { if (!(error instanceof RangeError)) throw error; }
        if (workspace.diagnostics().views !== before.views || host.childNodes.length) throw new Error("Invalid mount leaked a view or DOM.");
        const editor = mountTextEditor(host, workspace, tab, { ariaLabel: "Bracket source" });
        editor.decorations.addProvider({ name: "syntax", order: 0, provide: line => [{ from: line.from, to: line.to, className: "fixture-color" }] });
        const f: Fixture = { workspace, editor, tab, resource: resource.id, host, calls: 0, allowed: false, states: [],
            set: (text, caret) => { const document = workspace.document(resource.documentId);
                const result = workspace.edit({ documentId: resource.documentId, expectedRevision: document.revision, origin: "host", view: editor.view,
                    edits: [{ from: 0, to: document.buffer.length, insert: text }], selection: { anchor: caret, head: caret } });
                if (!result.applied) throw new Error("Fixture edit rejected."); },
            select: caret => { if (!editor.view.setSelection(workspace.document(resource.documentId).revision, { anchor: caret, head: caret })) throw new Error("Fixture selection rejected."); } };
        window.bracketFixture = f;
    }, { shadow, css });
}
const input = (page: Page) => page.getByRole("textbox", { name: "Bracket source", exact: true });
const marks = (page: Page) => page.locator(".st-matching-bracket");
const state = (page: Page) => page.evaluate(() => window.bracketFixture.editor.bracketMatching.getSnapshot());
async function settled(page: Page) { await expect.poll(async () => (await state(page)).status).not.toBe("pending");
    await page.waitForFunction(() => !window.bracketFixture.editor.viewport.activity().pending); }

for (const shadow of [false, true]) test(`${shadow ? "shadow" : "document"} bracket highlights compose with colors and follow primary input, history and focus`, async ({ page }) => {
    await fixture(page, shadow); await input(page).focus(); expect((await state(page)).status).toBe("disabled");
    await page.evaluate(() => window.bracketFixture.editor.bracketMatching.configure(true)); await settled(page);
    await expect(marks(page)).toHaveText(["(", ")"]);
    expect(await marks(page).first().evaluate(node => getComputedStyle(node).color)).toBe("rgb(160, 30, 120)");
    const stable = await page.evaluate(() => { const f = window.bracketFixture, before = f.editor.bracketMatching.getSnapshot();
        f.editor.input.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" })); return before === f.editor.bracketMatching.getSnapshot(); }); expect(stable).toBe(true);
    await input(page).press("End"); await settled(page); await expect(marks(page)).toHaveText(["[", "]"]);
    await input(page).press("Backspace"); await settled(page); await expect(marks(page)).toHaveCount(0);
    await input(page).press("Control+z"); await settled(page); await expect(marks(page)).toHaveText(["[", "]"]);
    await page.evaluate(() => { const f = window.bracketFixture, revision = f.workspace.document(f.editor.view.documentId).revision;
        f.editor.view.setSelections(revision, [{ anchor: 0, head: 0 }, { anchor: 7, head: 7 }], 0); });
    await settled(page); await expect(marks(page)).toHaveText(["(", ")"]);
    await page.evaluate(() => { const f = window.bracketFixture; f.editor.view.setSelections(f.workspace.document(f.editor.view.documentId).revision,
        [{ anchor: 0, head: 0 }, { anchor: 2, head: 3 }], 0); }); await settled(page);
    expect(await page.locator(".st-matching-bracket.st-viewport-selected").evaluate(node => getComputedStyle(node).backgroundColor)).toBe("rgb(36, 73, 107)");
    await page.getByRole("button", { name: "Outside" }).click(); await settled(page); await expect(marks(page)).toHaveCount(0);
    await input(page).focus(); await settled(page); await expect(marks(page)).toHaveText(["(", ")"]);
    await page.evaluate(() => { const f = window.bracketFixture; f.workspace.setCapabilities(f.resource, { edit: ["host"], save: true, run: true }); });
    await expect(input(page)).toHaveJSProperty("readOnly", true); await expect(marks(page)).toHaveCount(2);
    await page.evaluate(() => window.bracketFixture.editor.configureLanguage({ pairs: [] })); await settled(page); await expect(marks(page)).toHaveCount(0);
    await page.evaluate(() => window.bracketFixture.editor.bracketMatching.configure(false)); expect((await state(page)).status).toBe("disabled");
});

test("bracket jump works without highlights and a delayed jump cannot move a replacement selection", async ({ page }) => {
    await fixture(page); await input(page).focus();
    await input(page).press("Control+Shift+Backslash"); await page.keyboard.type("X");
    await expect(page.locator(".st-viewport-row").first()).toHaveJSProperty("textContent", "(aX) [b]");
    expect((await state(page)).status).toBe("disabled");
    const pending = await page.evaluate(() => {
        const f = window.bracketFixture;
        f.set("[" + "x".repeat(50_000) + "]", 0);
        f.editor.runCommand("jump-to-bracket");
        const pending = f.editor.activity().pendingCommand;
        f.set("new", 1);
        return pending;
    });
    expect(pending).toBe(true); await page.keyboard.type("!");
    await expect(page.locator(".st-viewport-row").first()).toHaveJSProperty("textContent", "n!ew");
});

test("bracket budgets, syntax refresh and reentrant cancellation never publish stale matches or leak owners", async ({ page }) => {
    await fixture(page); await input(page).focus();
    const disabledSubscriptions = await page.evaluate(() => window.bracketFixture.workspace.diagnostics().subscriptions);
    await page.evaluate(() => { const f = window.bracketFixture; f.set("(" + "x\n".repeat(100000) + ")", 0); f.editor.bracketMatching.configure({ maxWorkUnits: 1024 }); });
    await settled(page); expect((await state(page)).result).toMatchObject({ kind: "limited", limit: "work" }); await expect(marks(page)).toHaveCount(0);
    await page.evaluate(() => { const f = window.bracketFixture; f.editor.bracketMatching.configure(true); f.set("(a) [b]", 0);
        f.editor.configureLanguage({ allowPair: () => { f.calls++; return f.allowed; } }); });
    await settled(page); expect((await state(page)).result?.kind).toBe("vetoed");
    // The callback's lexical knowledge changes without replacing the document/configuration.
    await page.evaluate(() => { const f = window.bracketFixture; f.allowed = true; f.editor.bracketMatching.refresh(); });
    await settled(page); await expect(marks(page)).toHaveText(["(", ")"]);
    await page.evaluate(() => { const f = window.bracketFixture; let changed = false;
        f.stop = f.editor.bracketMatching.subscribe(() => { const s = f.editor.bracketMatching.getSnapshot(); if (s.status === "ready") f.states.push(s.result!.kind); });
        f.editor.configureLanguage({ allowPair: () => { if (!changed) { changed = true; f.set("[new]", 0); } return true; } }); });
    await settled(page); await expect(marks(page)).toHaveText(["[", "]"]); expect((await state(page)).result?.match).toBe(4);
    const end = await page.evaluate(async () => {
        const f = window.bracketFixture; f.editor.bracketMatching.configure(false);
        const disabled = f.workspace.diagnostics().subscriptions;
        f.editor.bracketMatching.configure(true); f.set("(" + "x\n".repeat(100000) + ")", 0);
        const pending = f.editor.bracketMatching.getSnapshot().status;
        f.editor.dispose(); f.stop?.(); const state = f.editor.bracketMatching.getSnapshot();
        f.workspace.close(f.tab); f.workspace.releaseResource(f.resource, true);
        await new Promise(resolve => setTimeout(resolve, 30));
        return { disabled, pending, status: state.status, result: state.result, views: f.workspace.diagnostics().views, subscriptions: f.workspace.diagnostics().subscriptions,
            markers: f.host.querySelectorAll(".st-matching-bracket").length, states: f.states };
    });
    expect(end.disabled).toBe(disabledSubscriptions);
    expect(end).toMatchObject({ pending: "pending", status: "disposed", result: null, views: 0, subscriptions: 0, markers: 0 });
    expect(end.states).toEqual(["matched"]);
});
