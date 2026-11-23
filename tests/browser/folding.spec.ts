import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });

test("moving adjacent collapsed blocks carries nested folds, the caret and each pane's fold choices through Undo", async ({ page }) => {
    await page.goto("/editing/");
    const top = "one\r\n  inner\n    x\r\n", bottom = "two\n  y\r\n", tail = "tail";
    await page.evaluate(({ top, bottom, tail }) => {
        const f = window.editingFixture, end = top.length + bottom.length;
        f.setText(top + bottom + tail);
        const ranges = [{ id: "one", from: 0, to: top.length, collapsed: true },
            { id: "inner", from: top.indexOf("inner"), to: top.length, collapsed: true },
            { id: "two", from: top.length, to: end, collapsed: true }];
        f.folds(ranges); f.folds(ranges.map(r => ({ ...r, collapsed: r.id === "inner" })), "secondary");
        f.select("primary", { anchor: 1, head: 1 }); f.focus("primary");
    }, { top, bottom, tail }); await ready(page);
    const state = () => page.evaluate(() => {
        const f = window.editingFixture;
        const folds = (pane: "primary" | "secondary") => f.folding(pane).regions.map(r => [r.id, r.lineFrom, r.lineTo, r.collapsed]);
        return { text: f.range(0, f.snapshot().document!.length), main: folds("primary"), peer: folds("secondary"), head: f.selectionSet().ranges[0]!.head };
    });
    const before = await state(), source = input(page);
    await source.press("Alt+ArrowDown");
    const moved = await state();
    expect(moved).toEqual({ text: bottom + top + tail, head: bottom.length + 1,
        main: [["two", 0, 2, true], ["one", 2, 5, true], ["inner", 3, 5, true]],
        peer: [["two", 0, 2, false], ["one", 2, 5, false], ["inner", 3, 5, true]] });
    await page.keyboard.type("X"); await expect(page.locator("#primary .st-viewport-row")).toHaveText(["two", "oXne", "tail"]);
    await source.press("Control+z"); await source.press("Control+z"); expect(await state()).toEqual(before);
    await source.press("Control+Shift+z"); expect(await state()).toEqual(moved);
    await source.press("Alt+ArrowUp"); expect(await state()).toEqual(before);
});

test("duplicating a collapsed header copies its body and types in the new copy", async ({ page }) => {
    await page.goto("/editing/");
    const source = input(page), original = "head\n  body\nend";
    const contents = () => page.evaluate(() => { const f = window.editingFixture; return f.range(0, f.snapshot().document!.length); });
    for (const key of ["Alt+Shift+ArrowDown", "Alt+Shift+ArrowUp"]) {
        await page.evaluate(original => {
            const f = window.editingFixture; f.setText(original); f.folds([{ id: "body", from: 0, to: 12, collapsed: true }]);
            f.select("primary", { anchor: 2, head: 2 }); f.focus("primary");
        }, original); await ready(page);
        await source.press(key); await page.keyboard.type("X");
        const down = key.endsWith("Down");
        expect(await contents()).toBe((down ? "head\n  body\nheXad" : "heXad\n  body\nhead") + "\n  body\nend");
        await expect(page.locator("#primary .st-fold-button")).toHaveAttribute("aria-expanded", "false");
        await source.press("Control+z"); await source.press("Control+z"); expect(await contents()).toBe(original);
    }
});

