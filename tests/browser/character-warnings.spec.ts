import { test, expect } from "./fixtures.ts";
import { editorModules } from "../helpers/fixture-modules.ts";
import type { Page } from "@playwright/test";
import type { Workspace, ResourceId } from "../../src/index.ts";
import type { CharacterWarningCapture, TextEditor } from "../../src/browser/index.ts";

type Fixture = { workspace: Workspace; editor: TextEditor; resource: ResourceId; host: HTMLElement;
    set: (text: string, caret?: number) => void; capture?: CharacterWarningCapture };
declare global { interface Window { warningFixture: Fixture } }
async function fixture(page: Page, text = "a\u00a0b\u200bc", enabled = false) {
    await editorModules(page, "/warning-fixture/");
    await page.route("**/warning-fixture/editor.css", route => route.fulfill({ path: "src/browser/editor.css" }));
    await page.route("**/warning-fixture/", route => route.fulfill({
        contentType: "text/html", body: '<!doctype html><link rel="stylesheet" href="editor.css"><style>.fixture-color { color: rgb(160, 30, 120) }</style>',
    }));
    await page.goto("/warning-fixture/");
    await page.evaluate(async ({ text, enabled }) => {
        const path = "/warning-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "warnings", variant: "text" }, "Warnings", { value: text });
        const host = document.createElement("section");
        host.style.cssText = "height:240px;width:600px"; document.body.append(host);
        const before = workspace.diagnostics();
        try { mountTextEditor(host, workspace, resource.documentId, { settings: { characterWarnings: { allow: ["two"] } } }); throw new Error("Invalid allow-list accepted."); }
        catch (error) { if (!(error instanceof TypeError)) throw error; }
        if (workspace.diagnostics().views !== before.views || host.childNodes.length) throw new Error("Invalid mount leaked a view or DOM.");
        const editor = mountTextEditor(host, workspace, resource.documentId, { ariaLabel: "Warning source", settings: { characterWarnings: enabled } });
        editor.decorations.addProvider({ order: 0, provide: line => [{ from: line.from, to: line.to, className: "fixture-color" }] });
        window.warningFixture = { workspace, editor, resource: resource.id, host,
            set: (text, caret = 0) => { const document = workspace.document(resource.documentId);
                const result = workspace.edit({ documentId: resource.documentId, expectedRevision: document.revision, origin: "host", view: editor.view,
                    edits: [{ from: 0, to: document.buffer.length, insert: text }], selection: { anchor: caret, head: caret } });
                if (!result.applied) throw new Error("Fixture edit rejected."); } };
        editor.viewport.flush();
    }, { text, enabled });
}
const marks = (page: Page) => page.locator(".st-viewport-layer .st-character-warning");
const input = (page: Page) => page.getByRole("textbox", { name: "Warning source", exact: true });
async function settled(page: Page) { await page.waitForFunction(() => !window.warningFixture.editor.viewport.activity().pending); }

test("warning policy composes with colors and selection; captures expire on edits, policy and disposal", async ({ page }) => {
    await fixture(page); await expect(marks(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.warningFixture.editor.characterWarnings.query(0, 5))).toBeNull();
    const initial = await page.evaluate(() => {
        const f = window.warningFixture; f.editor.configure({ characterWarnings: true }); f.capture = f.editor.characterWarnings.query(0, 5)!;
        const first = f.capture, settings = f.editor.settings(); let rejected = false;
        try { f.editor.configure({ minimap: true, language: { tabSize: 2 }, characterWarnings: { allow: ["ab"] } }); } catch { rejected = true; }
        return { unchanged: f.editor.settings() === settings && !f.host.querySelector(".st-minimap"), current: first.isCurrent(), frozen: Object.isFrozen(first) && Object.isFrozen(first.warnings), rejected,
            ranges: first.warnings.map(w => [w.from, w.to, w.kind]) };
    });
    expect(initial).toEqual({ unchanged: true, current: true, frozen: true, rejected: true, ranges: [[1, 2, "non-breaking-space"], [3, 4, "invisible"]] });
    await expect(marks(page)).toHaveText(["\u00a0", "\u200b"]);
    await expect(marks(page).first()).toHaveCSS("color", "rgb(160, 30, 120)");
    await expect(marks(page).first()).toHaveCSS("outline-style", "dotted");
    await page.evaluate(() => { const f = window.warningFixture; f.editor.view.setSelection(f.workspace.document(f.editor.view.documentId).revision, { anchor: 1, head: 2 }); });
    await expect(marks(page).first()).toHaveCSS("background-color", "rgb(36, 73, 107)");
    await input(page).focus(); await page.keyboard.press("Backspace"); await expect(marks(page)).toHaveText(["\u200b"]);
    expect(await page.evaluate(() => window.warningFixture.capture!.isCurrent())).toBe(false);
    await page.keyboard.press("Control+z"); await expect(marks(page)).toHaveText(["\u00a0", "\u200b"]);
    await page.evaluate(() => { const f = window.warningFixture; f.capture = f.editor.characterWarnings.query(0, 5)!;
        f.editor.configure({ characterWarnings: { categories: { invisible: false } } }); });
    expect(await page.evaluate(() => window.warningFixture.capture!.isCurrent())).toBe(false);
    await expect(marks(page)).toHaveText(["\u00a0"]);
    await page.evaluate(() => window.warningFixture.editor.configure({ characterWarnings: { allow: ["\u00a0"] } }));
    await expect(marks(page)).toHaveText(["\u200b"]);
    const end = await page.evaluate(() => {
        const f = window.warningFixture, capture = f.editor.characterWarnings.query(0, 5)!;
        f.editor.dispose(); const configured = f.editor.configure({ characterWarnings: true }), query = f.editor.characterWarnings.query(0, 5);
        f.workspace.releaseResource(f.resource, true);
        return { current: capture.isCurrent(), configured, query, configuration: f.editor.settings().characterWarnings, views: f.workspace.diagnostics().views,
            subscriptions: f.workspace.diagnostics().subscriptions, children: f.host.childNodes.length };
    });
    expect(end).toEqual({ current: false, configured: false, query: null, configuration: false, views: 0, subscriptions: 0, children: 0 });
});

