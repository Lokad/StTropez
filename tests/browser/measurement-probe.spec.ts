import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const { installHostReferenceProbe } = await import(new URL("../../scripts/host-reference-probe.mjs", import.meta.url).href) as { installHostReferenceProbe: () => void };
type HostScene = Readonly<{ mounted: boolean; mount(host: string, editor?: "native" | "candidate"): Promise<void>;
    dispose(observe?: () => Promise<void>): Promise<ReturnType<Window["hostFixture"]["snapshot"]> | undefined>;
    ready(): Promise<unknown>; sourceReady(): Promise<unknown>;
    snapshot(): Promise<ReturnType<Window["hostFixture"]["snapshot"]>>; exactText(text: string, target?: "source" | "reference"): Promise<boolean> }>;
const { createHostScene } = await import(new URL("../../scripts/host-scene.mjs", import.meta.url).href) as { createHostScene: (page: Page) => HostScene };
type Result = { kind: string; transactions: number; insertedUnits: number; revision: number; commandToFullReviewReadyProxyMs: number | null;
    lastInputToFullReviewReadyProxyMs: number | null; records: { trusted?: boolean; keydownHandlerMs?: number; inputHandlerMs?: number; workingRenderProxyMs: number | null }[] };
type Probe = { arm: (options: { kind: string; text?: string; caretOffset?: number; operation?: string; replaceSelection?: boolean }) => void;
    isSourceReady: (state?: ReturnType<Window["hostFixture"]["snapshot"]>) => boolean;
    waitSourceReady: () => Promise<unknown>;
    isReady: (state?: ReturnType<Window["hostFixture"]["snapshot"]>) => boolean;
    waitReady: () => Promise<unknown>; read: () => Promise<Result>; snapshot: () => { finished: boolean; failure?: string; records: unknown[] } };
declare global { interface Window { hostReferenceProbe: Probe } }

async function mount(page: Page, host: string) {
    await page.goto(`/hosts/${host}/?editor=candidate`); await ready(page);
    await page.evaluate(installHostReferenceProbe);
    await page.getByRole("button", { name: "Open source review", exact: true }).click(); await ready(page);
    await page.getByRole("button", { name: "Capture review acceptance", exact: true }).click();
    await page.evaluate(() => window.hostReferenceProbe.arm({ kind: "reference", operation: "identity" }));
    await page.getByRole("button", { name: "Finish review acceptance", exact: true }).click();
    expect((await page.evaluate(() => window.hostReferenceProbe.read())).kind).toBe("reference");
}

test("host text oracle checks complete raw source and independent reference without exports", async ({ page }) => {
    await page.goto("/workspace/"); // Establish the harness origin before mounting a host scene.
    const scene = createHostScene(page);
    // The surrogate pair and CRLF each straddle a chunk boundary; retain the lone surrogate too.
    const text = "a".repeat(32767) + "😀" + "b".repeat(32766) + "\r\nend\ud800";
    try {
        await scene.mount("plain");
        expect(await scene.exactText("", "reference")).toBe(false);
        await page.evaluate(text => {
            const f = window.hostFixture, s = f.snapshot();
            f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]);
        }, text);
        await page.getByRole("button", { name: "Open source review", exact: true }).click();
        await page.getByRole("button", { name: "Capture review acceptance", exact: true }).click();
        await page.getByRole("button", { name: "Finish review acceptance", exact: true }).click(); await scene.ready();
        for (const target of ["source", "reference"] as const) {
            expect(await scene.exactText(text, target)).toBe(true);
            expect(await scene.exactText(text.slice(0, -1), target)).toBe(false);
            expect(await scene.exactText(text.slice(0, 32768) + "x" + text.slice(32769), target)).toBe(false);
        }
        await page.evaluate(() => {
            const f = window.hostFixture, s = f.snapshot();
            f.editSource(s.source.revision, [{ from: s.source.length, to: s.source.length, insert: "q" }]);
        }); await scene.ready();
        expect(await scene.exactText(text + "q")).toBe(true);
        expect(await scene.exactText(text)).toBe(false);
        expect(await scene.exactText(text, "reference")).toBe(true);
        expect(await scene.exactText(text + "q", "reference")).toBe(false);
        const state = await scene.snapshot();
        expect(state.source.exports).toBe(0);
        expect(state.bindings.comparison!.baseline!.exports).toBe(0);
    } finally { await scene.dispose(); }
    expect(scene.mounted).toBe(false);
    await scene.dispose();
});