test("whole-line gestures select a collapsed block for deletion, including at EOF", async ({ page }) => {
    await page.goto("/editing/");
    const source = input(page), fold = page.locator("#primary .st-fold-button");
    const block = "head\r\nbody\r\nlast", prefix = "before\r\n";
    for (const [gesture, suffix] of [["gutter", "\r\ntail"], ["triple-click", ""], ["Ctrl+L", ""]] as const) {
        const text = prefix + block + suffix, from = prefix.length, to = text.length - (suffix ? "tail".length : 0);
        await page.evaluate(({ text, from, to }) => {
            const f = window.editingFixture;
            f.setText(text); f.folds([{ id: "section", from, to, collapsed: true }]);
            f.select("primary", { anchor: from + 2, head: from + 2 });
        }, { text, from, to }); await ready(page);
        if (gesture === "gutter") await page.locator("#primary .st-line-numbers span").filter({ hasText: /^2$/ }).dblclick();
        else if (gesture === "triple-click") await page.locator('#primary .st-viewport-row[data-line="1"]').click({ clickCount: 3, position: { x: 12, y: 8 } });
        else await source.press("Control+l");
        await ready(page);
        expect(await page.evaluate(() => window.editingFixture.selectionSet().ranges[0]), gesture).toMatchObject({ anchor: from, head: to });
        await expect(fold).toHaveAttribute("aria-expanded", "false");
        await source.press("Delete"); await ready(page);
        const contents = () => page.evaluate(() => { const f = window.editingFixture; return f.range(0, f.snapshot().document!.length); });
        expect(await contents()).toBe(prefix + (suffix ? "tail" : ""));
        await source.press("Control+z"); expect(await contents()).toBe(text);
    }
});

test("inserting beside a collapsed header and deleting its line keep typing on visible rows", async ({ page }) => {
    await page.goto("/editing/");
    const source = input(page), fold = page.locator("#primary .st-fold-button");
    const reset = async () => {
        await page.evaluate(() => {
            const f = window.editingFixture;
            f.setText("head\r\nbody\r\ntail"); f.folds([{ id: "section", from: 0, to: 12, collapsed: true }]);
            f.select("primary", { anchor: 2, head: 2 }); f.focus("primary");
        }); await ready(page);
    };
    for (const [shortcut, expected] of [["Control+Enter", ["head", "X", "tail"]], ["Control+Shift+Enter", ["X", "head", "tail"]]] as const) {
        await reset(); await source.press(shortcut); await page.keyboard.type("X");
        await expect(fold).toHaveAttribute("aria-expanded", "false");
        await expect(page.locator("#primary .st-viewport-row")).toHaveText([...expected]);
    }
    await reset(); await source.press("Control+Shift+k"); await expect(page.locator("#primary .st-viewport-row")).toHaveText(["tail"]);
    await page.keyboard.type("X"); await expect(page.locator("#primary .st-viewport-row")).toHaveText(["taXil"]);
    await source.press("Control+z"); await source.press("Control+z");
    expect(await page.evaluate(() => window.editingFixture.range(0, 16))).toBe("head\r\nbody\r\ntail");
    await reset(); await source.press("ArrowDown"); await source.press("Control+Shift+k");
    await expect(page.locator("#primary .st-viewport-row")).toHaveText(["head"]);
    await page.keyboard.type("Y"); await expect(page.locator("#primary .st-viewport-row")).toHaveText(["heYad"]);
});

test("collapsing from a body caret moves it to the header for navigation and typing", async ({ page }) => {
    await page.goto("/editing/");
    await page.evaluate(() => {
        const f = window.editingFixture; f.setText("head\r\nbody\r\nlast\r\ntail");
        f.discoverFolds(() => [{ from: 0, to: 18, group: "block" }]);
        f.select("primary", { anchor: 8, head: 8 }); f.select("secondary", { anchor: 13, head: 13 });
    });
    const source = input(page), fold = page.locator("#primary .st-fold-button");
    await expect(fold).toHaveAttribute("aria-expanded", "true"); await fold.press("Control+Shift+BracketLeft");
    await expect(fold).toHaveAttribute("aria-expanded", "false"); await expect(source).toBeFocused();
    const current = () => page.evaluate(() => window.editingFixture.selectionSet().ranges[0]);
    expect(await current()).toMatchObject({ anchor: 4, head: 4 });
    await source.press("ArrowDown"); await ready(page); expect(await current()).toMatchObject({ anchor: 22, head: 22 });
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    expect((await page.evaluate(() => window.editingFixture.snapshot())).secondary.selection).toMatchObject({ anchor: 13, head: 13 });
    await fold.click(); await page.evaluate(() => window.editingFixture.selections([{ anchor: 7, head: 7 }, { anchor: 14, head: 14 }], 1));
    await fold.click(); await expect(source).toBeFocused();
    expect(await page.evaluate(() => window.editingFixture.selectionSet().ranges.length)).toBe(1);
    await page.keyboard.type("X"); await expect(page.locator("#primary .st-viewport-row").first()).toHaveText("headX");
    expect(await page.evaluate(() => window.editingFixture.range(0, 23))).toBe("headX\r\nbody\r\nlast\r\ntail");
});

