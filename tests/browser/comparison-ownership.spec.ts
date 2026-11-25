import { test, expect } from "./fixtures.ts";
import { build } from "esbuild";
import { basename } from "node:path";

test.beforeEach(async ({ page }) => {
    // Two evaluations of the browser entry share one core module, like separately loaded views.
    const built = await build({ entryPoints: { core: "src/index.ts", kernels: "src/kernels/index.ts", comparison: "src/browser/comparison.ts", tools: "src/browser/index.ts" }, outdir: "artifacts/comparison-ownership",
        bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", write: false });
    const modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text]));
    await page.route("**/comparison-ownership/**", route => {
        const body = modules.get(new URL(route.request().url()).pathname.split("/").at(-1)!);
        return body === undefined ? route.abort() : route.fulfill({ contentType: "text/javascript", body });
    });
    await page.goto("/comparison/");
});

test("independent comparison modules share workspace identity and release retained baselines after their owners", async ({ page }) => {
    const result = await page.evaluate(async () => {
        const path = "/comparison-ownership/";
        const { Workspace, TextBuffer } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const first = await import(path + "comparison.js?one") as typeof import("../../src/browser/comparison.ts");
        const second = await import(path + "comparison.js?two") as typeof first;
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "test", resource: "source", variant: "working" }, "Working", { value: "working" });
        const tab = workspace.tabs.open({ kind: "text", documentId: source.documentId }, "working"), view = workspace.createDocumentView(source.documentId);
        const host = document.createElement("section"); document.body.append(host);
        const baseline = { buffer: TextBuffer.from("head\n  needle\nend"), version: "one" };
        let hiddenThroughout = true;
        const stopInventory = workspace.subscribe(() => {
            const state = workspace.getSnapshot(), tabs = workspace.tabs.getSnapshot();
            hiddenThroughout &&= state.resources.length === 1 && state.resources[0]!.id === source.id
                && state.documents.length === 1 && state.documents[0]!.id === source.documentId
                && tabs.length === 1 && tabs[0]!.id === tab;
        });
        const one = first.mountTextComparison(host, workspace, tab, baseline, { view, workBudget: 256 });
        const two = second.mountTextComparison(host, workspace, tab, baseline, { view, controls: false });
        const { createFindController, createFoldingController } = await import(path + "tools.js") as typeof import("../../src/browser/index.ts");
        const editor = one.panes.reference, old = workspace.resourceForDocument(editor.view.documentId), oldLease = workspace.acquire(old.id);
        const distinct = old.id !== workspace.resourceForDocument(two.panes.reference.view.documentId).id;
        const internal = old.metadata.getSnapshot().visibility === "internal" && editor.tab === undefined && workspace.diagnostics().tabs === 1;
        const initial = workspace.document(editor.view.documentId), find = createFindController(editor);
        const folds = createFoldingController(editor, document => [{ from: 0, to: document.buffer.offsetAt(2) - 1 }], { delayMs: 0 });
        const wait = async (ready: () => boolean) => {
            const until = performance.now() + 5000;
            while (!ready()) {
                if (performance.now() > until) throw new Error("Reference tools did not settle.");
                await new Promise<void>(resolve => setTimeout(resolve, 10));
            }
        };
        editor.configure({ columnRulers: [72] }); find.setQuery("needle");
        await wait(() => folds.getSnapshot().status === "ready" && find.getSnapshot().count === 1 && one.getSnapshot().canNavigate);
        const defaultWorking = one.activePane() === one.panes.working;
        const folded = editor.commands.run("fold.collapse-all"), activeReference = one.activePane() === editor && editor.getSnapshot().focused;
        const retired = one.hunkAt(0)!, next = initial.buffer.replace(initial.buffer.length, initial.buffer.length, "\nneedle");
        const refresh = (version: string, buffer = next) => one.controller.beginRefresh().complete({ buffer, version });
        if (!refresh("two")) throw new Error("Reference refresh failed.");
        const revision = workspace.document(editor.view.documentId).revision;
        if (!refresh("three", TextBuffer.from(next.text()))) throw new Error("Equal reference refresh failed.");
        if (workspace.document(editor.view.documentId).revision !== revision) throw new Error("Equal refresh changed the text revision.");
        await wait(() => one.getSnapshot().canNavigate && find.getSnapshot().count === 2 && folds.getSnapshot().status === "ready" && folds.getSnapshot().revision === revision);
        await wait(() => !!editor.element.querySelector('.st-fold-summary[data-label*="contains changes"]'));
        const afterRefresh = { stable: one.panes.reference === editor, oldText: initial.text(), text: workspace.document(editor.view.documentId).text(),
            retiredRejected: !retired.select(), rulers: editor.settings().columnRulers, query: find.getSnapshot().query,
            folded, collapsed: folds.getSnapshot().collapsed, defaultWorking, activeReference };
        const current = workspace.resourceForDocument(one.panes.reference.view.documentId), currentLease = workspace.acquire(current.id);
        one.dispose(); one.dispose(); two.dispose(); stopInventory();
        const afterDestroy = { children: host.childElementCount, controllers: [one.controller.getSnapshot().status, two.controller.getSnapshot().status],
            leases: workspace.diagnostics().leases, views: workspace.diagnostics().views, subscriptions: workspace.diagnostics().subscriptions,
            retained: [old.getSnapshot().state, current.getSnapshot().state] };
        oldLease.release(); currentLease.release(); await Promise.resolve();
        const afterRelease = { resources: workspace.diagnostics().resources, retained: [old.getSnapshot().state, current.getSnapshot().state] };
        view.dispose(); workspace.tabs.close(tab); workspace.releaseResource(source.id); host.remove();
        return { distinct, internal, hiddenThroughout, afterRefresh, afterDestroy, afterRelease, leases: workspace.diagnostics().leases };
    });
    expect(result).toEqual({ distinct: true, internal: true, hiddenThroughout: true, afterRefresh: { stable: true, oldText: "head\n  needle\nend", text: "head\n  needle\nend\nneedle", retiredRejected: true, rulers: [72], query: "needle", folded: true, collapsed: 1, defaultWorking: true, activeReference: true },
        afterDestroy: { children: 0, controllers: ["disposed", "disposed"], leases: 3, views: 1, subscriptions: 0, retained: ["ready", "ready"] },
        afterRelease: { resources: 1, retained: ["released", "released"] }, leases: 0 });
});

