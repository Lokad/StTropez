import { ready, test, expect } from "./fixtures.ts";
import type { Page, Locator } from "@playwright/test";
import { hostTextEquals } from "../../scripts/host-scene.mjs";

type FocusKey = Readonly<{ key: string; shift: boolean; trusted: boolean; prevented: boolean; tag: string | null; label: string | null }>;
declare global { interface Window { hostFocusEscapeKeys: readonly FocusKey[] } }

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const primary = (page: Page) => page.getByRole("textbox", { name: "Primary source", exact: true });
const secondary = (page: Page) => page.getByRole("textbox", { name: "Secondary source", exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const selections = (state: Awaited<ReturnType<typeof snapshot>>) => state.bindings.views.map(view => ({ id: view.id, selection: view.selection }));

async function waitForViews(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (s.bindings.activeViews === 2); });
}
async function exact(page: Page, text: string): Promise<void> { expect(await hostTextEquals(page, text)).toBe(true); }
/** Traverse the real page tab order; no pointer activation or programmatic focus. */
async function keyboardFocus(page: Page, target: Locator): Promise<void> {
    await expect(target).toBeVisible();
    for (let step = 0; step < 128; step++) {
        const focus = await target.evaluate(node => {
            const active = document.activeElement;
            return { reached: node === active, backward: !!active && !!(node.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING),
                editor: active instanceof HTMLTextAreaElement };
        });
        if (focus.reached) return;
        if (focus.editor) await page.keyboard.press("Escape");
        await page.keyboard.press(focus.backward ? "Shift+Tab" : "Tab");
    }
    throw new Error("Keyboard traversal did not reach the requested host control.");
}
async function activate(page: Page, name: string): Promise<void> {
    await keyboardFocus(page, button(page, name)); await page.keyboard.press("Enter");
}
async function mount(page: Page, host: "plain" | "react", editor: "native" | "candidate", original: string): Promise<void> {

    await page.goto(`/hosts/${host}/?editor=${editor}`); await expect(primary(page)).toBeVisible();
    // Fixture preparation is separate from the keyboard-only user workflow below.
    await page.evaluate(text => { const fixture = window.hostFixture, state = fixture.snapshot();
        fixture.editSource(state.source.revision, [{ from: 0, to: state.source.length, insert: text }]);
    }, original); await waitForViews(page);
    await page.evaluate(() => {
        const records: FocusKey[] = []; window.hostFocusEscapeKeys = records;
        document.addEventListener("keydown", event => {
            const target = event.target instanceof HTMLElement ? event.target : null;
            records.push({ key: event.key, shift: event.shiftKey, trusted: event.isTrusted, prevented: event.defaultPrevented,
                tag: target?.tagName ?? null, label: target?.getAttribute("aria-label") ?? target?.closest("label")?.textContent ?? target?.textContent?.slice(0, 80) ?? null });
        });
    });
}
async function exit(page: Page, backward: boolean): Promise<void> {
    await page.keyboard.press("Escape"); await page.keyboard.press(backward ? "Shift+Tab" : "Tab");
    await expect(backward ? button(page, "Inject form error") : page.getByRole("textbox", { name: "Configuration path", exact: true })).toBeFocused();
}
async function dispose(page: Page): Promise<void> {
    await page.evaluate(() => window.hostFixture.dispose()); const state = await snapshot(page);
    expect(state.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(state.hostSubscriptions).toBe(0);
}

test.afterEach(async ({ page }, info) => {
    if (page.isClosed()) return;
    const keys = await page.evaluate(() => window.hostFocusEscapeKeys ?? []);
    await info.attach("trusted-focus-keys", { contentType: "application/json", body: JSON.stringify(keys, null, 2) });
    if (info.status !== info.expectedStatus) {
        const state = await snapshot(page); await info.attach("failed-host-focus-state", { contentType: "application/json", body: JSON.stringify(state, null, 2) });
        const text = await page.evaluate(() => { const fixture = window.hostFixture; return fixture.range(0, fixture.snapshot().source.length); });
        await info.attach("failed-host-focus-source", { contentType: "text/plain", body: text });
    }
    expect(keys.length).toBeGreaterThan(0); expect(keys.every(key => key.trusted)).toBe(true);
});

for (const host of ["plain", "react"] as const) {
    for (const editor of ["native", "candidate"] as const)
        for (const large of editor === "candidate" ? [false, true] : [false])
            for (const backward of [false, true]) test(`${host} ${editor} ${large ? "100k" : "normal"} ${backward ? "backward" : "forward"} escape preserves keyboard-only save and review`, async ({ page }) => {
                const line = "    const café = 1;", original = large ? Array(100000).fill(line).join("\r\n") : line + "\r\n    const sample = 2;";
                await mount(page, host, editor, original);
                await activate(page, "Save source"); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
                const captured = (await snapshot(page)).pendingSaves;
                await keyboardFocus(page, primary(page)); await page.keyboard.press("Control+End"); await page.keyboard.type("!"); await waitForViews(page);
                const edited = original + "!"; await exact(page, edited); await page.keyboard.press("Control+Home");
                const before = await snapshot(page); await exit(page, backward); await waitForViews(page); const after = await snapshot(page);
                await exact(page, edited); expect(after.source.revision).toBe(before.source.revision); expect(after.history).toEqual(before.history);
                expect(selections(after)).toEqual(selections(before)); expect(after.pendingSaves).toEqual(captured); expect(after.source.exports).toBe(before.source.exports);

                if (!backward) {
                    await page.keyboard.press("End"); await page.keyboard.type(".kbd"); const form = await snapshot(page);
                    expect(await page.getByRole("textbox", { name: "Configuration path", exact: true }).inputValue()).toContain(".kbd");
                    expect(form.source.revision).toBe(before.source.revision);
                    expect(form.history).toEqual(before.history); expect(selections(form)).toEqual(selections(before));
                }
                if (editor === "candidate") {
                    // The exit arm is consumed; ordinary Tab/Shift+Tab still edit one intended history command.
                    await keyboardFocus(page, primary(page)); await page.keyboard.press("Control+Home"); const commands = await snapshot(page);
                    await page.keyboard.press("Tab"); await exact(page, "    " + edited);
                    expect((await snapshot(page)).history.undoDepth).toBe(commands.history.undoDepth + 1);
                    await page.keyboard.press("Shift+Tab"); await exact(page, edited);
                    await page.keyboard.press("Control+z"); await exact(page, "    " + edited);
                    await page.keyboard.press("Control+z"); await exact(page, edited);
                    expect((await snapshot(page)).pendingSaves).toEqual(captured);
                }
                await activate(page, "Finish save"); await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1");
                expect((await snapshot(page)).source.dirty).toBe(true); await exact(page, edited);
                await keyboardFocus(page, secondary(page)); await page.keyboard.press("Control+z"); await exact(page, original);
                expect((await snapshot(page)).source.dirty).toBe(false);
                await page.keyboard.press("Control+Shift+z"); await exact(page, edited); expect((await snapshot(page)).source.dirty).toBe(true);

                await activate(page, "Open source review"); await waitForViews(page);
                await activate(page, "Capture review acceptance"); await activate(page, "Finish review acceptance"); await waitForViews(page);
                const accepted = await snapshot(page); expect(accepted.bindings.comparison?.referenceIsWorkingBuffer).toBe(true);
                expect(accepted.bindings.comparison?.hunks).toBe(0); const baseline = accepted.bindings.comparison!.baseline!.version;
                await keyboardFocus(page, primary(page)); await page.keyboard.press("Control+End"); await page.keyboard.type("q"); await waitForViews(page);
                await exact(page, edited + "q"); expect((await snapshot(page)).bindings.comparison?.hunks).toBe(1);
                await activate(page, "Next change"); await waitForViews(page);
                expect((await snapshot(page)).bindings.comparison?.baseline?.version).toBe(baseline);
                await keyboardFocus(page, primary(page)); await page.keyboard.press("Control+z"); await exact(page, edited); await waitForViews(page);
                expect((await snapshot(page)).bindings.comparison?.hunks).toBe(0);
                // The native baseline projects whole values; only the bounded candidate promises zero ordinary exports.
                if (editor === "candidate") expect((await snapshot(page)).source.exports).toBe(accepted.source.exports);
                await dispose(page);
            });

    for (const backward of [false, true]) test(`${host} read-only ${backward ? "backward" : "forward"} escape remains available before permission restoration`, async ({ page }) => {
        const original = "    const café = 1;\r\n    const sample = 2;";
        await mount(page, host, "candidate", original); await activate(page, "Save source"); await activate(page, "Finish save");
        await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1");
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(true)); await expect(primary(page)).toHaveAttribute("readonly", "");
        await keyboardFocus(page, primary(page)); await page.keyboard.press("Control+Home"); await page.keyboard.type("!");
        const before = await snapshot(page); await exit(page, backward); await waitForViews(page); const after = await snapshot(page);
        await exact(page, original); expect(after.source.revision).toBe(before.source.revision); expect(after.history).toEqual(before.history);
        expect(selections(after)).toEqual(selections(before)); expect(after.source.exports).toBe(before.source.exports);
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(false)); await keyboardFocus(page, primary(page)); await expect(primary(page)).not.toHaveAttribute("readonly", "");
        await page.keyboard.press("Control+End"); await page.keyboard.type("!"); await exact(page, original + "!");
        await page.keyboard.press("Control+z"); await exact(page, original); expect((await snapshot(page)).source.dirty).toBe(false);
        await dispose(page);
    });
}
