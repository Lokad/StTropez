import { test, expect } from "./fixtures.ts";
import { editorModules } from "../helpers/fixture-modules.ts";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import type { Workspace, DocumentId } from "../../src/index.ts";
import type { TextEditor } from "../../src/browser/index.ts";

type Fixture = { workspace: Workspace; editor: TextEditor; resource: DocumentId; host: HTMLElement; calls: number; allowed: boolean;
    set: (text: string, caret: number) => void; select: (caret: number) => void; states: string[]; stop?: () => void };
declare global { interface Window { bracketFixture: Fixture } }
let css: string;
test.beforeAll(async () => { css = await readFile("src/browser/editor.css", "utf8"); });
async function fixture(page: Page, shadow = false) {
    await editorModules(page, "/bracket-fixture/");
    await page.route("**/bracket-fixture/editor.css", route => route.fulfill({ path: "src/browser/editor.css" }));
    await page.route("**/bracket-fixture/", route => route.fulfill({
        contentType: "text/html", body: '<!doctype html><link rel="stylesheet" href="editor.css"><button id="outside">Outside</button>',
    }));
    await page.goto("/bracket-fixture/");
    await page.evaluate(async ({ shadow, css }) => {
        const path = "/bracket-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "brackets", variant: "text" }, "Brackets", { value: "(a) [b]" });
        const container = document.createElement("div"); document.body.append(container);
        const root = shadow ? container.attachShadow({ mode: "open" }) : container, style = document.createElement("style"), host = document.createElement("section");
        style.textContent = css + ".fixture-color { color: rgb(160, 30, 120) }"; host.style.cssText = "height:240px;width:600px"; root.append(style, host);
        const before = workspace.diagnostics();
        try { mountTextEditor(host, workspace, resource.id, { settings: { bracketMatching: { maxWorkUnits: 0 } } }); throw new Error("Invalid matching limits accepted."); }
        catch (error) { if (!(error instanceof RangeError)) throw error; }
        if (workspace.diagnostics().views !== before.views || host.childNodes.length) throw new Error("Invalid mount leaked a view or DOM.");
        const editor = mountTextEditor(host, workspace, resource.id, { ariaLabel: "Bracket source" });
        editor.decorations.addProvider({ order: 0, provide: line => [{ from: line.from, to: line.to, className: "fixture-color" }] });
        const f: Fixture = { workspace, editor, resource: resource.id, host, calls: 0, allowed: false, states: [],
            set: (text, caret) => { const document = workspace.document(resource.id);
                const result = workspace.edit({ documentId: resource.id, expectedRevision: document.revision, origin: "host", view: editor.view,
                    edits: [{ from: 0, to: document.buffer.length, insert: text }], selection: { anchor: caret, head: caret } });
                if (!result.applied) throw new Error("Fixture edit rejected."); },
            select: caret => { if (!editor.view.setSelection(workspace.document(resource.id).revision, { anchor: caret, head: caret })) throw new Error("Fixture selection rejected."); } };
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
    await page.evaluate(() => window.bracketFixture.editor.configure({ bracketMatching: true })); await settled(page);
    await expect(marks(page)).toHaveText(["(", ")"]);
    expect(await marks(page).first().evaluate(node => getComputedStyle(node).color)).toBe("rgb(160, 30, 120)");
    const stable = await page.evaluate(() => { const f = window.bracketFixture, before = f.editor.bracketMatching.getSnapshot();
        f.editor.element.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" })); return before === f.editor.bracketMatching.getSnapshot(); }); expect(stable).toBe(true);
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
    await page.evaluate(() => { const f = window.bracketFixture; f.workspace.setCapabilities(f.resource, { edit: ["host"], save: true }); });
    await expect(input(page)).toHaveJSProperty("readOnly", true); await expect(marks(page)).toHaveCount(2);
    await page.evaluate(() => window.bracketFixture.editor.configure({ language: { pairs: [] } })); await settled(page); await expect(marks(page)).toHaveCount(0);
    await page.evaluate(() => window.bracketFixture.editor.configure({ bracketMatching: false })); expect((await state(page)).status).toBe("disabled");
});

test("bracket jumps update the selection before the following edit, including with highlights disabled", async ({ page }) => {
    await fixture(page); await input(page).focus();
    await input(page).dispatchEvent("keydown", { key: "µ", code: "Backslash", ctrlKey: true, shiftKey: true });
    await page.keyboard.type("X");
    await expect(page.locator(".st-viewport-row").first()).toHaveJSProperty("textContent", "(aX) [b]");
    expect((await state(page)).status).toBe("disabled");
    await page.evaluate(() => window.bracketFixture.set("outer(inner(value))", 14));
    await input(page).press("Control+Shift+Backslash"); await page.keyboard.type("!");
    await expect(page.locator(".st-viewport-row").first()).toHaveJSProperty("textContent", "outer(inner(value!))");
    await page.evaluate(() => window.bracketFixture.set("()  call[0]", 3));
    await input(page).press("Control+Shift+Backslash");
    await page.keyboard.type("!");
    await expect(page.locator(".st-viewport-row").first()).toHaveText("()  call![0]");
    const offsets = await page.evaluate(() => {
        const f = window.bracketFixture;
        const row = "(value)\n";
        f.set(row.repeat(2000), 0);
        const ranges = Array.from({ length: 2000 }, (_, i) => ({ anchor: i * row.length, head: i * row.length }));
        const view = f.editor.view;
        view.setSelections(view.getSnapshot().revision, ranges, 0);
        f.editor.commands.run("jump-to-bracket");
        return view.getSnapshot().selectionSet.ranges.map(range => range.head);
    });
    expect(offsets).toEqual(Array.from({ length: 2000 }, (_, i) => 8 * i + 6));
    const replacement = await page.evaluate(() => {
        const f = window.bracketFixture;
        let calls = 0;
        f.editor.configure({ language: { allowPair: () => {
            if (++calls === 1) f.set("new", 1);
            return true;
        } } });
        f.editor.commands.run("jump-to-bracket");
        return { calls, head: f.editor.view.getSnapshot().selection.head };
    });
    expect(replacement).toEqual({ calls: 1, head: 1 });
    await page.keyboard.type("!");
    await expect(page.locator(".st-viewport-row").first()).toHaveText("n!ew");
});

test("bracket budgets, syntax refresh and reentrant cancellation never publish stale matches or leak owners", async ({ page }) => {
    await fixture(page); await input(page).focus();
    const disabledSubscriptions = await page.evaluate(() => window.bracketFixture.workspace.diagnostics().subscriptions);
    await page.evaluate(() => { const f = window.bracketFixture; f.set("(" + "x\n".repeat(100000) + ")", 0); f.editor.configure({ bracketMatching: { maxWorkUnits: 1024 } }); });
    await settled(page); expect((await state(page)).result).toMatchObject({ kind: "limited", limit: "work" }); await expect(marks(page)).toHaveCount(0);
    await page.evaluate(() => { const f = window.bracketFixture; f.editor.configure({ bracketMatching: true }); f.set("(a) [b]", 0);
        f.editor.configure({ language: { allowPair: () => { f.calls++; return f.allowed; } } }); });
    await settled(page); expect((await state(page)).result?.kind).toBe("vetoed");
    // The callback's lexical knowledge changes without replacing the document/configuration.
    await page.evaluate(() => { const f = window.bracketFixture; f.allowed = true; f.editor.bracketMatching.refresh(); });
    await settled(page); await expect(marks(page)).toHaveText(["(", ")"]);
    await page.evaluate(() => { const f = window.bracketFixture; let changed = false;
        f.stop = f.editor.bracketMatching.subscribe(() => { const s = f.editor.bracketMatching.getSnapshot(); if (s.status === "ready") f.states.push(s.result!.kind); });
        f.editor.configure({ language: { allowPair: () => { if (!changed) { changed = true; f.set("[new]", 0); } return true; } } }); });
    await settled(page); await expect(marks(page)).toHaveText(["[", "]"]); expect((await state(page)).result?.match).toBe(4);
    const end = await page.evaluate(async () => {
        const f = window.bracketFixture; f.editor.configure({ bracketMatching: false });
        const disabled = f.workspace.diagnostics().subscriptions;
        f.editor.configure({ bracketMatching: true }); f.set("(" + "x\n".repeat(100000) + ")", 0);
        const pending = f.editor.bracketMatching.getSnapshot().status;
        f.editor.dispose(); f.stop?.(); const state = f.editor.bracketMatching.getSnapshot();
        f.workspace.releaseResource(f.resource, true);
        await new Promise(resolve => setTimeout(resolve, 30));
        return { disabled, pending, status: state.status, result: state.result, views: f.workspace.diagnostics().views, subscriptions: f.workspace.diagnostics().subscriptions,
            markers: f.host.querySelectorAll(".st-matching-bracket").length, states: f.states };
    });
    expect(end.disabled).toBe(disabledSubscriptions);
    expect(end).toMatchObject({ pending: "pending", status: "disposed", result: null, views: 0, subscriptions: 0, markers: 0 });
    expect(end.states).toEqual(["matched"]);
});
