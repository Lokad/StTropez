import { test, expect, chromium } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";

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
async function ready(page: Page): Promise<void> {
    await expect.poll(async () => {
        const state = await snapshot(page), comparison = state.bindings.comparison;
        return state.bindings.activeViews === 2 && state.bindings.views.every(view => !view.metrics || !view.metrics.pendingCaret
            && !view.metrics.pendingWord && !view.metrics.pendingGrapheme && !view.metrics.viewport.pending
            && view.metrics.viewport.revision === state.source.revision)
            && comparison?.status === "ready" && !comparison.workingViewport.pending && !comparison.referenceViewport?.pending;
    }).toBe(true);
}
async function exact(page: Page, text: string): Promise<void> {
    expect(await page.evaluate(text => {
        const fixture = window.hostFixture;
        if (fixture.snapshot().source.length !== text.length) return false;
        for (let from = 0; from < text.length; from += 32768)
            if (fixture.range(from, Math.min(text.length, from + 32768)) !== text.slice(from, from + 32768)) return false;
        return true;
    }, text)).toBe(true);
}
async function select(page: Page, from: number, to = from, id: "primary" | "secondary" = "primary"): Promise<void> {
    expect(await page.evaluate(({ from, to, id }) => { const fixture = window.hostFixture;
        return fixture.selectSource(id, fixture.snapshot().source.revision, { anchor: to, head: from });
    }, { from, to, id })).toBe(true); await ready(page);
}
async function mount(page: Page, host: "plain" | "react", editor: "native" | "candidate", text: string): Promise<void> {
    await page.goto(`/hosts/${host}/?editor=${editor}`);
    await page.evaluate(text => { const fixture = window.hostFixture, state = fixture.snapshot();
        fixture.editSource(state.source.revision, [{ from: 0, to: state.source.length, insert: text }]);
    }, text);
    await button(page, "Open source review").click(); await ready(page);
    await button(page, "Capture review acceptance").click(); await button(page, "Finish review acceptance").click(); await ready(page);
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
    const before = await snapshot(page); await primary(page).press("Control+c"); await ready(page); const after = await snapshot(page);
    expect(after.source.revision).toBe(before.source.revision); expect(after.history).toEqual(before.history);
    expect(after.pendingSaves).toEqual(before.pendingSaves); expect(selections(after)).toEqual(selections(before));
    const sink = page.getByRole("textbox", { name: "Known clipboard probe", exact: true }); await sink.focus(); await sink.press("Control+v");
    const events = await page.evaluate(() => window.hostKeyboardClipboardAudit.read()), copied = events.at(-2)!, pasted = events.at(-1)!;
    expect(copied).toMatchObject({ type: "copy", trusted: true, label: "Primary source" });
    expect(pasted).toMatchObject({ type: "paste", trusted: true, label: "Known clipboard probe" });
    expect(normalized(pasted.text)).toBe(normalized(selected)); expect(await sink.inputValue()).toBe(normalized(pasted.text));
    await primary(page).focus(); await ready(page); expect(selections(await snapshot(page))).toEqual(selections(before)); return pasted.text;
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
    const browser = await chromium.launch({ headless: true, args: ["--enable-automation"] }); let page: Page | undefined;
    try {
        const session = await browser.newBrowserCDPSession(), commandLine = await session.send("Browser.getBrowserCommandLine"), version = await session.send("Browser.getVersion");
        // Fail before the first clipboard action if a launch change selects a platform-backed browser.
        expect(commandLine.arguments[0]).toMatch(/(?:chrome-headless-shell|headless_shell)(?:\.exe)?$/i);
        expect(commandLine.arguments.some(arg => arg === "--headless" || arg.startsWith("--headless="))).toBe(true);
        expect(version.product).toMatch(/^HeadlessChrome\//);
        await info.attach("headless-clipboard-backend", { contentType: "application/json", body: JSON.stringify({ commandLine, version }, null, 2) }); await session.detach();
        page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 900 } });
        page.on("pageerror", error => { throw error; }); await run(page);
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
    } finally { await browser.close(); }
}