test("a translated review toolbar shares navigation labels with both panes", async ({ page }) => {
    const labels = await page.evaluate(async () => {
        const path = "/comparison-ownership/";
        const { Workspace, TextBuffer } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextComparison } = await import(path + "tools.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace();
        const id = workspace.createDocument({ scope: "review", resource: "test", variant: "working" }, "Test", "a\nb\nc");
        const host = document.body.appendChild(document.createElement("section"));
        host.id = "translated-review";
        const review = mountTextComparison(host, workspace, id, { buffer: TextBuffer.from("a\nB\nc"), version: "1" }, {
            strings: {
                previousChange: "Précédente", nextChange: "Suivante", useBaseline: "Rétablir",
                linkScrolling: "Lier le défilement", alignRows: "Aligner les lignes",
                baselineInput: "Texte de référence", workingInput: "Texte modifié", commandCategory: "Révision",
                previewLabel: "Aperçu", selectChange: "Choisir une ligne modifiée",
                heading: side => side === "baseline" ? "Référence" : "Version de travail",
                excerpt: (side, _range, text) => `<${side === "baseline" ? "Avant" : "Après"}> ${text}`,
                statusText: ({ selectedHunk, comparison }) => {
                    if (comparison.status !== "ready") return undefined;
                    const total = comparison.hunks.length;
                    if (selectedHunk !== null) return `Différence ${selectedHunk + 1} sur ${total}`;
                    return total ? `${total} différence${total > 1 ? "s" : ""}` : "Aucune différence";
                },
                restoreHint: ({ selectedHunk }) => selectedHunk === null
                    ? "Choisir une différence" : "Rétablir cette différence",
            },
        });
        host.addEventListener("release", () => review.dispose(), { once: true });
        return Object.values(review.panes).map(pane => ["comparison.previousChange", "comparison.nextChange"]
            .map(id => pane.commands.list().find(command => command.category === "Révision" && command.id === id)?.label));
    });
    expect(labels).toEqual([["Précédente", "Suivante"], ["Précédente", "Suivante"]]);
    const host = page.locator("#translated-review");
    const status = host.locator(".st-comparison-controls output");
    await expect(status).toHaveText("1 différence");
    await expect(host.getByRole("checkbox", { name: "Aligner les lignes" })).toBeVisible();
    await expect(host.getByRole("textbox", { name: "Texte de référence" })).toHaveAttribute("readonly", "");
    await expect(host.getByRole("heading")).toHaveText(["Référence", "Version de travail"]);
    await host.getByRole("button", { name: "Suivante" }).click();
    await expect(status).toHaveText("Différence 1 sur 1");
    await expect(host.getByLabel("Aperçu").locator("pre")).toHaveText([/^<Avant> B/, /^<Après> b/]);
    const restore = host.getByRole("button", { name: "Rétablir" });
    await expect(restore).toHaveAttribute("title", "Rétablir cette différence");
    await restore.click();
    await expect(status).toHaveText("Aucune différence");
    await expect(page.locator("#comparison").getByRole("button", { name: "Next change" })).toBeVisible();
    await host.dispatchEvent("release");
});

