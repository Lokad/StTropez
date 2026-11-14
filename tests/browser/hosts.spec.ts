import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";

for (const editor of ["native", "candidate"] as const) for (const mode of ["plain", "react"] as const) {
    test.describe(`${mode} ${editor} controller host`, () => {
        // Model permutations have deterministic owners. These variants establish DOM/host differences.
        const nativeControls = new Set([
            "stable refs preserve independent view state through movement/remount and typing avoids unrelated commits",
            "shared typing/deletion history returns to saved content and survives move, unmount, close and reopen",
            "forced view removal retains uncommitted composition separately from the document",
        ]);
        const reactIntegration = new Set([
            "proposal/correction/save/failed acknowledgement/retry/next request preserves both views and typed form",
            "queued host writes and synchronous edits have distinct completion; disposal stops background work",
            "synthetic composition survives independent form/progress updates and a Run error",
            "a large source completes propose/correct/save/acknowledge/next-request through bounded views",
        ]);
        const hostTest = (name: string, body: (args: { page: Page }) => Promise<void>) => {
            if (nativeControls.has(name) || editor === "candidate" && (mode === "plain" || reactIntegration.has(name))) test(name, body);
        };
        test.beforeEach(async ({ page }) => {


            await page.goto(`/hosts/${mode}/?editor=${editor}`);
            await expect(page.getByRole("textbox", { name: "Primary source", exact: true })).toBeVisible();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().bindings.activeViews)).toBe(2);
        });

        hostTest("proposal/correction/save/failed acknowledgement/retry/next request preserves both views and typed form", async ({ page }) => {
            const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
            const secondary = page.getByRole("textbox", { name: "Secondary source", exact: true });
            await page.getByRole("button", { name: "Associate agent", exact: true }).click();
            await page.getByRole("button", { name: "Request proposal", exact: true }).click();
            await expect(primary).toHaveAttribute("readonly", ""); await expect(secondary).toHaveAttribute("readonly", "");
            const captured = await page.evaluate(() => window.hostFixture.snapshot().requestInput);
            await page.getByRole("textbox", { name: "Configuration path" }).fill("updated.csv");
            await page.getByRole("button", { name: "Move primary view", exact: true }).click();
            expect(await page.evaluate(() => window.hostFixture.snapshot().requestInput)).toEqual(captured);
            await page.getByRole("button", { name: "Deliver proposal", exact: true }).click();
            await expect(primary).toHaveValue("agent proposal"); await expect(secondary).toHaveValue("agent proposal");
            await primary.fill("human correction");
            await page.getByRole("button", { name: "Save source", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().pendingSaves.length)).toBe(1);
            await primary.press("End"); await primary.pressSequentially(" later");
            await page.getByRole("button", { name: "Finish save", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().review.acknowledgements.length)).toBe(1);
            await expect(primary).toHaveValue("human correction later");
            await primary.press("Control+z"); await expect(primary).toHaveValue("human correction");
            expect((await page.evaluate(() => window.hostFixture.snapshot())).source.dirty).toBe(false);
            await primary.press("Control+z"); await expect(primary).toHaveValue("agent proposal");
            await primary.press("Control+Shift+z"); await expect(primary).toHaveValue("human correction");
            await primary.press("Control+Shift+z"); await expect(primary).toHaveValue("human correction later");
            await page.getByRole("button", { name: "Retry acknowledgement", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().review.acknowledgements[0]?.status)).toBe("failed");
            await expect(page.getByRole("status", { name: "Host messages" })).toContainText("document is retained");
            await page.getByRole("button", { name: "Retry acknowledgement", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().review.proposal)).toBeNull();
            const acknowledged = await page.evaluate(() => window.hostFixture.snapshot());
            expect(acknowledged.activity).toMatchObject({ writes: 1, acknowledgements: 1, ackAttempts: 2 });
            await page.getByRole("button", { name: "Request proposal", exact: true }).click();
            const next = await page.evaluate(() => window.hostFixture.snapshot());
            expect(next.requestInput?.sourceLength).toBe("human correction later".length);
            expect(next.requestInput?.configurationRevision).toBe(next.configuration.revision);
            await page.getByRole("button", { name: "Prompt close", exact: true }).click();
            await page.getByRole("button", { name: "Confirm close", exact: true }).click();
            await page.getByRole("button", { name: "Reopen primary source", exact: true }).click();
            await page.getByRole("button", { name: "Replace primary panel", exact: true }).click();
            await page.getByRole("button", { name: "Reopen primary source", exact: true }).click();
            await page.getByRole("button", { name: "Interrupt agent", exact: true }).click();
            await primary.fill("after interrupt");
            await page.getByRole("button", { name: "Deliver proposal", exact: true }).click();
            await expect(primary).toHaveValue("after interrupt");
            await page.getByRole("button", { name: "Close source review", exact: true }).click();
            await expect.poll(() => page.evaluate(() => { const { leases, views } = window.hostFixture.snapshot().diagnostics; return leases - views; })).toBe(0);
        });

        hostTest("proposal review exposes an immutable reference, shared typing and undoable hunk reversion without remounting source views", async ({ page }) => {
            const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
            const secondary = page.getByRole("textbox", { name: "Secondary source", exact: true });
            await primary.press("End"); await primary.pressSequentially(" human");
            await page.getByRole("button", { name: "Associate agent", exact: true }).click();
            await page.getByRole("button", { name: "Request proposal", exact: true }).click();
            await primary.focus(); await primary.evaluate(node => { node.dataset.retained = "yes"; });
            const before = await page.evaluate(() => window.hostFixture.snapshot());
            await page.evaluate(() => window.hostFixture.deliverProposal("agent proposal"));
            const review = page.getByRole("group", { name: "Source review", exact: true });
            await expect(review).toHaveAttribute("data-status", "ready");
            expect(await page.evaluate(() => window.hostFixture.referenceRange(0, window.hostFixture.snapshot().bindings.comparison!.baseline!.length))).toBe("start human");
            await expect(primary).toHaveAttribute("data-retained", "yes"); await expect(primary).toBeFocused();
            expect((await page.evaluate(() => window.hostFixture.snapshot())).bindings.mounts).toBe(before.bindings.mounts);
            await review.getByRole("button", { name: "Next change", exact: true }).click();
            await review.getByRole("button", { name: "Use baseline", exact: true }).click();
            await expect(primary).toHaveValue("start human"); await expect(secondary).toHaveValue("start human");
            await primary.press("Control+z"); await expect(primary).toHaveValue("agent proposal");
            await primary.press("Control+Shift+z"); await expect(primary).toHaveValue("start human");
            const working = page.getByRole("textbox", { name: "Comparison working source", exact: true });
            await working.press("Control+End"); await working.pressSequentially("!");
            await expect(primary).toHaveValue("start human!"); await expect(secondary).toHaveValue("start human!");
            expect(await page.evaluate(() => window.hostFixture.referenceRange(0, window.hostFixture.snapshot().bindings.comparison!.baseline!.length))).toBe("start human");
            await expect(review).toHaveAttribute("data-status", "ready");
            const after = await page.evaluate(() => window.hostFixture.snapshot());
            expect(after.bindings.comparison!.workingRevision).toBe(after.source.revision);
            expect(after.bindings.comparison!.input.inputUnits).toBeLessThan(2600);
            await page.evaluate(() => window.hostFixture.dispose());
            expect((await page.evaluate(() => window.hostFixture.snapshot())).diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 });
        });

        hostTest("captured review acceptance and saved-reference refresh retain later edits, expire stale responses and survive remount", async ({ page }) => {
            const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
            await primary.press("End"); await primary.pressSequentially(" A");
            await page.getByRole("button", { name: "Open source review", exact: true }).click();
            await expect(page.getByRole("group", { name: "Source review", exact: true })).toHaveAttribute("data-status", "ready");
            await page.getByRole("button", { name: "Capture reference refresh", exact: true }).click();
            await page.getByRole("button", { name: "Capture review acceptance", exact: true }).click();
            await primary.press("End"); await primary.pressSequentially("B");
            await page.getByRole("button", { name: "Finish review acceptance", exact: true }).click();
            expect(await page.evaluate(() => window.hostFixture.referenceRange(0, window.hostFixture.snapshot().bindings.comparison!.baseline!.length))).toBe("start A");
            await page.getByRole("button", { name: "Finish reference refresh", exact: true }).click();
            await expect(page.getByLabel("Reference operation status", { exact: true })).toHaveText("refresh expired");
            expect(await page.evaluate(() => window.hostFixture.referenceRange(0, window.hostFixture.snapshot().bindings.comparison!.baseline!.length))).toBe("start A");
            expect((await page.evaluate(() => window.hostFixture.snapshot())).source).toMatchObject({ serverVersion: "v0", dirty: true });
            await page.evaluate(() => window.hostFixture.unmount()); await page.evaluate(() => window.hostFixture.mount());
            expect(await page.evaluate(() => window.hostFixture.referenceRange(0, window.hostFixture.snapshot().bindings.comparison!.baseline!.length))).toBe("start A");
            await page.getByRole("button", { name: "Save source", exact: true }).click();
            await primary.press("End"); await primary.pressSequentially("C");
            await page.evaluate(() => window.hostFixture.finishSave());
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().source.serverVersion)).toBe("v1");
            expect(await page.evaluate(() => window.hostFixture.referenceRange(0, window.hostFixture.snapshot().bindings.comparison!.baseline!.length))).toBe("start A");
            await page.getByRole("button", { name: "Capture reference refresh", exact: true }).click();
            await page.getByRole("button", { name: "Finish reference refresh", exact: true }).click();
            expect(await page.evaluate(() => window.hostFixture.referenceRange(0, window.hostFixture.snapshot().bindings.comparison!.baseline!.length))).toBe("start AB");
            await expect(primary).toHaveValue("start ABC");
            await primary.press("Control+z"); await expect(primary).toHaveValue("start AB");
            expect((await page.evaluate(() => window.hostFixture.snapshot())).source.dirty).toBe(false);
            await primary.press("Control+Shift+z"); await expect(primary).toHaveValue("start ABC");
            await page.getByRole("button", { name: "Capture review acceptance", exact: true }).click();
            await page.getByRole("button", { name: "Replace primary panel", exact: true }).click();
            expect((await page.evaluate(() => window.hostFixture.snapshot())).bindings.comparison).toBeNull();
            await page.getByRole("button", { name: "Reopen primary source", exact: true }).click();
            await page.getByRole("button", { name: "Finish review acceptance", exact: true }).click();
            expect(await page.evaluate(() => window.hostFixture.referenceRange(0, window.hostFixture.snapshot().bindings.comparison!.baseline!.length))).toBe("start AB");
            expect((await page.evaluate(() => window.hostFixture.snapshot())).bindings.comparison!.pending).toEqual([]);
            await page.evaluate(() => window.hostFixture.dispose());
            const disposed = await page.evaluate(() => window.hostFixture.snapshot());
            expect(disposed.diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 }); expect(disposed.hostSubscriptions).toBe(0);
        });

        hostTest("stable refs preserve independent view state through movement/remount and typing avoids unrelated commits", async ({ page }) => {
            const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
            const secondary = page.getByRole("textbox", { name: "Secondary source", exact: true });
            await primary.fill("abcdefghij");
            await primary.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 5, "backward"));
            await secondary.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(7, 8));
            const before = await page.evaluate(() => window.hostFixture.snapshot());
            if (mode === "react") {
                expect(before.bindings.mounts).toBeGreaterThanOrEqual(4);
                expect(before.bindings.mounts - before.bindings.destroys).toBe(2);
            }
            await page.getByRole("button", { name: "Move primary view", exact: true }).click();
            await expect(primary).toHaveValue("abcdefghij");
            expect(await primary.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([2, 5, "backward"]);
            expect(await secondary.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([7, 8]);
            await page.getByRole("button", { name: "Toggle views", exact: true }).click(); await expect(primary).toHaveCount(0);
            await page.getByRole("button", { name: "Toggle views", exact: true }).click(); await expect(primary).toHaveValue("abcdefghij");
            // First focus attaches active-only language/fold observation. Compare typing
            // against that steady state; view unmount releases UI listeners while the
            // host draft service keeps three model observers and one rejected-input
            // observer until full disposal.
            await primary.focus();
            const ready = await page.evaluate(() => window.hostFixture.snapshot());
            await primary.press("End"); await primary.pressSequentially(" more typing");
            await expect(secondary).toHaveValue("abcdefghij more typing");
            const after = await page.evaluate(() => window.hostFixture.snapshot());
            expect(after.configuration.revision).toBe(ready.configuration.revision);
            expect(after.commits.form).toBe(ready.commits.form); expect(after.commits.metadata).toBe(ready.commits.metadata);
            expect(after.diagnostics.subscriptions).toBe(ready.diagnostics.subscriptions);
            await page.evaluate(() => window.hostFixture.unmount());
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().diagnostics.subscriptions)).toBe(4);
            expect((await page.evaluate(() => window.hostFixture.snapshot())).hostSubscriptions).toBe(2); // Input-recovery and loaded-source slot observers outlive views.
            await page.evaluate(() => window.hostFixture.mount()); await expect(primary).toHaveValue("abcdefghij more typing");
            expect((await page.evaluate(() => window.hostFixture.snapshot())).bindings.activeViews).toBe(2);
            await page.evaluate(() => window.hostFixture.dispose());
            expect((await page.evaluate(() => window.hostFixture.snapshot())).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
            expect((await page.evaluate(() => window.hostFixture.snapshot())).hostSubscriptions).toBe(0);
        });

        hostTest("shared typing/deletion history returns to saved content and survives move, unmount, close and reopen", async ({ page }) => {
            const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
            const secondary = page.getByRole("textbox", { name: "Secondary source", exact: true });
            await primary.fill("base"); await page.getByRole("button", { name: "Save source", exact: true }).click();
            await page.getByRole("button", { name: "Finish save", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().source.dirty)).toBe(false);
            const depth = await page.evaluate(() => window.hostFixture.snapshot().history.undoDepth);
            await primary.press("End"); await primary.pressSequentially("abc");
            expect((await page.evaluate(() => window.hostFixture.snapshot())).history.undoDepth).toBe(depth + 1);
            await primary.press("Backspace"); await primary.press("Backspace"); await expect(secondary).toHaveValue("basea");
            await primary.press("Control+z"); await expect(primary).toHaveValue("baseabc");
            await page.getByRole("button", { name: "Move primary view", exact: true }).click();
            await page.evaluate(() => window.hostFixture.unmount()); await page.evaluate(() => window.hostFixture.mount());
            await primary.press("Control+z"); await expect(primary).toHaveValue("base"); await expect(secondary).toHaveValue("base");
            expect((await page.evaluate(() => window.hostFixture.snapshot())).source.dirty).toBe(false);
            await primary.press("Control+Shift+z"); await expect(primary).toHaveValue("baseabc");
            await page.evaluate(() => window.hostFixture.unmount()); await page.evaluate(() => window.hostFixture.mount());
            await primary.press("End"); await primary.pressSequentially("X");
            await primary.press("Control+z"); await expect(primary).toHaveValue("baseabc");
            await page.getByRole("button", { name: "Prompt close", exact: true }).click(); await page.getByRole("button", { name: "Confirm close", exact: true }).click();
            await page.getByRole("button", { name: "Reopen primary source", exact: true }).click();
            await primary.press("Control+z"); await expect(primary).toHaveValue("base");
        });

        hostTest("a typing pause forms separate undo groups and each group returns exactly toward the saved capture", async ({ page }) => {
            const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
            await primary.fill("base"); await page.getByRole("button", { name: "Save source", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().pendingSaves.length)).toBe(1);
            await primary.press("End"); await primary.pressSequentially(" la");
            await page.waitForTimeout(1100); // The adapter's documented one-second typing-pause boundary.
            await primary.pressSequentially("ter"); await page.evaluate(() => window.hostFixture.finishSave());
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().source.serverVersion)).toBe("v1");
            await primary.press("Control+z"); await expect(primary).toHaveValue("base la");
            expect((await page.evaluate(() => window.hostFixture.snapshot())).source.dirty).toBe(true);
            await primary.press("Control+z"); await expect(primary).toHaveValue("base");
            expect((await page.evaluate(() => window.hostFixture.snapshot())).source.dirty).toBe(false);
            await primary.press("Control+Shift+z"); await expect(primary).toHaveValue("base la");
            await primary.press("Control+Shift+z"); await expect(primary).toHaveValue("base later");
        });

        hostTest("detached view selections follow range edits and map back through shared undo without losing direction", async ({ page }) => {
            const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
            const secondary = page.getByRole("textbox", { name: "Secondary source", exact: true });
            await primary.fill("abcdefghij");
            await primary.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(1, 3, "forward"));
            await secondary.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(5, 8, "backward"));
            await page.evaluate(() => window.hostFixture.unmount());
            const edited = await page.evaluate(() => window.hostFixture.editSource(window.hostFixture.snapshot().source.revision, [{ from: 0, to: 0, insert: "XY" }]));
            expect(edited.applied).toBe(true); await page.evaluate(() => window.hostFixture.mount());
            await expect(primary).toHaveValue("XYabcdefghij");
            expect(await primary.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([3, 5]);
            expect(await secondary.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([7, 10, "backward"]);
            await primary.press("Control+z"); await expect(secondary).toHaveValue("abcdefghij");
            expect(await secondary.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([5, 8, "backward"]);
        });

        hostTest("captured close/load/save targets expire presentation while resource work completes after replacement and reopen", async ({ page }) => {
            const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
            await primary.fill("saved target");
            await page.getByRole("button", { name: "Save source", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().pendingSaves.length)).toBe(1);
            await page.getByRole("button", { name: "Prompt close", exact: true }).click();
            await page.getByRole("button", { name: "Replace primary panel", exact: true }).click();
            await page.getByRole("button", { name: "Reopen primary source", exact: true }).click();
            await page.getByRole("button", { name: "Confirm close", exact: true }).click();
            await expect(primary).toHaveValue("saved target");
            await page.getByRole("button", { name: "Prompt close", exact: true }).click();
            await page.getByRole("button", { name: "Confirm close", exact: true }).click(); await expect(primary).toHaveCount(0);
            await page.getByRole("button", { name: "Reopen primary source", exact: true }).click();
            await primary.fill("new human text");
            await page.getByRole("button", { name: "Finish save", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().activity.writes)).toBe(1);
            await expect(primary).toHaveValue("new human text");
            await page.getByRole("button", { name: "Begin delayed load", exact: true }).click(); await expect(primary).toHaveCount(0);
            await page.getByRole("button", { name: "Move primary view", exact: true }).click();
            await page.getByRole("button", { name: "Reopen primary source", exact: true }).click();
            await page.getByRole("button", { name: "Finish delayed load", exact: true }).click();
            await expect(primary).toHaveValue("new human text");
            await expect.poll(() => page.evaluate(() => { const { leases, views } = window.hostFixture.snapshot().diagnostics; return leases - views; })).toBe(0);
            await primary.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(3, 5));
            await page.getByRole("button", { name: "Begin delayed load", exact: true }).click();
            await page.getByRole("button", { name: "Move primary view", exact: true }).click();
            await page.getByRole("button", { name: "Finish delayed load", exact: true }).click();
            await expect(primary).toHaveValue("loaded resource");
            await primary.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(1, 2));
            await page.getByRole("button", { name: "Reopen primary source", exact: true }).click();
            await expect(primary).toHaveValue("new human text");
            expect(await primary.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([3, 5]);
        });

        hostTest("queued host writes and synchronous edits have distinct completion; disposal stops background work", async ({ page }) => {
            await page.getByRole("button", { name: "Queue setting and run", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().activity.ordering)).toEqual(["edit:true", "run:preview", "write:inspect", "run:inspect"]);
            await page.getByRole("textbox", { name: "Configuration path" }).fill("run.csv");
            const before = await page.evaluate(() => window.hostFixture.snapshot());
            await page.getByRole("button", { name: "Run captured inputs", exact: true }).click();
            expect((await page.evaluate(() => window.hostFixture.snapshot())).activity.lastRun).toEqual({ sourceRevision: before.source.revision, configurationRevision: before.configuration.revision, mode: "inspect" });
            await page.getByRole("button", { name: "Save source", exact: true }).click();
            await page.getByRole("button", { name: "Save source", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().pendingSaves.length)).toBe(1);
            await page.evaluate(() => window.hostFixture.dispose());
            const stopped = await page.evaluate(() => window.hostFixture.snapshot());
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 120)));
            expect(await page.evaluate(() => window.hostFixture.snapshot())).toEqual(stopped);
            expect(stopped.bindings.activeViews).toBe(0); expect(stopped.diagnostics.subscriptions).toBe(0); expect(stopped.hostSubscriptions).toBe(0);
            expect(stopped.diagnostics.leases).toBe(0); expect(stopped.pendingCommands).toBe(0);
            expect(stopped.pendingSaves).toEqual([]); expect(stopped.pendingRuns).toEqual([]);
            expect(await page.evaluate(() => { try { window.hostFixture.mount(); return false; } catch { return true; } })).toBe(true);
        });

        hostTest("deferred Run keeps captured source and configuration while keyboard edits and form updates continue", async ({ page }) => {
            const input = page.getByRole("textbox", { name: "Primary source", exact: true });
            await input.fill("captured source"); await page.getByRole("textbox", { name: "Configuration path", exact: true }).fill("before.csv");
            const before = await page.evaluate(() => window.hostFixture.snapshot());
            await page.getByRole("button", { name: "Run captured inputs", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().pendingRuns.length)).toBe(1);
            await expect(page.getByLabel("Host operation status", { exact: true })).toContainText("Runs: 1 pending, 0 completed");
            const captured = await page.evaluate(() => window.hostFixture.runCapture(0));
            expect(captured).toEqual({ source: "captured source", configuration: { path: "before.csv", format: "csv" }, settings: { mode: "preview" } });
            await input.press("End"); await input.pressSequentially(" later");
            await input.evaluate(node => { node.dataset.retained = "yes"; });
            await page.evaluate(() => window.hostFixture.setPath("after.csv"));
            const during = await page.evaluate(() => window.hostFixture.snapshot());
            expect(during.pendingRuns[0]).toMatchObject({ sourceId: before.source.id, sourceRevision: before.source.revision, sourceVersion: "v0", configurationId: before.configuration.id, configurationRevision: before.configuration.revision });
            expect(await page.evaluate(() => window.hostFixture.runCapture(0))).toEqual(captured);
            await page.evaluate(() => window.hostFixture.finishRun());
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().activity.completedRuns)).toBe(1);
            await expect(page.getByLabel("Host operation status", { exact: true })).toContainText("Runs: 0 pending, 1 completed");
            await input.pressSequentially(" again"); await expect(input).toHaveValue("captured source later again");
            await expect(input).toHaveAttribute("data-retained", "yes");
            expect(await input.evaluate(node => node.ownerDocument.activeElement === node)).toBe(true);
            const after = await page.evaluate(() => window.hostFixture.snapshot());
            expect(after.source.serverVersion).toBe("v0"); expect(after.activity.writes).toBe(0); expect(after.source.dirty).toBe(true);
            expect(after.bindings.mounts).toBe(during.bindings.mounts); expect(after.diagnostics.leases - after.diagnostics.views).toBe(0);
        });

        hostTest("a late Run failure preserves the focused editor while the host reports recovery", async ({ page }) => {
            const input = page.getByRole("textbox", { name: "Primary source", exact: true });
            await input.fill("working"); await page.getByRole("button", { name: "Run captured inputs", exact: true }).click();
            await input.press("End"); await input.pressSequentially(" before failure");
            const before = await page.evaluate(() => window.hostFixture.snapshot());
            await input.evaluate(node => { node.dataset.retained = "yes"; });
            await page.evaluate(() => { window.hostFixture.setPath("updated.csv"); window.hostFixture.failRun(); });
            await expect(page.getByRole("status", { name: "Host messages", exact: true })).toContainText("document is retained");
            expect(await input.evaluate(node => node.ownerDocument.activeElement === node)).toBe(true);
            await input.pressSequentially(" after failure"); await expect(input).toHaveValue("working before failure after failure");
            await expect(input).toHaveAttribute("data-retained", "yes");
            const after = await page.evaluate(() => window.hostFixture.snapshot()); expect(after.bindings.mounts).toBe(before.bindings.mounts);
            expect(after.configuration.revision).toBe(before.configuration.revision + 1); expect(after.pendingRuns).toEqual([]);
        });

        hostTest("forced view removal retains uncommitted composition separately from the document", async ({ page }) => {
            const input = page.getByRole("textbox", { name: "Primary source", exact: true }); await input.fill("alpha omega"); await input.focus();
            const before = await page.evaluate(() => window.hostFixture.snapshot());
            await input.evaluate(node => {
                const input = node as HTMLTextAreaElement; input.setSelectionRange(6, 11); input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
                input.setRangeText("東京", input.selectionStart, input.selectionEnd, "end");
                input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true }));
            });
            await page.getByRole("button", { name: "Toggle views", exact: true }).click(); await expect(input).toHaveCount(0);
            const detached = await page.evaluate(() => window.hostFixture.snapshot());
            expect(detached.source.revision).toBe(before.source.revision); expect(detached.inputRecovery[0]).toMatchObject({ expectedRevision: before.source.revision, reason: "composition-detached" });
            expect(await page.evaluate(() => window.hostFixture.recoveryText())).toBe("alpha 東京");
            await page.getByRole("button", { name: "Toggle views", exact: true }).click(); await expect(input).toHaveValue("alpha omega");
            await page.getByRole("button", { name: "Inspect recovered input", exact: true }).click(); await expect(page.locator('section[aria-label="Input recovery"] pre')).toHaveText("alpha 東京");
        });

        if (editor === "candidate") hostTest("synthetic composition survives independent form/progress updates and a Run error", async ({ page }) => {
            const input = page.getByRole("textbox", { name: "Primary source", exact: true });
            await input.fill("alpha omega"); await page.getByRole("button", { name: "Run captured inputs", exact: true }).click();
            await input.focus();
            await input.evaluate(node => {
                const input = node as HTMLTextAreaElement; input.setSelectionRange(6, 11);
                input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
                input.setRangeText("東京", input.selectionStart, input.selectionEnd, "end");
                input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true }));
            });
            const before = await page.evaluate(() => window.hostFixture.snapshot());
            await page.evaluate(() => { window.hostFixture.setPath("during.csv"); window.hostFixture.failRun(); });
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().activity.errors)).toBeGreaterThan(0);
            expect(await input.evaluate(node => node.ownerDocument.activeElement === node)).toBe(true);
            expect((await page.evaluate(() => window.hostFixture.snapshot())).source.revision).toBe(before.source.revision);
            await input.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "東京" })));
            await expect(input).toHaveValue("alpha 東京");
            const after = await page.evaluate(() => window.hostFixture.snapshot());
            expect(after.source.revision).toBe(before.source.revision + 1); expect(after.bindings.mounts).toBe(before.bindings.mounts);
            expect(after.bindings.views.find(view => view.id === "primary")!.metrics!.composing).toBe(false);
            await input.press("Control+z"); await expect(input).toHaveValue("alpha omega");
        });

        if (editor === "candidate") hostTest("a large source completes propose/correct/save/acknowledge/next-request through bounded views", async ({ page }) => {
            const original = "const sample = '😀 é';\r\n".repeat(100000).trimEnd();
            await page.evaluate(text => { const s = window.hostFixture.snapshot(); window.hostFixture.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, original);
            const input = page.getByRole("textbox", { name: "Primary source", exact: true });
            await input.press("Control+Home"); await input.pressSequentially("human ");
            const before = await page.evaluate(() => window.hostFixture.snapshot()); expect(before.source.exports).toBe(0);
            await page.getByRole("button", { name: "Associate agent", exact: true }).click();
            await page.getByRole("button", { name: "Request proposal", exact: true }).click();
            expect((await page.evaluate(() => window.hostFixture.snapshot())).requestInput!.sourceLength).toBe(original.length + 6);
            await page.evaluate(() => window.hostFixture.setPath("changed-during-request.csv"));
            await page.evaluate(text => window.hostFixture.deliverProposal(text), `agent ${original}`);
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().review.proposal !== null)).toBe(true);
            await input.press("Control+Home"); await input.pressSequentially("fixed ");
            const corrected = `fixed agent ${original}`;
            await page.getByRole("button", { name: "Save source", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().pendingSaves.length)).toBe(1);
            await input.press("Control+End"); await input.pressSequentially(" later");
            await page.evaluate(() => window.hostFixture.finishSave());
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().review.acknowledgements.length)).toBe(1);
            expect(await input.evaluate(node => node.ownerDocument.activeElement === node)).toBe(true);
            await input.press("Control+z");
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().source.dirty)).toBe(false);
            await input.press("Control+Shift+z");
            await page.getByRole("button", { name: "Retry acknowledgement", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().review.acknowledgements[0]?.status)).toBe("failed");
            await page.getByRole("button", { name: "Retry acknowledgement", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().review.proposal)).toBeNull();
            await expect(page.getByRole("group", { name: "Source review", exact: true })).toHaveAttribute("data-status", "ready");
            expect(await page.evaluate(expected => { for (let from = 0; from < expected.length; from += 32768) if (window.hostFixture.range(from, Math.min(expected.length, from + 32768)) !== expected.slice(from, from + 32768)) return false; return true; }, `${corrected} later`)).toBe(true);
            const after = await page.evaluate(() => window.hostFixture.snapshot());
            expect(after.source.id).toBe(before.source.id); expect(after.bindings.mounts).toBe(before.bindings.mounts);
            expect(after.bindings.views.every(view => view.metrics!.inputUnits < 2600)).toBe(true);
            expect(after.bindings.comparison!.input.inputUnits).toBeLessThan(2600);
            expect(after.bindings.comparison!.workingViewport.rows).toBeLessThan(100);
            expect(after.bindings.comparison!.referenceViewport!.rows).toBeLessThan(100);
            expect(after.bindings.comparison!.baseline!.length).toBe(original.length + 6);
            expect(after.source.exports).toBe(0); expect(after.source.serverVersion).toBe("v1");
            await page.getByRole("button", { name: "Request proposal", exact: true }).click();
            const next = await page.evaluate(() => window.hostFixture.snapshot()); expect(next.requestInput!.sourceLength).toBe(corrected.length + 6);
            expect(next.requestInput!.configurationRevision).toBe(next.configuration.revision);
            await page.evaluate(() => window.hostFixture.dispose());
            expect((await page.evaluate(() => window.hostFixture.snapshot())).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
        });

        if (editor === "candidate") hostTest("an agent takeover retains rejected composition in host recovery across remount", async ({ page }) => {
            const input = page.getByRole("textbox", { name: "Primary source", exact: true });
            await input.fill("alpha omega"); await page.getByRole("button", { name: "Associate agent", exact: true }).click(); await input.focus();
            const before = await page.evaluate(() => window.hostFixture.snapshot());
            await input.evaluate(node => {
                const input = node as HTMLTextAreaElement; input.setSelectionRange(6, 11); input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
                input.setRangeText("東京", input.selectionStart, input.selectionEnd, "end");
                input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true }));
            });
            await page.getByRole("button", { name: "Request proposal", exact: true }).click();
            await input.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "東京" })));
            const rejected = await page.evaluate(() => window.hostFixture.snapshot());
            expect(rejected.source.revision).toBe(before.source.revision); expect(rejected.inputRecovery).toHaveLength(1);
            expect(rejected.inputRecovery[0]).toMatchObject({ documentId: before.bindings.views.find(view => view.id === "primary")!.documentId, expectedRevision: before.source.revision, reason: "edit-locked", contextFrom: 0 });
            expect(JSON.stringify(rejected)).not.toContain("東京");
            expect(await page.evaluate(() => window.hostFixture.recoveryText())).toBe("alpha 東京");
            await page.getByRole("button", { name: "Deliver proposal", exact: true }).click(); await expect(input).toHaveValue("agent proposal");
            await page.getByRole("button", { name: "Inspect recovered input", exact: true }).click();
            await expect(page.locator('section[aria-label="Input recovery"] pre')).toHaveText("alpha 東京");
            await page.evaluate(() => window.hostFixture.unmount()); await page.evaluate(() => window.hostFixture.mount());
            await expect(page.locator('section[aria-label="Input recovery"] pre')).toHaveText("alpha 東京");
            await expect(input).toHaveValue("agent proposal");
            const revision = (await page.evaluate(() => window.hostFixture.snapshot())).source.revision;
            await page.getByRole("button", { name: "Discard recovered input", exact: true }).click();
            expect(await page.evaluate(() => window.hostFixture.recoveryText())).toBeNull();
            expect((await page.evaluate(() => window.hostFixture.snapshot())).source.revision).toBe(revision);
        });

        hostTest("two saves retain a newer proposal through old acknowledgement retry and survive agent service failure", async ({ page }) => {
            const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
            await page.getByRole("button", { name: "Associate agent", exact: true }).click();
            await page.getByRole("button", { name: "Request proposal", exact: true }).click();
            await page.getByRole("button", { name: "Fail agent service", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().review.lastResult)).toBe("failed");
            await expect(primary).toHaveValue("start");
            await page.getByRole("button", { name: "Request proposal", exact: true }).click();
            await page.getByRole("button", { name: "Deliver proposal", exact: true }).click();
            await expect(primary).toHaveValue("agent proposal"); await primary.fill("first correction");
            await page.getByRole("button", { name: "Save source", exact: true }).click();
            await page.getByRole("button", { name: "Offer newer proposal", exact: true }).click();
            await expect(primary).toHaveValue("newer agent proposal"); await primary.fill("second correction");
            await page.getByRole("button", { name: "Save source", exact: true }).click();
            await primary.press("End"); await primary.pressSequentially(" later");
            await page.getByRole("button", { name: "Move primary view", exact: true }).click();
            await page.getByRole("button", { name: "Finish save", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().pendingSaves[0]?.length)).toBe("second correction".length);
            await page.getByRole("button", { name: "Finish save", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().review.acknowledgements.length)).toBe(2);
            await page.getByRole("button", { name: "Retry acknowledgement", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().review.acknowledgements[0]?.status)).toBe("failed");
            await page.getByRole("button", { name: "Retry acknowledgement", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().review.acknowledgements.length)).toBe(1);
            expect((await page.evaluate(() => window.hostFixture.snapshot())).review.proposal?.target.revision).toBe(2);
            await page.getByRole("button", { name: "Retry acknowledgement", exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().review.proposal)).toBeNull();
            await expect(primary).toHaveValue("second correction later");
            expect((await page.evaluate(() => window.hostFixture.snapshot())).activity).toMatchObject({ writes: 2, ackAttempts: 3, acknowledgements: 2 });
        });
    });
}