test("source readiness supports native views and optional review without weakening full review", async ({ page }) => {
    await page.goto("/workspace/");
    const host = createHostScene(page), settle = host.sourceReady;
    const state = () => page.evaluate(() => ({ source: window.hostReferenceProbe.isSourceReady(), review: window.hostReferenceProbe.isReady() }));
    for (const editor of ["native", "candidate"] as const) try {
        await host.mount("plain", editor);
        await settle(); expect(await state()).toEqual({ source: true, review: false });
        await page.getByRole("button", { name: "Open source review", exact: true }).click(); await settle();
        expect(await state()).toEqual({ source: true, review: editor === "candidate" });
        expect(await page.evaluate(() => {
            const f = window.hostFixture;
            f.selectSourceSet("comparison", f.snapshot().source.revision, [{ anchor: 0, head: 1 }]);
            return { source: window.hostReferenceProbe.isSourceReady(), review: window.hostReferenceProbe.isReady() };
        })).toEqual({ source: false, review: false });
        await settle(); expect(await state()).toEqual({ source: true, review: editor === "candidate" });
        let observations = 0;
        const disposed = await host.dispose(async () => {
            observations++;
            expect(host.mounted).toBe(false);
            expect(await state()).toEqual({ source: false, review: false });
        });
        expect(disposed!.pendingCommands).toBe(0);
        await host.dispose(async () => { observations++; });
        expect(observations).toBe(1);
    } finally { await host.dispose(); }
});

test("review measurements await full selections, folds, queued input and reference work", async ({ page }) => {
    await mount(page, "plain");
    const settle = () => page.evaluate(() => window.hostReferenceProbe.waitReady());
    const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
    await page.evaluate(() => {
        const f = window.hostFixture, s = f.snapshot();
        f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: "header\n  one\n  two\nfooter\n" }]);
    }); await settle();
    expect(await page.evaluate(() => {
        const f = window.hostFixture, before = f.snapshot(), old = before.bindings.views.find(v => v.id === "secondary")!;
        f.selectSourceSet("secondary", before.source.revision, [old.selection, { anchor: 10, head: 12 }]);
        const next = f.snapshot().bindings.views.find(v => v.id === "secondary")!;
        return { primaryUnchanged: JSON.stringify(old.selection) === JSON.stringify(next.selection),
            staleSet: next.selectionSet !== next.metrics!.viewport.selectionSet, ready: window.hostReferenceProbe.isReady() };
    })).toEqual({ primaryUnchanged: true, staleSet: true, ready: false });
    await settle();
    await page.evaluate(() => {
        const f = window.hostFixture;
        f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: 19 }]);
    }); await settle(); await primary.focus();
    expect(await page.getByRole("button", { name: "Fold selected lines", exact: true }).evaluate(node => {
        (node as HTMLButtonElement).click(); const v = window.hostFixture.snapshot().bindings.views.find(v => v.id === "primary")!;
        return { staleFold: v.foldGeneration !== v.metrics!.viewport.foldGeneration, ready: window.hostReferenceProbe.isReady() };
    })).toEqual({ staleFold: true, ready: false });
    await settle();

    const reference = page.getByRole("textbox", { name: "Comparison baseline source", exact: true });
    await reference.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await settle(); // Composition alone is not scheduled editor work or native-device qualification.
    expect(await page.getByRole("checkbox", { name: "Align review rows", exact: true }).evaluate(node => {
        (node as HTMLInputElement).click(); const c = window.hostFixture.snapshot().bindings.comparison!;
        return { pending: c.work.alignment.pending, ready: window.hostReferenceProbe.isReady() };
    })).toEqual({ pending: true, ready: false });
    await reference.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { data: "", bubbles: true })));
    await settle();

    await page.evaluate(() => {
        const f = window.hostFixture, s = f.snapshot();
        f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: "a".repeat(262144) + "\ntail" }]);
        f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: 0 }]);
    }); await settle();
    for (const name of ["Capture review acceptance", "Finish review acceptance"]) {
        await page.getByRole("button", { name, exact: true }).click(); await settle();
    }
    await primary.focus(); await settle();
    expect(await primary.evaluate(node => {
        node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true }));
        const command = window.hostFixture.snapshot().bindings.views.find(v => v.id === "primary")!.metrics!.pendingCommand;
        const commandReady = window.hostReferenceProbe.isReady();
        const input = new InputEvent("beforeinput", { inputType: "insertText", data: "q", bubbles: true, cancelable: true }); node.dispatchEvent(input);
        return { command, commandReady, captured: input.defaultPrevented,
            input: window.hostFixture.snapshot().bindings.views.find(v => v.id === "primary")!.metrics!.pendingInput, ready: window.hostReferenceProbe.isReady() };
    })).toEqual({ command: true, commandReady: false, captured: true, input: true, ready: false });
    await settle(); expect(await page.evaluate(() => window.hostFixture.range(262142, 262150))).toBe("aa\nqtail");
    expect(await reference.evaluate(node => {
        node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
        return { pending: window.hostFixture.snapshot().bindings.comparison!.referenceInput!.pendingCommand, ready: window.hostReferenceProbe.isReady() };
    })).toEqual({ pending: true, ready: false });
    await settle();
    expect(await page.evaluate(() => { window.hostFixture.dispose(); return window.hostReferenceProbe.isReady(); })).toBe(false);
});