test("a document reference follows edits in its source editor and stays read-only in review", async ({ page }) => {
    const ids = await page.evaluate(async () => {
        const path = "/comparison-ownership/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextComparison, mountTextEditor } = await import(path + "tools.js") as typeof import("../../src/browser/index.ts");
        class DocumentWorkspace extends Workspace {
            override get tabs(): never { throw new Error("A document-only editor requested the tab layout."); }
        }
        const workspace = new DocumentWorkspace();
        const resource = (name: string) => workspace.createDocument({ scope: "review", resource: name, variant: "source" }, name, "a");
        const working = resource("working"), baseline = resource("baseline");
        const host = document.createElement("section"); host.id = "follow-document"; document.body.append(host);
        const source = mountTextEditor(host, workspace, baseline, { ariaLabel: "Reference source editor" });
        const review = mountTextComparison(host, workspace, working, baseline);
        host.addEventListener("release", () => { review.dispose(); source.dispose(); host.remove(); }, { once: true });
        return { tabs: workspace.diagnostics().tabs, reference: review.panes.reference.view.documentId === baseline };
    });
    expect(ids).toEqual({ tabs: 0, reference: true });
    const host = page.locator("#follow-document"), source = host.getByRole("textbox", { name: "Reference source editor" });
    const reference = host.getByRole("textbox", { name: "Comparison baseline source" });
    await expect(host.locator(".st-comparison-controls output")).toHaveText("No changes");
    await source.press("End"); await source.pressSequentially("b");
    await expect(host.locator(".st-comparison-removed")).toHaveText("b");
    await expect(host.locator(".st-comparison-controls output")).toHaveText("1 change");
    await reference.pressSequentially("x");
    await expect(reference).toHaveAttribute("readonly", "");
    await expect(host.locator(".st-comparison-removed")).toHaveText("b");
    await source.press("Control+z");
    await expect(host.locator(".st-comparison-controls output")).toHaveText("No changes");
    await host.dispatchEvent("release");
});

type Presentation = {
    capture: () => { status: string; revision: number; hunks: number; paints: readonly { revision: number; text: string; color: string }[]; staleRevert: boolean; currentRevert: boolean };
    release: () => void; refresh: () => boolean; dispose: () => void;
};

