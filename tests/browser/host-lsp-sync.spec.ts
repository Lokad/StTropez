import { ready, isolatedTest as test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { sourceDiagnosticUri } from "./fixture-diagnostics.ts";
// Explicit background process ownership also avoids the known Firefox context-deletion issue.

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const source = (page: Page) => page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length));
const field = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const provider = async (page: Page, id = "primary") => (await snapshot(page)).bindings.language.sessions.find(session => session.id === id)!.provider;

async function seed(page: Page, text: string, offset = text.indexOf("saMORE") + 2) {
    await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, text);
    await field(page).focus(); await page.evaluate(offset => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: offset, head: offset }); }, offset); await ready(page);
}
async function offer(page: Page) { await field(page).press("Control+Space"); await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible(); }

/** Inspect bounded peer slices, never an exported editor buffer or a multi-megabyte RPC result. */
async function peerText(page: Page, uri: string, expected: string, afterVersion = 0): Promise<number> {
    let version = 0;
    await expect.poll(async () => {
        const result = await page.evaluate(async ({ uri, expected, afterVersion }) => {
            type Peer = { version: number; length: number; text: string; syncFailures: string[] };
            const read = async (from: number, to: number) => await window.hostFixture.providerCustom("fixture/document", { uri, from, to }) as Peer;
            const first = await read(0, 32768);
            if (first.version <= afterVersion || first.length !== expected.length || first.syncFailures.length) return { exact: false, version: first.version };
            for (let from = 0; from < expected.length; from += 32768) {
                const part = from === 0 ? first : await read(from, from + 32768);
                if (part.version !== first.version || part.length !== expected.length || part.syncFailures.length || part.text !== expected.slice(from, from + 32768)) return { exact: false, version: part.version };
            }
            return { exact: true, version: first.version };
        }, { uri, expected, afterVersion });
        version = result.version; return result.exact;
    }, { timeout: 30000 }).toBe(true);
    return version;
}

async function canonicalSave(page: Page, text: string): Promise<void> {
    const uri = await sourceDiagnosticUri(page), initialVersion = await peerText(page, uri, text);
    await button(page, "Open source review").click(); await ready(page);
    const before = await snapshot(page), baseline = before.bindings.comparison!.baseline;
    await field(page).press("Control+End"); await field(page).pressSequentially("  "); await ready(page);
    const typedVersion = await peerText(page, uri, text + "  ", initialVersion);
    await field(page, "Secondary source").press("Control+z"); await ready(page);
    const undoneVersion = await peerText(page, uri, text, typedVersion);
    await field(page, "Secondary source").press("Control+Shift+z"); await ready(page);
    const redoneVersion = await peerText(page, uri, text + "  ", undoneVersion), submitted = await snapshot(page);
    expect(submitted.history.undoDepth).toBe(before.history.undoDepth + 1);
    await field(page, "Secondary source").press("Control+s");
    await expect.poll(async () => (await snapshot(page)).pendingSaves).toEqual([{ revision: submitted.source.revision, length: text.length + 2, expectedServerVersion: submitted.source.serverVersion }]);
    await page.evaluate(() => window.hostFixture.finishSave()); await ready(page);
    const canonical = text.trimEnd();
    await expect.poll(async () => { const s = await snapshot(page); return { dirty: s.source.dirty, pending: s.pendingSaves.length }; }).toEqual({ dirty: false, pending: 0 });
    expect(await peerText(page, uri, canonical, redoneVersion)).toBe(redoneVersion + 1);
    const saved = await snapshot(page);
    expect(saved.source.revision).toBeGreaterThan(submitted.source.revision); expect(saved.source.length).toBe(canonical.length);
    expect(saved.source.exports).toBe(0);
    expect(saved.bindings.comparison!.baseline).toEqual(baseline);
    expect(await page.evaluate(text => {
        const f = window.hostFixture;
        for (let from = 0; from < text.length; from += 32768) if (f.range(from, Math.min(text.length, from + 32768)) !== text.slice(from, from + 32768)) return false;
        return f.snapshot().source.length === text.length;
    }, canonical)).toBe(true);
    await button(page, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(page)).pendingRuns.length).toBe(1);
    expect((await snapshot(page)).pendingRuns[0]!.sourceId).toBe(before.source.id);
    expect(await page.evaluate(text => window.hostFixture.runCapture(0)!.source === text, canonical)).toBe(true);
    await page.evaluate(() => window.hostFixture.finishRun());
    expect((await snapshot(page)).bindings.views.every(view => view.metrics!.viewport.rows < 100 && view.metrics!.inputUnits <= 4096)).toBe(true);
    await button(page, "Close source review").click(); await ready(page);
}