test("review measurement propagates terminal settlement failure and releases the observation", async ({ page }) => {
    await mount(page, "plain"); await page.getByRole("textbox", { name: "Primary source", exact: true }).focus();
    await page.evaluate(() => window.hostReferenceProbe.waitReady());
    // Inject only the owner's terminal signal; do not add a runtime fault switch.
    await page.evaluate(() => {
        const original = window.hostFixture;
        window.hostFixture = { ...original, get settled(): boolean {
            if (document.documentElement.dataset.failSettlement) throw new Error("terminal alignment failure");
            return original.settled;
        } };
        document.documentElement.dataset.failSettlement = "true";
    });
    await page.evaluate(installHostReferenceProbe);
    await expect(page.evaluate(() => window.hostReferenceProbe.waitSourceReady())).rejects.toThrow("terminal alignment failure");
    await expect(page.evaluate(() => window.hostReferenceProbe.waitReady())).rejects.toThrow("terminal alignment failure");
    await page.evaluate(() => {
        delete document.documentElement.dataset.failSettlement;
        window.hostReferenceProbe.arm({ kind: "input", text: "q" });
        document.documentElement.dataset.failSettlement = "true";
    });
    await page.keyboard.type("q");
    await expect(page.evaluate(() => window.hostReferenceProbe.read())).rejects.toThrow("terminal alignment failure");
    expect(await page.evaluate(() => window.hostReferenceProbe.snapshot())).toMatchObject({ finished: true, failure: "terminal alignment failure", records: [{}] });
    await page.evaluate(() => window.hostFixture.dispose());
});

