import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
async function waitForReview(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (s.bindings.comparison !== null); });
}

test(`react review typing retains unchanged labels and controls while new reference versions still appear`, async ({ page }) => {

    await page.goto(`/hosts/react/`);
    const input = page.getByRole("textbox", { name: "Primary source", exact: true }), original = "const sample = 1; // TODO\n" + "x".repeat(48_000);
    await expect(input).toBeVisible();
    await page.getByRole("button", { name: "Open source review", exact: true }).click(); await waitForReview(page);
    await page.evaluate(text => { const f = window.hostFixture, state = f.snapshot(); f.editSource(state.source.revision, [{ from: 0, to: state.source.length, insert: text }]); }, original);
    await page.getByRole("button", { name: "Capture review acceptance", exact: true }).click();
    await page.getByRole("button", { name: "Finish review acceptance", exact: true }).click(); await waitForReview(page);
    await page.getByRole("button", { name: "Save source", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1); await page.evaluate(() => window.hostFixture.finishSave());
    await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0);
    await page.getByRole("button", { name: "Capture reference refresh", exact: true }).click();
    await page.getByRole("button", { name: "Finish reference refresh", exact: true }).click(); await waitForReview(page);
    const reference = page.getByRole("heading", { name: "Baseline · reference:saved-v1", exact: true }); await expect(reference).toBeVisible();
    expect((await snapshot(page)).bindings.comparison!.referenceIsWorkingBuffer).toBe(false);
    await input.press("Control+Home"); for (let i = 0; i < 8; i++) await input.press("ArrowRight");
    await input.press("Control+Space"); await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible();
    await expect(page.getByLabel("Source diagnostics", { exact: true })).toContainText(`${original.indexOf("TODO")}: Resolve this placeholder.`);
    await input.press("Control+End"); await waitForReview(page);
    const probe = await page.evaluateHandle(() => {
        const root = document.querySelector('.st-comparison[aria-label="Source review"]')!, heading = [...root.querySelectorAll("h3")].find(h => h.textContent!.startsWith("Baseline ·"))!;
        const fields = new Map<Node, string>([[heading, "reference"], [document.querySelector('[aria-label="Language status"]')!, "language"],
            [document.querySelector('[aria-label="Find status"]')!, "find"], [document.querySelector('[aria-label="Host operation status"]')!, "host"]]);
        const first = heading.firstChild, duplicates: Record<string, number> = { reference: 0, language: 0, find: 0, host: 0 };
        const collect = (records: readonly MutationRecord[]) => { for (const record of records) { const key = fields.get(record.target); if (!key) continue;
            const before = [...record.removedNodes].map(n => n.textContent).join(""), after = [...record.addedNodes].map(n => n.textContent).join("");
            if (before === after) duplicates[key] = duplicates[key]! + 1;
        } };
        const observer = new MutationObserver(collect); for (const node of fields.keys()) observer.observe(node, { childList: true });
        return { read: () => { collect(observer.takeRecords()); return { duplicates, referenceRetained: heading.firstChild === first }; }, stop: () => observer.disconnect() };
    });
    try {
        await input.pressSequentially("x".repeat(32)); await waitForReview(page);
        expect(await page.evaluate(text => { const f = window.hostFixture; return f.range(0, text.length) === text; }, original + "x".repeat(32))).toBe(true);
        const observed = await probe.evaluate(p => p.read());
        expect(observed.duplicates).toEqual({ reference: 0, language: 0, find: 0, host: 0 }); expect(observed.referenceRetained).toBe(true);
    } finally { await probe.evaluate(p => p.stop()); await probe.dispose(); }
    await input.press("Control+Home"); for (let i = 0; i < 8; i++) await input.press("ArrowRight");
    await input.press("Control+Space"); await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible();
    await page.getByLabel("Source diagnostics", { exact: true }).getByRole("button", { name: `${original.indexOf("TODO")}: Resolve this placeholder.`, exact: true }).click();
    await expect(input).toBeFocused();
    expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: original.indexOf("TODO"), head: original.indexOf("TODO") + 4 });
    await page.getByRole("button", { name: "Save source", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1); await page.evaluate(() => window.hostFixture.finishSave());
    await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0);
    await page.getByRole("button", { name: "Capture reference refresh", exact: true }).click();
    await page.getByRole("button", { name: "Finish reference refresh", exact: true }).click(); await waitForReview(page);
    await expect(page.getByRole("heading", { name: "Baseline · reference:saved-v2", exact: true })).toBeVisible();
    expect((await snapshot(page)).source.dirty).toBe(false); expect((await snapshot(page)).bindings.comparison!.hunks).toBe(0);
    await page.evaluate(() => window.hostFixture.dispose());
});
