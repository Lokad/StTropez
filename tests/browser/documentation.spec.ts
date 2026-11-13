import { test, expect } from "@playwright/test";
import type { DocumentationView } from "../../src/browser/index.ts";
declare global { interface Window { documentationTest: { view: DocumentationView; opened: string[]; allowed: boolean; retired?: HTMLButtonElement } } }

test("documentation preserves format, renders the focused subset and leaves HTML and unauthorized links inert", async ({ page }) => {
    await page.goto("/protocol/");
    await page.evaluate(() => {
        const host = document.createElement("section"); host.id = "documentation-test"; document.body.append(host);
        const opened: string[] = [], view = window.protocolFixture.mountDocumentation(host, {
            canOpenLink: target => window.documentationTest.allowed && target.startsWith("help:"), openLink: target => opened.push(target),
        });
        window.documentationTest = { view, opened, allowed: true };
        view.setContent([{ kind: "plaintext", value: "**literal** <img src=x onerror=alert(1)>" }, { kind: "markdown", value:
            "A **strong** and *emphasized* paragraph with `code` and an_under_score.\n\n- First **item**\n- Second\n\n3. Ordered\n4. Again\n\n~~~ts\n<script>alert(1)</script>\n~~~\n\n[Help](help:topic(one)) [Rejected](javascript:alert(1)) ![image](https://invalid.example/image.png)" }]);
    });
    const root = page.locator("#documentation-test");
    await expect(root.locator(".st-documentation-plain")).toHaveText("**literal** <img src=x onerror=alert(1)>");
    await expect(root.locator("strong")).toHaveText(["strong", "item"]); await expect(root.locator("em")).toHaveText("emphasized");
    await expect(root.locator("ul li")).toHaveText(["First item", "Second"]); await expect(root.locator("ol")).toHaveAttribute("start", "3");
    await expect(root.locator("pre code")).toHaveText("<script>alert(1)</script>");
    await expect(root.locator("img,script,iframe,a[href]")).toHaveCount(0);
    await expect(root.getByRole("button")).toHaveCount(1); await root.getByRole("button", { name: "Help", exact: true }).click();
    expect(await page.evaluate(() => window.documentationTest.opened)).toEqual(["help:topic(one)"]);
    await page.evaluate(() => { window.documentationTest.allowed = false; });
    await root.getByRole("button", { name: "Help", exact: true }).click();
    expect(await page.evaluate(() => window.documentationTest.opened)).toEqual(["help:topic(one)"]);
    const result = await page.evaluate(() => {
        const state = window.documentationTest; state.retired = document.querySelector<HTMLButtonElement>("#documentation-test button")!;
        state.allowed = true; state.view.setContent([{ kind: "markdown", value: "Replacement" }]); state.retired.click();
        state.view.dispose(); state.view.setContent([{ kind: "markdown", value: "[Later](help:later)" }]); state.retired.click();
        return { opened: state.opened, children: document.getElementById("documentation-test")!.childElementCount };
    });
    expect(result).toEqual({ opened: ["help:topic(one)"], children: 0 });
});

test("documentation handles escaped delimiters, unterminated fences and large unmatched punctuation without losing text", async ({ page }) => {
    await page.goto("/protocol/");
    const result = await page.evaluate(() => {
        const host = document.createElement("section"); host.id = "documentation-test"; document.body.append(host);
        const view = window.protocolFixture.mountDocumentation(host);
        view.setContent([{ kind: "markdown", value: "\\*literal\\* and **strong with _emphasis_ inside** and ``a ` b``.\n\n```ts\nUnclosed <tag>\n" }]);
        const parsed = { text: host.textContent, strong: host.querySelector("strong")?.textContent, emphasis: host.querySelector("em")?.textContent, code: [...host.querySelectorAll("code")].map(node => node.textContent) };
        const text = "[ ".repeat(30000) + "* ".repeat(30000), start = performance.now(); view.setContent([{ kind: "markdown", value: text }]);
        const large = { exact: host.textContent === text, nodes: host.querySelectorAll("*").length, elapsedMs: performance.now() - start };
        view.dispose(); return { parsed, large };
    });
    expect(result.parsed.strong).toBe("strong with emphasis inside"); expect(result.parsed.emphasis).toBe("emphasis");
    expect(result.parsed.code).toEqual(["a ` b", "Unclosed <tag>\n"]); expect(result.parsed.text).toContain("*literal*");
    expect(result.large.exact).toBe(true); expect(result.large.nodes).toBeLessThan(5);
});
