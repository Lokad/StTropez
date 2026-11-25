import { ready, test, expect } from "./fixtures.ts";
import { typeAfterClick } from "../helpers/editor-assertions.ts";

test.beforeEach(async ({ page }) => {  await page.goto("/comparison/"); await ready(page); });

test("shared commands keep the initiating pane through focus changes and expire chords on baseline refresh", async ({ page }) => {
    const initial = await page.evaluate(() => {
        const review = window.comparisonFixture.review;
        const { working, reference } = review.panes;
        const field = document.createElement("input");
        field.id = "command-field";
        document.body.append(field);
        field.addEventListener("keydown", event => review.activePane().keymap.handle(event));
        const id = "host.mark";
        review.commands.register({ id, label: "Mark pane", owner: "annotations", category: "Review",
            run: (_, pane) => { field.value += pane === reference ? "R" : "W"; } },
            { keys: ["Mod+k Mod+j"], shared: true });
        // The second pane owns this key. A failed shared registration must release the first pane's binding.
        reference.commands.register({ id: "host.local", label: "Local", run() {} }, { keys: ["F8"] });
        let conflict = false;
        try {
            review.commands.register({ id: "host.other", label: "Other", run() {} }, { keys: ["F8"] });
        } catch (error) { conflict = String(error).includes("Key binding conflicts"); }
        working.commands.register({ id: "host.reclaimed", label: "Reclaimed", run() {} }, { keys: ["F8"] });
        return { info: reference.commands.get(id), count: review.commands.list().filter(row => row.id === id).length,
            conflict, rolledBack: !working.commands.get("host.other") && !reference.commands.get("host.other") };
    });
    expect(initial).toEqual({ info: { id: "host.mark", label: "Mark pane", owner: "annotations", category: "Review",
        enabled: true }, count: 1, conflict: true, rolledBack: true });
    const working = page.getByRole("textbox", { name: "Comparison working source" });
    const reference = page.getByRole("textbox", { name: "Comparison baseline source" });
    const field = page.locator("#command-field");
    await reference.press("Control+k");
    await working.press("Control+j");
    await expect(field).toHaveValue("");
    await working.press("Control+k");
    await working.press("Control+j");
    await expect(field).toHaveValue("W");
    await reference.focus();
    await field.focus();
    await field.press("Control+k");
    await field.press("Control+j");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("WR");
    await reference.press("Control+k");
    await page.evaluate(() => {
        const { controller } = window.comparisonFixture.review;
        const buffer = controller.getSnapshot().baseline!.buffer;
        controller.beginRefresh().complete({ buffer, version: "second" });
    });
    await reference.press("Control+j");
    await expect(field).toHaveValue("WR");
    await reference.press("Control+k");
    await reference.press("Control+j");
    await expect(field).toHaveValue("WRR");
    const retired = await page.evaluate(() => {
        const review = window.comparisonFixture.review;
        review.dispose();
        return [review.commands.run("host.mark"), review.panes.reference.commands.run("host.mark"),
            review.panes.working.commands.run("host.mark")];
    });
    expect(retired).toEqual([false, false, false]);
});

test("both review panes reserve space for the longer line number through typing and undo", async ({ page }) => {
    await page.evaluate(() => window.comparisonFixture.setText("x\n".repeat(9998) + "last")); await ready(page);
    const work = page.getByRole("textbox", { name: "Comparison working source", exact: true });
    const widths = () => page.locator(".st-comparison-panes .st-viewport-gutter").evaluateAll(nodes => nodes.map(el => el.getBoundingClientRect().width));
    const [initial, other] = await widths(); expect(initial).toBe(other);
    await work.press("Control+End"); await work.press("Enter"); await page.keyboard.type("x"); await ready(page);
    const [baseline, working] = await widths(); expect(baseline).toBe(working); expect(working!).toBeGreaterThan(initial!);
    await expect(page.locator('.st-comparison-panes section:last-child .st-viewport-row[data-line="9999"]')).toHaveText("x");
    await work.press("Control+z"); await work.press("Control+z"); await ready(page);
    expect(await widths()).toEqual([initial, initial]);
});

