import { expect, test, type Page } from "@playwright/test";

const firstLine = 'const obj={"palette":"blue","shade":2};const result=obj["palette"];';
const bundle = [firstLine, ...Array.from({ length: 200 }, (_, i) =>
    `let k${i}="${"abcdef".repeat(i === 10 ? 16384 : 100)}";`)].join("\n");

async function pasteBundle(page: Page, url: string) {
    await page.goto(url);
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+a");
    await source.evaluate((input, text) => {
        const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
        event.clipboardData!.setData("text/plain", text);
        input.dispatchEvent(event);
    }, bundle);
    await source.press("Control+Home");
    const viewport = page.locator("#editor .st-viewport");
    const property = viewport.locator(".demo-token-string").filter({ hasText: '"palette"' }).first();
    await expect(property).toBeVisible();
    return { source, viewport, box: (await property.boundingBox())! };
}

export async function dragBundleScrollbars(page: Page, url: string) {
    const { source, viewport } = await pasteBundle(page, url);
    for (let i = 0; i < 5; i++) await source.press("Shift+ArrowRight");
    const selection = () => source.evaluate(node => {
        const input = node as HTMLTextAreaElement;
        return [input.selectionStart, input.selectionEnd, input.value.slice(input.selectionStart, input.selectionEnd)];
    });
    const before = await selection();
    expect(before[2]).toBe("const");
    const box = await viewport.evaluate((el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.left + el.clientLeft, y: rect.top + el.clientTop, w: el.clientWidth, h: el.clientHeight,
            vertical: el.offsetWidth - el.clientWidth, horizontal: el.offsetHeight - el.clientHeight };
    });
    const thickness = Math.min(box.vertical, box.horizontal);
    test.skip(test.info().project.name !== "chromium" && thickness === 0, "The headless engine exposes no draggable scrollbar gutter.");
    expect(thickness).toBeGreaterThan(0);
    for (const vertical of [true, false]) {
        const x = vertical ? box.x + box.w + box.vertical / 2 : box.x + 23;
        const y = vertical ? box.y + 23 : box.y + box.h + box.horizontal / 2;
        const scroll = () => viewport.evaluate((el, v) => v ? el.scrollTop : el.scrollLeft, vertical);
        await page.mouse.move(x, y); await page.mouse.down();
        await page.mouse.move(vertical ? x : box.x + box.w / 3, vertical ? box.y + box.h / 3 : y, { steps: 8 });
        await expect.poll(scroll).toBeGreaterThan(0);
        const middle = await scroll();
        await page.mouse.move(vertical ? x : box.x + box.w / 2, vertical ? box.y + box.h / 2 : y, { steps: 8 });
        await page.mouse.up();
        await expect.poll(scroll).toBeGreaterThan(middle);
        expect(await selection()).toEqual(before);
    }
}

export async function selectInsideString(page: Page, url: string) {
    const { source, viewport, box } = await pasteBundle(page, url);
    const color = "rgb(69, 98, 136)";
    await viewport.evaluate((el, value) => el.style.setProperty("--st-selection", value), color);
    const y = box.y + box.height / 2, x = box.x + box.width * 4 / 9;
    await page.mouse.click(x, y);
    const occurrence = viewport.locator(".demo-token-string.st-occurrence-write");
    await expect(occurrence.first()).toBeVisible();
    const selected = occurrence.and(viewport.locator(".st-viewport-selected"));
    await source.press("Shift+ArrowRight"); await source.press("Shift+ArrowRight");
    await expect(selected).toHaveText("et"); await expect(selected).toHaveCSS("background-color", color);
    await source.press("ArrowLeft");
    await page.mouse.move(box.x + box.width / 9, y); await page.mouse.down();
    await page.mouse.move(box.x + box.width * 5 / 9, y, { steps: 6 }); await page.mouse.up();
    await expect(selected).toHaveText("pale"); await expect(selected).toHaveCSS("background-color", color);
    await expect(viewport.locator(".st-occurrence-write:not(.st-viewport-selected)").first()).not.toHaveCSS("background-color", color);
}

export async function hoverString(page: Page, url: string) {
    await page.addInitScript(() => {
        const probe = { requests: 0, hides: 0 };
        Reflect.set(window, "bundleHover", probe);
        Worker.prototype.postMessage = new Proxy(Worker.prototype.postMessage, { apply(target, worker, args) {
            if (typeof args[0] === "string" && args[0].includes('"method":"textDocument/hover"')) probe.requests++;
            return Reflect.apply(target, worker, args);
        } });
    });
    const { viewport, box } = await pasteBundle(page, url);
    await expect(page.locator("#language-status")).toHaveText("Language ready");
    await expect(page.locator("#analysis-status")).toContainText("syntax & emit");
    const tooltip = page.locator(".demo-language-popups .host-symbol-info:not(.host-signature)");
    const counts = () => page.evaluate(() => Reflect.get(window, "bundleHover") as { requests: number; hides: number });
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await expect(tooltip).toContainText('"palette": string');
    await expect(tooltip).toBeVisible();
    await tooltip.evaluate(popup => {
        const probe = Reflect.get(window, "bundleHover") as { hides: number };
        new MutationObserver(records => { probe.hides += records.filter(r => r.oldValue === null).length; })
            .observe(popup, { attributes: true, attributeOldValue: true, attributeFilter: ["hidden"] });
    });
    const before = await counts();
    // Deliver native moves at the same pixel and at another character in this hover range.
    // Each pause lets a duplicate request cross the host's 300 ms pointer dwell.
    for (const at of [x, x + box.width / 9]) {
        await page.mouse.move(at, y); await page.waitForTimeout(400);
    }
    expect(await counts()).toEqual(before);
    await expect(tooltip).toBeVisible();
    await viewport.locator(".demo-token-string").filter({ hasText: '"shade"' }).hover();
    await expect(tooltip).toContainText('"shade": number');
    expect((await counts()).requests).toBeGreaterThan(before.requests);
    await page.mouse.move(0, 0); await expect(tooltip).toBeHidden();
}