test("a pointer fold returns to typing while keyboard activation keeps the disclosure focused", async ({ page }) => {
    await page.goto("/editing/");
    await page.evaluate(() => {
        const fixture = window.editingFixture;
        fixture.setText("header\nbody\ntail");
        fixture.folds([{ id: "section", from: 0, to: 12 }]);
        fixture.select("primary", { anchor: 3, head: 3 });
    });
    await ready(page);
    const button = page.locator("#primary .st-fold-button");
    await button.dblclick();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    expect(await page.evaluate(() => window.editingFixture.selectionSet().ranges[0])).toMatchObject({ anchor: 3, head: 3 });
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(input(page)).toBeFocused();
    await page.keyboard.type("Z");
    await expect(page.locator("#primary .st-viewport-row").first()).toHaveText("heaZder");
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(button).toBeFocused();
    await page.evaluate(() => window.editingFixture.select("primary", { anchor: 3, head: 1 }));
    await button.click();
    const summary = page.locator("#primary .st-fold-summary");
    await summary.hover(); await page.mouse.down();
    await page.evaluate(() => window.editingFixture.edit([{ from: 17, to: 17, insert: "!" }]));
    await ready(page); await page.mouse.up();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await summary.click(); await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(input(page)).toBeFocused();
    expect(await page.evaluate(() => window.editingFixture.selectionSet().ranges[0])).toMatchObject({ anchor: 3, head: 1 });
    await page.keyboard.type("Q"); await expect(page.locator("#primary .st-viewport-row").first()).toHaveText("hQZder");
});

test("horizontal scrolling keeps fold controls clear of the first visible text column", async ({ page }) => {
    await page.goto("/editing/");
    await page.evaluate(() => {
        const f = window.editingFixture, header = "0123456789".repeat(200);
        f.setText(header + "\ninside\nafter"); f.folds([{ id: "section", from: 0, to: header.length + 8 }]);
    });
    await ready(page);
    const root = page.locator("#primary .st-editor"), button = root.locator(".st-fold-button");
    const before = await button.boundingBox(); if (!before) throw new Error("Missing fold control");
    await root.evaluate(element => { element.scrollLeft = 500; });
    await expect.poll(() => page.evaluate(() => window.editingFixture.snapshot().primary.viewport.scrollLeft)).toBeGreaterThan(450);
    const point = await root.evaluate(element => {
        const gutter = element.querySelector(".st-viewport-gutter")!.getBoundingClientRect();
        const row = element.querySelector('.st-viewport-row[data-line="0"]')!.getBoundingClientRect();
        return { x: gutter.right + 1, y: row.top + row.height / 2 };
    });
    expect((await button.boundingBox())?.x).toBeCloseTo(before.x, 0);
    await page.mouse.click(point.x, point.y);
    await expect(button).toHaveAttribute("aria-expanded", "true");
    const head = await page.evaluate(() => window.editingFixture.selectionSet().ranges[0]!.head);
    expect(head).toBeGreaterThan(0);
    await page.keyboard.type("X");
    expect(await page.evaluate(offset => window.editingFixture.range(offset, offset + 1), head)).toBe("X");
});