test("mouse review controls preserve the typing target and keyboard activation retains toolbar focus", async ({ page }) => {
    const working = page.getByRole("textbox", { name: "Comparison working source", exact: true });
    const reference = page.getByRole("textbox", { name: "Comparison baseline source", exact: true });
    const next = page.getByRole("button", { name: "Next change", exact: true });
    const previous = page.getByRole("button", { name: "Previous change", exact: true });
    const restore = page.getByRole("button", { name: "Use baseline", exact: true });
    const sections = page.locator(".st-comparison-panes > section");
    const unchanged = sections.last().locator('.st-viewport-row[data-line="1"]');
    await unchanged.click({ position: { x: 6, y: 8 } }); await expect(restore).toBeDisabled();
    const box = (await restore.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await expect(working).toBeFocused();
    await typeAfterClick(next, working, "Q");
    await expect(sections.last().locator('.st-viewport-row[data-line="2"]')).toContainText("Q");
    await working.press("Control+z"); await ready(page);
    await sections.first().locator('.st-viewport-row[data-line="1"]').click();
    await previous.click(); await expect(reference).toBeFocused();
    await next.focus(); await next.press("Enter"); await expect(next).toBeFocused();
});

for (const custom of [false, true]) test(`${custom ? "host" : "built-in"} review controls follow the caret through navigation, restore and undo`, async ({ page }) => {
    if (custom) { await page.goto("/comparison/?controls=host"); await ready(page); }
    const base = "top\nold 1\nkeep A\nold 2\nkeep B\nold 3\nend", work = base.replaceAll("old", "new");
    await page.evaluate(({ base, work }) => {
        const f = window.comparisonFixture; f.setText(base); f.begin("accept"); f.finish("accept"); f.setText(work);
    }, { base, work }); await ready(page);
    const working = page.getByRole("textbox", { name: "Comparison working source", exact: true });
    const reference = page.getByRole("textbox", { name: "Comparison baseline source", exact: true });
    const button = (name: string) => page.getByRole("button", { name, exact: true });
    const next = button(custom ? "Later change" : "Next change"), previous = button(custom ? "Earlier change" : "Previous change");
    const restore = button(custom ? "Restore selected change" : "Use baseline");
    const status = page.locator(custom ? "#review-controls output" : ".st-comparison-controls output");
    const rows = (side: "working" | "baseline") => page.locator(".st-comparison-line-" + side);
    await rows("working").nth(1).click({ position: { x: 6, y: 8 } }); await working.press("End");
    await expect(working).toBeFocused(); await expect(status).toContainText(/change 2 of 3/i); await expect(restore).toBeEnabled();
    await working.press("Control+l"); await expect(status).toContainText(/change 2 of 3/i);
    await next.click(); await expect(status).toContainText(/change 3 of 3/i);
    await next.click(); await expect(status).toContainText(/change 1 of 3/i);
    await previous.click(); await expect(status).toContainText(/change 3 of 3/i);
    await rows("baseline").nth(1).click({ position: { x: 6, y: 8 } }); await reference.press("End");
    await expect(reference).toBeFocused(); await expect(status).toContainText(/change 2 of 3/i);
    const rect = await restore.boundingBox(); await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
    await page.mouse.down();
    await page.evaluate(() => {
        const controller = window.comparisonFixture.review.controller, baseline = controller.getSnapshot().baseline!;
        const refresh = controller.beginRefresh(); try { refresh.complete({ buffer: baseline.buffer, version: "refreshed" }); }
        finally { refresh.finish(); }
    }); await ready(page);
    await expect(status).toContainText(/change 2 of 3/i); await expect(restore).toBeEnabled();
    await page.mouse.up(); await ready(page);
    expect(await page.evaluate(n => window.comparisonFixture.range(0, n), work.length)).toBe(work);
    await rows("baseline").nth(1).click({ position: { x: 6, y: 8 } });
    if (!custom) {
        const reserved = await reference.evaluate(node => {
            const event = new KeyboardEvent("keydown", { key: "F7", bubbles: true, cancelable: true, modifierAltGraph: true });
            return node.dispatchEvent(event);
        });
        expect(reserved).toBe(true); await expect(status).toContainText(/change 2 of 3/i);
        await page.evaluate(() => {
            const keys = window.comparisonFixture.review.panes.reference.keymap;
            keys.unbind("F7"); keys.bind("Alt+j", "comparison.nextChange");
        });
        await next.hover(); await expect(next).toHaveAttribute("title", /Alt\+j/);
        await reference.press("F7"); await expect(status).toContainText(/change 2 of 3/i);
        await reference.press("Alt+j"); await expect(status).toContainText(/change 3 of 3/i);
        await reference.press("Shift+F7"); await expect(status).toContainText(/change 2 of 3/i);
        await expect(reference).toBeFocused();
        await working.press("Control+Home");
        expect(await page.evaluate(() => window.comparisonFixture.review.panes.reference.commands.run("comparison.nextChange"))).toBe(true);
        await expect(working).toBeFocused(); await expect(status).toContainText(/change 3 of 3/i);
        await rows("baseline").nth(1).click({ position: { x: 6, y: 8 } });
    }
    await restore.click(); await ready(page);
    expect(await page.evaluate(n => window.comparisonFixture.range(0, n), work.length)).toBe(work.replace("new 2", "old 2"));
    await expect(working).toBeFocused();
    await working.press("F7"); await expect(status).toContainText(/change 2 of 2/i);
    await working.press("Shift+F7"); await expect(status).toContainText(/change 1 of 2/i);
    await working.press("ControlOrMeta+z"); await ready(page);
    expect(await page.evaluate(n => window.comparisonFixture.range(0, n), work.length)).toBe(work);
});

test("paired rows highlight their own changed text and restore together", async ({ page }) => {
    const long = "wide ".repeat(1800);
    const base = ["price 12, qty 2", "read 😀 now", "name=end", long + "A", "end"].join("\r\n");
    const work = base.replace("12", "15").replace("😀", "😁").replace("name=", "name=x").replace("A\r", "B\r");
    await page.evaluate(({ base, work }) => {
        const f = window.comparisonFixture; f.setText(base); f.begin("accept"); f.finish("accept"); f.setText(work);
    }, { base, work }); await ready(page);
    const sections = page.locator(".st-comparison-panes > section"), baseline = sections.first(), working = sections.last();
    await expect(baseline.locator(".st-comparison-removed")).toHaveText(["2", "😀"]);
    await expect(working.locator(".st-comparison-added")).toHaveText(["5", "😁", "x"]);
    await expect(baseline.locator('[data-line="2"] .st-comparison-anchor')).toHaveCount(1);
    await expect(working.locator('.st-comparison-line-working[data-line="3"]')).toBeVisible();
    await page.addStyleTag({ content: `.st-comparison { --st-comparison-baseline-line: #512230; --st-comparison-baseline-bar: #d37782;
        --st-comparison-working-line: #194832; --st-comparison-working-bar: #77cf9a; }` });
    await page.evaluate(() => {
        for (const pane of Object.values(window.comparisonFixture.review.panes)) pane.configure({ minimap: true });
    }); await ready(page);
    const viewports = sections.locator(".st-viewport");
    for (const positions of [[0, 0], [110, 220]]) {
        await viewports.evaluateAll((panes, positions) => panes.forEach((pane, i) => {
            pane.scrollLeft = positions[i]!; pane.dispatchEvent(new Event("scroll"));
        }), positions); await ready(page);
        for (const [index, pane] of (await viewports.all()).entries()) {
            const stripe = await pane.evaluate(node => {
                const layer = node.querySelector(".st-viewport-layer")!.getBoundingClientRect();
                const map = node.querySelector(".st-minimap")!.getBoundingClientRect();
                const row = node.querySelector('.st-viewport-row[data-line="0"]')!, glyph = document.createRange();
                glyph.selectNodeContents(row);
                const x = Math.ceil(layer.left);
                return { x, y: Math.ceil(row.getBoundingClientRect().top) + 3, width: Math.floor(map.left) - x,
                    mapWidth: map.width, origin: glyph.getBoundingClientRect().left - x, scroll: node.scrollLeft };
            });
            expect(stripe.scroll).toBe(positions[index]); expect(stripe.mapWidth).toBeGreaterThan(0);
            if (!stripe.scroll) expect(stripe.origin).toBeGreaterThan(3);
            const png = await page.screenshot({ scale: "css", clip: { x: stripe.x, y: stripe.y, width: stripe.width, height: 1 } });
            const colors = await page.evaluate(async bytes => {
                const image = new Image(); image.src = "data:image/png;base64," + bytes; await image.decode();
                const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = 1;
                const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
                return [1, canvas.width - 2].map(x => Array.from(ctx.getImageData(x, 0, 1, 1).data.slice(0, 3)));
            }, png.toString("base64"));
            expect(colors).toEqual(index === 0 ? [[211, 119, 130], [81, 34, 48]] : [[119, 207, 154], [25, 72, 50]]);
        }
    }
    await page.getByRole("button", { name: "Next change" }).click();
    await expect(page.locator(".st-comparison-controls output")).toHaveText("Change 1 of 1");
    await page.getByRole("button", { name: "Use baseline" }).click(); await ready(page);
    expect(await page.evaluate(n => window.comparisonFixture.range(0, n), base.length)).toBe(base);
    await working.getByRole("textbox").press("ControlOrMeta+z"); await ready(page);
    expect(await page.evaluate(n => window.comparisonFixture.range(0, n), work.length)).toBe(work);
});

test("forced colors distinguish changed rows, characters, empty changes and the current line", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    test.skip(!await page.evaluate(() => matchMedia("(forced-colors: active)").matches), "Engine does not emulate forced colors");
    await page.evaluate(() => {
        const f = window.comparisonFixture;
        f.setText("value = 1;\nkeep\nlast"); f.begin("accept"); f.finish("accept"); f.setText("value = 9;\nkeep\nextra\nlast");
        f.review.setRowsAligned(true); f.review.panes.working.configure({ highlightCurrentLine: true });
        f.select({ anchor: 0, head: 0 }); f.focus();
    }); await ready(page);
    const sections = page.locator(".st-comparison-panes > section");
    for (const [pane, side, mark, stroke] of [
        [sections.first(), "baseline", "removed", "dashed"], [sections.last(), "working", "added", "solid"]
    ] as const) {
        const row = pane.locator(".st-comparison-line-" + side).first();
        expect(await row.evaluate(node => getComputedStyle(node, "::before").borderLeftStyle)).toBe(stroke);
        await expect(pane.locator(".st-comparison-" + mark).first()).toHaveCSS("border-bottom-style", stroke);
    }
    const empty = sections.first().locator(".st-comparison-anchor");
    expect(await empty.evaluate(node => parseFloat(getComputedStyle(node, "::after").borderLeftWidth))).toBe(2);
    await expect(sections.first().locator(".st-comparison-padding").first()).toHaveCSS("border-left-style", "dotted");
    const layer = sections.last().locator(".st-viewport-layer");
    const top = (await sections.last().locator(".st-current-line-background").boundingBox())!.y - (await layer.boundingBox())!.y;
    const image = await layer.screenshot({ scale: "css" });
    const paint = await page.evaluate(async ({ png, top }) => {
        const img = new Image(); img.src = "data:image/png;base64," + png; await img.decode();
        const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext("2d")!; ctx.drawImage(img, 0, 0);
        const pixel = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data.slice(0, 3).join(",");
        const y = Math.round(top), fill = pixel(100, y + 8);
        const dotted = [y - 1, y, y + 1].some(yy => {
            const stripe = Array.from({ length: 50 }, (_, i) => pixel(100 + i, yy));
            return new Set(stripe).size > 1;
        });
        return { bar: pixel(1, y + 8) !== fill, currentLine: dotted };
    }, { png: image.toString("base64"), top });
    expect(paint).toEqual({ bar: true, currentLine: true });
});