for (const host of ["plain", "react"]) test(`${host} Enter measurements separate command clocks, raw newline units and transactions`, async ({ page }) => {
    await mount(page, host); const input = page.getByRole("textbox", { name: "Primary source", exact: true });
    for (const item of [
        { source: "first\nsecond", offset: 3, insert: "\n", caret: 1 },
        { source: "first\r\nsecond", offset: 0, insert: "\r\n", caret: 2 },
        { source: "    abc\r\nnext", offset: 7, insert: "\r\n    ", caret: 6 },
        { source: "{}", offset: 1, insert: "\n  \n", caret: 3, split: true },
        { source: "row\n".repeat(100000), offset: 200001, insert: "\n", caret: 1 },
    ]) {
        await page.evaluate(item => {
            const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: item.source }]);
            f.configureSource("primary", { tabSize: 2, enter: item.split ? () => ({ indent: 1, split: true }) : "keep" });
            f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: item.offset, head: item.offset }]);
        }, item); await ready(page); await input.focus(); await page.evaluate(() => window.hostReferenceProbe.waitReady());
        const before = await page.evaluate(() => window.hostFixture.snapshot().source.revision);
        await page.evaluate(item => window.hostReferenceProbe.arm({ kind: "command", text: item.insert, caretOffset: item.caret }), item);
        await input.press("Enter"); const result = await page.evaluate(() => window.hostReferenceProbe.read());
        expect(result).toMatchObject({ kind: "command", transactions: 1, insertedUnits: item.insert.length, revision: before + 1, lastInputToFullReviewReadyProxyMs: null });
        expect(result.commandToFullReviewReadyProxyMs).toBeGreaterThan(0); expect(result.records).toHaveLength(1);
        expect(result.records[0]!.trusted).toBe(true); expect(result.records[0]!.keydownHandlerMs).toBeGreaterThanOrEqual(0);
        expect(result.records[0]!.inputHandlerMs).toBeUndefined(); expect(result.records[0]!.workingRenderProxyMs).not.toBeNull();
        const expected = item.source.slice(0, item.offset) + item.insert + item.source.slice(item.offset);
        expect(await page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); })).toBe(expected);
        await input.press("Control+z"); await ready(page);
        expect(await page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); })).toBe(item.source);
        await input.press("Control+Shift+z"); await ready(page);
        expect(await page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); })).toBe(expected);
    }
    await page.evaluate(() => window.hostFixture.dispose());
});

test("input measurement identifies its native route and retains a rejected command observation", async ({ page, browserName }) => {
    await mount(page, "plain"); const input = page.getByRole("textbox", { name: "Primary source", exact: true }); await input.focus();
    await page.evaluate(() => window.hostReferenceProbe.waitReady());
    await page.evaluate(() => window.hostReferenceProbe.arm({ kind: "input", text: "😀é" }));
    await page.keyboard.insertText("😀é");
    if (browserName === "firefox") {
        // Playwright's Firefox insertText uses composition; do not label it ordinary native typing.
        await expect(page.evaluate(() => window.hostReferenceProbe.read())).rejects.toThrow("Expected native insertText; received insertCompositionText.");
        expect(await page.evaluate(() => window.hostReferenceProbe.snapshot())).toMatchObject({ finished: true, records: [] });
        await page.evaluate(() => window.hostReferenceProbe.waitReady());
    } else {
        const native = await page.evaluate(() => window.hostReferenceProbe.read());
        expect(native).toMatchObject({ kind: "input", transactions: 1, insertedUnits: 4, commandToFullReviewReadyProxyMs: null });
        expect(native.records).toHaveLength(1); expect(native.records[0]!.inputHandlerMs).toBeGreaterThanOrEqual(0); expect(native.records[0]!.keydownHandlerMs).toBeUndefined();
    }
    await page.evaluate(() => window.hostReferenceProbe.arm({ kind: "command", text: "wrong expected newline" }));
    await input.press("Enter");
    await expect(page.evaluate(() => window.hostReferenceProbe.read())).rejects.toThrow(/Incorrect handled Enter/);
    expect(await page.evaluate(() => window.hostReferenceProbe.snapshot())).toMatchObject({ finished: true, failure: "Incorrect handled Enter text, selection or event counters.", records: [{}] });
    await page.evaluate(() => window.hostReferenceProbe.arm({ kind: "input", text: "q" })); await page.keyboard.type("q");
    expect((await page.evaluate(() => window.hostReferenceProbe.read())).transactions).toBe(1);
    await page.evaluate(() => window.hostFixture.dispose());
});