test("browser comparison work yields with large requested budgets and cancels its next turn", async ({ page }) => {
    const results = await page.evaluate(async () => {
        const path = "/comparison-ownership/";
        const { Workspace, TextBuffer } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { TextDiff } = await import(path + "kernels.js") as typeof import("../../src/kernels/index.ts");
        const { mountTextComparison } = await import(path + "comparison.js") as typeof import("../../src/browser/comparison.ts");
        const timeout = window.setTimeout, clear = window.clearTimeout, next = TextDiff.prototype.next;
        const clock = Object.getOwnPropertyDescriptor(performance, "now"), tasks = new Map<number, () => void>();
        let serial = 0, now = 0, calls = 0, work = 0, clockRate = 1;
        window.setTimeout = ((callback: TimerHandler) => {
            if (typeof callback !== "function") throw new Error("Expected a scheduled function.");
            const id = ++serial; tasks.set(id, () => callback()); return id;
        }) as typeof window.setTimeout;
        window.clearTimeout = id => { if (typeof id === "number") tasks.delete(id); };
        Object.defineProperty(performance, "now", { configurable: true, value: () => now });
        // A controlled cost per work unit exposes whether a large advance can prevent
        // the browser owner from checking its clock. No machine-speed timing assertion.
        TextDiff.prototype.next = function(budget = 32768) {
            now += budget / 1024 * clockRate; calls++; work += budget;
            return Object.freeze({ status: "running", work, readUnits: 0, lineEdits: 0, hunks: Object.freeze([]), failure: null });
        };
        const results: { requested: number | null; clockRate: number; calls: number; elapsed: number; work: number; pending: number; cancelled: boolean }[] = [];
        try {
            for (const { requested, rate } of [{ requested: undefined, rate: 1 }, { requested: 256, rate: 1 },
                { requested: Number.MAX_SAFE_INTEGER, rate: 1 }, { requested: undefined, rate: 0 }]) {
                clockRate = rate;
                const workspace = new Workspace(), source = workspace.createTextResource({ scope: "test", resource: "budget", variant: "working" }, "Working", { value: "working" });
                const tab = workspace.tabs.open({ kind: "text", documentId: source.documentId }, "working"), host = document.createElement("section"); document.body.append(host);
                const baseline = { buffer: TextBuffer.from("baseline"), version: "one" }, before = workspace.diagnostics();
                // Clamping must not make invalid public input acceptable or leak a mount.
                for (const invalid of [255, 256.5, Infinity, NaN]) {
                    let rejected = false; try { mountTextComparison(host, workspace, tab, baseline, { workBudget: invalid }); } catch (error) { rejected = error instanceof RangeError; }
                    if (!rejected || host.childElementCount || workspace.diagnostics().leases !== before.leases) throw new Error("Invalid mount budget was accepted or leaked ownership.");
                }
                const mounted = mountTextComparison(host, workspace, tab, baseline, requested === undefined ? {} : { workBudget: requested });
                try {
                    now = calls = work = 0;
                    const queued = tasks.entries().next().value; if (!queued) throw new Error("Missing comparison work.");
                    tasks.delete(queued[0]); queued[1]();
                    const pending = tasks.size, measured = mounted.getDiagnostics(), prior = calls; mounted.dispose();
                    const terminal = mounted.getDiagnostics();
                    if (terminal.maxStepMs !== measured.maxStepMs || terminal.totalStepMs !== measured.totalStepMs || !mounted.getSnapshot().disposed)
                        throw new Error("Disposal lost comparison measurements or terminal presentation state.");
                    for (const run of tasks.values()) run();
                    results.push({ requested: requested ?? null, clockRate, calls, elapsed: measured.maxStepMs, work, pending,
                        cancelled: tasks.size === 0 && calls === prior && workspace.diagnostics().leases === 0 && workspace.diagnostics().subscriptions === 0 });
                } finally { mounted.dispose(); workspace.tabs.close(tab); workspace.releaseResource(source.id, true); host.remove(); }
            }
        } finally {
            window.setTimeout = timeout; window.clearTimeout = clear; TextDiff.prototype.next = next;
            if (clock) Object.defineProperty(performance, "now", clock); else Reflect.deleteProperty(performance, "now");
        }
        return results;
    });
    expect(results).toEqual([
        { requested: null, clockRate: 1, calls: 1, elapsed: 4, work: 4096, pending: 1, cancelled: true },
        { requested: 256, clockRate: 1, calls: 16, elapsed: 4, work: 4096, pending: 1, cancelled: true },
        { requested: Number.MAX_SAFE_INTEGER, clockRate: 1, calls: 1, elapsed: 4, work: 4096, pending: 1, cancelled: true },
        { requested: null, clockRate: 0, calls: 32, elapsed: 0, work: 131072, pending: 1, cancelled: true },
    ]);
});
declare global { interface Window { comparisonPresentation: Presentation } }