test("a column drag released in comparison padding ends on the last source row crossed", async ({ page }) => {
    await page.evaluate(() => {
        const f = window.comparisonFixture;
        f.setText("a12\nb12\nc12\nd12"); f.begin("accept"); f.finish("accept");
        f.setText("a12\nb12\nextra\nc12\nd12");
        f.review.setRowsAligned(true);
    }); await ready(page);
    const reference = page.locator(".st-comparison-panes > section").first();
    const gap = (await reference.locator(".st-comparison-padding").boundingBox())!;
    for (const offset of [1, 13]) {
        const [start, end] = await page.evaluate(offset => {
            const { viewport } = window.comparisonFixture.review.panes.reference;
            const point = (at: number) => { const r = viewport.coordsAt(at)!; return { x: r.left + 1, y: r.top + r.height / 2 }; };
            return [point(offset), point(offset + 1)] as const;
        }, offset);
        await page.keyboard.down("Shift"); await page.keyboard.down("Alt"); await page.mouse.move(start.x, start.y);
        await page.mouse.down(); await page.mouse.move(end.x, gap.y + gap.height / 2); await page.mouse.up();
        await page.keyboard.up("Alt"); await page.keyboard.up("Shift"); await ready(page);
        const result = () => page.evaluate(() => {
            const { ranges, primary } = window.comparisonFixture.review.panes.reference.view.getSnapshot().selectionSet;
            return { ranges: ranges.map(s => [s.anchor, s.head]), primary };
        });
        const expected = offset === 1 ? { ranges: [[1, 2], [5, 6]], primary: 1 } : { ranges: [[9, 10], [13, 14]], primary: 0 };
        expect(await result()).toEqual(expected);
        await page.mouse.click(start.x, start.y);
        await page.keyboard.down("Shift"); await page.keyboard.down("Alt");
        await page.mouse.click(end.x, gap.y + gap.height / 2);
        await page.keyboard.up("Alt"); await page.keyboard.up("Shift");
        expect(await result()).toEqual(expected);
    }
});

