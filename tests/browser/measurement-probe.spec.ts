import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const { installHostReferenceProbe } = await import(new URL("../../scripts/host-reference-probe.mjs", import.meta.url).href) as { installHostReferenceProbe: () => void };
type Result = { kind: string; transactions: number; insertedUnits: number; revision: number; commandToFullReviewReadyProxyMs: number | null;
    lastInputToFullReviewReadyProxyMs: number | null; records: { trusted?: boolean; keydownHandlerMs?: number; inputHandlerMs?: number; workingRenderProxyMs: number | null }[] };
type Probe = { arm: (options: { kind: string; text?: string; caretOffset?: number; operation?: string; replaceSelection?: boolean }) => void;
    waitReady: () => Promise<unknown>; read: () => Promise<Result>; snapshot: () => { finished: boolean; failure?: string; records: unknown[] } };
declare global { interface Window { hostReferenceProbe: Probe } }

async function mount(page: Page, host: string) {
    await page.goto(`/hosts/${host}/?editor=candidate`); await ready(page);
    await page.evaluate(installHostReferenceProbe);
    await page.getByRole("button", { name: "Open source review", exact: true }).click(); await ready(page);
    await page.getByRole("button", { name: "Capture review acceptance", exact: true }).click();
    await page.evaluate(() => window.hostReferenceProbe.arm({ kind: "reference", operation: "identity" }));
    await page.getByRole("button", { name: "Finish review acceptance", exact: true }).click();
    expect((await page.evaluate(() => window.hostReferenceProbe.read())).kind).toBe("reference");
}

for (const host of ["plain", "react"]) test(`${host} Enter measurements separate command clocks, raw newline units and transactions`, async ({ page }) => {
    await mount(page, host); const input = page.getByRole("textbox", { name: "Primary source", exact: true });
    for (const item of [
        { source: "first\nsecond", offset: 3, insert: "\n", caret: 1 },
        { source: "first\r\nsecond", offset: 0, insert: "\r\n", caret: 2 },
        { source: "    abc\r\nnext", offset: 7, insert: "\r\n    ", caret: 6 },
        { source: "{}", offset: 1, insert: "\n  \n", caret: 3, split: true },
        { source: "row\n".repeat(100000), offset: 200001, insert: "\n", caret: 1 },
    ]) {
        await page.evaluate(item => {
            const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: item.source }]);
            f.configureSource("primary", { tabSize: 2, enter: item.split ? () => ({ indent: 1, split: true }) : "keep" });
            f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: item.offset, head: item.offset }]);
        }, item); await ready(page); await input.focus(); await page.evaluate(() => window.hostReferenceProbe.waitReady());
        const before = await page.evaluate(() => window.hostFixture.snapshot().source.revision);
        await page.evaluate(item => window.hostReferenceProbe.arm({ kind: "command", text: item.insert, caretOffset: item.caret }), item);
        await input.press("Enter"); const result = await page.evaluate(() => window.hostReferenceProbe.read());
        expect(result).toMatchObject({ kind: "command", transactions: 1, insertedUnits: item.insert.length, revision: before + 1, lastInputToFullReviewReadyProxyMs: null });
        expect(result.commandToFullReviewReadyProxyMs).toBeGreaterThan(0); expect(result.records).toHaveLength(1);
        expect(result.records[0]!.trusted).toBe(true); expect(result.records[0]!.keydownHandlerMs).toBeGreaterThanOrEqual(0);
        expect(result.records[0]!.inputHandlerMs).toBeUndefined(); expect(result.records[0]!.workingRenderProxyMs).not.toBeNull();
        const expected = item.source.slice(0, item.offset) + item.insert + item.source.slice(item.offset);
        expect(await page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); })).toBe(expected);
        await input.press("Control+z"); await ready(page);
        expect(await page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); })).toBe(item.source);
        await input.press("Control+Shift+z"); await ready(page);
        expect(await page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); })).toBe(expected);
    }
    await page.evaluate(() => window.hostFixture.dispose());
});

test("input measurement identifies its native route and retains a rejected command observation", async ({ page, browserName }) => {
    await mount(page, "plain"); const input = page.getByRole("textbox", { name: "Primary source", exact: true }); await input.focus();
    await page.evaluate(() => window.hostReferenceProbe.waitReady());
    await page.evaluate(() => window.hostReferenceProbe.arm({ kind: "input", text: "😀é" }));
    await page.keyboard.insertText("😀é");
    if (browserName === "firefox") {
        // Playwright's Firefox insertText uses composition; do not label it ordinary native typing.
        await expect(page.evaluate(() => window.hostReferenceProbe.read())).rejects.toThrow("Expected native insertText; received insertCompositionText.");
        expect(await page.evaluate(() => window.hostReferenceProbe.snapshot())).toMatchObject({ finished: true, records: [] });
        await page.evaluate(() => window.hostReferenceProbe.waitReady());
    } else {
        const native = await page.evaluate(() => window.hostReferenceProbe.read());
        expect(native).toMatchObject({ kind: "input", transactions: 1, insertedUnits: 4, commandToFullReviewReadyProxyMs: null });
        expect(native.records).toHaveLength(1); expect(native.records[0]!.inputHandlerMs).toBeGreaterThanOrEqual(0); expect(native.records[0]!.keydownHandlerMs).toBeUndefined();
    }
    await page.evaluate(() => window.hostReferenceProbe.arm({ kind: "command", text: "wrong expected newline" }));
    await input.press("Enter");
    await expect(page.evaluate(() => window.hostReferenceProbe.read())).rejects.toThrow(/Incorrect handled Enter/);
    expect(await page.evaluate(() => window.hostReferenceProbe.snapshot())).toMatchObject({ finished: true, failure: "Incorrect handled Enter text, selection or event counters.", records: [{}] });
    await page.evaluate(() => window.hostReferenceProbe.arm({ kind: "input", text: "q" })); await page.keyboard.type("q");
    expect((await page.evaluate(() => window.hostReferenceProbe.read())).transactions).toBe(1);
    await page.evaluate(() => window.hostFixture.dispose());
});