test("group folding preserves every selection and typing replaces the retained hidden ranges", async ({ page }) => {
    await page.goto("/editing/");
    const text = "outer\r\n  first\r\n    second\r\n  third\r\nother\r\n  last\r\nend";
    await page.evaluate(text => {
        const f = window.editingFixture; f.setText(text);
        f.discoverFolds(() => [
            { from: 0, to: text.indexOf("other"), group: "regions" },
            { from: text.indexOf("  first"), to: text.indexOf("  third"), group: "regions" },
            { from: text.indexOf("other"), to: text.indexOf("end"), group: "other" },
        ]);
        f.selections([
            { anchor: text.indexOf("first") + 5, head: text.indexOf("first"), anchorAffinity: "before", headAffinity: "after" },
            { anchor: text.indexOf("second"), head: text.indexOf("second") + 6, anchorAffinity: "after", headAffinity: "before" },
        ], 1);
    }, text);
    await expect.poll(() => page.evaluate(() => window.editingFixture.foldStatus()?.status)).toBe("ready"); await ready(page);
    const before = await page.evaluate(() => window.editingFixture.snapshot());
    const selected = before.primary.viewport.selectionSet;
    const folded = async (command: "collapse-all" | "expand-all") => {
        expect(await page.evaluate(command => window.editingFixture.commands.run("fold." + command, "regions"), command)).toBe(true); await ready(page);
        const after = await page.evaluate(() => window.editingFixture.snapshot());
        expect(after.primary.viewport.selectionSet).toEqual(selected); expect(after.document).toEqual(before.document);
        expect(after.history).toEqual(before.history); expect(after.secondary.selection).toEqual(before.secondary.selection);
        expect(after.secondary.viewport.collapsedFolds).toBe(0);
        expect((await page.evaluate(() => window.editingFixture.folding())).regions.map(r => r.collapsed)).toEqual([command === "collapse-all", command === "collapse-all", false]);
        await expect(input(page)).toBeFocused();
    };
    await folded("collapse-all");
    expect(await page.locator("#primary .st-viewport-row").allTextContents()).toEqual(["outer", "other", "  last", "end"]);
    await folded("expand-all"); await folded("collapse-all");
    // A real input event must reveal and replace both raw ranges, not their projected header.
    await page.keyboard.type("X"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, window.editingFixture.snapshot().document!.length))).toBe(text.replace("first", "X").replace("second", "X"));
    expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.viewport.collapsedFolds).toBe(0);
    await page.keyboard.press("Control+z"); await ready(page);
    expect(await page.evaluate(length => window.editingFixture.range(0, length), text.length)).toBe(text);
    expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.viewport.selectionSet).toEqual(selected);
    await page.keyboard.press("Control+Shift+z"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, window.editingFixture.snapshot().document!.length))).toBe(text.replace("first", "X").replace("second", "X"));
    await page.evaluate(() => window.editingFixture.dispose());
    expect((await page.evaluate(() => window.editingFixture.snapshot())).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});