test("a one-sided change marks the empty range without tinting its unchanged neighbour", async ({ page }) => {
    const tail = "shared long line ".repeat(32);
    const original = "first\nmiddle\nlast\n" + tail;
    await page.evaluate(text => {
        const f = window.comparisonFixture; f.setText(text); f.begin("accept"); f.finish("accept");
        for (const pane of Object.values(f.review.panes)) pane.configure({ minimap: true });
    }, original);
    const sections = page.locator(".st-comparison-panes > section");
    for (const insert of [true, false]) {
        const working = (insert ? "first\nextra\nmiddle\nlast\n" : "first\nlast\n") + tail;
        await page.evaluate(text => window.comparisonFixture.setText(text), working); await ready(page);
        const empty = insert ? sections.first() : sections.last(), changed = insert ? sections.last() : sections.first();
        const row = empty.locator('.st-viewport-row[data-line="1"]');
        await row.click(); await empty.getByRole("textbox").press("Home");
        const restore = page.getByRole("button", { name: "Use baseline", exact: true });
        await expect(restore).toBeEnabled();
        await empty.getByRole("textbox").press("ArrowRight"); await expect(restore).toBeDisabled();
        for (const aligned of [true, false]) {
            await page.getByRole("checkbox", { name: "Align review rows" }).setChecked(aligned); await ready(page);
            await expect(row).toHaveText(insert ? "middle" : "last");
            await expect(row).not.toHaveClass(/st-comparison-line-/);
            const marker = row.locator('.st-comparison-anchor[data-ornament="point"]');
            expect(await marker.evaluate(el => parseFloat(getComputedStyle(el, "::after").borderBottomWidth))).toBeGreaterThan(0);
            await expect(changed.locator(insert ? ".st-comparison-line-working" : ".st-comparison-line-baseline")).toHaveText(insert ? "extra" : "middle");
            if (aligned) {
                const viewport = empty.locator(".st-viewport");
                await viewport.evaluate(node => { node.scrollLeft = 220; node.dispatchEvent(new Event("scroll")); }); await ready(page);
                const coverage = await viewport.evaluate(node => {
                    const gap = node.querySelector(".st-comparison-padding")!, box = gap.getBoundingClientRect();
                    return { scroll: node.scrollLeft, left: box.left - node.querySelector(".st-viewport-gutter")!.getBoundingClientRect().right,
                        right: box.right - node.querySelector(".st-minimap")!.getBoundingClientRect().left, stripes: getComputedStyle(gap).backgroundImage };
                });
                expect(coverage.scroll).toBe(220); expect(Math.abs(coverage.left)).toBeLessThan(1);
                expect(Math.abs(coverage.right)).toBeLessThan(1); expect(coverage.stripes).toContain("gradient");
            }
        }
        await page.getByRole("button", { name: "Next change" }).click();
        await page.getByRole("button", { name: "Use baseline", exact: true }).click(); await ready(page);
        expect(await page.evaluate(length => window.comparisonFixture.range(0, length), original.length)).toBe(original);
        await sections.last().getByRole("textbox").press("ControlOrMeta+z"); await ready(page);
        expect(await page.evaluate(length => window.comparisonFixture.range(0, length), working.length)).toBe(working);
    }
    await page.evaluate(() => {
        const f = window.comparisonFixture; f.setText("first\r\nlast"); f.begin("accept"); f.finish("accept"); f.setText("first\rX\nlast");
    }); await ready(page);
    const edge = sections.first().locator('.st-viewport-row[data-line="0"] .st-comparison-anchor');
    expect(await edge.evaluate(marker => {
        const prefix = document.createRange(); prefix.selectNodeContents(marker.closest(".st-viewport-row")!);
        prefix.setEndBefore(marker); return prefix.toString();
    })).toBe("first");
});

