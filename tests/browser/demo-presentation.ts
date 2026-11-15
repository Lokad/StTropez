import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

type AnalysisControl = { hold: boolean; held: number; release: () => void };

type SyntaxTraffic = { worker: number; kind: string; job: number; units: number; base?: number; emit?: boolean }[];

/** Inspect the real worker boundary; no instrumentation is shipped in the demo. */
export async function runDemoSyntaxDemand(page: Page, url: string): Promise<SyntaxTraffic> {
    await page.addInitScript(() => {
        const records: SyntaxTraffic = []; let serial = 0;
        Object.assign(window, { demoSyntaxTraffic: records });
        const NativeWorker = Worker;
        window.Worker = class extends NativeWorker {
            private readonly syntaxId: number;
            constructor(url: string | URL, options?: WorkerOptions) {
                super(url, options); this.syntaxId = String(url).endsWith("demo-syntax-worker.js") ? serial++ : -1;
                if (this.syntaxId >= 0) this.addEventListener("message", event => {
                    records.push({ worker: this.syntaxId, kind: event.data.kind, job: event.data.job, units: event.data.javascript?.length ?? 0 });
                });
            }
            override postMessage(message: unknown, options: StructuredSerializeOptions | Transferable[] = []): void {
                const m = message as { kind: string; job: number; text?: string; change?: { base: number }; options?: { emit?: boolean } };
                if (this.syntaxId >= 0) records.push({ worker: this.syntaxId, kind: m.kind, job: m.job, units: m.text?.length ?? 0,
                    ...(m.change ? { base: m.change.base } : {}), ...(m.options?.emit === undefined ? {} : { emit: m.options.emit }) });
                if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
            }
        };
    });
    await page.goto(url); await page.locator("#sample").selectOption("large");
    const source = page.getByRole("textbox", { name: "large.ts", exact: true }), status = page.locator("#analysis-status");
    await expect(source).toBeVisible(); await expect(status).toContainText("syntax & emit", { timeout: 30000 });
    const traffic = () => page.evaluate(() => (window as unknown as { demoSyntaxTraffic: SyntaxTraffic }).demoSyntaxTraffic.filter(m => m.worker === 0));
    const hiddenStart = (await traffic()).length;
    await page.locator("#panel-collapse").click();
    await source.press("Control+Home"); await page.keyboard.insertText("// hidden output\n");
    await expect(status).toHaveText("TypeScript 5.9.3 · syntax", { timeout: 30000 });
    await expect(page.locator("#editor .demo-token-comment").first()).toHaveText("// hidden output");
    const hidden = (await traffic()).slice(hiddenStart);
    expect(hidden.some(m => m.kind === "finish")).toBe(true);
    expect(hidden.filter(m => m.kind === "finish").every(m => m.emit === false)).toBe(true);
    expect(hidden.filter(m => m.kind === "start").every(m => m.base !== undefined)).toBe(true);
    expect(hidden.filter(m => m.kind === "chunk").reduce((sum, m) => sum + m.units, 0)).toBeLessThan(1024);
    expect(hidden.filter(m => m.kind === "result").every(m => m.units === 0)).toBe(true);
    const reopenStart = (await traffic()).length;
    await page.locator("#panel-collapse").click();
    await expect(status).toContainText("syntax & emit", { timeout: 30000 });
    await expect(page.getByRole("region", { name: "JavaScript output", exact: true })).toContainText("// hidden output");
    const reopened = (await traffic()).slice(reopenStart);
    expect(reopened.filter(m => m.kind === "chunk").reduce((sum, m) => sum + m.units, 0)).toBe(0);
    expect(reopened.some(m => m.kind === "finish" && m.emit)).toBe(true);
    const problemsStart = (await traffic()).length;
    await page.locator('[data-panel="problems"]').click();
    await source.press("Control+Home"); await page.keyboard.insertText("// problems visible\n");
    await expect(status).toHaveText("TypeScript 5.9.3 · syntax", { timeout: 30000 });
    const problems = (await traffic()).slice(problemsStart);
    expect(problems.some(m => m.kind === "finish")).toBe(true);
    expect(problems.filter(m => m.kind === "finish").every(m => m.emit === false)).toBe(true);
    await page.locator('[data-panel="javascript"]').click();
    await expect(status).toContainText("syntax & emit", { timeout: 30000 });
    await expect(page.getByRole("region", { name: "JavaScript output", exact: true })).toContainText("// problems visible");
    return traffic();
}

