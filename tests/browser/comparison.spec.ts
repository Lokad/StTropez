import { ready, test, expect } from "./fixtures.ts";

test.beforeEach(async ({ page }) => {  await page.goto("/comparison/"); await ready(page); });

test("paired navigation exposes exact whitespace and reverts one hunk through shared undo", async ({ page }) => {
    const initial = await page.evaluate(() => window.comparisonFixture.snapshot()); expect(initial.hunks.length).toBeGreaterThan(1);
    await expect(page.getByRole("button", { name: "Use baseline", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Next change", exact: true }).click();
    await expect(page.locator(".st-comparison-controls output")).toContainText("Change 1 of");
    await page.getByRole("button", { name: "Use baseline", exact: true }).click(); await ready(page);
    expect(await page.evaluate(() => window.comparisonFixture.range(0, 25))).toContain("Baseline");
    expect((await page.evaluate(() => window.comparisonFixture.snapshot())).history.undoDepth).toBe(1);
    await page.getByRole("button", { name: "Undo working edit", exact: true }).click(); await ready(page);
    expect(await page.evaluate(() => window.comparisonFixture.range(0, 24))).toContain("Working");
    await page.evaluate(() => window.comparisonFixture.setText("a\n")); await ready(page);
    await page.evaluate(() => { window.comparisonFixture.begin("accept"); window.comparisonFixture.finish("accept"); window.comparisonFixture.setText("a\r\n"); }); await ready(page);
    await page.getByRole("button", { name: "Next change", exact: true }).click();
    await expect(page.locator(".st-comparison-controls output")).toContainText("whitespace only");
    await expect(page.locator(".st-comparison-preview")).toContainText("␍");
    expect(await page.locator(".st-comparison-line-working").count()).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.comparisonFixture.snapshot().working.exports)).toBe(0);
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
    expect(final.hunks.length).toBe(1); expect(final.working.exports).toBe(0); expect(final.baseline!.exports).toBe(0);
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
    expect(after.diagnostics).toMatchObject({ resources: 2, documents: 2, tabs: 2, views: 2, leases: 3 });
});

test("a stale selected hunk cannot retarget after typing, and permissions gate revert", async ({ page }) => {
    const captured = await page.evaluate(() => { const s = window.comparisonFixture.snapshot(); window.comparisonFixture.selectHunk(s.generation, 0); window.comparisonFixture.focus(); return s; });
    await page.keyboard.type("new"); await ready(page);
    expect(await page.evaluate(g => window.comparisonFixture.revert(g, 0), captured.generation)).toBe(false);
    await expect(page.getByRole("button", { name: "Use baseline", exact: true })).toBeDisabled();
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
    const capture = await page.evaluate(() => {
        const f = window.comparisonFixture, state = f.review.getSnapshot(); let rejected = false, calls = 0;
        const stop = f.review.subscribe(() => { calls++; try { f.selectHunk(f.review.getSnapshot().comparison.generation, 0); } catch { rejected = true; } });
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
    expect(await page.evaluate(g => window.comparisonFixture.revert(g, 0), capture.generation)).toBe(false);
    await input.dispatchEvent("compositionend", { data: "" }); await ready(page);
    await page.evaluate(() => window.comparisonFixture.focus());
    await page.keyboard.type("replacement"); await ready(page);
    expect(await page.evaluate(g => window.comparisonFixture.revert(g, 0), capture.generation)).toBe(false);
    expect(await page.evaluate(() => window.comparisonFixture.review.getSnapshot().selectedHunk)).toBeNull();
    await expect(restore).toBeDisabled();
    await later.click();
    const beforeRefresh = await page.evaluate(() => {
        const f = window.comparisonFixture, state = f.review.getSnapshot(); f.begin("refresh"); f.finish("refresh");
        return { generation: state.comparison.generation, cleared: f.review.getSnapshot().selectedHunk === null };
    });
    expect(beforeRefresh.cleared).toBe(true); await ready(page);
    expect(await page.evaluate(g => window.comparisonFixture.selectHunk(g, 0), beforeRefresh.generation)).toBe(false);
    await later.click();
    expect(await input.evaluate(element => {
        const f = window.comparisonFixture, state = f.review.getSnapshot(), input = element as HTMLTextAreaElement;
        input.readOnly = true; const applied = f.revert(state.comparison.generation, state.selectedHunk!); input.readOnly = false; return applied;
    })).toBe(false);
    await restore.click(); await ready(page);
    await page.getByRole("button", { name: "Undo working edit", exact: true }).click(); await ready(page);
    const terminal = await page.evaluate(() => {
        const f = window.comparisonFixture; let notified = false;
        const stop = f.review.subscribe(() => { if (f.review.getSnapshot().disposed) notified = true; });
        f.dispose(); stop(); const state = f.review.getSnapshot();
        return { notified, disposed: state.disposed, status: state.comparison.status, selected: state.selectedHunk,
            navigate: state.canNavigate, revert: state.canRevert, rejected: !f.revert(state.comparison.generation, 0), diagnostics: f.snapshot().diagnostics };
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
    expect(state.status).toBe("disposed"); expect(state.baseline).toBeNull(); expect(state.reference).toBeNull();
    expect(state.pending).toEqual({ refreshes: 0, acceptances: 0 });
    await expect(page.getByRole("button", { name: "Request baseline refresh", exact: true })).toBeDisabled();
    expect(state.diagnostics).toMatchObject({ resources: 2, tabs: 1, views: 0, leases: 0, subscriptions: 0 });
    await expect(page.locator(".st-comparison")).toHaveCount(0);
});

test("large comparison stays virtualized, exact and cooperative during real input", async ({ page }) => {
    for (const kind of ["long", "unique", "repeated", "unbalanced"] as const) {
        const { length, at } = await page.evaluate(kind => {
            const many = kind !== "long";
            const text = many ? Array.from({ length: 10000 }, (_, i) => `row ${kind === "unique" ? i : i % 20}\n`).join("") : "unchanged source line\r\n".repeat(30000);
            let working = many ? text.replace(/^row (\d+)$/gm, (line, n: string) => Number(n) % 10 === 0 ? "changed " + n : line) : text.replace("unchanged", "modified") + "tail";
            if (kind === "unbalanced") working = working.replaceAll("row 11\n", "row 11\nrow 11\n");
            const at = kind === "unbalanced" ? working.indexOf("changed ", Math.floor(working.length / 2)) + 3 : working.length;
            const f = window.comparisonFixture; f.setText(text); f.begin("accept"); f.finish("accept"); f.setText(working);
            f.select({ anchor: at, head: at }); f.focus(); return { length: working.length, at };
        }, kind);
        if (kind === "unbalanced") await ready(page); // Retain the completed review before editing an unmatched row.
        await page.keyboard.type("x"); await ready(page);
        const state = await page.evaluate(() => window.comparisonFixture.snapshot());
        expect(state.hunks.length).toBeGreaterThan(0); expect(state.working.exports).toBe(0); expect(state.baseline!.exports).toBe(0);
        expect(await page.locator(".st-viewport-row").count()).toBeLessThan(100);
        expect(state.editor.inputUnits).toBeLessThan(2600); expect(state.working.length).toBe(length + 1);
        expect(await page.evaluate(at => window.comparisonFixture.range(at, at + 1), at)).toBe("x");
        if (kind !== "long") {
            expect(state.hunks.length).toBe(kind === "unbalanced" ? 1068 : 1001);
            await page.keyboard.press("Control+z"); await ready(page);
            const undone = await page.evaluate(() => window.comparisonFixture.snapshot());
            expect(undone.working.length).toBe(length); expect(undone.hunks.length).toBe(kind === "unbalanced" ? 1068 : 1000);
            await page.keyboard.press("Control+Shift+z"); await ready(page);
            expect((await page.evaluate(() => window.comparisonFixture.snapshot())).hunks.length).toBe(kind === "unbalanced" ? 1068 : 1001);
            expect(await page.evaluate(at => window.comparisonFixture.range(at, at + 1), at)).toBe("x");
        }
    }
});

test("a full 100000-line hunk stays atomic under bounded history and permits later typing", async ({ page }) => {
    const reference = Array.from({ length: 100_000 }, (_, index) => `A${String(index).padStart(6, "0")} = 1234567890123;`).join("\n") + "X";
    const working = Array.from({ length: 100_000 }, (_, index) => `B${String(index).padStart(6, "0")} = 9876543210987;`).join("\n") + "Y";
    await page.evaluate(({ reference, working }) => {
        const fixture = window.comparisonFixture;
        fixture.setText(reference); fixture.begin("accept"); fixture.finish("accept"); fixture.setText(working);
    }, { reference, working }); await ready(page);
    const before = await page.evaluate(() => window.comparisonFixture.snapshot());
    expect(before.hunks).toHaveLength(1);
    expect(before.hunks[0]).toMatchObject({ baseline: { from: 0, to: reference.length }, working: { from: 0, to: working.length } });
    await page.getByRole("button", { name: "Next change", exact: true }).click();
    await page.getByRole("button", { name: "Use baseline", exact: true }).click(); await ready(page);
    const reverted = await page.evaluate(() => window.comparisonFixture.snapshot());
    // The default changed-unit cap evicts the two setup entries, retaining this whole hunk.
    expect(reverted.history).toMatchObject({ undoDepth: 1 });
    expect(reverted.diagnostics.history).toMatchObject({ groups: 1, changedUnits: 5_000_000 });
    expect(reverted.selection).toEqual({ anchor: 0, head: reference.length, anchorAffinity: "after", headAffinity: "before" });
    expect(reverted.hunks).toHaveLength(0);
    const input = page.getByRole("textbox", { name: "Comparison working source", exact: true });
    await input.focus(); await input.press("ArrowRight"); await input.press("q"); await ready(page);
    for (const [command, expected] of [["Undo working edit", reference], ["Undo working edit", working], ["Redo working edit", reference], ["Redo working edit", reference + "q"]] as const) {
        await page.getByRole("button", { name: command, exact: true }).click(); await ready(page);
        expect(await page.evaluate(({ expected, reference }) => {
            const fixture = window.comparisonFixture, state = fixture.snapshot();
            if (state.working.length !== expected.length || state.baseline?.length !== reference.length) return false;
            for (let from = 0; from < expected.length; from += 32768) if (fixture.range(from, Math.min(expected.length, from + 32768)) !== expected.slice(from, from + 32768)) return false;
            for (let from = 0; from < reference.length; from += 32768) if (fixture.baselineRange(from, Math.min(reference.length, from + 32768)) !== reference.slice(from, from + 32768)) return false;
            return true;
        }, { expected, reference })).toBe(true);
    }
    const final = await page.evaluate(() => window.comparisonFixture.snapshot());
    expect(final.working.id).toBe(before.working.id); expect(final.viewId).toBe(before.viewId);
    expect(final.working.revision).toBe(before.working.revision + 6);
    expect(final.working.metadata).toMatchObject({ serverVersion: "saved-1", dirty: true });
    expect(final.baseline?.version).toBe(before.baseline?.version); expect(final.editor.inputEvents).toBe(1);
    expect(final.editor.inputUnits).toBeLessThan(2600);
    expect(await page.locator(".st-viewport-row").count()).toBeLessThan(100);
    expect(final.working.exports).toBe(0); expect(final.baseline?.exports).toBe(0);
    await page.getByRole("button", { name: "Dispose comparison", exact: true }).click();
    expect((await page.evaluate(() => window.comparisonFixture.snapshot())).diagnostics).toMatchObject({ resources: 1, tabs: 1, views: 0, leases: 0, subscriptions: 0 });
});
