import { ready, test, expect } from "./fixtures.ts";
import type { Page, Worker as BrowserWorker } from "@playwright/test";
const snapshot = (p: Page) => p.evaluate(() => window.hostFixture.snapshot());
const button = (p: Page, name: string) => p.getByRole("button", { name, exact: true });
const input = (p: Page, reference = true) => p.getByRole("textbox", { name: reference ? "Comparison baseline source" : "Comparison working source", exact: true });
const query = (p: Page) => p.getByRole("textbox", { name: "Find source", exact: true });
const flag = (p: Page, name: string) => p.getByRole("checkbox", { name, exact: true });
async function waitForReview(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (s.bindings.comparison !== null); });
}
async function found(p: Page, count: number): Promise<void> { await expect(p.getByLabel("Find status", { exact: true })).toContainText(`${count} matches · ready`); await waitForReview(p); }
async function setup(p: Page, host: string, raw: string): Promise<void> {
    await p.addInitScript(() => {
        const Original = window.Worker; let sequence = 0;
        window.heldReferenceMatches = [];
        window.Worker = class extends Original {
            constructor(url: string | URL, options?: WorkerOptions) {
                const regex = String(url).endsWith("/regex-worker.js"), name = regex ? `reference-find-${++sequence}` : options?.name;
                super(url, { ...options, ...(name === undefined ? {} : { name }) });
                if (regex) this.addEventListener("message", e => {
                    if (window.holdReferenceMatches && typeof e.data === "string" && JSON.parse(e.data).operation === "regex-matches") {
                        e.stopImmediatePropagation(); window.heldReferenceMatches!.push({ worker: this, name: name!, data: e.data });
                    }
                }, { capture: true });
            }
        };
    });
    await p.goto(`/hosts/${host}/?editor=candidate`);
    await p.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, raw);
    for (const name of ["Open source review", "Capture review acceptance", "Finish review acceptance"]) { await button(p, name).click(); await waitForReview(p); }
}
async function exact(p: Page, text: string, reference = false): Promise<void> { expect(await p.evaluate(({ text, reference }) => { const f = window.hostFixture, s = f.snapshot(), length = reference ? s.bindings.comparison!.baseline!.length : s.source.length; if (length !== text.length) return false; for (let from = 0; from < text.length; from += 32768) if ((reference ? f.referenceRange(from, Math.min(length, from + 32768)) : f.range(from, Math.min(length, from + 32768))) !== text.slice(from, from + 32768)) return false; return true; }, { text, reference })).toBe(true); }
async function dispose(p: Page): Promise<void> { await p.evaluate(() => window.hostFixture.dispose()); const s = await snapshot(p); expect(s.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(s.hostSubscriptions).toBe(0); await expect.poll(() => p.workers().length).toBe(0); }
async function referenceCase(p: Page, host: string, large: boolean) {
    const n = large ? 100000 : 900, header = "café😀 é;\r\n", rows = Array.from({ length: n }, (_, i) => `row${i.toString().padStart(6, "0")}:needle needleX NEEDLE\r\n`), raw = header + rows.join(""), prefix = "working-only\r\n";
    await setup(p, host, raw);
    await p.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: text }]); }, prefix);
    await waitForReview(p);
    await flag(p, "Align review rows").check();
    await waitForReview(p);
    return { n, raw, prefix };
}
async function selectLastReferenceMatch(p: Page, n: number): Promise<void> {
    await input(p).press("Control+f");
    await flag(p, "Whole word").check();
    await flag(p, "Match case").uncheck();
    await query(p).fill(`row${(n - 1).toString().padStart(6, "0")}:needle`);
    await found(p, 1); await query(p).press("Enter"); await waitForReview(p);
}