test("nested fold shortcuts move insertion carets to each visible header and preserve child folds", async ({ page }) => {
    await page.goto("/editing/");
    const text = "outer\r\n  first\r\n    second\r\n  third\r\ntail", at = text.indexOf("second") + 3;
    await page.evaluate(({ text, at }) => {
        const f = window.editingFixture; f.setText(text); f.select("primary", { anchor: at, head: at });
        f.discoverFolds(() => [{ from: 0, to: text.indexOf("tail") }, { from: text.indexOf("  first"), to: text.indexOf("  third") }]);
        f.focus("primary");
    }, { text, at });
    await expect.poll(() => page.evaluate(() => window.editingFixture.foldStatus()?.status)).toBe("ready"); await ready(page);
    const before = await page.evaluate(() => window.editingFixture.snapshot());
    const shortcut = async (key: string, collapsed: boolean[], head: number) => {
        await page.keyboard.press(key); await ready(page);
        const after = await page.evaluate(() => window.editingFixture.snapshot());
        expect(after.primary.selection).toMatchObject({ anchor: head, head }); expect(after.history).toEqual(before.history);
        expect((await page.evaluate(() => window.editingFixture.folding())).regions.map(r => r.collapsed)).toEqual(collapsed);
    };
    await shortcut("Control+Shift+[", [false, true], text.indexOf("\r\n", text.indexOf("first")));
    await shortcut("Control+Shift+[", [true, true], 5);
    const projected = await page.evaluate(at => { const f = window.editingFixture; return { hidden: f.coords(at), header: f.coords(5) }; }, at);
    expect(projected.hidden?.left).toBe(projected.header!.left); expect(projected.hidden?.top).toBe(projected.header!.top);
    await expect(page.locator("#primary .st-input-caret")).toBeVisible();
    await shortcut("Control+Shift+]", [false, true], 5);
    await page.keyboard.press("ArrowDown"); await ready(page);
    await shortcut("Control+Shift+]", [false, false], text.indexOf("  first") + 5);
    await page.evaluate(() => window.editingFixture.dispose());
    expect((await page.evaluate(() => window.editingFixture.snapshot())).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});
test("disposing fold discovery releases its shortcuts and a conflicting remount rolls back", async ({ page }) => {
    await page.goto("/editing/");
    await page.evaluate(() => {
        const f = window.editingFixture; f.setText("header\n  child\ntail");
        f.discoverFolds(() => [{ from: 0, to: 15, group: "blocks" }]);
    });
    await expect.poll(() => page.evaluate(() => window.editingFixture.foldStatus()?.status)).toBe("ready");
    const result = await page.evaluate(() => {
        const f = window.editingFixture, id = "fold.collapse-all";
        const block = f.commands.get(id, "blocks"), unknown = f.commands.get(id, "other");
        const invalid = f.commands.run(id, {}); f.stopFoldDiscovery();
        let hostCalls = 0;
        const host = f.commands.register({ id: "host.bracket", label: "Host bracket", run: () => { hostCalls++; } });
        f.keymap.bind("Ctrl+Shift+Code:BracketRight", "host.bracket");
        let conflict = "";
        try { f.discoverFolds(() => []); } catch (error) { conflict = String(error); }
        const partial = f.commands.list().filter(entry => entry.id.startsWith("fold."));
        const retired = f.commands.run(id);
        // A keyboard layout can produce a different character at this physical key.
        const node = document.querySelector<HTMLTextAreaElement>("#primary textarea")!;
        node.dispatchEvent(new KeyboardEvent("keydown", { key: "Å", code: "BracketRight", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
        host.dispose();
        f.discoverFolds(() => [{ from: 0, to: 15, group: "blocks" }]);
        return { block, unknown: unknown?.enabled, invalid, conflict, partial, retired, hostCalls };
    });
    expect(result).toEqual({ block: { id: "fold.collapse-all", label: "Collapse group", enabled: true }, unknown: false, invalid: false,
        conflict: expect.stringContaining("Key binding conflicts"), partial: [], retired: false, hostCalls: 1 });
    await expect.poll(() => page.evaluate(() => window.editingFixture.foldStatus()?.status)).toBe("ready");
    await input(page).press("Control+Shift+[");
    await expect.poll(() => page.evaluate(() => window.editingFixture.foldStatus()?.collapsed)).toBe(1);
});
test("automatic discovery preserves newer view choices, cancels changed targets and waits for composition", async ({ page }) => {
    await page.goto("/editing/");
    await page.evaluate(() => {
        const f = window.editingFixture; f.setText("head\n  child\nend");
        const pending: { signal: AbortSignal; resolve: (value: readonly { from: number; to: number }[]) => void }[] = [];
        Object.assign(window, { pendingFolds: pending });
        f.discoverFolds((_, signal) => new Promise(resolve => pending.push({ signal, resolve })));
    });
    const count = () => page.evaluate(() => (window as unknown as { pendingFolds: unknown[] }).pendingFolds.length);
    const resolve = () => page.evaluate(() => (window as unknown as { pendingFolds: { resolve: (value: readonly { from: number; to: number }[]) => void }[] }).pendingFolds.at(-1)!.resolve([{ from: 0, to: 13 }]));
    await expect.poll(count).toBe(1); await resolve();
    await expect.poll(() => page.evaluate(() => window.editingFixture.foldStatus()?.status)).toBe("ready");
    expect(await page.evaluate(() => {
        const f = window.editingFixture, groups = f.foldStatus()!.groups;
        f.refreshFolds(); return groups === f.foldStatus()!.groups;
    })).toBe(true); await expect.poll(count).toBe(2);
    await page.evaluate(() => window.editingFixture.commands.run("fold.collapse-all")); await resolve();
    await expect.poll(() => page.evaluate(() => window.editingFixture.foldStatus()?.status)).toBe("ready");
    expect((await page.evaluate(() => window.editingFixture.folding())).regions[0]!.collapsed).toBe(true);
    await page.evaluate(() => window.editingFixture.refreshFolds()); await expect.poll(count).toBe(3);
    await input(page).dispatchEvent("compositionstart", { data: "" });
    await resolve();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect((await page.evaluate(() => window.editingFixture.foldStatus()))?.status).toBe("pending");
    await input(page).dispatchEvent("compositionend", { data: "" });
    await expect.poll(() => page.evaluate(() => window.editingFixture.foldStatus()?.status)).toBe("ready");
    await page.evaluate(() => window.editingFixture.refreshFolds()); await expect.poll(count).toBe(4);
    await page.evaluate(() => window.editingFixture.setText("new\n  body\nlast"));
    expect(await page.evaluate(() => (window as unknown as { pendingFolds: { signal: AbortSignal }[] }).pendingFolds[3]!.signal.aborted)).toBe(true);
    await expect.poll(count).toBe(5); await page.evaluate(() => window.editingFixture.replacePrimary()); await resolve();
    expect(await page.evaluate(() => (window as unknown as { pendingFolds: { signal: AbortSignal }[] }).pendingFolds[4]!.signal.aborted)).toBe(true);
    await page.evaluate(() => window.editingFixture.dispose());
    expect((await page.evaluate(() => window.editingFixture.snapshot())).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});
test("a host cursor may invalidate itself without reentrant cancellation or leaking its work", async ({ page }) => {
    for (const throws of [false, true]) {
      await page.goto("/editing/");
    await page.evaluate(throws => {
        const f = window.editingFixture; f.setText("head\n  child\nend"); let first = true;
        Object.assign(window, { foldCursorClosed: false });
        f.discoverFolds(() => {
            if (!first) return []; first = false;
            let calls = 0, pumping = false, disposed = false;
            const snapshot = () => ({ status: disposed ? "disposed" as const : "running" as const, result: null, failure: null });
            return { snapshot, next: budget => {
                if (budget !== 4096) throw new Error("Expected charged cursor budget");
                pumping = true;
                try {
                    // Cross a task boundary before invalidating the running cursor.
                    if (++calls === 65) {
                        f.edit([{ from: 0, to: 0, insert: "prefix\n" }]);
                        if (throws) throw new Error("Expired fold work failed");
                    }
                    return snapshot();
                } finally { pumping = false; }
            }, dispose: () => {
                if (pumping) throw new Error("Reentrant fold disposal");
                disposed = true; Object.assign(window, { foldCursorClosed: true });
            } };
        });
    }, throws);
    await expect.poll(() => page.evaluate(() => window.editingFixture.foldStatus()?.status)).toBe("ready");
    expect(await page.evaluate(() => (window as unknown as { foldCursorClosed: boolean }).foldCursorClosed)).toBe(true);
    }
});

test("terminal and late fold cursors release ownership without replacing folds on failure", async ({ page }) => {
    await page.goto("/editing/");
    for (const mode of ["ready", "failed", "disposed", "throw"] as const) {
        await page.evaluate(mode => {
            const f = window.editingFixture; f.setText("head\n  child\nend"); f.folds([{ id: "existing", from: 0, to: 13, collapsed: true }]);
            Object.assign(window, { foldCursorReleases: 0 });
            f.discoverFolds(() => {
                const snapshot = () => ({ status: mode === "throw" ? "running" as const : mode,
                    result: mode === "ready" ? [{ from: 0, to: 13 }] : null, failure: mode === "failed" ? "Fixture failure" : null });
                return { snapshot, next: () => { if (mode === "throw") throw new Error("Fixture failure"); return snapshot(); },
                    dispose: () => { const w = window as unknown as { foldCursorReleases: number }; w.foldCursorReleases++; } };
            });
        }, mode);
        await expect.poll(() => page.evaluate(() => window.editingFixture.foldStatus()?.status)).toBe(mode === "ready" ? "ready" : "failed");
        expect(await page.evaluate(() => (window as unknown as { foldCursorReleases: number }).foldCursorReleases)).toBe(1);
        expect((await page.evaluate(() => window.editingFixture.folding())).regions).toMatchObject([{ id: "existing", collapsed: true }]);
    }
    await page.evaluate(() => {
        const f = window.editingFixture;
        f.discoverFolds(() => new Promise(resolve => {
            Object.assign(window, { resolveLateFold: () => resolve({
                snapshot: () => ({ status: "running", result: null, failure: null }),
                next: () => { throw new Error("Late fold cursor must not advance"); },
                dispose: () => { Object.assign(window, { lateFoldReleased: true }); }
            }) });
        }));
    });
    await page.waitForFunction(() => "resolveLateFold" in window);
    await page.evaluate(() => {
        window.editingFixture.discoverFolds(() => []);
        (window as unknown as { resolveLateFold: () => void }).resolveLateFold();
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { lateFoldReleased: boolean }).lateFoldReleased)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.editingFixture.foldStatus()?.status)).toBe("ready");
});

test("folded rows keep independent views, disclosure keys and visible-line navigation while Find reveals raw matches", async ({ page }) => {
    await page.goto("/editing/"); const text = "head\r\none\r\ntwo\r\nlast\r\n";
    await page.evaluate(text => { const f = window.editingFixture; f.setText(text); f.folds([{ id: "body", from: 0, to: text.indexOf("last"), collapsed: true }]); }, text); await ready(page);
    const primary = page.locator("#primary .st-viewport-row"), secondary = page.locator("#secondary .st-viewport-row");
    expect(await primary.allTextContents()).toEqual(["head", "last", ""]); expect(await secondary.allTextContents()).toEqual(["head", "one", "two", "last", ""]);
    const summary = primary.first().locator(".st-fold-summary");
    await expect(summary).toHaveAttribute("data-label", "… 2 lines hidden");
    expect(await summary.evaluate(node => getComputedStyle(node, "::after").content)).toContain("2 lines hidden");
    // The marker is presentation only: full raw copy and text-node geometry still address source.
    const copied = await input(page).evaluate(node => {
        const f = window.editingFixture; f.select("primary", { anchor: 0, head: f.snapshot().document!.length });
        const event = new ClipboardEvent("copy", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }); node.dispatchEvent(event);
        f.select("primary", { anchor: 0, head: 0 }); return event.clipboardData!.getData("text/plain");
    }); expect(copied).toBe(text);
    await input(page).press("Escape"); await input(page).press("Shift+Tab");
    expect(await page.evaluate(() => document.getElementById("primary")!.contains(document.activeElement))).toBe(false);
    await input(page).focus(); await input(page).press("Escape"); await input(page).press("Tab");
    expect(await page.evaluate(() => document.getElementById("primary")!.contains(document.activeElement))).toBe(false);
    await input(page).press("ArrowDown"); await ready(page); expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.selection.head).toBe(16);
    await input(page).press("ArrowUp"); await ready(page); expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.selection.head).toBe(0);
    await input(page).press("End"); await input(page).press("ArrowRight"); await ready(page); expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.selection.head).toBe(16);
    const disclosure = page.getByRole("button", { name: "Expand lines 2–3", exact: true }); await disclosure.focus(); await disclosure.press("Space"); await ready(page);
    await expect(page.getByRole("button", { name: "Collapse lines 2–3", exact: true })).toHaveAttribute("aria-expanded", "true"); expect(await primary.allTextContents()).toEqual(["head", "one", "two", "last", ""]);
    await expect(summary).toHaveCount(0);
    await page.getByRole("button", { name: "Collapse lines 2–3", exact: true }).press("Enter"); await ready(page);
    expect(await primary.allTextContents()).toEqual(["head", "last", ""]);
    // A queued viewport paint between pointerdown/up must preserve the pressed disclosure.
    await disclosure.hover(); await page.mouse.down();
    const painted = await disclosure.evaluate(() => new Promise<boolean>(resolve => {
        const f = window.editingFixture, before = f.snapshot().primary.viewport.renders;
        f.select("primary", { anchor: 1, head: 1 });
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(f.snapshot().primary.viewport.renders > before)));
    })); expect(painted).toBe(true);
    await page.mouse.up(); await expect(page.getByRole("button", { name: "Collapse lines 2–3", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Collapse lines 2–3", exact: true }).press("Enter"); await ready(page);
    await page.getByRole("textbox", { name: "Find", exact: true }).fill("two"); await expect(page.locator("#find-status")).toContainText("1 matches · ready");
    await page.getByRole("button", { name: "Next match", exact: true }).click(); await ready(page);
    expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.selection).toMatchObject({ anchor: 11, head: 14 });
    expect((await page.evaluate(() => window.editingFixture.folding())).regions[0]!.collapsed).toBe(false);
    await input(page).pressSequentially("TWO"); await ready(page); expect(await page.evaluate(() => window.editingFixture.range(0, 22))).toBe("head\r\none\r\nTWO\r\nlast\r\n");
    await input(page, "Secondary source").press("Control+z"); await ready(page); expect(await page.evaluate(() => window.editingFixture.range(0, 22))).toBe(text);
    expect((await page.evaluate(() => window.editingFixture.snapshot())).document!.exports).toBe(0);
    await page.evaluate(() => window.editingFixture.dispose()); expect((await page.evaluate(() => window.editingFixture.snapshot())).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});
test("a 100k-line fold keeps row work bounded, maps edits and undo, and reveals a hidden typing target", async ({ page }) => {
    test.setTimeout(120000); await page.goto("/editing/"); const text = "start\r\n" + "const row = 1;\r\n".repeat(100000) + "end", end = text.length - 3;
    await page.evaluate(({ text, end }) => { const f = window.editingFixture; f.setText(text); f.folds([{ id: "many", from: 0, to: end, collapsed: true }]); }, { text, end }); await ready(page);
    let state = await page.evaluate(() => window.editingFixture.snapshot()); expect(state.primary.viewport.visibleLines).toBe(2); expect(state.primary.viewport.rows).toBe(2); expect(state.primary.inputUnits).toBeLessThanOrEqual(2600);
    expect(await page.locator("#primary .st-viewport-row").allTextContents()).toEqual(["start", "end"]);
    await expect(page.locator("#primary .st-fold-summary")).toHaveAttribute("data-label", "… 100000 lines hidden");
    await input(page).press("PageDown"); await ready(page); expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.selection.head).toBe(end);
    await input(page).press("PageUp"); await ready(page); expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.selection.head).toBe(0);
    const middle = Math.floor(text.length / 2); await page.evaluate(at => window.editingFixture.edit([{ from: at, to: at, insert: "new\r\n" }]), middle); await ready(page);
    state = await page.evaluate(() => window.editingFixture.snapshot()); expect(state.primary.viewport.visibleLines).toBe(2); expect(state.primary.viewport.rows).toBe(2);
    await input(page, "Secondary source").press("Control+z"); await ready(page); expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.viewport.visibleLines).toBe(2);
    await page.evaluate(at => window.editingFixture.select("primary", { anchor: at, head: at }), middle); await ready(page);
    expect((await page.evaluate(() => window.editingFixture.folding())).regions[0]!.collapsed).toBe(false);
    await page.evaluate(end => window.editingFixture.discoverFolds(() => [{ from: 0, to: end, group: "large" }]), end);
    await expect.poll(() => page.evaluate(() => window.editingFixture.foldStatus()?.status)).toBe("ready");
    expect(await page.evaluate(() => window.editingFixture.commands.run("fold.collapse-all", "large"))).toBe(true); await ready(page);
    state = await page.evaluate(() => window.editingFixture.snapshot());
    expect(state.primary.selection).toMatchObject({ anchor: 5, head: 5 });
    expect(state.primary.viewport.rows).toBe(2); expect(state.primary.inputUnits).toBeLessThanOrEqual(2600);
    // A host can still restore a logical caret inside a fold. Input must edit its raw offset.
    await page.evaluate(middle => {
        const f = window.editingFixture; f.select("primary", { anchor: middle, head: middle });
        f.folds([{ id: "many", from: 0, to: f.snapshot().document!.length - 3, collapsed: true }]);
    }, middle); await ready(page);
    await input(page).pressSequentially("!"); await ready(page); state = await page.evaluate(() => window.editingFixture.snapshot());
    expect(state.primary.selection.head).toBe(middle + 1); expect(state.primary.viewport.visibleLines).toBe(100002); expect(state.document!.exports).toBe(0);
    expect(await page.evaluate(at => window.editingFixture.range(at, at + 5), middle)).toBe("!" + text.slice(middle, middle + 4));
    await page.evaluate(() => window.editingFixture.dispose()); expect((await page.evaluate(() => window.editingFixture.snapshot())).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});
