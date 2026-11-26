import { expect, ready, test } from "./fixtures.ts";

for (const host of ["plain", "react"]) {
    test(host + " restores Find to the baseline while Save captures the working revision", async ({ page }) => {
        await page.goto("/hosts/" + host + "/");
        const snapshot = () => page.evaluate(() => window.hostFixture.snapshot());
        const button = (name: string) => page.getByRole("button", { name, exact: true });
        const input = (name: string) => page.getByRole("textbox", { name, exact: true });
        const baseline = input("Comparison baseline source"), working = input("Comparison working source");
        const query = input("Find text"), status = page.locator(".st-find-status");
        const original = "only baseline";
        await page.evaluate(text => {
            const f = window.hostFixture, source = f.snapshot().source;
            f.editSource(source.revision, [{ from: 0, to: source.length, insert: text }]);
        }, original);
        for (const name of ["Open source review", "Capture review acceptance", "Finish review acceptance"]) {
            await button(name).click();
            await ready(page);
        }
        await working.press("Control+End");
        await working.pressSequentially(" only");
        await working.press("Control+h");
        await query.fill("only");
        await expect(status).toHaveText(/2 matches|of 2/);
        await expect(button("Replace all")).toBeEnabled();

        await baseline.focus();
        await expect(status).toHaveText(/1 match|of 1/);
        await expect(button("Replace all")).toBeDisabled();
        const word = button("Match whole word");
        await word.click();
        const mounted = await snapshot();
        await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
        await ready(page);
        await expect(query).toHaveValue("only");
        await expect(word).toHaveAttribute("aria-pressed", "true");
        await expect(status).toHaveText(/1 match|of 1/);
        await expect(button("Replace all")).toBeDisabled();
        await query.press("Enter");
        await ready(page);
        const reviewed = await snapshot();
        expect(reviewed.bindings.comparison!.referenceViewport!.selection).toMatchObject({ anchor: 0, head: 4 });
        expect(reviewed.bindings.comparison!.selectionSet).toEqual(mounted.bindings.comparison!.selectionSet);
        expect(reviewed.history).toEqual(mounted.history);
        await query.press("Control+s");
        await expect.poll(async () => (await snapshot()).pendingSaves).toMatchObject([
            { revision: mounted.source.revision, length: (original + " only").length }
        ]);
        await query.press("Escape");
        await expect(baseline).toBeFocused();
        await page.evaluate(() => window.hostFixture.dispose());
    });
}