for (const host of ["plain", "react"]) for (const large of [false, true]) {
    test(`${host} ${large ? "100k" : "normal"} reference Find preserves raw ranges, read-only controls and aligned navigation`, async ({ page: p }) => {
        test.setTimeout(120000);
        const { n, raw, prefix } = await referenceCase(p, host, large);
        const before = await snapshot(p), providers = before.bindings.language.sessions.map(s => s.provider.posted), first = raw.indexOf("needle"), second = raw.indexOf("needle", first + 1);
        await input(p).press("Control+Home");
        await input(p).press("Control+f");
        await expect(query(p)).toBeFocused();
        await query(p).fill("needle");
        await found(p, n * 2);
        let s = await snapshot(p);
        expect(s.bindings.language.active).toBe("reference");
        expect(s.bindings.language.referenceFind).toHaveLength(1);
        expect(s.bindings.language.sessions.map(s => s.provider.posted)).toEqual(providers);
        await expect(p.getByRole("textbox", { name: "Replacement", exact: true })).toBeDisabled();
        await expect(button(p, "Replace current")).toBeDisabled();
        await expect(button(p, "Replace all")).toBeDisabled();
        await expect(button(p, "Request completion")).toBeDisabled();
        for (const name of ["Replace current", "Replace all"])
            await button(p, name).evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
        expect((await snapshot(p)).history).toEqual(before.history);
        await exact(p, raw, true);
        await exact(p, prefix + raw);
        await query(p).press("Enter");
        await waitForReview(p);
        expect((await snapshot(p)).bindings.comparison!.referenceViewport!.selection).toMatchObject({ anchor: first, head: first + 6 });
        await flag(p, "Match case").press("F3");
        await waitForReview(p);
        expect((await snapshot(p)).bindings.comparison!.referenceViewport!.selection).toMatchObject({ anchor: second, head: second + 6 });
        await button(p, "Find previous").press("Shift+F3");
        await waitForReview(p);
        expect((await snapshot(p)).bindings.comparison!.referenceViewport!.selection!.anchor).toBe(first);
        await query(p).press("F3");
        await waitForReview(p);
        expect((await snapshot(p)).bindings.comparison!.referenceViewport!.selection!.anchor).toBe(second);
        await query(p).press("Shift+Enter");
        await waitForReview(p);
        expect((await snapshot(p)).bindings.comparison!.referenceViewport!.selection!.anchor).toBe(first);
        await button(p, "Find next").press("Enter");
        await waitForReview(p);
        expect((await snapshot(p)).bindings.comparison!.referenceViewport!.selection!.anchor).toBe(second);
        await button(p, "Find previous").press("Enter");
        await waitForReview(p);
        expect((await snapshot(p)).bindings.comparison!.referenceViewport!.selection!.anchor).toBe(first);
        await flag(p, "Whole word").press("Control+h");
        await expect(query(p)).toBeFocused();
        await button(p, "Find next").press("Control+f");
        await expect(query(p)).toBeFocused();
        expect(await query(p).evaluate(n => n instanceof HTMLInputElement && n.selectionStart === 0 && n.selectionEnd === n.value.length)).toBe(true);
        await query(p).press("Escape");
        await expect(input(p)).toBeFocused();
        await input(p).press("Control+Home");
        await input(p).press("Shift+F3");
        await found(p, n * 2);
        await expect.poll(async () => (await snapshot(p)).bindings.comparison!.referenceViewport!.selection!.anchor).toBe(raw.lastIndexOf("needle"));
        expect((await snapshot(p)).bindings.language.navigationPending).toBe(false);
        await expect.poll(() => p.locator(".st-comparison-panes > section").first().locator(".st-search-match").count()).toBeGreaterThan(0);
        await input(p).press("Control+f");
        await found(p, n * 2);
        await flag(p, "Whole word").check();
        await found(p, n);
        await flag(p, "Match case").uncheck();
        await found(p, n * 2);
        const target = `row${(n - 1).toString().padStart(6, "0")}:needle`, at = raw.indexOf(target);
        await query(p).fill(target);
        await found(p, 1);
        await query(p).press("Enter");
        await waitForReview(p);
        s = await snapshot(p);
        expect(s.bindings.comparison!.referenceViewport!.selection).toMatchObject({ anchor: at, head: at + target.length });
        expect(s.bindings.comparison!.selectionSet).toEqual(before.bindings.comparison!.selectionSet);
        expect(Math.abs(s.bindings.comparison!.referenceViewport!.scrollTop - s.bindings.comparison!.workingViewport.scrollTop)).toBeLessThan(1);
        expect(s.history).toEqual(before.history);
        expect(s.source.exports).toBe(0);
        expect(s.bindings.comparison!.baseline!.exports).toBe(0);
        expect(s.bindings.comparison!.referenceViewport!.rows).toBeLessThan(100);
        await exact(p, raw, true);
        await exact(p, prefix + raw);
        await dispose(p);
    });

    test(`${host} ${large ? "100k" : "normal"} working Find survives remount and owns deferred regex replacement with shared undo`, async ({ page: p }) => {
        test.setTimeout(120000);
        const { n, raw, prefix } = await referenceCase(p, host, large);
        await selectLastReferenceMatch(p, n);
        await input(p, false).press("Control+f");
        await expect(query(p)).toBeFocused();
        await query(p).fill("working-only");
        await found(p, 1);
        const replacement = p.getByRole("textbox", { name: "Replacement", exact: true });
        await expect(replacement).toBeEnabled();
        await replacement.fill("changed-only");
        const workingFind = await snapshot(p);
        await p.evaluate(() => { const f = window.hostFixture; f.unmount(); f.mount(); });
        await waitForReview(p);
        const s = await snapshot(p);
        expect(s.bindings.language.active).toBe("comparison");
        expect(s.bindings.comparison!.selectionSet).toEqual(workingFind.bindings.comparison!.selectionSet);
        expect(s.history).toEqual(workingFind.history);
        await expect(input(p, false)).not.toBeFocused();
        await query(p).fill("WORKING-ONLY");
        await found(p, 1);
        await expect(replacement).toBeEnabled();
        await input(p, false).press("Control+Home");
        await flag(p, "Regular expression").check();
        await found(p, 1);
        const beforeReplacement = await snapshot(p);
        await p.evaluate(() => { window.holdReferenceMatches = true; });
        await query(p).fill("WORKING-ONLY|not-present");
        await p.waitForFunction(() => !!window.heldReferenceMatches?.length);
        await replacement.press("Enter");
        await replacement.press("Enter");
        expect((await snapshot(p)).bindings.language.findCommandPending).toBe("replace");
        expect((await snapshot(p)).source.revision).toBe(beforeReplacement.source.revision);
        await p.evaluate(() => { window.holdReferenceMatches = false; for (const { worker, data } of window.heldReferenceMatches!)
            worker.dispatchEvent(new MessageEvent("message", { data })); window.heldReferenceMatches = []; });
        await expect.poll(() => p.evaluate(() => window.hostFixture.range(0, 12))).toBe("changed-only");
        await waitForReview(p);
        expect((await snapshot(p)).history.undoDepth).toBe(beforeReplacement.history.undoDepth + 1);
        expect((await snapshot(p)).bindings.language.findCommandPending).toBeNull();
        await exact(p, "changed-only\r\n" + raw);
        await p.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+z");
        await waitForReview(p);
        await exact(p, prefix + raw);
        await flag(p, "Regular expression").uncheck();
        await exact(p, raw, true);
        await dispose(p);
    });

    test(`${host} ${large ? "100k" : "normal"} reference Find survives remount while Save and Run retain working captures and history`, async ({ page: p }) => {
        test.setTimeout(120000);
        const { n, raw, prefix } = await referenceCase(p, host, large);
        await selectLastReferenceMatch(p, n);
        const replacement = p.getByRole("textbox", { name: "Replacement", exact: true });
        await input(p, false).press("Control+End");
        await input(p, false).pressSequentially("K");
        await waitForReview(p);
        await exact(p, prefix + raw + "K");
        await input(p).press("Control+f");
        await query(p).fill("needle");
        await found(p, n * 2);
        const mounted = await snapshot(p);
        await p.evaluate(() => { const f = window.hostFixture; f.unmount(); f.mount(); f.unmount(); f.mount(); });
        await waitForReview(p);
        let s = await snapshot(p);
        expect(s.bindings.language.referenceFind).toHaveLength(1);
        expect(s.bindings.comparison!.referenceViewport!.selectionSet).toEqual(mounted.bindings.comparison!.referenceViewport!.selectionSet);
        expect(s.history).toEqual(mounted.history);
        expect(s.bindings.language.active).toBe("reference");
        expect(s.bindings.language.referenceFind[0]!.find).toBeNull();
        await expect(input(p)).not.toBeFocused();
        await query(p).fill("NEEDLE");
        await found(p, n * 2);
        await expect(replacement).toBeDisabled();
        await query(p).press("Enter");
        await waitForReview(p);
        s = await snapshot(p);
        const selectedReference = s.bindings.comparison!.referenceViewport!.selection!;
        expect(raw.slice(Math.min(selectedReference.anchor, selectedReference.head), Math.max(selectedReference.anchor, selectedReference.head)).toLowerCase()).toBe("needle");
        expect(s.bindings.comparison!.selectionSet).toEqual(mounted.bindings.comparison!.selectionSet);
        expect(s.history).toEqual(mounted.history);
        const saveControl = host === "plain" ? large ? button(p, "Find next") : flag(p, "Match case") : large ? flag(p, "Regular expression") : query(p);
        const beforeExit = await snapshot(p);
        await saveControl.press("Escape");
        await waitForReview(p);
        await expect(input(p)).toBeFocused();
        s = await snapshot(p);
        expect(s.bindings.comparison!.referenceViewport!.selectionSet).toEqual(beforeExit.bindings.comparison!.referenceViewport!.selectionSet);
        expect(s.bindings.comparison!.selectionSet).toEqual(beforeExit.bindings.comparison!.selectionSet);
        expect(s.history).toEqual(beforeExit.history);
        expect(s.source.revision).toBe(beforeExit.source.revision);
        expect(s.bindings.language.referenceFind[0]!.find!.status).toBe("cancelled");
        await input(p).press("Control+f");
        await found(p, n * 2);
        await saveControl.focus();
        await p.keyboard.down("Control");
        await p.keyboard.down("s");
        await p.keyboard.down("s");
        await p.keyboard.down("s");
        await p.keyboard.up("s");
        await p.keyboard.up("Control");
        await expect(saveControl).toBeFocused();
        s = await snapshot(p);
        expect(s.pendingSaves).toHaveLength(1);
        const captured = s.pendingSaves[0]!;
        expect(captured.revision).toBe(s.source.revision);
        expect(captured.length).toBe(prefix.length + raw.length + 1);
        await input(p, false).press("Control+End");
        await input(p, false).pressSequentially("L");
        await waitForReview(p);
        await button(p, "Finish save").click();
        await waitForReview(p);
        expect((await snapshot(p)).source.dirty).toBe(true);
        await exact(p, prefix + raw + "KL");
        await p.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+z");
        await waitForReview(p);
        await exact(p, prefix + raw + "K");
        expect((await snapshot(p)).source.dirty).toBe(false);
        await p.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+Shift+z");
        await waitForReview(p);
        await exact(p, prefix + raw + "KL");
        await input(p).focus();
        await button(p, "Run captured inputs").click();
        expect((await snapshot(p)).activity.lastRun!.sourceRevision).toBe((await snapshot(p)).source.revision);
        await button(p, "Finish run").click();
        await exact(p, raw, true);
        await exact(p, prefix + raw + "KL");
        await dispose(p);
    });
}
declare global { interface Window { holdReferenceMatches?: boolean; heldReferenceMatches?: { worker: Worker; name: string; data: string }[] } }
async function heldRegexWorker(p: Page): Promise<BrowserWorker> {
    const name = await p.evaluate(() => window.heldReferenceMatches!.at(-1)!.name);
    // Changed search intent can terminate an earlier worker before the view is refreshed.
    for (const worker of p.workers()) if (worker.url().endsWith("/regex-worker.js") && await worker.evaluate(() => self.name) === name) return worker;
    throw new Error("The held regex reply has no live worker.");
}
async function regexCase(p: Page, host: string, retainHistory = false): Promise<string> {
    const raw = "café😀 needle NEEDLE needleX\r\n".repeat(2000);
    await setup(p, host, raw);
    if (retainHistory) {
        // Preserve the redo entry formerly created by the edit-cancellation arm of the composite journey.
        await p.evaluate(() => { const f = window.hostFixture, s = f.snapshot();
            f.editSource(s.source.revision, [{ from: s.source.length, to: s.source.length, insert: " guard" }]); });
        await p.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+z");
        await waitForReview(p); await exact(p, raw);
    }
    await input(p).press("Control+f");
    await query(p).fill("\\b(?:needle|NEEDLE)\\b");
    await flag(p, "Regular expression").check();
    await found(p, 4000);
    return raw;
}
async function refreshedRegexCase(p: Page, host: string): Promise<{ raw: string; refreshed: string }> {
    const raw = await regexCase(p, host, true);
    await p.evaluate(() => { for (const name of ["Capture reference refresh", "Finish reference refresh"]) {
        const button = [...document.querySelectorAll("button")].find(n => n.textContent === name);
        if (!button)
            throw new Error("Missing refresh control.");
        button.click();
    } });
    await waitForReview(p); await query(p).focus();
    const refreshed = await p.evaluate(() => { const f = window.hostFixture; return f.referenceRange(0, f.snapshot().bindings.comparison!.baseline!.length)!; });
    return { raw, refreshed };
}