const normal = "const café = 'é 😀';\r\nconst end = 123;";
const unverifiedBackend = "Only the guarded Chromium headless shell has a verified process-local clipboard backend; other engines and OS/browser-menu paths remain unverified.";
for (const host of ["plain", "react"] as const) for (const editor of ["native", "candidate"] as const) {
    for (const corpus of editor === "candidate" ? ["normal", "lines-100000"] : ["normal"]) {
        test(`${host} ${editor} ${corpus} trusted clipboard preserves selections, captured save and shared history`, async ({ browserName, baseURL }, info) => {
            test.skip(browserName !== "chromium", unverifiedBackend);
            await isolatedClipboard(baseURL, info, async page => {
                const original = corpus === "normal" ? normal : Array(100000).fill("const sample = 1234567;").join("\r\n");
                const from = corpus === "normal" ? 6 : 100000, to = corpus === "normal" ? original.indexOf("const end") : original.length - 100000;
                await mount(page, host, editor, original); await primary(page).focus(); await select(page, from, to); await select(page, 3, 3, "secondary");
                const captured = await snapshot(page); expect(sourceSelection(captured, "primary")).toMatchObject({ anchor: to, head: from });
                await copyToKnownControl(page, original.slice(from, to));
                await primary(page).press("Control+x"); await ready(page); const cut = original.slice(0, from) + original.slice(to), cutState = await snapshot(page);
                await exact(page, cut); expect(cutState.source.revision).toBe(captured.source.revision + 1); expect(cutState.history.undoDepth).toBe(captured.history.undoDepth + 1);
                expect(sourceSelection(cutState, "primary")).toMatchObject({ anchor: from, head: from });
                expect(sourceSelection(cutState, "secondary")).toEqual(sourceSelection(captured, "secondary")); expect(cutState.pendingSaves).toEqual(captured.pendingSaves);
                const peer = page.getByRole("textbox", { name: "Secondary source", exact: true });
                await peer.focus(); await peer.press("Control+z"); await ready(page); await exact(page, original);
                await peer.press("Control+Shift+z"); await ready(page); await exact(page, cut);
                await primary(page).focus(); await select(page, from); await select(page, 3, 3, "secondary"); const beforePaste = await snapshot(page);
                await primary(page).press("Control+v"); await ready(page);
                const events = await page.evaluate(() => window.hostKeyboardClipboardAudit.read()), paste = events.at(-1)!;
                expect(events.map(event => event.type)).toEqual(["copy", "paste", "cut", "paste"]);
                expect(paste).toMatchObject({ trusted: true, label: "Primary source", prevented: editor === "candidate" });
                expect(normalized(paste.text)).toBe(normalized(original.slice(from, to)));
                // The native baseline commits textarea.value; the candidate handles the raw event payload itself.
                const inserted = editor === "native" ? normalized(paste.text) : paste.text, pasted = cut.slice(0, from) + inserted + cut.slice(from), afterPaste = await snapshot(page);
                await exact(page, pasted); expect(afterPaste.source.revision).toBe(beforePaste.source.revision + 1);
                expect(afterPaste.history.undoDepth).toBe(cutState.history.undoDepth + 1);
                expect(sourceSelection(afterPaste, "primary")).toMatchObject({ anchor: from + inserted.length, head: from + inserted.length });
                expect(sourceSelection(afterPaste, "secondary")).toEqual(sourceSelection(beforePaste, "secondary")); expect(afterPaste.pendingSaves).toEqual(captured.pendingSaves);
                if (editor === "candidate") { expect(afterPaste.source.exports).toBe(0); expect(afterPaste.bindings.views.every(view => view.metrics && view.metrics.inputUnits <= 2600)).toBe(true); }
                await select(page, pasted.length); await primary(page).pressSequentially("q"); await ready(page); await exact(page, pasted + "q");
                expect((await snapshot(page)).pendingSaves).toEqual(captured.pendingSaves);
                await page.evaluate(() => window.hostFixture.finishSave()); await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1"); await ready(page);
                await exact(page, pasted + "q"); expect((await snapshot(page)).source.dirty).toBe(true);
                for (const [expected, clean] of [[pasted, pasted === original], [cut, false], [original, true]] as const) {
                    await primary(page).press("Control+z"); await ready(page); await exact(page, expected); expect((await snapshot(page)).source.dirty).toBe(!clean);
                }
                for (const expected of [cut, pasted, pasted + "q"]) { await primary(page).press("Control+Shift+z"); await ready(page); await exact(page, expected); }
                await dispose(page, info);
            });
        });
    }
    test(`${host} ${editor} trusted read-only clipboard preserves source and history until permission returns`, async ({ browserName, baseURL }, info) => {
        test.skip(browserName !== "chromium", unverifiedBackend);
        await isolatedClipboard(baseURL, info, async page => {
            await mount(page, host, editor, normal);
            // Agent requests require settled saves; test the lock before capturing the next save.
            await page.evaluate(() => window.hostFixture.finishSave()); await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1"); await ready(page);
            await button(page, "Associate agent").click(); await button(page, "Request proposal").click();
            await expect(primary(page)).toHaveAttribute("readonly", ""); await primary(page).focus();
            const from = 6, to = normal.indexOf("const end"); await select(page, from, to); await select(page, 3, 3, "secondary");
            await copyToKnownControl(page, normal.slice(from, to)); const before = await snapshot(page);
            await primary(page).press("Control+x"); await primary(page).press("Control+v"); await primary(page).pressSequentially("q"); await ready(page);
            const after = await snapshot(page); await exact(page, normal);
            expect(after.source.revision).toBe(before.source.revision); expect(after.source.exports).toBe(before.source.exports);
            expect(after.history).toEqual(before.history); expect(after.pendingSaves).toEqual(before.pendingSaves); expect(selections(after)).toEqual(selections(before));
            await button(page, "Interrupt agent").click(); await expect(primary(page)).not.toHaveAttribute("readonly", ""); await primary(page).focus(); await ready(page);
            expect(sourceSelection(await snapshot(page), "primary")).toEqual(sourceSelection(before, "primary"));
            await button(page, "Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
            const pending = (await snapshot(page)).pendingSaves; await primary(page).focus();
            await primary(page).pressSequentially("q"); await ready(page); const expected = normal.slice(0, from) + "q" + normal.slice(to);
            await exact(page, expected); const typed = await snapshot(page); expect(typed.source.revision).toBe(before.source.revision + 1);
            expect(sourceSelection(typed, "primary")).toMatchObject({ anchor: from + 1, head: from + 1 }); expect(typed.pendingSaves).toEqual(pending);
            await page.evaluate(() => window.hostFixture.finishSave()); await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v2"); await ready(page);
            await exact(page, expected); expect((await snapshot(page)).source.dirty).toBe(true);
            await primary(page).press("Control+z"); await ready(page); await exact(page, normal); expect((await snapshot(page)).source.dirty).toBe(false);
            await primary(page).press("Control+Shift+z"); await ready(page); await exact(page, expected); expect((await snapshot(page)).source.dirty).toBe(true);
            await dispose(page, info);
        });
    });
}