for (const mode of ["plain", "react"] as const) test.describe(`${mode} LSP synchronization host`, () => {
    test.beforeEach(async ({ page }) => {
         await page.goto(`/hosts/${mode}/?editor=candidate&language=lsp`); await expect(field(page)).toBeVisible(); await ready(page);
    });
    test("shared connection and exact canonical saves survive review, detach and reconnect", async ({ page }) => {
        const methods: string[] = []; page.on("websocket", socket => socket.on("framesent", frame => { const value = JSON.parse(frame.payload.toString()); if (value.method) methods.push(value.method); }));
        type Counts = { initialize: number; failures: string[]; documents: { uri: string; open: number; change: number; close: number; version: number | null }[] };
        const sync = async () => await page.evaluate(() => window.hostFixture.providerCustom("fixture/synchronization", {})) as Counts;
        const text = "const saMORE = 1; // TODO\r\ncatalogue;"; await seed(page, text); await offer(page); await button(page, "Cancel request").click();
        const baseline = await sync(), uri = baseline.documents[0]!.uri; await field(page).focus(); await field(page).pressSequentially("x"); await ready(page);
        await expect.poll(async () => (await sync()).documents.find(doc => doc.uri === uri)!.change).toBe(baseline.documents[0]!.change + 1);
        const typed = text.replace("saMORE", "saxMORE"); expect(await source(page)).toBe(typed); await offer(page); await button(page, "Cancel request").click();
        await canonicalSave(page, typed);
        await button(page, "Add navigation companion").click(); await field(page).focus();
        await page.evaluate(at => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: at, head: at }); }, typed.indexOf("catalogue") + 2); await ready(page);
        await field(page).press("Control+k"); await field(page).press("Control+i"); await expect(page.getByRole("tooltip")).toContainText("catalogue"); await field(page).press("Escape");
        await field(page).press("F12"); await expect(field(page, "Secondary source")).toBeFocused(); await button(page, "Open source review").click(); await ready(page);
        await field(page, "Comparison working source").focus(); const before = await snapshot(page);
        await button(page, "Register provider review command").click(); await expect.poll(async () => (await snapshot(page)).bindings.project.pending).toBe(false);
        await button(page, "Request provider review edits").click(); await expect.poll(async () => !!(await snapshot(page)).bindings.project.state.review).toBe(true);
        await button(page, "Apply captured provider edits").click(); await expect.poll(async () => (await snapshot(page)).bindings.project.pending).toBe(false); await ready(page);
        expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1); await field(page, "Secondary source").press("Control+z"); await ready(page); expect(await source(page)).toBe(typed);
        await button(page, "Close source review").click(); await ready(page); const counts = await sync();
        expect(counts.initialize).toBe(1); expect(counts.failures).toEqual([]); expect(counts.documents.length).toBeGreaterThanOrEqual(2);
        expect(counts.documents.every(doc => doc.open === 1 && doc.close === 0)).toBe(true); expect((await snapshot(page)).bindings.lsp).toMatchObject({ created: 1, terminated: 0 });
        for (const method of ["textDocument/completion", "textDocument/hover", "textDocument/definition", "workspace/executeCommand"]) expect(methods).toContain(method);
        const history = (await snapshot(page)).history; await field(page).focus(); await button(page, "Reconnect provider").click(); await expect.poll(async () => (await provider(page)).connected).toBe(true);
        const reopened = await sync(); expect(reopened.initialize).toBe(1); expect(reopened.documents.every(doc => doc.open === 1 && doc.change === 0)).toBe(true);
        expect((await snapshot(page)).history).toEqual(history); expect(await source(page)).toBe(typed); expect(methods.filter(method => method === "initialize")).toHaveLength(2);
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).bindings.lsp).toMatchObject({ scopes: 0, documents: 0, created: 2, terminated: 2 });
        expect((await snapshot(page)).diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 });
    });
    test("100k-line typing, completion and canonical save retain exact peer text and bounded input", async ({ page }, info) => {
        test.setTimeout(120000);
        const row = "const saMORE = 123; // row\r\n", text = row.repeat(100_000); await seed(page, text, 8); const diagnostics = [];
        await expect.poll(async () => (await provider(page)).connected).toBe(true); await page.evaluate(() => window.hostFixture.providerCustom("fixture/completionStyle", { style: "incomplete" }));
        const wire: unknown[] = []; let currentLine = 0;
        page.on("websocket", socket => socket.on("framesent", frame => {
            const value = JSON.parse(frame.payload.toString()) as { method?: string; params?: { textDocument?: { version?: number; text?: string }; contentChanges?: { range?: unknown; text: string }[] } };
            if (value.method) wire.push({ line: currentLine, method: value.method, version: value.params?.textDocument?.version, openUnits: value.params?.textDocument?.text?.length, changes: value.params?.contentChanges?.map(change => ({ range: change.range, units: change.text.length })) });
        }));
        try {
        for (const line of [0, 50_000, 99_999]) {
            currentLine = line;
            await field(page).focus(); await page.evaluate(offset => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: offset, head: offset }); }, line * row.length + 8); await ready(page);
            const started = performance.now(); await field(page).pressSequentially("m"); await ready(page); const completeAutomationMs = performance.now() - started;
            const metrics = (await snapshot(page)).bindings.views.find(view => view.id === "primary")!.metrics!, completionMetrics = await provider(page), completionStart = performance.now();
            await expect(page.getByLabel("Completion detail", { exact: true })).toContainText("Resolved sample"); await field(page).pressSequentially("p");
            await expect.poll(async () => (await provider(page)).pending).toBe(false); await field(page).press("Enter"); await ready(page);
            expect(await page.evaluate(({ from, to }) => window.hostFixture.range(from, to), { from: line * row.length, to: (line + 1) * row.length })).toBe(row.replace("saMORE", "sample"));
            expect(metrics.inputUnits).toBeLessThanOrEqual(4096); expect((await snapshot(page)).source.exports).toBe(0);
            diagnostics.push({ line, beforeinputHandlerMs: metrics.lastBeforeInputMs, inputHandlerMs: metrics.lastInputMs, completionBeforeInputMs: completionMetrics.lastCompletionBeforeInputMs,
                editorKeydownMs: metrics.lastKeydownMs, beforeinputEvents: metrics.beforeInputEvents, inputEvents: metrics.inputEvents, completeAutomationMs,
                completionAutomationMs: performance.now() - completionStart, interactionAutomationMs: performance.now() - started });
        }
        const completedRow = row.replace("saMORE", "sample");
        await canonicalSave(page, completedRow + row.repeat(49_999) + completedRow + row.repeat(49_998) + completedRow);
        await info.attach("large-lsp-correctness-clocks", { contentType: "application/json", body: JSON.stringify({ scope: "Three correctness samples. Candidate beforeinput excludes completion capture listener, measured separately. Input handler includes synchronous Core observers. Automation includes IPC/assertion polling and rendering. No latency-tail, native or physical-display qualification.", diagnostics }) });
        } finally { await info.attach("large-lsp-sync-state", { contentType: "application/json", body: JSON.stringify({ line: currentLine, diagnostics, wire, provider: await provider(page), message: await page.getByLabel("Language status", { exact: true }).textContent() }) }); }
    });
});