for (const host of ["plain", "react"]) {
    test(`${host} reference regex queues the latest navigation intent until its real worker replies`, async ({ page: p }) => {
        test.setTimeout(120000);
        const raw = await regexCase(p, host);
        await expect(button(p, "Replace all")).toBeDisabled();
        await query(p).press("Enter");
        await waitForReview(p);
        expect((await snapshot(p)).bindings.comparison!.referenceViewport!.selection!.anchor).toBe(raw.indexOf("needle"));
        await p.evaluate(() => { window.holdReferenceMatches = true; });
        await input(p).press("Control+Home");
        await input(p).press("Control+f");
        await query(p).fill("needle|not-here");
        await p.waitForFunction(() => !!window.heldReferenceMatches?.length);
        await query(p).press("Enter");
        expect((await snapshot(p)).bindings.language.navigationPending).toBe(true);
        await query(p).press("Enter");
        await query(p).press("Shift+Enter");
        expect((await snapshot(p)).bindings.language.navigationPending).toBe(true);
        await expect(query(p)).toBeFocused();
        await p.evaluate(() => { window.holdReferenceMatches = false; for (const { worker, data } of window.heldReferenceMatches!)
            worker.dispatchEvent(new MessageEvent("message", { data })); window.heldReferenceMatches = []; });
        await found(p, 4000);
        await expect(query(p)).toBeFocused();
        expect((await snapshot(p)).bindings.comparison!.referenceViewport!.selection!.anchor).toBe(raw.lastIndexOf("needle"));
        expect((await snapshot(p)).bindings.language.navigationPending).toBe(false);
        await exact(p, raw);
        await exact(p, raw, true);
        await dispose(p);
    });

    for (const arm of ["blur", "query", "options", "selection", "edit", "composition", "disabled", "cancel", "replacement", "permission", "transient-disabled"] as const) {
        test(`${host} queued working Find replacement expires after ${arm}`, async ({ page: p }) => {
            test.setTimeout(120000);
            const raw = await regexCase(p, host, true);
            await p.evaluate(() => { document.querySelectorAll("[data-navigation-focus]").forEach(n => n.removeAttribute("data-navigation-focus")); window.holdReferenceMatches = true; });
            await input(p, false).press("Control+Home");
            await input(p, false).press("Control+f");
            await query(p).fill("\\b(?:needle|NEEDLE)\\b|missing-" + arm);
            await p.waitForFunction(() => !!window.heldReferenceMatches?.length);
            const field = p.getByRole("textbox", { name: "Replacement", exact: true });
            await field.fill("guard");
            await field.press("Enter");
            expect((await snapshot(p)).bindings.language.findCommandPending).toBe("replace");
            if (arm === "blur") {
                await p.getByRole("textbox", { name: "Configuration path", exact: true }).focus();
                await field.focus();
            }
            else if (arm === "query")
                await query(p).fill("\\b(?:needle|NEEDLE)\\b|another");
            else if (arm === "options")
                await flag(p, "Match case").evaluate(n => { if (n instanceof HTMLInputElement)
                    n.click(); });
            else if (arm === "selection")
                await p.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("comparison", f.snapshot().source.revision, [{ anchor: 3, head: 5 }, { anchor: 7, head: 9 }], 1); });
            else if (arm === "edit")
                await p.evaluate(() => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: s.source.length, to: s.source.length, insert: " guard" }]); });
            else if (arm === "composition")
                await field.evaluate(n => n.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
            else if (arm === "disabled")
                await field.evaluate(n => { if (n instanceof HTMLInputElement)
                    n.disabled = true; });
            else if (arm === "transient-disabled")
                await field.evaluate(n => { if (n instanceof HTMLInputElement) {
                    n.disabled = true;
                    n.disabled = false;
                } });
            else if (arm === "replacement")
                await field.fill("guard revised");
            else if (arm === "permission")
                await p.evaluate(() => { const f = window.hostFixture, id = f.snapshot().bindings.language.sessions.find(s => s.id === "comparison")!.documentId; f.setProjectTargetReadOnly(id, true); f.setProjectTargetReadOnly(id, false); });
            else
                await field.press("Escape");
            const retained = await snapshot(p);
            await p.evaluate(() => document.activeElement?.setAttribute("data-navigation-focus", "expected"));
            await p.evaluate(() => { window.holdReferenceMatches = false; for (const { worker, data } of window.heldReferenceMatches!)
                worker.dispatchEvent(new MessageEvent("message", { data })); window.heldReferenceMatches = []; });
            if (arm !== "cancel")
                await found(p, 4000);
            else
                await waitForReview(p);
            const settled = await snapshot(p);
            expect(settled.bindings.language.findCommandPending).toBeNull();
            expect(settled.bindings.comparison!.selectionSet).toEqual(retained.bindings.comparison!.selectionSet);
            expect(settled.history).toEqual(retained.history);
            expect(settled.source.revision).toBe(retained.source.revision);
            expect(await p.evaluate(disabled => document.activeElement?.getAttribute("data-navigation-focus") === "expected" || disabled && document.activeElement === document.body, (arm === "disabled" || arm === "transient-disabled"))).toBe(true);
            if (arm === "disabled")
                await field.evaluate(n => { if (n instanceof HTMLInputElement)
                    n.disabled = false; });
            if (arm === "composition")
                await field.evaluate(n => n.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
            if (arm === "edit") {
                await p.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+z");
                await waitForReview(p);
                await exact(p, raw);
            }
            await exact(p, raw);
            await exact(p, raw, true);
            await dispose(p);
        });
    }

    test(`${host} reference refresh retains the query and rejects queued navigation from the old revision`, async ({ page: p }) => {
        test.setTimeout(120000);
        const raw = await regexCase(p, host, true);
        await input(p, false).press("Control+Home"); await input(p, false).press("Control+f");
        await query(p).fill("\\b(?:needle|NEEDLE)\\b|pending-refresh"); await found(p, 4000);
        await flag(p, "Match case").check();
        await found(p, 4000);
        await p.evaluate(() => { window.holdReferenceMatches = true; });
        await input(p).press("Control+f");
        await p.waitForFunction(() => window.heldReferenceMatches?.length === 1);
        await query(p).fill("\\b(?:needle|NEEDLE)\\b|nomatch");
        await p.waitForFunction(() => window.heldReferenceMatches?.length === 2);
        await query(p).press("Shift+Enter");
        expect((await snapshot(p)).bindings.language.navigationPending).toBe(true);
        const before = await snapshot(p), oldView = before.bindings.language.referenceFind[0]!.viewId;
        await p.evaluate(() => { for (const name of ["Capture reference refresh", "Finish reference refresh"]) {
            const button = [...document.querySelectorAll("button")].find(n => n.textContent === name);
            if (!button)
                throw new Error("Missing refresh control.");
            button.click();
        } });

        await waitForReview(p);
        let s = await snapshot(p);
        expect(s.bindings.language.active).toBe("reference");
        expect(s.bindings.language.referenceFind).toHaveLength(1);
        expect(s.bindings.language.referenceFind[0]!.viewId).toBe(oldView);
        expect(s.diagnostics.resources).toBe(before.diagnostics.resources);
        expect(s.diagnostics.documents).toBe(before.diagnostics.documents);
        expect(s.diagnostics.views).toBe(before.diagnostics.views);
        expect(s.diagnostics.leases).toBe(before.diagnostics.leases);
        await p.evaluate(() => { window.holdReferenceMatches = false; for (const { worker, data } of window.heldReferenceMatches!)
            worker.dispatchEvent(new MessageEvent("message", { data })); window.heldReferenceMatches = []; });
        await waitForReview(p);
        s = await snapshot(p);
        expect(s.history).toEqual(before.history);
        expect(s.source.revision).toBe(before.source.revision);
        expect(s.bindings.language.referenceFind[0]!.find).toMatchObject({ query: before.bindings.language.referenceFind[0]!.find!.query, count: 0 });
        await expect(query(p)).toBeFocused();
        expect(s.bindings.language.navigationPending).toBe(false);
        await exact(p, raw);
        await dispose(p);
    });

    test(`${host} refreshed reference Find guards synthetic shortcuts and leaves unrelated form focus intact`, async ({ page: p }) => {
        test.setTimeout(120000);
        const { raw, refreshed } = await refreshedRegexCase(p, host);
        const before = await snapshot(p);
        // Synthetic key guards exercise application policy, not native IME/OS shortcuts.
        const blocked = await query(p).evaluate(node => [{ shiftKey: true }, { altKey: true }, { isComposing: true }, { repeat: true }, { prevented: true }].map(flags => {
            const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true, ...flags });
            if ("prevented" in flags)
                event.preventDefault();
            node.dispatchEvent(event);
            return event.defaultPrevented;
        }));
        expect(blocked).toEqual([false, false, false, true, true]);
        expect((await snapshot(p)).pendingSaves).toEqual([]);
        await p.getByRole("textbox", { name: "Replacement", exact: true }).evaluate(node => node.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })));
        expect((await snapshot(p)).pendingSaves).toEqual([]);
        const disabledChild = await button(p, "Replace all").evaluate(node => { const child = document.createElement("span"); node.append(child); try {
            return ["s", "F3", "Enter"].map(key => { const event = new KeyboardEvent("keydown", { key, ctrlKey: key === "s", bubbles: true, cancelable: true }); child.dispatchEvent(event); return event.defaultPrevented; });
        }
        finally {
            child.remove();
        } });
        expect(disabledChild).toEqual([false, false, false]);
        expect((await snapshot(p)).pendingSaves).toEqual([]);
        const inherited = await query(p).evaluate(node => { if (!(node instanceof HTMLInputElement))
            throw new Error("Expected the Find input."); const parent = node.parentElement!, fieldset = document.createElement("fieldset"); fieldset.disabled = true; parent.insertBefore(fieldset, node); fieldset.append(node); try {
            const prevented = ["s", "F3", "Enter"].map(key => { const event = new KeyboardEvent("keydown", { key, ctrlKey: key === "s", bubbles: true, cancelable: true }); node.dispatchEvent(event); return event.defaultPrevented; });
            return { own: node.disabled, effective: node.matches(":disabled"), prevented };
        }
        finally {
            parent.insertBefore(node, fieldset);
            fieldset.remove();
        } });
        expect(inherited).toEqual({ own: false, effective: true, prevented: [false, false, false] });
        expect((await snapshot(p)).pendingSaves).toEqual([]);
        const outside = p.getByRole("textbox", { name: "Configuration path", exact: true }), path = await outside.inputValue();
        await outside.press("Control+s");
        await outside.press("Escape");
        await expect(outside).toBeFocused();
        expect((await snapshot(p)).pendingSaves).toEqual([]);
        await expect(outside).toHaveValue(path);
        expect((await snapshot(p)).history).toEqual(before.history);
        const freshQuery = refreshed.match(/[A-Za-z]{4,}/)![0];
        await query(p).fill(freshQuery);
        await found(p, 1);
        const s = await snapshot(p);
        expect(s.bindings.language.active).toBe("reference");
        expect(s.bindings.language.referenceFind[0]!.find!.query).toBe(freshQuery);
        await expect(button(p, "Replace all")).toBeDisabled();
        expect(s.history).toEqual(before.history);
        const keyGuards = await query(p).evaluate(node => ["Escape", "F3", "f", "h", "Enter"].flatMap(key => [{ isComposing: true }, { prevented: true }].map(flags => { const event = new KeyboardEvent("keydown", { key, ctrlKey: key === "f" || key === "h", bubbles: true, cancelable: true, ...flags }); if ("prevented" in flags)
            event.preventDefault(); node.dispatchEvent(event); return event.defaultPrevented; })));
        expect(keyGuards).toEqual([false, true, false, true, false, true, false, true, false, true]);
        expect((await snapshot(p)).bindings.language.referenceFind[0]!.find!.status).toBe("ready");
        await expect(query(p)).toBeFocused();
        await exact(p, raw);
        await dispose(p);
    });

    test(`${host} reference remount closes its pending regex worker without reviving navigation`, async ({ page: p }) => {
        test.setTimeout(120000);
        const { raw, refreshed } = await refreshedRegexCase(p, host);
        const before = await snapshot(p);
        const freshQuery = refreshed.match(/[A-Za-z]{4,}/)![0];
        await query(p).fill(freshQuery);
        await found(p, 1);
        await p.evaluate(() => { window.holdReferenceMatches = true; });
        await query(p).fill(freshQuery + "|nomatch");
        await p.waitForFunction(() => !!window.heldReferenceMatches?.length);
        await query(p).press("Enter");
        expect((await snapshot(p)).bindings.language.navigationPending).toBe(true);
        const remountClosed = (await heldRegexWorker(p)).waitForEvent("close", { timeout: 10000 });
        await p.evaluate(() => { const f = window.hostFixture; f.unmount(); f.mount(); });
        await remountClosed;
        await waitForReview(p);
        const s = await snapshot(p);
        expect(s.bindings.language.active).toBe("reference");
        expect(s.bindings.language.referenceFind[0]!.find).toBeNull();
        expect(s.history).toEqual(before.history);
        await p.evaluate(() => { window.holdReferenceMatches = false; for (const { worker, data } of window.heldReferenceMatches!)
            worker.dispatchEvent(new MessageEvent("message", { data })); window.heldReferenceMatches = []; });
        await waitForReview(p);
        expect((await snapshot(p)).bindings.language.referenceFind[0]!.find).toBeNull();
        await query(p).fill(freshQuery);
        await found(p, 1);
        await exact(p, raw);
        await dispose(p);
    });

    test(`${host} Find follows current reference and source views while Save retains only its eligible source`, async ({ page: p }) => {
        test.setTimeout(120000);
        const { raw, refreshed } = await refreshedRegexCase(p, host);
        const freshQuery = refreshed.match(/[A-Za-z]{4,}/)![0];
        await query(p).fill(freshQuery);
        await found(p, 1);
        await button(p, "Capture reference refresh").click();
        await input(p, false).focus();
        await button(p, "Finish reference refresh").click();
        await waitForReview(p);
        let s = await snapshot(p);
        expect(s.bindings.language.active).toBe("comparison");
        expect(s.bindings.language.referenceFind[0]!.find?.query).toBe(freshQuery);
        await query(p).fill("needle");
        await found(p, 4000);
        expect((await snapshot(p)).bindings.language.active).toBe("comparison");
        await p.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+f");
        await found(p, 4000);
        await p.evaluate(() => window.hostFixture.openTransferTarget("different needle"));
        await waitForReview(p);
        expect((await snapshot(p)).bindings.language.active).toBeNull();
        await query(p).fill("different");
        await expect(p.getByLabel("Find status", { exact: true })).toHaveText("Find in the active source view.");
        await exact(p, raw);
        await flag(p, "Whole word").press("Control+s");
        await flag(p, "Whole word").press("Escape");
        await flag(p, "Whole word").press("F3");
        await expect(flag(p, "Whole word")).toBeFocused();
        expect((await snapshot(p)).pendingSaves).toEqual([]);
        await p.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+f");
        await found(p, 1);
        expect((await snapshot(p)).bindings.language.active).toBe("secondary");
        await button(p, "Find next").press("Control+s");
        expect((await snapshot(p)).pendingSaves).toEqual([]);
        await p.getByRole("textbox", { name: "Primary source", exact: true }).press("Control+f");
        await query(p).fill("needle");
        await found(p, 4000);
        const meta = await flag(p, "Whole word").evaluate(node => { const event = new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }); node.dispatchEvent(event); return event.defaultPrevented; });
        expect(meta).toBe(true);
        s = await snapshot(p);
        expect(s.pendingSaves).toHaveLength(1);
        expect(s.pendingSaves[0]!.revision).toBe(s.source.revision);
        await button(p, "Finish save").click();
        await waitForReview(p);
        await exact(p, raw.trimEnd());
        expect((await snapshot(p)).source.dirty).toBe(false);
        await dispose(p);
    });
}