/** Delay actual compiler replies, without adding a provider/testing path to the application. */
export async function controlDemoAnalysis(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const pending: (() => void)[] = [];
        const control: AnalysisControl = { hold: false, held: 0, release: () => {
            control.hold = false; control.held = 0; pending.splice(0).forEach(deliver => deliver());
        } };
        Object.assign(window, { demoAnalysisControl: control });
        const NativeWorker = Worker;
        window.Worker = class extends NativeWorker {
            constructor(url: string | URL, options?: WorkerOptions) {
                super(url, options);
                if (!String(url).endsWith("demo-syntax-worker.js")) return;
                this.addEventListener("message", event => {
                    if (!control.hold) return;
                    event.stopImmediatePropagation(); control.held++;
                    pending.push(() => this.dispatchEvent(new MessageEvent("message", { data: event.data })));
                }, { capture: true });
            }
        };
    });
}

export async function holdDemoAnalysis(page: Page): Promise<void> {
    await page.evaluate(() => { (window as unknown as { demoAnalysisControl: AnalysisControl }).demoAnalysisControl.hold = true; });
}
export async function releaseDemoAnalysis(page: Page): Promise<void> {
    await page.evaluate(() => { (window as unknown as { demoAnalysisControl: AnalysisControl }).demoAnalysisControl.release(); });
}

