import { ready, test, expect } from "./fixtures.ts";
import { chromium } from "@playwright/test";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";
import type { Page, TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { hostTextEquals } from "../../scripts/host-scene.mjs";

type ClipboardRecord = Readonly<{ type: string; trusted: boolean; prevented: boolean; label: string | null; text: string }>;
declare global {
    interface Window { hostKeyboardClipboardAudit: Readonly<{ read(): readonly ClipboardRecord[]; stop(): void }> }
}
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const primary = (page: Page) => page.getByRole("textbox", { name: "Primary source", exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const normalized = (text: string) => text.replace(/\r\n?|\n/g, "\n");
const selections = (state: Awaited<ReturnType<typeof snapshot>>) => state.bindings.views.map(view => ({ id: view.id, selection: view.selection }));
const sourceSelection = (state: Awaited<ReturnType<typeof snapshot>>, id: "primary" | "secondary") => state.bindings.views.find(view => view.id === id)!.selection;
async function waitForReview(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (s.bindings.activeViews === 2 && s.bindings.comparison !== null); });
}
async function exact(page: Page, text: string): Promise<void> { expect(await hostTextEquals(page, text)).toBe(true); }
async function select(page: Page, from: number, to = from, id: "primary" | "secondary" = "primary"): Promise<void> {
    expect(await page.evaluate(({ from, to, id }) => { const fixture = window.hostFixture;
        return fixture.selectSource(id, fixture.snapshot().source.revision, { anchor: to, head: from });
    }, { from, to, id })).toBe(true); await waitForReview(page);
}
async function mount(page: Page, host: "plain" | "react", editor: "native" | "candidate", text: string): Promise<void> {
    await page.goto(`/hosts/${host}/?editor=${editor}`);
    await page.evaluate(text => { const fixture = window.hostFixture, state = fixture.snapshot();
        fixture.editSource(state.source.revision, [{ from: 0, to: state.source.length, insert: text }]);
    }, text);
    await button(page, "Open source review").click(); await waitForReview(page);
    await button(page, "Capture review acceptance").click(); await button(page, "Finish review acceptance").click(); await waitForReview(page);
    await button(page, "Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
    await page.evaluate(() => {
        const listeners = new AbortController(), records: ClipboardRecord[] = [];
        for (const type of ["copy", "cut", "paste"] as const) document.addEventListener(type, event => {
            if (!(event.target instanceof HTMLTextAreaElement)) return;
            records.push({ type, trusted: event.isTrusted, prevented: event.defaultPrevented,
                label: event.target.getAttribute("aria-label"), text: event.clipboardData?.getData("text/plain") ?? "" });
        }, { signal: listeners.signal });
        window.hostKeyboardClipboardAudit = Object.freeze({ read: () => records.map(record => ({ ...record })), stop: () => listeners.abort() });
        const sink = document.createElement("textarea"); sink.setAttribute("aria-label", "Known clipboard probe"); document.body.append(sink);
    });
}
async function copyToKnownControl(page: Page, selected: string): Promise<string> {
    const before = await snapshot(page); await primary(page).press("Control+c"); await waitForReview(page); const after = await snapshot(page);
    expect(after.source.revision).toBe(before.source.revision); expect(after.history).toEqual(before.history);
    expect(after.pendingSaves).toEqual(before.pendingSaves); expect(selections(after)).toEqual(selections(before));
    const sink = page.getByRole("textbox", { name: "Known clipboard probe", exact: true }); await sink.focus(); await sink.press("Control+v");
    const events = await page.evaluate(() => window.hostKeyboardClipboardAudit.read()), copied = events.at(-2)!, pasted = events.at(-1)!;
    expect(copied).toMatchObject({ type: "copy", trusted: true, label: "Primary source" });
    expect(pasted).toMatchObject({ type: "paste", trusted: true, label: "Known clipboard probe" });
    expect(normalized(pasted.text)).toBe(normalized(selected)); expect(await sink.inputValue()).toBe(normalized(pasted.text));
    await primary(page).focus(); await waitForReview(page); expect(selections(await snapshot(page))).toEqual(selections(before)); return pasted.text;
}
async function dispose(page: Page, info: TestInfo): Promise<void> {
    const events = await page.evaluate(() => window.hostKeyboardClipboardAudit.read()); expect(events.every(event => event.trusted)).toBe(true);
    await info.attach("trusted-clipboard-events", { contentType: "application/json", body: JSON.stringify(events.map(({ text, ...event }) => ({ ...event,
        units: text.length, sha256: createHash("sha256").update(text).digest("hex"), ...(text.length < 128 ? { text } : {}) })), null, 2) });
    await page.evaluate(() => { window.hostKeyboardClipboardAudit.stop(); window.hostFixture.dispose(); }); const state = await snapshot(page);
    expect(state.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(state.hostSubscriptions).toBe(0);
}
async function isolatedClipboard(baseURL: string | undefined, info: TestInfo, run: (page: Page) => Promise<void>): Promise<void> {
    if (!baseURL) throw new Error("Clipboard regressions require the local host fixture server.");
    const browser = await chromium.launch({ headless: true, args: ["--enable-automation"] }); let page: Page | undefined, errors: ReturnType<typeof captureBrowserErrors> | undefined;
    try {
        const session = await browser.newBrowserCDPSession(), commandLine = await session.send("Browser.getBrowserCommandLine"), version = await session.send("Browser.getVersion");
        // Fail before the first clipboard action if a launch change selects a platform-backed browser.
        expect(commandLine.arguments[0]).toMatch(/(?:chrome-headless-shell|headless_shell)(?:\.exe)?$/i);
        expect(commandLine.arguments.some(arg => arg === "--headless" || arg.startsWith("--headless="))).toBe(true);
        expect(version.product).toMatch(/^HeadlessChrome\//);
        await info.attach("headless-clipboard-backend", { contentType: "application/json", body: JSON.stringify({ commandLine, version }, null, 2) }); await session.detach();
        page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 900 } });
        errors = captureBrowserErrors(page.context()); await run(page);
    } catch (error) {
        if (page) {
            const state = await page.evaluate(() => { const fixture = window.hostFixture; if (!fixture) return null;
                const state = fixture.snapshot(); return { state, text: fixture.range(0, state.source.length), clipboard: window.hostKeyboardClipboardAudit?.read(),
                    native: [...document.querySelectorAll("textarea")].map(input => ({ label: input.getAttribute("aria-label"), value: input.value,
                        start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection })) };
            }).catch(() => null);
            await info.attach("failed-clipboard-state", { contentType: "application/json", body: JSON.stringify(state, null, 2) });
            await info.attach("failed-clipboard-view", { contentType: "image/png", body: await page.screenshot() });
        }
        throw error;
    } finally { try { await browser.close(); } finally { errors?.dispose(); errors?.assertClean(); } }
}

const normal = "const café = 'é 😀';\r\nconst end = 123;";
const unverifiedBackend = "Only the guarded Chromium headless shell has a verified process-local clipboard backend; other engines and OS/browser-menu paths remain unverified.";
test("three selected source lines paste one per caret with their trailing line break", async ({ browserName, baseURL }, info) => {
    test.skip(browserName !== "chromium", unverifiedBackend);
    await isolatedClipboard(baseURL, info, async page => {
        const original = "x1\r\nx2\r\nx3\r\naaa\r\nbbb\r\nccc";
        await mount(page, "plain", "candidate", original);
        const source = primary(page);
        await source.press("Control+Home");
        for (let i = 0; i < 3; i++) await source.press("Shift+ArrowDown");
        await source.press("Control+c"); await source.press("ArrowRight");
        await source.press("Control+Alt+ArrowDown"); await source.press("Control+Alt+ArrowDown");
        await source.press("Control+v");
        await exact(page, "x1\r\nx2\r\nx3\r\nx1aaa\r\nx2bbb\r\nx3ccc");
        await page.keyboard.type("!"); await exact(page, "x1\r\nx2\r\nx3\r\nx1!aaa\r\nx2!bbb\r\nx3!ccc");
        await source.press("Control+z"); await source.press("Control+z"); await exact(page, original);
        const events = await page.evaluate(() => window.hostKeyboardClipboardAudit.read());
        expect(events.map(e => [e.type, normalized(e.text)])).toEqual([["copy", "x1\nx2\nx3\n"], ["paste", "x1\nx2\nx3\n"]]);
        await dispose(page, info);
    });
});

test("Shift+Delete cuts a selection or caret line for the next Shift+Insert", async ({ browserName, baseURL }, info) => {
    test.skip(browserName !== "chromium" || process.platform === "darwin", "This shortcut uses the Windows or Linux headless clipboard.");
    await isolatedClipboard(baseURL, info, async page => {
        await mount(page, "plain", "candidate", "cart: red\nlast");
        const source = primary(page);
        await select(page, 0, 4); await source.press("Shift+Delete"); await exact(page, ": red\nlast");
        await source.press("Control+End"); await source.press("Shift+Insert"); await exact(page, ": red\nlastcart");
        await select(page, 2); await source.press("Shift+Delete"); await exact(page, "lastcart");
        await source.press("Shift+Insert"); await exact(page, ": red\nlastcart");
        const events = await page.evaluate(() => window.hostKeyboardClipboardAudit.read());
        expect(events.map(e => [e.type, normalized(e.text)])).toEqual([["cut", "cart"], ["paste", "cart"], ["cut", ": red\n"], ["paste", ": red\n"]]);
        await source.press("Control+z"); await exact(page, "lastcart");
        await dispose(page, info);
    });
});
test(`plain trusted HTML table paste converts the actual clipboard and keeps captured save and undo`, async ({ browserName, baseURL }, info) => {
    test.skip(browserName !== "chromium", unverifiedBackend);
    await isolatedClipboard(baseURL, info, async page => {
        await mount(page, "plain", "candidate", "source");
        await page.getByRole("checkbox", { name: "Paste tables as CSV", exact: true }).check();
        await page.evaluate(() => {
            const wrapper = document.createElement("div"); wrapper.contentEditable = "true"; wrapper.id = "known-table-clipboard-source"; wrapper.tabIndex = 0;
            wrapper.innerHTML = '<table><tr><th>city</th><th>value</th></tr><tr><td>東京</td><td>A,&quot;B&quot;</td></tr></table>'; document.body.append(wrapper);
            wrapper.focus(); const range = document.createRange(); range.selectNodeContents(wrapper); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
        });
        await page.keyboard.press("Control+c"); await primary(page).focus(); await select(page, 0, 6);
        await primary(page).evaluate(node => node.addEventListener("paste", event => Object.assign(globalThis, { tableNativePaste: { htmlUnits: (event as ClipboardEvent).clipboardData?.getData("text/html").length ?? 0, trusted: event.isTrusted } }), { capture: true, once: true }));
        const before = await snapshot(page); await primary(page).press("Control+v");
        await expect.poll(async () => (await snapshot(page)).bindings.tablePaste.status).toBe("applied"); await waitForReview(page);
        await exact(page, '"city","value"\r\n"東京","A,""B"""');
        const audit = await page.evaluate(() => (globalThis as unknown as { tableNativePaste: { htmlUnits: number; trusted: boolean } }).tableNativePaste);
        expect(audit.trusted).toBe(true); expect(audit.htmlUnits).toBeGreaterThan(0);
        expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
        await page.evaluate(() => window.hostFixture.finishSave()); await waitForReview(page); expect((await snapshot(page)).source.dirty).toBe(true);
        await page.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+z"); await waitForReview(page); await exact(page, "source"); expect((await snapshot(page)).source.dirty).toBe(false);
        await dispose(page, info);
    });
});
for (const editor of ["native", "candidate"] as const) {
    test(`plain ${editor} trusted clipboard preserves selections, captured save and shared history`, async ({ browserName, baseURL }, info) => {
        test.skip(browserName !== "chromium", unverifiedBackend);
        await isolatedClipboard(baseURL, info, async page => {
            const original = normal;
            const from = 6, to = original.indexOf("const end");
            await mount(page, "plain", editor, original); await primary(page).focus(); await select(page, from, to); await select(page, 3, 3, "secondary");
            const captured = await snapshot(page); expect(sourceSelection(captured, "primary")).toMatchObject({ anchor: to, head: from });
            await copyToKnownControl(page, original.slice(from, to));
            await primary(page).press("Control+x"); await waitForReview(page); const cut = original.slice(0, from) + original.slice(to), cutState = await snapshot(page);
            await exact(page, cut); expect(cutState.source.revision).toBe(captured.source.revision + 1); expect(cutState.history.undoDepth).toBe(captured.history.undoDepth + 1);
            expect(sourceSelection(cutState, "primary")).toMatchObject({ anchor: from, head: from });
            expect(sourceSelection(cutState, "secondary")).toEqual(sourceSelection(captured, "secondary")); expect(cutState.pendingSaves).toEqual(captured.pendingSaves);
            const peer = page.getByRole("textbox", { name: "Secondary source", exact: true });
            await peer.focus(); await peer.press("Control+z"); await waitForReview(page); await exact(page, original);
            await peer.press("Control+Shift+z"); await waitForReview(page); await exact(page, cut);
            await primary(page).focus(); await select(page, from); await select(page, 3, 3, "secondary"); const beforePaste = await snapshot(page);
            await primary(page).press("Control+v"); await waitForReview(page);
            const events = await page.evaluate(() => window.hostKeyboardClipboardAudit.read()), paste = events.at(-1)!;
            expect(events.map(event => event.type)).toEqual(["copy", "paste", "cut", "paste"]);
            expect(paste).toMatchObject({ trusted: true, label: "Primary source", prevented: editor === "candidate" });
            expect(normalized(paste.text)).toBe(normalized(original.slice(from, to)));
            // Cutting the sole CRLF in the normal sample leaves a single line, whose default is LF.
            const inserted = normalized(paste.text);
            const pasted = cut.slice(0, from) + inserted + cut.slice(from), afterPaste = await snapshot(page);
            await exact(page, pasted); expect(afterPaste.source.revision).toBe(beforePaste.source.revision + 1);
            expect(afterPaste.history.undoDepth).toBe(cutState.history.undoDepth + 1);
            expect(sourceSelection(afterPaste, "primary")).toMatchObject({ anchor: from + inserted.length, head: from + inserted.length });
            expect(sourceSelection(afterPaste, "secondary")).toEqual(sourceSelection(beforePaste, "secondary")); expect(afterPaste.pendingSaves).toEqual(captured.pendingSaves);
            if (editor === "candidate") { expect(afterPaste.source.exports).toBe(0); expect(afterPaste.bindings.views.every(view => view.metrics && view.metrics.inputUnits <= 2600)).toBe(true); }
            await select(page, pasted.length); await primary(page).pressSequentially("q"); await waitForReview(page); await exact(page, pasted + "q");
            expect((await snapshot(page)).pendingSaves).toEqual(captured.pendingSaves);
            await page.evaluate(() => window.hostFixture.finishSave()); await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1"); await waitForReview(page);
            await exact(page, pasted + "q"); expect((await snapshot(page)).source.dirty).toBe(true);
            for (const [expected, clean] of [[pasted, pasted === original], [cut, false], [original, true]] as const) {
                await primary(page).press("Control+z"); await waitForReview(page); await exact(page, expected); expect((await snapshot(page)).source.dirty).toBe(!clean);
            }
            for (const expected of [cut, pasted, pasted + "q"]) { await primary(page).press("Control+Shift+z"); await waitForReview(page); await exact(page, expected); }
            await dispose(page, info);
        });
    });
    test(`plain ${editor} trusted read-only clipboard preserves source and history until permission returns`, async ({ browserName, baseURL }, info) => {
        test.skip(browserName !== "chromium", unverifiedBackend);
        await isolatedClipboard(baseURL, info, async page => {
            await mount(page, "plain", editor, normal);
            // Exercise the read-only command before capturing the next save.
            await page.evaluate(() => window.hostFixture.finishSave()); await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1"); await waitForReview(page);
            await page.evaluate(() => window.hostFixture.setSourceReadOnly(true));
            await expect(primary(page)).toHaveAttribute("readonly", ""); await primary(page).focus();
            const from = 6, to = normal.indexOf("const end"); await select(page, from, to); await select(page, 3, 3, "secondary");
            await copyToKnownControl(page, normal.slice(from, to)); const before = await snapshot(page);
            for (const shortcut of ["Control+x", "Control+v"]) {
                await primary(page).press(shortcut);
                if (editor === "candidate") {
                    const notice = page.getByLabel("Primary source edit feedback", { exact: true });
                    await expect(notice, shortcut).toBeVisible();
                    await primary(page).blur(); await expect(notice).toBeHidden(); await primary(page).focus();
                }
            }
            await primary(page).pressSequentially("q"); await waitForReview(page);
            const after = await snapshot(page); await exact(page, normal);
            expect(after.source.revision).toBe(before.source.revision); expect(after.source.exports).toBe(before.source.exports);
            expect(after.history).toEqual(before.history); expect(after.pendingSaves).toEqual(before.pendingSaves); expect(selections(after)).toEqual(selections(before));
            await page.evaluate(() => window.hostFixture.setSourceReadOnly(false)); await expect(primary(page)).not.toHaveAttribute("readonly", ""); await primary(page).focus(); await waitForReview(page);
            expect(sourceSelection(await snapshot(page), "primary")).toEqual(sourceSelection(before, "primary"));
            await button(page, "Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
            const pending = (await snapshot(page)).pendingSaves; await primary(page).focus();
            await primary(page).pressSequentially("q"); await waitForReview(page); const expected = normal.slice(0, from) + "q" + normal.slice(to);
            await exact(page, expected); const typed = await snapshot(page); expect(typed.source.revision).toBe(before.source.revision + 1);
            expect(sourceSelection(typed, "primary")).toMatchObject({ anchor: from + 1, head: from + 1 }); expect(typed.pendingSaves).toEqual(pending);
            await page.evaluate(() => window.hostFixture.finishSave()); await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v2"); await waitForReview(page);
            await exact(page, expected); expect((await snapshot(page)).source.dirty).toBe(true);
            await primary(page).press("Control+z"); await waitForReview(page); await exact(page, normal); expect((await snapshot(page)).source.dirty).toBe(false);
            await primary(page).press("Control+Shift+z"); await waitForReview(page); await exact(page, expected); expect((await snapshot(page)).source.dirty).toBe(true);
            await dispose(page, info);
        });
    });
}