for (const editor of ["native", "candidate"] as const) {
test(`React ${editor} root error callbacks retain resources and recover through an explicit host lifecycle`, async ({ page }) => {

    await page.goto(`/hosts/react/?editor=${editor}`);
    const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
    await primary.fill("unsaved before failure");
    const before = await page.evaluate(() => window.hostFixture.snapshot());
    await page.getByRole("button", { name: "Inject form error", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().activity.errors)).toBeGreaterThan(0);
    await expect(primary).toHaveCount(0);
    expect((await page.evaluate(() => window.hostFixture.snapshot())).diagnostics.subscriptions).toBe(4); // Source document/metadata, connection and transfer recovery observers.
    await page.getByRole("button", { name: "Recover views", exact: true }).click();
    await expect(primary).toHaveValue("unsaved before failure");
    const after = await page.evaluate(() => window.hostFixture.snapshot());
    expect(after.source.id).toBe(before.source.id); expect(after.source.revision).toBe(before.source.revision);
    expect(after.bindings.activeViews).toBe(2);
    await page.evaluate(() => window.hostFixture.dispose());
    expect((await page.evaluate(() => window.hostFixture.snapshot())).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
    expect((await page.evaluate(() => window.hostFixture.snapshot())).hostSubscriptions).toBe(0);
});

test(`React ${editor} explicit mount returns only after stable refs and Strict Mode replay are ready`, async ({ page }) => {
    await page.goto(`/hosts/react/?editor=${editor}`); await page.waitForFunction(() => window.hostFixture?.ready);
    expect(await page.evaluate(() => {
        window.hostFixture.unmount(); window.hostFixture.mount();
        return { inputs: document.querySelectorAll('textarea[aria-label="Primary source"],textarea[aria-label="Secondary source"]').length, views: window.hostFixture.snapshot().bindings.activeViews };
    })).toEqual({ inputs: 2, views: 2 });
    const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
    await primary.fill("first input after mount");
    expect((await page.evaluate(() => window.hostFixture.snapshot())).source.revision).toBe(1);
    await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
    await expect(primary).toHaveValue("first input after mount");
});
}

for (const editor of ["native", "candidate"] as const) for (const mode of ["plain", "react"] as const) {
    test(`${mode} ${editor} native status reset preserves captured Run progress, later typing and shared history`, async ({ page }) => {
        await page.goto(`/hosts/${mode}/?editor=${editor}`);
        const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
        const status = page.getByLabel("Host operation status", { exact: true });
        await primary.press("End"); await primary.pressSequentially(" human");
        await page.getByRole("textbox", { name: "Configuration path", exact: true }).fill("status-reset.csv");
        const before = await page.evaluate(() => window.hostFixture.snapshot());
        await status.evaluate(node => {
            // Associate only the output so this checks its native reset independently of input reset policy.
            const form = document.createElement("form"); form.id = "host-status-reset"; document.body.append(form);
            node.setAttribute("form", form.id); form.reset();
        });
        const reset = await page.evaluate(() => window.hostFixture.snapshot());
        expect(reset.source.revision).toBe(before.source.revision); expect(reset.history).toEqual(before.history);
        await page.getByRole("button", { name: "Run captured inputs", exact: true }).click();
        await expect(status).toContainText("Runs: 1 pending, 0 completed");
        expect(await page.evaluate(() => window.hostFixture.runCapture(0))).toMatchObject({ source: "start human" });
        await primary.press("End"); await primary.pressSequentially(" later");
        const typed = await page.evaluate(() => window.hostFixture.snapshot());
        await page.getByRole("button", { name: "Finish run", exact: true }).click();
        await expect(status).toContainText("Runs: 0 pending, 1 completed");
        expect((await page.evaluate(() => window.hostFixture.snapshot())).history).toEqual(typed.history);
        await expect(primary).toHaveValue("start human later");
        expect(await page.evaluate(() => window.hostFixture.range(0, 17))).toBe("start human later");
        await primary.press("Control+z"); await expect(primary).toHaveValue("start human");
        await primary.press("Control+Shift+z"); await expect(primary).toHaveValue("start human later");
        await page.evaluate(() => window.hostFixture.dispose());
        const disposed = await page.evaluate(() => window.hostFixture.snapshot());
        expect(disposed.diagnostics.views).toBe(0); expect(disposed.diagnostics.leases).toBe(0);
        expect(disposed.diagnostics.subscriptions).toBe(0); expect(disposed.hostSubscriptions).toBe(0);
    });
}