test("warning marks preserve native shaping, range geometry and hit testing", async ({ page }, info) => {
    await fixture(page, "x\u200by a\u00a0b\n👩‍💻 ♥️ क्‍ष\nمرحبا\u200f שלום\nleft \u202eabc\u202c right\nA\u{e0100}B");
    const result = await page.evaluate(() => {
        const f = window.warningFixture, viewport = f.editor.viewport;
        const measure = () => [...f.host.querySelectorAll<HTMLElement>(".st-viewport-layer .st-viewport-row")].map(row => {
            const from = Number(row.dataset.from), points = [];
            for (let i = 0; i <= row.textContent.length; i++) {
                let local = i; const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let text = walker.nextNode() as Text;
                while (local > text.length) { local -= text.length; text = walker.nextNode() as Text; }
                const range = document.createRange(); range.setStart(text, local); range.collapse(true);
                const rectangles = [...range.getClientRects()].map(r => [r.left, r.top, r.width, r.height]);
                const point = viewport.coordsAt(from + i);
                points.push({ rectangles, caret: point && [point.left, point.top, point.height],
                    hit: point && viewport.hitTest(point.left, point.top + point.height / 2)?.offset });
            }
            return { text: row.textContent, width: row.getBoundingClientRect().width, points };
        });
        const before = measure(); f.editor.configure({ characterWarnings: true }); viewport.flush(); const after = measure();
        return { before, after, marks: f.host.querySelectorAll(".st-viewport-layer .st-character-warning").length };
    });
    await info.attach("warning-geometry", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.marks).toBeGreaterThanOrEqual(8);
    for (let row = 0; row < result.before.length; row++) {
        const before = result.before[row]!, after = result.after[row]!;
        expect(after.text).toBe(before.text); expect(Math.abs(after.width - before.width)).toBeLessThan(.1);
        expect(after.points.map(p => p.hit)).toEqual(before.points.map(p => p.hit));
        for (let i = 0; i < before.points.length; i++) {
            const a = after.points[i]!.caret!, b = before.points[i]!.caret!;
            // Inline-box boundaries change native range fragmentation/rounding. Firefox also
            // reports the fallback emoji box instead of the adjacent text font (2px vertically).
            expect(Math.abs(a[0]! - b[0]!)).toBeLessThan(.5);
            expect(Math.abs(a[1]! - b[1]!)).toBeLessThanOrEqual(2.01);
            expect(Math.abs(a[2]! - b[2]!)).toBeLessThanOrEqual(2.01);
        }
    }
});

test("large documents and horizontal fragments keep warning work local and source queries bounded", async ({ page }) => {
    const row = "a\u200bb\u00a0c";
    await fixture(page, (row + "\n").repeat(1000), true);
    const result = await page.evaluate(() => {
        const f = window.warningFixture, viewport = f.editor.viewport;
        viewport.scrollTo({ top: viewport.getSnapshot().lineHeight * 500 }); viewport.flush();
        const rows = [...f.host.querySelectorAll<HTMLElement>(".st-viewport-layer .st-viewport-row")];
        const capture = f.editor.characterWarnings.query(3001, 5000, { maxUnits: 64, maxWarnings: 8 })!;
        const bounded = { units: capture.scannedUnits, complete: capture.complete };
        const expected = rows.map(r => r.textContent), count = f.host.querySelectorAll(".st-viewport-layer .st-character-warning").length;
        // A long row must not hide warnings when its horizontal window moves or splits a surrogate pair.
        f.set("x".repeat(100000) + "\u{e0100}\u200by"); viewport.revealOffset(100002); viewport.flush();
        const fragment = f.host.querySelector<HTMLElement>('.st-viewport-layer .st-viewport-row[data-line="0"]')!;
        return { bounded, rows: rows.length, count, expected, fragmentUnits: fragment.textContent.length,
            fragmentText: fragment.textContent.slice(-4), marks: [...fragment.querySelectorAll(".st-character-warning")].map(mark => mark.textContent) };
    });
    expect(result.rows).toBeLessThan(100); expect(result.count).toBe(result.rows * 2);
    expect(result.expected.every(row => row === "a\u200bb\u00a0c")).toBe(true);
    expect(result.bounded.complete).toBe(false); expect(result.bounded.units).toBeLessThanOrEqual(64);
    expect(result.fragmentUnits).toBeLessThan(1000); expect(result.fragmentText).toBe("\u{e0100}\u200by");
    expect(result.marks.join("")).toBe("x\u{e0100}\u200b");
    await settled(page);
});