test("typing below an aligned gap keeps the scrolled row in place on every paint", async ({ page }) => {
    const positions = await page.evaluate(async () => {
        const path = "/comparison-ownership/";
        const { Workspace, TextBuffer } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextComparison } = await import(path + "comparison.js") as typeof import("../../src/browser/comparison.ts");
        const rows = Array.from({ length: 120 }, (_, i) => "row " + i);
        const workspace = new Workspace(), source = workspace.createTextResource(
            { scope: "test", resource: "aligned", variant: "working" }, "Aligned", { value: rows.slice(12).join("\n") });
        const host = document.createElement("section");
        host.style.cssText = "height:300px;width:800px;position:fixed;inset:0";
        document.body.append(host);
        const comparison = mountTextComparison(host, workspace, source.documentId,
            { buffer: TextBuffer.from(rows.join("\n")), version: "saved" }, { rowsAligned: true, controls: false });
        const editor = comparison.panes.working, viewport = editor.viewport, line = 40;
        const settle = async () => {
            for (let frame = 0; frame < 120; frame++) {
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                if (comparison.getSnapshot().alignment.status === "ready" && !viewport.activity().pending) return;
            }
            throw new Error("Alignment did not settle");
        };
        try {
            await settle();
            editor.reveal({ line, column: 1 }, { select: true, focus: true, align: "center" });
            await settle();
            const position = () => [
                viewport.element.querySelector(`.st-viewport-row[data-line="${line}"]`)?.getBoundingClientRect().top,
                viewport.element.scrollTop
            ];
            const before = position(), frames: (typeof before)[] = [];
            const stop = viewport.onRender(() => frames.push(position()));
            document.execCommand("insertText", false, "x");
            viewport.flush();
            await settle();
            stop();
            return { before, frames, text: workspace.document(source.documentId).buffer.line(line).text };
        } finally {
            comparison.dispose();
            workspace.releaseResource(source.id, true);
            host.remove();
        }
    });
    expect(positions.text).toContain("x");
    expect(positions.before[0]).toEqual(expect.any(Number));
    expect(positions.before[1]).toBeGreaterThan(0);
    expect(positions.frames.length).toBeGreaterThan(0);
    for (const frame of positions.frames) expect(frame).toEqual(positions.before);
});