/** Observe every frame and completed viewport render, including the deliberately pending interval. */
export async function runDemoPresentationContinuity(page: Page, url: string) {
    await controlDemoAnalysis(page); await page.goto(url);
    const observations = [];
    for (const sample of ["pricing", "large"] as const) {
        if (sample === "large") await page.locator("#sample").selectOption(sample);
        const name = sample === "large" ? "large.ts" : "main.ts", source = page.getByRole("textbox", { name, exact: true });
        await expect(source).toBeVisible();
        if (sample === "pricing") {
            await source.press("Control+a");
            await page.keyboard.insertText(Array.from({ length: 60 }, (_, i) => `// Comment ${i}: café 😀\nconst item${i} = \`value ${i}\`;`).join("\n"));
        }
        await expect(page.locator("#analysis-status")).toContainText("syntax & emit", { timeout: 30000 });
        const viewport = page.locator("#editor .st-viewport");
        await viewport.evaluate(root => { root.scrollTop = root.scrollHeight / 2; });
        // Attached rows may still belong to the previous scroll position. Wait for a
        // painted comment inside the scrollport before capturing its click coordinates.
        const painted = await page.waitForFunction(() => {
            const root = document.querySelector("#editor .st-viewport"); if (!root) return;
            const box = root.getBoundingClientRect();
            const row = [...root.querySelectorAll<HTMLElement>(".st-viewport-row")].find(row => row.textContent?.startsWith("//")
                && row.getBoundingClientRect().top > box.top + 30 && row.getBoundingClientRect().bottom < box.bottom - 30);
            if (!row) return;
            const at = row.getBoundingClientRect(); return { x: at.left + 30, y: at.top + at.height / 2,
                line: Number(row.dataset.line), text: row.textContent! };
        }, undefined, { timeout: 5000 });
        const point = (await painted.jsonValue())!; await painted.dispose();
        const output = page.getByRole("region", { name: "JavaScript output", exact: true });
        await output.evaluate((root, line) => { root.scrollTop = line * parseFloat(getComputedStyle(root).lineHeight); }, point.line);
        await expect(output).toContainText(point.text);
        const outputTop = await output.evaluate(root => root.scrollTop);
        await page.mouse.click(point.x, point.y); await source.press("Home");
        await holdDemoAnalysis(page);
        await page.evaluate(() => {
            const root = document.querySelector("#editor .st-viewport")!, output = document.querySelector(".demo-output")!;
            const state = { frames: 0, uncolored: 0, missingOutput: 0, maxFrameGapMs: 0, active: true };
            Object.assign(window, { demoContinuity: state });
            let previous = performance.now();
            const check = () => {
                if (!state.active) return;
                state.frames++;
                for (const row of root.querySelectorAll<HTMLElement>(".st-viewport-row")) {
                    if (row.textContent?.startsWith("//") && row.querySelector(".demo-token-comment")?.textContent !== row.textContent) state.uncolored++;
                    if (row.textContent?.startsWith("const") && !row.querySelector(".demo-token-keyword")) state.uncolored++;
                }
                if (!output.isConnected || !output.querySelector(".st-viewport-row")) state.missingOutput++;
            };
            root.addEventListener("sttropez-render", check);
            function frame(now: number) { if (!state.active) { root.removeEventListener("sttropez-render", check); return; }
                state.maxFrameGapMs = Math.max(state.maxFrameGapMs, now - previous); previous = now; check(); requestAnimationFrame(frame); }
            requestAnimationFrame(frame);
        });
        await source.press("Shift+End"); await source.press("Shift+ArrowRight"); await source.press("Delete");
        await expect.poll(() => page.evaluate(() => (window as unknown as { demoAnalysisControl: AnalysisControl }).demoAnalysisControl.held)).toBeGreaterThan(0);
        await source.press("Control+z"); await source.press("Control+y");
        const editedRow = viewport.locator(`[data-line="${point.line}"]`);
        await expect(editedRow).not.toHaveText(point.text);
        const before = (await editedRow.textContent())!, expected = before.slice(0, -3) + before.slice(-2);
        await source.press("End"); await source.press("ArrowLeft"); await source.press("ArrowLeft"); await source.press("ArrowLeft"); await source.press("Delete");
        await expect(editedRow).toHaveText(expected);
        await viewport.hover(); await page.mouse.wheel(0, 300);
        // A bounded controlled delay checks the waiting state, rather than racing a fast compiler.
        await page.waitForTimeout(250);
        expect(await output.evaluate(root => root.scrollTop)).toBe(outputTop);
        await releaseDemoAnalysis(page);
        await expect(page.locator("#analysis-status")).toContainText("syntax & emit", { timeout: 30000 });
        await expect(output).toContainText(expected);
        await expect(output).not.toContainText(point.text);
        expect(await output.evaluate(root => root.scrollTop)).toBe(outputTop);
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const observation = await page.evaluate(() => {
            const state = (window as unknown as { demoContinuity: { active: boolean; frames: number; uncolored: number; missingOutput: number; maxFrameGapMs: number } }).demoContinuity;
            return { ...state, sourceRows: document.querySelectorAll("#editor .st-viewport-row").length,
                outputRows: document.querySelectorAll(".demo-output .st-viewport-row").length,
                outputUnits: document.querySelector(".demo-output")?.textContent?.length ?? 0 };
        });
        await page.evaluate(() => { (window as unknown as { demoContinuity: { active: boolean } }).demoContinuity.active = false; });
        expect(observation.frames).toBeGreaterThan(3);
        expect(observation.uncolored).toBe(0); expect(observation.missingOutput).toBe(0);
        expect(observation.sourceRows).toBeLessThan(60); expect(observation.outputRows).toBeLessThan(60);
        expect(observation.outputUnits).toBeLessThan(5000);
        observations.push({ sample, ...observation });
    }
    return observations;
}
