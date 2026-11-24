import { isolatedTest as test, expect } from "./fixtures.ts";

for (const feature of ["hover", "signature"] as const) {
    test(`plain ${feature} preserves structured documentation and fits rendered content through remount`, async ({ page }) => {
        const method = feature === "hover" ? "textDocument/hover" : "textDocument/signatureHelp";
        const documentation = { kind: "markdown", value: "**Provider documentation** with `code`.\n\n"
            + "A paragraph tall enough to require fitting after the provider reply.\n\n".repeat(12)
            + "[Host destination](help:topic) <img src=x onerror=alert(1)>" };
        await page.routeWebSocket("**/lsp-fixture", client => {
            const server = client.connectToServer(), requests = new Set<number>();
            client.onMessage(message => {
                const value = JSON.parse(message.toString()); if (value.method === method) requests.add(value.id); server.send(message);
            });
            server.onMessage(message => {
                const value = JSON.parse(message.toString());
                if (!requests.delete(value.id)) { client.send(message); return; }
                client.send(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: feature === "hover" ? { contents: documentation } : {
                    signatures: [{ label: "lookup(value: string): string", documentation,
                        parameters: [{ label: "value: string", documentation: { kind: "markdown", value: "The **active argument**." } }] }],
                    activeSignature: 0, activeParameter: 0,
                } }));
            });
        });
        await page.setViewportSize({ width: 620, height: 460 });
        await page.goto(`/hosts/plain/?language=lsp`);
        const field = page.getByRole("textbox", { name: "Primary source", exact: true });
        await expect(field).toBeVisible();
        await page.evaluate(() => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: "lookup(value)" }]); });
        const popup = page.locator(feature === "hover" ? ".host-symbol-info:not(.host-signature)" : ".host-signature");
        const before = await page.evaluate(() => window.hostFixture.snapshot().history);
        for (let mount = 0; mount < 2; mount++) {
            await field.scrollIntoViewIfNeeded(); await field.focus();
            await page.evaluate(() => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: 9, head: 9 }); });
            if (feature === "hover") { await field.press("Control+k"); await field.press("Control+i"); }
            else await field.press("Control+Shift+Space");
            await expect(popup.locator(".st-documentation strong").first()).toHaveText("Provider documentation");
            await expect(popup.locator("code")).toHaveText("code");
            if (feature === "signature") {
                await expect(popup.getByLabel("Active signature parameter", { exact: true })).toHaveText("value: string");
                await expect(popup.locator(".st-documentation strong").last()).toHaveText("active argument");
            }
            await expect(popup.locator(".st-documentation-link")).toHaveText("Host destination");
            await expect(popup.locator("img,script,a,button")).toHaveCount(0);
            await expect.poll(() => popup.evaluate(node => {
                const box = node.getBoundingClientRect();
                return box.left >= 8 && box.top >= 8 && box.right <= innerWidth - 8 && box.bottom <= innerHeight - 8;
            })).toBe(true);
            await expect(field).toBeFocused();
            expect(await page.evaluate(() => window.hostFixture.snapshot().history)).toEqual(before);
            await field.press("Escape"); await expect(popup).toBeHidden();
            if (mount === 0) {
                await page.evaluate(() => window.hostFixture.unmount()); await expect(popup).toHaveCount(0);
                await page.evaluate(() => window.hostFixture.mount());
            }
        }
        await page.evaluate(() => window.hostFixture.dispose());
        await expect(popup).toHaveCount(0);
        expect(await page.evaluate(() => window.hostFixture.snapshot().hostSubscriptions)).toBe(0);
    });
}