test("review highlights survive every typing paint while exact comparison work is held", async ({ page }) => {
    await page.evaluate(async () => {
        const path = "/comparison-ownership/";
        const { Workspace, TextBuffer } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { TextDiff } = await import(path + "kernels.js") as typeof import("../../src/kernels/index.ts");
        const { mountTextComparison } = await import(path + "comparison.js") as typeof import("../../src/browser/comparison.ts");
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "test", resource: "paint", variant: "working" }, "Working", { value: "old\n" + "unchanged\n".repeat(4000) });
        const tab = workspace.tabs.open({ kind: "text", documentId: source.documentId }, "working"), host = document.createElement("section");
        host.id = "held-comparison"; host.style.height = "540px"; document.body.append(host);
        const mounted = mountTextComparison(host, workspace, tab, { buffer: TextBuffer.from("new\n" + "unchanged\n".repeat(4000)), version: "one" });
        await new Promise<void>(resolve => { const stop = mounted.controller.subscribe(() => { if (mounted.controller.getSnapshot().status === "ready") { stop(); resolve(); } }); });
        const exact = mounted.hunkAt(0)!; exact.select();
        mounted.panes.working.view.setSelection(0, { anchor: 1, head: 1 }); mounted.panes.working.focus();
        const next = TextDiff.prototype.next;
        TextDiff.prototype.next = function() { return Object.freeze({ status: "running", work: 0, readUnits: 0, lineEdits: 0, hunks: Object.freeze([]), failure: null }); };
        const paints: { revision: number; text: string; color: string }[] = [];
        mounted.panes.working.viewport.onRender(() => {
            const revision = workspace.document(source.documentId).revision; if (!revision) return;
            const marked = mounted.panes.working.viewport.element.querySelector(".st-comparison-added");
            paints.push({ revision, text: marked?.textContent ?? "", color: marked ? getComputedStyle(marked).backgroundColor : "" });
        });
        window.comparisonPresentation = {
            capture: () => { const s = mounted.controller.getSnapshot(); return { status: s.status, revision: s.working!.revision, hunks: s.hunks.length, paints,
                staleRevert: exact.revert(), currentRevert: mounted.controller.hunkAt(0)?.revert() ?? false }; },
            release: () => { TextDiff.prototype.next = next; },
            refresh: () => {
                const ticket = mounted.controller.beginRefresh();
                try { return ticket.complete({ buffer: TextBuffer.from("replacement reference"), version: "two" }); }
                finally { ticket.finish(); }
            },
            dispose: () => { TextDiff.prototype.next = next; mounted.dispose(); workspace.tabs.close(tab); workspace.releaseResource(source.id, true); host.remove(); },
        };
    });
    try {
        const root = page.locator("#held-comparison"), preview = root.locator(".st-comparison-preview"), status = root.locator(".st-comparison-controls output");
        await expect(preview).toBeVisible();
        const previewText = await preview.innerText(), before = await preview.boundingBox(), initialStatus = await status.boundingBox();
        const panes = root.locator(".st-comparison-panes"), initialPanes = await panes.boundingBox();
        await page.keyboard.type("Z");
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const held = await page.evaluate(() => window.comparisonPresentation.capture());
        expect(held).toMatchObject({ status: "running", revision: 1, hunks: 1, staleRevert: false, currentRevert: false });
        expect(held.paints.length).toBeGreaterThan(0);
        for (const paint of held.paints) { expect(paint.text).toBe("oZld"); expect(paint.color).toBe("rgb(36, 98, 70)"); }
        await expect(root.getByRole("button", { name: "Use baseline", exact: true })).toBeDisabled();
        await expect(root.getByRole("button", { name: "Next change", exact: true })).toBeDisabled();
        await expect(status).toHaveAttribute("aria-busy", "true");
        await expect.poll(() => status.evaluate(el => getComputedStyle(el, "::after").visibility)).toBe("visible");
        await expect(status.locator("span")).toBeHidden();
        expect(await preview.innerText()).toBe(previewText);
        expect((await preview.boundingBox())!.height).toBe(before!.height);
        expect((await panes.boundingBox())!.height).toBe(initialPanes!.height);
        expect((await status.boundingBox())!.width).toBe(initialStatus!.width);
        await page.evaluate(() => window.comparisonPresentation.release());
        await expect(root.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
        await expect(root.locator(".st-comparison-added")).toHaveText("oZld");
        await expect(preview).toContainText("oZld"); await expect(status.locator("span")).toBeVisible();
        expect(await preview.evaluate(node => window.comparisonPresentation.refresh() && (node as HTMLElement).hidden)).toBe(true);
    } finally { await page.evaluate(() => window.comparisonPresentation.dispose()); }
});