test("the two saved revisions stay read-only while navigating their changes", async ({ page }) => {
    await page.getByRole("link", { name: "Compare two saved revisions" }).click();
    await ready(page);
    const panes = page.getByRole("textbox");
    await expect(panes).toHaveCount(2);
    for (const pane of await panes.all()) await expect(pane).toHaveAttribute("readonly", "");
    await page.getByRole("button", { name: "Next change" }).click();
    await expect(page.locator(".st-comparison-controls output")).toContainText("Change 1 of");
    await expect(page.getByRole("button", { name: "Use baseline", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Capture working acceptance" })).toHaveCount(0);
    const state = await page.evaluate(() => window.comparisonFixture.snapshot());
    expect(state.baseline?.version).toBe("saved-1");
    expect(state.working.metadata.serverVersion).toBe("saved-2");
    await page.getByRole("button", { name: "Dispose comparison" }).click();
    await expect(panes).toHaveCount(0);
});

test("paired navigation exposes exact whitespace and reverts one hunk through shared undo", async ({ page }) => {
    const initial = await page.evaluate(() => window.comparisonFixture.snapshot()); expect(initial.hunks.length).toBeGreaterThan(1);
    await expect(page.getByRole("button", { name: "Use baseline", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Next change", exact: true }).click();
    await expect(page.locator(".st-comparison-controls output")).toContainText("Change 1 of");
    await ready(page);
    const carets = await page.evaluate(() => {
        const { panes } = window.comparisonFixture.review;
        return [panes.reference.view.getSnapshot().selection, panes.working.view.getSnapshot().selection];
    });
    for (const caret of carets) expect(caret).toMatchObject({ anchor: 0, head: 0 });
    const fitting = await page.locator(".st-comparison-panes .st-viewport").evaluateAll(panes => panes.map(pane => {
        const row = pane.querySelector<HTMLElement>(".st-viewport-row")!, bounds = pane.getBoundingClientRect(), range = pane.ownerDocument.createRange();
        range.selectNodeContents(row);
        return { overflow: pane.scrollWidth - pane.clientWidth, textLeft: range.getBoundingClientRect().left - bounds.left };
    }));
    for (const pane of fitting) { expect(pane.overflow).toBeLessThanOrEqual(1); expect(pane.textLeft).toBeGreaterThanOrEqual(0); }
    await page.getByRole("button", { name: "Use baseline", exact: true }).click(); await ready(page);
    expect(await page.evaluate(() => window.comparisonFixture.range(0, 25))).toContain("Baseline");
    expect((await page.evaluate(() => window.comparisonFixture.snapshot())).history.undoDepth).toBe(1);
    await expect(page.getByRole("textbox", { name: "Comparison working source", exact: true })).toBeFocused();
    const restored = await page.evaluate(() => window.comparisonFixture.snapshot());
    const start = initial.hunks[0]!.working.from;
    expect(restored.selection).toMatchObject({ anchor: start, head: start });
    await page.keyboard.press("Control+z"); await ready(page);
    await expect(page.locator(".st-comparison-panes section").last().locator(".st-viewport-row").first()).toContainText("Working");
    expect(await page.evaluate(() => window.comparisonFixture.range(0, 24))).toContain("Working");
    await page.evaluate(() => window.comparisonFixture.setText("a\nb\n")); await ready(page);
    const revision = await page.evaluate(() => {
        const f = window.comparisonFixture; f.begin("accept"); f.finish("accept"); f.select({ anchor: 4, head: 0 }); f.focus();
        return f.snapshot().working.revision;
    });
    await page.getByRole("textbox", { name: "Comparison working source" }).evaluate(input => {
        const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
        event.clipboardData!.setData("text/plain", "a\r\nb\r\n"); input.dispatchEvent(event);
    });
    await ready(page);
    await expect(page.locator(".st-comparison-controls output")).toHaveText("No changes");
    expect(await page.evaluate(() => window.comparisonFixture.snapshot().working.revision)).toBe(revision);
    await page.evaluate(() => window.comparisonFixture.setText("a\r\nb\r\n")); await ready(page);
    await expect(page.locator(".st-comparison-controls output")).toContainText("line endings only");
    await page.getByRole("button", { name: "Next change", exact: true }).click();
    await expect(page.locator(".st-comparison-controls output")).toContainText("line endings only");
    await expect(page.locator(".st-comparison-preview")).toContainText("␍");
    expect(await page.locator(".st-comparison-line-working").count()).toBeGreaterThan(0);
});

test("acceptance captures a revision while later keyboard input, focus and history survive", async ({ page }) => {
    const identity = await page.evaluate(() => { const s = window.comparisonFixture.snapshot(); window.comparisonFixture.select({ anchor: s.working.length, head: s.working.length }); window.comparisonFixture.focus(); return s; });
    await page.keyboard.type("before"); await ready(page);
    await page.evaluate(() => window.comparisonFixture.begin("accept"));
    const captured = await page.evaluate(() => window.comparisonFixture.snapshot());
    await page.keyboard.type("after"); await ready(page);
    await page.evaluate(() => window.comparisonFixture.finish("accept")); await ready(page);
    const final = await page.evaluate(() => window.comparisonFixture.snapshot());
    expect(final.baseline!.length).toBe(captured.working.length); expect(final.working.length).toBe(captured.working.length + 5);
    expect(final.working.id).toBe(identity.working.id); expect(final.viewId).toBe(identity.viewId);
    expect(final.working.metadata).toMatchObject({ serverVersion: "saved-1", dirty: true });
    expect(await page.getByRole("textbox", { name: "Comparison working source", exact: true }).evaluate(input => document.activeElement === input)).toBe(true);
    expect(final.hunks.length).toBe(1);
    await page.keyboard.press("ControlOrMeta+z"); await ready(page);
    expect((await page.evaluate(() => window.comparisonFixture.snapshot())).working.length).toBe(identity.working.length);
});

test("out-of-order refresh rejects old results and never replaces the mounted working editor", async ({ page }) => {
    await page.getByRole("textbox", { name: "Comparison working source", exact: true }).evaluate(input => { input.dataset.retained = "yes"; });
    const before = await page.evaluate(() => { const s = window.comparisonFixture.snapshot(); window.comparisonFixture.begin("refresh"); window.comparisonFixture.begin("refresh"); window.comparisonFixture.moveTab(); return s; });
    expect(await page.evaluate(() => window.comparisonFixture.finish("refresh", true))).toBe(true); await ready(page);
    const fresh = await page.evaluate(() => window.comparisonFixture.snapshot());
    expect(await page.evaluate(() => window.comparisonFixture.finish("refresh"))).toBe(false); await ready(page);
    const after = await page.evaluate(() => window.comparisonFixture.snapshot());
    expect(after.baseline).toEqual(fresh.baseline); expect(after.working).toEqual(before.working); expect(after.viewId).toBe(before.viewId);
    await expect(page.getByRole("textbox", { name: "Comparison working source", exact: true })).toHaveAttribute("data-retained", "yes");
    expect(after.diagnostics).toMatchObject({ resources: 2, documents: 2, tabs: 1, views: 2, leases: 3 });
});

test("a stale selected hunk cannot retarget after typing, and permissions gate revert", async ({ page }) => {
    const captured = await page.evaluateHandle(() => { const f = window.comparisonFixture, hunk = f.review.hunkAt(0)!; hunk.select(); f.focus(); return hunk; });
    await page.keyboard.type("new"); await ready(page);
    expect(await captured.evaluate(hunk => hunk.revert())).toBe(false);
    await expect(page.getByRole("button", { name: "Use baseline", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Next change", exact: true }).click();
    await page.evaluate(() => window.comparisonFixture.readOnly(true));
    await expect(page.getByRole("button", { name: "Use baseline", exact: true })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Comparison working source", exact: true })).toHaveAttribute("readonly", "");
});

test("custom host controls observe captured selection, alignment, authority and teardown", async ({ page }) => {
    await page.goto("/comparison/?controls=host"); await ready(page);
    await expect(page.locator(".st-comparison-controls, .st-comparison-preview, .st-comparison h3")).toHaveCount(0);
    const controls = page.getByRole("navigation", { name: "Custom review commands" });
    const later = controls.getByRole("button", { name: "Later change", exact: true });
    const restore = controls.getByRole("button", { name: "Restore selected change", exact: true });
    await expect(restore).toBeDisabled(); await later.click(); await expect(restore).toBeEnabled();
    const selected = await page.evaluateHandle(() => window.comparisonFixture.review.hunkAt(0)!);
    const capture = await page.evaluate(() => {
        const f = window.comparisonFixture, state = f.review.getSnapshot(); let rejected = false, calls = 0;
        const stop = f.review.subscribe(() => { calls++; try { f.review.hunkAt(0)!.select(); } catch { rejected = true; } });
        f.readOnly(true); const locked = !f.review.getSnapshot().canRevert; f.readOnly(false); stop();
        return { generation: state.comparison.generation, selected: state.selectedHunk, locked, rejected, calls,
            frozen: Object.isFrozen(state) && Object.isFrozen(state.alignment), retained: state.canRevert,
            stable: f.review.getSnapshot() === f.review.getSnapshot() };
    });
    expect(capture).toMatchObject({ selected: 0, locked: true, rejected: true, calls: 2, frozen: true, retained: true, stable: true });
    await controls.getByRole("button", { name: "Toggle aligned rows", exact: true }).click(); await ready(page);
    await expect(controls.locator("output")).toContainText("alignment ready");
    await expect(controls.getByRole("button", { name: "Toggle linked scrolling", exact: true })).toHaveAttribute("aria-pressed", "true");
    await controls.getByRole("button", { name: "Toggle linked scrolling", exact: true }).click();
    await expect(controls.getByRole("button", { name: "Toggle linked scrolling", exact: true })).toHaveAttribute("aria-pressed", "false");
    // Browser command guards also apply when a host invokes a captured action directly.
    const input = page.getByRole("textbox", { name: "Comparison working source", exact: true });
    await input.focus();
    await input.dispatchEvent("compositionstart", { data: "" });
    await expect(later).toBeDisabled(); await expect(restore).toBeDisabled();
    expect(await selected.evaluate(hunk => hunk.revert())).toBe(false);
    await input.dispatchEvent("compositionend", { data: "" }); await ready(page);
    await page.evaluate(() => window.comparisonFixture.focus());
    await page.keyboard.type("replacement"); await ready(page);
    expect(await selected.evaluate(hunk => hunk.revert())).toBe(false);
    expect(await page.evaluate(() => window.comparisonFixture.review.getSnapshot().selectedHunk)).toBe(0);
    await expect(restore).toBeEnabled();
    await later.click();
    const beforeRefresh = await page.evaluateHandle(() => window.comparisonFixture.review.hunkAt(0)!);
    expect(await page.evaluate(() => {
        const f = window.comparisonFixture; f.begin("refresh"); f.finish("refresh");
        return f.review.getSnapshot().selectedHunk === null;
    })).toBe(true); await ready(page);
    expect(await beforeRefresh.evaluate(hunk => hunk.select())).toBe(false);
    await later.click();
    expect(await page.evaluate(() => {
        const f = window.comparisonFixture, hunk = f.review.hunkAt(f.review.getSnapshot().selectedHunk!)!;
        f.readOnly(true);
        try { return hunk.revert(); } finally { f.readOnly(false); }
    })).toBe(false);
    await restore.click(); await ready(page);
    await page.getByRole("button", { name: "Undo working edit", exact: true }).click(); await ready(page);
    const terminal = await page.evaluate(() => {
        const f = window.comparisonFixture; let notified = false;
        const stop = f.review.subscribe(() => { if (f.review.getSnapshot().disposed) notified = true; });
        f.dispose(); stop(); const state = f.review.getSnapshot();
        return { notified, disposed: state.disposed, status: state.comparison.status, selected: state.selectedHunk,
            navigate: state.canNavigate, revert: state.canRevert, rejected: f.review.hunkAt(0) === undefined, diagnostics: f.snapshot().diagnostics };
    });
    expect(terminal).toMatchObject({ notified: true, disposed: true, status: "disposed", selected: null, navigate: false, revert: false, rejected: true,
        diagnostics: { resources: 1, tabs: 1, views: 0, leases: 0, subscriptions: 0 } });
    await expect(controls).toHaveCount(0);
});

test("tab replacement expires pending work and teardown leaves only host resources", async ({ page }) => {
    await page.evaluate(() => { window.comparisonFixture.begin("refresh"); window.comparisonFixture.begin("accept"); window.comparisonFixture.replaceTab(); });
    await expect.poll(() => page.evaluate(() => window.comparisonFixture.snapshot().status)).toBe("expired");
    expect(await page.evaluate(() => window.comparisonFixture.finish("refresh"))).toBe(false);
    await page.evaluate(() => window.comparisonFixture.dispose());
    const state = await page.evaluate(() => window.comparisonFixture.snapshot());
    expect(state.status).toBe("disposed"); expect(state.baseline).toBeNull(); expect(state.reference).toMatchObject({ disposed: true, revision: null, rows: 0 });
    expect(state.pending).toEqual({ refreshes: 0, acceptances: 0 });
    await expect(page.getByRole("button", { name: "Request baseline refresh", exact: true })).toBeDisabled();
    expect(state.diagnostics).toMatchObject({ resources: 2, tabs: 1, views: 0, leases: 0, subscriptions: 0 });
    await expect(page.locator(".st-comparison")).toHaveCount(0);
});

for (const kind of ["long", "unique", "repeated", "unbalanced"] as const)
    test(`${kind} comparison stays virtualized, exact and cooperative during real input`, async ({ page }) => {
        const { length, at } = await page.evaluate(kind => {
            const many = kind !== "long";
            const text = many ? Array.from({ length: 10000 }, (_, i) => `row ${kind === "unique" ? i : i % 20}\n`).join("") : "unchanged source line\r\n".repeat(20_000);
            let working = many ? text.replace(/^row (\d+)$/gm, (line, n: string) => Number(n) % 10 === 0 ? "changed " + n : line) : text.replace("unchanged", "modified") + "tail";
            if (kind === "unbalanced") working = working.replaceAll("row 11\n", "row 11\nrow 11\n");
            const at = kind === "unbalanced" ? working.indexOf("changed ", Math.floor(working.length / 2)) + 3 : working.length;
            const f = window.comparisonFixture; f.setText(text); f.begin("accept"); f.finish("accept"); f.setText(working);
            f.select({ anchor: at, head: at }); f.focus(); return { length: working.length, at };
        }, kind);
        if (kind === "unbalanced") await ready(page); // Retain the completed review before editing an unmatched row.
        await page.keyboard.type("x"); await ready(page);
        const state = await page.evaluate(() => window.comparisonFixture.snapshot());
        expect(state.hunks.length).toBeGreaterThan(0);
        expect(await page.locator(".st-viewport-row").count()).toBeLessThan(100);
        expect(state.working.length).toBe(length + 1);
        expect(await page.evaluate(at => window.comparisonFixture.range(at, at + 1), at)).toBe("x");
        if (kind !== "long") {
            // Every tenth baseline row is replaced; 500 extra identical rows admit several minimal alignments.
            const edits = () => page.evaluate(() => window.comparisonFixture.review.controller.getSnapshot().progress!.lineEdits);
            if (kind === "unbalanced") expect(await edits()).toBe(2500);
            else expect(state.hunks.length).toBe(1001);
            if (kind === "unique") {
                await expect(page.locator(".st-comparison-controls output")).toHaveText("Change 1,001 of 1,001");
                await expect(page.getByRole("button", { name: "Use baseline" })).toHaveAttribute("title", "Restore change 1,001 of 1,001 from the baseline");
            }
            await page.keyboard.press("Control+z"); await ready(page);
            const undone = await page.evaluate(() => window.comparisonFixture.snapshot());
            expect(undone.working.length).toBe(length);
            if (kind === "unbalanced") expect(await edits()).toBe(2500);
            else expect(undone.hunks.length).toBe(1000);
            if (kind === "unique") await expect(page.locator(".st-comparison-controls output")).toHaveText("1,000 changes");
            await page.keyboard.press("Control+Shift+z"); await ready(page);
            if (kind === "unbalanced") expect(await edits()).toBe(2500);
            else expect((await page.evaluate(() => window.comparisonFixture.snapshot())).hunks.length).toBe(1001);
            expect(await page.evaluate(at => window.comparisonFixture.range(at, at + 1), at)).toBe("x");
        }
        if (kind === "unbalanced") {
            for (const [command, split] of [["Enter", true], ["Backspace", false], ["Control+z", true], ["Control+Shift+z", false]] as const) {
                await page.keyboard.press(command); await ready(page);
                const edited = await page.evaluate(() => window.comparisonFixture.snapshot());
                expect(edited.working.length).toBe(length + 1 + Number(split));
                expect(edited.selection).toMatchObject({ anchor: at + 1 + Number(split), head: at + 1 + Number(split) });
                expect(await page.evaluate(() => window.comparisonFixture.review.controller.getSnapshot().progress!.lineEdits)).toBe(2500 + Number(split));
                expect(await page.evaluate(at => window.comparisonFixture.range(at, at + 2), at)).toBe(split ? "x\n" : "xn");
            }
        }
    });
